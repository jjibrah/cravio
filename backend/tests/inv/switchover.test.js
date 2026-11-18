// Switch-over of the 009 flow (P2-25). The REAL handlers of routes/stock-flow.js (the 009 request / review / dispatch / receive URLs) run against two in-memory
// databases with every proposed migration: one business with inventory_enabled = false (src/stock/service.js, unchanged) and one with it ON (delegated to distribution.js).
//   * the same scenario is replayed on both; every step's visible result (status, numbers, the error status and wording for the same mistake) and every balance must match;
//   * differences that are on purpose are asserted separately (approval holds stock, discrepancies, reservations, ...);
//   * disabled: no new-engine rows at all (no reservations, no discrepancies); enabled: ledger reconciliation (on hand AND reserved) clean;
//   * a request made through the old URL is visible to, and can be finished by, the new engine (one set of rows), and idempotent commandIds still work.
// Usage: node backend/tests/inv/switchover.test.js
import assert from 'node:assert/strict';
import { rig } from './fixture.js';
import { makeAsserts } from './helpers.js';
import { createFlowRoutes } from '../../src/routes/stock-flow.js';
import { createRoutes as distRoutes } from '../../src/routes/inventory-distribution.js';
import * as legacy from '../../src/stock/service.js';
import * as bridge from '../../src/inventory/legacy-bridge.js';
import * as ledger from '../../src/inventory/ledger.js';
import { HttpError } from '../../src/lib/http.js';

const { eq, ok, count } = makeAsserts();

async function world(enabled) {
  const r = await rig();
  const { db, ids, people, contexts, branches } = r;
  if (!enabled) await db.query('update public.businesses set inventory_enabled = false where id = $1', [ids.businessId]);
  const who = (request) => request.headers.authorization.replace(/^Bearer /, '');
  const flow = createFlowRoutes({
    managerContext: async (request) => {
      const name = who(request);
      return { ...contexts[name], restaurantId: contexts[name].memberships[0].restaurant.id, user: contexts[name].user };
    },
    ownerContext: async (request, businessId, { write = false } = {}) => {
      const grant = (contexts[who(request)].grants || []).find((g) => g.businessId === String(businessId).toLowerCase());
      if (!grant) throw new HttpError(404, 'That business isn’t yours.');
      if (write && grant.role !== 'owner') throw new HttpError(403, 'Only the business owner can do this.');
      return { ...contexts[who(request)], grant };
    },
    transact: (fn) => db.transaction(fn),
    bust: () => {},
  });
  const call = async (as, method, pathname, body = {}) => {
    for (const route of flow) {
      if (route.method !== method) continue;
      const m = route.path instanceof RegExp ? route.path.exec(pathname) : (route.path === pathname ? { groups: {} } : null);
      if (!m) continue;
      return route.handler({ request: { headers: { authorization: `Bearer ${as}` } }, params: { ...(m.groups || {}) }, body });
    }
    throw new Error(`No route for ${method} ${pathname}`);
  };
  const tx = (fn) => db.transaction(fn);
  const ctx = { businessId: ids.businessId, actorId: people.owner };
  const fanta = (await tx((t) => legacy.createItem(t, ctx, { name: 'Fanta' }))).id;
  const coke = (await tx((t) => legacy.createItem(t, ctx, { name: 'Coke' }))).id;
  const center = ids.centerLocationId;
  await tx((t) => legacy.adjust(t, { ...ctx, locationId: center }, { kind: 'added', itemId: fanta, quantity: 100 }));
  await tx((t) => legacy.adjust(t, { ...ctx, locationId: center }, { kind: 'added', itemId: coke, quantity: 40 }));
  const onHand = async (loc, item) => Number((await ledger.balance(db, loc, item)).onHand);
  return { r, db, ids, people, contexts, branches, call, tx, fanta, coke, center, onHand, branch: ids.branchLocationId };
}

const biz = (w) => w.ids.businessId;
const own = (w, method, suffix, body) => w.call('owner', method, `/api/owner/stock/${biz(w)}${suffix}`, body);
const brn = (w, method, path, body) => w.call('manager', method, path, body);

/** The scenario. Returns a trace of what a caller could see; nothing in it depends on ids or codes. */
async function scenario(w) {
  const trace = [];
  const step = async (label, fn, pick = (x) => x) => {
    try {
      const out = await fn();
      trace.push([label, 'ok', pick(out)]);
      return out;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      trace.push([label, 'refused', e.status, e.message]);
      return null;
    }
  };
  const stock = async (label) => trace.push([`stock:${label}`, { center: [await w.onHand(w.center, w.fanta), await w.onHand(w.center, w.coke)], branch: [await w.onHand(w.branch, w.fanta), await w.onHand(w.branch, w.coke)] }]);
  const view = async (label) => {
    const snap = bridge.legacyView(await w.tx((t) => legacy.businessSnapshot(t, biz(w))));
    trace.push([`view:${label}`, snap.requests.map((q) => [q.number, q.status, q.lines.map((l) => [l.name, l.requested, l.approved])]), snap.transfers.map((x) => [x.number, x.status, x.lines.map((l) => [l.name, l.quantity, l.received])])]);
  };

  // request, with the mistakes people make
  await step('submit: no lines', () => brn(w, 'POST', '/api/stock/requests', { lines: [] }));
  await step('submit: zero', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: w.fanta, quantity: 0 }] }));
  await step('submit: duplicate item', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: w.fanta, quantity: 1 }, { itemId: w.fanta, quantity: 2 }] }));
  await step('submit: unknown item', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: crypto.randomUUID(), quantity: 1 }] }));
  await step('submit: 4 decimals', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: w.fanta, quantity: 1.2345 }] }));
  const req = await step('submit', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: w.fanta, quantity: 20 }, { itemId: w.coke, quantity: 10 }], note: 'Weekend' }), (x) => [x.number, x.status]);
  const cmd = crypto.randomUUID();
  const again = await step('submit once (commandId)', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: w.coke, quantity: 1 }], commandId: cmd }), (x) => [x.number, x.status]);
  const replay = await step('submit replay (commandId)', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: w.coke, quantity: 1 }], commandId: cmd }), (x) => [x.number, x.status]);
  eq(replay.id, again.id, 'a replay with the same commandId returns the first request');
  await step('cancel own submitted request', () => brn(w, 'POST', `/api/stock/requests/${again.id}/cancel`), (x) => x.status);
  await step('cancel again', () => brn(w, 'POST', `/api/stock/requests/${again.id}/cancel`));
  await view('after submit');

  await step('dispatch before review', () => own(w, 'POST', '/dispatches', { requestId: req.id }));
  await step('approve more than asked', () => own(w, 'POST', `/requests/${req.id}/review`, { decision: 'approve', lines: [{ itemId: w.fanta, approved: 25 }] }));
  await step('approve nothing', () => own(w, 'POST', `/requests/${req.id}/review`, { decision: 'approve', lines: [{ itemId: w.fanta, approved: 0 }, { itemId: w.coke, approved: 0 }] }));
  await step('neither approve nor reject', () => own(w, 'POST', `/requests/${req.id}/review`, { decision: 'maybe' }));
  await step('manager cannot review', () => w.call('manager', 'POST', `/api/owner/stock/${biz(w)}/requests/${req.id}/review`, { decision: 'approve' }));
  await step('approve part', () => own(w, 'POST', `/requests/${req.id}/review`, { decision: 'approve', lines: [{ itemId: w.fanta, approved: 12 }, { itemId: w.coke, approved: 0 }], note: 'Coke from Monday' }), (x) => x.status);
  await step('review twice', () => own(w, 'POST', `/requests/${req.id}/review`, { decision: 'approve' }));
  await step('cancel after review', () => brn(w, 'POST', `/api/stock/requests/${req.id}/cancel`));
  await view('after review');
  await stock('after review');

  // dispatch
  const sent = await step('dispatch the request', () => own(w, 'POST', '/dispatches', { requestId: req.id }), (x) => [x.number, x.status, /^[A-HJ-NP-Z2-9]{10}$/.test(x.code), x.restaurantId === w.ids.branchId]);
  await stock('after dispatch');
  await view('after dispatch');
  await step('dispatch again', () => own(w, 'POST', '/dispatches', { requestId: req.id }));
  const found = await step('look the code up', async () => w.tx((t) => legacy.findByCode(t, sent.code.toLowerCase(), [w.ids.branchId])), (x) => [x.number, bridge.legacyTransferStatus(x.status)]);
  void found;

  // receive: mistakes, then short with a note
  await step('receive: nothing entered', () => brn(w, 'POST', `/api/stock/transfers/${sent.id}/receive`, { lines: [] }));
  await step('receive: more than sent', () => brn(w, 'POST', `/api/stock/transfers/${sent.id}/receive`, { lines: [{ itemId: w.fanta, received: 13 }] }));
  await step('receive: short without a note', () => brn(w, 'POST', `/api/stock/transfers/${sent.id}/receive`, { lines: [{ itemId: w.fanta, received: 10 }] }));
  await step('receive: addressed to another branch', () => w.call('manager2', 'POST', `/api/stock/transfers/${sent.id}/receive`, { lines: [{ itemId: w.fanta, received: 12 }] }));
  await stock('before receiving');
  await step('receive 10 of 12 with a note', () => brn(w, 'POST', `/api/stock/transfers/${sent.id}/receive`, { lines: [{ itemId: w.fanta, received: 10 }], note: '2 bottles broken' }), (x) => [x.status, x.short]);
  await step('receive twice', () => brn(w, 'POST', `/api/stock/transfers/${sent.id}/receive`, { lines: [{ itemId: w.fanta, received: 10 }], note: 'again' }));
  await stock('after receiving');
  await view('after receiving');

  // direct dispatch and cancel
  await step('direct dispatch to another business', () => own(w, 'POST', '/dispatches', { restaurantId: crypto.randomUUID(), lines: [{ itemId: w.fanta, quantity: 1 }] }));
  const push = await step('direct dispatch 5 Fanta', () => own(w, 'POST', '/dispatches', { restaurantId: w.ids.branchId, lines: [{ itemId: w.fanta, quantity: 5 }], note: 'Top-up' }), (x) => [x.status, x.restaurantId === w.ids.branchId]);
  await stock('after direct dispatch');
  await step('cancel the dispatch', () => own(w, 'POST', `/dispatches/${push.id}/cancel`), (x) => x.status);
  await step('cancel the dispatch again', () => own(w, 'POST', `/dispatches/${push.id}/cancel`));
  await step('cancel a received dispatch', () => own(w, 'POST', `/dispatches/${sent.id}/cancel`));
  await stock('after cancelling');

  // reject
  const r2 = await step('submit #2', () => brn(w, 'POST', '/api/stock/requests', { lines: [{ itemId: w.coke, quantity: 5 }] }), (x) => [x.number, x.status]);
  await step('reject without a reason', () => own(w, 'POST', `/requests/${r2.id}/review`, { decision: 'reject' }));
  await step('reject', () => own(w, 'POST', `/requests/${r2.id}/review`, { decision: 'reject', note: 'Use your own supplier' }), (x) => x.status);
  await view('at the end');
  await stock('at the end');
  return { trace, req, sent };
}

// manager2 manages the second branch: used to be refused at branch 1's delivery
const off = await world(false);
const on = await world(true);
const a = await scenario(off);
const b = await scenario(on);

// ---------------------------------------------------------------------------------------------------------
// Parity: the same scenario gives the same visible outcome
// ---------------------------------------------------------------------------------------------------------
const key = (t) => JSON.stringify(t);
const normalise = (trace) => trace.map((row) => row.map((x) => x));
const known = new Set();
const left = normalise(a.trace).filter((t) => !known.has(t[0]));
const right = normalise(b.trace).filter((t) => !known.has(t[0]));
eq(left.length, right.length, 'both runs took the same steps');
for (let i = 0; i < left.length; i += 1) {
  assert.equal(key(right[i]), key(left[i]), `parity at step ${i} "${left[i][0]}":\n  disabled: ${key(left[i])}\n  enabled:  ${key(right[i])}`);
}
ok(left.length > 40, `${left.length} steps compared (results, errors and balances) and every one matches`);

// ---------------------------------------------------------------------------------------------------------
// What differs on purpose
// ---------------------------------------------------------------------------------------------------------
{
  // disabled business: not one new-engine row
  const n = async (w, sql) => Number((await w.db.query(sql)).rows[0].n);
  eq([await n(off, 'select count(*) as n from public.stock_reservations'), await n(off, 'select count(*) as n from public.transfer_discrepancies')], [0, 0], 'disabled: no reservations, no discrepancies (009 exactly)');
  eq((await off.db.query(`select direction, status from public.stock_transfers order by number`)).rows.map((x) => x.status), ['received', 'cancelled'], 'disabled: 009 statuses');
  eq((await off.db.query(`select distinct reason from public.stock_movements where reason in ('transfer_dispatch', 'transfer_receipt')`)).rows, [], 'disabled: 009 reasons (dispatched / received), never the ledger’s transfer reasons');

  // enabled business: one engine
  eq(await n(on, `select count(*) as n from public.stock_reservations where request_id = '${b.req.id}'`), 1, 'enabled: approving held stock (one reservation for the one approved line)');
  eq((await on.db.query(`select status, qty_reserved::text as r, qty_consumed::text as c from public.stock_reservations where request_id = $1`, [b.req.id])).rows, [{ status: 'consumed', r: '12.0000', c: '12.0000' }], 'enabled: the dispatch used up the hold');
  eq((await on.db.query(`select kind, qty_base::text as q, status from public.transfer_discrepancies`)).rows, [{ kind: 'short', q: '2.0000', status: 'open' }], 'enabled: the 2 broken bottles opened a discrepancy for the owner to resolve');
  eq((await on.db.query(`select distinct reason from public.stock_movements where reason like 'transfer%' order by reason`)).rows.map((x) => x.reason), ['transfer_cancelled', 'transfer_dispatch', 'transfer_receipt'], 'enabled: ledger transfer movements');
  eq((await on.db.query(`select count(*)::int as n from public.notifications where kind = 'discrepancy_opened' and recipient_id = $1`, [on.people.owner])).rows[0].n, 1, 'enabled: the owner was told');
  eq(await ledger.reconcile(on.db, { businessId: on.ids.businessId }), [], 'enabled: ledger reconciliation (on hand) is clean');
  eq(await ledger.reconcileReserved(on.db, { businessId: on.ids.businessId }), [], 'enabled: reserved reconciliation is clean');
  eq(await ledger.reconcile(off.db, { businessId: off.ids.businessId }), [], 'disabled: reconciliation clean too');
}

// approving more than the Warehouse can spare: refused at approval (the hold), not at dispatch
{
  const big = await brn(on, 'POST', '/api/stock/requests', { lines: [{ itemId: on.coke, quantity: 100 }] });
  const err = await own(on, 'POST', `/requests/${big.id}/review`, { decision: 'approve' }).then(() => null, (e) => e);
  eq([err.status, err.details.code, /Only \d+ .*free/.test(err.message)], [409, 'insufficient_available', true], 'enabled: approving 100 when the Warehouse has 40 is refused with the figure');
  eq((await brn(on, 'POST', `/api/stock/requests/${big.id}/cancel`)).status, 'cancelled', 'and the request can still be cancelled');
  const bigOff = await brn(off, 'POST', '/api/stock/requests', { lines: [{ itemId: off.coke, quantity: 100 }] });
  eq((await own(off, 'POST', `/requests/${bigOff.id}/review`, { decision: 'approve' })).status, 'approved', 'disabled (009): approval never looked at stock');
  await brn(off, 'POST', `/api/stock/requests/${bigOff.id}/cancel`).catch(() => null);
}

// one set of rows: the old URL and the new engine see and finish each other's work
{
  const r = await brn(on, 'POST', '/api/stock/requests', { lines: [{ itemId: on.fanta, quantity: 6 }, { itemId: on.coke, quantity: 3 }] });
  const dist = distRoutes({ authenticate: async (request) => on.contexts[request.headers.authorization.replace(/^Bearer /, '')], pool: () => on.db, transact: (fn) => on.db.transaction(fn) });
  const newGet = (path) => dist.find((x) => x.method === 'GET' && x.path.exec(path)).handler({ request: { headers: { authorization: 'Bearer owner' } }, params: { ...dist.find((x) => x.method === 'GET' && x.path.exec(path)).path.exec(path).groups }, url: new URL(`http://x${path}`) });
  const seen = await newGet(`/api/owner/inventory/${biz(on)}/requests/${r.id}`);
  eq([seen.request.status, seen.request.ref.startsWith('REQ-'), seen.request.lines.length], ['submitted', true, 2], 'a request made through the old URL is a normal request in the new engine');
  await own(on, 'POST', `/requests/${r.id}/review`, { decision: 'approve' });
  const held = await newGet(`/api/owner/inventory/${biz(on)}/requests/${r.id}`);
  eq(held.request.lines.map((l) => [l.name, l.held]), [['Coke', '3.0000'], ['Fanta', '6.0000']], 'approving through the old URL holds the stock (the new screens show it)');
  const out = await own(on, 'POST', '/dispatches', { requestId: r.id });
  const got = await brn(on, 'POST', `/api/stock/transfers/${out.id}/receive`, { lines: [{ itemId: on.fanta, received: 6 }, { itemId: on.coke, received: 3 }] });
  eq([got.status, got.short], ['received', 0], 'received through the old URL');
  const done = await newGet(`/api/owner/inventory/${biz(on)}/requests/${r.id}`);
  eq(done.request.status, 'completed', 'the new engine sees the request completed (nothing missing)');
  eq(await ledger.reconcile(on.db, { businessId: biz(on) }), [], 'reconciliation stays clean');
  eq(await ledger.reconcileReserved(on.db, { businessId: biz(on) }), [], 'and so does the reserved figure');
}

// snapshots fold new statuses back for the old pages; for 009 values it is the identity
{
  const view = bridge.legacyView({ requests: ['draft', 'submitted', 'pending_approval', 'approved', 'partially_approved', 'preparing', 'rejected', 'dispatched', 'partially_received', 'received', 'completed', 'cancelled'].map((status) => ({ status })),
    transfers: ['pending_approval', 'in_transit', 'partially_received', 'received', 'cancelled'].map((status) => ({ status })) });
  eq(view.requests.map((x) => x.status), ['submitted', 'submitted', 'approved', 'approved', 'approved', 'rejected', 'dispatched', 'dispatched', 'received', 'received', 'cancelled'], 'request statuses the old page knows');
  eq(view.transfers.map((x) => x.status), ['in_transit', 'in_transit', 'received', 'cancelled'], 'transfer statuses the old page knows');
  const nine = { requests: [{ status: 'submitted' }, { status: 'approved' }, { status: 'dispatched' }, { status: 'received' }, { status: 'rejected' }, { status: 'cancelled' }], transfers: [{ status: 'in_transit' }, { status: 'received' }, { status: 'cancelled' }] };
  eq(bridge.legacyView(nine), nine, 'a 009 snapshot is unchanged');
  eq([await bridge.switched(on.db, biz(on)), await bridge.switched(off.db, biz(off))], [true, false], 'switched() reads the business flag');
}

console.log(`Switch-over: ${count()} checks passed.`);
