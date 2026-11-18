// The Phase 2 harness itself (P2-02): fixture defaults, rig(), shared helpers, fake clock and fake storage.
// Usage: node backend/tests/inv/harness.test.js
import { inventoryFixture, rig } from './fixture.js';
import { ALL_INVENTORY_MIGRATIONS } from './migrations.js';
import { makeAsserts, keyGen, makeItem, receive, fakeClock, fakeStorage } from './helpers.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { balance, reconcile } from '../../src/inventory/ledger.js';
import { setSetting } from '../../src/inventory/policies.js';

const { eq, ok, refuses, count } = makeAsserts();

// ---- fixture defaults: ALL inventory migrations unless the test opts out ----
const has = async (db, table) => (await db.query(`select to_regclass($1) as r`, [`public.${table}`])).rows[0].r !== null;
const plain = await inventoryFixture({ extra: [] });
eq(await has(plain.db, 'recipes'), false, 'extra: [] = base migrations only (no 013 tables)');
eq(await has(plain.db, 'stock_item_units'), false, 'extra: [] = no 012 tables');
await plain.db.close();
const some = await inventoryFixture({ extra: [ALL_INVENTORY_MIGRATIONS[0]] });
eq([await has(some.db, 'stock_item_units'), await has(some.db, 'recipes')], [true, false], 'explicit list = exactly those migrations');
await some.db.close();
const all = await inventoryFixture();
eq([await has(all.db, 'stock_item_units'), await has(all.db, 'recipes')], [true, true], 'default = every inventory migration');
await all.db.close();

// ---- rig(): the people, branch and items Phase 2 suites share ----
const f = await rig();
const { db, ids, people, branches, items, contexts } = f;
eq(Object.keys(people).sort(), ['manager', 'manager2', 'ops', 'owner', 'owner2', 'waiter'], 'rig people');
eq(branches.branch2.restaurantId === ids.branchId, false, 'a second branch exists');
eq((await db.query(`select count(*)::int n from public.stock_locations where business_id = $1`, [ids.businessId])).rows[0].n, 3, 'warehouse + two branches');
const scope = (name) => inventoryScope(db, contexts[name], ids.businessId);
eq((await scope('owner')).role, 'owner', 'owner');
eq((await scope('owner2')).role, 'owner', 'second owner');
eq((await scope('manager2')).role, 'branch_manager', 'second branch manager');
const opsScope = await scope('ops');
eq(opsScope.role, 'operations', 'operations manager');
eq(new Set(opsScope.locationCaps.keys()), new Set([ids.centerLocationId, ids.branchLocationId]), 'operations manager: assigned branch + warehouse, not the second branch');
await setSetting(db, { businessId: ids.businessId, key: 'operations_can_approve', value: true, actorId: people.owner });
ok((await scope('ops')).locationCaps.get(ids.branchLocationId).has('inv.request.approve') && !opsScope.locationCaps.get(ids.branchLocationId).has('inv.request.approve'), 'operations_can_approve widens what the operations manager can do');

// ---- makeItem / receive / keyGen ----
const key = keyGen('h');
eq([key(), key()], ['h-1', 'h-2'], 'keyGen');
const rcv = await receive(db, { businessId: ids.businessId, locationId: ids.centerLocationId, itemId: items.flour, qty: '50000', unitCost: '0.08', actorId: people.owner });
eq(rcv.balance.onHand, '50000.0000', 'receive posts through the ledger');
eq((await balance(db, ids.centerLocationId, items.flour)).onHand, '50000.0000', 'balance');
eq(await reconcile(db, { businessId: ids.businessId }), [], 'reconciliation is clean');
const sack = (await db.query(`select factor::text f from public.stock_item_units where item_id = $1 and name = 'sack'`, [items.flour])).rows[0];
eq(sack.f, '25000.0000', 'item pack');
const custom = await makeItem(db, ids.businessId, 'Milk', { unit: 'ml', displayUnit: 'L', packs: [{ name: 'carton', factor: 500 }, { name: 'crate', factor: 12000 }] });
eq((await db.query(`select name from public.stock_item_units where item_id = $1 order by position`, [custom])).rows.map((r) => r.name), ['carton', 'crate'], 'pack order kept');

// ---- refuses() reports properly ----
await refuses(receive(db, { businessId: ids.businessId, locationId: ids.centerLocationId, itemId: items.flour, qty: '0', actorId: people.owner }), 400, 'zero_quantity', /zero/, 'zero quantity refused');

// ---- fake clock ----
const clock = fakeClock('2026-11-18T09:00:00+03:00');
eq(clock.iso(), '2026-11-18T06:00:00.000Z', 'clock starts where told');
clock.advance(5 * 60_000);
eq(clock.iso(), '2026-11-18T06:05:00.000Z', 'clock advances');
clock.advanceDays(1);
eq(clock.iso(), '2026-11-19T06:05:00.000Z', 'clock advances in days');

// ---- fake storage (D2-8 rules) ----
const storage = fakeStorage({ clock });
await refuses(storage.createSignedUpload({ path: 'a/b.exe', contentType: 'application/x-msdownload', size: 10 }), 400, 'bad_file_type', undefined, 'wrong type refused');
await refuses(storage.createSignedUpload({ path: 'a/b.jpg', contentType: 'image/jpeg', size: 9 * 1024 * 1024 }), 400, 'file_too_big', undefined, 'over 8 MB refused');
const up = await storage.createSignedUpload({ path: 'inv/1/photo.jpg', contentType: 'image/jpeg', size: 1000 });
eq(await storage.exists(up.path), false, 'nothing stored before the browser uploads');
await storage.put(up.path, up.token, Buffer.alloc(900));
eq(await storage.head(up.path), { contentType: 'image/jpeg', size: 900 }, 'stored');
await refuses(storage.put(up.path, up.token, Buffer.alloc(10)), 400, 'upload_token_used', undefined, 'upload link works once');
const view = await storage.createSignedUrl(up.path, 300);
eq(storage.verify(view.url), true, 'signed url valid now');
clock.advance(301_000);
eq(storage.verify(view.url), false, 'signed url dead after 5 minutes');
const late = await storage.createSignedUpload({ path: 'inv/1/late.pdf', contentType: 'application/pdf', size: 100 });
clock.advance(11 * 60_000);
await refuses(storage.put(late.path, late.token, Buffer.alloc(5)), 400, 'upload_token_expired', undefined, 'upload link expires after 10 minutes');

console.log(`Phase 2 harness: ${count()} checks passed.`);
await db.close();
