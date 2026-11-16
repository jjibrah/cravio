// Inventory (migration 009): servings per location, branch stock actions, requests, dispatches and receipts.
// Every function takes `db` (query(sql, params) -> { rows }) inside a transaction the caller opened, and ids the
// route has already authorised (branch membership or business ownership). Each function re-checks that the
// records it touches belong to that branch/business, so a substituted id fails with 404.
// Balance rows are locked (SELECT … FOR UPDATE) before they change; commands with a commandId are idempotent.
import { randomInt } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX = 100000;

export function quantity(value, label = 'Quantity', { allowZero = false } = {}) {
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new HttpError(400, `${label} must be a number of servings.`);
  if (number < 0 || (!allowZero && number === 0)) throw new HttpError(400, `${label} must be more than zero.`);
  if (number > MAX) throw new HttpError(400, `${label} is too large.`);
  if (Math.round(number * 1000) !== number * 1000) throw new HttpError(400, `${label} can have at most 3 decimal places.`);
  return number;
}
const id = (value, label) => { if (!isId(value)) throw new HttpError(400, `${label} is invalid.`); return value.toLowerCase(); };
const note = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'The note must be text.');
  const clean = value.trim();
  if (clean.length > 280) throw new HttpError(400, 'Keep the note under 280 characters.');
  return clean || null;
};
const num = (value) => (value === null || value === undefined ? null : Number(value));

/** Runs `fn` once per commandId: a retry gets the first result back instead of repeating the change. */
export async function once(db, { commandId, businessId, actorId, kind }, fn) {
  if (commandId === undefined || commandId === null) return fn();
  const key = id(commandId, 'commandId');
  const { rows } = await db.query(`insert into public.stock_commands (id, business_id, actor_id, kind) values ($1, $2, $3, $4)
    on conflict (id) do nothing returning id`, [key, businessId, actorId, kind]);
  if (!rows.length) {
    const prior = (await db.query('select business_id, kind, result from public.stock_commands where id = $1', [key])).rows[0];
    if (prior.business_id !== businessId || prior.kind !== kind) throw new HttpError(409, 'This request id was already used for something else.');
    return prior.result;
  }
  const result = await fn();
  await db.query('update public.stock_commands set result = $2 where id = $1', [key, JSON.stringify(result ?? {})]);
  return result;
}

/* ---------- Locations and balances ---------- */

export async function branchLocation(db, restaurantId) {
  const { rows } = await db.query('select private.branch_location($1) as id', [restaurantId]);
  if (!rows[0]?.id) throw new HttpError(404, 'That branch doesn’t exist.');
  return rows[0].id;
}

export async function centerLocation(db, businessId) {
  await db.query(`insert into public.stock_locations (business_id, kind, name)
    select id, 'center', 'Main center' from public.businesses where id = $1 on conflict do nothing`, [businessId]);
  const { rows } = await db.query(`select id from public.stock_locations where business_id = $1 and kind = 'center'`, [businessId]);
  if (!rows[0]) throw new HttpError(404, 'That business doesn’t exist.');
  return rows[0].id;
}

async function businessOfRestaurant(db, restaurantId) {
  const { rows } = await db.query('select business_id from public.restaurants where id = $1', [restaurantId]);
  if (!rows[0]) throw new HttpError(404, 'That branch doesn’t exist.');
  return rows[0].business_id;
}

async function requireItem(db, businessId, itemId) {
  const { rows } = await db.query('select id, name, active from public.stock_items where id = $1 and business_id = $2', [id(itemId, 'Stock item'), businessId]);
  if (!rows[0]) throw new HttpError(404, 'That stock item isn’t in this business.');
  return rows[0];
}

/** Locks and returns the balance row (created at 0 when missing). */
async function lockBalance(db, locationId, itemId) {
  await db.query('insert into public.stock_balances (location_id, item_id) values ($1, $2) on conflict do nothing', [locationId, itemId]);
  const { rows } = await db.query('select on_hand from public.stock_balances where location_id = $1 and item_id = $2 for update', [locationId, itemId]);
  return Number(rows[0].on_hand);
}

/** Changes a locked balance by `delta` and appends the movement. Returns the new balance. */
async function move(db, { businessId, locationId, itemId, delta, reason, actorId, orderId = null, transferId = null, note: text = null }) {
  if (delta === 0) return null;
  const { rows } = await db.query(`update public.stock_balances set on_hand = on_hand + $3, updated_at = now()
    where location_id = $1 and item_id = $2 returning on_hand`, [locationId, itemId, delta]);
  const balance = Number(rows[0].on_hand);
  await db.query(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, actor_id, order_id, transfer_id, note)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [businessId, locationId, itemId, delta, balance, reason, actorId, orderId, transferId, text]);
  return balance;
}

/* ---------- Catalogue ---------- */

export async function createItem(db, { businessId, actorId }, body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new HttpError(400, 'Enter the item name.');
  if (name.length > 80) throw new HttpError(400, 'Keep the name under 80 characters.');
  const low = body.lowLevel === undefined || body.lowLevel === null || body.lowLevel === '' ? null : quantity(body.lowLevel, 'Low-stock level', { allowZero: true });
  const { rows: existing } = await db.query('select id, name from public.stock_items where business_id = $1 and lower(btrim(name)) = lower($2)', [businessId, name]);
  if (existing[0]) throw new HttpError(409, `“${existing[0].name}” is already a stock item. Use that one.`, { itemId: existing[0].id });
  const { rows } = await db.query(`insert into public.stock_items (business_id, name, low_level, created_by) values ($1, $2, $3, $4)
    returning id, name, unit, low_level`, [businessId, name, low, actorId]);
  return { id: rows[0].id, name: rows[0].name, unit: rows[0].unit, lowLevel: num(rows[0].low_level) };
}

/**
 * Count / add / waste at one location.
 *   count – set on-hand to what was counted (opening stock is the first count); records the difference
 *   added – servings received from outside Cravio transfers (supplier, own production)
 *   waste – servings thrown away or spoiled (can't exceed what's on hand)
 */
export async function adjust(db, { businessId, locationId, actorId }, body = {}) {
  const kind = body.kind;
  if (!['count', 'added', 'waste'].includes(kind)) throw new HttpError(400, 'Choose count, add or waste.');
  const item = await requireItem(db, businessId, body.itemId);
  const amount = quantity(body.quantity, kind === 'count' ? 'Counted servings' : 'Servings', { allowZero: kind === 'count' });
  const text = note(body.note);
  if (kind === 'waste' && !text) throw new HttpError(400, 'Say why the servings were wasted.');
  const current = await lockBalance(db, locationId, item.id);
  const delta = kind === 'count' ? amount - current : kind === 'added' ? amount : -amount;
  if (kind === 'waste' && amount > current) throw new HttpError(409, `Only ${current} servings of ${item.name} are on hand.`);
  const balance = await move(db, { businessId, locationId, itemId: item.id, delta, reason: kind, actorId, note: text });
  return { itemId: item.id, onHand: balance ?? current, change: delta };
}

/* ---------- Branch: menu links, corrections ---------- */

export async function linkMenuItem(db, { businessId, restaurantId, actorId }, menuItemId, body = {}) {
  const dish = (await db.query('select id, name from public.menu_items where id = $1 and restaurant_id = $2', [id(menuItemId, 'Dish'), restaurantId])).rows[0];
  if (!dish) throw new HttpError(404, 'That dish isn’t on this branch’s menu.');
  if (body.itemId === null) {
    await db.query('delete from public.menu_item_stock where menu_item_id = $1', [dish.id]);
    return { menuItemId: dish.id, tracked: false };
  }
  const item = await requireItem(db, businessId, body.itemId);
  const servings = body.servings === undefined ? 1 : quantity(body.servings, 'Servings per dish');
  const keepSelling = body.allowWhenOut === true;
  await db.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings, allow_when_out, updated_by)
    values ($1, $2, $3, $4, $5, $6) on conflict (menu_item_id) do update
    set item_id = excluded.item_id, servings = excluded.servings, allow_when_out = excluded.allow_when_out, updated_by = excluded.updated_by, updated_at = now()`,
  [dish.id, restaurantId, item.id, servings, keepSelling, actorId]);
  return { menuItemId: dish.id, tracked: true, itemId: item.id, servings, allowWhenOut: keepSelling };
}

/**
 * Stock correction on a served order, e.g. a Fanta swapped for a Coke after serving:
 * returned: servings that came back unused (added back); used: servings used instead (taken out).
 * The order's lines and bill are not changed.
 */
export async function correctOrder(db, { businessId, restaurantId, locationId, actorId }, orderId, body = {}) {
  const order = (await db.query('select id, status, served_at from public.orders where id = $1 and restaurant_id = $2', [id(orderId, 'Order'), restaurantId])).rows[0];
  if (!order) throw new HttpError(404, 'That order isn’t at this branch.');
  if (!order.served_at || !['served', 'paid', 'cancelled'].includes(order.status)) throw new HttpError(409, 'Stock leaves when an order is served. Change the order itself until then.');
  const text = note(body.note);
  if (!text) throw new HttpError(400, 'Say what changed, e.g. “Swapped Fanta for Coke”.');
  const lines = [...(body.returned || []).map((line) => ({ ...line, sign: 1 })), ...(body.used || []).map((line) => ({ ...line, sign: -1 }))];
  if (!lines.length) throw new HttpError(400, 'Add what came back or what was used instead.');
  const changes = [];
  for (const line of lines.sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)))) {
    const item = await requireItem(db, businessId, line.itemId);
    const amount = quantity(line.quantity);
    await lockBalance(db, locationId, item.id);
    const balance = await move(db, { businessId, locationId, itemId: item.id, delta: line.sign * amount, reason: 'order_correction', actorId, orderId: order.id, note: text });
    changes.push({ itemId: item.id, change: line.sign * amount, onHand: balance });
  }
  return { orderId: order.id, changes };
}

/* ---------- Requests ---------- */

async function nextNumber(db, table, businessId) {
  await db.query('select pg_advisory_xact_lock(hashtextextended($1, 11))', [`${table}:${businessId}`]);
  const { rows } = await db.query(`select coalesce(max(number), 0) + 1 as next from public.${table} where business_id = $1`, [businessId]);
  return rows[0].next;
}

function requestLines(businessId, lines) {
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Add at least one item.');
  if (lines.length > 100) throw new HttpError(400, 'Keep a request under 100 items.');
  const seen = new Set();
  return lines.map((line) => {
    const itemId = id(line.itemId, 'Stock item');
    if (seen.has(itemId)) throw new HttpError(400, 'Each item can appear once.');
    seen.add(itemId);
    return { itemId, quantity: quantity(line.quantity) };
  });
}

export async function submitRequest(db, { businessId, restaurantId, actorId }, body = {}) {
  const lines = requestLines(businessId, body.lines);
  for (const line of lines) await requireItem(db, businessId, line.itemId);
  const number = await nextNumber(db, 'stock_requests', businessId);
  const { rows } = await db.query(`insert into public.stock_requests (business_id, restaurant_id, number, note, requested_by)
    values ($1, $2, $3, $4, $5) returning id`, [businessId, restaurantId, number, note(body.note), actorId]);
  for (const line of lines) await db.query('insert into public.stock_request_lines (request_id, item_id, requested) values ($1, $2, $3)', [rows[0].id, line.itemId, line.quantity]);
  return { id: rows[0].id, number, status: 'submitted' };
}

async function lockRequest(db, businessId, requestId) {
  const { rows } = await db.query('select * from public.stock_requests where id = $1 and business_id = $2 for update', [id(requestId, 'Request'), businessId]);
  if (!rows[0]) throw new HttpError(404, 'That request isn’t in this business.');
  return rows[0];
}

export async function cancelRequest(db, { businessId, restaurantId, actorId }, requestId) {
  const request = await lockRequest(db, businessId, requestId);
  if (request.restaurant_id !== restaurantId) throw new HttpError(404, 'That request isn’t from this branch.');
  if (request.status !== 'submitted') throw new HttpError(409, 'Only a request that hasn’t been reviewed can be cancelled.');
  await db.query(`update public.stock_requests set status = 'cancelled', updated_at = now(), review_note = coalesce(review_note, 'Cancelled by the branch'), reviewed_by = $2 where id = $1`, [request.id, actorId]);
  return { id: request.id, status: 'cancelled' };
}

/**
 * Owner review. decision 'reject' (with a reason) or 'approve' with an approved quantity per line
 * (0 declines that line; at least one line must be approved). Approval doesn't move stock.
 */
export async function reviewRequest(db, { businessId, actorId }, requestId, body = {}) {
  const request = await lockRequest(db, businessId, requestId);
  if (request.status !== 'submitted') throw new HttpError(409, `This request is already ${request.status}.`);
  const text = note(body.note);
  if (body.decision === 'reject') {
    if (!text) throw new HttpError(400, 'Give the branch a reason for rejecting.');
    await db.query(`update public.stock_requests set status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now() where id = $1`, [request.id, actorId, text]);
    return { id: request.id, status: 'rejected' };
  }
  if (body.decision !== 'approve') throw new HttpError(400, 'Choose approve or reject.');
  const { rows: lines } = await db.query('select item_id, requested from public.stock_request_lines where request_id = $1', [request.id]);
  const given = new Map((body.lines || []).map((line) => [String(line.itemId).toLowerCase(), line.approved]));
  let total = 0;
  for (const line of lines) {
    const approved = given.has(line.item_id) ? quantity(given.get(line.item_id), 'Approved servings', { allowZero: true }) : Number(line.requested);
    if (approved > Number(line.requested)) throw new HttpError(400, 'You can’t approve more than was requested. Dispatch extra separately.');
    total += approved;
    await db.query('update public.stock_request_lines set approved = $3 where request_id = $1 and item_id = $2', [request.id, line.item_id, approved]);
  }
  if (total === 0) throw new HttpError(400, 'Approve at least one item, or reject the request.');
  await db.query(`update public.stock_requests set status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now() where id = $1`, [request.id, actorId, text]);
  return { id: request.id, status: 'approved' };
}

/* ---------- Dispatch and receipt ---------- */

function dispatchCode() {
  return Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

/**
 * Sends servings from the main center to a branch. With requestId, lines default to the approved quantities.
 * Center stock is checked and taken out at once (in transit until received). Returns the dispatch number and code.
 */
export async function dispatch(db, { businessId, actorId }, body = {}) {
  let request = null;
  let restaurantId;
  let lines;
  if (body.requestId) {
    request = await lockRequest(db, businessId, body.requestId);
    if (request.status !== 'approved') throw new HttpError(409, request.status === 'submitted' ? 'Review the request before dispatching.' : `This request is already ${request.status}.`);
    restaurantId = request.restaurant_id;
    const { rows } = await db.query('select item_id, approved from public.stock_request_lines where request_id = $1 and approved > 0', [request.id]);
    lines = body.lines ? requestLines(businessId, body.lines) : rows.map((row) => ({ itemId: row.item_id, quantity: Number(row.approved) }));
  } else {
    restaurantId = id(body.restaurantId, 'Branch');
    lines = requestLines(businessId, body.lines);
  }
  const branchBusiness = await businessOfRestaurant(db, restaurantId);
  if (branchBusiness !== businessId) throw new HttpError(404, 'That branch isn’t in this business.');
  const from = await centerLocation(db, businessId);
  const to = await branchLocation(db, restaurantId);
  const number = await nextNumber(db, 'stock_transfers', businessId);
  const code = dispatchCode();
  const { rows } = await db.query(`insert into public.stock_transfers (business_id, number, code, from_location, to_location, request_id, note, dispatched_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [businessId, number, code, from, to, request?.id || null, note(body.note), actorId]);
  const transferId = rows[0].id;
  for (const line of [...lines].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    const item = await requireItem(db, businessId, line.itemId);
    const onHand = await lockBalance(db, from, item.id);
    if (onHand < line.quantity) throw new HttpError(409, `The main center has ${onHand} servings of ${item.name}; you’re sending ${line.quantity}.`, { itemId: item.id });
    await db.query('insert into public.stock_transfer_lines (transfer_id, item_id, quantity) values ($1, $2, $3)', [transferId, item.id, line.quantity]);
    await move(db, { businessId, locationId: from, itemId: item.id, delta: -line.quantity, reason: 'dispatched', actorId, transferId });
  }
  if (request) await db.query(`update public.stock_requests set status = 'dispatched', updated_at = now() where id = $1`, [request.id]);
  return { id: transferId, number, code, restaurantId, status: 'in_transit' };
}

async function lockTransfer(db, businessId, transferId) {
  const { rows } = await db.query('select * from public.stock_transfers where id = $1 and business_id = $2 for update', [id(transferId, 'Dispatch'), businessId]);
  if (!rows[0]) throw new HttpError(404, 'That dispatch isn’t in this business.');
  return rows[0];
}

/** Owner takes back a dispatch that hasn't been received: servings return to the center. */
export async function cancelDispatch(db, { businessId, actorId }, transferId) {
  const transfer = await lockTransfer(db, businessId, transferId);
  if (transfer.status !== 'in_transit') throw new HttpError(409, `This dispatch is already ${transfer.status.replace('_', ' ')}.`);
  const { rows: lines } = await db.query('select item_id, quantity from public.stock_transfer_lines where transfer_id = $1 order by item_id', [transfer.id]);
  for (const line of lines) {
    await lockBalance(db, transfer.from_location, line.item_id);
    await move(db, { businessId, locationId: transfer.from_location, itemId: line.item_id, delta: Number(line.quantity), reason: 'dispatch_cancelled', actorId, transferId: transfer.id });
  }
  await db.query(`update public.stock_transfers set status = 'cancelled', cancelled_by = $2, cancelled_at = now() where id = $1`, [transfer.id, actorId]);
  if (transfer.request_id) await db.query(`update public.stock_requests set status = 'approved', updated_at = now() where id = $1`, [transfer.request_id]);
  return { id: transfer.id, status: 'cancelled' };
}

/** The in-transit dispatch with this code, if it is headed to one of `restaurantIds`. */
export async function findByCode(db, code, restaurantIds) {
  const clean = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(clean)) throw new HttpError(400, 'Enter the 10-character code on the dispatch note.');
  const { rows } = await db.query(`select t.id, t.number, t.status, l.restaurant_id from public.stock_transfers t
    join public.stock_locations l on l.id = t.to_location where t.code = $1 and l.restaurant_id = any($2::uuid[])`, [clean, restaurantIds]);
  if (!rows[0]) throw new HttpError(404, 'No dispatch with that code is on its way to your branches.');
  return { id: rows[0].id, number: rows[0].number, status: rows[0].status, branchId: rows[0].restaurant_id };
}

/**
 * The destination branch confirms what arrived, line by line (received ≤ dispatched). Received servings are added
 * to the branch; any shortfall stays recorded on the dispatch as missing (it left the center but didn't arrive).
 */
export async function receive(db, { businessId, restaurantId, actorId }, transferId, body = {}) {
  const transfer = await lockTransfer(db, businessId, transferId);
  const to = await branchLocation(db, restaurantId);
  if (transfer.to_location !== to) throw new HttpError(404, 'That dispatch isn’t addressed to this branch.');
  if (transfer.status !== 'in_transit') throw new HttpError(409, `This dispatch is already ${transfer.status.replace('_', ' ')}.`);
  const { rows: lines } = await db.query('select item_id, quantity from public.stock_transfer_lines where transfer_id = $1 order by item_id', [transfer.id]);
  const counted = new Map((body.lines || []).map((line) => [String(line.itemId).toLowerCase(), line.received]));
  const text = note(body.note);
  let short = 0;
  for (const line of lines) {
    if (!counted.has(line.item_id)) throw new HttpError(400, 'Enter what arrived for every item on the dispatch.');
    const received = quantity(counted.get(line.item_id), 'Received servings', { allowZero: true });
    if (received > Number(line.quantity)) throw new HttpError(400, 'You can’t receive more than was dispatched. Add extra as a separate “Add stock”.');
    short += Number(line.quantity) - received;
    await db.query('update public.stock_transfer_lines set received = $3 where transfer_id = $1 and item_id = $2', [transfer.id, line.item_id, received]);
    if (received > 0) {
      await lockBalance(db, to, line.item_id);
      await move(db, { businessId, locationId: to, itemId: line.item_id, delta: received, reason: 'received', actorId, transferId: transfer.id, note: text });
    }
  }
  if (short > 0 && !text) throw new HttpError(400, 'Some items are short. Add a note saying what was missing or damaged.');
  await db.query(`update public.stock_transfers set status = 'received', received_by = $2, received_at = now(), note = coalesce($3, note) where id = $1`, [transfer.id, actorId, text]);
  if (transfer.request_id) await db.query(`update public.stock_requests set status = 'received', updated_at = now() where id = $1`, [transfer.request_id]);
  return { id: transfer.id, status: 'received', short };
}

/* ---------- Reads ---------- */

const transferOut = (row, lines) => ({
  id: row.id, number: row.number, code: row.code, status: row.status, note: row.note, requestId: row.request_id,
  branchId: row.restaurant_id, branchName: row.branch_name,
  dispatchedAt: row.dispatched_at, receivedAt: row.received_at,
  lines: lines.filter((line) => line.transfer_id === row.id).map((line) => ({ itemId: line.item_id, name: line.name, quantity: Number(line.quantity), received: num(line.received) })),
});
const requestOut = (row, lines) => ({
  id: row.id, number: row.number, status: row.status, note: row.note, reviewNote: row.review_note,
  branchId: row.restaurant_id, branchName: row.branch_name, createdAt: row.created_at, reviewedAt: row.reviewed_at,
  lines: lines.filter((line) => line.request_id === row.id).map((line) => ({ itemId: line.item_id, name: line.name, requested: Number(line.requested), approved: num(line.approved) })),
});

async function transfersFor(db, where, params) {
  const { rows } = await db.query(`select t.*, l.restaurant_id, r.name as branch_name from public.stock_transfers t
    join public.stock_locations l on l.id = t.to_location join public.restaurants r on r.id = l.restaurant_id
    where ${where} order by t.dispatched_at desc limit 50`, params);
  const { rows: lines } = rows.length ? await db.query(`select tl.*, i.name from public.stock_transfer_lines tl join public.stock_items i on i.id = tl.item_id
    where tl.transfer_id = any($1::uuid[]) order by i.name`, [rows.map((row) => row.id)]) : { rows: [] };
  return rows.map((row) => transferOut(row, lines));
}

async function requestsFor(db, where, params) {
  const { rows } = await db.query(`select q.*, r.name as branch_name from public.stock_requests q join public.restaurants r on r.id = q.restaurant_id
    where ${where} order by q.created_at desc limit 50`, params);
  const { rows: lines } = rows.length ? await db.query(`select ql.*, i.name from public.stock_request_lines ql join public.stock_items i on i.id = ql.item_id
    where ql.request_id = any($1::uuid[]) order by i.name`, [rows.map((row) => row.id)]) : { rows: [] };
  return rows.map((row) => requestOut(row, lines));
}

async function movementsAt(db, locationId, limit = 60) {
  const { rows } = await db.query(`select m.id, m.item_id, i.name, m.delta, m.balance_after, m.reason, m.note, m.order_id, m.transfer_id, m.created_at,
      p.name as actor from public.stock_movements m join public.stock_items i on i.id = m.item_id left join public.profiles p on p.id = m.actor_id
    where m.location_id = $1 order by m.id desc limit $2`, [locationId, limit]);
  return rows.map((row) => ({ id: Number(row.id), itemId: row.item_id, name: row.name, change: Number(row.delta), balance: Number(row.balance_after),
    reason: row.reason, note: row.note, orderId: row.order_id, transferId: row.transfer_id, at: row.created_at, by: row.actor || null }));
}

/** Everything the branch Inventory page shows. */
export async function branchSnapshot(db, restaurantId) {
  const businessId = await businessOfRestaurant(db, restaurantId);
  const location = await branchLocation(db, restaurantId);
  const [items, committed, links, dishes] = await Promise.all([
    db.query(`select i.id, i.name, i.unit, i.low_level, i.active, coalesce(b.on_hand, 0) as on_hand, b.updated_at
      from public.stock_items i left join public.stock_balances b on b.item_id = i.id and b.location_id = $2
      where i.business_id = $1 order by i.name`, [businessId, location]),
    db.query('select item_id, quantity from private.branch_committed($1)', [restaurantId]),
    db.query('select menu_item_id, item_id, servings, allow_when_out from public.menu_item_stock where restaurant_id = $1', [restaurantId]),
    db.query('select id, name, available from public.menu_items where restaurant_id = $1 order by name', [restaurantId]),
  ]);
  const held = new Map(committed.rows.map((row) => [row.item_id, Number(row.quantity)]));
  const linkOf = new Map(links.rows.map((row) => [row.menu_item_id, row]));
  const [incoming, requests, movements] = await Promise.all([
    transfersFor(db, `t.to_location = $1 and (t.status = 'in_transit' or t.received_at > now() - interval '14 days')`, [location]),
    requestsFor(db, 'q.restaurant_id = $1', [restaurantId]),
    movementsAt(db, location),
  ]);
  return {
    businessId, generatedAt: new Date().toISOString(), unit: 'serving',
    items: items.rows.map((row) => {
      const onHand = Number(row.on_hand);
      const reserved = held.get(row.id) || 0;
      const available = onHand - reserved;
      const low = num(row.low_level);
      return { id: row.id, name: row.name, unit: row.unit, active: row.active, onHand, reserved, available, lowLevel: low,
        state: available <= 0 ? 'out' : low !== null && available <= low ? 'low' : 'ok', updatedAt: row.updated_at,
        dishes: links.rows.filter((link) => link.item_id === row.id).length };
    }),
    dishes: dishes.rows.map((row) => {
      const link = linkOf.get(row.id);
      return { id: row.id, name: row.name, manuallySoldOut: !row.available,
        link: link ? { itemId: link.item_id, servings: Number(link.servings), allowWhenOut: link.allow_when_out } : null };
    }),
    incoming, requests, movements,
  };
}

/** Everything the owner Inventory page shows for one business. */
export async function businessSnapshot(db, businessId) {
  const center = await centerLocation(db, businessId);
  const [items, branches, balances] = await Promise.all([
    db.query(`select i.id, i.name, i.unit, i.low_level, coalesce(b.on_hand, 0) as on_hand from public.stock_items i
      left join public.stock_balances b on b.item_id = i.id and b.location_id = $2 where i.business_id = $1 order by i.name`, [businessId, center]),
    db.query('select id, name, status from public.restaurants where business_id = $1 order by name', [businessId]),
    db.query(`select l.restaurant_id, b.item_id, b.on_hand from public.stock_balances b join public.stock_locations l on l.id = b.location_id
      where l.business_id = $1 and l.kind = 'branch'`, [businessId]),
  ]);
  const [requests, transfers, movements] = await Promise.all([
    requestsFor(db, 'q.business_id = $1', [businessId]),
    transfersFor(db, 't.business_id = $1', [businessId]),
    movementsAt(db, center),
  ]);
  return {
    businessId, generatedAt: new Date().toISOString(), unit: 'serving',
    center: { id: center, name: 'Main center' },
    items: items.rows.map((row) => ({ id: row.id, name: row.name, unit: row.unit, lowLevel: num(row.low_level), centerOnHand: Number(row.on_hand),
      branches: Object.fromEntries(balances.rows.filter((b) => b.item_id === row.id).map((b) => [b.restaurant_id, Number(b.on_hand)])) })),
    branches: branches.rows.map((row) => ({ id: row.id, name: row.name, status: row.status })),
    requests, transfers, centerMovements: movements,
  };
}

/** Sold-out state per linked dish at a branch (for the guest and waiter menus). */
export async function availability(db, restaurantId) {
  const { rows } = await db.query('select * from public.stock_menu_availability($1)', [restaurantId]);
  return rows.map((row) => ({ menuItemId: row.menu_item_id, available: Number(row.available), servings: Number(row.servings), allowWhenOut: row.allow_when_out, soldOut: row.sold_out }));
}
