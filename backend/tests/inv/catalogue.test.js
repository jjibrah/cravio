// Catalogue & locations service and the owner API (P1-08). Runs against a throwaway in-memory database.
// The route tests run the REAL handlers from routes/inventory-owner.js (createRoutes) with injected dependencies:
// `authenticate` maps a fake Authorization header to a hand-made requireUser() context (no token service needed),
// `pool` is the PGlite database and `transact` is PGlite's transaction (commit, or roll back when the handler throws).
// Usage: node backend/tests/inv/catalogue.test.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inventoryFixture } from './fixture.js';
import { createUser } from '../support/pg.js';
import { branchLocation } from '../../src/stock/service.js';
import { createRoutes } from '../../src/routes/inventory-owner.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import * as ledger from '../../src/inventory/ledger.js';
import * as catalogue from '../../src/inventory/catalogue.js';
import { getWarehouse, listLocations } from '../../src/inventory/locations.js';
import { DEFAULT_CATEGORIES } from '../../src/inventory/catalogue.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const refuses = async (promise, status, code, pattern, m) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status, `${m}: status (${e.message})`);
    if (code) assert.equal(e.details?.code, code, `${m}: code (${e.message})`);
    if (pattern) assert.match(e.message, pattern, `${m}: message`);
    return true;
  }, m);
  checks++;
};

const f = await inventoryFixture({ extra: ['migrations/012_inventory_catalogue.sql'] });
const { db, ids, users } = f;
const { businessId, branchId, centerLocationId, branchLocationId } = ids;
const tx = (fn) => db.transaction(fn);
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

// A second branch and its manager, an operations manager for branch 1, and a stranger.
const branch2 = (await db.query(`insert into public.restaurants (owner_id, name, status, business_id, owner_primary) values ($1, 'Second branch', 'live', $2, false) returning id`, [users.owner, businessId])).rows[0].id;
const branch2Location = await tx((t) => branchLocation(t, branch2));
const manager2 = await createUser(db, 'manager2@example.test', { role: 'owner' });
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'manager')`, [branch2, manager2]);
const ops = await createUser(db, 'ops@example.test', { role: 'owner' });
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'operations')`, [businessId, ops]);
await db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessId, ops, branchId]);
const stranger = await createUser(db, 'stranger@example.test', { role: 'owner' });
const admin = await createUser(db, 'admin@example.test', { role: 'admin' });

const ctx = (userId, { role = 'owner', memberships = [], grants = [] } = {}) => ({
  user: { id: userId }, profile: { role }, memberships: memberships.map(([rid, r]) => ({ role: r, restaurant: { id: rid } })), grants,
});
const contexts = {
  owner: ctx(users.owner, { memberships: [[branchId, 'owner']], grants: [{ businessId, role: 'owner', branchIds: null }] }),
  ops: ctx(ops, { grants: [{ businessId, role: 'operations', branchIds: [branchId] }] }),
  manager: ctx(users.manager, { memberships: [[branchId, 'manager']] }),
  manager2: ctx(manager2, { memberships: [[branch2, 'manager']] }),
  waiter: ctx(users.waiter, { role: 'waiter', memberships: [[branchId, 'waiter']] }),
  stranger: ctx(stranger),
  admin: ctx(admin, { role: 'admin' }),
};

// ---- Route harness: the real route table, with the database and the identity injected ----
const routes = createRoutes({
  authenticate: async (request) => {
    const who = request.headers.authorization?.replace(/^Bearer /, '');
    if (!contexts[who]) { const { HttpError } = await import('../../src/lib/http.js'); throw new HttpError(401, 'Please sign in to continue.'); }
    return contexts[who];
  },
  pool: () => db,
  transact: (fn) => db.transaction(fn),
});
const api = async (as, method, pathname, body, query = '') => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    return route.handler({ request: { headers: { authorization: `Bearer ${as}` } }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const base = `/api/owner/inventory/${businessId}`;

const scopeOf = (who, opts) => inventoryScope(db, contexts[who], businessId, opts);

// =============================================================================================================
// 0. Switched off by default
// =============================================================================================================
{
  const minimal = await api('owner', 'GET', base);
  eq(minimal.enabled, false, 'owner gets the minimal "switch on" answer');
  eq(minimal.items, [], 'no items listed while off');
  ok(/switched on/.test(minimal.message), 'plain message');
  await refuses(api('manager', 'GET', base), 403, 'inventory_disabled', /switched on/, 'manager is refused while off');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Nope', baseUnit: 'weight' }), 403, 'inventory_disabled', null, 'owner cannot write while off');
  await refuses(api('stranger', 'GET', base), 403, 'forbidden', null, 'stranger');
  await refuses(api('admin', 'GET', base), 403, 'forbidden', null, 'admin never sees stock');
  await refuses(api('nobody', 'GET', base), 401, null, null, 'not signed in');
}
await db.query('update public.businesses set inventory_enabled = true where id = $1', [businessId]);

// =============================================================================================================
// 1. Warehouse and locations
// =============================================================================================================
{
  const owner = await scopeOf('owner', { ensureLocations: true });
  const w = await tx((t) => getWarehouse(t, businessId));
  eq(w.id, centerLocationId, 'the warehouse is the 009 center');
  eq(w.label, 'Warehouse', 'labelled Warehouse');
  eq((await listLocations(db, owner)).map((l) => l.kind).sort(), ['branch', 'branch', 'center'], 'warehouse + two branches for the owner');
  const mgr = await scopeOf('manager');
  eq((await listLocations(db, mgr)).map((l) => l.id), [branchLocationId], 'a branch manager sees only their branch');
  const opsScope = await scopeOf('ops');
  eq((await listLocations(db, opsScope)).map((l) => l.id).sort(), [branchLocationId, centerLocationId].sort(), 'operations: warehouse (read only) + assigned branch');
  eq(branch2Location !== branchLocationId, true, 'second branch has its own location');

  const renamed = await api('owner', 'PATCH', `${base}/warehouse`, { name: ' Main  store ', code: 'wh1' });
  eq([renamed.name, renamed.code], ['Main store', 'wh1'], 'renamed, spaces tidied');
  await refuses(api('owner', 'PATCH', `${base}/warehouse`, { name: '' }), 400, 'name_required', /Enter a name/, 'blank name');
  await refuses(api('manager', 'PATCH', `${base}/warehouse`, { name: 'Mine now' }), 403, 'forbidden', null, 'manager cannot rename');
  await refuses(api('ops', 'PATCH', `${base}/warehouse`, { name: 'Mine now' }), 403, 'forbidden', null, 'operations cannot rename');
  await db.query(`update public.stock_locations set code = 'B1' where id = $1`, [branchLocationId]);
  await refuses(api('owner', 'PATCH', `${base}/warehouse`, { code: 'b1' }), 409, 'code_taken', /already used/, 'code clash');
  eq(await api('owner', 'PATCH', `${base}/warehouse`, { code: null }).then((r) => r.code), null, 'code cleared');
  const ev = await one(`select before, after from public.inventory_events where entity = 'warehouse' and action = 'update' order by id limit 1`);
  eq([ev.before, ev.after], [{ code: null, name: 'Main center' }, { code: 'wh1', name: 'Main store' }], 'warehouse audit diff');
}

// =============================================================================================================
// 2. Items: create, validation, duplicates
// =============================================================================================================
let rice;
{
  const cmd = randomUUID();
  rice = await api('owner', 'POST', `${base}/items`, {
    commandId: cmd, name: '  Basmati   rice ', baseUnit: 'weight', displayUnit: 'kg', sku: 'RICE-1', kind: 'raw', storage: 'dry',
    units: [{ name: 'crate', factor: { quantity: 10, unit: 'kg' }, forPurchase: true, forRecipe: false, forCount: true }],
    lowLevel: '5 kg', yieldPct: 100, vatClass: 'zero', notes: 'Pishori',
  });
  eq([rice.name, rice.baseUnit, rice.measuredBy, rice.displayUnit], ['Basmati rice', 'g', 'weight', 'kg'], 'created in weight, shown in kg');
  eq(rice.units.map((u) => [u.name, u.factor, u.size]), [['crate', '10000.0000', '10 kg']], 'a crate is 10 kg, stored in grams');
  eq(rice.lowLevel, '5000.0000', 'low level 5 kg stored as 5000 g');
  eq([rice.vatClass, rice.storage, rice.sku], ['zero', 'dry', 'RICE-1'], 'other fields');

  const again = await api('owner', 'POST', `${base}/items`, { commandId: cmd, name: 'Basmati rice', baseUnit: 'weight' });
  eq(again.id, rice.id, 'same commandId returns the first result');
  eq((await one(`select count(*)::int as n from public.stock_items where lower(name) = 'basmati rice'`)).n, 1, 'only one item was created');
  await refuses(api('owner', 'POST', `${base}/categories`, { commandId: cmd, name: 'X' }), 409, 'command_conflict', /already used/, 'a command id is for one kind of action');
  const aud = await one(`select actor_role, after from public.inventory_events where entity = 'item' and action = 'create' and entity_id = $1`, [rice.id]);
  eq(aud.actor_role, 'owner', 'audited with the actor role');
  eq(aud.after.name, 'Basmati rice', 'create audit has the new values');

  await refuses(api('owner', 'POST', `${base}/items`, { name: 'BASMATI RICE', baseUnit: 'weight' }), 409, 'name_taken', /already a stock item/, 'duplicate name, any case');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Rice 2', baseUnit: 'weight', sku: 'rice-1' }), 409, 'sku_taken', /already belongs/, 'duplicate SKU');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Milk', baseUnit: 'volume', displayUnit: 'kg' }), 400, 'unit_mismatch', /measured by volume/, 'display unit of another kind');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Milk', baseUnit: 'volume', displayUnit: 'crate' }), 400, 'bad_display_unit', /isn’t a unit/, 'a unit the item does not have');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Milk', baseUnit: 'kg' }), 400, 'bad_base_unit', /weight, volume, count or servings/, 'base unit must be a plain kind');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Milk' }), 400, 'bad_base_unit', null, 'base unit required');
  await refuses(api('owner', 'POST', `${base}/items`, { name: '', baseUnit: 'count' }), 400, 'name_required', null, 'name required');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'x'.repeat(81), baseUnit: 'count' }), 400, 'name_too_long', null, 'name length');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Milk', baseUnit: 'volume', yieldPct: 0 }), 400, 'bad_yield', /more than 0/, 'yield 0');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Milk', baseUnit: 'volume', yieldPct: 101 }), 400, 'bad_yield', null, 'yield over 100');
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Milk', baseUnit: 'volume', kind: 'nope' }), 400, 'bad_choice', null, 'kind');
  eq((await one(`select count(*)::int as n from public.stock_items where lower(name) = 'milk'`)).n, 0, 'refused creates left nothing behind');
}
const milk = await api('owner', 'POST', `${base}/items`, { name: 'Milk', baseUnit: 'litres'.replace('litres', 'volume'), displayUnit: 'l', yieldPct: 85.5 });
eq([milk.baseUnit, milk.displayUnit, milk.yieldPct], ['ml', 'l', 85.5], 'volume item shown in litres, yield kept');
const eggs = await api('owner', 'POST', `${base}/items`, { name: 'Eggs', baseUnit: 'count', displayUnit: 'piece' });
eq(eggs.baseUnit, 'piece', 'count -> piece');
const meals = await api('owner', 'POST', `${base}/items`, { name: 'Chef meal', baseUnit: 'servings' });
eq(meals.baseUnit, 'serving', 'servings -> serving');
eq((await api('owner', 'POST', `${base}/items`, { name: 'Flour', baseUnit: 'g' })).baseUnit, 'g', 'a code is accepted too');

// =============================================================================================================
// 3. Editing, audit diffs, base-unit lock
// =============================================================================================================
{
  const edited = await api('owner', 'PATCH', `${base}/items/${rice.id}`, { name: 'Basmati rice 5kg', notes: null, vatClass: 'exempt', lowLevel: { quantity: 8, unit: 'kg' } });
  eq([edited.name, edited.notes, edited.vatClass, edited.lowLevel], ['Basmati rice 5kg', null, 'exempt', '8000.0000'], 'edited');
  const ev = await one(`select before, after from public.inventory_events where entity = 'item' and action = 'update' and entity_id = $1 order by id desc limit 1`, [rice.id]);
  eq(ev.before, { name: 'Basmati rice', notes: 'Pishori', vatClass: 'zero', lowLevel: '5000.0000' }, 'audit has only the changed keys (before)');
  eq(ev.after, { name: 'Basmati rice 5kg', notes: null, vatClass: 'exempt', lowLevel: '8000.0000' }, 'audit has only the changed keys (after)');
  const before = (await one(`select count(*)::int as n from public.inventory_events where entity_id = $1`, [rice.id])).n;
  await api('owner', 'PATCH', `${base}/items/${rice.id}`, { name: 'Basmati rice 5kg' });
  eq((await one(`select count(*)::int as n from public.inventory_events where entity_id = $1`, [rice.id])).n, before, 'an edit that changes nothing writes no audit row');
  await api('owner', 'PATCH', `${base}/items/${rice.id}`, { name: 'Basmati rice' });
  await refuses(api('owner', 'PATCH', `${base}/items/${rice.id}`, { name: 'milk' }), 409, 'name_taken', null, 'rename onto another item');
  await refuses(api('owner', 'PATCH', `${base}/items/${rice.id}`, { displayUnit: 'l' }), 400, 'unit_mismatch', null, 'edit display unit to wrong kind');
  await refuses(api('owner', 'PATCH', `${base}/items/${randomUUID()}`, { name: 'Ghost' }), 404, 'item_not_found', /isn’t in this business/, 'unknown item');

  // Base unit: free while there is no history, locked after the first movement.
  const loose = await api('owner', 'POST', `${base}/items`, { name: 'Loose', baseUnit: 'count' });
  eq((await api('owner', 'PATCH', `${base}/items/${loose.id}`, { baseUnit: 'weight' })).baseUnit, 'g', 'base unit can change before any movement');
  await tx((t) => ledger.post(t, { businessId, locationId: centerLocationId, itemId: loose.id, qty: '10', reason: 'opening', idempotencyKey: 'loose-open', actorId: users.owner }));
  await refuses(api('owner', 'PATCH', `${base}/items/${loose.id}`, { baseUnit: 'volume' }), 409, 'unit_locked', /already has stock history/, 'base unit locked after a movement');
  eq((await api('owner', 'PATCH', `${base}/items/${loose.id}`, { baseUnit: 'weight' })).baseUnit, 'g', 'same unit again is not a change');
  eq((await one('select unit from public.stock_items where id = $1', [loose.id])).unit, 'g', 'unit untouched');
}

// =============================================================================================================
// 4. Item units, barcodes
// =============================================================================================================
{
  const sack = await api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [
    { name: 'crate', factor: '10 kg' }, { name: 'Sack', quantity: 25, unit: 'kg', forRecipe: false, forCount: false }] });
  eq(sack.units.map((u) => [u.name, u.factor, u.forCount]), [['crate', '10000.0000', true], ['Sack', '25000.0000', false]], 'units replaced; "10 kg" and {quantity, unit} both work');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'KG', factor: '1 kg' }] }), 400, 'unit_name_reserved', /standard unit/, 'cannot reuse a standard unit');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'tray', factor: '1 kg' }, { name: 'Tray', factor: '2 kg' }] }), 400, 'unit_name_duplicate', null, 'duplicate names');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'tray', factor: '0 kg' }] }), 400, 'not_positive', /more than zero/, 'size must be positive');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'tray', factor: '2 l' }] }), 400, 'unit_mismatch', null, 'a litre is not a weight');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'tray' }] }), 400, 'unit_size_required', /Say how much/, 'size needed');
  // The display unit cannot vanish on its own.
  await api('owner', 'PATCH', `${base}/items/${rice.id}`, { displayUnit: 'crate' });
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'Sack', factor: '25 kg' }] }), 409, 'display_unit_in_use', /how Basmati rice is shown/, 'cannot remove the display unit');
  const moved = await api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'Sack', factor: '25 kg' }], displayUnit: 'kg' });
  eq([moved.displayUnit, moved.units.map((u) => u.name)], ['kg', ['Sack']], 'removed once the display unit changes in the same call');
  await api('owner', 'PUT', `${base}/items/${rice.id}/units`, { units: [{ name: 'crate', factor: '10 kg' }, { name: 'Sack', factor: '25 kg' }] });
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'item' and action = 'units' and entity_id = $1`, [rice.id])).n >= 2, true, 'unit changes audited');

  const bc = await api('owner', 'PUT', `${base}/items/${rice.id}/barcodes`, { barcodes: ['6001', ' 6002 '] });
  eq(bc.barcodes, ['6001', '6002'], 'barcodes set');
  await refuses(api('owner', 'PUT', `${base}/items/${milk.id}/barcodes`, { barcodes: ['6002'] }), 409, 'barcode_taken', /belongs to “Basmati rice”/, 'barcode on another item');
  await refuses(api('owner', 'PUT', `${base}/items/${milk.id}/barcodes`, { barcodes: ['7', '7'] }), 400, 'barcode_duplicate', null, 'same barcode twice');
  eq((await api('owner', 'PUT', `${base}/items/${rice.id}/barcodes`, { barcodes: ['6001'] })).barcodes, ['6001'], 'replace-all removes the others');
  eq((await api('owner', 'GET', `${base}`, undefined, '?search=6001').catch(() => null)) === null, false, 'overview search by barcode works');
}

// =============================================================================================================
// 5. Levels
// =============================================================================================================
{
  const set = await api('owner', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [
    { locationId: centerLocationId, min: '5 kg', reorder: 10, par: { quantity: 2, unit: 'crate' }, max: '50 kg' },
    { locationId: branchLocationId, reorder: '1 kg' }] });
  const w = set.locations.find((l) => l.locationId === centerLocationId);
  eq(w.level, { min: '5000.0000', reorder: '10000.0000', par: '20000.0000', max: '50000.0000' }, 'entered in kg / crates, stored in grams');
  eq(w.levelDisplay.par, '20 kg · 2 crates', 'friendly display of a level');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: centerLocationId, min: '20 kg', reorder: '10 kg' }] }), 400, 'levels_order', /higher than the reorder level/, 'min above reorder');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: centerLocationId, par: '30 kg', max: '20 kg' }] }), 400, 'levels_order', null, 'par above max');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: centerLocationId, min: '-1 kg' }] }), 400, 'negative', null, 'negative level');
  await refuses(api('owner', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: centerLocationId, min: '5 l' }] }), 400, 'unit_mismatch', null, 'litres for a weight item');
  eq((await one(`select reorder::text as r from public.stock_item_levels where item_id = $1 and location_id = $2`, [rice.id, centerLocationId])).r, '10000.0000', 'a refused call changed nothing');

  // A branch manager sets levels for their own branch only, and never wipes other locations' levels.
  const mine = await api('manager', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: branchLocationId, min: '1 kg', reorder: '2 kg' }] });
  eq(mine.locations.find((l) => l.locationId === branchLocationId).level.reorder, '2000.0000', 'manager sets own branch levels');
  eq(await one(`select reorder::text as r from public.stock_item_levels where item_id = $1 and location_id = $2`, [rice.id, centerLocationId]).then((r) => r?.r), '10000.0000', 'warehouse levels untouched by the manager');
  const deniedBefore = (await one(`select count(*)::int as n from public.inventory_events where action = 'denied'`)).n;
  await refuses(api('manager', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: centerLocationId, min: '1 kg' }] }), 403, 'forbidden', null, 'manager cannot set warehouse levels');
  await refuses(api('manager', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: branch2Location, min: '1 kg' }] }), 403, 'forbidden', null, 'manager cannot set another branch');
  eq((await one(`select count(*)::int as n from public.inventory_events where action = 'denied'`)).n, deniedBefore + 2, 'denied attempts are audited and survive (authorized before the transaction)');
  const cleared = await api('owner', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [{ locationId: centerLocationId, min: '5 kg', reorder: 10, par: '20 kg', max: '50 kg' }] });
  eq(cleared.locations.find((l) => l.locationId === branchLocationId).level, null, 'owner replace-all drops levels not listed');
}

// =============================================================================================================
// 6. Listing: balances, display, low flag, costs, search
// =============================================================================================================
{
  const post = (itemId, locationId, qty, reason, extra = {}) => tx((t) => ledger.post(t, { businessId, locationId, itemId, qty, reason, idempotencyKey: `${reason}-${itemId}-${locationId}-${qty}`, actorId: users.owner, ...extra }));
  await post(rice.id, centerLocationId, '400000', 'opening', { unitCost: '0.1' });
  await post(rice.id, branchLocationId, '3000', 'opening');
  await db.query(`update public.stock_balances set reserved = 500 where location_id = $1 and item_id = $2`, [centerLocationId, rice.id]);
  const list = await catalogue.listItems(db, await scopeOf('owner'), {});
  const r = list.find((i) => i.id === rice.id);
  const wh = r.locations.find((l) => l.locationId === centerLocationId);
  eq([wh.onHand, wh.reserved, wh.available], ['400000.0000', '500.0000', '399500.0000'], 'on hand, reserved, available');
  eq(wh.display.onHand, '400 kg · 40 crates', 'friendly on hand with the crate hint');
  eq(wh.value, '40000.00', 'value = on hand x average cost');
  eq(r.totals.onHand, '403000.0000', 'totals across locations');
  eq(wh.low, false, 'plenty at the warehouse (reorder level 10 kg)');
  eq(r.locations.find((l) => l.locationId === branchLocationId).low, true, 'branch has no level of its own: falls back to the item low level (8 kg) and 3 kg is under it');
  eq(r.low, true, 'item is low if any visible location is');
  eq((await catalogue.listItems(db, await scopeOf('owner'), { lowOnly: true })).map((i) => i.name), ['Basmati rice'], 'lowOnly');
  eq((await catalogue.listItems(db, await scopeOf('owner'), { search: '6001' })).map((i) => i.name), ['Basmati rice'], 'search by barcode');
  eq((await catalogue.listItems(db, await scopeOf('owner'), { search: 'rice-1' })).map((i) => i.name), ['Basmati rice'], 'search by SKU');
  eq((await catalogue.listItems(db, await scopeOf('owner'), { search: '%' })).length, 0, 'a % in search is not a wildcard');
  eq(r.avgCost, '0.100000', 'owner sees the average cost');

  // Visibility by role.
  const mgrItem = (await catalogue.listItems(db, await scopeOf('manager'), {})).find((i) => i.id === rice.id);
  eq(mgrItem.locations.map((l) => l.locationId), [branchLocationId], 'branch manager sees only their branch balances');
  eq(mgrItem.totals.onHand, '3000.0000', 'totals cover only visible locations');
  const opsItem = (await catalogue.listItems(db, await scopeOf('ops'), {})).find((i) => i.id === rice.id);
  eq(opsItem.locations.map((l) => l.locationId).sort(), [branchLocationId, centerLocationId].sort(), 'operations sees warehouse + assigned branch');
  await refuses(catalogue.listItems(db, await scopeOf('waiter'), {}), 403, 'forbidden', null, 'waiters do not list the catalogue');

  // Costs hidden for a scope without inv.cost.view.
  const noCost = await scopeOf('owner');
  for (const caps of noCost.locationCaps.values()) caps.delete('inv.cost.view');
  const hidden = (await catalogue.listItems(db, noCost, {})).find((i) => i.id === rice.id);
  eq([hidden.avgCost, hidden.lastCost, hidden.totals.value, hidden.locations[0].value], [undefined, undefined, undefined, undefined], 'no cost, no value anywhere');
  const detailNoCost = await catalogue.getItem(db, noCost, rice.id);
  ok(detailNoCost.movements.length > 0 && detailNoCost.movements.every((m) => !('unitCost' in m) && !('value' in m)), 'movements carry no cost either');
  const viaApi = await api('owner', 'GET', `${base}`);
  ok(viaApi.items.find((i) => i.id === rice.id).avgCost !== undefined, 'owner response has costs');

  // Item detail: movements are only the ones the scope may see.
  const detail = await api('owner', 'GET', `${base}/items/${rice.id}`);
  eq(detail.movements.length, 2, 'two movements so far');
  eq(detail.movements[0].display.delta.startsWith('+'), true, 'signed friendly movement');
  ok(detail.compatibleUnits.some((u) => u.code === 'crate'), 'compatible units for the dropdown');
  const mgrDetail = await api('manager', 'GET', `${base}/items/${rice.id}`);
  eq(mgrDetail.movements.map((m) => m.locationId), [branchLocationId], 'branch manager sees only own-branch movements');
  eq(mgrDetail.movements[0].unitCost !== undefined, true, 'branch managers hold inv.cost.view');
  await refuses(api('owner', 'GET', `${base}/items/${randomUUID()}`), 404, 'item_not_found', null, 'unknown item');

  // The overview.
  const overview = await api('owner', 'GET', base);
  eq([overview.enabled, overview.role, overview.capabilities.itemEdit, overview.capabilities.costView, overview.capabilities.settingsEdit], [true, 'owner', true, true, true], 'owner capabilities flattened');
  eq(overview.warehouse.id, centerLocationId, 'overview warehouse');
  ok(overview.units.some((u) => u.code === 'kg') && overview.measuredBy.length === 4, 'units and plain-word measuring kinds');
  eq(overview.settings.branch_can_add_items, true, 'settings included');
  ok(overview.categories.length >= DEFAULT_CATEGORIES.length, 'categories seeded');
}

// =============================================================================================================
// 7. Archive and restore
// =============================================================================================================
{
  const stock = await api('owner', 'POST', `${base}/items`, { name: 'Sugar', baseUnit: 'weight', displayUnit: 'kg' });
  const post = (itemId, locationId, qty, reason) => tx((t) => ledger.post(t, { businessId, locationId, itemId, qty, reason, idempotencyKey: `arch-${itemId}-${reason}-${qty}`, actorId: users.owner }));
  await post(stock.id, centerLocationId, '2500', 'opening');
  await refuses(api('owner', 'POST', `${base}/items/${stock.id}/archive`, {}), 409, 'stock_left', /Sugar still has stock: 2\.5 kg at Main store\. Count it to zero first, or record waste\./, 'archive refused with stock');
  await post(stock.id, centerLocationId, '-2500', 'wastage');
  const done = await api('owner', 'POST', `${base}/items/${stock.id}/archive`, {});
  eq(done.archived, true, 'archived at zero');
  eq((await one('select active from public.stock_items where id = $1', [stock.id])).active, false, 'inactive for the old code too');
  eq((await api('owner', 'GET', base)).items.some((i) => i.id === stock.id), false, 'archived items are hidden by default');
  eq((await api('owner', 'GET', base, undefined, '?archived=1')).items.some((i) => i.id === stock.id), true, 'and shown on request');
  await refuses(tx((t) => ledger.post(t, { businessId, locationId: centerLocationId, itemId: stock.id, qty: '100', reason: 'purchase_receipt', idempotencyKey: 'arch-after', actorId: users.owner })), 409, 'item_archived', null, 'no new stock for an archived item');
  eq((await api('owner', 'POST', `${base}/items/${stock.id}/restore`, {})).archived, false, 'restored');
  // Reserved (held) stock also blocks.
  await post(stock.id, centerLocationId, '100', 'opening2'.replace('opening2', 'opening'));
  await post(stock.id, centerLocationId, '-100', 'wastage');
  await db.query(`update public.stock_balances set reserved = 10 where item_id = $1 and location_id = $2`, [stock.id, centerLocationId]);
  await refuses(api('owner', 'POST', `${base}/items/${stock.id}/archive`, {}), 409, 'stock_left', null, 'held stock blocks archiving');
  await db.query(`update public.stock_balances set reserved = 0 where item_id = $1`, [stock.id]);

  // A dish uses it.
  const bun = await api('owner', 'POST', `${base}/items`, { name: 'Buns', baseUnit: 'count' });
  await db.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings) values ($1, $2, $3, 1), ($4, $2, $3, 1)`, [ids.burgerId, branchId, bun.id, ids.friesId]);
  await refuses(api('owner', 'POST', `${base}/items/${bun.id}/archive`, {}), 409, 'used_by_dishes', /used by “Chicken burger” and “Fries”\. Remove it from those dishes first\./, 'archive refused while linked to dishes');
  await db.query('delete from public.menu_item_stock where item_id = $1', [bun.id]);
  eq((await api('owner', 'POST', `${base}/items/${bun.id}/archive`, {})).archived, true, 'archived once unlinked');
  const arch = await one(`select count(*)::int as n from public.inventory_events where entity = 'item' and action in ('archive', 'restore')`);
  eq(arch.n >= 3, true, 'archive/restore audited');
}

// =============================================================================================================
// 8. Categories
// =============================================================================================================
{
  const biz2 = (await db.query(`insert into public.restaurants (owner_id, name, status) values ($1, 'Other biz', 'live') returning business_id`, [stranger])).rows[0].business_id;
  await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [biz2, stranger]);
  await db.query('update public.businesses set inventory_enabled = true where id = $1', [biz2]);
  const s2 = await inventoryScope(db, ctx(stranger, { grants: [{ businessId: biz2, role: 'owner', branchIds: null }] }), biz2, { ensureLocations: true });
  const first = await catalogue.listCategories(db, s2);
  eq(first.map((c) => c.name), [...DEFAULT_CATEGORIES], 'default list, in order, on first use');
  const second = await catalogue.listCategories(db, s2);
  eq(second.length, DEFAULT_CATEGORIES.length, 'seeded once');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'category' and action = 'seed' and business_id = $1`, [biz2])).n, 1, 'seed audited once');

  const cats = (await api('owner', 'GET', `${base}/categories`)).categories;
  eq(cats.length, DEFAULT_CATEGORIES.length, 'per business');
  const dairy = cats.find((c) => c.name === 'Dairy');
  const renamed = await api('owner', 'PATCH', `${base}/categories/${dairy.id}`, { name: 'Dairy and eggs', position: 5 });
  eq([renamed.name, renamed.position], ['Dairy and eggs', 5], 'renamed and reordered');
  await refuses(api('owner', 'PATCH', `${base}/categories/${dairy.id}`, { name: 'bakery' }), 409, 'category_name_taken', /already a category/, 'duplicate name');
  const milkIn = await api('owner', 'PATCH', `${base}/items/${milk.id}`, { categoryId: dairy.id });
  eq(milkIn.categoryName, 'Dairy and eggs', 'item in a category');
  const off = await api('owner', 'PATCH', `${base}/categories/${dairy.id}`, { active: false });
  eq([off.active, off.itemCount], [false, 1], 'deactivated, still counts its items');
  await refuses(api('owner', 'PATCH', `${base}/items/${eggs.id}`, { categoryId: dairy.id }), 409, 'category_inactive', /switched off/, 'cannot put new items into a switched-off category');
  eq((await api('owner', 'GET', `${base}/items/${milk.id}`)).categoryId, dairy.id, 'existing items keep it');
  const child = await api('owner', 'POST', `${base}/categories`, { name: 'Cheese', parentId: cats.find((c) => c.name === 'Bakery').id });
  eq(child.name, 'Cheese', 'sub-category created');
  await refuses(api('owner', 'POST', `${base}/categories`, { name: 'Soft', parentId: child.id }), 400, 'category_too_deep', /one level/, 'one level only');
  await refuses(api('owner', 'POST', `${base}/categories`, { name: 'Cheese', parentId: cats.find((c) => c.name === 'Bakery').id }), 409, 'category_name_taken', null, 'duplicate in the same parent');
  const other = await api('owner', 'POST', `${base}/categories`, { name: 'Cheese' });
  ok(other.position > child.position, 'new categories go last; same name allowed under another parent');
  await refuses(api('owner', 'PATCH', `${base}/categories/${randomUUID()}`, { name: 'x' }), 404, 'category_not_found', null, 'unknown category');
  ok((await one(`select count(*)::int as n from public.inventory_events where entity = 'category' and action = 'update'`)).n >= 2, 'category edits audited');
}

// =============================================================================================================
// 9. Who may do what
// =============================================================================================================
{
  // Operations manager: reads, never writes.
  const opsView = await api('ops', 'GET', base);
  eq([opsView.role, opsView.capabilities.view, opsView.capabilities.itemEdit, opsView.capabilities.settingsEdit], ['operations', true, false, false], 'operations capabilities');
  ok(opsView.items.length > 0, 'operations sees items');
  const denied = (await one(`select count(*)::int as n from public.inventory_events where action = 'denied'`)).n;
  await refuses(api('ops', 'POST', `${base}/items`, { name: 'Ops item', baseUnit: 'count' }), 403, 'forbidden', /don’t have access/, 'operations cannot create');
  await refuses(api('ops', 'PATCH', `${base}/items/${rice.id}`, { name: 'Hacked' }), 403, 'forbidden', null, 'operations cannot edit');
  await refuses(api('ops', 'POST', `${base}/items/${rice.id}/archive`, {}), 403, 'forbidden', null, 'operations cannot archive');
  await refuses(api('ops', 'PUT', `${base}/items/${rice.id}/units`, { units: [] }), 403, 'forbidden', null, 'operations cannot change units');
  await refuses(api('ops', 'PUT', `${base}/items/${rice.id}/levels`, { levels: [] }), 403, 'forbidden', null, 'operations cannot set levels');
  await refuses(api('ops', 'POST', `${base}/categories`, { name: 'Ops cat' }), 403, 'forbidden', null, 'operations cannot add categories');
  await refuses(api('ops', 'PUT', `${base}/settings/count_tolerance_pct`, { value: 1 }), 403, 'forbidden', null, 'operations cannot change settings');
  eq((await one(`select count(*)::int as n from public.inventory_events where action = 'denied'`)).n, denied + 7, 'every refusal audited');
  eq((await one(`select name from public.stock_items where id = $1`, [rice.id])).name, 'Basmati rice', 'nothing changed');
  // The same checks hold in the service itself.
  await refuses(catalogue.createItem(db, await scopeOf('ops'), { name: 'Sneaky', baseUnit: 'count' }), 403, 'forbidden', null, 'service re-checks the capability');

  // Branch manager: may add items only while branch_can_add_items is on.
  const created = await api('manager', 'POST', `${base}/items`, { name: 'Branch napkins', baseUnit: 'count' });
  eq(created.name, 'Branch napkins', 'branch manager creates items (setting is on by default)');
  await refuses(api('manager', 'PUT', `${base}/settings/branch_can_add_items`, { value: false }), 403, 'forbidden', null, 'a manager cannot change settings');
  const set = await api('owner', 'PUT', `${base}/settings/branch_can_add_items`, { commandId: randomUUID(), value: false });
  eq([set.key, set.value, set.settings.branch_can_add_items], ['branch_can_add_items', false, false], 'owner turns it off');
  await refuses(api('manager', 'POST', `${base}/items`, { name: 'Branch forks', baseUnit: 'count' }), 403, 'forbidden', null, 'manager cannot create once it is off');
  await refuses(api('manager', 'PATCH', `${base}/items/${created.id}`, { name: 'Branch napkins 2' }), 403, 'forbidden', null, 'nor edit');
  eq((await api('manager', 'GET', base)).capabilities.itemEdit, false, 'the button flag follows the setting');
  await refuses(api('owner', 'PUT', `${base}/settings/count_tolerance_pct`, { value: 500 }), 400, 'invalid_setting', /between 0 and 100/, 'setting validated');
  await refuses(api('owner', 'PUT', `${base}/settings/nonsense`, { value: 1 }), 400, 'invalid_setting', /Unknown setting/, 'unknown setting');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'setting' and action in ('create', 'update')`)).n >= 1, true, 'setting change audited');
  await api('owner', 'PUT', `${base}/settings/branch_can_add_items`, { value: true });
  eq((await api('manager', 'POST', `${base}/items`, { name: 'Branch forks', baseUnit: 'count' })).name, 'Branch forks', 'and back on');

  // Waiters and strangers get nothing from the owner API; the second branch's manager sees their own branch only.
  await refuses(api('waiter', 'GET', base), 403, 'forbidden', null, 'waiter');
  await refuses(api('stranger', 'POST', `${base}/items`, { name: 'Intruder', baseUnit: 'count' }), 403, 'forbidden', null, 'stranger');
  const m2 = await api('manager2', 'GET', base);
  eq(m2.locations.map((l) => l.id), [branch2Location], 'another branch manager sees only their own branch');
  eq(m2.items.find((i) => i.id === rice.id).totals.onHand, '0.0000', 'and none of the other branch’s stock');
  await refuses(api('owner', 'GET', `/api/owner/inventory/${randomUUID()}`), 404, null, /isn’t yours/, 'unknown business');
}

// =============================================================================================================
// 10. Idempotent retries through the route, rolled-back failures
// =============================================================================================================
{
  const cmd = randomUUID();
  const first = await api('owner', 'PUT', `${base}/items/${eggs.id}/barcodes`, { commandId: cmd, barcodes: ['9001'] });
  await api('owner', 'PUT', `${base}/items/${eggs.id}/barcodes`, { commandId: cmd, barcodes: ['9002'] }).then((r) => eq(r.barcodes, first.barcodes, 'a retried command returns the first result, not the new body'));
  // A failing write leaves nothing: units applied, then a bad second part must not persist the first.
  const before = (await one(`select count(*)::int as n from public.stock_items`)).n;
  await refuses(api('owner', 'POST', `${base}/items`, { name: 'Half made', baseUnit: 'weight', units: [{ name: 'tub', factor: '2 kg' }], displayUnit: 'tub', lowLevel: '-3 kg' }), 400, 'negative', null, 'bad low level');
  eq((await one(`select count(*)::int as n from public.stock_items`)).n, before, 'nothing left behind');
  eq((await api('owner', 'POST', `${base}/items`, { name: 'Tubbed', baseUnit: 'weight', units: [{ name: 'tub', factor: '2 kg' }], displayUnit: 'tub', lowLevel: '3 tub' })).lowLevel, '6000.0000', 'display unit may be one of the item’s own units, levels in it too');
  eq((await one(`select count(*)::int as n from public.stock_commands where business_id = $1`, [businessId])).n >= 3, true, 'commands recorded');
}

// Ledger and balances stay consistent (the catalogue never writes them).
eq(await ledger.reconcile(db, { businessId }), [], 'ledger reconciles');

console.log(`catalogue.test.js: ${checks} checks passed`);
