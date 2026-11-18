// Notification events and request suggestions (P2-24). Real services and route handlers, in-memory database, no network.
// Events: request submitted -> owners; approved / partly approved / rejected -> the branch's managers; dispatched -> the destination's managers ("on its way" + code);
// received with a difference -> owners; cancelled dispatch -> destination; a 009 request the Warehouse cannot cover -> owners (needs attention).
// Each fires once per cause (a replay with the same commandId, or a second look, never duplicates), reaches the right people and links to a real screen.
// Suggestions: par - available - incoming (on its way + open requests), rounded UP to the main pack; items with no par fall back to 7 days of the last 14 days' use.
// Usage: node backend/tests/inv/notifications-p2.test.js
import { rig } from './fixture.js';
import { makeAsserts, makeItem, receive } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-distribution.js';
import * as ledger from '../../src/inventory/ledger.js';
import * as legacy from '../../src/stock/service.js';
import * as notifications from '../../src/inventory/notifications.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, contexts } = r;
const biz = ids.businessId;
const WH = ids.centerLocationId;
const B1 = branches.branch1.locationId;
const B2 = branches.branch2.locationId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
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
const BR = { manager: ids.branchId, manager2: branches.branch2.restaurantId };
const mgr = (who, method, suffix, body, query) => run(who, method, `/api/inventory${suffix}`, body, query, BR[who]);
const own = (who, method, suffix, body, query) => run(who, method, `/api/owner/inventory/${biz}${suffix}`, body, query);
const uuid = () => crypto.randomUUID();
const notes = (user, kind) => q('select * from public.notifications where recipient_id = $1 and kind = $2 order by created_at, id', [user, kind]);
const line = (itemId, quantity, unit = 'kg') => ({ itemId, quantity, unit });
const reconciled = async (m) => eq(await ledger.reconcile(db, { businessId: biz }), [], `reconciliation is clean: ${m}`);
const B1LINK = `/branch/${ids.branchId}/inventory/requests`;

const beef = await makeItem(db, biz, 'Beef');
const lamb = await makeItem(db, biz, 'Lamb');
const { flour } = r.items;
await receive(db, { businessId: biz, locationId: WH, itemId: beef, qty: '100000', unitCost: '0.5' });
await receive(db, { businessId: biz, locationId: WH, itemId: lamb, qty: '100000', unitCost: '1' });
await receive(db, { businessId: biz, locationId: WH, itemId: flour, qty: '200000', unitCost: '0.1' });

// ============================================================================================================
// request submitted -> owners, once
// ============================================================================================================
const cmd = uuid();
const made = (await mgr('manager', 'POST', '/requests', { lines: [line(beef, 20)], commandId: cmd })).request;
await mgr('manager', 'POST', '/requests', { lines: [line(beef, 20)], commandId: cmd });
for (const who of ['owner', 'owner2']) {
  const n = await notes(people[who], 'request_submitted');
  eq([n.length, n[0].link, n[0].entity_id], [1, '/owner/inventory/requests', made.id], `${who} is told once (a replay with the same commandId doesn't repeat it)`);
}
eq([(await notes(people.manager2, 'request_submitted')).length, (await notes(people.waiter, 'request_submitted')).length], [0, 0], 'other branches’ managers and waiters are not told');
{
  const draft = (await mgr('manager', 'POST', '/requests', { lines: [line(lamb, 1)], submit: false })).request;
  eq((await q(`select count(*)::int as n from public.notifications where entity_id = $1`, [draft.id]))[0].n, 0, 'a draft tells nobody');
  await mgr('manager', 'POST', `/requests/${draft.id}/submit`, {});
  await mgr('manager', 'POST', `/requests/${draft.id}/submit`, {});
  eq((await q(`select count(*)::int as n from public.notifications where entity_id = $1 and kind = 'request_submitted' and recipient_id = $2`, [draft.id, people.owner]))[0].n, 1, 'submitting a draft (twice) tells the owner once');
  await mgr('manager', 'POST', `/requests/${draft.id}/cancel`, { reason: 'No longer needed' });
}

// ============================================================================================================
// approved / partly approved / rejected -> that branch's managers
// ============================================================================================================
await own('owner', 'POST', `/requests/${made.id}/review`, { decision: 'approve', lines: [{ itemId: beef, approved: 15, unit: 'kg' }], commandId: uuid() });
{
  const n = await notes(people.manager, 'request_partially_approved');
  eq([n.length, n[0].link, n[0].entity_id], [1, B1LINK, made.id], 'the branch manager hears it was partly approved, link to their requests screen');
  ok(/Beef: 15 kg of 20 kg/.test(n[0].body), 'with what was cut, in words');
  eq((await notes(people.manager2, 'request_partially_approved')).length, 0, 'not the other branch');
}
{
  const full = (await mgr('manager', 'POST', '/requests', { lines: [line(lamb, 5)] })).request;
  await own('owner', 'POST', `/requests/${full.id}/review`, { decision: 'approve' });
  eq((await notes(people.manager, 'request_approved')).map((n) => n.entity_id), [full.id], 'fully approved -> request_approved');
  const no = (await mgr('manager', 'POST', '/requests', { lines: [line(lamb, 5)] })).request;
  await own('owner', 'POST', `/requests/${no.id}/review`, { decision: 'reject', note: 'Use your own supplier' });
  const n = await notes(people.manager, 'request_rejected');
  eq([n.length, n[0].body, n[0].link], [1, 'Use your own supplier', B1LINK], 'rejected -> request_rejected with the reason');
  await mgr('manager', 'POST', `/requests/${full.id}/cancel`, {});
  eq((await notes(people.manager, 'request_cancelled')).length, 0, 'a branch cancelling its own request doesn’t notify itself');
  await own('owner', 'POST', `/requests/${made.id}/cancel`, { reason: 'Not needed after all' });
  eq((await notes(people.manager, 'request_cancelled')).map((n) => n.entity_id), [made.id], 'an owner cancelling tells the branch manager once');
}

// ============================================================================================================
// dispatched -> destination managers, with the code; cancelled dispatch; received with a difference
// ============================================================================================================
const req2 = (await mgr('manager', 'POST', '/requests', { lines: [line(flour, 50)] })).request;
await own('owner', 'POST', `/requests/${req2.id}/review`, { decision: 'approve' });
const dcmd = uuid();
const sent = (await own('owner', 'POST', `/requests/${req2.id}/dispatch`, { driver: 'Joseph', commandId: dcmd })).transfer;
await own('owner', 'POST', `/requests/${req2.id}/dispatch`, { driver: 'Joseph', commandId: dcmd });
{
  const n = await notes(people.manager, 'delivery_incoming');
  eq([n.length, n[0].entity_id, n[0].link], [1, sent.id, `${B1LINK}?receive=${sent.id}`], 'dispatch: the destination manager is told once, the link opens the receive form');
  ok(n[0].body.includes(sent.code), 'the message carries the code');
  eq([(await notes(people.manager2, 'delivery_incoming')).length, (await notes(people.waiter, 'delivery_incoming')).length], [0, 0], 'only the destination’s managers (never a waiter or another branch)');
}
{
  // cancel a direct dispatch before it is received
  const t = (await own('owner', 'POST', '/dispatches', { branchId: ids.branchId, lines: [line(lamb, 2)] })).transfer;
  await own('owner', 'POST', `/dispatches/${t.id}/cancel`, {});
  await own('owner', 'POST', `/dispatches/${t.id}/cancel`, {});
  const n = (await notes(people.manager, 'delivery_cancelled')).filter((x) => x.entity_id === t.id);
  eq([n.length, n[0].link], [1, B1LINK], 'cancelling a dispatch tells the destination once (also on a repeat)');
}
await mgr('manager', 'POST', `/transfers/${sent.id}/receive`, { lines: [{ itemId: flour, received: 48, unit: 'kg' }], note: 'Two kilos spilled', commandId: uuid() });
{
  for (const who of ['owner', 'owner2']) {
    eq([(await notes(people[who], 'discrepancy_opened')).length, (await notes(people[who], 'delivery_received')).length], [1, 1], `${who} hears about the difference and the receipt`);
  }
  const o = (await notes(people.owner, 'discrepancy_opened'))[0];
  eq(o.link, '/owner/inventory/requests?tab=problems', 'the difference opens the problems tab');
  ok(/short 2 kg of Flour/.test(o.body) || /short .*Flour/.test(o.body), 'and says what is short');
  eq((await notes(people.manager, 'discrepancy_opened')).length, 0, 'the person who counted is not told about their own count');
  eq((await notes(people.manager2, 'discrepancy_opened')).length, 0, 'nor is another branch');
}

// ============================================================================================================
// a 009 request the Warehouse can't cover -> owners, once
// ============================================================================================================
{
  const hold = (await mgr('manager', 'POST', '/requests', { lines: [line(lamb, 10)] })).request;
  await own('owner', 'POST', `/requests/${hold.id}/review`, { decision: 'approve' });         // holds 10 kg of Lamb
  const old = await db.transaction(async (t) => {
    const made = await legacy.submitRequest(t, { businessId: biz, restaurantId: ids.branchId, actorId: people.manager }, { lines: [{ itemId: lamb, quantity: 100000 }] });
    await legacy.reviewRequest(t, { businessId: biz, actorId: people.owner }, made.id, { decision: 'approve' });
    return made;
  });
  await own('owner', 'GET', '/requests/inbox');
  await own('owner', 'GET', '/requests/inbox');
  for (const who of ['owner', 'owner2']) {
    const n = (await notes(people[who], 'reservation_attention')).filter((x) => x.entity_id === old.id);
    eq([n.length, n[0]?.link], [1, '/owner/inventory/requests'], `${who} is told once that the 009 request needs attention`);
  }
  eq((await notes(people.manager2, 'reservation_attention')).length, 0, 'branch managers of other branches are not told');
  await mgr('manager', 'POST', `/requests/${hold.id}/cancel`, {});
  await own('owner', 'POST', `/requests/${old.id}/cancel`, { reason: 'Test over' });
}
await reconciled('after the notification flows');

// ---- the catalogue ----
{
  const kinds = (await q(`select distinct kind from public.notifications where business_id = $1`, [biz])).map((x) => x.kind);
  const unknown = kinds.filter((k) => !notifications.EVENT_KINDS[k]);
  eq(unknown, [], 'every notification kind written is in the event catalogue');
  const page = await notifications.list(db, people.manager);
  ok(page.notifications.every((n) => typeof n.label === 'string'), 'the list carries a label per kind for the bell');
}

// ============================================================================================================
// Suggestions
// ============================================================================================================
const DAY = 24 * 3600 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);
const post = (locationId, itemId, qty, reason, at = null) => db.transaction((t) => ledger.post(t, { businessId: biz, locationId, itemId, qty, reason, occurredAt: at, idempotencyKey: `sg-${Math.random().toString(36).slice(2)}` }));
const suggest = async (who = 'manager') => Object.fromEntries((await mgr(who, 'GET', '/requests/suggestions')).suggestions.map((s) => [s.name, s]));
{
  // nothing to go on
  const none = await mgr('manager2', 'GET', '/requests/suggestions');
  eq([none.suggestions, /nothing to suggest/.test(none.message)], [[], true], 'no par and no use: an empty list with a plain message');

  // par minus available minus incoming (on its way and open requests), rounded UP to the pack (flour: sack = 25 kg)
  await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, par) values ($1, $2, $3, 90000)`, [B2, flour, biz]);
  await post(B2, flour, '20000', 'purchase_receipt');
  let s = await suggest('manager2');
  eq([s.Flour.basis, s.Flour.par, s.Flour.available, s.Flour.incoming, s.Flour.suggested], ['par', '90000.0000', '20000.0000', '0.0000', '75000.0000'], 'par 90 - on hand 20 = 70 kg, rounded up to 3 sacks = 75 kg');
  eq([s.Flour.pack.name, s.Flour.suggestedDisplay.startsWith('75 kg')], ['sack', true], 'with the pack and a readable amount');
  const open = (await mgr('manager2', 'POST', '/requests', { lines: [line(flour, 25)] })).request;
  s = await suggest('manager2');
  eq([s.Flour.incoming, s.Flour.suggested], ['25000.0000', '50000.0000'], 'an open request counts as incoming: 90 - 20 - 25 = 45 kg -> 2 sacks');
  await own('owner', 'POST', `/requests/${open.id}/review`, { decision: 'approve' });
  const t = (await own('owner', 'POST', `/requests/${open.id}/dispatch`, {})).transfer;
  s = await suggest('manager2');
  eq([s.Flour.incoming, s.Flour.suggested], ['25000.0000', '50000.0000'], 'on its way counts the same (not twice)');
  await mgr('manager2', 'POST', `/transfers/${t.id}/receive`, { lines: [{ itemId: flour, received: 25, unit: 'kg' }] });
  s = await suggest('manager2');
  eq([s.Flour.available, s.Flour.incoming, s.Flour.suggested], ['45000.0000', '0.0000', '50000.0000'], 'once received it is on hand: 90 - 45 = 45 kg -> 2 sacks');
  await post(B2, flour, '50000', 'purchase_receipt');
  eq((await suggest('manager2')).Flour, undefined, 'at or above par: nothing to ask for');
  await reconciled('after par suggestions');
}
{
  // no par: 7 days of the average use over the last 14 days; older use is ignored
  await post(B1, lamb, '30000', 'purchase_receipt');
  await post(B1, lamb, '-7000', 'pos_consumption', ago(3));
  await post(B1, lamb, '-7000', 'pos_consumption', ago(10));
  await post(B1, lamb, '-5000', 'pos_consumption', ago(20));
  await post(B1, lamb, '-9000', 'wastage', ago(1));          // waste is not "use"
  let s = await suggest();
  eq([s.Lamb.basis, s.Lamb.par, s.Lamb.avgDailyUse, s.Lamb.target], ['use', null, '1000.0000', '7000.0000'], 'average use 14 kg / 14 days = 1 kg a day, so 7 kg for a week');
  eq([s.Lamb.available, s.Lamb.suggested], ['2000.0000', '5000.0000'], 'on hand 2 kg: ask for 5 kg (no pack, so exactly)');
  eq(s.Lamb.daysCover, '2.0', 'two days of cover left');
  const asked = (await mgr('manager', 'POST', '/requests', { lines: [line(lamb, 3)] })).request;
  s = await suggest();
  eq([s.Lamb.incoming, s.Lamb.suggested], ['3000.0000', '2000.0000'], 'asking for 3 kg leaves 2 kg to suggest');
  await mgr('manager', 'POST', `/requests/${asked.id}/cancel`, {});

  // pack rounding on the fallback: flour, 28 kg used in 14 days = 2 kg a day -> 14 kg target, 4 kg on hand -> 10 kg -> one 25 kg sack
  await post(B1, flour, '-14000', 'pos_consumption', ago(2));
  await post(B1, flour, '-14000', 'pos_consumption', ago(12));
  await post(B1, flour, '-16000', 'wastage', ago(1));          // leaves 4 kg of the 48 kg that arrived
  s = await suggest();
  eq([s.Flour.basis, s.Flour.avgDailyUse, s.Flour.available, s.Flour.suggested], ['use', '2000.0000', '4000.0000', '25000.0000'], '10 kg short rounds up to one 25 kg sack');
  // a par level wins over use
  await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, par) values ($1, $2, $3, 54000)`, [B1, flour, biz]);
  s = await suggest();
  eq([s.Flour.basis, s.Flour.par, s.Flour.suggested], ['par', '54000.0000', '50000.0000'], 'with a par level that is the target: 54 - 4 = 50 kg = 2 sacks');
  await refuses(run('waiter', 'GET', '/api/inventory/requests/suggestions', undefined, '', ids.branchId), 403, 'forbidden', null, 'a waiter cannot ask for suggestions');
  eq((await own('owner', 'GET', '/requests/suggestions', undefined, `?branchId=${ids.branchId}`)).suggestions.map((x) => x.name), ['Flour', 'Lamb'], 'the owner can ask for any branch');
  await reconciled('after fallback suggestions');
}

console.log(`Notifications and suggestions: ${count()} checks passed.`);
