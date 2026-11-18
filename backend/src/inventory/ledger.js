// The inventory ledger: the ONLY code that writes stock_movements / stock_balances for the new inventory module.
// (07-implementation-plan §0.3, DECISIONS INV-A3/A4/A5/A8: stock stops at zero.)
//
// Every function takes `db` already inside a transaction (pg client / PGlite tx with .query). Nothing here opens,
// commits or rolls back a transaction: on any error the caller's transaction must be rolled back (a refused
// movement may leave a Postgres error pending, e.g. when the archived-item guard fires).
// All quantity and money maths is exact (decimal.js BigInt scaled integers, or SQL numeric). No floats.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { QTY, COST, MONEY, dec, add, mul, div, cmp, neg, isZero, isNeg, absolute } from './decimal.js';
import { DEFAULT_UNITS, toBase, display } from './units.js';

/**
 * Reason → allowed direction of the movement (delta sign):
 *   'in'  = must be positive (stock arrives),  'out' = must be negative (stock leaves),  'either' = signed.
 *
 *   in      opening, purchase_receipt, emergency_receipt, transfer_receipt, transfer_cancelled (dispatch returned
 *           to the sender), production_output, adjustment_gain, + legacy 009: added, received, dispatch_cancelled
 *   out     supplier_return, transfer_dispatch, pos_consumption, production_input, wastage, adjustment_loss,
 *           staff_meal, complimentary, + legacy 009: waste, served, dispatched, lost_in_transit
 *   either  count_correction (count found more or less), count (legacy), reversal (opposite of what it undoes),
 *           transfer_discrepancy (receiver counted more or less than was sent), order_correction (an order edited
 *           up or down after serving)
 */
export const REASONS = Object.freeze({
  opening: 'in',
  purchase_receipt: 'in',
  emergency_receipt: 'in',
  transfer_receipt: 'in',
  transfer_cancelled: 'in',
  production_output: 'in',
  adjustment_gain: 'in',
  added: 'in',
  received: 'in',
  dispatch_cancelled: 'in',
  supplier_return: 'out',
  transfer_dispatch: 'out',
  pos_consumption: 'out',
  production_input: 'out',
  wastage: 'out',
  adjustment_loss: 'out',
  staff_meal: 'out',
  complimentary: 'out',
  waste: 'out',
  served: 'out',
  dispatched: 'out',
  lost_in_transit: 'out',
  count_correction: 'either',
  count: 'either',
  reversal: 'either',
  transfer_discrepancy: 'either',
  order_correction: 'either',
});

/**
 * Outbound reasons that may carry a `reservationId` and use up that reservation (P2-20): a reserved request being dispatched.
 * The "never dip into someone else's hold" guard in post() is unconditional; this set only says who may consume a hold.
 */
export const CONSUMES_RESERVATION = new Set(['transfer_dispatch']);

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

/** SQL for the scheduled reconciliation job: ($1 business id, $2 location id or null). Returns rows that DISAGREE. */
export const RECONCILE_SQL = `
select l.id as location_id, x.item_id, coalesce(b.on_hand, 0)::text as on_hand, coalesce(m.total, 0)::text as ledger_total
  from public.stock_locations l
  cross join lateral (
    select item_id from public.stock_balances where location_id = l.id
    union
    select item_id from public.stock_movements where location_id = l.id
  ) x
  left join public.stock_balances b on b.location_id = l.id and b.item_id = x.item_id
  left join (select location_id, item_id, sum(delta) as total from public.stock_movements group by location_id, item_id) m
    on m.location_id = l.id and m.item_id = x.item_id
 where l.business_id = $1 and ($2::uuid is null or l.id = $2)
   and coalesce(b.on_hand, 0) <> coalesce(m.total, 0)
 order by l.id, x.item_id`;

const MOVEMENT_COLUMNS = `id::text as id, business_id, location_id, item_id, delta::text as delta, balance_after::text as balance_after,
  reason, unit_cost::text as unit_cost, value::text as value, ref_type, ref_id, counterparty_location_id, note, actor_id,
  idempotency_key, entered_quantity::text as entered_quantity, entered_unit, occurred_at, created_at, reverses_movement_id::text as reverses_movement_id`;

const shape = (r) => ({
  id: r.id, businessId: r.business_id, locationId: r.location_id, itemId: r.item_id,
  delta: r.delta, balanceAfter: r.balance_after, reason: r.reason, unitCost: r.unit_cost, value: r.value,
  refType: r.ref_type, refId: r.ref_id, counterpartyLocationId: r.counterparty_location_id, note: r.note,
  actorId: r.actor_id, idempotencyKey: r.idempotency_key,
  entered: r.entered_quantity === null ? null : { quantity: r.entered_quantity, unit: r.entered_unit },
  occurredAt: r.occurred_at, createdAt: r.created_at, reversesMovementId: r.reverses_movement_id,
});

const balanceShape = (onHand, reserved) => ({
  onHand: dec(onHand).toString(QTY), reserved: dec(reserved).toString(QTY), available: add(onHand, neg(reserved), QTY).toString(QTY),
});

function needId(value, label) {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
}

/** Loads the item and everything units.display needs. Throws 404 when it isn't in this business. */
async function loadItem(db, businessId, itemId) {
  const { rows } = await db.query(`select id, name, unit, display_unit, avg_cost::text as avg_cost, archived_at
    from public.stock_items where id = $1 and business_id = $2`, [itemId, businessId]);
  if (!rows[0]) throw fail(404, 'That stock item isn’t in this business. Pick it from the stock list.', 'item_not_found');
  const own = (await db.query(`select name, factor::text as factor from public.stock_item_units where item_id = $1 order by position, name`, [itemId])).rows;
  const r = rows[0];
  return { id: r.id, name: r.name, baseUnit: r.unit, displayUnit: r.display_unit || undefined, units: own, avgCost: r.avg_cost };
}

async function loadUnits(db) {
  const { rows } = await db.query(`select code, dimension, to_base::text as to_base, label, plural from public.units order by position`);
  return rows.length ? rows.map((u) => ({ code: u.code, dimension: u.dimension, toBase: u.to_base, label: u.label, plural: u.plural })) : DEFAULT_UNITS;
}

/** Validates the location belongs to the business and returns its status ('active' | 'suspended' | 'archived'). */
async function requireLocation(db, businessId, locationId, label) {
  const { rows } = await db.query('select status from public.stock_locations where id = $1 and business_id = $2', [locationId, businessId]);
  if (!rows[0]) throw fail(404, `${label} isn’t part of this business. Pick it from the locations list.`, 'location_not_found');
  return rows[0].status;
}

const sameMovement = (row, locationId, itemId, qty) => row.location_id === locationId && row.item_id === itemId && cmp(row.delta, qty) === 0;

async function findByKey(db, key, reason) {
  return (await db.query(`select ${MOVEMENT_COLUMNS} from public.stock_movements where idempotency_key = $1 and reason = $2`, [key, reason])).rows[0] || null;
}

async function readBalance(db, locationId, itemId) {
  const { rows } = await db.query('select on_hand::text as on_hand, reserved::text as reserved from public.stock_balances where location_id = $1 and item_id = $2', [locationId, itemId]);
  return balanceShape(rows[0]?.on_hand ?? '0', rows[0]?.reserved ?? '0');
}

async function replay(db, row, locationId, itemId, qty, key) {
  if (!sameMovement(row, locationId, itemId, qty)) {
    throw fail(409, `The request id “${key}” was already used for a different stock movement. Start the action again so it gets a new id.`, 'idempotency_conflict');
  }
  return { movement: shape(row), balance: await readBalance(db, locationId, itemId), replayed: true };
}

/** Postgres errors from the 012 guards → plain HttpErrors (409). Anything else is rethrown untouched. */
function mapDbError(e) {
  if (e instanceof HttpError) return e;
  if (e?.hint === 'stock_item_archived') return fail(409, e.message, 'item_archived');
  if (e?.hint === 'stock_unit_locked') return fail(409, e.message, 'unit_locked');
  if (e?.code === '23505' && /stock_movements_reversed_once/.test(`${e.constraint || ''} ${e.message}`)) {
    return fail(409, 'This movement was already reversed. Check the stock history before trying again.', 'already_reversed');
  }
  if (e?.code === '23505' && /stock_movements_idempotency/.test(`${e.constraint || ''} ${e.message}`)) {
    return fail(409, 'This stock movement was just recorded by another request. Refresh and check before trying again.', 'idempotency_conflict');
  }
  return e;
}

/**
 * Records ONE movement. Returns { movement, balance: { onHand, reserved, available }, replayed }.
 * `qty` is a signed decimal string in the item's BASE unit (max 4 dp). `entered` ({ quantity, unit }) is what the person
 * typed (kept for display and audit; must convert to exactly |qty| in the item's units).
 */
export async function post(db, input) {
  const { businessId: bizIn, locationId: locIn, itemId: itemIn, reason, ref = null, counterpartyLocationId = null,
    note = null, actorId = null, idempotencyKey, occurredAt = null, entered = null, reversesMovementId = null,
    reservationId = null, respectHeld = false } = input;

  // 1. Validate.
  const businessId = needId(bizIn, 'The business');
  const locationId = needId(locIn, 'The location');
  const itemId = needId(itemIn, 'The stock item');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 120) {
    throw fail(400, 'Every stock movement needs a request id (1 to 120 characters) so a retry can’t count twice.', 'idempotency_required');
  }
  const direction = Object.hasOwn(REASONS, reason) ? REASONS[reason] : null;
  if (!direction) throw fail(400, `“${reason}” isn’t a stock movement type Cravio knows.`, 'bad_reason');
  const qty = dec(input.qty, { scale: QTY, round: 'exact', label: 'Quantity' }); // > 4 dp refused with a plain message
  if (isZero(qty)) throw fail(400, 'Quantity can’t be zero. Enter how much came in or went out.', 'zero_quantity');
  const outbound = isNeg(qty);
  if (direction === 'in' && outbound) throw fail(400, `${reason.replace(/_/g, ' ')} adds stock, so the quantity must be more than zero. Use a take-out type (like wastage) to remove stock.`, 'wrong_direction');
  if (direction === 'out' && !outbound) throw fail(400, `${reason.replace(/_/g, ' ')} removes stock, so the quantity must be negative. Use a receipt type to add stock.`, 'wrong_direction');
  const cost = input.unitCost === undefined || input.unitCost === null ? null : dec(input.unitCost, { scale: COST, round: 'exact', label: 'Cost' });
  if (cost && isNeg(cost)) throw fail(400, 'Cost can’t be negative.', 'bad_cost');
  if (ref && (typeof ref.type !== 'string' || !ref.type || ref.type.length > 40 || (ref.id != null && !isId(ref.id)))) {
    throw fail(400, 'The reference must have a type and a valid id.', 'bad_ref');
  }
  const counterparty = counterpartyLocationId ? needId(counterpartyLocationId, 'The other location') : null;
  const when = occurredAt instanceof Date ? occurredAt.toISOString() : occurredAt;

  const item = await loadItem(db, businessId, itemId);
  const status = await requireLocation(db, businessId, locationId, 'That location');
  if (status === 'archived') throw fail(409, 'This location is archived, so its stock can’t change. Reopen it first.', 'location_archived');
  if (status === 'suspended' && !outbound) throw fail(409, 'This location is suspended, so it can’t take in stock. Reactivate it first (taking stock out and corrections still work).', 'location_suspended');
  if (counterparty) await requireLocation(db, businessId, counterparty, 'The other location');
  const units = await loadUnits(db);
  let enteredQty = null;
  let enteredUnit = null;
  if (entered) {
    enteredQty = dec(entered.quantity, { scale: QTY, round: 'exact', label: 'Entered quantity' });
    enteredUnit = String(entered.unit ?? '').trim();
    const asBase = toBase(absolute(enteredQty).toString(), enteredUnit, item, units, { label: 'Entered quantity' }); // 400 unit_mismatch
    if (cmp(asBase, absolute(qty)) !== 0) {
      throw fail(400, `${entered.quantity} ${enteredUnit} doesn’t match the quantity ${qty.toString()} ${item.baseUnit} being recorded. Re-enter the amount.`, 'entered_mismatch');
    }
  }
  const show = (v) => display(absolute(v).toString(QTY), item, units);

  // 2. Idempotency (cheap check before taking any lock, repeated after it to close the race).
  const existing = await findByKey(db, idempotencyKey, reason);
  if (existing) return replay(db, existing, locationId, itemId, qty, idempotencyKey);

  // 3. Lock. Branch dispatches that must respect open orders take the SAME advisory lock the 013 order check takes
  //    (hashtextextended(restaurant || item, 9)) BEFORE the balance row, so a new order and this dispatch serialise.
  let held = dec('0');
  if (respectHeld && outbound) {
    const loc = (await db.query('select restaurant_id from public.stock_locations where id = $1', [locationId])).rows[0];
    if (loc?.restaurant_id) {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1::text || $2::text, 9))', [loc.restaurant_id, itemId]);
      const h = (await db.query('select coalesce(sum(quantity), 0)::text as q from private.branch_committed($1) where item_id = $2', [loc.restaurant_id, itemId])).rows[0];
      held = dec(h.q);
    }
  }
  await db.query('insert into public.stock_balances (location_id, item_id) values ($1, $2) on conflict do nothing', [locationId, itemId]);
  const locked = (await db.query(`select on_hand::text as on_hand, reserved::text as reserved from public.stock_balances
    where location_id = $1 and item_id = $2 for update`, [locationId, itemId])).rows[0];
  const again = await findByKey(db, idempotencyKey, reason);
  if (again) return replay(db, again, locationId, itemId, qty, idempotencyKey);

  // Optional reservation to consume (balance row is already locked: lock order is always balance -> reservation).
  let consume = dec('0');
  let resv = null;
  if (reservationId) {
    if (!outbound || !CONSUMES_RESERVATION.has(reason)) throw fail(400, `${reason.replace(/_/g, ' ')} can’t use up a held reservation.`, 'reservation_not_applicable');
    resv = (await db.query(`select id, business_id, location_id, item_id, status, qty_reserved::text as qr, qty_consumed::text as qc, qty_released::text as qrel
      from public.stock_reservations where id = $1 for update`, [needId(reservationId, 'The reservation')])).rows[0];
    if (!resv || resv.business_id !== businessId || resv.location_id !== locationId || resv.item_id !== itemId) {
      throw fail(409, 'That reservation is not for this item at this location.', 'reservation_mismatch');
    }
    if (resv.status !== 'active') throw fail(409, 'That reservation is already used up or released.', 'reservation_closed');
    const remaining = add(add(resv.qr, neg(resv.qc), QTY), neg(resv.qrel), QTY);
    const want = absolute(qty);
    consume = cmp(want, remaining) < 0 ? want : remaining; // anything beyond the reservation must come from FREE stock (checked below)
  }

  // 4. Stop at zero, and never into stock that is held for someone else.
  const onHand = dec(locked.on_hand);
  const reserved = dec(locked.reserved);
  const reservedAfter = add(reserved, neg(consume), QTY);
  const after = add(onHand, qty, QTY);
  if (isNeg(after)) {
    throw fail(409, `Only ${show(onHand)} of ${item.name} left here; you tried to take ${show(qty)}. Take less, or receive more stock first.`, 'insufficient_stock');
  }
  if (outbound && cmp(after, reservedAfter) < 0) {
    throw fail(409, `Only ${show(add(onHand, neg(reserved), QTY))} of ${item.name} is free here (${show(reserved)} is held for open requests); you tried to take ${show(qty)}. Take less or release the hold first.`, 'stock_reserved');
  }
  if (outbound && respectHeld && !isZero(held) && isNeg(add(after, neg(held), QTY))) {
    throw fail(409, `${show(held)} of ${item.name} is held for open orders; only ${show(add(onHand, neg(held), QTY))} can leave this branch. Take less.`, 'stock_held');
  }

  // Cost: inbound with a cost re-averages; outbound without one takes the current average.
  let unitCost = cost;
  let newAvg = null;
  if (!outbound && cost) {
    const total = (await db.query(`select coalesce(sum(on_hand), 0)::text as total from public.stock_balances where item_id = $1`, [itemId])).rows[0].total;
    const before = isNeg(total) ? dec('0') : dec(total);
    const oldAvg = item.avgCost === null ? cost : dec(item.avgCost);
    const numerator = add(mul(before, oldAvg, before.s + oldAvg.s), mul(qty, cost, qty.s + cost.s));
    newAvg = div(numerator, add(before, qty), COST);
  } else if (outbound && !cost && item.avgCost !== null) {
    unitCost = dec(item.avgCost);
  }
  const value = unitCost ? mul(qty, unitCost, MONEY) : null;

  // 5. Write: balance, then the append-only movement, then item cost.
  try {
    await db.query('update public.stock_balances set on_hand = on_hand + $3, reserved = reserved - $4, updated_at = now() where location_id = $1 and item_id = $2', [locationId, itemId, qty.toString(QTY), consume.toString(QTY)]);
    const inserted = (await db.query(`insert into public.stock_movements
      (business_id, location_id, item_id, delta, balance_after, reason, note, actor_id, unit_cost, value, ref_type, ref_id,
       counterparty_location_id, idempotency_key, entered_quantity, entered_unit, occurred_at, reverses_movement_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, coalesce($17::timestamptz, now()), $18)
      returning ${MOVEMENT_COLUMNS}`, [
      businessId, locationId, itemId, qty.toString(QTY), after.toString(QTY), reason, note, actorId,
      unitCost ? unitCost.toString(COST) : null, value ? value.toString(MONEY) : null, ref?.type ?? null, ref?.id ?? null,
      counterparty, idempotencyKey, enteredQty ? enteredQty.toString(QTY) : null, enteredUnit, when, reversesMovementId,
    ])).rows[0];
    if (resv && !isZero(consume)) {
      await db.query(`update public.stock_reservations set qty_consumed = qty_consumed + $2, updated_at = now(),
        status = case when qty_consumed + $2 + qty_released >= qty_reserved then 'consumed' else status end where id = $1`, [resv.id, consume.toString(QTY)]);
      await db.query(`insert into public.stock_reservation_events (reservation_id, kind, qty, reason, movement_id, idempotency_key, actor_id)
        values ($1, 'consume', $2, $3, $4, $5, $6)`, [resv.id, consume.toString(QTY), reason, inserted.id, idempotencyKey, actorId]);
    }
    if (newAvg) {
      await db.query('update public.stock_items set avg_cost = $2, last_cost = $3 where id = $1', [itemId, newAvg.toString(COST), cost.toString(COST)]);
    }
    return { movement: shape(inserted), balance: balanceShape(after, reservedAfter), replayed: false, consumedFromReservation: consume.toString(QTY) };
  } catch (e) {
    throw mapDbError(e);
  }
}

/** Posts several movements in a stable (location, item) order so concurrent callers can't deadlock. Results follow input order. */
export async function postMany(db, entries) {
  const order = entries.map((e, i) => i).sort((a, b) => {
    const x = entries[a]; const y = entries[b];
    return String(x.locationId).localeCompare(String(y.locationId)) || String(x.itemId).localeCompare(String(y.itemId)) || a - b;
  });
  const results = new Array(entries.length);
  for (const i of order) results[i] = await post(db, entries[i]);
  return results;
}

/** Undoes one movement with the opposite delta (reason 'reversal', ref = the original). Refuses reversing a reversal, reversing twice, or going below zero. */
export async function reverse(db, { movementId, actorId = null, note = null, idempotencyKey }) {
  if (!/^\d{1,18}$/.test(String(movementId ?? ''))) throw fail(400, 'Say which movement to reverse.', 'bad_id');
  const original = (await db.query(`select ${MOVEMENT_COLUMNS} from public.stock_movements where id = $1`, [String(movementId)])).rows[0];
  if (!original) throw fail(404, 'That stock movement doesn’t exist.', 'movement_not_found');
  if (original.reason === 'reversal') throw fail(409, 'A reversal can’t be reversed. Record the stock change again as a new movement instead.', 'already_reversal');
  const prior = (await db.query(`select idempotency_key from public.stock_movements where reverses_movement_id = $1`, [original.id])).rows[0];
  if (prior && prior.idempotency_key !== idempotencyKey) throw fail(409, 'This movement was already reversed. Check the stock history before trying again.', 'already_reversed');
  return post(db, {
    businessId: original.business_id, locationId: original.location_id, itemId: original.item_id,
    qty: neg(original.delta).toString(QTY), reason: 'reversal', ref: { type: 'movement', id: null }, reversesMovementId: original.id,
    unitCost: original.unit_cost, counterpartyLocationId: original.counterparty_location_id,
    note, actorId, idempotencyKey,
  });
}

/** Current { onHand, reserved, available } (strings, 4 dp) for one item at one location. */
export async function balance(db, locationId, itemId) {
  return readBalance(db, needId(locationId, 'The location'), needId(itemId, 'The stock item'));
}

/**
 * Disagreements to investigate (expect none):
 *   on-hand rows   { location_id, item_id, on_hand, ledger_total }  where SUM(movement deltas) differs from stock_balances.on_hand;
 *   reserved rows  { kind: 'reserved', location_id, item_id, reserved, reservations_total }  where stock_balances.reserved differs from
 *                  the sum of what active reservations still hold (only checked once migration 018's stock_reservations exists).
 */
export async function reconcile(db, { businessId, locationId = null }) {
  const biz = needId(businessId, 'The business');
  const rows = (await db.query(RECONCILE_SQL, [biz, locationId])).rows;
  if (!(await db.query(`select to_regclass('public.stock_reservations') as t`)).rows[0].t) return rows;
  const reservedRows = (await db.query(RECONCILE_RESERVED_SQL, [biz])).rows
    .filter((r) => !locationId || r.location_id === locationId)
    .map((r) => ({ kind: 'reserved', ...r }));
  return [...rows, ...reservedRows];
}

// ---------------------------------------------------------------------------------------------------------------------
// Reservations (P2-20). ledger.js stays the only writer of stock_balances.reserved.
// ---------------------------------------------------------------------------------------------------------------------
const RESERVATION_COLUMNS = `id, business_id, location_id, item_id, request_id, qty_reserved::text as qty_reserved, qty_consumed::text as qty_consumed,
  qty_released::text as qty_released, (qty_reserved - qty_consumed - qty_released)::text as remaining, status, idempotency_key, created_at`;

/** Holds `qty` (positive base string) of an item at the Warehouse for a request line. 409 insufficient_available says how much is free. */
export async function reserve(db, { businessId: bizIn, locationId: locIn, itemId: itemIn, qty: qtyIn, requestId, actorId = null, idempotencyKey }) {
  const businessId = needId(bizIn, 'The business'); const locationId = needId(locIn, 'The location'); const itemId = needId(itemIn, 'The stock item');
  needId(requestId, 'The request');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 120) throw fail(400, 'Every reservation needs a request id so a retry can’t hold stock twice.', 'idempotency_required');
  const qty = dec(qtyIn, { scale: QTY, round: 'exact', label: 'Quantity' });
  if (isZero(qty) || isNeg(qty)) throw fail(400, 'Quantity to hold must be more than zero.', 'bad_quantity');

  const item = await loadItem(db, businessId, itemId);
  const units = await loadUnits(db);
  const show = (v) => display(absolute(v).toString(QTY), item, units);
  const kind = (await db.query('select kind from public.stock_locations where id = $1 and business_id = $2', [locationId, businessId])).rows[0]?.kind;
  if (!kind) throw fail(404, 'That location isn’t part of this business.', 'location_not_found');
  if (kind !== 'center') throw fail(409, 'Stock is only held at the Warehouse. Branches check availability when they dispatch.', 'reservation_not_at_warehouse');

  const replayRow = async () => {
    const r = (await db.query(`select ${RESERVATION_COLUMNS} from public.stock_reservations where business_id = $1 and idempotency_key = $2`, [businessId, idempotencyKey])).rows[0];
    if (!r) return null;
    if (r.location_id !== locationId || r.item_id !== itemId || r.request_id !== requestId || cmp(r.qty_reserved, qty) !== 0) {
      throw fail(409, `The request id “${idempotencyKey}” was already used for a different hold. Start again so it gets a new id.`, 'idempotency_conflict');
    }
    return { reservation: r, balance: await readBalance(db, locationId, itemId), replayed: true };
  };
  const prior = await replayRow(); if (prior) return prior;

  await db.query('insert into public.stock_balances (location_id, item_id) values ($1, $2) on conflict do nothing', [locationId, itemId]);
  const locked = (await db.query('select on_hand::text as on_hand, reserved::text as reserved from public.stock_balances where location_id = $1 and item_id = $2 for update', [locationId, itemId])).rows[0];
  const prior2 = await replayRow(); if (prior2) return prior2;

  const free = add(locked.on_hand, neg(locked.reserved), QTY);
  if (cmp(qty, free) > 0) {
    const shown = isNeg(free) ? dec('0') : free;
    throw fail(409, `Only ${show(shown)} of ${item.name} is free at the Warehouse; you asked to hold ${show(qty)}. Approve a smaller amount.`, 'insufficient_available', { available: shown.toString(QTY) });
  }
  try {
    const row = (await db.query(`insert into public.stock_reservations (business_id, location_id, item_id, request_id, qty_reserved, idempotency_key, created_by)
      values ($1, $2, $3, $4, $5, $6, $7) returning ${RESERVATION_COLUMNS}`, [businessId, locationId, itemId, requestId, qty.toString(QTY), idempotencyKey, actorId])).rows[0];
    await db.query('update public.stock_balances set reserved = reserved + $3, updated_at = now() where location_id = $1 and item_id = $2', [locationId, itemId, qty.toString(QTY)]);
    await db.query(`insert into public.stock_reservation_events (reservation_id, kind, qty, idempotency_key, actor_id) values ($1, 'reserve', $2, $3, $4)`, [row.id, qty.toString(QTY), idempotencyKey, actorId]);
    return { reservation: row, balance: balanceShape(locked.on_hand, add(locked.reserved, qty, QTY)), replayed: false };
  } catch (e) {
    if (e?.code === '23505' && /stock_reservations_one_active/.test(`${e.constraint || ''} ${e.message}`)) {
      throw fail(409, 'This request line already holds stock. Release it first to change the amount.', 'already_reserved');
    }
    throw e;
  }
}

/** Gives back `qty` (default: everything still held) of a reservation. Replaying the same key changes nothing. */
export async function release(db, reservationId, { qty: qtyIn = null, reason = 'released', actorId = null, idempotencyKey }) {
  needId(reservationId, 'The reservation');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 120) throw fail(400, 'Every release needs a request id so a retry can’t count twice.', 'idempotency_required');
  const peek = (await db.query('select business_id, location_id, item_id from public.stock_reservations where id = $1', [reservationId])).rows[0];
  if (!peek) throw fail(404, 'That reservation doesn’t exist.', 'reservation_not_found');
  // Same lock order as post(): balance row first, then the reservation.
  const locked = (await db.query('select on_hand::text as on_hand, reserved::text as reserved from public.stock_balances where location_id = $1 and item_id = $2 for update', [peek.location_id, peek.item_id])).rows[0];
  const r = (await db.query(`select ${RESERVATION_COLUMNS} from public.stock_reservations where id = $1 for update`, [reservationId])).rows[0];
  const seen = (await db.query(`select 1 from public.stock_reservation_events where reservation_id = $1 and kind = 'release' and idempotency_key = $2`, [reservationId, idempotencyKey])).rows[0];
  if (seen) return { reservation: r, balance: balanceShape(locked.on_hand, locked.reserved), released: '0.0000', replayed: true };
  const remaining = dec(r.remaining);
  if (qtyIn === null && isZero(remaining)) return { reservation: r, balance: balanceShape(locked.on_hand, locked.reserved), released: '0.0000', replayed: false }; // nothing left to give back
  const want = qtyIn === null ? remaining : dec(qtyIn, { scale: QTY, round: 'exact', label: 'Quantity' });
  if (isNeg(want) || isZero(want)) throw fail(400, 'Quantity to release must be more than zero.', 'bad_quantity');
  if (cmp(want, remaining) > 0) {
    const item = await loadItem(db, r.business_id, r.item_id);
    const units = await loadUnits(db);
    const show = (v) => display(absolute(v).toString(QTY), item, units);
    throw fail(409, `Only ${show(remaining)} of ${item.name} is still held on this request line; you tried to release ${show(want)}.`, 'release_too_much');
  }
  await db.query('update public.stock_balances set reserved = reserved - $3, updated_at = now() where location_id = $1 and item_id = $2', [peek.location_id, peek.item_id, want.toString(QTY)]);
  const updated = (await db.query(`update public.stock_reservations set qty_released = qty_released + $2, updated_at = now(),
      status = case when qty_consumed + qty_released + $2 >= qty_reserved then (case when qty_consumed > 0 then 'consumed' else 'released' end) else status end
    where id = $1 returning ${RESERVATION_COLUMNS}`, [reservationId, want.toString(QTY)])).rows[0];
  await db.query(`insert into public.stock_reservation_events (reservation_id, kind, qty, reason, idempotency_key, actor_id) values ($1, 'release', $2, $3, $4, $5)`,
    [reservationId, want.toString(QTY), reason, idempotencyKey, actorId]);
  return { reservation: updated, balance: balanceShape(locked.on_hand, add(locked.reserved, neg(want), QTY)), released: want.toString(QTY), replayed: false };
}

/**
 * What can still leave `locationId` for `itemId`:  available = on_hand - reserved - held.
 *   reserved = stock held for approved requests (Warehouse only, stock_balances.reserved);
 *   held     = what open ('taken'/'accepted') orders will use (013 order snapshot, branches only; 0 at the Warehouse).
 */
export async function availability(db, locationId, itemId) {
  const b = await readBalance(db, needId(locationId, 'The location'), needId(itemId, 'The stock item'));
  const loc = (await db.query('select restaurant_id from public.stock_locations where id = $1', [locationId])).rows[0];
  const h = loc?.restaurant_id
    ? (await db.query('select coalesce(sum(quantity), 0)::text as q from private.branch_committed($1) where item_id = $2', [loc.restaurant_id, itemId])).rows[0].q : '0';
  return { onHand: b.onHand, reserved: b.reserved, held: dec(h).toString(QTY), available: add(add(b.onHand, neg(b.reserved), QTY), neg(h), QTY).toString(QTY) };
}

/** Second reconciliation: stock_balances.reserved must equal the sum of the remainders of ACTIVE reservations per (location, item). Returns disagreements. */
export const RECONCILE_RESERVED_SQL = `
select coalesce(b.location_id, r.location_id) as location_id, coalesce(b.item_id, r.item_id) as item_id,
       coalesce(b.reserved, 0)::text as reserved, coalesce(r.held, 0)::text as reservations_total
  from public.stock_balances b
  full join (select location_id, item_id, sum(qty_reserved - qty_consumed - qty_released) as held
               from public.stock_reservations where status = 'active' group by location_id, item_id) r
    on r.location_id = b.location_id and r.item_id = b.item_id
 where coalesce(b.reserved, 0) <> coalesce(r.held, 0)
   and (select business_id from public.stock_locations where id = coalesce(b.location_id, r.location_id)) = $1
 order by 1, 2`;
export async function reconcileReserved(db, { businessId }) {
  return (await db.query(RECONCILE_RESERVED_SQL, [needId(businessId, 'The business')])).rows;
}
