// P2-25: the 009 request / dispatch / receive endpoints (routes/stock.js, served by main) for a business whose inventory_enabled flag is ON.
//
// DECISION (a), delegation: when the business is switched on, those endpoints keep their URLs, request bodies and response shapes but run distribution.js, so
// there is ONE engine and ONE set of rows (reservations, ledger movements, discrepancies) whichever screen a person uses. When it is OFF the routes run
// src/stock/service.js exactly as before (that file is frozen). Delegation instead of a 409 'use_new_inventory' because every 009 call maps cleanly (the bodies
// carry item ids and servings/base-unit amounts) and a cached old page or an old client keeps working instead of dying mid-delivery.
//
// What the old callers see, and how it differs (all on purpose, each one stricter or equal, never looser):
//   * amounts are in the item's BASE unit (servings for 009 items), as before; the bridge passes unit = the item's base unit so nothing is rescaled;
//   * validation errors keep the 009 wording and status (same checks, same order, run before the new engine is called);
//   * approving a request now HOLDS the stock: approving more than the Warehouse has free is refused (409, says how much is free) instead of failing later at
//     dispatch; "approved" with less than asked is stored as partially_approved but still answers status 'approved';
//   * a dispatch of a request cannot send more than was approved (009 allowed it);
//   * a receipt is posted by the new engine (good quantity only, a shortfall opens a discrepancy and tells the owners) and still answers { id, status: 'received', short };
//   * statuses the old pages do not know are folded back when they read the snapshots: preparing -> approved, partially_approved -> approved, partially_received ->
//     dispatched / in_transit, completed -> received; drafts and transfers waiting for approval are hidden from the old pages.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { quantity, requireItem, branchLocation } from '../stock/service.js';
import { inventoryScope } from './permissions.js';
import * as dist from './distribution.js';

const missing = (message) => new HttpError(404, message);
const bad = (message) => new HttpError(400, message);
const conflict = (message) => new HttpError(409, message);

/* ---------- is the business on the new engine? ---------- */

/** True when public.businesses.inventory_enabled exists and is on. A database without migration 012 simply answers false (the 009 behaviour). */
export async function switched(db, businessId) {
  const col = await db.query(`select 1 from information_schema.columns where table_schema = 'public' and table_name = 'businesses' and column_name = 'inventory_enabled'`);
  if (!col.rows.length) return false;
  return (await db.query('select inventory_enabled from public.businesses where id = $1', [businessId])).rows[0]?.inventory_enabled === true;
}

/* ---------- status names the old pages know ---------- */

const REQUEST_NAMES = { draft: null, submitted: 'submitted', pending_approval: 'submitted', approved: 'approved', partially_approved: 'approved', preparing: 'approved', rejected: 'rejected',
  dispatched: 'dispatched', partially_received: 'dispatched', received: 'received', completed: 'received', cancelled: 'cancelled' };
const TRANSFER_NAMES = { pending_approval: null, in_transit: 'in_transit', partially_received: 'in_transit', received: 'received', cancelled: 'cancelled' };
export const legacyRequestStatus = (status) => (Object.hasOwn(REQUEST_NAMES, status) ? REQUEST_NAMES[status] : status);
export const legacyTransferStatus = (status) => (Object.hasOwn(TRANSFER_NAMES, status) ? TRANSFER_NAMES[status] : status);

/** A 009 snapshot (branchSnapshot / businessSnapshot) with new-engine statuses folded back. For a 009-only business this changes nothing. */
export function legacyView(snapshot) {
  if (!snapshot) return snapshot;
  const out = { ...snapshot };
  if (Array.isArray(snapshot.requests)) out.requests = snapshot.requests.filter((r) => legacyRequestStatus(r.status) !== null).map((r) => ({ ...r, status: legacyRequestStatus(r.status) }));
  if (Array.isArray(snapshot.transfers)) out.transfers = snapshot.transfers.filter((t) => legacyTransferStatus(t.status) !== null).map((t) => ({ ...t, status: legacyTransferStatus(t.status) }));
  return out;
}

/* ---------- 009 validation, repeated so the same mistakes get the same words ---------- */

const text = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw bad('The note must be text.');
  const clean = value.trim();
  if (clean.length > 280) throw bad('Keep the note under 280 characters.');
  return clean || null;
};
const itemId = (value, label) => { if (!isId(value)) throw bad(`${label} is invalid.`); return value.toLowerCase(); };

function lines(raw, { label = 'Quantity', key = 'quantity', allowZero = false } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw bad('Add at least one item.');
  if (raw.length > 100) throw bad('Keep a request under 100 items.');
  const seen = new Set();
  return raw.map((line) => {
    const id = itemId(line.itemId, 'Stock item');
    if (seen.has(id)) throw bad('Each item can appear once.');
    seen.add(id);
    return { itemId: id, quantity: quantity(line[key], label, { allowZero }) };
  });
}

const scopeOf = (db, ctx) => inventoryScope(db, ctx.context, ctx.businessId, { ensureLocations: true });
const baseUnits = async (db, businessId, ids) => {
  const items = await dist.loadItems(db, businessId, ids);
  return (id) => items.get(id)?.baseUnit;
};
const q = async (db, sql, params) => (await db.query(sql, params)).rows[0];

async function lockedRequest(db, businessId, requestId) {
  const row = await q(db, 'select * from public.stock_requests where id = $1 and business_id = $2 for update', [itemId(requestId, 'Request'), businessId]);
  if (!row) throw missing('That request isn’t in this business.');
  return row;
}
async function lockedTransfer(db, businessId, transferId) {
  const row = await q(db, 'select * from public.stock_transfers where id = $1 and business_id = $2 for update', [itemId(transferId, 'Dispatch'), businessId]);
  if (!row) throw missing('That dispatch isn’t in this business.');
  return row;
}

/* ---------- the seven calls ---------- */

/** POST /api/stock/requests  ctx: { businessId, restaurantId, actorId, context } */
export async function submitRequest(db, ctx, _params, body = {}) {
  const wanted = lines(body.lines);
  for (const l of wanted) await requireItem(db, ctx.businessId, l.itemId);
  const note = text(body.note);
  const scope = await scopeOf(db, ctx);
  const unit = await baseUnits(db, ctx.businessId, wanted.map((l) => l.itemId));
  const made = await dist.createRequest(db, scope, { locationId: dist.branchLocationOf(scope, ctx.restaurantId).id, note: note ?? undefined,
    lines: wanted.map((l) => ({ itemId: l.itemId, quantity: String(l.quantity), unit: unit(l.itemId) })) });
  return { id: made.request.id, number: made.request.number, status: 'submitted' };
}

/** POST /api/stock/requests/:id/cancel */
export async function cancelRequest(db, ctx, params) {
  const request = await lockedRequest(db, ctx.businessId, params.id);
  if (request.restaurant_id !== ctx.restaurantId) throw missing('That request isn’t from this branch.');
  if (request.status !== 'submitted') throw conflict('Only a request that hasn’t been reviewed can be cancelled.');
  const scope = await scopeOf(db, ctx);
  await dist.cancel(db, scope, request.id, { reason: 'Cancelled by the branch' });
  return { id: request.id, status: 'cancelled' };
}

/** POST /api/owner/stock/:biz/requests/:id/review */
export async function reviewRequest(db, ctx, params, body = {}) {
  const request = await lockedRequest(db, ctx.businessId, params.id);
  const status = legacyRequestStatus(request.status);
  if (request.status !== 'submitted') throw conflict(`This request is already ${status ?? request.status}.`);
  const reason = text(body.note);
  const scope = await scopeOf(db, ctx);
  if (body.decision === 'reject') {
    if (!reason) throw bad('Give the branch a reason for rejecting.');
    await dist.review(db, scope, request.id, { decision: 'reject', note: reason });
    return { id: request.id, status: 'rejected' };
  }
  if (body.decision !== 'approve') throw bad('Choose approve or reject.');
  const asked = (await db.query('select item_id, requested from public.stock_request_lines where request_id = $1', [request.id])).rows;
  const given = new Map((body.lines || []).map((l) => [String(l.itemId).toLowerCase(), l.approved]));
  const unit = await baseUnits(db, ctx.businessId, asked.map((l) => l.item_id));
  let total = 0;
  const approvals = asked.map((l) => {
    const approved = given.has(l.item_id) ? quantity(given.get(l.item_id), 'Approved amount', { allowZero: true }) : Number(l.requested);
    if (approved > Number(l.requested)) throw bad('You can’t approve more than was requested. Dispatch extra separately.');
    total += approved;
    return { itemId: l.item_id, approved: String(approved), unit: unit(l.item_id) };
  });
  if (total === 0) throw bad('Approve at least one item, or reject the request.');
  await dist.review(db, scope, request.id, { decision: 'approve', note: reason ?? undefined, lines: approvals });
  return { id: request.id, status: 'approved' };
}

/** POST /api/owner/stock/:biz/dispatches */
export async function dispatch(db, ctx, _params, body = {}) {
  const note = text(body.note);
  const scope = await scopeOf(db, ctx);
  let request = null;
  let branchId;
  if (body.requestId) {
    request = await lockedRequest(db, ctx.businessId, body.requestId);
    if (!['approved', 'partially_approved', 'preparing'].includes(request.status)) {
      throw conflict(request.status === 'submitted' ? 'Review the request before dispatching.' : `This request is already ${legacyRequestStatus(request.status) ?? request.status}.`);
    }
    branchId = request.restaurant_id;
  } else {
    branchId = itemId(body.restaurantId, 'Branch');
    const branch = await q(db, 'select business_id from public.restaurants where id = $1', [branchId]);
    if (!branch) throw missing('That branch doesn’t exist.');
    if (branch.business_id !== ctx.businessId) throw missing('That branch isn’t in this business.');
  }
  const wanted = body.lines || !request ? lines(body.lines) : null;
  const unit = wanted ? await baseUnits(db, ctx.businessId, wanted.map((l) => l.itemId)) : null;
  const sent = await dist.dispatch(db, scope, { requestId: request?.id, branchId: request ? undefined : branchId, note: note ?? undefined,
    lines: wanted ? wanted.map((l) => ({ itemId: l.itemId, quantity: String(l.quantity), unit: unit(l.itemId) })) : undefined });
  return { id: sent.transfer.id, number: sent.transfer.number, code: sent.transfer.code, restaurantId: branchId, status: 'in_transit' };
}

/** POST /api/owner/stock/:biz/dispatches/:id/cancel */
export async function cancelDispatch(db, ctx, params) {
  const transfer = await lockedTransfer(db, ctx.businessId, params.id);
  if (transfer.status !== 'in_transit') throw conflict(`This dispatch is already ${(legacyTransferStatus(transfer.status) ?? transfer.status).replace('_', ' ')}.`);
  const scope = await scopeOf(db, ctx);
  await dist.cancelDispatch(db, scope, transfer.id);
  return { id: transfer.id, status: 'cancelled' };
}

/** POST /api/stock/transfers/:id/receive */
export async function receive(db, ctx, params, body = {}) {
  const transfer = await lockedTransfer(db, ctx.businessId, params.id);
  const to = await branchLocation(db, ctx.restaurantId);
  if (transfer.to_location !== to) throw missing('That dispatch isn’t addressed to this branch.');
  if (transfer.status !== 'in_transit') throw conflict(`This dispatch is already ${(legacyTransferStatus(transfer.status) ?? transfer.status).replace('_', ' ')}.`);
  const sent = (await db.query('select item_id, quantity from public.stock_transfer_lines where transfer_id = $1 order by item_id', [transfer.id])).rows;
  const counted = new Map((body.lines || []).map((l) => [String(l.itemId).toLowerCase(), l.received]));
  const reason = text(body.note);
  let short = 0;
  const arrived = sent.map((l) => {
    if (!counted.has(l.item_id)) throw bad('Enter what arrived for every item on the dispatch.');
    const received = quantity(counted.get(l.item_id), 'Received amount', { allowZero: true });
    if (received > Number(l.quantity)) throw bad('You can’t receive more than was dispatched. Add extra as a separate “Add stock”.');
    short += Number(l.quantity) - received;
    return { itemId: l.item_id, received };
  });
  if (short > 0 && !reason) throw bad('Some items are short. Add a note saying what was missing or damaged.');
  const scope = await scopeOf(db, ctx);
  const unit = await baseUnits(db, ctx.businessId, arrived.map((l) => l.itemId));
  await dist.receive(db, scope, transfer.id, { note: reason ?? undefined, final: true,
    lines: arrived.map((l) => ({ itemId: l.itemId, received: String(l.received), unit: unit(l.itemId) })) });
  return { id: transfer.id, status: 'received', short };
}
