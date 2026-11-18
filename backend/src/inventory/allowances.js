// Staff meals and complimentaries (WST-4, D3-6, P3-05, migration 019 allowance_usage). A manager gives food away at a branch: a DISH x portions (expanded through
// the recipe in force, yield applied, like wastage) or ONE stock item. Each is its own ledger reason ('staff_meal' / 'complimentary', separate from wastage in
// every report) and they count against the branch's allowance for the Nairobi day.
//
//   record(db, scope, { locationId, kind: 'staff_meal' | 'complimentary', itemId | menuItemId, quantity, unit?, reasonCodeId | reasonCode?, forWhom?, note?, id? }, { now })
//   allowance(db, scope, { locationId, now })        what is allowed today, used and left (null = no allowance set)
//   list(db, scope, { locationId, kind, from, to, limit, before })     the history, newest first, with the over-allowance flag
//
// Allowances (owner settings, per branch with a business default; null = off): staff_meal_allowance_portions (portions a day) and complimentary_allowance_kes
// (KES a day at cost). A dish counts its portions; a single stock item counts as one portion. The day is the Africa/Nairobi calendar day, so it resets at
// local midnight. Exactly reaching the allowance is allowed; one more is "over".
// DECISION (over the allowance): the migration has no table to park a record that is waiting, and food that was already given can't wait, so an over-allowance
// record is NOT routed to the approvals inbox. It is allowed but it needs a NOTE from the manager saying why, it is FLAGGED (over_allowance in the audit trail and
// in the history) and the OWNERS are told. When the cost is unknown while an allowance is set it counts as over (it can't be proven within the allowance).
// The ledger still stops at zero.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { COST, MONEY, QTY, add, cmp, dec, rescale, sub } from './decimal.js';
import { normaliseUnit, toBase } from './units.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { loadUnits } from './catalogue.js';
import { loadDish } from './recipes.js';
import { postMany } from './ledger.js';
import { resolve as resolveReason } from './reasons.js';
import { notify } from './notifications.js';
import { getSettings } from './policies.js';
import { record as audit } from './audit.js';
import { dishLines, itemLines, loadItemRow, totalOf } from './wastage.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};
const kes = (v) => `KES ${Number(dec(v).toString(MONEY)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export const KINDS = Object.freeze(['staff_meal', 'complimentary']);
const NAME = Object.freeze({ staff_meal: 'Staff meal', complimentary: 'Complimentary' });
const MAX_NOTE = 500;
const MAX_FOR = 80;

/** The Africa/Nairobi calendar day of `now` as YYYY-MM-DD (allowances reset at local midnight). */
export const nairobiDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const kindOf = (kind) => {
  if (!KINDS.includes(kind)) throw fail(400, 'Say whether this is a staff meal or a complimentary.', 'kind_required');
  return kind;
};
const locationOfScope = (scope, locationId) => {
  const loc = scope.locations.find((l) => l.id === (locationId ? String(locationId).toLowerCase() : null));
  if (!loc) throw fail(404, 'That branch or warehouse isn’t part of this business.', 'location_not_found');
  return loc;
};

/* ---------- allowance ---------- */

const limitsOf = (settings) => ({ staffMealPortions: settings.staff_meal_allowance_portions ?? null, complimentaryKes: settings.complimentary_allowance_kes ?? null });

async function usageRow(db, businessId, locationId, day, kind, { lock = false } = {}) {
  if (lock) await db.query('insert into public.allowance_usage (business_id, location_id, day, kind) values ($1, $2, $3, $4) on conflict do nothing', [businessId, locationId, day, kind]);
  const row = (await db.query(`select portions::text as portions, value_kes::text as value_kes from public.allowance_usage where business_id = $1 and location_id = $2 and day = $3 and kind = $4${lock ? ' for update' : ''}`,
    [businessId, locationId, day, kind])).rows[0];
  return { portions: row?.portions ?? '0', valueKes: row?.value_kes ?? '0' };
}

const left = (limit, used) => (limit === null ? null : (cmp(limit, used) > 0 ? sub(limit, used).toString(MONEY) : '0.00'));

/** What is allowed today at a branch, what has been used and what is left. A limit of null means no allowance is set (nothing is checked). */
export async function allowance(db, scope, { locationId, now = new Date() } = {}) {
  const loc = locationOfScope(scope, locationId);
  requireCan(scope, 'inv.view', { locationId: loc.id });
  const day = nairobiDay(now);
  const limits = limitsOf(await getSettings(db, scope.businessId, loc.id));
  const meals = await usageRow(db, scope.businessId, loc.id, day, 'staff_meal');
  const comps = await usageRow(db, scope.businessId, loc.id, day, 'complimentary');
  const showCost = can(scope, 'inv.cost.view', { locationId: loc.id });
  return {
    day, locationId: loc.id,
    staffMeal: { limitPortions: limits.staffMealPortions, usedPortions: meals.portions, remainingPortions: left(limits.staffMealPortions, meals.portions) },
    complimentary: { limitKes: limits.complimentaryKes, usedKes: showCost ? comps.valueKes : null, usedPortions: comps.portions, remainingKes: showCost ? left(limits.complimentaryKes, comps.valueKes) : null },
  };
}

/* ---------- record ---------- */

/**
 * Gives food away and posts it. Returns { record, posted: true, overAllowance, evaluation: { reasons }, allowance, movements, replayed }.
 * The caller needs inv.adjust.create at the branch (managers their own branch, owners anywhere).
 */
export async function record(db, scope, input = {}, { now = new Date() } = {}) {
  const loc = locationOfScope(scope, input.locationId);
  requireCan(scope, 'inv.adjust.create', { locationId: loc.id });
  const kind = kindOf(input.kind);
  const hasItem = input.itemId !== undefined && input.itemId !== null && input.itemId !== '';
  const hasDish = input.menuItemId !== undefined && input.menuItemId !== null && input.menuItemId !== '';
  if (hasItem === hasDish) throw fail(400, hasItem ? 'Choose either a stock item or a dish, not both.' : 'Choose what was given: a dish or a stock item.', 'subject_required');
  const recordId = input.id ? needId(input.id, 'The record id') : randomUUID();
  const replayed = (await db.query(`select 1 from public.stock_movements where idempotency_key = $1 and reason = $2`, [`${kind}:${recordId}:0`, kind])).rows[0];
  if (replayed) return { ...(await get(db, scope, recordId)), posted: true, replayed: true };

  if (input.quantity === undefined || input.quantity === null || String(input.quantity).trim() === '') throw fail(400, hasDish ? 'Enter how many portions.' : 'Enter how much.', 'quantity_required');
  const typed = dec(typeof input.quantity === 'string' ? input.quantity.trim() : input.quantity, { label: hasDish ? 'The portions' : 'The amount' });
  if (cmp(typed, 0) <= 0) throw fail(400, 'The amount must be more than zero.', 'zero_quantity');
  let lines; let subject; let enteredUnit; let enteredQty; let portions;
  if (hasItem) {
    const { row, item } = await loadItemRow(db, scope.businessId, needId(input.itemId, 'The stock item'));
    if (row.archived_at) throw fail(409, `${row.name} is archived, so its stock can’t change. Restore it first.`, 'item_archived');
    const unit = input.unit === undefined || input.unit === null || String(input.unit).trim() === '' ? (item.displayUnit ?? item.baseUnit) : String(input.unit).trim();
    const qtyBase = toBase(typed.toString(), unit, item, await loadUnits(db), { positive: true, label: 'The amount' });
    enteredUnit = normaliseUnit(unit, item, await loadUnits(db)) || item.baseUnit;
    enteredQty = rescale(typed, QTY, 'half-up').toString(QTY);
    lines = itemLines(row, qtyBase);
    subject = { itemId: row.id, name: row.name };
    portions = '1';
  } else {
    const dish = await loadDish(db, scope, input.menuItemId);
    if (!loc.restaurantId || dish.restaurantId !== loc.restaurantId) throw fail(400, `${dish.name} is on another branch’s menu. Record it at the branch that makes it.`, 'dish_other_branch');
    enteredQty = rescale(typed, QTY, 'half-up').toString(QTY);
    enteredUnit = 'portion';
    lines = await dishLines(db, scope, dish, enteredQty);
    subject = { menuItemId: dish.id, name: dish.name };
    portions = rescale(typed, 2, 'half-up').toString(2);
  }
  const total = totalOf(lines);       // null = some ingredient has no cost yet

  // Reason: the kind's own list; staff meals default to "Staff meal", complimentaries to "Complimentary".
  const askedReason = (input.reasonCodeId !== undefined && input.reasonCodeId !== null && input.reasonCodeId !== '') || tidy(input.reasonCode);
  let reason = await resolveReason(db, scope.businessId, kind, { id: input.reasonCodeId, code: input.reasonCode });
  if (!reason && askedReason) throw fail(404, 'That reason isn’t in your list. Pick one from the list.', 'reason_not_found');
  if (!reason) reason = await resolveReason(db, scope.businessId, kind, { code: kind }).catch(() => null);
  const note = tidy(input.note);
  if (note.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');
  const forWhom = tidy(input.forWhom);
  if (forWhom.length > MAX_FOR) throw fail(400, `Keep “for whom” under ${MAX_FOR} characters.`, 'for_whom_too_long');
  if (reason?.needsNote && !note) throw fail(400, `“${reason.label}” needs a note. Say what happened.`, 'note_required');

  // The allowance of this Nairobi day (the usage row is locked so two managers can't both slip under it).
  const day = nairobiDay(now);
  const limits = limitsOf(await getSettings(db, scope.businessId, loc.id));
  const used = await usageRow(db, scope.businessId, loc.id, day, kind, { lock: true });
  const why = [];
  if (kind === 'staff_meal' && limits.staffMealPortions !== null) {
    const after = add(used.portions, portions);
    if (cmp(after, limits.staffMealPortions) > 0) why.push(`That makes ${after.toString(2).replace(/\.00$/, '')} staff meals today; the allowance is ${limits.staffMealPortions}.`);
  }
  if (kind === 'complimentary' && limits.complimentaryKes !== null) {
    if (total === null) why.push('Some of this stock has no cost yet, so Cravio can’t check it against today’s complimentary allowance.');
    else if (cmp(add(used.valueKes, total), limits.complimentaryKes) > 0) why.push(`That makes ${kes(add(used.valueKes, total))} of complimentaries today; the allowance is ${kes(limits.complimentaryKes)}.`);
  }
  const over = why.length > 0;
  if (over && !note) throw fail(400, `${why[0]} Say why in a note, then record it. The owner is told.`, 'allowance_note_required', { reasons: why });

  const label = NAME[kind];
  const what = `${subject.name}${hasDish ? ` x ${dec(enteredQty).toString(QTY).replace(/\.?0+$/, '')}` : ''}`;
  const noteText = [reason && reason.label !== label ? `${label} (${reason.label})` : label, what, forWhom ? `for ${forWhom}` : null, over ? 'OVER ALLOWANCE' : null, note || null].filter(Boolean).join(': ').slice(0, 280);
  const results = await postMany(db, lines.map((l, position) => ({
    businessId: scope.businessId, locationId: loc.id, itemId: l.itemId, qty: `-${dec(l.qtyBase).toString(QTY)}`, reason: kind, ref: { type: kind, id: recordId }, note: noteText,
    actorId: scope.userId, idempotencyKey: `${kind}:${recordId}:${position}`, occurredAt: now, unitCost: l.unitCost === null ? null : dec(l.unitCost).toString(COST),
    entered: !hasDish && lines.length === 1 ? { quantity: enteredQty, unit: enteredUnit } : null,
  })));
  await db.query(`update public.allowance_usage set portions = portions + $5, value_kes = value_kes + $6, updated_at = now() where business_id = $1 and location_id = $2 and day = $3 and kind = $4`,
    [scope.businessId, loc.id, day, kind, portions, total ?? '0']);

  await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'allowance', entityId: recordId, action: 'record',
    after: { kind, name: subject.name, quantity: enteredQty, unit: enteredUnit, portions, valueKes: total, forWhom: forWhom || null, overAllowance: over, reasons: why, note: note || null, day,
      movementIds: results.map((r) => r.movement.id) } });
  if (over) {
    await notify(db, { businessId: scope.businessId, recipients: ['owners'], exclude: [scope.userId], kind: 'allowance_exceeded', title: `${label} allowance passed at ${loc.name}`,
      body: `${why[0]} ${note}`.slice(0, 300), link: '/owner/inventory/wastage', entity: { type: 'allowance', id: recordId }, locationId: loc.id, dedupeKey: `allowance_exceeded:${recordId}` });
  }
  const view = await get(db, scope, recordId);
  return { ...view, posted: true, overAllowance: over, evaluation: { reasons: why }, allowance: await allowance(db, scope, { locationId: loc.id, now }),
    movements: results.map((r) => r.movement), balance: results.at(-1).balance, replayed: false };
}

/* ---------- reading ---------- */

// Lines come back in the order they were recorded: the recipe line position (the last part of the idempotency key <kind>:<id>:<position>), then item name.
// (postMany posts in item-id order, so movement ids say nothing about that order.)
const GROUPED = `select m.ref_id as id, m.reason as kind, m.location_id, min(m.occurred_at) as at, (array_agg(m.actor_id))[1] as actor_id, min(m.note) as note, count(*)::int as lines,
    sum(-m.value) filter (where m.value is not null)::text as value, bool_or(m.value is null) as cost_unknown,
    json_agg(json_build_object('itemId', m.item_id, 'name', i.name, 'quantityBase', (-m.delta)::text) order by split_part(m.idempotency_key, ':', 3)::int, i.name, m.id) as items,
    coalesce((select (e.after->>'overAllowance')::boolean from public.inventory_events e where e.entity = 'allowance' and e.entity_id = m.ref_id and e.action = 'record' order by e.id limit 1), false) as over,
    (select e.after->>'forWhom' from public.inventory_events e where e.entity = 'allowance' and e.entity_id = m.ref_id and e.action = 'record' order by e.id limit 1) as for_whom
  from public.stock_movements m join public.stock_items i on i.id = m.item_id`;

const shape = (r, showCost, nameOf = (x) => x) => ({
  id: r.id, kind: r.kind, locationId: r.location_id, at: r.at, recordedBy: r.actor_id, note: r.note, forWhom: r.for_whom || null, overAllowance: r.over,
  valueKes: showCost ? (r.value ?? null) : null, costUnknown: showCost ? r.cost_unknown : undefined, items: r.items.map((x) => nameOf({ itemId: x.itemId, name: x.name, quantityBase: x.quantityBase })), lines: r.lines,
});

/** One record: its movements, value and flags. Needs inv.view at its branch. */
export async function get(db, scope, id) {
  if (!isId(id)) throw fail(400, 'That record id is invalid.', 'bad_id');
  const row = (await db.query(`${GROUPED} where m.business_id = $1 and m.ref_id = $2 and m.reason in ('staff_meal', 'complimentary') group by m.ref_id, m.reason, m.location_id`, [scope.businessId, id.toLowerCase()])).rows[0];
  if (!row) throw fail(404, 'That staff meal or complimentary doesn’t exist.', 'allowance_record_not_found');
  requireCan(scope, 'inv.view', { locationId: row.location_id });
  return { record: shape(row, can(scope, 'inv.cost.view', { locationId: row.location_id })) };
}

/** Who may see where a record is (for routes that authorise before reading). */
export async function locationOf(db, businessId, id) {
  if (!isId(id)) throw fail(400, 'That record id is invalid.', 'bad_id');
  const row = (await db.query(`select location_id from public.stock_movements where business_id = $1 and ref_id = $2 and reason in ('staff_meal', 'complimentary') limit 1`, [businessId, id.toLowerCase()])).rows[0];
  if (!row) throw fail(404, 'That staff meal or complimentary doesn’t exist.', 'allowance_record_not_found');
  return { locationId: row.location_id };
}

const parseDate = (value, label) => {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw fail(400, `${label} isn’t a valid date.`, 'bad_date');
  return t;
};

/**
 * The history (newest first): staff meals and complimentaries at the places the caller can view. Filters: locationId, kind, overOnly, from, to, limit (max 200),
 * before (the nextBefore marker). Totals are for the same filters: count and value per kind.
 */
export async function list(db, scope, { locationId = null, kind = null, overOnly = false, from = null, to = null, limit = 60, before = null } = {}) {
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
  const where = ['m.business_id = $1', 'm.location_id = any($2::uuid[])', `m.reason in ('staff_meal', 'complimentary')`];
  const arg = (value) => { args.push(value); return `$${args.length}`; };
  if (kind) where.push(`m.reason = ${arg(kindOf(kind))}`);
  if (from) where.push(`m.occurred_at >= ${arg(parseDate(from, 'The start date'))}`);
  if (to) where.push(`m.occurred_at < ${arg(parseDate(to, 'The end date'))}`);
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 60, 1), 200);
  const havingParts = [];
  if (before) {
    const [at, lastId] = String(before).split('|');
    havingParts.push(`(min(m.occurred_at), m.ref_id) < (${arg(parseDate(at, 'The page marker'))}::timestamptz, ${arg(needId(lastId, 'The page marker'))}::uuid)`);
  }
  const rows = (await db.query(`select * from (${GROUPED} where ${where.join(' and ')} group by m.ref_id, m.reason, m.location_id${havingParts.length ? ` having ${havingParts.join(' and ')}` : ''}) g
    ${overOnly ? 'where g.over' : ''} order by g.at desc, g.id desc limit ${size + 1}`, args)).rows;
  const page = rows.slice(0, size);
  return {
    records: page.map((r) => shape(r, costPlaces.includes(r.location_id))),
    nextBefore: rows.length > size ? `${new Date(page.at(-1).at).toISOString()}|${page.at(-1).id}` : null,
  };
}
