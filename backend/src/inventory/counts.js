// Stock counts (CNT-1..5, P3-08, migration 020): full, cycle and spot counts with a snapshot, blind option, several counters, recounts, a reviewer, and
// ONE approval for the whole session when it has a variance. Built on the PROVEN design in docs/inventory-kb/spikes/count-snapshot/ (328 checks).
//
//   create(db, scope, { locationId, type: 'full'|'cycle'|'spot', blind?, categoryIds?, itemIds?, zone?, note?, start? = true, commandId? }, { now })
//   start(db, scope, id)                      the snapshot: one insert..select of on_hand + the highest movement id of each (location, item); no lock on stock
//   sheet(db, scope, id)                      the counter's sheet. A BLIND session never returns an expected number, a variance or anyone else's entry
//   enterCount(db, scope, id, { lineId | itemId, quantity, unit?, note?, confirmLarge? }, { now })     append-only; carries the ledger watermark of that moment
//   finishCounting(db, scope, id, { skips?, skipRemaining? })        counting -> under_review (every line counted, or skipped with a reason)
//   review(db, scope, id)                     reviewer's table: expected, entries, movements during the count, difference, KES, "counters disagree" flags
//   requestRecount(db, scope, id, { lineId | itemId, note? })  /  chooseEntry(db, scope, id, { lineId | itemId, entryId })
//   submitReview(db, scope, id, { now })      freezes the numbers, then: no variance -> posts; variance -> ONE approval (or none inside the owner's limits)
//   cancel(db, scope, id, { note? })          before posted; withdraws a waiting approval, posts nothing
//   get / list / report / suggestCycle / spotCount / locationOf / ensureCountApprovals
//
// THE FORMULA (watermark, never time, never at posting): variance(entry) = counted - (expected_base + sum(delta of this item here with
//   snapshot_movement_id < movement id <= entry.ledger_watermark)). Sales, receipts and transfers recorded around the count stay in the ledger; the
//   correction is only the unexplained part, and movements after the counter counted are never erased. Numbers freeze at submitReview; posting writes
//   exactly those with key count:<id>:<line>.
// APPROVAL (D3-5, T-CTL-2): no variance -> posts without approval; any variance and no rule -> one approval for the session (safe default); an owner rule
//   (variance % and/or KES, 017) or the two fallback settings -> approval only beyond the limits. Limits are judged on the GROSS value (gains and losses added up
//   without offsetting) so a big shortage and a big surplus can't cancel each other out of review. The engine enforces maker-checker (sole owner = self_approved,
//   flagged); on top of that a person who counted can't approve while another approver exists.
// Surplus is posted at the average cost, so the average does not move. A deficit never takes stock below zero: if sales after the count already used the
// stock, the correction is clamped to what is left and the line says so.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { MONEY, QTY, absolute, add, cmp, dec, div, isNeg, isZero, mul, neg, rescale, sub } from './decimal.js';
import { compatibleUnits, display, normaliseUnit, toBase } from './units.js';
import { can, requireCan } from './permissions.js';
import { loadUnits } from './catalogue.js';
import { balance, post } from './ledger.js';
import * as approvals from './approvals.js';
import { getSetting } from './policies.js';
import { nextNumber } from './numbers.js';
import { record as audit } from './audit.js';
import { notify } from './notifications.js';
import { checkLargeAmount } from './branch.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};
const money = (d) => (d === null || d === undefined ? null : dec(d).toString(MONEY));
const q4 = (d) => (d === null || d === undefined ? null : dec(d).toString(QTY));

export const TYPES = Object.freeze(['full', 'cycle', 'spot']);
export const STATUSES = Object.freeze(['open', 'counting', 'under_review', 'approved', 'posted', 'cancelled']);
export const ACTIVE = Object.freeze(['open', 'counting', 'under_review', 'approved']);
export const NUMBER_KIND = 'CNT';
export const MAX_SPOT_ITEMS = 10;

/* ============================================================================================================
 * Reading blocks
 * ========================================================================================================== */

const COUNT_SELECT = `select c.*, l.name as location_name, l.restaurant_id, r.name as branch_name, p.name as created_by_name, rp.name as reviewed_by_name,
    ap.status as approval_status, ap.self_approved as approval_self,
    (select count(*)::int from public.stock_count_lines x where x.count_id = c.id) as lines_total,
    (select count(*)::int from public.stock_count_lines x where x.count_id = c.id and (x.decision = 'skipped' or x.status in ('counted', 'settled'))) as lines_done,
    (select count(*)::int from public.stock_count_lines x where x.count_id = c.id and x.decision = 'skipped') as lines_skipped,
    (select count(*)::int from public.stock_count_lines x where x.count_id = c.id and x.status = 'recount') as lines_recount
  from public.stock_counts c join public.stock_locations l on l.id = c.location_id left join public.restaurants r on r.id = l.restaurant_id
  left join public.profiles p on p.id = c.created_by left join public.profiles rp on rp.id = c.reviewed_by left join public.approvals ap on ap.id = c.approval_id`;

async function loadCount(db, businessId, id, { lock = false } = {}) {
  if (!isId(id)) throw fail(400, 'That count id is invalid.', 'bad_id');
  const row = (await db.query(`${COUNT_SELECT} where c.id = $1 and c.business_id = $2 ${lock ? 'for update of c' : ''}`, [id.toLowerCase(), businessId])).rows[0];
  if (!row) throw fail(404, 'That count doesn’t exist.', 'count_not_found');
  return row;
}

/** Where a count is (for routes that authorise before the transaction). */
export async function locationOf(db, businessId, id) {
  if (!isId(id)) throw fail(400, 'That count id is invalid.', 'bad_id');
  const row = (await db.query('select location_id, blind, status from public.stock_counts where id = $1 and business_id = $2', [id.toLowerCase(), businessId])).rows[0];
  if (!row) throw fail(404, 'That count doesn’t exist.', 'count_not_found');
  return { locationId: row.location_id, blind: row.blind, status: row.status };
}

/** Items of a count with what units.js needs (own units, display unit) and the shared unit table. */
async function itemsOf(db, ids) {
  const units = await loadUnits(db);
  const map = new Map();
  if (!ids.length) return { units, map };
  const rows = (await db.query(`select i.id, i.name, i.unit, i.display_unit, i.category_id, c.name as category_name from public.stock_items i
    left join public.stock_categories c on c.id = i.category_id where i.id = any($1::uuid[])`, [ids])).rows;
  const own = (await db.query('select item_id, name, factor::text as factor from public.stock_item_units where item_id = any($1::uuid[]) order by position, lower(name)', [ids])).rows;
  for (const r of rows) {
    map.set(r.id, { id: r.id, name: r.name, categoryId: r.category_id, categoryName: r.category_name || null, baseUnit: r.unit, displayUnit: r.display_unit || undefined,
      units: own.filter((u) => u.item_id === r.id).map((u) => ({ name: u.name, factor: u.factor })) });
  }
  return { units, map };
}

const LINE_SELECT = `select l.id, l.count_id, l.item_id, l.expected_base::text as expected, l.snapshot_movement_id::text as snap_id, l.unit_cost::text as unit_cost, l.status, l.decision,
    l.skip_reason, l.chosen_entry_id, l.final_counted_base::text as final_counted, l.movements_since_base::text as since_stored, l.variance_base::text as variance_stored,
    l.variance_value::text as value_stored, l.movement_id, l.recount_requested_by from public.stock_count_lines l`;

async function loadLines(db, countId) {
  return (await db.query(`${LINE_SELECT} where l.count_id = $1`, [countId])).rows;
}

const ENTRY_SELECT = `select e.id, e.line_id, e.counter_id, e.qty_base::text as qty, e.entered_quantity::text as entered_qty, e.entered_unit, e.counted_at, e.ledger_watermark::text as watermark,
    e.is_recount, e.note, p.name as counter_name,
    coalesce((select sum(m.delta) from public.stock_movements m where m.location_id = c.location_id and m.item_id = l.item_id and m.id > l.snapshot_movement_id and m.id <= e.ledger_watermark), 0)::text as since
  from public.stock_count_entries e join public.stock_count_lines l on l.id = e.line_id join public.stock_counts c on c.id = l.count_id left join public.profiles p on p.id = e.counter_id`;

async function loadEntries(db, lineIds) {
  const map = new Map();
  if (!lineIds.length) return map;
  const rows = (await db.query(`${ENTRY_SELECT} where e.line_id = any($1::uuid[]) order by e.counted_at, e.ledger_watermark, e.id`, [lineIds])).rows;
  for (const r of rows) map.set(r.line_id, [...(map.get(r.line_id) || []), r]);
  return map;
}

/** The entries of the latest round: a recount starts a new round, so numbers from before it no longer count for disagreement or choice. */
function currentRound(entries) {
  let start = 0;                                  // the first number entered after a recount request is flagged is_recount: it opens the round
  entries.forEach((e, i) => { if (e.is_recount) start = i; });
  return entries.slice(start);
}
/** One entry per counter: their latest in the round (a counter who corrects themselves replaces their own earlier number, not someone else's). */
function latestPerCounter(round) {
  const byKey = new Map();
  for (const e of round) byKey.set(e.counter_id || e.id, e);
  return [...byKey.values()];
}

/**
 * One line from the ledger: each entry judged at ITS OWN moment (the watermark formula), whether the counters disagree beyond the tolerance, the entry
 * that applies (the reviewer's choice, else the only/latest one when nobody disagrees), and its numbers. Pure.
 */
function analyse(line, entries, tolerancePct) {
  const round = currentRound(entries);
  const current = latestPerCounter(round);
  const judge = (e) => {
    const atCount = add(line.expected, e.since, QTY);
    return { expectedAtCount: atCount, variance: sub(e.qty, atCount, QTY) };
  };
  const judged = new Map(entries.map((e) => [e.id, judge(e)]));
  let conflict = false;
  if (current.length > 1) {
    const vars = current.map((e) => judged.get(e.id).variance);
    const spread = sub(vars.reduce((a, b) => (cmp(b, a) > 0 ? b : a)), vars.reduce((a, b) => (cmp(b, a) < 0 ? b : a)), QTY);
    const base = current.map((e) => judged.get(e.id).expectedAtCount).reduce((a, b) => (cmp(b, a) > 0 ? b : a));
    const allowed = tolerancePct > 0 ? mul(absolute(base), div(dec(String(tolerancePct)), '100', 8), QTY) : dec('0');
    conflict = cmp(spread, allowed) > 0;
  }
  const chosen = line.chosen_entry_id ? round.find((e) => e.id === line.chosen_entry_id) : null;
  const applied = chosen || (!conflict && current.length ? current.at(-1) : null);
  const out = { round, current, judged, conflict, applied, needsChoice: Boolean(conflict && !chosen) };
  if (applied) {
    const j = judged.get(applied.id);
    out.counted = dec(applied.qty);
    out.movementsSince = dec(applied.since);
    out.expectedAtCount = j.expectedAtCount;
    out.variance = j.variance;
  }
  return out;
}

const toleranceOf = async (db, scope, locationId) => {
  const v = await getSetting(db, scope.businessId, 'count_tolerance_pct', locationId);
  return v === null || v === undefined ? 0 : Number(v);
};

const valueOf = (variance, unitCost) => (unitCost === null || unitCost === undefined ? null : mul(variance, unitCost, MONEY));

/* ============================================================================================================
 * Shaping
 * ========================================================================================================== */

const shapeCount = (r, { showCost = true } = {}) => ({
  id: r.id, number: r.number, locationId: r.location_id, locationName: r.branch_name || r.location_name, restaurantId: r.restaurant_id || null,
  type: r.type, blind: r.blind, status: r.status, zone: r.zone, note: r.note, categoryIds: r.category_ids || [], itemIds: r.item_ids || [],
  createdBy: r.created_by, createdByName: r.created_by_name || null, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  progress: { total: r.lines_total, counted: r.lines_done, skipped: r.lines_skipped, recount: r.lines_recount, left: r.lines_total - r.lines_done },
  reviewedBy: r.reviewed_by, reviewedByName: r.reviewed_by_name || null, reviewedAt: r.reviewed_at, approvalId: r.approval_id, approvalStatus: r.approval_status || null,
  selfApproved: r.approval_self === true, approvedAt: r.approved_at, postedAt: r.posted_at, cancelledAt: r.cancelled_at,
  waitingForApproval: r.status === 'under_review' && r.review_lines !== null && r.review_lines !== undefined,
  review: r.review_lines === null || r.review_lines === undefined ? null : {
    lines: r.review_lines, expectedValueKes: showCost ? money(r.review_expected_value) : null, varianceValueKes: showCost ? money(r.review_variance_value) : null,
    variancePct: showCost && r.review_variance_pct !== null ? String(Number(r.review_variance_pct)) : null, unpricedLines: r.review_unpriced_lines,
  },
});

/** The caller may see expected numbers: not blind, or blind but past counting and a reviewer (count.run / count.approve). Counters' own sheet never does. */
const mayReview = (scope, row) => can(scope, 'inv.count.run', { locationId: row.location_id }) || can(scope, 'inv.count.approve', { locationId: row.location_id });

/* ============================================================================================================
 * Create and start (snapshot)
 * ========================================================================================================== */

async function resolveItems(db, businessId, locationId, { type, categoryIds, itemIds }) {
  const explicit = itemIds.length ? (await db.query(`select id, name, archived_at from public.stock_items where business_id = $1 and id = any($2::uuid[])`, [businessId, itemIds])).rows : [];
  if (explicit.length !== itemIds.length) throw fail(404, 'One of the items isn’t in this business. Pick them from the stock list.', 'item_not_found');
  const archived = explicit.find((r) => r.archived_at);
  if (archived) throw fail(409, `${archived.name} is archived, so it can’t be counted. Restore it first.`, 'item_archived');
  const ids = new Set(itemIds);
  if (type === 'full' || (type === 'cycle' && categoryIds.length)) {
    const rows = (await db.query(`with recursive cats as (select id from public.stock_categories where business_id = $1 and id = any($3::uuid[])
        union select c.id from public.stock_categories c join cats on c.parent_id = cats.id where c.business_id = $1)
      select i.id from public.stock_items i where i.business_id = $1 and i.archived_at is null
        and exists (select 1 from public.stock_balances b where b.item_id = i.id and b.location_id = $2)
        and ($4::boolean or i.category_id in (select id from cats))`, [businessId, locationId, categoryIds, type === 'full'])).rows;
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/**
 * Creates a count session at a place and (by default) takes the snapshot at once.
 *   full  every active item stocked here (has a balance row); one open full count per place
 *   cycle a category (with its sub-categories) and/or a list of items
 *   spot  a few named items (up to 10)
 * Returns { count } (status counting after the snapshot, open when start: false).
 */
export async function create(db, scope, input = {}, { now = new Date() } = {}) {
  const loc = scope.locations.find((l) => l.id === (input.locationId ? String(input.locationId).toLowerCase() : null));
  if (!loc) throw fail(404, 'That branch or warehouse isn’t part of this business.', 'location_not_found');
  requireCan(scope, 'inv.count.run', { locationId: loc.id });
  const type = String(input.type ?? 'full').toLowerCase();
  if (!TYPES.includes(type)) throw fail(400, 'Choose a full count, a cycle count (some categories or items) or a spot count (a few items).', 'bad_type');
  const blind = input.blind === true || input.blind === 'true' || input.blind === 1;
  const list = (value, label) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw fail(400, `${label} must be a list.`, 'bad_filter');
    return [...new Set(value.map((id) => needId(id, label)))];
  };
  const categoryIds = list(input.categoryIds, 'A category');
  const itemIds = list(input.itemIds, 'An item');
  if (type === 'cycle' && !categoryIds.length && !itemIds.length) throw fail(400, 'A cycle count needs at least one category or item. Use a full count to count everything.', 'filter_required');
  if (type === 'spot' && (!itemIds.length || categoryIds.length)) throw fail(400, 'A spot count is for a few named items. Choose the items.', 'filter_required');
  if (type === 'spot' && itemIds.length > MAX_SPOT_ITEMS) throw fail(400, `A spot count is for a few items (up to ${MAX_SPOT_ITEMS}). Use a cycle count for more.`, 'too_many_items');
  if (type === 'full' && (categoryIds.length || itemIds.length)) throw fail(400, 'A full count covers everything here. Use a cycle count to count only some items.', 'filter_not_allowed');
  const zone = tidy(input.zone) || null;
  const note = tidy(input.note) || null;
  if (zone && zone.length > 60) throw fail(400, 'Keep the area name under 60 characters.', 'zone_too_long');
  if (note && note.length > 500) throw fail(400, 'Keep the note under 500 characters.', 'note_too_long');

  let commandId = null;
  if (input.commandId !== undefined && input.commandId !== null) {
    commandId = needId(input.commandId, 'The request id');
    const prior = (await db.query('select id from public.stock_counts where business_id = $1 and command_id = $2', [scope.businessId, commandId])).rows[0];
    if (prior) return { ...(await get(db, scope, prior.id)), replayed: true };
  }

  // One open full count per place, said plainly (the database index is the guard behind this check).
  const open = (await db.query(`select number from public.stock_counts where location_id = $1 and status = any($2::text[])`, [loc.id, ACTIVE])).rows;
  const openFull = (await db.query(`select number from public.stock_counts where location_id = $1 and type = 'full' and status = any($2::text[])`, [loc.id, ACTIVE])).rows[0];
  if (openFull && type === 'full') {
    throw fail(409, `A full count (${openFull.number}) is already open at ${loc.name}. Finish it or cancel it before starting another.`, 'full_count_open', { number: openFull.number });
  }
  const items = await resolveItems(db, scope.businessId, loc.id, { type, categoryIds, itemIds });
  if (!items.length) throw fail(409, 'There is nothing to count here: no stocked items match. Receive stock first, or pick the items by name.', 'nothing_to_count');
  // A full count (or a count of the same items) can't run alongside another count of those items: two sessions would each correct the same stock.
  if (open.length) {
    const clash = (await db.query(`select i.name, c.number from public.stock_counts c join public.stock_count_lines l on l.count_id = c.id join public.stock_items i on i.id = l.item_id
      where c.location_id = $1 and c.status = any($2::text[]) and l.item_id = any($3::uuid[]) order by i.name limit 1`, [loc.id, ACTIVE, items])).rows[0];
    if (clash) throw fail(409, `${clash.name} is already being counted here (${clash.number}). Finish or cancel that count first.`, 'item_in_open_count', { number: clash.number });
    if (type === 'full') throw fail(409, `Another count (${open[0].number}) is still open at ${loc.name}. Finish or cancel it before counting everything.`, 'count_open', { number: open[0].number });
  }

  const id = randomUUID();
  const number = await nextNumber(db, { businessId: scope.businessId, kind: NUMBER_KIND, now });
  try {
    await db.query(`insert into public.stock_counts (id, business_id, location_id, number, type, blind, category_ids, item_ids, zone, note, created_by, created_at, command_id)
      values ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::uuid[], $9, $10, $11, $12, $13)`,
    [id, scope.businessId, loc.id, number, type, blind, `{${categoryIds.join(',')}}`, `{${itemIds.join(',')}}`, zone, note, scope.userId, now, commandId]);
  } catch (error) {
    if (error?.code === '23505' && /one_open_full/.test(`${error.constraint || ''} ${error.message}`)) {
      throw fail(409, `A full count is already open at ${loc.name}. Finish it or cancel it before starting another.`, 'full_count_open');
    }
    throw error;
  }
  await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: id, action: 'create',
    after: { number, type, blind, categories: categoryIds.length, items: itemIds.length } });
  if (input.start === false) return { ...(await get(db, scope, id)), replayed: false };
  return { ...(await start(db, scope, id, { now, items })), replayed: false };
}

/** The snapshot: ONE insert..select reads each item's on_hand and the highest movement id of (location, item) together (one MVCC snapshot, no lock). */
export async function start(db, scope, id, { now = new Date(), items = null } = {}) {
  const row = await loadCount(db, scope.businessId, id, { lock: true });
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  if (row.status !== 'open') {
    if (['counting', 'under_review', 'approved', 'posted'].includes(row.status)) return { ...(await get(db, scope, row.id)), replayed: true };
    throw fail(409, 'This count was cancelled.', 'count_cancelled');
  }
  const ids = items || await resolveItems(db, row.business_id, row.location_id, { type: row.type, categoryIds: row.category_ids || [], itemIds: row.item_ids || [] });
  if (!ids.length) throw fail(409, 'There is nothing to count here: no stocked items match.', 'nothing_to_count');
  await db.query(`insert into public.stock_count_lines (count_id, business_id, item_id, expected_base, snapshot_movement_id, unit_cost)
    select $1, $2, i.id, coalesce(b.on_hand, 0), coalesce((select max(m.id) from public.stock_movements m where m.location_id = $3 and m.item_id = i.id), 0), i.avg_cost
    from public.stock_items i left join public.stock_balances b on b.item_id = i.id and b.location_id = $3 where i.id = any($4::uuid[])`, [row.id, row.business_id, row.location_id, ids]);
  await db.query(`update public.stock_counts set status = 'counting', snapshot_at = $2, started_at = $2,
    snapshot_movement_id = (select coalesce(max(id), 0) from public.stock_movements where business_id = $3) where id = $1`, [row.id, now, row.business_id]);
  await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'start',
    before: { status: 'open' }, after: { status: 'counting', lines: ids.length } });
  return get(db, scope, row.id);
}

/* ============================================================================================================
 * Counting
 * ========================================================================================================== */

async function pickLine(db, count, { lineId, itemId }) {
  const args = lineId ? [count.id, needId(lineId, 'The line')] : [count.id, needId(itemId, 'The item')];
  const line = (await db.query(`${LINE_SELECT} where l.count_id = $1 and ${lineId ? 'l.id' : 'l.item_id'} = $2`, args)).rows[0];
  if (!line) throw fail(404, 'That item isn’t part of this count.', 'line_not_found');
  return line;
}

/**
 * The counter's sheet: one card per item (name, units with their factors, MY latest number, whether it needs a recount). A blind session never returns an
 * expected number, a variance or another counter's entry: JSON has no such key at all. Needs inv.count.run at the place.
 */
export async function sheet(db, scope, id) {
  const row = await loadCount(db, scope.businessId, id);
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  const lines = await loadLines(db, row.id);
  const { units, map } = await itemsOf(db, lines.map((l) => l.item_id));
  const entries = await loadEntries(db, lines.map((l) => l.id));
  const mine = (lineId) => {
    const all = (entries.get(lineId) || []).filter((e) => e.counter_id === scope.userId);
    return currentRound(all).at(-1) || null;
  };
  const cards = lines.map((l) => {
    const item = map.get(l.item_id);
    const e = mine(l.id);
    const card = {
      lineId: l.id, itemId: l.item_id, name: item.name, category: item.categoryName, baseUnit: item.baseUnit, displayUnit: item.displayUnit || item.baseUnit,
      units: compatibleUnits(item, units).map((u) => ({ code: u.code, label: u.label, plural: u.plural, factor: u.factor })),
      state: l.decision === 'skipped' ? 'skipped' : l.status === 'recount' ? 'recount' : entries.get(l.id)?.length ? 'counted' : 'uncounted',
      skipReason: l.decision === 'skipped' ? l.skip_reason : null,
      mine: e ? { entryId: e.id, quantity: e.entered_qty, unit: e.entered_unit, qtyBase: e.qty, display: display(e.qty, item, units), countedAt: e.counted_at } : null,
    };
    if (!row.blind) { card.expected = l.expected; card.expectedDisplay = display(l.expected, item, units); }
    return card;
  }).sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  return { count: shapeCount(row, { showCost: false }), lines: cards, blind: row.blind };
}

/**
 * A counter enters what is on the shelf: any compatible unit or pack (kept as entered), zero allowed ("not here"). Entries are APPEND-ONLY: another counter, or
 * the same counter again, adds a new entry; the same counter sending the same number again is a replay. Each entry carries the ledger watermark of this moment.
 */
export async function enterCount(db, scope, id, input = {}, { now = new Date() } = {}) {
  const row = await loadCount(db, scope.businessId, id, { lock: true });
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  if (!['counting', 'under_review'].includes(row.status)) {
    throw fail(409, row.status === 'open' ? 'This count hasn’t started yet.' : `This count is ${row.status === 'cancelled' ? 'cancelled' : 'closed'}, so it can’t take numbers any more.`, 'count_not_counting');
  }
  const line = await pickLine(db, row, input);
  if (row.status === 'under_review') {
    // While under review only a recount takes numbers: the line is waiting for one, or the recount round has begun and another counter joins it.
    const round = currentRound((await loadEntries(db, [line.id])).get(line.id) || []);
    if (row.review_lines !== null) throw fail(409, 'This count is waiting for approval, so its numbers are fixed. Cancel it to start again.', 'count_in_review');
    if (line.status !== 'recount' && !round[0]?.is_recount) {
      throw fail(409, 'This count is being reviewed. The reviewer has to ask for a recount of an item before it takes a new number.', 'count_in_review');
    }
  }
  if (input.quantity === undefined || input.quantity === null || String(input.quantity).trim() === '') throw fail(400, 'Enter how much you counted (0 if there is none).', 'quantity_required');
  const typed = dec(typeof input.quantity === 'string' ? input.quantity.trim() : input.quantity, { label: 'The counted amount' });
  if (isNeg(typed)) throw fail(400, 'The counted amount can’t be negative.', 'negative_quantity');
  const { units, map } = await itemsOf(db, [line.item_id]);
  const item = map.get(line.item_id);
  const unit = input.unit === undefined || input.unit === null || String(input.unit).trim() === '' ? (item.displayUnit ?? item.baseUnit) : String(input.unit).trim();
  const qtyBase = toBase(typed.toString(), unit, item, units, { label: 'The counted amount' });
  const enteredUnit = normaliseUnit(unit, item, units) || item.baseUnit;
  const entered = rescale(typed, QTY, 'half-up').toString(QTY);
  const text = tidy(input.note);
  if (text.length > 280) throw fail(400, 'Keep the note under 280 characters.', 'note_too_long');

  const lineEntries = (await loadEntries(db, [line.id])).get(line.id) || [];
  const prior = currentRound(lineEntries).filter((e) => e.counter_id === scope.userId).at(-1);     // my latest number of the CURRENT round
  const isRecount = line.status === 'recount';
  if (prior && !isRecount && cmp(prior.qty, qtyBase) === 0) {
    return { replayed: true, entryId: prior.id, ...(await progressOf(db, row.id)) };
  }
  if (!isZero(dec(qtyBase)) && input.confirmLarge !== true) {
    await checkLargeAmount(db, scope, { id: row.location_id }, { itemRow: { id: line.item_id, name: item.name }, item, units, baseQty: dec(qtyBase), enteredQuantity: entered, enteredUnit, confirm: false });
  }
  const entryId = (await db.query(`insert into public.stock_count_entries (line_id, counter_id, qty_base, entered_quantity, entered_unit, counted_at, ledger_watermark, is_recount, note)
    select l.id, $2, $3, $4, $5, $6, coalesce((select max(m.id) from public.stock_movements m where m.location_id = c.location_id and m.item_id = l.item_id), 0), $7, $8
    from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.id = $1 returning id`,
  [line.id, scope.userId, qtyBase, entered, enteredUnit, now, isRecount, text || null])).rows[0].id;
  await db.query(`update public.stock_count_lines set status = 'counted', decision = null, skip_reason = null, chosen_entry_id = null where id = $1`, [line.id]);
  return { replayed: false, entryId, line: { lineId: line.id, itemId: line.item_id, name: item.name, quantity: entered, unit: enteredUnit, qtyBase, display: display(qtyBase, item, units) },
    ...(await progressOf(db, row.id)) };
}

async function progressOf(db, countId) {
  const p = (await db.query(`select count(*)::int as total, count(*) filter (where decision = 'skipped' or status in ('counted', 'settled'))::int as counted,
    count(*) filter (where status = 'recount')::int as recount from public.stock_count_lines where count_id = $1`, [countId])).rows[0];
  return { progress: { total: p.total, counted: p.counted, recount: p.recount, left: p.total - p.counted } };
}

/**
 * Counting is done: every item is counted or skipped with a reason, then the session goes to review.
 * Body: { skips: [{ itemId, reason }], skipRemaining: 'reason for every item still left' }.
 */
export async function finishCounting(db, scope, id, { skips = [], skipRemaining = null } = {}, { now = new Date() } = {}) {
  const row = await loadCount(db, scope.businessId, id, { lock: true });
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  if (row.status === 'under_review') return { ...(await get(db, scope, row.id)), replayed: true };
  if (row.status !== 'counting') throw fail(409, row.status === 'open' ? 'This count hasn’t started yet.' : `This count is ${row.status.replace('_', ' ')}, so counting can’t be finished.`, 'count_not_counting');
  const lines = await loadLines(db, row.id);
  const left = lines.filter((l) => l.status === 'uncounted' && l.decision !== 'skipped');
  const reasons = new Map();
  for (const s of Array.isArray(skips) ? skips : []) {
    const reason = tidy(s?.reason);
    if (!reason) throw fail(400, 'Say why an item was skipped.', 'skip_reason_required');
    if (reason.length > 280) throw fail(400, 'Keep the reason under 280 characters.', 'note_too_long');
    const line = lines.find((l) => l.item_id === String(s.itemId || '').toLowerCase() || l.id === String(s.lineId || '').toLowerCase());
    if (!line) throw fail(404, 'That item isn’t part of this count.', 'line_not_found');
    if (!left.includes(line)) throw fail(409, 'That item has already been counted, so it can’t be skipped.', 'line_counted');
    reasons.set(line.id, reason);
  }
  const all = tidy(skipRemaining);
  if (all) for (const l of left) if (!reasons.has(l.id)) reasons.set(l.id, all);
  const missing = left.filter((l) => !reasons.has(l.id));
  const recount = lines.filter((l) => l.status === 'recount');
  if (recount.length) throw fail(409, `${recount.length} item${recount.length === 1 ? ' is' : 's are'} waiting for a recount.`, 'lines_recount', { recount: recount.length });
  if (missing.length) {
    const { map } = await itemsOf(db, missing.slice(0, 5).map((l) => l.item_id));
    const names = missing.slice(0, 5).map((l) => map.get(l.item_id)?.name).join(', ');
    throw fail(409, `${missing.length} item${missing.length === 1 ? ' hasn’t' : 's haven’t'} been counted yet (${names}${missing.length > 5 ? ', …' : ''}). Count ${missing.length === 1 ? 'it' : 'them'}, or skip with a reason.`,
      'lines_uncounted', { uncounted: missing.length, itemIds: missing.map((l) => l.item_id) });
  }
  if (lines.length === reasons.size) throw fail(409, 'Nothing has been counted. Count at least one item, or cancel the count.', 'nothing_counted');
  for (const [lineId, reason] of reasons) {
    await db.query(`update public.stock_count_lines set decision = 'skipped', skip_reason = $2, status = 'counted' where id = $1 and status = 'uncounted'`, [lineId, reason]);
  }
  await db.query(`update public.stock_counts set status = 'under_review', finished_at = $2 where id = $1`, [row.id, now]);
  await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'finish',
    before: { status: 'counting' }, after: { status: 'under_review', skipped: reasons.size } });
  return { ...(await get(db, scope, row.id)), replayed: false };
}

/* ============================================================================================================
 * Review
 * ========================================================================================================== */

async function reviewLines(db, scope, row) {
  const lines = await loadLines(db, row.id);
  const { units, map } = await itemsOf(db, lines.map((l) => l.item_id));
  const entries = await loadEntries(db, lines.map((l) => l.id));
  const tol = await toleranceOf(db, scope, row.location_id);
  const seeCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const rows = lines.map((l) => {
    const item = map.get(l.item_id);
    const all = entries.get(l.id) || [];
    const a = analyse(l, all, tol);
    const skipped = l.decision === 'skipped';
    const frozen = l.status === 'settled' && !skipped && l.variance_stored !== null;
    const counted = frozen ? dec(l.final_counted) : a.counted ?? null;
    const variance = frozen ? dec(l.variance_stored) : a.variance ?? null;
    const since = frozen ? dec(l.since_stored) : a.movementsSince ?? null;
    const atCount = counted !== null && variance !== null ? sub(counted, variance, QTY) : null;
    const value = variance === null ? null : frozen && l.value_stored !== null ? dec(l.value_stored) : valueOf(variance, l.unit_cost);
    return {
      lineId: l.id, itemId: l.item_id, name: item.name, category: item.categoryName, baseUnit: item.baseUnit, status: l.status, decision: l.decision, skipReason: l.skip_reason,
      expected: l.expected, expectedDisplay: display(l.expected, item, units),
      movementsSince: since === null ? null : q4(since), movementsSinceDisplay: since === null ? null : `${isNeg(since) ? '-' : since.n === 0n ? '' : '+'}${display(absolute(since).toString(QTY), item, units)}`,
      expectedAtCount: atCount === null ? null : q4(atCount), counted: counted === null ? null : q4(counted), countedDisplay: counted === null ? null : display(q4(counted), item, units),
      variance: variance === null ? null : q4(variance), varianceDisplay: variance === null ? null : `${isNeg(variance) ? '-' : isZero(variance) ? '' : '+'}${display(absolute(variance).toString(QTY), item, units)}`,
      direction: variance === null || isZero(variance) ? 'same' : isNeg(variance) ? 'loss' : 'gain',
      unitCostKnown: l.unit_cost !== null, valueKes: seeCost && value !== null ? money(value) : null,
      conflict: a.conflict, needsChoice: a.needsChoice, message: a.needsChoice ? 'Counters disagree — recount or choose.' : a.conflict ? 'Counters disagree; one number was chosen.' : null,
      chosenEntryId: a.applied?.id || null, postedMovementId: l.movement_id,
      entries: all.map((e) => {
        const j = a.judged.get(e.id);
        return { id: e.id, counterId: e.counter_id, counterName: e.counter_name || null, quantity: e.entered_qty, unit: e.entered_unit, qtyBase: e.qty, display: display(e.qty, item, units),
          countedAt: e.counted_at, isRecount: e.is_recount, note: e.note, inCurrentRound: a.round.includes(e), movementsSince: q4(e.since), expectedAtCount: q4(j.expectedAtCount), variance: q4(j.variance),
          chosen: a.applied?.id === e.id };
      }),
      _num: { variance, value, atCount, unitCost: l.unit_cost, skipped, counted: counted !== null },
    };
  }).sort((x, y) => (x.category || '').localeCompare(y.category || '') || x.name.localeCompare(y.name));
  return rows;
}

function totalsOf(rows) {
  let net = dec('0'); let gross = dec('0'); let expectedValue = dec('0'); let unpriced = 0; let withVariance = 0; let compared = 0;
  let gains = dec('0'); let losses = dec('0');
  for (const r of rows) {
    const n = r._num;
    if (n.skipped || !n.counted) continue;
    compared += 1;
    const nonZero = n.variance !== null && !isZero(n.variance);
    if (nonZero) withVariance += 1;
    if (n.unitCost !== null && n.unitCost !== undefined && n.atCount !== null) expectedValue = add(expectedValue, mul(n.atCount, n.unitCost, MONEY), MONEY);
    if (nonZero && n.value === null) { unpriced += 1; continue; }
    if (n.value !== null) {
      net = add(net, n.value, MONEY); gross = add(gross, absolute(n.value), MONEY);
      if (isNeg(n.value)) losses = add(losses, absolute(n.value), MONEY); else gains = add(gains, n.value, MONEY);
    }
  }
  const pct = (v) => (cmp(expectedValue, 0) > 0 ? div(mul(v, '100', 6), expectedValue, 2) : null);
  return { compared, withVariance, unpriced, netValue: net, grossValue: gross, gains, losses, expectedValue, netPct: pct(net), grossPct: pct(gross) };
}

const shapeTotals = (t, showCost) => ({
  lines: t.compared, linesWithDifference: t.withVariance, unpricedLines: t.unpriced,
  expectedValueKes: showCost ? money(t.expectedValue) : null, netValueKes: showCost ? money(t.netValue) : null, grossValueKes: showCost ? money(t.grossValue) : null,
  gainsKes: showCost ? money(t.gains) : null, lossesKes: showCost ? money(t.losses) : null,
  netPct: showCost && t.netPct ? t.netPct.toString(2) : null, grossPct: showCost && t.grossPct ? t.grossPct.toString(2) : null,
});

const stripInternal = (rows) => rows.map(({ _num, ...rest }) => rest);

/**
 * The reviewer's table (needs inv.count.run or inv.count.approve): expected at the snapshot, what happened since, expected at the moment of counting,
 * counted, the difference and its KES, and every counter's entry. "Counters disagree" lines must be chosen (or recounted) before the count is sent on.
 * Only available once counting is finished, so a blind count's expected numbers stay hidden from counters until then.
 */
export async function review(db, scope, id) {
  const row = await loadCount(db, scope.businessId, id);
  if (!mayReview(scope, row)) throw fail(403, 'You don’t have access to this.', 'forbidden');
  if (['open', 'counting'].includes(row.status)) throw fail(409, row.blind ? 'This is a blind count: the expected numbers stay hidden until counting is finished.' : 'Counting isn’t finished yet.', 'review_not_ready');
  const rows = await reviewLines(db, scope, row);
  const seeCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const approval = row.approval_id ? await approvals.getApproval(db, scope.businessId, row.approval_id) : null;
  return {
    count: shapeCount(row, { showCost: seeCost }), lines: stripInternal(rows), totals: shapeTotals(totalsOf(rows), seeCost),
    needsChoice: rows.filter((r) => r.needsChoice).length, recounts: rows.filter((r) => r.status === 'recount').length,
    approval: approval && { id: approval.id, status: approval.status, decidedByName: approval.decidedByName, decidedAt: approval.decidedAt, decisionNote: approval.decisionNote,
      selfApproved: approval.selfApproved, reasons: approval.reasons, requestedByName: approval.requestedByName },
  };
}

/** The reviewer asks for a line to be counted again: it takes new entries, and the old ones stop counting toward disagreement. */
export async function requestRecount(db, scope, id, input = {}) {
  const row = await loadCount(db, scope.businessId, id, { lock: true });
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  if (row.status !== 'under_review') throw fail(409, 'A recount can be asked for once counting is finished and before the count is posted.', 'count_not_in_review');
  if (row.review_lines !== null) throw fail(409, 'This count is waiting for approval, so its numbers are fixed. Cancel it to start again.', 'count_waiting_approval');
  const line = await pickLine(db, row, input);
  if (line.decision === 'skipped') throw fail(409, 'That item was skipped. Cancel the count or count the item in a new one.', 'line_skipped');
  if (line.status === 'recount') return { ...(await review(db, scope, id)), replayed: true };
  await db.query(`update public.stock_count_lines set status = 'recount', decision = 'recount', chosen_entry_id = null, recount_requested_by = $2 where id = $1`, [line.id, scope.userId]);
  await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'recount',
    after: { lineId: line.id, itemId: line.item_id, note: tidy(input.note) || null } });
  return { ...(await review(db, scope, id)), replayed: false };
}

/** The reviewer picks which counter's number applies for a line (only for entries of the latest round). */
export async function chooseEntry(db, scope, id, input = {}) {
  const row = await loadCount(db, scope.businessId, id, { lock: true });
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  if (row.status !== 'under_review') throw fail(409, 'You can choose a number once counting is finished and before the count is posted.', 'count_not_in_review');
  if (row.review_lines !== null) throw fail(409, 'This count is waiting for approval, so its numbers are fixed. Cancel it to start again.', 'count_waiting_approval');
  const line = await pickLine(db, row, input);
  const entryId = needId(input.entryId, 'The entry');
  const entries = (await loadEntries(db, [line.id])).get(line.id) || [];
  const round = currentRound(entries);
  if (!round.some((e) => e.id === entryId)) throw fail(404, 'That number isn’t part of the latest count of this item. Choose one of the current numbers.', 'entry_not_found');
  if (line.status === 'recount') throw fail(409, 'This item is waiting for a recount. Choose after it has been counted again.', 'line_recount');
  await db.query(`update public.stock_count_lines set chosen_entry_id = $2, decision = 'accepted' where id = $1`, [line.id, entryId]);
  await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'choose',
    after: { lineId: line.id, entryId } });
  return review(db, scope, id);
}

/* ============================================================================================================
 * Submit: freeze numbers, evaluate, post or ask for approval
 * ========================================================================================================== */

async function evaluateCount(db, scope, row, totals, at) {
  const hasVariance = totals.withVariance > 0;
  const evaluation = await approvals.evaluate(db, { businessId: scope.businessId, subject: 'count', locationId: row.location_id, hasVariance,
    variancePct: totals.grossPct ? Number(totals.grossPct.toString(2)) : null, varianceKes: money(totals.grossValue), at, lock: false });
  if (!hasVariance) return evaluation;
  const rule = evaluation.rule;
  if (!rule) {
    // No approval rule: the two fallback settings (P3-02) may stand in for one; with neither set, every variance needs approval (safe default).
    const fbKes = await getSetting(db, scope.businessId, 'count_variance_value_kes', row.location_id);
    const fbPct = await getSetting(db, scope.businessId, 'count_variance_pct', row.location_id);
    if ((fbKes !== null && fbKes !== undefined) || (fbPct !== null && fbPct !== undefined)) {
      evaluation.safeDefault = false;
      evaluation.reasons = [];
      if (fbPct !== null && fbPct !== undefined && totals.grossPct && cmp(totals.grossPct, String(fbPct)) > 0) evaluation.reasons.push(`The count is off by ${totals.grossPct.toString(2)}% (limit ${fbPct}%).`);
      if (fbKes !== null && fbKes !== undefined && cmp(totals.grossValue, String(fbKes)) > 0) evaluation.reasons.push(`The count is off by KES ${money(totals.grossValue)} (limit ${fbKes}).`);
      evaluation.needsApproval = evaluation.reasons.length > 0;
      const unprovable = [];
      if (fbKes !== null && fbKes !== undefined && totals.unpriced) unprovable.push('some items have no cost yet');
      if (fbPct !== null && fbPct !== undefined && !totals.grossPct) unprovable.push('there is no stock value to compare with');
      if (unprovable.length) { evaluation.needsApproval = true; evaluation.reasons.push(`Cravio can’t check this count against your limit: ${unprovable.join(' and ')}.`); }
    }
    return evaluation;
  }
  // A rule exists: what can't be measured against it needs a person (never read as "within the limit").
  const unprovable = [];
  if (rule.varianceKes !== null && totals.unpriced) unprovable.push('some items have no cost yet');
  if (rule.variancePct !== null && !totals.grossPct) unprovable.push('there is no stock value to compare with');
  if (unprovable.length && !evaluation.needsApproval) {
    evaluation.needsApproval = true;
    evaluation.reasons.push(`Cravio can’t check this count against your limit: ${unprovable.join(' and ')}.`);
  }
  return evaluation;
}

/**
 * Sends the reviewed count on. Freezes every line's numbers (chosen entry, counted, movements since the snapshot, difference, KES) and the totals, then:
 * no difference -> posted at once; a difference -> ONE approval for the whole session unless the owner's limits (or the two fallback settings) say it is small.
 * Needs inv.count.run. Lines where counters disagree need a choice (or a recount) first; lines waiting for a recount block it.
 * Returns { count, posted, pendingApproval, evaluation, ... }.
 */
export async function submitReview(db, scope, id, { now = new Date() } = {}) {
  const row = await loadCount(db, scope.businessId, id, { lock: true });
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  if (row.status === 'posted') return { ...(await get(db, scope, row.id)), posted: true, pendingApproval: false, replayed: true };
  if (row.status !== 'under_review') throw fail(409, row.status === 'cancelled' ? 'This count was cancelled.' : 'Finish counting before sending the count for review.', 'count_not_in_review');
  if (row.review_lines !== null) {
    return { ...(await get(db, scope, row.id)), posted: false, pendingApproval: true, replayed: true };
  }
  const rows = await reviewLines(db, scope, row);
  const waiting = rows.filter((r) => r.status === 'recount');
  if (waiting.length) throw fail(409, `${waiting.length} item${waiting.length === 1 ? ' is' : 's are'} waiting for a recount (${waiting.slice(0, 3).map((r) => r.name).join(', ')}).`, 'lines_recount', { recount: waiting.length });
  const open = rows.filter((r) => r.needsChoice);
  if (open.length) throw fail(409, `Counters disagree on ${open.length} item${open.length === 1 ? '' : 's'} (${open.slice(0, 3).map((r) => r.name).join(', ')}). Ask for a recount or choose one number.`, 'counters_disagree', { items: open.map((r) => r.itemId) });
  const totals = totalsOf(rows);

  // Freeze: the numbers the approver sees are the numbers that post.
  for (const r of rows) {
    if (r._num.skipped) { await db.query(`update public.stock_count_lines set status = 'settled' where id = $1`, [r.lineId]); continue; }
    await db.query(`update public.stock_count_lines set status = 'settled', decision = 'accepted', chosen_entry_id = $2, final_counted_base = $3, movements_since_base = $4,
      variance_base = $5, variance_value = $6 where id = $1`,
    [r.lineId, r.chosenEntryId, r.counted, r.movementsSince, r.variance, r._num.value === null ? null : money(r._num.value)]);
  }
  await db.query(`update public.stock_counts set reviewed_by = $2, reviewed_at = $3, review_lines = $4, review_expected_value = $5, review_variance_value = $6, review_variance_pct = $7,
    review_unpriced_lines = $8 where id = $1`,
  [row.id, scope.userId, now, totals.compared, money(totals.expectedValue), money(totals.netValue), totals.netPct ? totals.netPct.toString(2) : null, totals.unpriced]);

  const evaluation = await evaluateCount(db, scope, row, totals, now);
  const base = { number: row.number, lines: totals.compared, linesWithDifference: totals.withVariance, netKes: money(totals.netValue), grossKes: money(totals.grossValue) };
  if (evaluation.needsApproval) {
    const approval = await approvals.request(db, { businessId: scope.businessId, subject: 'count', subjectId: row.id, locationId: row.location_id, requestedBy: scope.userId,
      requestedByRole: scope.role, amountKes: money(totals.grossValue), evaluation, at: now });
    await db.query('update public.stock_counts set approval_id = $2 where id = $1', [row.id, approval.id]);
    await audit(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'submit',
      before: { status: 'under_review' }, after: { ...base, approvalId: approval.id, reasons: evaluation.reasons, safeDefault: evaluation.safeDefault } });
    return { ...(await get(db, scope, row.id)), posted: false, pendingApproval: true, evaluation: { needsApproval: true, reasons: evaluation.reasons, safeDefault: evaluation.safeDefault }, replayed: false };
  }
  const posted = await postCount(db, scope, row.id, { actorId: scope.userId, at: now });
  await audit(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'submit',
    before: { status: 'under_review' }, after: { ...base, posted: true, withinLimits: totals.withVariance > 0, reasons: evaluation.reasons } });
  return { ...(await get(db, scope, row.id)), posted: true, pendingApproval: false, corrections: posted.corrections, clamped: posted.clamped,
    evaluation: { needsApproval: false, reasons: evaluation.reasons, safeDefault: evaluation.safeDefault }, replayed: false };
}

/**
 * Writes the frozen differences to the ledger: one 'count_correction' per line with a difference (key count:<id>:<line>), then marks the count posted.
 * A posted count is a no-op. Never recomputes: movements recorded after the counter counted stay in the ledger. A surplus carries the average cost
 * (the average does not move). A deficit that sales after the count have already used up is clamped to what is left, and reported.
 */
async function postCount(db, scope, countId, { actorId, at, afterApproval = null }) {
  const row = (await db.query('select * from public.stock_counts where id = $1 for update', [countId])).rows[0];
  if (row.status === 'posted') return { corrections: [], clamped: [], replayed: true };
  if (afterApproval) {
    await db.query(`update public.stock_counts set status = 'approved', approved_by = $2, approved_at = $3 where id = $1`, [row.id, afterApproval.decidedBy, afterApproval.decidedAt || at]);
  }
  const lines = (await db.query(`${LINE_SELECT} where l.count_id = $1 and l.decision is distinct from 'skipped' and l.variance_base is not null order by l.item_id`, [row.id])).rows;
  const corrections = [];
  const clamped = [];
  for (const l of lines) {
    let qty = dec(l.variance_stored);
    if (isZero(qty)) continue;
    const item = (await db.query('select name, avg_cost::text as avg_cost from public.stock_items where id = $1', [l.item_id])).rows[0];
    if (isNeg(qty)) {
      const bal = await balance(db, row.location_id, l.item_id);
      const onHand = dec(bal.onHand);
      if (isNeg(add(onHand, qty, QTY))) {
        const { units, map } = await itemsOf(db, [l.item_id]);
        const shown = (v) => display(absolute(v).toString(QTY), map.get(l.item_id), units);
        clamped.push({ itemId: l.item_id, name: item.name, wanted: qty.toString(QTY), posted: neg(onHand).toString(QTY),
          message: `${item.name}: the count found ${shown(qty)} less than expected, but sales after the count had already used the stock, so only ${shown(onHand)} could be taken off (stock is now 0).` });
        qty = neg(onHand);
        if (isZero(qty)) continue;
      }
    }
    let out;
    try {
      out = await post(db, { businessId: row.business_id, locationId: row.location_id, itemId: l.item_id, qty: qty.toString(QTY), reason: 'count_correction', ref: { type: 'count', id: row.id },
        actorId, occurredAt: at, idempotencyKey: `count:${row.id}:${l.id}`,
        unitCost: !isNeg(qty) && item.avg_cost !== null ? dec(item.avg_cost).toString(6) : null,           // a surplus carries the average cost: the average does not move
        note: `Count ${row.number}: counted ${q4(l.final_counted)} (expected ${q4(sub(l.final_counted, l.variance_stored, QTY))} at the count)` });
    } catch (error) {
      if (error instanceof HttpError && ['insufficient_stock', 'stock_reserved'].includes(error.details?.code)) throw fail(409, `This count can’t be posted yet. ${error.message}`, error.details.code);
      throw error;
    }
    await db.query('update public.stock_count_lines set movement_id = $2 where id = $1', [l.id, out.movement.id]);
    corrections.push({ itemId: l.item_id, name: item.name, delta: out.movement.delta, movementId: out.movement.id });
  }
  await db.query(`update public.stock_counts set status = 'posted', posted_at = $2 where id = $1`, [row.id, at]);
  await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'post',
    after: { status: 'posted', corrections: corrections.length, clamped: clamped.length ? clamped : undefined, approvalId: row.approval_id, selfApproved: afterApproval?.selfApproved || false } });
  const place = scope.locations.find((l) => l.id === row.location_id);
  const t = row.review_variance_value;
  await notify(db, { businessId: row.business_id, recipients: place?.restaurantId ? `branch_managers:${place.restaurantId}` : 'owners', exclude: [scope.userId],
    kind: 'count_posted', title: `Stock count ${row.number} is posted`,
    body: corrections.length ? `${corrections.length} item${corrections.length === 1 ? '' : 's'} corrected${t === null ? '' : `, net KES ${money(t)}`}.` : 'The counts matched the system: nothing to correct.',
    link: '/inventory/counts', entity: { type: 'count', id: row.id }, locationId: row.location_id, dedupeKey: `count_posted:${row.id}` });
  return { corrections, clamped, replayed: false };
}

/* ---------- the approvals engine calls this ---------- */

/**
 * Approved -> status approved, the frozen differences post (key count:<id>:<line>) and the count is posted. Rejected -> the session goes back to review with
 * its numbers unfrozen: the reviewer can recount, choose again and send it on. A person who counted can't approve while another approver exists.
 */
export async function applyDecision(db, approval, { scope }) {
  const row = (await db.query('select * from public.stock_counts where id = $1 and business_id = $2 for update', [approval.subjectId, approval.businessId])).rows[0];
  if (!row || row.status !== 'under_review' || row.approval_id !== approval.id) return null;
  if (approval.status === 'approved') {
    const counted = (await db.query(`select 1 from public.stock_count_entries e join public.stock_count_lines l on l.id = e.line_id where l.count_id = $1 and e.counter_id = $2 limit 1`, [row.id, scope.userId])).rows[0];
    if (counted && !approval.selfApproved && await approvals.approverAvailable(db, row.business_id, scope.userId, 'inv.count.approve', row.location_id)) {
      throw fail(403, 'You counted some of this stock, so someone else has to approve it.', 'counter_cannot_approve');
    }
    const result = await postCount(db, scope, row.id, { actorId: row.reviewed_by || scope.userId, at: approval.decidedAt ? new Date(approval.decidedAt) : new Date(), afterApproval: approval });
    await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id,
      action: approval.selfApproved ? 'approve_self' : 'approve', before: { status: 'under_review' }, after: { status: 'posted', approvalId: approval.id, corrections: result.corrections.length, selfApproved: approval.selfApproved } });
  } else if (approval.status === 'rejected') {
    await db.query(`update public.stock_count_lines set status = 'counted', final_counted_base = null, movements_since_base = null, variance_base = null, variance_value = null
      where count_id = $1 and status = 'settled'`, [row.id]);
    await db.query(`update public.stock_counts set reviewed_by = null, reviewed_at = null, review_lines = null, review_expected_value = null, review_variance_value = null,
      review_variance_pct = null, review_unpriced_lines = null, approval_id = null where id = $1`, [row.id]);
    await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'reject',
      before: { status: 'under_review' }, after: { status: 'under_review', note: approval.decisionNote } });
  }
  return row.id;
}
let unregister = null;
export function ensureCountApprovals() {
  if (!unregister) unregister = approvals.onDecided('count', applyDecision);
  return unregister;
}
/** For tests: forget the registration so ensureCountApprovals() adds it back after approvals.clearDecisionHandlers(). */
export function resetCountApprovals() { unregister = null; }
ensureCountApprovals();

/* ============================================================================================================
 * Cancel
 * ========================================================================================================== */

/** Cancels a count that isn't posted: withdraws its waiting approval and posts nothing. Needs inv.count.run. */
export async function cancel(db, scope, id, { note = null, now = new Date() } = {}) {
  const row = await loadCount(db, scope.businessId, id, { lock: true });
  requireCan(scope, 'inv.count.run', { locationId: row.location_id });
  if (row.status === 'cancelled') return { ...(await get(db, scope, row.id)), replayed: true };
  if (row.status === 'posted') throw fail(409, 'This count is already posted. Its corrections are in the stock history; correct anything wrong with an adjustment.', 'count_posted');
  const text = tidy(note);
  if (text.length > 280) throw fail(400, 'Keep the note under 280 characters.', 'note_too_long');
  await approvals.cancel(db, scope, { subject: 'count', subjectId: row.id }, { note: text || null, at: now });
  await db.query(`update public.stock_counts set status = 'cancelled', cancelled_at = $2 where id = $1`, [row.id, now]);
  await audit(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'count', entityId: row.id, action: 'cancel',
    before: { status: row.status }, after: { status: 'cancelled', note: text || null } });
  return { ...(await get(db, scope, row.id)), replayed: false };
}

/* ============================================================================================================
 * Reading
 * ========================================================================================================== */

/** One count's header: status, progress, review totals and approval. Never any expected or variance of a line (see review / sheet). Needs inv.view or inv.count.run. */
export async function get(db, scope, id) {
  const row = await loadCount(db, scope.businessId, id);
  if (!can(scope, 'inv.view', { locationId: row.location_id }) && !can(scope, 'inv.count.run', { locationId: row.location_id })) throw fail(403, 'You don’t have access to this.', 'forbidden');
  const seeCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const hideNumbers = row.blind && ['open', 'counting'].includes(row.status);
  const count = shapeCount(row, { showCost: seeCost && !hideNumbers });
  const approval = row.approval_id ? await approvals.getApproval(db, scope.businessId, row.approval_id) : null;
  return { count, approval: approval && { id: approval.id, status: approval.status, selfApproved: approval.selfApproved, reasons: approval.reasons, decidedByName: approval.decidedByName } };
}
export const view = get;

/**
 * The variance report of a count (needs inv.count.run / inv.count.approve, or inv.view once posted): per line expected, counted, difference and KES, the totals and
 * the share of stock value. Of a posted count this is exactly what was written to the ledger.
 */
export async function report(db, scope, id) {
  const row = await loadCount(db, scope.businessId, id);
  if (!mayReview(scope, row) && !(row.status === 'posted' && can(scope, 'inv.view', { locationId: row.location_id }))) throw fail(403, 'You don’t have access to this.', 'forbidden');
  if (['open', 'counting'].includes(row.status)) throw fail(409, 'The report is ready once counting is finished.', 'review_not_ready');
  const seeCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const rows = await reviewLines(db, scope, row);
  const totals = totalsOf(rows);
  const mov = new Map();
  const ids = rows.map((r) => r.postedMovementId).filter(Boolean);
  if (ids.length) for (const m of (await db.query('select id, delta::text as delta, value::text as value, unit_cost::text as unit_cost from public.stock_movements where id = any($1::bigint[])', [ids])).rows) mov.set(String(m.id), m);
  const lines = stripInternal(rows).filter((r) => r.decision !== 'skipped').map((r) => ({
    itemId: r.itemId, name: r.name, category: r.category, expected: r.expected, expectedAtCount: r.expectedAtCount, movementsSince: r.movementsSince, counted: r.counted, variance: r.variance,
    direction: r.direction, valueKes: r.valueKes, counters: r.entries.filter((e) => e.inCurrentRound).map((e) => e.counterName),
    posted: r.postedMovementId ? { movementId: r.postedMovementId, delta: mov.get(String(r.postedMovementId))?.delta ?? null, valueKes: seeCost ? mov.get(String(r.postedMovementId))?.value ?? null : null } : null,
  }));
  return { count: shapeCount(row, { showCost: seeCost }), final: row.status === 'posted', lines, skipped: stripInternal(rows).filter((r) => r.decision === 'skipped').map((r) => ({ itemId: r.itemId, name: r.name, reason: r.skipReason })),
    totals: shapeTotals(totals, seeCost) };
}

/**
 * Sessions the caller can see (newest first). Filters: locationId, status (comma list), type, limit (max 200), before (the nextBefore marker).
 */
export async function list(db, scope, { locationId = null, status = null, type = null, limit = 60, before = null } = {}) {
  const places = [...scope.locationCaps].filter(([, caps]) => caps.has('inv.view') || caps.has('inv.count.run')).map(([id]) => id);
  if (!places.length) throw fail(403, 'You don’t have access to this.', 'forbidden');
  let wanted = places;
  if (locationId) {
    const id = needId(locationId, 'The branch');
    if (!places.includes(id)) throw fail(403, 'You don’t have access to this branch.', 'branch_forbidden');
    wanted = [id];
  }
  const args = [scope.businessId, wanted];
  const where = ['c.business_id = $1', 'c.location_id = any($2::uuid[])'];
  const arg = (v) => { args.push(v); return `$${args.length}`; };
  if (status) {
    const list2 = String(status).split(',').map((s) => s.trim());
    if (!list2.every((s) => STATUSES.includes(s))) throw fail(400, `The status must be one of: ${STATUSES.join(', ')}.`, 'bad_status');
    where.push(`c.status = any(${arg(list2)}::text[])`);
  }
  if (type) {
    if (!TYPES.includes(type)) throw fail(400, 'The type must be full, cycle or spot.', 'bad_type');
    where.push(`c.type = ${arg(type)}`);
  }
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 60, 1), 200);
  if (before) {
    const [at, lastId] = String(before).split('|');
    const t = new Date(at);
    if (Number.isNaN(t.getTime())) throw fail(400, 'The page marker is invalid. Start from the top.', 'bad_cursor');
    where.push(`(c.created_at, c.id) < (${arg(t)}::timestamptz, ${arg(needId(lastId, 'The page marker'))}::uuid)`);
  }
  const rows = (await db.query(`${COUNT_SELECT} where ${where.join(' and ')} order by c.created_at desc, c.id desc limit ${size + 1}`, args)).rows;
  const page = rows.slice(0, size);
  return {
    counts: page.map((r) => shapeCount(r, { showCost: can(scope, 'inv.cost.view', { locationId: r.location_id }) && !(r.blind && ['open', 'counting'].includes(r.status)) })),
    nextBefore: rows.length > size ? `${new Date(page.at(-1).created_at).toISOString()}|${page.at(-1).id}` : null,
  };
}

/**
 * Cycle-count suggestions for a place: items whose last posted count is oldest (never counted first), or highest stock value. { n = 20, by = 'oldest' | 'value' }.
 */
export async function suggestCycle(db, scope, locationId, { n = 20, by = 'oldest' } = {}) {
  const loc = scope.locations.find((l) => l.id === String(locationId || '').toLowerCase());
  if (!loc) throw fail(404, 'That branch or warehouse isn’t part of this business.', 'location_not_found');
  requireCan(scope, 'inv.count.run', { locationId: loc.id });
  const size = Math.min(Math.max(Number.parseInt(n, 10) || 20, 1), 100);
  if (!['oldest', 'value'].includes(by)) throw fail(400, 'Order suggestions by oldest or value.', 'bad_order');
  const seeCost = can(scope, 'inv.cost.view', { locationId: loc.id });
  const rows = (await db.query(`select i.id, i.name, b.on_hand::text as on_hand, (b.on_hand * coalesce(i.avg_cost, 0))::numeric(16, 2)::text as value,
      (select max(c.posted_at) from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.item_id = i.id and c.location_id = b.location_id and c.status = 'posted' and l.decision is distinct from 'skipped') as last_counted
    from public.stock_balances b join public.stock_items i on i.id = b.item_id
    where b.location_id = $1 and i.business_id = $2 and i.archived_at is null
      and not exists (select 1 from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.item_id = i.id and c.location_id = b.location_id and c.status in ('open', 'counting', 'under_review', 'approved'))
    order by ${by === 'value' ? '(b.on_hand * coalesce(i.avg_cost, 0)) desc, i.name' : 'last_counted asc nulls first, i.name'} limit ${size}`, [loc.id, scope.businessId])).rows;
  return { items: rows.map((r) => ({ itemId: r.id, name: r.name, onHand: r.on_hand, valueKes: seeCost ? r.value : null, lastCountedAt: r.last_counted })) };
}

/* ============================================================================================================
 * Spot count shortcut
 * ============================================================================================================ */

/**
 * "Count this item": one to ten items, the caller is the only counter. Creates a spot session, enters the numbers, finishes and sends it on in one go: a spot count
 * with no difference posts nothing; a difference follows the same approval rules as any count. Items: [{ itemId, quantity, unit? }].
 */
export async function spotCount(db, scope, input = {}, { now = new Date() } = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw fail(400, 'Choose the item you counted and enter how much there is.', 'filter_required');
  const made = await create(db, scope, { locationId: input.locationId, type: 'spot', itemIds: items.map((i) => i.itemId), blind: false, note: input.note, zone: input.zone, commandId: input.commandId }, { now });
  if (made.replayed) return made;
  const id = made.count.id;
  for (const i of items) await enterCount(db, scope, id, { itemId: i.itemId, quantity: i.quantity, unit: i.unit, note: i.note, confirmLarge: input.confirmLarge === true }, { now });
  await finishCounting(db, scope, id, {}, { now });
  return { ...(await submitReview(db, scope, id, { now })), replayed: false };
}
