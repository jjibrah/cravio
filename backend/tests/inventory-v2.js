// Inventory (proposed migration 009) on a disposable PGlite database: servings, order-linked deduction on serving,
// sold-out refusal, swaps after serving, requests → approval → dispatch (QR code) → receipt, idempotency and isolation.
// Usage: node backend/tests/inventory-v2.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUser, freshDatabase, readSql } from './support/pg.js';
import {
  adjust, availability, branchLocation, branchSnapshot, businessSnapshot, cancelDispatch, cancelRequest, centerLocation, correctOrder,
  createItem, dispatch, findByCode, linkMenuItem, once, receive, reviewRequest, submitRequest,
} from '../src/stock/service.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fails = async (promise, test, m) => {
  await assert.rejects(promise, (error) => { if (typeof test === 'number') assert.equal(error.status, test, `${m}: ${error.status} ${error.message}`); else assert.match(error.message, test, m); return true; }, m);
  checks++;
};

const db = await freshDatabase({ extra: ['proposed/009_inventory.sql'] });
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const tx = (fn) => db.transaction(fn);

// Fixture: business with two branches, a rival business.
const owner = await createUser(db, 'owner@example.test', { role: 'owner' });
const manager = await createUser(db, 'manager@example.test', { role: 'owner' });
const waiter = await createUser(db, 'waiter@example.test', { role: 'waiter' });
const rivalOwner = await createUser(db, 'rival@example.test', { role: 'owner' });
const main = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Main', 'live') returning id, business_id`, [owner]);
const west = (await one(`insert into public.restaurants (owner_id, name, business_id, owner_primary, status) values ($1, 'West', $2, false, 'live') returning id`, [owner, main.business_id])).id;
const rival = await one(`insert into public.restaurants (owner_id, name) values ($1, 'Rival') returning id, business_id`, [rivalOwner]);
const biz = main.business_id;
const cat = (await one(`insert into public.menu_categories (restaurant_id, name) values ($1, 'Drinks') returning id`, [main.id])).id;
const dish = async (name, price = 100) => (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, $4) returning id`, [main.id, cat, name, price])).id;
const fantaDish = await dish('Fanta');
const cokeDish = await dish('Coke');
const pilauDish = await dish('Pilau (large)', 600);
const teaDish = await dish('Tea');

const ctx = { businessId: biz, actorId: manager };
const [fanta, coke, pilau] = await tx(async (t) => [
  await createItem(t, ctx, { name: 'Fanta 300ml', lowLevel: 5 }),
  await createItem(t, ctx, { name: 'Coke 300ml' }),
  await createItem(t, ctx, { name: 'Pilau' }),
]);
await fails(tx((t) => createItem(t, ctx, { name: ' fanta 300ML ' })), 409, 'duplicate names refused, not merged');
const mainLoc = await tx((t) => branchLocation(t, main.id));
const branchCtx = { businessId: biz, restaurantId: main.id, locationId: mainLoc, actorId: manager };

// Links: one large pilau uses 2 servings; tea stays untracked.
await tx(async (t) => {
  await linkMenuItem(t, branchCtx, fantaDish, { itemId: fanta.id });
  await linkMenuItem(t, branchCtx, cokeDish, { itemId: coke.id });
  await linkMenuItem(t, branchCtx, pilauDish, { itemId: pilau.id, servings: 2 });
});
await fails(tx((t) => linkMenuItem(t, { ...branchCtx, restaurantId: west }, fantaDish, { itemId: fanta.id })), 404, 'cannot link another branch’s dish');

// Opening stock is a count.
await tx((t) => adjust(t, { ...branchCtx }, { kind: 'count', itemId: fanta.id, quantity: 3 }));
await tx((t) => adjust(t, branchCtx, { kind: 'count', itemId: pilau.id, quantity: 5 }));
await fails(tx((t) => adjust(t, branchCtx, { kind: 'waste', itemId: fanta.id, quantity: 1 })), 400, 'waste needs a reason');
await fails(tx((t) => adjust(t, branchCtx, { kind: 'waste', itemId: fanta.id, quantity: 9, note: 'spilt' })), 409, 'cannot waste more than on hand');
await fails(tx((t) => adjust(t, { ...branchCtx, businessId: rival.business_id }, { kind: 'added', itemId: fanta.id, quantity: 1 })), 404, 'another business’s item refused');

// Orders: confirmed orders hold servings; serving deducts once.
const order = async (lines, status = 'taken') => tx(async (t) => {
  const o = (await t.query(`insert into public.orders (restaurant_id, status, taken_by) values ($1, $2, $3) returning id`, [main.id, status, waiter])).rows[0].id;
  await t.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, kind, components)
    select $1, $2, (l->>'itemId')::uuid, l->>'name', 100, (l->>'quantity')::int, 100, coalesce(l->>'kind', 'item'), l->'components'
    from jsonb_array_elements($3::jsonb) l`, [o, main.id, JSON.stringify(lines)]);
  return o;
});
const serve = (o) => db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [o, waiter]);
const onHand = async (item, loc = mainLoc) => Number((await one('select on_hand from public.stock_balances where location_id = $1 and item_id = $2', [loc, item]))?.on_hand ?? 0);
const avail = async () => Object.fromEntries((await availability(db, main.id)).map((a) => [a.menuItemId, a]));

const o1 = await order([{ itemId: fantaDish, name: 'Fanta', quantity: 2 }, { itemId: teaDish, name: 'Tea', quantity: 1 }]);
eq(await onHand(fanta.id), 3, 'confirming does not deduct');
eq((await avail())[fantaDish].available, 1, 'confirmed order holds servings');
await fails(order([{ itemId: fantaDish, name: 'Fanta', quantity: 2 }]), /Sold out: Fanta/, 'last servings cannot be ordered twice');
eq((await one('select count(*)::int as n from public.orders')).n, 1, 'refused order left nothing behind');
await serve(o1);
eq(await onHand(fanta.id), 1, 'serving deducts');
await db.query(`update public.orders set status = 'paid', paid_at = now() where id = $1`, [o1]);
await db.query(`update public.orders set status = 'served', paid_at = null where id = $1`, [o1]);
eq(await onHand(fanta.id), 1, 'paid → served again (failed payment) does not deduct twice');
eq((await one(`select count(*)::int as n from public.stock_movements where reason = 'served'`)).n, 1, 'one movement per served line');

// Deal: components count; large pilau uses 2 servings each.
const o2 = await order([{ kind: 'deal', name: 'Lunch deal', quantity: 1, components: [{ itemId: pilauDish, name: 'Pilau (large)', quantity: 2 }, { itemId: teaDish, name: 'Tea', quantity: 1 }] }]);
await serve(o2);
eq(await onHand(pilau.id), 1, 'deal components deduct (2 dishes × 2 servings)');
eq((await avail())[pilauDish].soldOut, true, 'one serving left but a large pilau needs two → sold out');

// Manager override: keep selling when out.
await fails(order([{ itemId: fantaDish, name: 'Fanta', quantity: 2 }]), /Sold out/, 'out of Fanta');
await tx((t) => linkMenuItem(t, branchCtx, fantaDish, { itemId: fanta.id, allowWhenOut: true }));
const o3 = await order([{ itemId: fantaDish, name: 'Fanta', quantity: 2 }]);
await serve(o3);
eq(await onHand(fanta.id), -1, 'override lets service continue; balance shows the gap to count');
await tx((t) => linkMenuItem(t, branchCtx, fantaDish, { itemId: fanta.id }));

// Cancelling an unserved order releases the hold; nothing to restock.
await tx((t) => adjust(t, branchCtx, { kind: 'count', itemId: coke.id, quantity: 1 }));
const o4 = await order([{ itemId: cokeDish, name: 'Coke', quantity: 1 }]);
eq((await avail())[cokeDish].soldOut, true, 'held by o4');
await db.query(`update public.orders set status = 'cancelled', cancelled_at = now() where id = $1`, [o4]);
eq((await avail())[cokeDish].soldOut, false, 'cancelling before serving releases the hold');
eq(await onHand(coke.id), 1, 'cancel before serving moves no stock');

// Swap after serving: Fanta came back unopened, Coke given instead.
await tx((t) => adjust(t, branchCtx, { kind: 'count', itemId: fanta.id, quantity: 4 }));
await fails(tx((t) => correctOrder(t, branchCtx, o4, { returned: [{ itemId: fanta.id, quantity: 1 }], note: 'x' })), 409, 'corrections only after serving');
await fails(tx((t) => correctOrder(t, branchCtx, o1, { returned: [{ itemId: fanta.id, quantity: 1 }] })), 400, 'correction needs a note');
await tx((t) => correctOrder(t, branchCtx, o1, { returned: [{ itemId: fanta.id, quantity: 1 }], used: [{ itemId: coke.id, quantity: 1 }], note: 'Swapped Fanta for Coke' }));
eq([await onHand(fanta.id), await onHand(coke.id)], [5, 0], 'swap returns one Fanta and takes one Coke');
await fails(tx((t) => correctOrder(t, { ...branchCtx, restaurantId: west }, o1, { used: [{ itemId: coke.id, quantity: 1 }], note: 'x' })), 404, 'other branch cannot correct this order');

// Requests → review → dispatch → receive.
const westLoc = await tx((t) => branchLocation(t, west));
const westCtx = { businessId: biz, restaurantId: west, locationId: westLoc, actorId: manager };
const ownerCtx = { businessId: biz, actorId: owner };
const req = await tx((t) => submitRequest(t, westCtx, { lines: [{ itemId: fanta.id, quantity: 20 }, { itemId: pilau.id, quantity: 10 }], note: 'Weekend' }));
eq(req.number, 1, 'requests are numbered per business');
await fails(tx((t) => dispatch(t, ownerCtx, { requestId: req.id })), 409, 'cannot dispatch before review');
await fails(tx((t) => reviewRequest(t, ownerCtx, req.id, { decision: 'approve', lines: [{ itemId: fanta.id, approved: 25 }] })), 400, 'cannot approve more than requested');
await fails(tx((t) => reviewRequest(t, { businessId: rival.business_id, actorId: rivalOwner }, req.id, { decision: 'approve' })), 404, 'rival owner cannot review');
await tx((t) => reviewRequest(t, ownerCtx, req.id, { decision: 'approve', lines: [{ itemId: fanta.id, approved: 12 }, { itemId: pilau.id, approved: 0 }], note: 'Pilau from Monday' }));
eq(await onHand(fanta.id, westLoc), 0, 'approval moves no stock');
const center = await tx((t) => centerLocation(t, biz));
await fails(tx((t) => dispatch(t, ownerCtx, { requestId: req.id })), /main center has 0/, 'cannot dispatch more than the center holds');
await tx((t) => adjust(t, { businessId: biz, locationId: center, actorId: owner }, { kind: 'added', itemId: fanta.id, quantity: 30, note: 'Supplier delivery' }));
const commandId = randomUUID();
const send = () => tx((t) => once(t, { commandId, businessId: biz, actorId: owner, kind: 'dispatch' }, () => dispatch(t, ownerCtx, { requestId: req.id })));
const sent = await send();
eq(await send(), sent, 'retrying a dispatch returns the first result');
eq([await onHand(fanta.id, center), await onHand(fanta.id, westLoc)], [18, 0], 'dispatch takes from the center; in transit until received');
assert.match(sent.code, /^[A-HJ-NP-Z2-9]{10}$/); checks++;
await fails(tx((t) => findByCode(t, sent.code, [main.id])), 404, 'code does not resolve for a branch it isn’t addressed to');
eq((await tx((t) => findByCode(t, sent.code.toLowerCase(), [west, main.id]))).branchId, west, 'QR/code lookup finds the destination');
await fails(tx((t) => receive(t, branchCtx, sent.id, { lines: [{ itemId: fanta.id, received: 12 }] })), 404, 'only the destination branch receives');
await fails(tx((t) => receive(t, westCtx, sent.id, { lines: [{ itemId: fanta.id, received: 13 }] })), 400, 'cannot receive more than dispatched');
await fails(tx((t) => receive(t, westCtx, sent.id, { lines: [{ itemId: fanta.id, received: 10 }] })), 400, 'shortfall needs a note');
eq(await onHand(fanta.id, westLoc), 0, 'refused receipt changed nothing');
await tx((t) => receive(t, westCtx, sent.id, { lines: [{ itemId: fanta.id, received: 10 }], note: '2 bottles broken' }));
eq(await onHand(fanta.id, westLoc), 10, 'received servings added to the branch');
eq((await one('select status from public.stock_requests where id = $1', [req.id])).status, 'received', 'request closes when received');
await fails(tx((t) => receive(t, westCtx, sent.id, { lines: [{ itemId: fanta.id, received: 10 }] })), 409, 'cannot receive twice');
await fails(tx((t) => cancelDispatch(t, ownerCtx, sent.id)), 409, 'received dispatch cannot be cancelled');

// Direct dispatch (no request), then cancelled: servings return to the center.
const push = await tx((t) => dispatch(t, ownerCtx, { restaurantId: west, lines: [{ itemId: fanta.id, quantity: 5 }] }));
await tx((t) => cancelDispatch(t, ownerCtx, push.id));
eq(await onHand(fanta.id, center), 18, 'cancelled dispatch returns to the center');
await fails(tx((t) => dispatch(t, ownerCtx, { restaurantId: rival.id, lines: [{ itemId: fanta.id, quantity: 1 }] })), 404, 'cannot dispatch to another business');

// Reject and branch cancel.
const r2 = await tx((t) => submitRequest(t, westCtx, { lines: [{ itemId: coke.id, quantity: 5 }] }));
await fails(tx((t) => reviewRequest(t, ownerCtx, r2.id, { decision: 'reject' })), 400, 'rejection needs a reason');
await tx((t) => reviewRequest(t, ownerCtx, r2.id, { decision: 'reject', note: 'Use your own supplier' }));
const r3 = await tx((t) => submitRequest(t, westCtx, { lines: [{ itemId: coke.id, quantity: 5 }] }));
await fails(tx((t) => cancelRequest(t, branchCtx, r3.id)), 404, 'another branch cannot cancel');
await tx((t) => cancelRequest(t, westCtx, r3.id));

// Snapshots
const snap = await branchSnapshot(db, west);
eq(snap.items.find((i) => i.id === fanta.id).onHand, 10, 'branch snapshot balance');
eq(snap.requests.map((r) => r.status), ['cancelled', 'rejected', 'received'], 'branch sees its requests');
eq(snap.incoming[0].lines[0], { itemId: fanta.id, name: 'Fanta 300ml', quantity: 12, received: 10 }, 'branch sees received vs dispatched');
const bsnap = await businessSnapshot(db, biz);
eq(bsnap.items.find((i) => i.id === fanta.id).branches[west], 10, 'owner sees branch balances');
eq(bsnap.items.find((i) => i.id === fanta.id).centerOnHand, 18, 'owner sees center balance');

// Ledger is append-only and readable only through the API.
await fails(db.query('delete from public.stock_movements'), /append-only/, 'movements cannot be deleted');
await fails(db.transaction(async (t) => { await t.query(`select set_config('request.jwt.claim.sub', $1, true)`, [manager]); await t.exec('set local role authenticated'); await t.query('select * from public.stock_balances'); }), /permission denied/, 'balances not readable directly by browsers');
await fails(db.transaction(async (t) => { await t.query(`select set_config('request.jwt.claim.sub', $1, true)`, [rivalOwner]); await t.exec('set local role authenticated'); await t.query('select * from public.stock_menu_availability($1)', [main.id]); }), /Not a member/, 'availability limited to branch members');

// Rollback: refused while history exists; after a deliberate clear it removes everything and orders keep working.
await fails(db.exec(readSql('proposed/009_inventory.down.sql')), /Refusing rollback/, 'rollback refuses while stock history exists');
await db.exec(`alter table public.stock_movements disable trigger stock_movements_no_change; delete from public.order_stock_effects; delete from public.stock_movements;
  delete from public.stock_transfers; delete from public.stock_requests;`);
await db.exec(readSql('proposed/009_inventory.down.sql'));
eq((await one(`select to_regclass('public.stock_items') is null as gone`)).gone, true, 'rollback removes inventory tables');
const after = await order([{ itemId: fantaDish, name: 'Fanta', quantity: 50 }]);
await serve(after);
eq((await one('select status from public.orders where id = $1', [after])).status, 'served', 'orders work without inventory after rollback');
await db.exec(readSql('proposed/009_inventory.sql'));
eq((await one(`select to_regclass('public.stock_items') is not null as back`)).back, true, 're-apply after rollback works');

console.log(`Inventory: ${checks} checks passed (disposable PGlite database).`);
await db.close();
