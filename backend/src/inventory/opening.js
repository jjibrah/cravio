// Opening balances (P1-11, PRD CNT-5): the first stock an item has at a location, posted as 'opening' movements.
// Everything goes through ledger.post (the only writer of quantities). Takes the caller's transaction for writes.
//
// Decisions:
//  - Cost: people type the cost PER THE UNIT THEY ENTERED ("KES 650 per kg", "KES 4,200 per jerrican"). It is converted
//    to KES per base unit (650 per kg -> 0.65 per g, at the 6 dp cost scale) before it reaches the ledger.
//  - One opening per item per location. A second one is refused unless the first was reversed. It is also refused while
//    the item already has stock there (anything else recorded since), because an opening on top of real stock double
//    counts it: "Use a count to correct it." An item sitting at zero with some history (sold out) may still take its first opening.
//  - A line with a zero quantity is skipped (nothing to record), never an error: a spreadsheet full of blanks is normal.
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { QTY, COST, dec, div, isZero, isNeg } from './decimal.js';
import { loadUnits } from './catalogue.js';
import { display, toBase } from './units.js';
import { can, requireCan } from './permissions.js';
import { record } from './audit.js';
import * as ledger from './ledger.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const MAX_LINES = 500;
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const KENYA_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: '2-digit', year: 'numeric' });
export const formatDate = (value) => KENYA_DATE.format(new Date(value));

/** The item the way units.js wants it. */
async function loadItems(db, businessId, ids) {
  const items = (await db.query(`select id, name, unit, display_unit, archived_at from public.stock_items where business_id = $1 and id = any($2::uuid[])`, [businessId, ids])).rows;
  const own = (await db.query(`select item_id, name, factor::text as factor from public.stock_item_units where item_id = any($1::uuid[])`, [ids])).rows;
  return new Map(items.map((r) => [r.id, { id: r.id, name: r.name, baseUnit: r.unit, displayUnit: r.display_unit || undefined, archived: r.archived_at !== null,
    units: own.filter((u) => u.item_id === r.id).map((u) => ({ name: u.name, factor: u.factor })) }]));
}

export async function locationName(db, businessId, locationId) {
  const row = (await db.query(`select coalesce(r.name, l.name) as name from public.stock_locations l left join public.restaurants r on r.id = l.restaurant_id
    where l.id = $1 and l.business_id = $2`, [locationId, businessId])).rows[0];
  if (!row) throw fail(404, 'That location isn’t part of this business. Pick it from the locations list.', 'location_not_found');
  return row.name;
}

/** A cost the way people type it: 650, "650", "KES 1,250.50". KES per ONE entered unit. Returns a Dec, or null when blank. */
export function readCost(value, label = 'The cost') {
  if (empty(value)) return null;
  const text = typeof value === 'number' ? String(value) : String(value).replace(/^\s*(kes|ksh|kshs)\.?\s*/i, '').replace(/,/g, '').trim();
  let cost;
  try { cost = dec(text, { label }); } catch { throw fail(400, `${label} must be a number, like 650 or 1,250.50.`, 'bad_cost'); }
  if (isNeg(cost)) throw fail(400, `${label} can’t be negative.`, 'bad_cost');
  if (isZero(cost)) throw fail(400, `${label} can’t be zero. Leave it blank if you don’t know it yet.`, 'bad_cost');
  return cost;
}

/** KES per entered unit -> KES per base unit (string, 6 dp). Refuses a cost that rounds to nothing. */
export function costPerBase(cost, unit, item, units) {
  const factor = dec(toBase('1', unit, item, units, { label: 'The unit' }));
  const perBase = div(cost, factor, COST, 'half-up');
  if (isZero(perBase)) throw fail(400, `A cost of ${cost.toString()} per ${unit} is too small to record. Check the cost and the unit.`, 'bad_cost');
  return perBase.toString(COST);
}

/** The open (not reversed) opening movement for the item at the location, or null. */
export async function openingOf(db, locationId, itemId) {
  return (await db.query(`select m.id::text as id, m.occurred_at, m.idempotency_key from public.stock_movements m
    where m.location_id = $1 and m.item_id = $2 and m.reason = 'opening'
      and not exists (select 1 from public.stock_movements r where r.reverses_movement_id = m.id)
    order by m.id desc limit 1`, [locationId, itemId])).rows[0] || null;
}

/**
 * Why this item can't take an opening balance at this location, in plain words (null = it can).
 * `replayKey`: an opening that was posted with that request id counts as "already done", not as a clash.
 */
export async function openingBlocker(db, { businessId, locationId, item, locationLabel, replayKey = null, units }) {
  const existing = await openingOf(db, locationId, item.id);
  if (existing) {
    if (replayKey && existing.idempotency_key === replayKey) return null;
    return `Opening stock for ${item.name} at ${locationLabel} was already set on ${formatDate(existing.occurred_at)}. Use a count to correct it.`;
  }
  const bal = (await db.query('select on_hand::text as on_hand from public.stock_balances where location_id = $1 and item_id = $2', [locationId, item.id])).rows[0];
  if (bal && !isZero(dec(bal.on_hand))) {
    return `${item.name} already has ${display(bal.on_hand, item, units)} recorded at ${locationLabel}, so it can’t take an opening balance. Use a count to correct it.`;
  }
  return null;
}

/** The request id behind one line: the same command + location + item always gives the same key, so a retry can't post twice. */
export const lineKey = (commandId, locationId, itemId) => (commandId
  ? `opening:${createHash('sha256').update(`${String(commandId).toLowerCase()}|${locationId}|${itemId}`).digest('hex').slice(0, 40)}`
  : `opening:${randomUUID()}`);

/**
 * Turns one typed line into what will be posted: { itemId, qty (base), entered: { quantity, unit }, unitCost (per base) | null, shown }.
 * `line`: { quantity, unit?, unitCost? }. A missing unit means the item's usual (display) unit. Returns null for a zero quantity.
 */
export function prepareLine(item, line, units, label = item.name) {
  if (empty(line.quantity)) return null;
  const qtyText = typeof line.quantity === 'number' ? String(line.quantity) : String(line.quantity).replace(/,/g, '').trim();
  let quantity;
  try { quantity = dec(qtyText, { label: `The opening amount for ${label}` }); } catch { throw fail(400, `The opening amount for ${label} must be a number, like 40 or 12.5.`, 'bad_quantity'); }
  if (isNeg(quantity)) throw fail(400, `The opening amount for ${label} can’t be negative.`, 'negative');
  if (isZero(quantity)) return null;
  const unit = empty(line.unit) ? (item.displayUnit || item.baseUnit) : String(line.unit).trim();
  const qty = toBase(quantity.toString(), unit, item, units, { label: `The opening amount for ${label}` });
  if (isZero(dec(qty))) throw fail(400, `The opening amount for ${label} is too small to record.`, 'bad_quantity');
  const cost = readCost(line.unitCost, `The cost of ${label}`);
  return {
    itemId: item.id, qty, entered: { quantity: quantity.toString(), unit },
    unitCost: cost ? costPerBase(cost, unit, item, units) : null,
    shown: display(qty, item, units),
  };
}

/**
 * Posts opening balances for several items at ONE location.
 *   input: { locationId, lines: [{ itemId, quantity, unit?, unitCost? }], commandId? }
 * Needs inv.stock.record at that location. All lines are checked first; if any is refused, nothing is posted.
 * Returns { locationId, locationName, results: [{ itemId, itemName, status: 'posted'|'skipped'|'replayed', ... }], posted, skipped }.
 */
export async function setOpening(db, scope, input = {}) {
  const locationId = isId(input.locationId) ? input.locationId.toLowerCase() : null;
  if (!locationId) throw fail(400, 'Choose the location the opening stock is for.', 'bad_id');
  requireCan(scope, 'inv.stock.record', { locationId });
  const lines = input.lines;
  if (!Array.isArray(lines) || !lines.length) throw fail(400, 'Add at least one item with its opening amount.', 'no_lines');
  if (lines.length > MAX_LINES) throw fail(400, `Set opening stock for at most ${MAX_LINES} items at a time.`, 'too_many_lines');
  const where = await locationName(db, scope.businessId, locationId);
  const ids = lines.map((l) => (isId(l?.itemId) ? l.itemId.toLowerCase() : null));
  if (ids.includes(null)) throw fail(400, 'Each line needs an item. Pick it from the stock list.', 'bad_id');
  const seen = new Set();
  const items = await loadItems(db, scope.businessId, ids);
  const units = await loadUnits(db);

  const work = [];
  for (const [i, line] of lines.entries()) {
    const item = items.get(ids[i]);
    if (!item) throw fail(404, 'One of those items isn’t in this business. Pick it from the stock list.', 'item_not_found');
    if (seen.has(item.id)) throw fail(400, `${item.name} is listed twice. Give each item one opening amount.`, 'duplicate_line');
    seen.add(item.id);
    if (item.archived) throw fail(409, `${item.name} is archived. Restore it before setting its opening stock.`, 'item_archived');
    const prepared = prepareLine(item, line, units);
    work.push({ item, prepared });
  }
  for (const { item, prepared } of work) {
    if (!prepared) continue;
    const key = lineKey(input.commandId, locationId, item.id);
    const blocked = await openingBlocker(db, { businessId: scope.businessId, locationId, item, locationLabel: where, replayKey: input.commandId ? key : null, units });
    if (blocked) throw fail(409, blocked, 'opening_exists', { itemId: item.id });
    prepared.key = key;
  }

  const results = [];
  for (const { item, prepared } of work) {
    if (!prepared) { results.push({ itemId: item.id, itemName: item.name, status: 'skipped', message: `${item.name}: no amount entered, so nothing was recorded.` }); continue; }
    const out = await ledger.post(db, { businessId: scope.businessId, locationId, itemId: item.id, qty: prepared.qty, reason: 'opening',
      unitCost: prepared.unitCost, entered: prepared.entered, actorId: scope.userId, idempotencyKey: prepared.key, note: 'Opening stock' });
    results.push({ itemId: item.id, itemName: item.name, status: out.replayed ? 'replayed' : 'posted', movementId: out.movement.id,
      quantity: prepared.entered.quantity, unit: prepared.entered.unit, delta: out.movement.delta, display: prepared.shown, unitCost: out.movement.unitCost,
      onHand: out.balance.onHand });
  }
  const posted = results.filter((r) => r.status === 'posted').length;
  if (posted) {
    await record(db, { businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity: 'opening_stock', action: 'set',
      after: { items: posted, lines: results.filter((r) => r.status === 'posted').map((r) => ({ itemId: r.itemId, quantity: r.quantity, unit: r.unit })) } });
  }
  return { locationId, locationName: where, results, posted, skipped: results.filter((r) => r.status === 'skipped').length };
}

/**
 * Items at one location with whether an opening balance is set. Needs inv.view there.
 * Returns { locationId, locationName, canRecord, items: [{ itemId, name, code, baseUnit, displayUnit, hasOpening, openingSetAt, opening, onHand, display, ... }], counts }.
 * Costs only for callers with inv.cost.view at the location.
 */
export async function openingStatus(db, scope, locationId) {
  const id = isId(locationId) ? locationId.toLowerCase() : null;
  if (!id) throw fail(400, 'Choose a location.', 'bad_id');
  requireCan(scope, 'inv.view', { locationId: id });
  const where = await locationName(db, scope.businessId, id);
  const units = await loadUnits(db);
  const seeCost = can(scope, 'inv.cost.view', { locationId: id });
  const rows = (await db.query(`select i.id, i.name, i.sku, i.unit, i.display_unit, coalesce(b.on_hand, 0)::text as on_hand,
      o.id::text as opening_id, o.occurred_at as opening_at, o.entered_quantity::text as entered_quantity, o.entered_unit, o.unit_cost::text as opening_cost
    from public.stock_items i
    left join public.stock_balances b on b.location_id = $1 and b.item_id = i.id
    left join lateral (select m.id, m.occurred_at, m.entered_quantity, m.entered_unit, m.unit_cost from public.stock_movements m
      where m.location_id = $1 and m.item_id = i.id and m.reason = 'opening'
        and not exists (select 1 from public.stock_movements r where r.reverses_movement_id = m.id)
      order by m.id desc limit 1) o on true
    where i.business_id = $2 and i.archived_at is null order by lower(i.name)`, [id, scope.businessId])).rows;
  const own = rows.length ? (await db.query(`select item_id, name, factor::text as factor from public.stock_item_units where item_id = any($1::uuid[])`, [rows.map((r) => r.id)])).rows : [];
  const items = rows.map((r) => {
    const item = { name: r.name, baseUnit: r.unit, displayUnit: r.display_unit || undefined, units: own.filter((u) => u.item_id === r.id).map((u) => ({ name: u.name, factor: u.factor })) };
    const out = {
      itemId: r.id, name: r.name, code: r.sku, baseUnit: r.unit, displayUnit: r.display_unit, hasOpening: r.opening_id !== null,
      openingSetAt: r.opening_at, opening: r.opening_id === null ? null : { movementId: r.opening_id, quantity: r.entered_quantity, unit: r.entered_unit },
      onHand: dec(r.on_hand).toString(QTY), display: display(r.on_hand, item, units),
      // An opening can be set while nothing is recorded yet (see the decisions at the top of this file).
      canSetOpening: r.opening_id === null && isZero(dec(r.on_hand)),
      units: item.units.map((u) => u.name),
    };
    if (seeCost && r.opening_cost !== null) out.openingUnitCost = r.opening_cost; // KES per base unit
    return out;
  });
  return { locationId: id, locationName: where, canRecord: can(scope, 'inv.stock.record', { locationId: id }), items,
    counts: { items: items.length, withOpening: items.filter((i) => i.hasOpening).length, waiting: items.filter((i) => i.canSetOpening).length } };
}
