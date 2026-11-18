// P1-17: the platform admin's Inventory on/off switch. Entitlement only, audited in access_events, idempotent.
// Usage: node backend/tests/inv/admin-toggle.test.js
import assert from 'node:assert/strict';
import { createUser, freshDatabase } from '../support/pg.js';
import { BASE_MIGRATIONS } from './migrations.js';
import { inventoryFixture } from './fixture.js';
import { activity, businessDetail, listBusinesses, setInventoryEnabled } from '../../src/lib/admin-business.js';
import { inventoryScope } from '../../src/inventory/permissions.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fails = async (promise, status, m) => { await assert.rejects(promise, (e) => { assert.equal(e.status, status, `${m}: ${e.status} ${e.message}`); return true; }); checks++; };

const { db, ids, users } = await inventoryFixture({ extra: ['migrations/012_inventory_catalogue.sql'] });
const { businessId } = ids;
const adminId = await createUser(db, 'admin@example.test', { role: 'admin' });
const ctx = (id, role, extra = {}) => ({ user: { id }, profile: { role }, memberships: [], grants: [], ...extra });
const admin = ctx(adminId, 'admin');
const owner = ctx(users.owner, 'owner', { memberships: [{ role: 'owner', restaurant: { id: ids.branchId } }], grants: [{ businessId, role: 'owner', branchIds: null }] });
const manager = ctx(users.manager, 'owner', { memberships: [{ role: 'manager', restaurant: { id: ids.branchId } }] });
const toggle = (who, enabled, opts, id = businessId) => db.transaction((t) => setInventoryEnabled(t, who, id, enabled, opts));
const events = async () => (await db.query(`select action, actor_id, business_id, detail from public.access_events where action like 'inventory_%' order by id`)).rows;

// Starts off, and the list/detail say so
eq((await listBusinesses(db)).businesses[0].inventoryEnabled, false, 'list: off by default');
eq((await businessDetail(db, businessId)).inventoryEnabled, false, 'detail: off by default');
eq((await inventoryScope(db, owner, businessId)).enabled, false, 'owner scope: disabled before the switch');

// Refusals
await fails(toggle(owner, true), 403, 'owner cannot switch');
await fails(toggle(manager, true), 403, 'branch manager cannot switch');
await fails(toggle(ctx(users.waiter, 'waiter'), true), 403, 'waiter cannot switch');
await fails(toggle(admin, true, {}, '00000000-0000-4000-8000-000000000000'), 404, 'unknown business');
await fails(toggle(admin, true, {}, 'not-an-id'), 400, 'bad id');
await fails(toggle(admin, 'yes'), 400, 'enabled must be a boolean');
await fails(toggle(admin, true, { reason: 'x'.repeat(281) }), 400, 'reason too long');
eq(await events(), [], 'refused calls wrote nothing');
eq((await inventoryScope(db, owner, businessId)).enabled, false, 'still off after refusals');

// Switch on, with a reason
eq(await toggle(admin, true, { reason: '  Pilot   with the owner ' }), { id: businessId, inventoryEnabled: true, changed: true }, 'switched on');
eq((await inventoryScope(db, owner, businessId)).enabled, true, 'owner scope: enabled after the switch');
eq((await businessDetail(db, businessId)).inventoryEnabled, true, 'detail: on');
eq((await listBusinesses(db)).businesses[0].inventoryEnabled, true, 'list: on');
let log = await events();
eq([log.length, log[0].action, log[0].actor_id, log[0].business_id, log[0].detail], [1, 'inventory_enabled', adminId, businessId, { note: 'Pilot with the owner', by: 'platform_admin' }], 'one audit event with actor, business and note');

// Idempotent repeat: no second event
eq((await toggle(admin, true)).changed, false, 'repeat on reports no change');
eq((await events()).length, 1, 'repeat on writes no event');

// Switch off: stock data is untouched, one more event
await db.query(`insert into public.stock_items (business_id, name) values ($1, 'Buns')`, [businessId]);
eq((await toggle(admin, false)).inventoryEnabled, false, 'switched off');
eq((await toggle(admin, false)).changed, false, 'repeat off reports no change');
eq([(await events()).map((e) => e.action), Number((await db.query('select count(*) as n from public.stock_items')).rows[0].n)], [['inventory_enabled', 'inventory_disabled'], 1], 'two events; nothing deleted');
eq((await inventoryScope(db, owner, businessId)).enabled, false, 'owner scope: disabled again');

// Activity wording, and counts only in the detail (no stock records or costs)
const feed = await activity(db, { businessId });
eq([feed[0].text, feed[1].text, feed[1].note, feed[1].viaAdmin], ['switched Inventory off', 'switched Inventory on', 'Pilot with the owner', true], 'activity reads in plain words');
eq(Object.keys((await businessDetail(db, businessId)).stock).sort(), ['inTransit', 'items', 'out', 'requestsWaiting', 'shortDeliveries30d', 'trackedDishes'], 'detail exposes counts only');

// Without 012 the column is missing: nulls on read, plain 503 on write
const old = await freshDatabase({ migrations: [...BASE_MIGRATIONS] });
const oldAdmin = await createUser(old, 'admin@example.test', { role: 'admin' });
const oldOwner = await createUser(old, 'o@example.test', { role: 'owner' });
const oldBranch = (await old.query(`insert into public.restaurants (owner_id, name, status) values ($1, 'B', 'live') returning business_id`, [oldOwner])).rows[0];
eq((await listBusinesses(old)).businesses[0].inventoryEnabled, null, 'no 012: list says null');
eq((await businessDetail(old, oldBranch.business_id)).inventoryEnabled, null, 'no 012: detail says null');
await fails(old.transaction((t) => setInventoryEnabled(t, ctx(oldAdmin, 'admin'), oldBranch.business_id, true)), 503, 'no 012: 503');

console.log(`Admin inventory switch: ${checks} checks passed (disposable PGlite databases).`);
