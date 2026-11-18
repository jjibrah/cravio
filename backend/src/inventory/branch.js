// Branch inventory service (P1-12): what one branch has, what is held for open orders, and how a manager counts, adds or
// writes off stock. Everything takes (db, scope, locationId, ...): `scope` comes from permissions.inventoryScope(), and
// `locationId` is that branch's stock location (the routes resolve it from X-Cravio-Branch).
// Writes go through ledger.post only (decimal-exact, stop at zero), inside the caller's transaction. Reads never write.
// Quantities are strings in the item's BASE unit (4 dp); every quantity also comes with a friendly `display`.
// Needs migrations 009 + 012 + 013 (snapshot reads recipes and stock_menu_availability; exceptions come from serving).
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { QTY, MONEY, dec, add, sub, mul, div, cmp, isNeg, isZero, absolute } from './decimal.js';
import { compatibleUnits, display, toBase } from './units.js';
import { can, requireCan } from './permissions.js';
import { loadUnits, getItem } from './catalogue.js';
import { post } from './ledger.js';
import { getSetting } from './policies.js';
import { record as audit } from './audit.js';
import { record as recordWastage } from './wastage.js';
import { together } from '../lib/pool.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};

const q4 = (v) => dec(v ?? '0').toString(QTY);

/** What units.js needs to know about an item. */
const unitItem = (row, own) => ({ name: row.name, baseUnit: row.unit, displayUnit: row.display_unit || undefined,
  units: (own || []).map((u) => ({ name: u.name, factor: u.factor })) });

/** Plain-words label for every movement reason (the ledger's reasons plus the 009 legacy ones). */
export const REASON_LABELS = Object.freeze({
  opening: 'Opening stock',
  purchase_receipt: 'Delivery received',
  emergency_receipt: 'Emergency purchase',
  transfer_receipt: 'Received from another location',
  transfer_cancelled: 'Transfer cancelled, stock returned',
  production_output: 'Made in the kitchen',
  adjustment_gain: 'Stock added',
  added: 'Stock added',
  received: 'Delivery received',
  dispatch_cancelled: 'Dispatch cancelled, stock returned',
  supplier_return: 'Returned to supplier',
  transfer_dispatch: 'Sent to another location',
  pos_consumption: 'Used in orders',
  production_input: 'Used to make other items',
  wastage: 'Waste',
  waste: 'Waste',
  adjustment_loss: 'Stock removed',
  staff_meal: 'Staff meal',
  complimentary: 'Complimentary',
  served: 'Served in orders',
  dispatched: 'Sent to another location',
  lost_in_transit: 'Lost in transit',
  count_correction: 'Count',
  count: 'Count',
  reversal: 'Reversal of an earlier entry',
  transfer_discrepancy: 'Difference found on receiving',
  order_correction: 'Order correction',
});
export const reasonLabel = (reason) => REASON_LABELS[reason] || String(reason).replace(/_/g, ' ');

/** The branch location in the scope, or 404. */
function branchLocation(scope, locationId) {
  const loc = scope.locations.find((l) => l.id === String(locationId || '').toLowerCase());
  if (!loc || loc.kind !== 'branch' || !loc.restaurantId) throw fail(404, 'That branch isn’t part of this business.', 'location_not_found');
  return loc;
}

async function ownUnits(db, itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await db.query(`select item_id, name, factor::text as factor from public.stock_item_units
    where item_id = any($1::uuid[]) order by position, lower(name)`, [itemIds]);
  const map = new Map();
  for (const r of rows) map.set(r.item_id, [...(map.get(r.item_id) || []), r]);
  return map;
}

const num = (text) => text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** "4000" -> "4,000"; "0.5000" -> "0.5". */
function fmtNumber(value) {
  const [int, frac = ''] = dec(value).toString(QTY).replace('-', '').split('.');
  const trimmed = frac.replace(/0+$/, '');
  return `${num(int)}${trimmed ? `.${trimmed}` : ''}`;
}

/* ============================================================================================================
 * Snapshot
 * ========================================================================================================== */

/**
 * Everything the branch Stock screen needs. Items = used at or stocked at this branch (a balance row, a level, or in
 * a recipe / link / extra of this branch's dishes); { all: true } lists every active item of the business instead
 * (for the "add stock" picker). available = on hand - reserved (for transfers) - held for open orders.
 */
export async function snapshot(db, scope, locationId, { all = false } = {}) {
  const loc = branchLocation(scope, locationId);
  requireCan(scope, 'inv.view', { locationId: loc.id });
  const restaurantId = loc.restaurantId;
  const seeCost = can(scope, 'inv.cost.view', { locationId: loc.id });

  // Which items this branch uses (a recipe, a link or an extra of its dishes). Used both to count dishes per item and to pick the items to list.
  const USED = `select rl.item_id, r.menu_item_id as dish from public.recipes r
        join public.recipe_lines rl on rl.version_id = r.current_version_id where r.restaurant_id = $1
      union all
      select s.item_id, s.menu_item_id from public.menu_item_stock s where s.restaurant_id = $1
        and not exists (select 1 from public.recipes r where r.menu_item_id = s.menu_item_id and r.current_version_id is not null)
      union all
      select l.item_id, e.item_id from public.menu_extra_recipe_lines l join public.menu_item_extras e on e.id = l.extra_id where l.restaurant_id = $1`;

  // Six independent reads: on the pool they run on separate connections, so the screen costs one round trip, not nine.
  const [units, usedRows, rows, heldRows, openRows, dishRows] = await together(db,
    () => loadUnits(db, scope),
    async () => (await db.query(`select item_id, count(distinct dish)::int as dishes from (${USED}) x group by item_id`, [restaurantId])).rows,
    async () => (await db.query(`select i.id, i.name, i.sku, i.unit, i.display_unit, i.low_level::text as low_level, i.avg_cost::text as avg_cost,
      i.category_id, c.name as category_name, b.item_id is not null as has_balance, b.on_hand::text as on_hand, b.reserved::text as reserved, b.updated_at,
      lv.item_id is not null as has_level, lv.min::text as lv_min, lv.reorder::text as lv_reorder, lv.par::text as lv_par, lv.max::text as lv_max,
      coalesce((select json_agg(json_build_object('name', u.name, 'factor', u.factor::text) order by u.position, lower(u.name))
        from public.stock_item_units u where u.item_id = i.id), '[]'::json) as own_units
    from public.stock_items i
      left join public.stock_categories c on c.id = i.category_id
      left join public.stock_balances b on b.item_id = i.id and b.location_id = $2
      left join public.stock_item_levels lv on lv.item_id = i.id and lv.location_id = $2
    where i.business_id = $1 and i.archived_at is null
      and ($3::boolean or b.item_id is not null or lv.item_id is not null or i.id in (select item_id from (${USED.replaceAll('$1', '$4')}) used))
    order by lower(i.name)`, [scope.businessId, loc.id, Boolean(all), restaurantId])).rows,
    async () => (await db.query('select item_id, quantity::text as quantity from private.branch_committed($1)', [restaurantId])).rows,
    async () => (await db.query(`select item_id, count(*)::int as n from public.stock_exceptions where location_id = $1 and status = 'open' group by item_id`, [loc.id])).rows,
    async () => (await db.query(`select a.menu_item_id, a.item_id, a.allow_when_out, a.sold_out, m.name, si.name as item_name
      from public.stock_menu_availability($1) a join public.menu_items m on m.id = a.menu_item_id left join public.stock_items si on si.id = a.item_id order by lower(m.name)`, [restaurantId])).rows);
  const usedBy = new Map(usedRows.map((r) => [r.item_id, r.dishes]));
  const held = new Map(heldRows.map((r) => [r.item_id, r.quantity]));
  const openByItem = new Map(openRows.map((r) => [r.item_id, r.n]));
  const own = new Map(rows.map((r) => [r.id, typeof r.own_units === 'string' ? JSON.parse(r.own_units) : r.own_units]));

  let valueTotal = dec('0');
  let valueUnknown = false;
  const items = rows.map((r) => {
    const item = unitItem(r, own.get(r.id));
    const show = (v) => display(v, item, units);
    const onHand = q4(r.on_hand);
    const reserved = q4(r.reserved);
    const heldForOrders = q4(held.get(r.id));
    const available = sub(sub(onHand, reserved, QTY), heldForOrders, QTY).toString(QTY);
    const level = r.has_level ? { min: r.lv_min, reorder: r.lv_reorder, par: r.lv_par, max: r.lv_max } : null;
    const threshold = level?.reorder ?? r.low_level ?? null;
    const dishes = usedBy.get(r.id) || 0;
    const openExceptions = openByItem.get(r.id) || 0;
    const out = cmp(available, '0') <= 0;
    const low = !out && threshold !== null && cmp(available, threshold) <= 0;
    // "Count needed": the numbers can't be trusted until someone counts it.
    let countReason = null;
    if (openExceptions) countReason = 'Orders were served without enough of this. Count it to correct the stock.';
    else if (isNeg(dec(available))) countReason = 'More is held for open orders than is on hand. Count it to check.';
    else if (!r.has_balance && dishes) countReason = 'Dishes use this but it has never been counted here.';
    const view = {
      id: r.id, name: r.name, sku: r.sku, categoryId: r.category_id, categoryName: r.category_name || null,
      baseUnit: r.unit, displayUnit: r.display_unit || null,
      onHand, heldForOrders, reserved, available,
      display: { onHand: show(onHand), heldForOrders: show(heldForOrders), reserved: show(reserved), available: show(available) },
      level, levelDisplay: level ? Object.fromEntries(Object.entries(level).map(([k, v]) => [k, v === null ? null : show(v)])) : null,
      out, low, countNeeded: Boolean(countReason), countNeededReason: countReason,
      state: out ? 'out' : low ? 'low' : 'ok',
      status: out ? 'Out' : countReason ? 'Count needed' : low ? 'Low' : 'OK',
      dishes, openExceptions, updatedAt: r.updated_at,
      units: compatibleUnits(item, units),
    };
    if (seeCost) {
      view.avgCost = r.avg_cost === null ? null : dec(r.avg_cost).toString(6);
      view.value = r.avg_cost === null ? (isZero(dec(onHand)) ? '0.00' : null) : mul(dec(onHand), dec(r.avg_cost), MONEY).toString(MONEY);
      if (view.value === null) valueUnknown = true; else valueTotal = add(valueTotal, dec(view.value), MONEY);
    }
    return view;
  });

  // Dishes: tracked ones and which are sold out (the limiting ingredient decides).
  const dishes = {
    tracked: dishRows.length,
    keepSelling: dishRows.filter((d) => d.allow_when_out).length,
    soldOut: dishRows.filter((d) => d.sold_out).map((d) => ({ id: d.menu_item_id, name: d.name, itemId: d.item_id, itemName: d.item_name || null })),
  };
  const openExceptions = openRows.reduce((sum, r) => sum + r.n, 0);

  const summary = { items: items.length, low: items.filter((i) => i.low).length, out: items.filter((i) => i.out).length,
    countNeeded: items.filter((i) => i.countNeeded).length };
  if (seeCost) { summary.value = valueTotal.toString(MONEY); summary.valueComplete = !valueUnknown; }
  return { location: { id: loc.id, name: loc.name, restaurantId }, generatedAt: new Date().toISOString(), seeCost, summary, items, dishes, openExceptions };
}

/** One item at this branch: the catalogue view narrowed to this location, with held-for-orders and labelled movements. */
export async function itemDetail(db, scope, locationId, itemId) {
  const loc = branchLocation(scope, locationId);
  requireCan(scope, 'inv.view', { locationId: loc.id });
  // The catalogue service shows every location the scope can see; narrow the scope to this one branch.
  const narrowed = { ...scope, locationCaps: new Map([[loc.id, scope.locationCaps.get(loc.id) || new Set()]]) };
  const item = await getItem(db, narrowed, itemId);
  const heldRow = (await db.query('select quantity::text as quantity from private.branch_committed($1) where item_id = $2', [loc.restaurantId, item.id])).rows[0];
  const here = item.locations.find((l) => l.locationId === loc.id) || null;
  const units = await loadUnits(db);
  const own = (await ownUnits(db, [item.id])).get(item.id);
  const shape = unitItem({ name: item.name, unit: item.baseUnit, display_unit: item.displayUnit }, own);
  const heldForOrders = q4(heldRow?.quantity);
  const atBranch = here && { ...here, heldForOrders, display: { ...here.display, heldForOrders: display(heldForOrders, shape, units) },
    available: sub(here.available, heldForOrders, QTY).toString(QTY) };
  if (atBranch) atBranch.display.available = display(atBranch.available, shape, units);
  const { totals, locations, ...rest } = item;
  return { ...rest, location: atBranch, movements: item.movements.map((m) => ({ ...m, reasonLabel: reasonLabel(m.reason) })) };
}

/* ============================================================================================================
 * Recording stock: count, add, waste
 * ========================================================================================================== */

async function loadItem(db, businessId, itemId) {
  const { rows } = await db.query(`select id, name, unit, display_unit, avg_cost::text as avg_cost, archived_at from public.stock_items
    where id = $1 and business_id = $2`, [itemId, businessId]);
  if (!rows[0]) throw fail(404, 'That stock item isn’t in this business. Pick it from the stock list.', 'item_not_found');
  const own = (await ownUnits(db, [itemId])).get(itemId);
  return { row: rows[0], item: unitItem(rows[0], own) };
}

/** The amount a typical entry at this location is (base units), or null when nothing is known. */
async function typicalAmount(db, locationId, itemId) {
  const lv = (await db.query('select reorder::text as reorder, par::text as par from public.stock_item_levels where location_id = $1 and item_id = $2', [locationId, itemId])).rows[0];
  const avg = (await db.query(`select round(coalesce(avg(abs(delta)), 0), 4)::text as avg from public.stock_movements
    where location_id = $1 and item_id = $2 and occurred_at > now() - interval '30 days'
      and reason not in ('opening', 'count_correction', 'count', 'reversal')`, [locationId, itemId])).rows[0].avg;
  let best = null;
  for (const candidate of [lv?.reorder, lv?.par, avg]) {
    if (candidate === null || candidate === undefined || isZero(dec(candidate))) continue;
    if (best === null || cmp(candidate, best) > 0) best = dec(candidate).toString(QTY);
  }
  return best;
}

/**
 * Refuses (409 confirm_large_amount) an amount far above what is normal for this item here, unless confirmed.
 * Normal = the larger of the item's reorder/par level and its 30-day average movement here. Limit = factor x normal.
 */
export async function checkLargeAmount(db, scope, loc, { itemRow, item, units, baseQty, enteredQuantity, enteredUnit, confirm }) {
  if (confirm) return;
  const typical = await typicalAmount(db, loc.id, itemRow.id);
  if (typical === null) return;
  const factor = await getSetting(db, scope.businessId, 'large_amount_warning_factor', loc.id);
  const limit = mul(dec(typical), dec(String(factor)), QTY);
  if (cmp(baseQty, limit) <= 0) return;
  let suggestion = null;
  for (const k of [1000, 100, 10]) {
    const q = div(dec(enteredQuantity), dec(String(k)), QTY, 'half-up');
    if (isZero(q)) continue;
    try {
      if (cmp(toBase(q.toString(QTY), enteredUnit, item, units), limit) <= 0) { suggestion = { quantity: fmtNumber(q), unit: enteredUnit }; break; }
    } catch { /* precision: try the next */ }
  }
  const amount = `${fmtNumber(enteredQuantity)} ${enteredUnit}`;
  const message = suggestion
    ? `${amount} is a lot for ${itemRow.name}. Did you mean ${suggestion.quantity} ${suggestion.unit}?`
    : `${amount} is a lot for ${itemRow.name}. Check the amount, then confirm if it is right.`;
  throw fail(409, message, 'confirm_large_amount', { suggestion, typical: display(typical, item, units), confirmWith: 'confirmLarge' });
}

const KINDS = ['count', 'add', 'waste'];
const CAPABILITY = { count: 'inv.count.run', add: 'inv.stock.record', waste: 'inv.adjust.create' };
/** The capability a record kind needs (routes authorize it before the transaction). */
export const recordCapability = (kind) => CAPABILITY[kind] || null;

/**
 * Count, add or write off stock at one branch.
 *   count  quantity = what is physically there NOW (in `unit`). The difference is posted as 'count_correction'; no
 *          difference = nothing posted ("No change").
 *   add    quantity arrives. Posted as 'adjustment_gain' ("Stock added"). unitCost (money per ENTERED unit, e.g. per kg)
 *          is kept on the movement and re-averages the item's cost. It is not 'purchase_receipt': that reason belongs to
 *          the purchasing flow (Phase 3) which a branch manager does not hold the capability for.
 *   waste  quantity leaves, 'wastage'. A note is required (reasonCode is optional free text for now).
 * Body: { kind, itemId, quantity, unit, note?, unitCost?, reasonCode?, confirmLarge?, commandId? }.
 */
export async function record(db, scope, { locationId, kind, itemId, quantity, unit, note, unitCost, reasonCode, confirmLarge = false, commandId = null }) {
  const loc = branchLocation(scope, locationId);
  if (!KINDS.includes(kind)) throw fail(400, 'Choose count, add or waste.', 'bad_kind');
  requireCan(scope, CAPABILITY[kind], { locationId: loc.id });
  const id = needId(itemId, 'The stock item');
  const { row, item } = await loadItem(db, scope.businessId, id);
  if (row.archived_at) throw fail(409, `${row.name} is archived, so its stock can’t change. Restore it first.`, 'item_archived');
  const units = await loadUnits(db);
  const unitText = String(unit ?? row.display_unit ?? row.unit).trim();
  if (quantity === undefined || quantity === null || String(quantity).trim() === '') throw fail(400, kind === 'count' ? 'Enter how much you counted.' : 'Enter how much.', 'quantity_required');
  const entered = dec(quantity, { label: kind === 'count' ? 'The counted amount' : 'The amount' });
  if (isNeg(entered)) throw fail(400, 'The amount can’t be negative.', 'negative_quantity');
  if (kind !== 'count' && isZero(entered)) throw fail(400, 'The amount must be more than zero.', 'zero_quantity');
  const baseQty = dec(toBase(entered.toString(), unitText, item, units, { label: kind === 'count' ? 'The counted amount' : 'The amount' }));

  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length > 240) throw fail(400, 'Keep the note under 240 characters.', 'note_too_long');
  const code = reasonCode === undefined || reasonCode === null || String(reasonCode).trim() === '' ? null : String(reasonCode).trim();
  if (code && (code.length > 30 || !/^[\w -]+$/.test(code))) throw fail(400, 'The reason code is invalid. Use a few plain words.', 'bad_reason_code');
  if (kind === 'waste' && !text) throw fail(400, `Say why ${row.name} was written off, e.g. “spoiled” or “dropped”.`, 'note_required');
  const fullNote = [code && kind === 'waste' ? code : null, text].filter(Boolean).join(': ') || null;
  if (fullNote && fullNote.length > 280) throw fail(400, 'Keep the note shorter.', 'note_too_long');

  let costBase = null;
  if (unitCost !== undefined && unitCost !== null && String(unitCost).trim() !== '') {
    if (kind !== 'add') throw fail(400, 'A cost only goes with adding stock.', 'cost_not_allowed');
    requireCan(scope, 'inv.cost.view', { locationId: loc.id });
    const perUnit = dec(unitCost, { label: 'The cost' });
    if (isNeg(perUnit)) throw fail(400, 'Cost can’t be negative.', 'bad_cost');
    const oneUnit = dec(toBase('1', unitText, item, units));
    costBase = div(perUnit, oneUnit, 6, 'half-up').toString(6);
  }

  await checkLargeAmount(db, scope, loc, { itemRow: row, item, units, baseQty, enteredQuantity: entered.toString(), enteredUnit: unitText, confirm: confirmLarge === true });

  const key = `branch:${kind}:${commandId ? String(commandId).toLowerCase() : randomUUID()}`;
  const show = (v) => display(absolute(v).toString(QTY), item, units);
  const before = (await db.query('select on_hand::text as on_hand from public.stock_balances where location_id = $1 and item_id = $2 for update', [loc.id, id])).rows[0]?.on_hand ?? '0';
  // With migration 019 applied, waste is the reason-coded wastage flow (P3-04: approval rules, cost, alerts). The route and the response keep their shape;
  // a reasonCode that isn't in the owner's list is kept as free text, as before.
  if (kind === 'waste' && (await db.query(`select to_regclass('public.wastage_records') is not null as ok`)).rows[0].ok) {
    const done = await recordWastage(db, scope, { locationId: loc.id, itemId: id, quantity: entered.toString(), unit: unitText, reasonCode: code, note: text,
      commandId: isId(commandId) ? commandId : null }, { allowFreeText: true, requireNote: true });
    const base = { kind, changed: true, replayed: done.replayed === true, itemId: id, itemName: row.name, wastage: { id: done.wastage.id, number: done.wastage.number, status: done.wastage.status,
      valueKes: done.wastage.valueKes }, pendingApproval: done.pendingApproval, warnings: [] };
    if (done.pendingApproval) {
      return { ...base, movement: null, onHand: q4(before), display: { onHand: show(before), change: '0' },
        message: `Sent for approval: ${show(baseQty)} of ${row.name}. Stock changes once it is approved.`, approvalReasons: done.evaluation?.reasons || [] };
    }
    const m = done.movements[0] || (done.replayed ? { id: done.wastage.movementIds[0] } : null);
    const after = done.balance?.onHand ?? (await db.query('select on_hand::text as on_hand from public.stock_balances where location_id = $1 and item_id = $2', [loc.id, id])).rows[0]?.on_hand ?? '0';
    const moved = m && m.delta !== undefined ? m : (await db.query(`select id, delta::text as delta, entered_quantity::text as eq, entered_unit as eu, note from public.stock_movements where id = $1`, [m?.id])).rows[0];
    return { ...base,
      movement: moved ? { id: moved.id, reason: 'wastage', reasonLabel: reasonLabel('wastage'), delta: moved.delta, entered: moved.entered ?? (moved.eq ? { quantity: moved.eq, unit: moved.eu } : null), note: moved.note } : null,
      onHand: q4(after), available: done.balance?.available, display: { onHand: show(after), change: `-${show(baseQty)}` },
      message: `Wrote off ${show(baseQty)} of ${row.name}. Now ${show(after)}.` };
  }
  const warnings = [];
  let qty;
  let reason;
  let entry = { quantity: entered.toString(), unit: unitText };
  let message;
  if (kind === 'count') {
    qty = sub(baseQty, dec(before), QTY);
    if (isZero(qty)) {
      return { kind, changed: false, itemId: id, itemName: row.name, movement: null, onHand: q4(before), display: { onHand: show(before) },
        message: `No change: ${row.name} is already ${show(before)}.`, warnings };
    }
    reason = 'count_correction';
    entry = null; // the difference isn't what was typed; the typed count goes in the note
    const held = (await db.query('select quantity::text as quantity from private.branch_committed($1) where item_id = $2', [loc.restaurantId, id])).rows[0]?.quantity;
    if (held && cmp(baseQty, held) < 0) {
      warnings.push(`You counted ${show(baseQty)} of ${row.name}, which is less than the ${show(held)} held for open orders. Those dishes will show as sold out.`);
    }
  } else if (kind === 'add') {
    qty = baseQty;
    reason = 'adjustment_gain';
  } else {
    qty = dec(`-${baseQty.toString(QTY)}`);
    reason = 'wastage';
  }
  const movementNote = kind === 'count' ? `Counted ${show(baseQty)} (was ${show(before)})${fullNote ? `: ${fullNote}` : ''}`.slice(0, 280) : fullNote;
  const result = await post(db, { businessId: scope.businessId, locationId: loc.id, itemId: id, qty: qty.toString(QTY), reason, note: movementNote,
    actorId: scope.userId, idempotencyKey: key, entered: entry, unitCost: costBase });
  const onHand = result.balance.onHand;
  if (kind === 'count') message = `Counted ${show(baseQty)} of ${row.name}. Stock was ${show(before)}, so it changed by ${isNeg(qty) ? '-' : '+'}${show(qty)}.`;
  else if (kind === 'add') message = `Added ${show(qty)} of ${row.name}. Now ${show(onHand)}.`;
  else message = `Wrote off ${show(qty)} of ${row.name}. Now ${show(onHand)}.`;
  await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'stock_record',
    entityId: id, action: kind, before: { onHand: q4(before) }, after: { onHand, delta: qty.toString(QTY), reason, entered: entry, movementId: result.movement.id } });
  return {
    kind, changed: true, replayed: result.replayed, itemId: id, itemName: row.name,
    movement: { id: result.movement.id, reason, reasonLabel: reasonLabel(reason), delta: result.movement.delta, entered: result.movement.entered, note: result.movement.note },
    onHand, available: result.balance.available,
    display: { onHand: show(onHand), change: `${isNeg(qty) ? '-' : '+'}${show(qty)}` },
    message, warnings,
  };
}

/* ============================================================================================================
 * History
 * ========================================================================================================== */

/** Movements at this branch, newest first. { itemId, limit = 60 (max 200), before = a movement id from nextBefore }. */
export async function history(db, scope, locationId, { itemId = null, limit = 60, before = null } = {}) {
  const loc = branchLocation(scope, locationId);
  requireCan(scope, 'inv.view', { locationId: loc.id });
  const seeCost = can(scope, 'inv.cost.view', { locationId: loc.id });
  const item = itemId ? needId(itemId, 'The stock item') : null;
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 60, 1), 200);
  if (before !== null && before !== undefined && before !== '' && !/^\d{1,18}$/.test(String(before))) throw fail(400, 'The page marker is invalid. Start from the top.', 'bad_cursor');
  const units = await loadUnits(db);
  const { rows } = await db.query(`select m.id::text as id, m.item_id, i.name as item_name, i.unit, i.display_unit, m.delta::text as delta, m.balance_after::text as balance_after,
      m.reason, m.note, m.actor_id, p.name as actor_name, m.order_id, o.short_id, m.entered_quantity::text as entered_quantity, m.entered_unit,
      m.unit_cost::text as unit_cost, m.value::text as value, m.occurred_at, m.created_at
    from public.stock_movements m
      join public.stock_items i on i.id = m.item_id
      left join public.profiles p on p.id = m.actor_id
      left join public.orders o on o.id = m.order_id
    where m.location_id = $1 and ($2::uuid is null or m.item_id = $2::uuid) and ($3::bigint is null or m.id < $3::bigint)
    order by m.id desc limit $4`, [loc.id, item, before === null || before === '' ? null : String(before), size + 1]);
  const page = rows.slice(0, size);
  const own = await ownUnits(db, [...new Set(page.map((r) => r.item_id))]);
  const movements = page.map((r) => {
    const shape = unitItem({ name: r.item_name, unit: r.unit, display_unit: r.display_unit }, own.get(r.item_id));
    const shortId = r.order_id ? String(r.short_id || r.order_id).slice(0, 6) : null;
    const out = {
      id: r.id, itemId: r.item_id, itemName: r.item_name, reason: r.reason, reasonLabel: reasonLabel(r.reason), note: r.note,
      delta: r.delta, balanceAfter: r.balance_after,
      display: { delta: `${isNeg(dec(r.delta)) ? '-' : '+'}${display(absolute(r.delta).toString(QTY), shape, units)}`, balanceAfter: display(r.balance_after, shape, units) },
      entered: r.entered_quantity === null ? null : { quantity: r.entered_quantity, unit: r.entered_unit },
      by: r.actor_id ? { id: r.actor_id, name: r.actor_name || 'Former staff' } : null,
      order: r.order_id ? { id: r.order_id, shortId, link: `/branch/${loc.restaurantId}/orders?order=${shortId}` } : null,
      occurredAt: r.occurred_at, createdAt: r.created_at,
    };
    if (seeCost) { out.unitCost = r.unit_cost; out.value = r.value; }
    return out;
  });
  return { location: { id: loc.id, name: loc.name }, movements, nextBefore: rows.length > size ? page.at(-1).id : null };
}

/* ============================================================================================================
 * Stock exceptions: dishes served without enough stock
 * ========================================================================================================== */

/** { status: 'open' (default) | 'resolved' | 'all' }. Newest first. */
export async function exceptions(db, scope, locationId, { status = 'open', limit = 100 } = {}) {
  const loc = branchLocation(scope, locationId);
  requireCan(scope, 'inv.view', { locationId: loc.id });
  if (!['open', 'resolved', 'all'].includes(status)) throw fail(400, 'Status must be open, resolved or all.', 'bad_status');
  const seeCost = can(scope, 'inv.cost.view', { locationId: loc.id });
  const units = await loadUnits(db);
  const { rows } = await db.query(`select e.id, e.item_id, i.name as item_name, i.unit, i.display_unit, i.avg_cost::text as avg_cost, e.kind, e.short_qty::text as short_qty,
      e.status, e.note, e.created_at, e.resolved_at, e.resolved_by, rp.name as resolved_by_name, e.order_id, o.short_id
    from public.stock_exceptions e join public.stock_items i on i.id = e.item_id
      left join public.orders o on o.id = e.order_id left join public.profiles rp on rp.id = e.resolved_by
    where e.location_id = $1 and ($2 = 'all' or e.status = $2)
    order by e.created_at desc, e.id desc limit $3`, [loc.id, status, Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200)]);
  const own = await ownUnits(db, [...new Set(rows.map((r) => r.item_id))]);
  const openCount = (await db.query(`select count(*)::int as n from public.stock_exceptions where location_id = $1 and status = 'open'`, [loc.id])).rows[0].n;
  return {
    location: { id: loc.id, name: loc.name }, openCount,
    exceptions: rows.map((r) => {
      const shape = unitItem({ name: r.item_name, unit: r.unit, display_unit: r.display_unit }, own.get(r.item_id));
      const shortId = r.order_id ? String(r.short_id || r.order_id).slice(0, 6) : null;
      const out = {
        id: r.id, itemId: r.item_id, itemName: r.item_name, kind: r.kind, shortQty: q4(r.short_qty), display: { shortQty: display(q4(r.short_qty), shape, units) },
        message: `${r.item_name} was short by ${display(q4(r.short_qty), shape, units)}${shortId ? ` on order #${shortId}` : ''}. Count it or record a delivery.`,
        status: r.status, note: r.note, createdAt: r.created_at, resolvedAt: r.resolved_at,
        resolvedBy: r.resolved_by ? { id: r.resolved_by, name: r.resolved_by_name || 'Former staff' } : null,
        order: r.order_id ? { id: r.order_id, shortId, link: `/branch/${loc.restaurantId}/orders?order=${shortId}` } : null,
      };
      if (seeCost) out.estimatedValue = r.avg_cost === null ? null : mul(dec(q4(r.short_qty)), dec(r.avg_cost), MONEY).toString(MONEY);
      return out;
    }),
  };
}

/** The location an exception belongs to (for the route's authorize-before-transaction), or null. */
export async function exceptionLocation(db, scope, exceptionId) {
  if (!isId(exceptionId)) return null;
  const { rows } = await db.query('select location_id from public.stock_exceptions where id = $1 and business_id = $2', [exceptionId.toLowerCase(), scope.businessId]);
  return rows[0]?.location_id || null;
}

/** Marks an exception resolved (audited). `locationId` pins it to the branch the caller is working in. */
export async function resolveException(db, scope, exceptionId, { note, locationId = null } = {}) {
  if (!isId(exceptionId)) throw fail(400, 'That exception id is invalid.', 'bad_id');
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length > 280) throw fail(400, 'Keep the note under 280 characters.', 'note_too_long');
  const { rows } = await db.query(`select e.id, e.location_id, e.status, e.item_id, e.short_qty::text as short_qty, i.name as item_name
    from public.stock_exceptions e join public.stock_items i on i.id = e.item_id
    where e.id = $1 and e.business_id = $2 for update of e`, [exceptionId.toLowerCase(), scope.businessId]);
  const row = rows[0];
  if (!row || (locationId && row.location_id !== String(locationId).toLowerCase())) throw fail(404, 'That exception isn’t at this branch.', 'exception_not_found');
  requireCan(scope, 'inv.exception.resolve', { locationId: row.location_id });
  if (row.status === 'resolved') throw fail(409, 'This exception was already resolved.', 'already_resolved');
  await db.query(`update public.stock_exceptions set status = 'resolved', resolved_by = $2, resolved_at = now(), note = $3 where id = $1`, [row.id, scope.userId, text || null]);
  await audit(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'stock_exception',
    entityId: row.id, action: 'resolve', before: { status: 'open', itemId: row.item_id, shortQty: row.short_qty }, after: { status: 'resolved', note: text || null } });
  return { id: row.id, status: 'resolved', itemId: row.item_id, itemName: row.item_name, note: text || null, message: `Marked as resolved: ${row.item_name}.` };
}

/* ============================================================================================================
 * Availability (waiter and guest menus)
 * ========================================================================================================== */

/**
 * Sold-out state per tracked dish at a branch. SAME shape as src/stock/service.js availability() (the app switches
 * over without changes): [{ menuItemId, available, servings, allowWhenOut, soldOut }] (numbers, not strings).
 */
export async function availability(db, restaurantId) {
  const { rows } = await db.query('select * from public.stock_menu_availability($1)', [restaurantId]);
  return rows.map((row) => ({ menuItemId: row.menu_item_id, available: Number(row.available), servings: Number(row.servings), allowWhenOut: row.allow_when_out, soldOut: row.sold_out }));
}
