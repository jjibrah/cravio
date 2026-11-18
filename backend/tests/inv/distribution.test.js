// Distribution (P2-21, P2-22; migration 018). Runs the REAL service and route handlers (inventory-distribution.js, inventory-approvals.js) against an
// in-memory database with every proposed migration applied. No network.
// Covers T-REQ-1 (asks 20 kg, owner approves 15 -> partially approved, 15 kg held, available down, on hand unchanged), T-REQ-2 (dispatch 15, receive 14 ->
// Warehouse -15, branch +14, 1 kg short discrepancy, owners told), T-REQ-3 (cancel before dispatch releases the hold), approving more than is free (refused with
// the figure), partial dispatch (the rest stays held) then the second dispatch, damaged / over-delivery within and beyond tolerance, a code scanned by another
// branch or a waiter (403, T-SEC-1), cancel dispatch (before / after a receipt), idempotent replays, suggestions, a return to the Warehouse, branch -> branch with
// the owner's approval (maker-checker) and stock held for open orders, 009 requests adopted by the new engine (reserved oldest first, needs_attention when short),
// a 009 dispatch received by the new engine, and a clean reconciliation after every flow.
// Usage: node backend/tests/inv/distribution.test.js
import { rig } from './fixture.js';
import { makeAsserts, makeItem, receive } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-distribution.js';
import { createRoutes as approvalRoutes } from '../../src/routes/inventory-approvals.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { setSetting } from '../../src/inventory/policies.js';
import * as ledger from '../../src/inventory/ledger.js';
import * as recipes from '../../src/inventory/recipes.js';
import * as legacy from '../../src/stock/service.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, contexts, helpers } = r;
const biz = ids.businessId;
const WH = ids.centerLocationId;
const B1 = branches.branch1.locationId;
const B2 = branches.branch2.locationId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
  return contexts[who];
};
const common = { authenticate, pool: () => db, transact: (fn) => db.transaction(fn) };
const api = createRoutes({ ...common });
const approvalsApi = approvalRoutes(common);
const run = async (table, as, method, pathname, body, query = '', branch = null) => {
  for (const route of table) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    const headers = { authorization: `Bearer ${as}` };
    if (branch) headers['x-cravio-branch'] = branch;
    return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const BR = { manager: ids.branchId, manager2: branches.branch2.restaurantId, owner: ids.branchId, waiter: ids.branchId, ops: ids.branchId };
const mgr = (who, method, suffix, body, query) => run(api, who, method, `/api/inventory${suffix}`, body, query, BR[who]);
const own = (who, method, suffix, body, query) => run(api, who, method, `/api/owner/inventory/${biz}${suffix}`, body, query);
const decide = (who, approvalId, body) => run(approvalsApi, who, 'POST', `/api/owner/inventory/${biz}/approvals/${approvalId}/decide`, body);
const uuid = () => crypto.randomUUID();
const scopeOf = (who) => inventoryScope(db, contexts[who], biz);

const bal = async (loc, item) => (await ledger.balance(db, loc, item));
const reconciled = async (m) => eq(await ledger.reconcile(db, { businessId: biz }), [], `reconciliation is clean: ${m}`);
const notes = (user, kind) => q('select * from public.notifications where recipient_id = $1 and kind = $2 order by created_at', [user, kind]);
const kg = (n) => String(Math.round(n * 1000) / 1000);

// ---- stock at the Warehouse ----
const beef = await makeItem(db, biz, 'Beef');
const lamb = await makeItem(db, biz, 'Lamb');
const { flour, rice } = r.items;
await receive(db, { businessId: biz, locationId: WH, itemId: beef, qty: '100000', unitCost: '0.5' });     // 100 kg at KES 0.50 a gram
await receive(db, { businessId: biz, locationId: WH, itemId: flour, qty: '200000', unitCost: '0.1' });
await receive(db, { businessId: biz, locationId: WH, itemId: rice, qty: '60000', unitCost: '0.2' });
const line = (itemId, quantity, unit = 'kg', extra = {}) => ({ itemId, quantity, unit, ...extra });

// ============================================================================================================
// T-REQ-1: asks 20 kg, the owner approves 15
// ============================================================================================================
let req1;
{
  const made = await mgr('manager', 'POST', '/requests', { lines: [line(beef, 20)], note: 'Weekend rush', priority: 'urgent', neededBy: '2026-11-21', commandId: uuid() });
  req1 = made.request;
  eq([req1.status, req1.ref, req1.lines[0].requested, req1.priority, req1.neededBy, req1.branchId], ['submitted', 'REQ-2026-0001', '20000.0000', 'urgent', '2026-11-21', ids.branchId], 'request is submitted and numbered');
  eq(req1.lines[0].requestedDisplay.startsWith('20 kg'), true, 'shown in the item’s own unit');
  eq((await notes(people.owner, 'request_submitted')).length, 1, 'the owner is told a request came in');

  const inbox = await own('owner', 'GET', '/requests/inbox');
  eq(inbox.requests.map((x) => x.id), [req1.id], 'the owner’s inbox lists it');
  eq([inbox.requests[0].lines[0].warehouse.available, inbox.requests[0].lines[0].short], ['100000.0000', false], 'with what the Warehouse has beside each line');
  await refuses(mgr('manager2', 'GET', `/requests/${req1.id}`), 403, 'branch_forbidden', null, 'another branch can’t read it');
  await refuses(mgr('waiter', 'POST', '/requests', { lines: [line(beef, 1)] }), 403, 'forbidden', null, 'a waiter can’t ask for stock');
  await refuses(own('manager', 'GET', '/requests'), 403, 'forbidden', null, 'a branch manager can’t use the owner inbox');
  await refuses(own('owner', 'POST', `/requests/${req1.id}/review`, { decision: 'approve', lines: [{ itemId: beef, approved: 21, unit: 'kg' }] }), 400, 'approved_over_requested', /more than was asked/, 'can’t approve more than asked');

  const cmd = uuid();
  const approved = await own('owner', 'POST', `/requests/${req1.id}/review`, { decision: 'approve', note: 'Half now', lines: [{ itemId: beef, approved: 15, unit: 'kg' }], commandId: cmd });
  eq([approved.request.status, approved.request.lines[0].approved, approved.request.lines[0].held, approved.request.approvedBy], ['partially_approved', '15000.0000', '15000.0000', people.owner], 'T-REQ-1: partially approved, 15 kg held');
  let b = await bal(WH, beef);
  eq([b.onHand, b.reserved, b.available], ['100000.0000', '15000.0000', '85000.0000'], 'on hand unchanged, 15 kg reserved, available down by 15');
  eq((await notes(people.manager, 'request_partially_approved')).length, 1, 'the branch manager is told');
  const again = await own('owner', 'POST', `/requests/${req1.id}/review`, { decision: 'approve', note: 'Half now', lines: [{ itemId: beef, approved: 15, unit: 'kg' }], commandId: cmd });
  eq(again.request.status, 'partially_approved', 'a replay with the same commandId returns the same result');
  eq((await bal(WH, beef)).reserved, '15000.0000', 'and holds the stock only once');
  eq((await one(`select count(*)::int as n from public.stock_reservations where request_id = $1`, [req1.id])).n, 1, 'one reservation row');
  await refuses(own('owner', 'POST', `/requests/${req1.id}/review`, { decision: 'approve' }), 409, 'already_reviewed', /already partially approved/, 'approving again without the commandId is refused');
  await reconciled('after approval');
}

// ============================================================================================================
// Approve more than the Warehouse has free
// ============================================================================================================
{
  const big = (await mgr('manager', 'POST', '/requests', { lines: [line(rice, 80)] })).request;
  const e = await refuses(own('owner', 'POST', `/requests/${big.id}/review`, { decision: 'approve' }), 409, 'insufficient_available', /Only 60 kg .*of Rice is free at the Warehouse/, 'asked for 80 kg, 60 kg free');
  eq([e.details.available, e.details.itemId], ['60000.0000', rice], 'the refusal carries the available figure and the item');
  eq((await one('select status from public.stock_requests where id = $1', [big.id])).status, 'submitted', 'the request stays submitted');
  const rej = await own('owner', 'POST', `/requests/${big.id}/review`, { decision: 'reject', note: 'Wait for the next delivery' });
  eq(rej.request.status, 'rejected', 'the owner can reject');
  eq((await notes(people.manager, 'request_rejected')).length, 1, 'and the branch is told');
  await refuses(own('owner', 'POST', `/requests/${(await mgr('manager', 'POST', '/requests', { lines: [line(rice, 1)] })).request.id}/review`, { decision: 'reject' }), 400, 'reason_required', null, 'a rejection needs a reason');
  await refuses(mgr('manager', 'POST', `/requests/${big.id}/cancel`, {}), 409, 'not_cancellable', null, 'a rejected request can’t be cancelled');
}

// ============================================================================================================
// T-REQ-2: dispatch 15, branch receives 14
// ============================================================================================================
let trf1;
{
  const prep = await own('owner', 'POST', `/requests/${req1.id}/prepare`, {});
  eq([prep.lines.length, prep.lines[0].name, prep.lines[0].qtyBase, prep.lines[0].warehouseOnHand], [1, 'Beef', '15000.0000', '100000.0000'], 'the pick list shows what is left to send');
  eq((await one('select status from public.stock_requests where id = $1', [req1.id])).status, 'preparing', 'preparing');
  const cmd = uuid();
  const sent = await own('owner', 'POST', `/requests/${req1.id}/dispatch`, { driver: 'Joseph', vehicle: 'KDG 123A', note: 'Cold box', commandId: cmd });
  trf1 = sent.transfer;
  ok(/^[A-HJ-NP-Z2-9]{10}$/.test(trf1.code), 'a 10-letter code');
  eq([trf1.ref, trf1.status, trf1.direction, trf1.requestRef, trf1.qr.path, trf1.lines[0].quantity], ['TRF-2026-0001', 'in_transit', 'out', 'REQ-2026-0001', `/receive/${trf1.code}`, '15000.0000'], 'transfer in transit with the QR payload');
  eq([trf1.deliveryNote.driver, trf1.deliveryNote.vehicle, trf1.deliveryNote.from, trf1.deliveryNote.lines[0].name], ['Joseph', 'KDG 123A', 'Warehouse', 'Beef'], 'delivery note JSON with driver and vehicle');
  eq(sent.request.status, 'dispatched', 'the request is dispatched');
  let b = await bal(WH, beef);
  eq([b.onHand, b.reserved, b.available], ['85000.0000', '0.0000', '85000.0000'], 'Warehouse -15 kg and the hold is used up');
  const m = await one(`select delta::text as delta, unit_cost::text as cost, reason from public.stock_movements where ref_id = $1 and location_id = $2`, [trf1.id, WH]);
  eq([m.delta, m.cost, m.reason], ['-15000.0000', '0.500000', 'transfer_dispatch'], 'a transfer_dispatch movement at the average cost');
  eq((await own('owner', 'POST', `/requests/${req1.id}/dispatch`, { driver: 'Joseph', vehicle: 'KDG 123A', note: 'Cold box', commandId: cmd })).transfer.id, trf1.id, 'a replay returns the same dispatch');
  eq((await bal(WH, beef)).onHand, '85000.0000', 'and posts it once');
  eq((await notes(people.manager, 'delivery_incoming')).length, 1, 'the branch is told it is coming');
  await reconciled('after dispatch');

  // in transit is visible to both sides
  eq((await mgr('manager', 'GET', '/transfers', undefined, '?status=active')).transfers.map((t) => t.id), [trf1.id], 'the branch sees it on its way');
  eq((await own('owner', 'GET', '/dispatches', undefined, '?status=active')).transfers.map((t) => t.id), [trf1.id], 'and so does the owner');
}
{
  // T-SEC-1: the QR code
  await refuses(mgr('manager2', 'GET', `/receive/${trf1.code}`), 403, 'forbidden', null, 'another branch’s manager scanning the code is refused');
  await refuses(mgr('waiter', 'GET', `/receive/${trf1.code}`), 403, 'forbidden', null, 'a waiter is refused');
  await refuses(mgr('manager2', 'POST', `/transfers/${trf1.id}/receive`, { lines: [{ itemId: beef, received: 15, unit: 'kg' }] }), 403, 'branch_forbidden', null, 'and can’t receive it by id');
  await refuses(mgr('manager', 'GET', '/receive/AAAAAAAAAA'), 404, 'code_not_found', null, 'an unknown code is a 404');
  await refuses(mgr('manager', 'GET', '/receive/abc'), 400, 'bad_code', null, 'a malformed code is a 400');
  eq((await q(`select 1 from public.inventory_events where action = 'denied' and entity = 'transfer'`)).length >= 2, true, 'refusals are audited');
  const found = await mgr('manager', 'GET', `/receive/${trf1.code.toLowerCase()}`);
  eq([found.transfer.id, found.transfer.status, found.transfer.toBranchId], [trf1.id, 'in_transit', ids.branchId], 'the destination manager finds it by code (any case)');
  eq((await own('owner', 'GET', `/receive/${trf1.code}`)).transfer.id, trf1.id, 'the owner can look it up too');
}
{
  // receive 14 of 15: needs a note
  await refuses(mgr('manager', 'POST', `/transfers/${trf1.id}/receive`, { lines: [{ itemId: beef, received: 14, unit: 'kg' }] }), 400, 'note_required', /Add a note/, 'a short delivery needs a note');
  await refuses(mgr('manager', 'POST', `/transfers/${trf1.id}/receive`, { lines: [], note: 'x' }), 400, 'line_missing', /Enter what arrived of Beef/, 'every line must be counted');
  eq((await bal(B1, beef)).onHand, '0.0000', 'nothing moved yet');
  const done = await mgr('manager', 'POST', `/transfers/${trf1.id}/receive`, { lines: [{ itemId: beef, received: 14, unit: 'kg' }], note: 'One bag split open', commandId: uuid() });
  eq([done.transfer.status, done.closed, done.discrepanciesOpened.map((d) => [d.kind, d.quantity])], ['received', true, [['short', '1000.0000']]], 'T-REQ-2: received, one short discrepancy of 1 kg');
  eq((await bal(B1, beef)).onHand, '14000.0000', 'the branch gained 14 kg');
  eq((await bal(WH, beef)).onHand, '85000.0000', 'the Warehouse lost 15 kg in total');
  const m = await one(`select unit_cost::text as cost, reason from public.stock_movements where location_id = $1 and item_id = $2`, [B1, beef]);
  eq([m.cost, m.reason], ['0.500000', 'transfer_receipt'], 'received at the dispatch cost');
  const d = await one(`select kind, qty_base::text as qty, value_kes::text as value, status, note from public.transfer_discrepancies where transfer_id = $1`, [trf1.id]);
  eq([d.kind, d.qty, d.value, d.status, d.note], ['short', '1000.0000', '500.00', 'open', 'One bag split open'], 'the discrepancy is open, valued at the carried cost');
  eq([(await notes(people.owner, 'discrepancy_opened')).length, (await notes(people.owner, 'delivery_received')).length], [1, 1], 'the owner is told about the difference and the receipt');
  const reqNow = (await own('owner', 'GET', `/requests/${req1.id}`)).request;
  eq([reqNow.status, reqNow.lines[0].dispatched, reqNow.lines[0].received], ['received', '15000.0000', '14000.0000'], 'the request is received (not completed: a discrepancy is open)');
  await refuses(mgr('manager', 'POST', `/transfers/${trf1.id}/receive`, { lines: [{ itemId: beef, received: 1, unit: 'kg' }], note: 'x' }), 409, 'not_receivable', /already received/, 'receiving twice is refused');
  await refuses(own('owner', 'POST', `/dispatches/${trf1.id}/cancel`, {}), 409, 'not_cancellable', /already received/, 'cancel dispatch after receipt is refused');
  const opened = (await mgr('manager', 'GET', `/transfers/${trf1.id}`)).transfer;
  eq(opened.discrepancies.map((x) => x.kind), ['short'], 'the branch sees the discrepancy on the delivery');
  await reconciled('after the receipt');
}

// ============================================================================================================
// T-REQ-3: cancel before dispatch
// ============================================================================================================
{
  const before = await bal(WH, flour);
  const made = (await mgr('manager', 'POST', '/requests', { lines: [line(flour, 50)] })).request;
  await own('owner', 'POST', `/requests/${made.id}/review`, { decision: 'approve' });
  const held = await bal(WH, flour);
  eq([held.reserved, held.available], ['50000.0000', kgToG(150)], 'approved in full: 50 kg held, available down');
  const cancelled = await mgr('manager', 'POST', `/requests/${made.id}/cancel`, { reason: 'No longer needed' });
  eq(cancelled.request.status, 'cancelled', 'T-REQ-3: cancelled');
  const after = await bal(WH, flour);
  eq([after.reserved, after.available, after.onHand], [before.reserved, before.available, before.onHand], 'the hold is released and available is back');
  eq((await one('select status from public.stock_reservations where request_id = $1', [made.id])).status, 'released', 'the reservation is released');
  eq((await mgr('manager', 'POST', `/requests/${made.id}/cancel`, {})).replayed, true, 'cancelling twice is harmless');
  await refuses(own('owner', 'POST', `/requests/${made.id}/dispatch`, {}), 409, 'not_dispatchable', null, 'a cancelled request can’t be dispatched');
  // a draft, edited and sent
  const draft = (await mgr('manager', 'POST', '/requests', { lines: [line(flour, 5)], submit: false })).request;
  eq(draft.status, 'draft', 'a draft');
  eq((await own('owner', 'GET', '/requests/inbox')).requests.some((x) => x.id === draft.id), false, 'the owner doesn’t see drafts');
  const edited = (await mgr('manager', 'PUT', `/requests/${draft.id}`, { lines: [line(flour, 2, 'sack')], note: 'two sacks', priority: 'low' })).request;
  eq([edited.lines[0].requested, edited.priority, edited.note], ['50000.0000', 'low', 'two sacks'], 'edited: 2 sacks of 25 kg');
  eq((await mgr('manager', 'POST', `/requests/${draft.id}/submit`, {})).request.status, 'submitted', 'sent');
  await mgr('manager', 'POST', `/requests/${draft.id}/cancel`, {});
}
function kgToG(n) { return `${(n * 1000).toFixed(4)}`; }

// ============================================================================================================
// Partial dispatch keeps the rest held; a second dispatch sends it; cancelling the remainder
// ============================================================================================================
{
  const made = (await mgr('manager', 'POST', '/requests', { lines: [line(flour, 30), line(rice, 10)] })).request;
  await own('owner', 'POST', `/requests/${made.id}/review`, { decision: 'approve' });
  const first = await own('owner', 'POST', `/requests/${made.id}/dispatch`, { lines: [{ itemId: flour, quantity: 10, unit: 'kg' }, { itemId: rice, quantity: 10, unit: 'kg' }] });
  eq(first.transfer.lines.map((l) => [l.name, l.quantity]), [['Flour', '10000.0000'], ['Rice', '10000.0000']], 'part of the flour and all the rice go');
  eq([(await bal(WH, flour)).reserved, (await bal(WH, rice)).reserved], ['20000.0000', '0.0000'], 'the unsent 20 kg of flour stays reserved');
  eq(first.request.hasRemainder, true, 'the request knows there is more to send');
  await refuses(own('owner', 'POST', `/requests/${made.id}/dispatch`, {}), 409, 'delivery_open', /is still on its way/, 'the rest can’t go while a delivery is open');
  await refuses(mgr('manager', 'POST', `/requests/${made.id}/cancel`, {}), 409, 'delivery_in_transit', null, 'and the request can’t be cancelled while goods are on the way');
  const got = await mgr('manager', 'POST', `/transfers/${first.transfer.id}/receive`, { lines: [{ itemId: flour, received: 10, unit: 'kg' }, { itemId: rice, received: 10, unit: 'kg' }] });
  eq([got.request.status, got.discrepanciesOpened.length], ['partially_received', 0], 'received: the request waits for the rest');
  await refuses(own('owner', 'POST', `/requests/${made.id}/dispatch`, { lines: [{ itemId: flour, quantity: 25, unit: 'kg' }] }), 409, 'dispatch_over_approved', /Only 20 kg .*of Flour is left to send/, 'not more than is left');
  const second = await own('owner', 'POST', `/requests/${made.id}/dispatch`, {});
  eq([second.transfer.ref, second.transfer.lines.map((l) => l.quantity), second.request.status], ['TRF-2026-0003', ['20000.0000'], 'dispatched'], 'the second dispatch sends the remaining 20 kg');
  eq((await bal(WH, flour)).reserved, '0.0000', 'and uses up the hold');
  const got2 = await mgr('manager', 'POST', `/transfers/${second.transfer.id}/receive`, { lines: [{ itemId: flour, received: 20, unit: 'kg' }] });
  eq(got2.request.status, 'completed', 'all received, no discrepancy: completed');
  eq((await bal(B1, flour)).onHand, '30000.0000', 'the branch has all 30 kg');
  await reconciled('after partial dispatches');

  // cancel the remainder of a partly sent request
  const m2 = (await mgr('manager', 'POST', '/requests', { lines: [line(flour, 20)] })).request;
  await own('owner', 'POST', `/requests/${m2.id}/review`, { decision: 'approve' });
  const part = await own('owner', 'POST', `/requests/${m2.id}/dispatch`, { lines: [{ itemId: flour, quantity: 5, unit: 'kg' }] });
  await mgr('manager', 'POST', `/transfers/${part.transfer.id}/receive`, { lines: [{ itemId: flour, received: 5, unit: 'kg' }] });
  eq((await bal(WH, flour)).reserved, '15000.0000', '15 kg still held for the remainder');
  const rest = await mgr('manager', 'POST', `/requests/${m2.id}/cancel`, { reason: 'Enough for now' });
  eq([rest.request.status, rest.released.map((x) => x.released)], ['completed', ['15000.0000']], 'cancelling after a partial dispatch releases only the remainder');
  eq((await bal(WH, flour)).reserved, '0.0000', 'nothing is held any more');
  await reconciled('after cancelling a remainder');
}

// ============================================================================================================
// Damaged, over-delivery within and beyond tolerance, partial receipts
// ============================================================================================================
{
  const sendRice = async (qty) => {
    const m = (await mgr('manager', 'POST', '/requests', { lines: [line(rice, qty)] })).request;
    await own('owner', 'POST', `/requests/${m.id}/review`, { decision: 'approve' });
    return (await own('owner', 'POST', `/requests/${m.id}/dispatch`, {})).transfer;
  };
  const t1 = await sendRice(10);
  const base = (await bal(B1, rice)).onHand;
  await refuses(mgr('manager', 'POST', `/transfers/${t1.id}/receive`, { lines: [{ itemId: rice, received: 8, damaged: 2, unit: 'kg' }] }), 400, 'note_required', null, 'damaged goods need a note');
  const d = await mgr('manager', 'POST', `/transfers/${t1.id}/receive`, { lines: [{ itemId: rice, received: 8, damaged: 2, unit: 'kg' }], note: 'Two bags torn' });
  eq(d.discrepanciesOpened.map((x) => [x.kind, x.quantity]), [['damaged', '2000.0000']], 'damaged is recorded');
  eq(Number((await bal(B1, rice)).onHand) - Number(base), 8000, 'and NOT added to the branch');
  eq(d.transfer.lines[0].outstanding, '0.0000', 'nothing is left outstanding');

  const t2 = await sendRice(10);
  const o = await mgr('manager', 'POST', `/transfers/${t2.id}/receive`, { lines: [{ itemId: rice, received: 10.4, unit: 'kg' }], note: 'Counted 10.4 kg' });
  eq(o.discrepanciesOpened.map((x) => [x.kind, x.quantity]), [['over', '400.0000']], 'over-delivery within 5 % is accepted and recorded as over');
  eq(o.transfer.lines[0].received, '10000.0000', 'the line keeps good = what was sent');
  eq((await one(`select delta::text as delta, reason from public.stock_movements where ref_id = $1 and reason = 'transfer_discrepancy'`, [t2.id])).delta, '400.0000', 'the extra is posted as a transfer_discrepancy');

  const t3 = await sendRice(10);
  const before = (await bal(B1, rice)).onHand;
  const e = await refuses(mgr('manager', 'POST', `/transfers/${t3.id}/receive`, { lines: [{ itemId: rice, received: 11, unit: 'kg' }], note: 'More than sent' }), 409, 'over_delivery_too_large', /over the 5% extra allowed/, 'beyond tolerance is refused');
  eq(e.details.allowed, '500.0000', 'with the allowed figure');
  eq((await bal(B1, rice)).onHand, before, 'nothing was posted');
  // a delivery that arrives in two parts
  const p1 = await mgr('manager', 'POST', `/transfers/${t3.id}/receive`, { lines: [{ itemId: rice, received: 6, unit: 'kg' }], final: false });
  eq([p1.transfer.status, p1.closed, p1.discrepanciesOpened.length, p1.transfer.lines[0].outstanding, p1.request.status], ['partially_received', false, 0, '4000.0000', 'partially_received'], 'a partial receipt keeps the rest expected');
  const p2 = await mgr('manager', 'POST', `/transfers/${t3.id}/receive`, { lines: [{ itemId: rice, received: 3, unit: 'kg' }], note: 'One bag never came' });
  eq([p2.transfer.status, p2.discrepanciesOpened.map((x) => [x.kind, x.quantity])], ['received', [['short', '1000.0000']]], 'the second part closes it; the 1 kg shortage is recorded');
  eq((await bal(B1, rice)).onHand, String((Number(before) + 9000).toFixed(4)), 'the branch got 6 + 3 kg');
  await reconciled('after damaged, over and partial receipts');
}

// ============================================================================================================
// Cancel a dispatch before the branch has counted anything
// ============================================================================================================
{
  const m = (await mgr('manager', 'POST', '/requests', { lines: [line(beef, 5)] })).request;
  await own('owner', 'POST', `/requests/${m.id}/review`, { decision: 'approve' });
  const whBefore = await bal(WH, beef);
  const sent = await own('owner', 'POST', `/requests/${m.id}/dispatch`, {});
  eq((await bal(WH, beef)).onHand, String((Number(whBefore.onHand) - 5000).toFixed(4)), 'sent');
  await refuses(mgr('manager', 'POST', `/transfers/${sent.transfer.id}/cancel`, {}), 409, 'not_cancellable', null, 'the branch can’t cancel a delivery that is on its way');
  await refuses(own('manager', 'POST', `/dispatches/${sent.transfer.id}/cancel`, {}), 403, 'forbidden', null, 'a branch manager can’t cancel a dispatch');
  const back = await own('owner', 'POST', `/dispatches/${sent.transfer.id}/cancel`, {});
  eq(back.transfer.status, 'cancelled', 'the dispatch is cancelled');
  const whAfter = await bal(WH, beef);
  eq([whAfter.onHand, whAfter.reserved], [whBefore.onHand, whBefore.reserved], 'the stock is back and the request holds it again (re-reserved)');
  eq((await own('owner', 'GET', `/requests/${m.id}`)).request.status, 'approved', 'the request is approved again, ready to dispatch');
  eq((await own('owner', 'POST', `/dispatches/${sent.transfer.id}/cancel`, {})).replayed, true, 'cancelling twice is harmless');
  await refuses(mgr('manager', 'POST', `/transfers/${sent.transfer.id}/receive`, { lines: [{ itemId: beef, received: 5, unit: 'kg' }] }), 409, 'not_receivable', /cancelled/, 'a cancelled delivery can’t be received');
  const again = await own('owner', 'POST', `/requests/${m.id}/dispatch`, {});
  eq([again.transfer.ref, again.transfer.id === sent.transfer.id], ['TRF-2026-0009', false], 'and it can be sent again (a new delivery, the next number)');
  await mgr('manager', 'POST', `/transfers/${again.transfer.id}/receive`, { lines: [{ itemId: beef, received: 5, unit: 'kg' }] });
  await reconciled('after cancel dispatch');
}

// ============================================================================================================
// Direct dispatch can't take stock held for requests
// ============================================================================================================
{
  const held = (await mgr('manager', 'POST', '/requests', { lines: [line(lamb, 8)] })).request;
  await receive(db, { businessId: biz, locationId: WH, itemId: lamb, qty: '10000', unitCost: '1' });
  await own('owner', 'POST', `/requests/${held.id}/review`, { decision: 'approve' });
  await refuses(own('owner', 'POST', '/dispatches', { branchId: branches.branch2.restaurantId, lines: [line(lamb, 5)] }), 409, 'stock_reserved', /free here/, 'only 2 kg is free, 8 kg is held for the request');
  const ok1 = await own('owner', 'POST', '/dispatches', { branchId: branches.branch2.restaurantId, lines: [line(lamb, 2)], note: 'Direct' });
  eq([ok1.transfer.requestId, ok1.transfer.toBranchId, ok1.transfer.direction], [null, branches.branch2.restaurantId, 'out'], 'a direct dispatch of the free 2 kg to branch 2');
  await refuses(mgr('manager', 'POST', `/transfers/${ok1.transfer.id}/receive`, { lines: [{ itemId: lamb, received: 2, unit: 'kg' }] }), 403, 'branch_forbidden', null, 'branch 1 can’t receive branch 2’s delivery');
  await mgr('manager2', 'POST', `/transfers/${ok1.transfer.id}/receive`, { lines: [{ itemId: lamb, received: 2, unit: 'kg' }] });
  eq((await bal(B2, lamb)).onHand, '2000.0000', 'branch 2 received it');
  await mgr('manager', 'POST', `/requests/${held.id}/cancel`, {});
  eq((await bal(WH, lamb)).reserved, '0.0000', 'cancelling frees the hold');
  await refuses(own('owner', 'POST', '/dispatches', { branchId: ids.branchId, lines: [line(lamb, 100)] }), 409, 'insufficient_stock', /left here/, 'and a dispatch can’t take more than is on hand');
}

// ============================================================================================================
// Suggestions
// ============================================================================================================
{
  await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, par) values ($1, $2, $3, 90000)`, [B2, flour, biz]);
  const s = await mgr('manager2', 'GET', '/requests/suggestions');
  eq(s.suggestions.map((x) => [x.name, x.suggested, x.available, x.incoming]), [['Flour', '100000.0000', '0.0000', '0.0000']], 'par 90 kg, nothing there: rounded up to 4 sacks = 100 kg');
  const asked = (await mgr('manager2', 'POST', '/requests', { lines: [line(flour, 4, 'sack')] })).request;
  eq((await mgr('manager2', 'GET', '/requests/suggestions')).suggestions, [], 'once asked for, it counts as incoming');
  await mgr('manager2', 'POST', `/requests/${asked.id}/cancel`, {});
  eq((await mgr('manager2', 'GET', '/requests/suggestions')).suggestions.length, 1, 'and is suggested again after cancelling');
}

// ============================================================================================================
// Returns to the Warehouse (P2-22)
// ============================================================================================================
{
  const b1Before = await bal(B1, beef);
  const whBefore = await bal(WH, beef);
  await refuses(mgr('manager', 'POST', '/returns', { lines: [line(beef, 3)] }), 400, 'reason_required', null, 'a reason is needed');
  const e = await refuses(mgr('manager', 'POST', '/returns', { lines: [line(beef, 500)], reason: 'Too much' }), 409, 'insufficient_available', /Only 19 kg .*of Beef can leave here/, 'more than the branch has is refused');
  eq(e.details.available, b1Before.available, 'with the available figure');
  const ret = await mgr('manager', 'POST', '/returns', { lines: [line(beef, 3)], reason: 'Over-ordered', driver: 'Mary' });
  eq([ret.transfer.direction, ret.transfer.status, ret.transfer.fromBranchId, ret.transfer.toName], ['return', 'in_transit', ids.branchId, 'Warehouse'], 'a return is dispatched at once');
  eq((await bal(B1, beef)).onHand, String((Number(b1Before.onHand) - 3000).toFixed(4)), 'the branch is down 3 kg');
  eq((await bal(WH, beef)).onHand, whBefore.onHand, 'the Warehouse hasn’t received it yet');
  eq((await notes(people.owner, 'delivery_incoming')).filter((n) => n.entity_id === ret.transfer.id).length, 1, 'the owner is told it is coming');
  await refuses(mgr('manager2', 'GET', `/transfers/${ret.transfer.id}`), 403, 'branch_forbidden', null, 'another branch can’t see it');
  await refuses(mgr('manager', 'POST', `/transfers/${ret.transfer.id}/receive`, { lines: [{ itemId: beef, received: 3, unit: 'kg' }] }), 403, 'branch_forbidden', null, 'the sending branch can’t receive its own return');
  const got = await own('owner', 'POST', `/dispatches/${ret.transfer.id}/receive`, { lines: [{ itemId: beef, received: 3, unit: 'kg' }] });
  eq(got.transfer.status, 'received', 'the Warehouse receives it');
  eq((await bal(WH, beef)).onHand, String((Number(whBefore.onHand) + 3000).toFixed(4)), 'the Warehouse is up 3 kg');
  eq((await one(`select unit_cost::text as cost from public.stock_movements where location_id = $1 and reason = 'transfer_receipt' and ref_id = $2`, [WH, ret.transfer.id])).cost, '0.500000', 'at the cost it left');
  eq((await mgr('manager', 'GET', '/transfers', undefined, '?direction=return')).transfers.length, 1, 'the branch history shows it');
  await reconciled('after a return');

  // with approval turned on
  await setSetting(db, { businessId: biz, key: 'returns_need_approval', value: true, actorId: people.owner });
  const waiting = await mgr('manager', 'POST', '/returns', { lines: [line(beef, 1)], reason: 'Spare' });
  eq([waiting.pendingApproval, waiting.transfer.status, waiting.transfer.awaitingApproval], [true, 'pending_approval', true], 'with returns_need_approval the return waits');
  await refuses(mgr('manager', 'POST', `/transfers/${waiting.transfer.id}/dispatch`, {}), 409, 'approval_required', /owner’s approval/, 'and can’t be sent yet');
  await mgr('manager', 'POST', `/transfers/${waiting.transfer.id}/cancel`, {});
  await setSetting(db, { businessId: biz, key: 'returns_need_approval', value: false, actorId: people.owner });
}

// ============================================================================================================
// Branch -> branch with the owner's approval (P2-22)
// ============================================================================================================
{
  const b1 = await bal(B1, beef);
  const asked = await mgr('manager', 'POST', '/branch-transfers', { toBranchId: branches.branch2.restaurantId, lines: [line(beef, 2)], note: 'Branch 2 ran out' });
  const tr = asked.transfer;
  eq([tr.direction, tr.status, tr.awaitingApproval, tr.fromBranchId, tr.toBranchId], ['branch_to_branch', 'pending_approval', true, ids.branchId, branches.branch2.restaurantId], 'pending the owner’s approval');
  const appr = await one(`select id, status, subject_type, location_id, approver_capability from public.approvals where subject_id = $1`, [tr.id]);
  eq([appr.status, appr.subject_type, appr.location_id, appr.approver_capability], ['pending', 'transfer', B1, 'inv.request.approve'], 'an approval row on the engine, at the source branch');
  eq((await bal(B1, beef)).reserved, '0.0000', 'nothing is reserved (D2-12)');
  await refuses(mgr('manager', 'POST', `/transfers/${tr.id}/dispatch`, {}), 409, 'approval_required', null, 'dispatch before approval is refused');
  await refuses(mgr('manager2', 'POST', `/transfers/${tr.id}/dispatch`, {}), 403, 'branch_forbidden', null, 'and the destination can’t send it');
  await refuses(decide('manager', appr.id, { decision: 'approve' }), 403, 'forbidden', null, 'a branch manager can’t approve');
  const inboxRows = (await run(approvalsApi, 'owner', 'GET', `/api/owner/inventory/${biz}/approvals`)).approvals;
  eq(inboxRows.filter((x) => x.subject === 'transfer').map((x) => [x.summary.kind, x.summary.from, x.summary.to, x.summary.lineCount]), [['transfer', 'Main branch', 'Second branch', 1]], 'it shows in the owner’s approvals inbox, with a summary line');
  eq((await notes(people.owner, 'branch_transfer_requested')).length, 1, 'the owner is told');
  const ok2 = await decide('owner', appr.id, { decision: 'approve' });
  eq(ok2.status, 'approved', 'approved by the owner');
  const view = (await own('owner', 'GET', `/dispatches/${tr.id}`)).transfer;
  eq([view.awaitingApproval, view.awaitingDispatch, view.approval.status], [false, true, 'approved'], 'now it waits for the source to send');
  const sent = await mgr('manager', 'POST', `/transfers/${tr.id}/dispatch`, { driver: 'Peter' });
  eq([sent.transfer.status, sent.transfer.deliveryNote.driver], ['in_transit', 'Peter'], 'the source branch sends it');
  eq((await bal(B1, beef)).onHand, String((Number(b1.onHand) - 2000).toFixed(4)), 'the source is down 2 kg');
  eq((await mgr('manager', 'POST', `/transfers/${tr.id}/dispatch`, {})).replayed, true, 'sending twice does nothing more');
  await refuses(mgr('manager', 'POST', `/transfers/${tr.id}/receive`, { lines: [{ itemId: beef, received: 2, unit: 'kg' }] }), 403, 'branch_forbidden', null, 'the source can’t receive it');
  await refuses(mgr('manager', 'GET', `/receive/${sent.transfer.code}`), 403, 'forbidden', null, 'the code only works at the destination');
  const dest = await mgr('manager2', 'GET', `/receive/${sent.transfer.code}`);
  eq(dest.transfer.id, tr.id, 'the destination manager finds it by code');
  eq((await mgr('manager2', 'POST', `/receive/${sent.transfer.code}`, { lines: [{ itemId: beef, received: 2, unit: 'kg' }] })).transfer.status, 'received', 'and receives it by code');
  eq((await bal(B2, beef)).onHand, '2000.0000', 'branch 2 is up 2 kg');
  eq([(await mgr('manager', 'GET', '/transfers', undefined, '?direction=branch_to_branch')).transfers.length, (await mgr('manager2', 'GET', '/transfers', undefined, '?direction=branch_to_branch')).transfers.length], [1, 1], 'both branches’ histories show it');
  await reconciled('after a branch to branch transfer');

  // maker-checker: the owner asks, another owner exists, so the owner can't approve their own
  const mine = (await own('owner', 'POST', '/branch-transfers', { fromBranchId: ids.branchId, toBranchId: branches.branch2.restaurantId, lines: [line(beef, 1)] })).transfer;
  const a2 = await one(`select id from public.approvals where subject_id = $1`, [mine.id]);
  await refuses(decide('owner', a2.id, { decision: 'approve' }), 403, 'maker_checker', null, 'the owner can’t approve their own request while another owner exists');
  eq((await decide('owner2', a2.id, { decision: 'reject', note: 'Not now' })).status, 'rejected', 'the other owner rejects it');
  eq((await own('owner', 'GET', `/dispatches/${mine.id}`)).transfer.status, 'cancelled', 'a rejected transfer is cancelled');
  // switched off
  await setSetting(db, { businessId: biz, key: 'branch_to_branch_enabled', value: false, actorId: people.owner });
  await refuses(mgr('manager', 'POST', '/branch-transfers', { toBranchId: branches.branch2.restaurantId, lines: [line(beef, 1)] }), 409, 'branch_to_branch_disabled', /switched off/, 'off by the owner');
  await setSetting(db, { businessId: biz, key: 'branch_to_branch_enabled', value: true, actorId: people.owner });
  await refuses(mgr('manager', 'POST', '/branch-transfers', { toBranchId: ids.branchId, lines: [line(beef, 1)] }), 400, 'same_branch', null, 'two different branches');
}

// ============================================================================================================
// Branch -> branch can't take stock held for open orders (respectHeld)
// ============================================================================================================
{
  const sc = await scopeOf('owner');
  await db.transaction((t) => recipes.saveRecipe(t, sc, ids.burgerId, { lines: [{ itemId: beef, quantity: 200, unit: 'g' }] }));
  const b1 = await ledger.availability(db, B1, beef);
  const onHand = Number(b1.onHand);
  // enough open orders that 1 kg beyond what's free would dig into the held part
  const burgers = Math.floor((onHand - 1000) / 200) + 0;
  await helpers.order([{ itemId: ids.burgerId, name: 'Chicken burger', quantity: burgers }]);
  const a = await ledger.availability(db, B1, beef);
  ok(Number(a.held) > 0 && Number(a.available) < onHand, 'open orders hold some of the branch’s beef');
  const asked = await mgr('manager', 'POST', '/branch-transfers', { toBranchId: branches.branch2.restaurantId, lines: [line(beef, (Number(a.available) + 500) / 1000, 'kg')] });
  const appr = await one(`select id from public.approvals where subject_id = $1`, [asked.transfer.id]);
  await decide('owner', appr.id, { decision: 'approve' });
  const e = await refuses(mgr('manager', 'POST', `/transfers/${asked.transfer.id}/dispatch`, {}), 409, 'insufficient_available', /held for open orders/, 'the source can’t send stock a waiter could sell');
  eq(e.details.available, a.available, 'the message carries what can leave');
  eq((await bal(B1, beef)).onHand, a.onHand, 'nothing left the branch');
  await mgr('manager', 'POST', `/transfers/${asked.transfer.id}/cancel`, {});
  eq((await own('owner', 'GET', `/dispatches/${asked.transfer.id}`)).transfer.status, 'cancelled', 'the transfer can be withdrawn');
  eq((await one(`select status from public.approvals where subject_id = $1`, [asked.transfer.id])).status, 'approved', 'the approval row keeps its history');
}

// ============================================================================================================
// 009 requests adopted by the new engine
// ============================================================================================================
{
  await db.query(`select 1`);
  const mutton = await makeItem(db, biz, 'Mutton');
  await receive(db, { businessId: biz, locationId: WH, itemId: mutton, qty: '8000', unitCost: '2' });
  const legacyScope = { businessId: biz, restaurantId: ids.branchId, actorId: people.manager };
  const submitLegacy = (qty) => db.transaction((t) => legacy.submitRequest(t, legacyScope, { lines: [{ itemId: mutton, quantity: qty }] }));
  const reviewLegacy = (id) => db.transaction((t) => legacy.reviewRequest(t, { businessId: biz, actorId: people.owner }, id, { decision: 'approve' }));
  const l1 = await submitLegacy(6000);
  const l2 = await submitLegacy(6000);
  await reviewLegacy(l1.id); await reviewLegacy(l2.id);
  eq((await bal(WH, mutton)).reserved, '0.0000', 'main’s flow holds nothing');
  eq((await one('select from_location, to_location from public.stock_requests where id = $1', [l1.id])).from_location, null, 'and leaves the new columns empty');
  const inbox = await own('owner', 'GET', '/requests/inbox');
  const b = await bal(WH, mutton);
  eq([b.reserved, b.available], ['8000.0000', '0.0000'], 'first touch: the oldest request holds 6 kg, the next gets the remaining 2 kg');
  const rows = await q(`select r.request_id, r.qty_reserved::text as qty from public.stock_reservations r where r.item_id = $1 order by r.created_at, r.qty_reserved desc`, [mutton]);
  eq(rows.map((x) => [x.request_id, x.qty]), [[l1.id, '6000.0000'], [l2.id, '2000.0000']], 'oldest first');
  eq(inbox.needsAttention.map((x) => x.id), [l2.id], 'the short one is flagged needs_attention, the first isn’t');
  eq([(await one('select needs_attention, status from public.stock_requests where id = $1', [l2.id])).needs_attention, (await one('select approved::text as a from public.stock_request_lines where request_id = $1', [l2.id])).a], [true, '6000.0000'], 'never silently shortened: approved is untouched');
  eq((await notes(people.owner, 'reservation_attention')).length, 1, 'the owner is told once');
  await own('owner', 'GET', '/requests/inbox'); await own('owner', 'GET', '/requests/inbox');
  eq([(await bal(WH, mutton)).reserved, (await q('select 1 from public.stock_reservations where item_id = $1', [mutton])).length, (await notes(people.owner, 'reservation_attention')).length], ['8000.0000', 2, 1], 'adopting again changes nothing');
  eq((await one('select from_location from public.stock_requests where id = $1', [l1.id])).from_location, WH, 'the locations were filled in');
  const sent = await own('owner', 'POST', `/requests/${l1.id}/dispatch`, {});
  eq([sent.transfer.lines[0].quantity, (await bal(WH, mutton)).reserved, (await bal(WH, mutton)).onHand], ['6000.0000', '2000.0000', '2000.0000'], 'the first dispatches, using its hold');
  await refuses(own('owner', 'POST', `/requests/${l2.id}/dispatch`, {}), 409, 'insufficient_stock', /left here/, 'the short one can’t be sent until stock arrives');
  const got = await mgr('manager', 'POST', `/transfers/${sent.transfer.id}/receive`, { lines: [{ itemId: mutton, received: 6, unit: 'g' }] }).catch((e) => e);
  ok(got instanceof Error, 'the unit is the typed one: 6 g is far short of 6000 g and needs a note');
  await mgr('manager', 'POST', `/transfers/${sent.transfer.id}/receive`, { lines: [{ itemId: mutton, received: 6000, unit: 'g' }] });
  await receive(db, { businessId: biz, locationId: WH, itemId: mutton, qty: '4000', unitCost: '2' });
  eq((await own('owner', 'POST', `/requests/${l2.id}/dispatch`, {})).transfer.lines[0].quantity, '6000.0000', 'after a delivery the rest can go');

  // a 009 dispatch received by the new engine
  await receive(db, { businessId: biz, locationId: WH, itemId: mutton, qty: '3000', unitCost: '2' });
  const l3 = await submitLegacy(1000);
  await reviewLegacy(l3.id);
  const legacySent = await db.transaction((t) => legacy.dispatch(t, { businessId: biz, actorId: people.owner }, { requestId: l3.id }));
  eq((await one('select status from public.stock_transfers where id = $1', [legacySent.id])).status, 'in_transit', 'main’s dispatch is in transit');
  const view = (await mgr('manager', 'GET', `/receive/${legacySent.code}`)).transfer;
  eq([view.direction, view.lines[0].quantity, view.requestRef !== null], ['out', '1000.0000', true], 'the new engine sees it');
  const rcv = await mgr('manager', 'POST', `/receive/${legacySent.code}`, { lines: [{ itemId: mutton, received: 1000, unit: 'g' }] });
  eq([rcv.transfer.status, rcv.request.status], ['received', 'completed'], 'and receives it');
  eq((await bal(B1, mutton)).onHand, '7000.0000', 'the branch has what came (6000 + 1000)');
  await reconciled('after adopting legacy requests');
}

// ---- audit and validation ----
{
  eq((await q(`select distinct action from public.inventory_events where entity = 'stock_request' order by action`)).map((x) => x.action).filter((a) => ['submit', 'approve_partial', 'cancel', 'adopt_legacy', 'prepare'].includes(a)), ['adopt_legacy', 'approve_partial', 'cancel', 'prepare', 'submit'], 'request actions are audited');
  eq((await q(`select distinct action from public.inventory_events where entity = 'transfer' order by action`)).map((x) => x.action).filter((a) => ['dispatch', 'receive', 'cancel_dispatch', 'approve', 'request'].includes(a)), ['approve', 'cancel_dispatch', 'dispatch', 'receive', 'request'], 'transfer actions are audited');
  await refuses(mgr('manager', 'POST', '/requests', { lines: [] }), 400, 'lines_required', /at least one item/, 'a request needs lines');
  await refuses(mgr('manager', 'POST', '/requests', { lines: [line(beef, 1), line(beef, 2)] }), 400, 'duplicate_item', /once/, 'each item once');
  await refuses(mgr('manager', 'POST', '/requests', { lines: [line(beef, 0)] }), 400, 'zero_quantity', null, 'a zero amount');
  await refuses(mgr('manager', 'POST', '/requests', { lines: [line(beef, 1, 'l')] }), 400, 'unit_mismatch', null, 'a unit of the wrong kind');
  await refuses(mgr('manager', 'POST', '/requests', { lines: [line(beef, 1)], priority: 'asap' }), 400, 'bad_priority', null, 'a priority');
  await refuses(mgr('manager', 'POST', '/requests', { lines: [line(uuid(), 1)] }), 404, 'item_not_found', null, 'an unknown item');
  await reconciled('at the end');
}

console.log(`Distribution: ${count()} checks passed.`);
