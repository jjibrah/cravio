// Permissions, policies and audit (P1-07). Runs against a throwaway in-memory database.
// Usage: node backend/tests/inv/permissions.test.js
import assert from 'node:assert/strict';
import { inventoryFixture } from './fixture.js';
import { createUser } from '../support/pg.js';
import { branchLocation } from '../../src/stock/service.js';
import { CAPABILITIES, BUSINESS_CAPABILITIES, ROLE_DEFAULTS, inventoryScope, can, requireCan, authorize, assertDifferentPeople, locationsWith } from '../../src/inventory/permissions.js';
import { SETTINGS, getSetting, getSettings, setSetting, resetSetting } from '../../src/inventory/policies.js';
import { record, diff, MAX_JSON_BYTES } from '../../src/inventory/audit.js';

let checks = 0;
const ok = (value, m) => { assert.ok(value, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const rejects = async (fn, status, code, m) => {
  await assert.rejects(fn, (e) => { assert.equal(e.status, status, m); if (code) assert.equal(e.details?.code, code, m); return true; }, m);
  checks++;
};
const throwsSync = (fn, status, code, m) => {
  assert.throws(fn, (e) => { assert.equal(e.status, status, m); assert.equal(e.details?.code, code, m); return true; }, m);
  checks++;
};

const f = await inventoryFixture({ extra: ['migrations/012_inventory_catalogue.sql'] });
const { db, ids, users } = f;
const { businessId, branchId, centerLocationId, branchLocationId } = ids;

// A second branch with its own manager, plus an operations manager assigned to branch 1 only.
const branch2 = (await db.query(`insert into public.restaurants (owner_id, name, status, business_id, owner_primary) values ($1, 'Second branch', 'live', $2, false) returning id`, [users.owner, businessId])).rows[0].id;
const branch2Location = await f.helpers.tx((t) => branchLocation(t, branch2));
const manager2 = await createUser(db, 'manager2@example.test', { role: 'owner' });
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'manager')`, [branch2, manager2]);
const ops = await createUser(db, 'ops@example.test', { role: 'owner' });
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'operations')`, [businessId, ops]);
await db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessId, ops, branchId]);
const stranger = await createUser(db, 'stranger@example.test', { role: 'owner' });
const admin = await createUser(db, 'admin@example.test', { role: 'admin' });

// What lib/auth.js requireUser() would hand back for each person.
const ctx = (userId, { role = 'owner', memberships = [], grants = [] } = {}) => ({
  user: { id: userId }, profile: { role }, memberships: memberships.map(([rid, r]) => ({ role: r, restaurant: { id: rid } })), grants,
});
const contexts = {
  owner: ctx(users.owner, { memberships: [[branchId, 'owner']], grants: [{ businessId, role: 'owner', branchIds: null }] }),
  opsAssigned: ctx(ops, { grants: [{ businessId, role: 'operations', branchIds: [branchId] }] }),
  manager1: ctx(users.manager, { memberships: [[branchId, 'manager']] }),
  manager2: ctx(manager2, { memberships: [[branch2, 'manager']] }),
  waiter: ctx(users.waiter, { role: 'waiter', memberships: [[branchId, 'waiter']] }),
  admin: ctx(admin, { role: 'admin' }),
  stranger: ctx(stranger),
};

await db.query('update public.businesses set inventory_enabled = true where id = $1', [businessId]);
const scopes = {};
for (const [name, context] of Object.entries(contexts)) scopes[name] = await inventoryScope(db, context, businessId);

// --- Role summary and location mapping ---
eq(Object.fromEntries(Object.entries(scopes).map(([n, s]) => [n, s.role])),
  { owner: 'owner', opsAssigned: 'operations', manager1: 'branch_manager', manager2: 'branch_manager', waiter: 'waiter', admin: 'admin', stranger: 'none' }, 'roles');
eq(scopes.owner.locations.length, 3, 'warehouse + two branches');
eq(scopes.owner.centerLocationId, centerLocationId, 'warehouse id');
eq([...scopes.manager1.locationCaps.keys()], [branchLocationId], 'branch manager sees only their own location');
eq(new Set(scopes.opsAssigned.locationCaps.keys()), new Set([centerLocationId, branchLocationId]), 'operations: assigned branch + warehouse');

// --- Capability matrix ---
const L = { center: centerLocationId, b1: branchLocationId, b2: branch2Location };
// Business-wide capabilities (item.edit, settings.edit) ignore the location, so they are checked separately.
const allowed = (scope, loc) => CAPABILITIES.filter((c) => !BUSINESS_CAPABILITIES.includes(c) && can(scope, c, { locationId: loc }));
const set = (list) => new Set(list);
eq(set(allowed(scopes.owner, L.b1)), set(CAPABILITIES.filter((c) => !BUSINESS_CAPABILITIES.includes(c))), 'owner: everything at branch 1');
ok(BUSINESS_CAPABILITIES.every((c) => can(scopes.owner, c)), 'owner: catalogue and settings');
eq(set(allowed(scopes.owner, L.b2)), set(CAPABILITIES.filter((c) => !BUSINESS_CAPABILITIES.includes(c))), 'owner: everything at branch 2');
eq(set(allowed(scopes.owner, L.center)), set(CAPABILITIES.filter((c) => !BUSINESS_CAPABILITIES.includes(c))), 'owner: everything at the warehouse');
eq(set(allowed(scopes.opsAssigned, L.b1)), set(['inv.view', 'inv.cost.view', 'inv.report.view', 'inv.availability.view']), 'operations: oversight on assigned branch (approvals off)');
eq(allowed(scopes.opsAssigned, L.b2), [], 'operations: nothing at an unassigned branch');
eq(set(allowed(scopes.opsAssigned, L.center)), set(['inv.view', 'inv.cost.view', 'inv.report.view']), 'operations: warehouse read-only');
ok(!can(scopes.opsAssigned, 'inv.item.edit') && !can(scopes.opsAssigned, 'inv.settings.edit'), 'operations: no catalogue or settings');
eq(set(allowed(scopes.manager1, L.b1)), set(ROLE_DEFAULTS.branch_manager), 'branch manager: own branch');
ok(can(scopes.manager1, 'inv.item.edit'), 'branch manager: item.edit via branch_can_add_items (default on)');
eq(allowed(scopes.manager1, L.b2), [], 'branch manager: nothing at another branch');
eq(allowed(scopes.manager1, L.center), [], 'branch manager: nothing at the warehouse');
for (const cap of ['inv.adjust.approve', 'inv.request.approve', 'inv.emergency.approve', 'inv.count.approve', 'inv.purchase.create', 'inv.transfer.dispatch', 'inv.settings.edit']) {
  ok(!can(scopes.manager1, cap, { locationId: L.b1 }), `branch manager can't ${cap}`);
}
eq(allowed(scopes.waiter, L.b1), ['inv.availability.view'], 'waiter: availability only');
eq(allowed(scopes.waiter, L.b2), [], 'waiter: nothing at another branch');
for (const name of ['admin', 'stranger']) {
  for (const loc of [L.b1, L.center, null]) eq(CAPABILITIES.filter((c) => can(scopes[name], c, { locationId: loc })), [], `${name}: nothing`);
}
ok(can(scopes.manager1, 'inv.view') && !can(scopes.manager1, 'inv.adjust.approve'), 'no location named = "ever"');
eq(locationsWith(scopes.manager2, 'inv.stock.record'), [L.b2], 'locationsWith');
ok(!can(scopes.owner, 'inv.view', { locationId: '00000000-0000-0000-0000-000000000001' }), 'unknown location is denied even for the owner');
assert.throws(() => can(scopes.owner, 'inv.bogus'), TypeError); checks++;

// Settings change who can do what.
await setSetting(db, { businessId, key: 'branch_can_add_items', value: false, actorId: users.owner, actorRole: 'owner' });
const manager1NoItems = await inventoryScope(db, contexts.manager1, businessId);
ok(!can(manager1NoItems, 'inv.item.edit') && can(manager1NoItems, 'inv.stock.record', { locationId: L.b1 }), 'branch_can_add_items=false removes item.edit only');
await resetSetting(db, { businessId, key: 'branch_can_add_items', actorId: users.owner });
await setSetting(db, { businessId, key: 'operations_can_approve', value: true, actorId: users.owner });
const opsApprover = await inventoryScope(db, contexts.opsAssigned, businessId);
ok(can(opsApprover, 'inv.request.approve', { locationId: L.b1 }) && can(opsApprover, 'inv.adjust.approve', { locationId: L.b1 }), 'operations_can_approve grants approvals on assigned branch');
ok(!can(opsApprover, 'inv.request.approve', { locationId: L.b2 }) && !can(opsApprover, 'inv.request.approve', { locationId: L.center }), '...but not elsewhere');
await resetSetting(db, { businessId, key: 'operations_can_approve', actorId: users.owner });

// A person holding two roles gets the union.
const both = await inventoryScope(db, ctx(users.manager, { memberships: [[branchId, 'manager']], grants: [{ businessId, role: 'operations', branchIds: [branchId] }] }), businessId);
eq(both.roles, ['operations', 'branch_manager'], 'two roles, highest first');
ok(can(both, 'inv.stock.record', { locationId: L.b1 }), 'union includes branch manager caps');

// A grant for some other business gives nothing here.
const other = await inventoryScope(db, ctx(users.owner, { grants: [{ businessId: '11111111-1111-1111-1111-111111111111', role: 'owner', branchIds: null }] }), businessId);
eq(other.role, 'none', 'foreign grant is ignored');
await rejects(() => inventoryScope(db, contexts.owner, '11111111-1111-1111-1111-111111111111'), 404, undefined, 'unknown business 404');

// --- T-SEC-1: wrong branch -> 403 and an audit event ---
const deniedBefore = (await db.query(`select count(*)::int n from public.inventory_events where action = 'denied'`)).rows[0].n;
await rejects(() => authorize(db, scopes.manager1, 'inv.stock.record', { locationId: L.b2, entity: 'stock_count', entityId: null }), 403, 'forbidden', 'T-SEC-1 403');
const denied = (await db.query(`select * from public.inventory_events where action = 'denied' order by id desc limit 1`)).rows[0];
eq((await db.query(`select count(*)::int n from public.inventory_events where action = 'denied'`)).rows[0].n, deniedBefore + 1, 'one denied event');
eq([denied.actor_id, denied.actor_role, denied.location_id, denied.business_id, denied.entity], [users.manager, 'branch_manager', L.b2, businessId, 'stock_count'], 'denied event fields');
eq(denied.after, { capability: 'inv.stock.record', locationId: L.b2 }, 'denied event payload');
await authorize(db, scopes.manager1, 'inv.stock.record', { locationId: L.b1 }); checks++;
await rejects(() => authorize(db, scopes.waiter, 'inv.view', { locationId: L.b1 }), 403, 'forbidden', 'waiter cannot view stock');
throwsSync(() => requireCan(scopes.admin, 'inv.view', { locationId: L.b1 }), 403, 'forbidden', 'admin refused');
throwsSync(() => requireCan(scopes.opsAssigned, 'inv.adjust.create', { locationId: L.b1 }), 403, 'forbidden', 'operations cannot record');

// --- T-SEC-2: maker-checker ---
throwsSync(() => assertDifferentPeople(users.manager, users.manager), 403, 'maker_checker', 'same person');
assert.throws(() => assertDifferentPeople(users.manager.toUpperCase(), users.manager), /You can’t approve something you created\. Ask another manager\./); checks++;
assertDifferentPeople(users.manager, users.owner); assertDifferentPeople(null, users.owner); checks += 2;

// --- inventory_enabled ---
await db.query('update public.businesses set inventory_enabled = false where id = $1', [businessId]);
const off = await inventoryScope(db, contexts.owner, businessId);
const offManager = await inventoryScope(db, contexts.manager1, businessId);
eq(off.enabled, false, 'scope.enabled false');
throwsSync(() => requireCan(off, 'inv.view', { locationId: L.b1 }), 403, 'inventory_disabled', 'owner blocked while off');
throwsSync(() => requireCan(offManager, 'inv.stock.record', { locationId: L.b1 }), 403, 'inventory_disabled', 'manager blocked while off');
assert.throws(() => requireCan(off, 'inv.view'), /Inventory isn’t switched on for this business yet\./); checks++;
ok(can(off, 'inv.settings.edit', { allowDisabled: true }), 'owner can reach setup while off');
ok(!can(off, 'inv.settings.edit'), 'but can() is false by default while off');
await rejects(() => authorize(db, off, 'inv.view', { locationId: L.b1 }), 403, 'inventory_disabled', 'authorize: disabled');
throwsSync(() => requireCan(scopes.admin, 'inv.view'), 403, 'forbidden', 'admin is forbidden, not "disabled"');
await db.query('update public.businesses set inventory_enabled = true where id = $1', [businessId]);
requireCan(await inventoryScope(db, contexts.owner, businessId), 'inv.view', { locationId: L.b1 }); checks++;

// --- Settings ---
eq(await getSetting(db, businessId, 'count_tolerance_pct'), null, 'default: not set (D2-16: no built-in 3 %)');
eq(await getSetting(db, businessId, 'wastage_approval_value_kes'), null, 'null default');
eq(Object.keys(await getSettings(db, businessId)).sort(), Object.keys(SETTINGS).sort(), 'all keys present');
await setSetting(db, { businessId, key: 'count_tolerance_pct', value: 5, actorId: users.owner, actorRole: 'owner' });
eq(await getSetting(db, businessId, 'count_tolerance_pct'), 5, 'business override');
eq(await getSetting(db, businessId, 'count_tolerance_pct', L.b1), 5, 'location inherits business');
await setSetting(db, { businessId, locationId: L.b1, key: 'count_tolerance_pct', value: 1.5, actorId: users.owner, actorRole: 'owner' });
eq(await getSetting(db, businessId, 'count_tolerance_pct', L.b1), 1.5, 'location override wins');
eq(await getSetting(db, businessId, 'count_tolerance_pct', L.b2), 5, 'other location unaffected');
eq((await getSettings(db, businessId, L.b1)).count_tolerance_pct, 1.5, 'getSettings applies precedence');
eq(await getSetting(db, businessId, 'count_tolerance_pct'), 5, 'business value unchanged by location override');
await setSetting(db, { businessId, key: 'count_tolerance_pct', value: 6, actorId: users.owner });
eq((await db.query(`select count(*)::int n from public.inventory_settings where key = 'count_tolerance_pct' and location_id is null`)).rows[0].n, 1, 'upsert keeps one row');
await setSetting(db, { businessId, key: 'wastage_approval_value_kes', value: 2500, actorId: users.owner });
await setSetting(db, { businessId, key: 'wastage_approval_value_kes', value: null, actorId: users.owner });
eq(await getSetting(db, businessId, 'wastage_approval_value_kes'), null, 'nullable can be cleared');
for (const [key, value] of [['count_tolerance_pct', 'lots'], ['count_tolerance_pct', 101], ['count_tolerance_pct', -1], ['low_alert_enabled', 'yes'], ['cost_method', 'fifo'],
  ['large_amount_warning_factor', 0.5], ['nope', 1], ['notify_on_zero', undefined], ['count_tolerance_pct', NaN]]) {
  await rejects(() => setSetting(db, { businessId, key, value, actorId: users.owner }), 400, 'invalid_setting', `refuse ${key}=${String(value)}`);
}
eq(await getSetting(db, businessId, 'count_tolerance_pct'), 6, 'refused values change nothing');
await rejects(() => setSetting(db, { businessId, locationId: '22222222-2222-2222-2222-222222222222', key: 'notify_on_zero', value: false }), undefined, undefined, 'unknown location refused by FK');
const audit = (await db.query(`select * from public.inventory_events where entity = 'setting' and location_id is null and after->>'key' = 'count_tolerance_pct' order by id`)).rows;
eq(audit.map((r) => r.action), ['create', 'update'], 'setting audit actions');
eq([audit[0].before, audit[0].after], [{ key: 'count_tolerance_pct', value: null, inherited: true }, { key: 'count_tolerance_pct', value: 5 }], 'first change before/after');
eq([audit[1].before.value, audit[1].after.value, audit[1].actor_id], [5, 6, users.owner], 'second change before/after');
eq(audit[0].actor_role, 'owner', 'actor role stored');
eq(await resetSetting(db, { businessId, locationId: L.b1, key: 'count_tolerance_pct', actorId: users.owner }), true, 'reset override');
eq(await getSetting(db, businessId, 'count_tolerance_pct', L.b1), 6, 'back to business value');
eq((await db.query(`select count(*)::int n from public.inventory_events where action = 'reset'`)).rows[0].n, 3, 'reset audited (incl. earlier test resets)');

// --- Audit ---
const id1 = await record(db, { businessId, locationId: L.b1, actorId: users.owner, actorRole: 'owner', entity: 'item', entityId: ids.categoryId, action: 'edit', before: { name: 'A', gone: undefined }, after: { name: 'B' } });
const ev = (await db.query('select * from public.inventory_events where id = $1', [id1])).rows[0];
eq([ev.before, ev.after, ev.entity, ev.action], [{ name: 'A' }, { name: 'B' }, 'item', 'edit'], 'record strips undefined');
const big = await record(db, { businessId, entity: 'item', action: 'import', after: { blob: 'x'.repeat(50000) } });
const bigRow = (await db.query('select after, length(after::text) len from public.inventory_events where id = $1', [big])).rows[0];
ok(bigRow.after._truncated === true && bigRow.len <= MAX_JSON_BYTES && bigRow.after.bytes > MAX_JSON_BYTES, 'oversized payload truncated with marker');
const circular = {}; circular.self = circular;
const odd = await record(db, { businessId, entity: 'item', action: 'weird', after: circular, before: { n: 10n } });
const oddRow = (await db.query('select before, after from public.inventory_events where id = $1', [odd])).rows[0];
eq([oddRow.after, oddRow.before], [{ _unserializable: true }, { n: '10' }], 'circular and bigint never throw');
const bare = await record(db, { businessId, entity: 'x'.repeat(100), action: 'y'.repeat(100), entityId: 'not-a-uuid', actorRole: 'r'.repeat(80) });
const bareRow = (await db.query('select * from public.inventory_events where id = $1', [bare])).rows[0];
eq([bareRow.entity.length, bareRow.action.length, bareRow.actor_role.length, bareRow.entity_id, bareRow.before, bareRow.after], [60, 60, 40, null, null, null], 'long text clipped, bad id nulled');
await assert.rejects(() => db.query(`update public.inventory_events set action = 'x' where id = $1`, [id1]), /append-only/); checks++;
await assert.rejects(() => db.query('delete from public.inventory_events where id = $1', [id1]), /append-only/); checks++;
await assert.rejects(() => record(db, { businessId, action: 'a' }), TypeError); checks++;
eq(diff({ a: 1, b: { x: 1 }, c: 'same', d: 4 }, { a: 2, b: { x: 1 }, c: 'same', e: 5 }),
  { before: { a: 1, d: 4 }, after: { a: 2, e: 5 }, changed: ['a', 'd', 'e'] }, 'diff keeps only changed keys');
eq(diff({ a: 1 }, { a: 1 }).changed, [], 'no change');
eq(diff(null, { a: 1 }), { before: {}, after: { a: 1 }, changed: ['a'] }, 'diff from nothing');

console.log(`Permissions, policies & audit: ${checks} checks passed.`);
process.exit(0);
