// Discrepancy review (P2-23). Real services and route handlers on an in-memory database with every proposed migration applied. No network.
// Covers T-REQ-2 follow-through: dispatch 15 kg, receive 14 -> sender -15, receiver +14, the missing 1 kg already out of every on-hand figure, so
//   * write_off with each bearer posts NO stock movement and records the loss value (carried unit cost) against that bearer;
//   * arrived_later posts one transfer_receipt at the receiver, returned_to_source one transfer_discrepancy at the sender (whole or in part);
//   * damaged can only be written off; over can be accepted (no movement), taken off the sender, or taken back off the receiver;
//   * never two stock changes for the same units, cannot resolve twice, settleRequest completes the request, permissions, lists/filters, notifications, reconcile clean.
// Usage: node backend/tests/inv/discrepancies.test.js
import { rig } from './fixture.js';
import { makeAsserts, makeItem, receive } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-distribution.js';
import { setSetting } from '../../src/inventory/policies.js';
import * as ledger from '../../src/inventory/ledger.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, contexts } = r;
const biz = ids.businessId;
const WH = ids.centerLocationId;
const B1 = branches.branch1.locationId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
  return contexts[who];
};
const api = createRoutes({ authenticate, pool: () => db, transact: (fn) => db.transaction(fn) });
const run = async (as, method, pathname, body, query = '', branch = null) => {
  for (const route of api) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    const headers = { authorization: `Bearer ${as}` };
    if (branch) headers['x-cravio-branch'] = branch;
    return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const BR = { manager: ids.branchId, manager2: branches.branch2.restaurantId, waiter: ids.branchId, ops: ids.branchId };
const mgr = (who, method, suffix, body, query) => run(who, method, `/api/inventory${suffix}`, body, query, BR[who]);
const own = (who, method, suffix, body, query) => run(who, method, `/api/owner/inventory/${biz}${suffix}`, body, query);
const bal = (loc, item) => ledger.balance(db, loc, item);
const reconciled = async (m) => eq(await ledger.reconcile(db, { businessId: biz }), [], `reconciliation is clean: ${m}`);
const notes = (user, kind) => q('select * from public.notifications where recipient_id = $1 and kind = $2 order by created_at', [user, kind]);
const moves = (discId) => q(`select reason, location_id, delta::text as delta, unit_cost::text as cost from public.stock_movements where ref_type = 'discrepancy' and ref_id = $1`, [discId]);
const line = (itemId, quantity, unit = 'kg') => ({ itemId, quantity, unit });

const beef = await makeItem(db, biz, 'Beef');
const lamb = await makeItem(db, biz, 'Lamb');
await receive(db, { businessId: biz, locationId: WH, itemId: beef, qty: '200000', unitCost: '0.5' });
await receive(db, { businessId: biz, locationId: WH, itemId: lamb, qty: '200000', unitCost: '1' });

/** A request approved, dispatched and received with `got` kg of `item` (asked = sent). Returns the open discrepancies of that delivery. */
async function delivery(item, sent, got, { damaged = 0, over = 0, note = 'Count differs', viaRequest = true } = {}) {
  let t;
  let request = null;
  if (viaRequest) {
    request = (await mgr('manager', 'POST', '/requests', { lines: [line(item, sent)] })).request;
    await own('owner', 'POST', `/requests/${request.id}/review`, { decision: 'approve' });
    t = (await own('owner', 'POST', `/requests/${request.id}/dispatch`, {})).transfer;
  } else {
    t = (await own('owner', 'POST', '/dispatches', { branchId: ids.branchId, lines: [line(item, sent)] })).transfer;
  }
  const done = await mgr('manager', 'POST', `/transfers/${t.id}/receive`, { lines: [{ itemId: item, received: got, damaged, over, unit: 'kg' }], note });
  return { request, transfer: t, opened: done.discrepanciesOpened };
}
const resolveIt = (id, body, as = 'owner') => own(as, 'POST', `/discrepancies/${id}/resolve`, body);

// ============================================================================================================
// T-REQ-2: sent 15, received 14. The 1 kg is already out of every balance, so a write-off moves no stock.
// ============================================================================================================
const d1 = await delivery(beef, 15, 14, { note: 'One bag split open' });
const disc1 = d1.opened[0];
eq([disc1.kind, disc1.quantity, disc1.valueKes], ['short', '1000.0000', '500.00'], 'a 1 kg short, valued at the carried cost');
{
  const whBefore = (await bal(WH, beef)).onHand;
  const b1Before = (await bal(B1, beef)).onHand;
  eq([whBefore, b1Before], ['185000.0000', '14000.0000'], 'Warehouse -15 kg, branch +14 kg: the missing kg is out of both');
  const movementsBefore = (await q('select count(*)::int as n from public.stock_movements'))[0].n;

  // owner sees it in the list; branch sees it read only
  const list = await own('owner', 'GET', '/discrepancies');
  eq([list.discrepancies.length, list.summary.open, list.summary.openValueKes], [1, 1, '500.00'], 'the owner’s open list and total');
  eq(list.discrepancies[0].choices, ['write_off', 'arrived_later', 'returned_to_source'], 'a short can be written off, found, or put back on the sender');
  eq((await mgr('manager', 'GET', '/discrepancies')).discrepancies.map((x) => x.id), [disc1.id], 'the branch manager sees it too');

  await refuses(resolveIt(disc1.id, { resolution: 'write_off', note: 'x' }), 400, 'bearer_required', /who bears/, 'a bearer is required');
  await refuses(resolveIt(disc1.id, { bearer: 'carrier', note: 'x' }), 400, 'resolution_required', null, 'a resolution is required');
  await refuses(resolveIt(disc1.id, { bearer: 'carrier', resolution: 'write_off' }), 400, 'note_required', null, 'a note is required');
  await refuses(resolveIt(disc1.id, { bearer: 'nobody', resolution: 'write_off', note: 'x' }), 400, 'bearer_required', null, 'bearer must be one of the three');
  await refuses(resolveIt(disc1.id, { bearer: 'carrier', resolution: 'source_deducts', note: 'x' }), 400, 'resolution_not_allowed', /short difference can be resolved as/, 'source_deducts is only for extra goods');
  await refuses(resolveIt(disc1.id, { bearer: 'carrier', resolution: 'write_off', note: 'x' }, 'manager'), 403, 'forbidden', null, 'a branch manager cannot resolve');
  await refuses(resolveIt(disc1.id, { bearer: 'carrier', resolution: 'write_off', note: 'x' }, 'ops'), 403, 'forbidden', null, 'operations cannot resolve unless allowed to approve');
  await refuses(mgr('manager2', 'GET', `/discrepancies/${disc1.id}`), 403, 'branch_forbidden', null, 'another branch’s manager cannot read it');
  eq((await q(`select 1 from public.inventory_events where action = 'denied' and entity = 'discrepancy'`)).length >= 1, true, 'that refusal is audited');

  const res = await resolveIt(disc1.id, { bearer: 'carrier', resolution: 'write_off', note: 'Driver confirmed the box was short', commandId: crypto.randomUUID() });
  eq([res.discrepancy.status, res.discrepancy.bearer, res.discrepancy.resolution, res.discrepancy.lossKes, res.movement], ['resolved', 'carrier', 'write_off', '500.00', null], 'write_off with the carrier bearing it: loss recorded, no movement');
  eq([(await bal(WH, beef)).onHand, (await bal(B1, beef)).onHand], [whBefore, b1Before], 'no stock changed anywhere');
  eq((await q('select count(*)::int as n from public.stock_movements'))[0].n, movementsBefore, 'not a single movement was posted');
  eq((await moves(disc1.id)).length, 0, 'no movement refers to the discrepancy');
  eq(res.requestSettled, true, 'settleRequest ran');
  eq((await own('owner', 'GET', `/requests/${d1.request.id}`)).request.status, 'completed', 'with nothing open the request is completed');
  await refuses(resolveIt(disc1.id, { bearer: 'source', resolution: 'write_off', note: 'again' }), 409, 'already_resolved', /already resolved/, 'it cannot be resolved twice');
  const after = await own('owner', 'GET', '/discrepancies', undefined, '?status=all');
  eq(after.summary.lossKesByBearer, { carrier: '500.00', source: '0.00', destination: '0.00' }, 'the loss is reported against the carrier');
  eq((await own('owner', 'GET', '/discrepancies')).discrepancies, [], 'nothing is open any more');
  eq((await mgr('manager', 'GET', '/discrepancies', undefined, '?status=resolved')).discrepancies[0].resolutionNote, 'Driver confirmed the box was short', 'the branch sees how it was resolved');
  await reconciled('after a write-off');
}

// each bearer: the loss lands on the chosen bearer, stock never moves
for (const bearer of ['source', 'destination']) {
  const d = await delivery(lamb, 5, 4, { note: `short ${bearer}` });
  const snap = [(await bal(WH, lamb)).onHand, (await bal(B1, lamb)).onHand];
  const res = await resolveIt(d.opened[0].id, { bearer, resolution: 'write_off', note: `borne by ${bearer}` });
  eq([res.discrepancy.bearer, res.discrepancy.lossKes], [bearer, '1000.00'], `${bearer} bears KES 1,000`);
  eq([(await bal(WH, lamb)).onHand, (await bal(B1, lamb)).onHand], snap, `${bearer}: no stock change`);
}
{
  const s = (await own('owner', 'GET', '/discrepancies', undefined, '?status=resolved')).summary.lossKesByBearer;
  eq(s, { carrier: '500.00', source: '1000.00', destination: '1000.00' }, 'the report splits the losses by bearer');
  await reconciled('after write-offs with each bearer');
}

// ============================================================================================================
// found later: the goods turn up
// ============================================================================================================
{
  const d = await delivery(beef, 10, 8, { note: 'Two kilos missing' });
  const x = d.opened[0];
  const b1 = (await bal(B1, beef)).onHand;
  const wh = (await bal(WH, beef)).onHand;
  await refuses(resolveIt(x.id, { bearer: 'carrier', resolution: 'arrived_later', quantity: '3000', note: 'x' }), 400, 'quantity_too_large', null, 'more than is missing is refused');
  await refuses(resolveIt(x.id, { bearer: 'carrier', resolution: 'write_off', quantity: '1000', note: 'x' }), 400, 'partial_not_allowed', null, 'a write-off is never partial');
  // part turns up: 1 kg of the 2 kg missing
  const part = await resolveIt(x.id, { bearer: 'carrier', resolution: 'arrived_later', quantity: '1000', note: 'Found in the van' });
  eq([part.discrepancy.quantity, part.discrepancy.status, part.discrepancy.valueKes, part.movement.reason, part.movement.delta], ['1000.0000', 'resolved', '500.00', 'transfer_receipt', '1000.0000'], 'the found 1 kg is a resolved row with a receipt');
  eq([part.remaining.id, part.remaining.status, part.remaining.quantity, part.remaining.valueKes], [x.id, 'open', '1000.0000', '500.00'], 'the other 1 kg stays open on the original row');
  eq([(await bal(B1, beef)).onHand, (await bal(WH, beef)).onHand], [String(Number(b1) + 1000).replace(/$/, '.0000'), wh], 'branch +1 kg, Warehouse unchanged');
  const mv = await moves(part.discrepancy.id);
  eq([mv.length, mv[0].reason, mv[0].location_id, mv[0].cost], [1, 'transfer_receipt', B1, '0.500000'], 'one receipt at the receiver at the carried cost');
  eq(part.requestSettled, false, 'the request still has an open discrepancy');
  // the rest turns up too
  const rest = await resolveIt(x.id, { bearer: 'carrier', resolution: 'arrived_later', note: 'Found the rest' });
  eq([rest.movement.reason, rest.movement.delta, rest.requestSettled], ['transfer_receipt', '1000.0000', true], 'the rest arrives: another single receipt, request settled');
  eq((await moves(x.id)).length, 1, 'one movement on this row');
  eq((await bal(B1, beef)).onHand, String(Number(b1) + 2000).replace(/$/, '.0000'), 'branch got all 2 kg back in total');
  eq((await own('owner', 'GET', `/requests/${d.request.id}`)).request.status, 'completed', 'completed');
  await reconciled('after found-later in two parts');
}

// returned to source: it never really left the Warehouse
{
  const d = await delivery(lamb, 6, 5, { note: 'Over-picked' });
  const wh = (await bal(WH, lamb)).onHand;
  const res = await resolveIt(d.opened[0].id, { bearer: 'source', resolution: 'returned_to_source', note: 'Still on the Warehouse shelf' });
  eq([res.movement.reason, res.movement.locationId, res.movement.delta], ['transfer_discrepancy', WH, '1000.0000'], 'one movement: +1 kg at the sender');
  eq((await bal(WH, lamb)).onHand, String(Number(wh) + 1000).replace(/$/, '.0000'), 'the Warehouse count goes back up');
  await reconciled('after returned_to_source');
}

// ============================================================================================================
// damaged: already out of both books, write-off only
// ============================================================================================================
{
  const d = await delivery(beef, 4, 3, { damaged: 1, note: 'Spoiled in transit' });
  const dm = d.opened.find((x) => x.kind === 'damaged');
  eq([d.opened.length, dm.quantity], [1, '1000.0000'], 'one damaged difference');
  await refuses(resolveIt(dm.id, { bearer: 'carrier', resolution: 'arrived_later', note: 'x' }), 400, 'resolution_not_allowed', null, 'damaged goods can’t "arrive later"');
  const snap = [(await bal(WH, beef)).onHand, (await bal(B1, beef)).onHand];
  const res = await resolveIt(dm.id, { bearer: 'carrier', resolution: 'write_off', note: 'Cold chain broke' });
  eq([res.discrepancy.lossKes, res.movement, (await bal(WH, beef)).onHand, (await bal(B1, beef)).onHand], ['500.00', null, snap[0], snap[1]], 'a damaged write-off is a recorded loss only');
  await reconciled('after a damaged write-off');
}

// ============================================================================================================
// over-delivery: confirm or reverse
// ============================================================================================================
{
  // accepted as extra stock: nothing changes
  const a = await delivery(beef, 10, 10, { over: 0.4, note: 'Butcher added a piece', viaRequest: false });
  const x = a.opened.find((d) => d.kind === 'over');
  eq(x.quantity, '400.0000', 'an over of 400 g (within 5 %)');
  eq((await own('owner', 'GET', `/discrepancies/${x.id}`)).discrepancy.choices, ['write_off', 'source_deducts', 'returned_to_source'], 'an over offers accept, take off the sender, take back');
  await refuses(resolveIt(x.id, { bearer: 'source', resolution: 'arrived_later', note: 'x' }), 400, 'resolution_not_allowed', null, 'found-later makes no sense for extra goods');
  const snap = [(await bal(WH, beef)).onHand, (await bal(B1, beef)).onHand];
  const res = await resolveIt(x.id, { bearer: 'destination', resolution: 'write_off', note: 'Keep it' });
  eq([res.movement, res.discrepancy.lossKes, (await bal(WH, beef)).onHand, (await bal(B1, beef)).onHand], [null, null, snap[0], snap[1]], 'accepted: no movement, no loss counted');
}
{
  // source_deducts: the extra really came out of the Warehouse shelf
  const a = await delivery(beef, 10, 10, { over: 0.4, note: 'Extra piece', viaRequest: false });
  const x = a.opened.find((d) => d.kind === 'over');
  const wh = Number((await bal(WH, beef)).onHand);
  const b1 = (await bal(B1, beef)).onHand;
  const res = await resolveIt(x.id, { bearer: 'source', resolution: 'source_deducts', note: 'Counted the shelf, it is down' });
  eq([res.movement.reason, res.movement.locationId, res.movement.delta], ['transfer_discrepancy', WH, '-400.0000'], 'one movement: -400 g at the sender');
  eq([Number((await bal(WH, beef)).onHand), (await bal(B1, beef)).onHand], [wh - 400, b1], 'the sender is corrected, the receiver keeps the extra');
  await reconciled('after source_deducts');
}
{
  // returned_to_source on an over: the extra goes back off the receiver; the sender never lost it
  const a = await delivery(beef, 10, 10, { over: 0.3, note: 'Extra piece', viaRequest: false });
  const x = a.opened.find((d) => d.kind === 'over');
  const wh = (await bal(WH, beef)).onHand;
  const b1 = Number((await bal(B1, beef)).onHand);
  const res = await resolveIt(x.id, { bearer: 'carrier', resolution: 'returned_to_source', note: 'Sent the piece back' });
  eq([res.movement.reason, res.movement.locationId, res.movement.delta], ['transfer_discrepancy', B1, '-300.0000'], 'one movement: -300 g at the receiver');
  eq([(await bal(WH, beef)).onHand, Number((await bal(B1, beef)).onHand)], [wh, b1 - 300], 'the sender was never short, so it is untouched');
  await reconciled('after reversing an over');
}
{
  // source_deducts refused when the sender has not got it free: nothing is resolved, nothing is posted
  const a = await delivery(beef, 10, 10, { over: 0.2, note: 'Extra piece', viaRequest: false });
  const x = a.opened.find((d) => d.kind === 'over');
  const free = (await bal(WH, beef)).onHand;
  await db.transaction((t) => ledger.post(t, { businessId: biz, locationId: WH, itemId: beef, qty: `-${free}`, reason: 'adjustment_loss', idempotencyKey: 'drain-beef' }));
  const left = (await bal(WH, beef)).onHand;
  if (Number(left) === 0) {
    await refuses(resolveIt(x.id, { bearer: 'source', resolution: 'source_deducts', note: 'x' }), 409, 'insufficient_stock', /Only 0 .*left here/, 'the sender cannot go below zero');
    eq((await one('select status from public.transfer_discrepancies where id = $1', [x.id])).status, 'open', 'and the discrepancy stays open');
    eq((await moves(x.id)).length, 0, 'with no movement');
    await receive(db, { businessId: biz, locationId: WH, itemId: beef, qty: '100000', unitCost: '0.5' });
    ok(true, 're-stocked for the next checks');
  } else {
    ok(false, `could not drain the Warehouse (left ${left})`);
  }
  await reconciled('after a refused source_deducts');
}

// ============================================================================================================
// lists, filters, permissions, notifications
// ============================================================================================================
{
  const d = await delivery(lamb, 8, 7, { note: 'Short' });
  const x = d.opened[0];
  const list = await own('owner', 'GET', '/discrepancies', undefined, `?branchId=${ids.branchId}&kind=short`);
  eq(list.discrepancies.map((y) => y.id), [x.id], 'filter by branch and kind');
  eq((await own('owner', 'GET', '/discrepancies', undefined, `?branchId=${branches.branch2.restaurantId}`)).discrepancies, [], 'another branch has none');
  eq((await own('owner', 'GET', '/discrepancies', undefined, '?from=2999-01-01')).discrepancies, [], 'a date range in the future is empty');
  eq((await own('owner', 'GET', '/discrepancies', undefined, '?from=2000-01-01&to=2999-01-01')).discrepancies.length, 2, 'and a wide one finds it (this one and the over left open above)');
  await refuses(own('owner', 'GET', '/discrepancies', undefined, '?from=yesterday'), 400, 'bad_date', null, 'bad dates are refused');
  await refuses(own('owner', 'GET', '/discrepancies', undefined, '?status=soon'), 400, 'bad_status', null, 'bad status');
  eq((await mgr('manager2', 'GET', '/discrepancies')).discrepancies, [], 'the other branch’s manager sees none');
  eq((await own('ops', 'GET', '/discrepancies')).discrepancies.length, 2, 'operations can read (their branch)');

  // operations may resolve only when the business lets them approve
  await setSetting(db, { businessId: biz, key: 'operations_can_approve', value: true, actorId: people.owner });
  const opsCtx = r.helpers.ctx(people.ops, { grants: [{ businessId: biz, role: 'operations', branchIds: [ids.branchId] }] });
  contexts.ops = opsCtx;
  const before = (await notes(people.owner2, 'discrepancy_resolved')).length;
  const cmd = crypto.randomUUID();
  const res = await resolveIt(x.id, { bearer: 'source', resolution: 'write_off', note: 'Operations signs off', commandId: cmd }, 'ops');
  eq(res.discrepancy.status, 'resolved', 'operations can resolve when allowed to approve');
  eq((await resolveIt(x.id, { bearer: 'source', resolution: 'write_off', note: 'Operations signs off', commandId: cmd }, 'ops')).discrepancy.id, res.discrepancy.id, 'a replay with the same commandId returns the same result');
  eq((await notes(people.owner2, 'discrepancy_resolved')).length - before, 1, 'the other owner is told, once');
  eq((await notes(people.manager, 'discrepancy_resolved')).filter((n) => n.entity_id === res.discrepancy.id).length, 1, 'and the branch manager, once');
  const n = (await notes(people.manager, 'discrepancy_resolved')).at(-1);
  eq(n.link, `/branch/${ids.branchId}/inventory/requests`, 'the branch link matches the frontend route');
  ok(/borne by the sender/i.test(n.body), 'says who bears it, in words');
  eq((await notes(people.owner2, 'discrepancy_resolved')).at(-1).link, '/owner/inventory/requests?tab=problems', 'the owner link opens the problems tab');
  eq((await notes(people.manager2, 'discrepancy_resolved')).length, 0, 'an uninvolved branch is not told');
  eq((await q(`select count(*)::int as n from public.stock_movements where ref_type = 'discrepancy' and ref_id = $1`, [x.id]))[0].n, 0, 'the replay posted nothing');
  eq((await q(`select action from public.inventory_events where entity = 'discrepancy' and entity_id = $1`, [x.id])).map((e) => e.action), ['resolve'], 'the resolution is audited once');
  await reconciled('at the end');
}

// request that is only partly received stays open after a resolution
{
  const request = (await mgr('manager', 'POST', '/requests', { lines: [line(beef, 10)] })).request;
  await own('owner', 'POST', `/requests/${request.id}/review`, { decision: 'approve', lines: [{ itemId: beef, approved: 10, unit: 'kg' }] });
  const t1 = (await own('owner', 'POST', `/requests/${request.id}/dispatch`, { lines: [line(beef, 4)] })).transfer;
  const got = await mgr('manager', 'POST', `/transfers/${t1.id}/receive`, { lines: [{ itemId: beef, received: 3, unit: 'kg' }], note: 'One short' });
  const res = await resolveIt(got.discrepanciesOpened[0].id, { bearer: 'carrier', resolution: 'write_off', note: 'Lost' });
  eq([res.requestSettled, (await own('owner', 'GET', `/requests/${request.id}`)).request.status], [false, 'partially_received'], 'a request with 6 kg still to send is not completed by a resolution');
  await reconciled('final');
}

console.log(`Discrepancies: ${count()} checks passed.`);
