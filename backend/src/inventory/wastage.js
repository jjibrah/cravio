// Wastage (WST-1..5, P3-04, migration 019). A person writes stock off at a location: one stock item in any of its units, or a DISH x portions that is
// expanded through the recipe in force (yield applied, take-away-only lines left out) into one ledger movement per ingredient. Every posted record
// is a ledger movement of reason 'wastage' (a separate type in reports), carrying ref_type 'wastage' / ref_id = the record.
//
//   record(db, scope, { locationId, itemId | menuItemId, quantity, unit?, reasonCodeId | reasonCode, note?, photoIds?, id?, commandId? }, { now })
//   get / list / locationOf                                  history for the Wastage report: filters reason, item (also inside dishes), employee, branch, date
//   ensureWastageApprovals()                                 registers the decision callback (approvals.onDecided('wastage'))
//
// Approval (D3-4, D2-16): there is NO built-in amount. approvals.evaluate('wastage', value): with no rule the record posts at once; when the owner's
// rule says approval, the record is saved as pending_approval, NOTHING posts, and the approvers are asked once. Approving posts with key
// wastage:<id>:<line> (a replay never posts twice); rejecting keeps the record and posts nothing. Maker-checker is the engine's (D2-5).
// Cost is FROZEN at record time from the weighted-average cost and shown on the record; an approved record posts at that frozen cost, so the
// amount the approver saw is the amount that leaves the books. Some ingredient without a cost: value is null (cost_unknown), and when the owner has
// a wastage rule the record goes to approval (we can't prove it is under the limit).
// The legacy setting wastage_approval_value_kes becomes a rule the first time a record is made after the migration (then the setting is cleared).
// Unusual wastage: after a posted record, the item's wastage value at the location in the last 7 days is compared with the weekly average of the 28 days
// before; more than unusual_wastage_factor x that average (and above unusual_wastage_floor_kes when set; no history = no alert) tells the owners and the
// branch's managers once per item per Nairobi week.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { COST, MONEY, QTY, add, cmp, dec, div, isZero, mul, rescale } from './decimal.js';
import { display, normaliseUnit, toBase } from './units.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { loadUnits } from './catalogue.js';
import { loadDish } from './recipes.js';
import { postMany } from './ledger.js';
import * as approvals from './approvals.js';
import { resolve as resolveReason } from './reasons.js';
import { list as listAttachments } from './attachments.js';
import { nextNumber } from './numbers.js';
import { notify } from './notifications.js';
import { getSettings, resetSetting } from './policies.js';
import { record as audit } from './audit.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const lc = (id) => (id ? String(id).toLowerCase() : null);
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};
const money = (d) => (d === null || d === undefined ? null : dec(d).toString(MONEY));
const kes = (v) => `KES ${Number(dec(v).toString(MONEY)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
export const STATUSES = Object.freeze(['recorded', 'pending_approval', 'approved', 'rejected']);
const MAX_PHOTOS = 5;
const MAX_NOTE = 500;
export const NUMBER_KIND = 'WST';

const locationOfScope = (scope, locationId) => {
  const loc = scope.locations.find((l) => l.id === lc(locationId));
  if (!loc) throw fail(404, 'That branch or warehouse isn’t part of this business.', 'location_not_found');
  return loc;
};

/* ---------- reading what is being wasted ---------- */

async function loadItemRow(db, businessId, itemId) {
  const { rows } = await db.query(`select id, name, unit, display_unit, avg_cost::text as avg_cost, archived_at from public.stock_items where id = $1 and business_id = $2`, [itemId, businessId]);
  if (!rows[0]) throw fail(404, 'That stock item isn’t in this business. Pick it from the stock list.', 'item_not_found');
  const own = (await db.query('select name, factor::text as factor from public.stock_item_units where item_id = $1 order by position, lower(name)', [itemId])).rows;
  return { row: rows[0], item: { name: rows[0].name, baseUnit: rows[0].unit, displayUnit: rows[0].display_unit || undefined, units: own } };
}

/** Value of `qtyBase` at an average cost (money, half-up), or null when the item has no cost yet. */
const valueOf = (qtyBase, avgCost) => (avgCost === null || avgCost === undefined ? null : mul(qtyBase, avgCost, MONEY, 'half-up'));

/** One item: its single line. */
function itemLines(row, qtyBase) {
  const value = valueOf(qtyBase, row.avg_cost);
  return [{ itemId: row.id, name: row.name, qtyBase: dec(qtyBase).toString(QTY), unitCost: row.avg_cost === null ? null : dec(row.avg_cost).toString(COST), value: value ? value.toString(MONEY) : null }];
}

/**
 * A dish x portions expanded through the recipe version in force (or the 009 single link when it has no recipe): per ingredient
 * qty_base x portions / (yield / 100), at 4 dp, take-away-only lines left out (like the food cost). 1 burger with 200 g chicken at 70 % yield = 285.7143 g.
 */
async function dishLines(db, scope, dish, portions) {
  const recipe = (await db.query('select current_version_id from public.recipes where menu_item_id = $1', [dish.id])).rows[0];
  let rows = [];
  if (recipe?.current_version_id) {
    rows = (await db.query(`select item_id, qty_base::text as qty_base from public.recipe_lines where version_id = $1 and takeaway_only is not true order by position`, [recipe.current_version_id])).rows;
  } else {
    const link = (await db.query('select item_id, servings::text as qty_base from public.menu_item_stock where menu_item_id = $1', [dish.id])).rows[0];
    if (link) rows = [link];
  }
  if (!rows.length) throw fail(400, `${dish.name} has no recipe, so Cravio doesn’t know which stock to write off. Add its recipe first, or write off the ingredients one by one.`, 'dish_not_tracked');
  const items = new Map((await db.query(`select id, name, avg_cost::text as avg_cost, yield_pct::text as yield_pct from public.stock_items where business_id = $1 and id = any($2::uuid[])`,
    [scope.businessId, rows.map((r) => r.item_id)])).rows.map((r) => [r.id, r]));
  const merged = new Map();
  for (const r of rows) {
    const item = items.get(r.item_id);
    if (!item) continue;
    const gross = div(mul(mul(r.qty_base, portions, 12, 'exact'), 100, 12, 'exact'), item.yield_pct ?? 100, QTY, 'half-up');
    if (isZero(gross)) continue;
    merged.set(item.id, { item, qty: merged.has(item.id) ? add(merged.get(item.id).qty, gross) : gross });
  }
  if (!merged.size) throw fail(400, `${dish.name}’s recipe is too small to write off that amount.`, 'dish_too_small');
  return [...merged.values()].map(({ item, qty }) => {
    const value = valueOf(qty, item.avg_cost);
    return { itemId: item.id, name: item.name, qtyBase: qty.toString(QTY), unitCost: item.avg_cost === null ? null : dec(item.avg_cost).toString(COST), value: value ? value.toString(MONEY) : null };
  });
}

const totalOf = (lines) => {
  if (lines.some((l) => l.value === null)) return null;
  return lines.reduce((sum, l) => add(sum, l.value), dec(0)).toString(MONEY);
};

/* ---------- photos ---------- */

async function checkPhotos(db, businessId, locationId, recordId, photoIds) {
  if (photoIds === undefined || photoIds === null) return [];
  if (!Array.isArray(photoIds)) throw fail(400, 'photoIds must be a list of uploaded photo ids.', 'bad_photo');
  const ids = [...new Set(photoIds.map((id) => needId(id, 'A photo')))];
  if (ids.length > MAX_PHOTOS) throw fail(400, `Attach at most ${MAX_PHOTOS} photos.`, 'too_many_photos');
  if (!ids.length) return [];
  const found = (await db.query(`select id from public.attachments where business_id = $1 and entity_type = 'wastage' and entity_id = $2 and location_id = $3
    and deleted_at is null and id = any($4::uuid[])`, [businessId, recordId, locationId, ids])).rows.map((r) => r.id);
  if (found.length !== ids.length) throw fail(400, 'One of the photos wasn’t uploaded for this wastage record. Upload it again, then record the wastage.', 'bad_photo');
  return ids;
}

/* ---------- the legacy limit ---------- */

/** wastage_approval_value_kes (Phase 1 setting) becomes a business-wide wastage rule once, when no wastage rule exists; the setting is then cleared. */
async function migrateLegacyLimit(db, scope, settings) {
  const limit = settings.wastage_approval_value_kes;
  if (limit === null || limit === undefined) return false;
  const exists = (await db.query(`select 1 from public.approval_rules where business_id = $1 and subject = 'wastage'`, [scope.businessId])).rows[0];
  if (!exists) {
    const row = (await db.query(`insert into public.approval_rules (business_id, subject, per_transaction_kes, approver_capability, created_by, updated_by)
      values ($1, 'wastage', $2, 'inv.adjust.approve', $3, $3) on conflict do nothing returning id`, [scope.businessId, dec(limit).toString(MONEY), scope.userId])).rows[0];
    if (row) await audit(db, { businessId: scope.businessId, actorId: scope.userId, actorRole: scope.role, entity: 'approval_rule', entityId: row.id, action: 'migrate_wastage_limit',
      after: { subject: 'wastage', perTransactionKes: dec(limit).toString(MONEY), from: 'setting wastage_approval_value_kes' } });
  }
  await resetSetting(db, { businessId: scope.businessId, key: 'wastage_approval_value_kes', actorId: scope.userId, actorRole: scope.role });
  return true;
}

/* ---------- posting ---------- */

async function postLines(db, rec, lines, { actorId, at }) {
  const single = rec.item_id && lines.length === 1;
  const noteText = [rec.menu_item_name ? `${rec.menu_item_name} x ${dec(rec.entered_quantity).toString(QTY).replace(/\.?0+$/, '')}` : null, rec.reason_text, rec.note].filter(Boolean).join(': ').slice(0, 280) || null;
  const entries = lines.map((l) => ({
    businessId: rec.business_id, locationId: rec.location_id, itemId: l.item_id, qty: `-${dec(l.qty_base).toString(QTY)}`, reason: 'wastage',
    ref: { type: 'wastage', id: rec.id }, note: noteText, actorId, idempotencyKey: `wastage:${rec.id}:${l.position}`, occurredAt: at,
    unitCost: l.unit_cost === null ? null : dec(l.unit_cost).toString(COST),
    entered: single ? { quantity: dec(rec.entered_quantity).toString(QTY), unit: rec.entered_unit } : null,
  }));
  const results = await postMany(db, entries);
  const ids = results.map((r) => r.movement.id);
  await db.query('update public.wastage_records set movement_ids = $2::bigint[], posted_at = $3 where id = $1', [rec.id, `{${ids.join(',')}}`, at]);
  return results;
}

const lineRows = async (db, recordId) => (await db.query(`select item_id, position, qty_base::text as qty_base, unit_cost::text as unit_cost, value_kes::text as value_kes
  from public.wastage_record_lines where record_id = $1 order by position`, [recordId])).rows;

/* ---------- unusual wastage ---------- */

const weekKey = (now) => {
  const local = new Date(now.getTime() + OFFSET_MS);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(dayStart - ((local.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};

/**
 * This item's wastage value at this location over the last 7 days against its weekly average of the 28 days before. Returns the numbers and whether
 * an alert was due ({ unusual, thisWeek, average, factor }) and tells the owners and the branch's managers once per item per week.
 */
export async function checkUnusual(db, scope, { locationId, itemId, recordId = null, now = new Date() }) {
  const settings = await getSettings(db, scope.businessId, locationId);
  const factor = Number(settings.unusual_wastage_factor);
  const floor = settings.unusual_wastage_floor_kes;
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const baseStart = new Date(now.getTime() - 35 * DAY_MS);
  const sums = (await db.query(`select coalesce(sum(case when occurred_at > $4 then -value end), 0)::text as week, coalesce(sum(case when occurred_at <= $4 then -value end), 0)::text as before
    from public.stock_movements where business_id = $1 and location_id = $2 and item_id = $3 and reason in ('wastage', 'waste') and value is not null
      and occurred_at > $5 and occurred_at <= $6`, [scope.businessId, locationId, itemId, weekStart, baseStart, now])).rows[0];
  const thisWeek = dec(sums.week);
  const average = div(sums.before, 4, MONEY, 'half-up');
  const result = { unusual: false, thisWeek: thisWeek.toString(MONEY), average: average.toString(MONEY), factor };
  if (isZero(average) || cmp(thisWeek, mul(average, factor, 6, 'half-up')) <= 0) return result;
  if (floor !== null && floor !== undefined && cmp(thisWeek, floor) < 0) return result;
  result.unusual = true;
  const loc = scope.locations.find((l) => l.id === locationId);
  const name = (await db.query('select name from public.stock_items where id = $1', [itemId])).rows[0]?.name || 'An item';
  const place = loc?.name || 'a branch';
  const times = Number(div(thisWeek, average, 1, 'half-up').toString(1));
  result.notified = await notify(db, { businessId: scope.businessId, recipients: ['owners', ...(loc?.restaurantId ? [`branch_managers:${loc.restaurantId}`] : [])], kind: 'wastage_unusual',
    title: `Unusual wastage: ${name}`, body: `${name} wastage at ${place} was ${kes(thisWeek)} in the last 7 days, ${times} times its usual ${kes(average)} a week.`,
    link: '/owner/inventory/wastage', entity: recordId ? { type: 'wastage', id: recordId } : null, locationId, dedupeKey: `wastage_unusual:${locationId}:${itemId}:${weekKey(now)}` });
  return result;
}

/* ---------- record ---------- */

const RECORD_SELECT = `select w.*, w.value_kes::text as value_text, w.entered_quantity::text as entered_text, w.qty_base::text as qty_text, l.name as location_name, r.name as branch_name,
    coalesce(i.name, w.menu_item_name) as subject_name, rc.code as reason_code, rc.label as reason_label, p.name as recorded_by_name, a.status as approval_status
  from public.wastage_records w join public.stock_locations l on l.id = w.location_id left join public.restaurants r on r.id = l.restaurant_id
  left join public.stock_items i on i.id = w.item_id left join public.stock_reason_codes rc on rc.id = w.reason_code_id left join public.profiles p on p.id = w.recorded_by
  left join public.approvals a on a.id = w.approval_id`;

const shapeRow = (r, showCost) => ({
  id: r.id, number: r.number, locationId: r.location_id, locationName: r.branch_name || r.location_name,
  kind: r.menu_item_id ? 'dish' : 'item', itemId: r.item_id, menuItemId: r.menu_item_id, name: r.subject_name,
  quantity: r.entered_text, unit: r.entered_unit, quantityBase: r.qty_text,
  reason: { id: r.reason_code_id, code: r.reason_code, label: r.reason_label || r.reason_text }, note: r.note,
  valueKes: showCost ? r.value_text : null, costUnknown: showCost ? r.cost_unknown : undefined,
  status: r.status, approvalId: r.approval_id, movementIds: r.movement_ids, photoIds: r.photo_attachment_ids,
  recordedBy: r.recorded_by, recordedByName: r.recorded_by_name || null, occurredAt: r.occurred_at, postedAt: r.posted_at,
});

/** Where a record is (for routes that authorise before the transaction). 404 when it isn't this business's. */
export async function locationOf(db, businessId, id) {
  if (!isId(id)) throw fail(400, 'That wastage record id is invalid.', 'bad_id');
  const row = (await db.query('select location_id from public.wastage_records where id = $1 and business_id = $2', [id.toLowerCase(), businessId])).rows[0];
  if (!row) throw fail(404, 'That wastage record doesn’t exist.', 'wastage_not_found');
  return { locationId: row.location_id };
}

/**
 * Writes stock off. Returns { wastage (the record, with lines), posted: boolean, pendingApproval: boolean, replayed, evaluation, movements: [...], balance, unusual }.
 *   locationId     the branch or warehouse (the caller needs inv.adjust.create THERE: managers their own branch, owners anywhere)
 *   itemId         a stock item, with quantity in any unit it has (unit defaults to its display unit)      -- OR --
 *   menuItemId     a dish of that branch; quantity = portions (decimals allowed), expanded through its recipe
 *   reasonCodeId   from /reason-codes; `reasonCode` (a code or label) is accepted too. Free text is only for the old branch route (allowFreeText).
 *   note, photoIds (uploaded as entity 'wastage' with entityId = id; send the same `id` here), commandId (a retry returns the same record)
 */
export async function record(db, scope, input = {}, { now = new Date(), allowFreeText = false, requireNote = false } = {}) {
  const loc = locationOfScope(scope, input.locationId);
  requireCan(scope, 'inv.adjust.create', { locationId: loc.id });
  const hasItem = input.itemId !== undefined && input.itemId !== null && input.itemId !== '';
  const hasDish = input.menuItemId !== undefined && input.menuItemId !== null && input.menuItemId !== '';
  if (hasItem === hasDish) throw fail(400, hasItem ? 'Choose either a stock item or a dish, not both.' : 'Choose what was wasted: a stock item or a dish.', 'subject_required');

  // A retry with the same commandId gets the same record back.
  let commandId = null;
  if (input.commandId !== undefined && input.commandId !== null) {
    commandId = needId(input.commandId, 'The request id');
    const prior = (await db.query('select id from public.wastage_records where business_id = $1 and command_id = $2', [scope.businessId, commandId])).rows[0];
    if (prior) return { ...(await view(db, scope, prior.id)), replayed: true };
  }

  const recordId = input.id ? needId(input.id, 'The wastage record id') : randomUUID();
  if (input.id && (await db.query('select 1 from public.wastage_records where id = $1', [recordId])).rows[0]) throw fail(409, 'That wastage record id is already used.', 'id_taken');

  // Quantity and what it is.
  if (input.quantity === undefined || input.quantity === null || String(input.quantity).trim() === '') throw fail(400, hasDish ? 'Enter how many portions.' : 'Enter how much.', 'quantity_required');
  const typed = dec(typeof input.quantity === 'string' ? input.quantity.trim() : input.quantity, { label: hasDish ? 'The portions' : 'The amount' });
  if (cmp(typed, 0) <= 0) throw fail(400, 'The amount must be more than zero.', 'zero_quantity');
  let lines; let subject; let enteredUnit; let qtyBase; let enteredQty;
  if (hasItem) {
    const itemId = needId(input.itemId, 'The stock item');
    const { row, item } = await loadItemRow(db, scope.businessId, itemId);
    if (row.archived_at) throw fail(409, `${row.name} is archived, so its stock can’t change. Restore it first.`, 'item_archived');
    const units = await loadUnits(db);
    const unit = input.unit === undefined || input.unit === null || String(input.unit).trim() === '' ? (item.displayUnit ?? item.baseUnit) : String(input.unit).trim();
    qtyBase = toBase(typed.toString(), unit, item, units, { positive: true, label: 'The amount' });
    enteredUnit = normaliseUnit(unit, item, units) || item.baseUnit;
    enteredQty = rescale(typed, QTY, 'half-up').toString(QTY);
    lines = itemLines(row, qtyBase);
    subject = { itemId, name: row.name };
  } else {
    const dish = await loadDish(db, scope, input.menuItemId);
    if (!loc.restaurantId || dish.restaurantId !== loc.restaurantId) throw fail(400, `${dish.name} is on another branch’s menu. Record the wastage at the branch that makes it.`, 'dish_other_branch');
    enteredQty = rescale(typed, QTY, 'half-up').toString(QTY);
    qtyBase = enteredQty;
    enteredUnit = 'portion';
    lines = await dishLines(db, scope, dish, enteredQty);
    subject = { menuItemId: dish.id, name: dish.name };
  }
  const total = totalOf(lines);
  const costUnknown = total === null;

  // Reason, note, photos.
  const reason = await resolveReason(db, scope.businessId, 'wastage', { id: input.reasonCodeId, code: input.reasonCode });
  let reasonText = reason?.label ?? null;
  if (!reason) {
    const free = tidy(input.reasonCode);
    const askedById = input.reasonCodeId !== undefined && input.reasonCodeId !== null && input.reasonCodeId !== '';
    if (allowFreeText && !askedById) reasonText = (free || 'Not stated').slice(0, 60);          // the old branch route: free text is kept as text
    else if (free && !askedById) throw fail(404, 'That reason isn’t in your list. Pick one from the list.', 'reason_not_found');
    else throw fail(400, 'Pick a reason for the wastage.', 'reason_required');
  }
  const note = tidy(input.note);
  if (note.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');
  if ((reason?.needsNote || requireNote) && !note) throw fail(400, requireNote && !reason?.needsNote ? `Say why ${subject.name} was written off, e.g. “spoiled” or “dropped”.` : `“${reason.label}” needs a note. Say what happened.`, 'note_required');
  const photoIds = await checkPhotos(db, scope.businessId, loc.id, recordId, input.photoIds);
  if (reason?.needsPhoto && !photoIds.length) throw fail(400, `“${reason.label}” needs a photo. Take one, then record the wastage.`, 'photo_required');

  // Does it need approval? (Nothing is built in: with no rule it posts at once.)
  const settings = await getSettings(db, scope.businessId);
  await migrateLegacyLimit(db, scope, settings);
  const evaluation = await approvals.evaluate(db, { businessId: scope.businessId, subject: 'wastage', locationId: loc.id, amountKes: total ?? '0', at: now, lock: false });
  let needsApproval = evaluation.needsApproval;
  if (!needsApproval && costUnknown && evaluation.rules.length) {
    needsApproval = true;
    evaluation.reasons.push('Some of this stock has no cost yet, so Cravio can’t check it against your limit.');
  }

  const number = await nextNumber(db, { businessId: scope.businessId, kind: NUMBER_KIND, now });
  const status = needsApproval ? 'pending_approval' : 'recorded';
  let inserted;
  try {
    inserted = (await db.query(`insert into public.wastage_records (id, business_id, location_id, number, item_id, menu_item_id, menu_item_name, entered_quantity, entered_unit, qty_base,
        reason_code_id, reason_text, note, photo_attachment_ids, value_kes, cost_unknown, status, recorded_by, command_id, occurred_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid[], $15, $16, $17, $18, $19, $20) returning id`,
    [recordId, scope.businessId, loc.id, number, subject.itemId ?? null, subject.menuItemId ?? null, subject.menuItemId ? subject.name : null, enteredQty, enteredUnit, qtyBase,
      reason?.id ?? null, reasonText, note || null, `{${photoIds.join(',')}}`, total, costUnknown, status, scope.userId, commandId, now])).rows[0];
  } catch (error) {
    if (error?.code === '23505' && commandId && /command/.test(`${error.constraint || ''} ${error.message}`)) {
      const prior = (await db.query('select id from public.wastage_records where business_id = $1 and command_id = $2', [scope.businessId, commandId])).rows[0];
      if (prior) return { ...(await view(db, scope, prior.id)), replayed: true };
    }
    throw error;
  }
  for (const [position, l] of lines.entries()) {
    await db.query(`insert into public.wastage_record_lines (record_id, business_id, item_id, position, qty_base, unit_cost, value_kes) values ($1, $2, $3, $4, $5, $6, $7)`,
      [inserted.id, scope.businessId, l.itemId, position, l.qtyBase, l.unitCost, l.value]);
  }

  const out = { posted: false, pendingApproval: needsApproval, evaluation: { needsApproval, reasons: evaluation.reasons, safeDefault: evaluation.safeDefault }, movements: [], balance: null, unusual: null, replayed: false };
  if (needsApproval) {
    const approval = await approvals.request(db, { businessId: scope.businessId, subject: 'wastage', subjectId: inserted.id, locationId: loc.id, requestedBy: scope.userId,
      requestedByRole: scope.role, amountKes: total ?? '0', evaluation, at: now });
    await db.query('update public.wastage_records set approval_id = $2 where id = $1', [inserted.id, approval.id]);
    await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'wastage', entityId: inserted.id, action: 'request',
      after: { number, status, name: subject.name, quantity: enteredQty, unit: enteredUnit, valueKes: total, approvalId: approval.id, reasons: evaluation.reasons } });
  } else {
    const rec = (await db.query('select * from public.wastage_records where id = $1', [inserted.id])).rows[0];
    const results = await postLines(db, rec, await lineRows(db, inserted.id), { actorId: scope.userId, at: now });
    out.posted = true;
    out.movements = results.map((r) => r.movement);
    out.balance = results.at(-1).balance;
    await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'wastage', entityId: inserted.id, action: 'record',
      after: { number, status, name: subject.name, quantity: enteredQty, unit: enteredUnit, valueKes: total, movementIds: results.map((r) => r.movement.id) } });
    out.unusual = await unusualFor(db, scope, loc.id, lines.map((l) => l.itemId), inserted.id, now);
  }
  return { ...out, wastage: (await view(db, scope, inserted.id)).wastage };
}

async function unusualFor(db, scope, locationId, itemIds, recordId, now) {
  const alerts = [];
  for (const itemId of itemIds) {
    const r = await checkUnusual(db, scope, { locationId, itemId, recordId, now });
    if (r.unusual) alerts.push({ itemId, thisWeek: r.thisWeek, average: r.average, factor: r.factor });
  }
  return alerts.length ? alerts : null;
}

/* ---------- the approvals engine calls this ---------- */

/**
 * Approved -> posts the record's movements (key wastage:<id>:<line>, at the cost frozen when it was recorded) and marks it approved; rejected -> marks it
 * rejected and posts nothing. Anything else (the record already decided) is left alone. If the stock is no longer there the approval fails with the
 * ledger's plain message and the decision is rolled back, so the approver can reject it or try again after a delivery.
 */
export async function applyDecision(db, approval, { scope }) {
  const rec = (await db.query('select * from public.wastage_records where id = $1 and business_id = $2 for update', [approval.subjectId, approval.businessId])).rows[0];
  if (!rec || rec.status !== 'pending_approval') return null;
  const at = approval.decidedAt ? new Date(approval.decidedAt) : new Date();
  if (approval.status === 'approved') {
    await db.query(`update public.wastage_records set status = 'approved' where id = $1`, [rec.id]);
    let results;
    try {
      results = await postLines(db, rec, await lineRows(db, rec.id), { actorId: rec.recorded_by, at });
    } catch (error) {
      if (error instanceof HttpError && ['insufficient_stock', 'stock_reserved'].includes(error.details?.code)) {
        throw fail(409, `This can’t be approved yet. ${error.message}`, error.details.code);
      }
      throw error;
    }
    await audit(db, { businessId: rec.business_id, locationId: rec.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'wastage', entityId: rec.id,
      action: approval.selfApproved ? 'approve_self' : 'approve', before: { status: 'pending_approval' },
      after: { status: 'approved', approvalId: approval.id, valueKes: money(rec.value_kes), movementIds: results.map((r) => r.movement.id), selfApproved: approval.selfApproved } });
    await unusualFor(db, scope, rec.location_id, (await lineRows(db, rec.id)).map((l) => l.item_id), rec.id, at);
  } else if (approval.status === 'rejected') {
    await db.query(`update public.wastage_records set status = 'rejected' where id = $1`, [rec.id]);
    await audit(db, { businessId: rec.business_id, locationId: rec.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'wastage', entityId: rec.id, action: 'reject',
      before: { status: 'pending_approval' }, after: { status: 'rejected', note: approval.decisionNote } });
  }
  return rec.id;
}
let unregister = null;
/** Registers the decision callback once per process. */
export function ensureWastageApprovals() {
  if (!unregister) unregister = approvals.onDecided('wastage', applyDecision);
  return unregister;
}
/** For tests: forget the registration so ensureWastageApprovals() adds it back after approvals.clearDecisionHandlers(). */
export function resetWastageApprovals() { unregister = null; }
ensureWastageApprovals();
// Shared with adjustments.js / allowances.js (P3-05): what an item or a dish expands to, and what it is worth.
export { dishLines, itemLines, loadItemRow, totalOf };

/* ---------- reading ---------- */

/** One record with its lines, photos and approval. Needs inv.view at its location (404 when it isn't this business's). */
export async function view(db, scope, id) {
  if (!isId(id)) throw fail(400, 'That wastage record id is invalid.', 'bad_id');
  const row = (await db.query(`${RECORD_SELECT} where w.id = $1 and w.business_id = $2`, [id.toLowerCase(), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That wastage record doesn’t exist.', 'wastage_not_found');
  requireCan(scope, 'inv.view', { locationId: row.location_id });
  const showCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const lines = (await db.query(`select l.item_id, l.position, l.qty_base::text as qty_base, l.unit_cost::text as unit_cost, l.value_kes::text as value_kes, i.name, i.unit, i.display_unit
    from public.wastage_record_lines l join public.stock_items i on i.id = l.item_id where l.record_id = $1 order by l.position`, [row.id])).rows;
  const units = await loadUnits(db);
  const own = lines.length ? (await db.query(`select item_id, name, factor::text as factor from public.stock_item_units where item_id = any($1::uuid[]) order by position, lower(name)`, [lines.map((l) => l.item_id)])).rows : [];
  const photos = await listAttachments(db, scope, { entityType: 'wastage', entityId: row.id });
  const approval = row.approval_id ? await approvals.getApproval(db, scope.businessId, row.approval_id) : null;
  return {
    wastage: {
      ...shapeRow(row, showCost),
      lines: lines.map((l) => ({ itemId: l.item_id, name: l.name, quantityBase: l.qty_base,
        display: display(l.qty_base, { name: l.name, baseUnit: l.unit, displayUnit: l.display_unit || undefined, units: own.filter((o) => o.item_id === l.item_id) }, units),
        unitCost: showCost ? l.unit_cost : null, valueKes: showCost ? l.value_kes : null })),
      photos: photos.map((p) => ({ id: p.id, name: p.name, mime: p.mime })),
      approval: approval && { id: approval.id, status: approval.status, decidedByName: approval.decidedByName, decidedAt: approval.decidedAt, decisionNote: approval.decisionNote,
        selfApproved: approval.selfApproved, reasons: approval.reasons },
    },
  };
}
export const get = view;

const parseDate = (value, label) => {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw fail(400, `${label} isn’t a valid date.`, 'bad_date');
  return t;
};

/**
 * The wastage log (newest first) for the places the caller can view, with totals by reason for the same filters (posted records only: recorded + approved).
 * Filters: locationId, reason (code or id), itemId (also matches dishes that used it), menuItemId, employee (user id), status, from, to (Nairobi day boundaries are the
 * caller's: pass ISO times), limit (max 200), before (the nextBefore marker).
 */
export async function list(db, scope, { locationId = null, reason = null, itemId = null, menuItemId = null, employee = null, status = null, from = null, to = null, limit = 60, before = null } = {}) {
  const visible = locationsWith(scope, 'inv.view');
  if (!visible.length) throw fail(403, 'You don’t have access to this.', 'forbidden');
  const costPlaces = locationsWith(scope, 'inv.cost.view');
  let places = visible;
  if (locationId) {
    const id = needId(locationId, 'The branch');
    if (!visible.includes(id)) throw fail(403, 'You don’t have access to this branch.', 'branch_forbidden');
    places = [id];
  }
  const args = [scope.businessId, places];
  const where = ['w.business_id = $1', 'w.location_id = any($2::uuid[])'];
  const arg = (value) => { args.push(value); return `$${args.length}`; };
  if (reason) {
    if (isId(reason)) where.push(`w.reason_code_id = ${arg(reason.toLowerCase())}`);
    else where.push(`w.reason_code_id in (select id from public.stock_reason_codes where business_id = $1 and kind = 'wastage' and code = ${arg(String(reason).toLowerCase())})`);
  }
  if (itemId) where.push(`(w.item_id = ${arg(needId(itemId, 'The item'))} or exists (select 1 from public.wastage_record_lines x where x.record_id = w.id and x.item_id = $${args.length}))`);
  if (menuItemId) where.push(`w.menu_item_id = ${arg(needId(menuItemId, 'The dish'))}`);
  if (employee) where.push(`w.recorded_by = ${arg(needId(employee, 'The employee'))}`);
  if (status) {
    const wanted = String(status).split(',').map((s) => s.trim());
    if (!wanted.every((s) => STATUSES.includes(s))) throw fail(400, `The status must be one of: ${STATUSES.join(', ')}.`, 'bad_status');
    where.push(`w.status = any(${arg(wanted)}::text[])`);
  }
  if (from) where.push(`w.occurred_at >= ${arg(parseDate(from, 'The start date'))}`);
  if (to) where.push(`w.occurred_at < ${arg(parseDate(to, 'The end date'))}`);
  const filtered = where.join(' and ');
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 60, 1), 200);
  let cursor = '';
  if (before) {
    const [at, lastId] = String(before).split('|');
    cursor = ` and (w.occurred_at, w.id) < (${arg(parseDate(at, 'The page marker'))}::timestamptz, ${arg(needId(lastId, 'The page marker'))}::uuid)`;
  }
  const rows = (await db.query(`${RECORD_SELECT} where ${filtered}${cursor} order by w.occurred_at desc, w.id desc limit ${size + 1}`, args.slice(0, args.length))).rows;
  const page = rows.slice(0, size);
  const totalArgs = args.slice(0, args.length - (before ? 2 : 0));
  totalArgs.push(costPlaces);
  const costArg = `$${totalArgs.length}`;
  const totals = (await db.query(`select coalesce(rc.code, 'other') as code, coalesce(rc.label, w.reason_text) as label, count(*)::int as n,
      coalesce(sum(case when w.location_id = any(${costArg}::uuid[]) then w.value_kes end), 0)::text as value
    from public.wastage_records w left join public.stock_reason_codes rc on rc.id = w.reason_code_id
    where ${filtered} and w.status in ('recorded', 'approved') group by 1, 2 order by sum(w.value_kes) desc nulls last, 2`, totalArgs)).rows;
  const pending = (await db.query(`select count(*)::int as n from public.wastage_records w where ${filtered} and w.status = 'pending_approval'`, totalArgs.slice(0, -1))).rows[0].n;
  return {
    wastage: page.map((r) => shapeRow(r, costPlaces.includes(r.location_id))),
    totals: { count: totals.reduce((s, t) => s + t.n, 0), valueKes: totals.reduce((s, t) => add(s, t.value), dec(0)).toString(MONEY), pending,
      byReason: totals.map((t) => ({ code: t.code, label: t.label, count: t.n, valueKes: dec(t.value).toString(MONEY) })) },
    nextBefore: rows.length > size ? `${new Date(page.at(-1).occurred_at).toISOString()}|${page.at(-1).id}` : null,
  };
}
