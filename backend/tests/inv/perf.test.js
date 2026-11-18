// Performance budgets (round trips). The shared database is ~250 ms away from the server, so latency = SEQUENTIAL queries x 250 ms.
// This test runs the REAL route handlers against the golden dataset (in-memory PGlite) with a query counter (query-counter.js) and
// asserts, per endpoint, the total number of queries and the sequential depth (critical path). It prints before/after numbers.
// BASELINE numbers (measured before the speed-up, same dataset) are kept in BEFORE below for the report.
// Usage: node backend/tests/inv/perf.test.js
import { loadGolden } from './golden.js';
import { makeAsserts, makeSupplier } from './helpers.js';
import { countQueries } from './query-counter.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes as ownerRoutes } from '../../src/routes/inventory-owner.js';
import { createRoutes as recipeRoutes } from '../../src/routes/inventory-recipes.js';
import { createRoutes as distributionRoutes } from '../../src/routes/inventory-distribution.js';
import { createRoutes as approvalRoutes } from '../../src/routes/inventory-approvals.js';
import { createRoutes as purchasingRoutes } from '../../src/routes/inventory-purchasing.js';
import { createRoutes as branchRoutes } from '../../src/routes/inventory-branch.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { getSettings, setSetting } from '../../src/inventory/policies.js';
import { canParallel, together } from '../../src/lib/pool.js';
import { clearUnitsCache, loadUnits } from '../../src/inventory/catalogue.js';
import { clearSettingsCache } from '../../src/inventory/policies.js';

const { eq, ok, count } = makeAsserts();
const g = await loadGolden();
const { db, ids, users, helpers } = g;
const biz = ids.businessId;
const counter = countQueries(db);
const wired = { pool: () => counter.db, transact: (fn) => counter.db.transaction(fn) };

const grantsOwner = [{ businessId: biz, role: 'owner', branchIds: null }];
const contexts = {
  owner: helpers.ctx(users.owner, { memberships: [[ids.branchId, 'owner']], grants: grantsOwner }),
  manager: helpers.ctx(users.manager, { memberships: [[ids.branchId, 'manager']] }),
};
contexts.managerKnown = { ...contexts.manager, memberships: [{ role: 'manager', restaurant: { id: ids.branchId, business_id: biz } }] }; // as requireUser() now returns it
const owner2 = await helpers.addOwner('owner2@example.test');
contexts.owner2 = helpers.ctx(owner2, { memberships: [[ids.branchId, 'owner']], grants: grantsOwner });
const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
  return contexts[who];
};
const tables = {
  owner: ownerRoutes({ authenticate, ...wired }),
  recipes: recipeRoutes({ authenticate, ...wired }),
  distribution: distributionRoutes({ authenticate, ...wired }),
  approvals: approvalRoutes({ authenticate, ...wired }),
  purchasing: purchasingRoutes({ authenticate, ...wired }),
  branch: branchRoutes({ authenticate, ...wired }),
};
const call = async (table, as, method, pathname, { body, query = '', branch = null } = {}) => {
  for (const route of tables[table]) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    const headers = { authorization: `Bearer ${as}` };
    if (branch) headers['x-cravio-branch'] = branch;
    return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};

// ---- extra data the golden week does not have: requests, purchase orders waiting for approval ----
const base = `/api/owner/inventory/${biz}`;
const itemId = Object.values(g.itemIds)[0];
const itemId2 = Object.values(g.itemIds)[1];
const supplier = await makeSupplier(db, biz, 'Perf supplier', { phone: '254712345678' });
await db.query(`update public.stock_items set avg_cost = 1 where id = any($1::uuid[])`, [[itemId, itemId2]]);
for (const id of [itemId, itemId2]) {
  await db.query(`insert into public.supplier_prices (business_id, supplier_id, item_id, unit, unit_factor, price, price_per_base, effective_from) values ($1, $2, $3, 'kg', 1000, 100, 0.1, '2026-01-01')`, [biz, supplier, id]);
}
for (let i = 0; i < 6; i += 1) {
  await call('distribution', 'manager', 'POST', '/api/inventory/requests', { branch: ids.branchId, body: { lines: [{ itemId, quantity: 1 + i, unit: 'kg' }, { itemId: itemId2, quantity: 2, unit: 'kg' }], commandId: crypto.randomUUID() } });
}
await call('approvals', 'owner', 'PUT', `${base}/approval-rules`, { body: { subject: 'purchase_order', perTransactionKes: 1 } });
for (let i = 0; i < 4; i += 1) {
  const made = await call('purchasing', 'owner2', 'POST', `${base}/purchase-orders`, { body: { supplierId: supplier, lines: [{ itemId, qty: 5 + i, unit: 'kg' }, { itemId: itemId2, qty: 3, unit: 'kg' }] } });
  await call('purchasing', 'owner2', 'POST', `${base}/purchase-orders/${made.order.id}/submit`, { body: {} });
}

// ---- measure ----
// [total queries, sequential depth] before the speed-up, measured on this dataset with the old code (every query was sequential).
const BEFORE = { overview: [33, 33], recipes: [18, 18], requests: [12, 12], approvals: [6, 6], purchaseOrders: [5, 5], branchInventory: [21, 21], branchKnown: [21, 21] };
// Budgets are about SEQUENTIAL round trips (depth). Totals only guard against a query per row creeping back in (this dataset: 6 requests,
// 4 orders, 12 dishes, ~12 items), so they are generous but far below what N+1 would cost.
const BUDGET = { overview: [8, 3], recipes: [6, 3], requests: [9, 3], approvals: [4, 3], purchaseOrders: [3, 2], branchInventory: [9, 3], branchKnown: [8, 2] };
const measure = async (name, run, check) => {
  counter.reset();
  const result = await run();
  const { total, depth } = counter.stats();
  const [bt, bd] = BEFORE[name];
  if (process.env.PERF_LOG === name) for (const l of counter.log()) console.log(`      L${l.level} ${l.sql}`);
  console.log(`  ${name.padEnd(16)} queries ${String(bt).padStart(3)} -> ${String(total).padStart(3)}   sequential ${String(bd).padStart(3)} -> ${String(depth).padStart(3)}`);
  if (process.env.PERF_BASELINE !== '1') {
    ok(total <= BUDGET[name][0], `${name}: ${total} queries (budget ${BUDGET[name][0]})`);
    ok(depth <= BUDGET[name][1], `${name}: sequential depth ${depth} (budget ${BUDGET[name][1]})`);
    ok(total < bt && depth < bd, `${name}: fewer queries than before`);
  }
  if (check) check(result);
  return result;
};

console.log('\nQuery budgets (golden dataset: 3 locations, items, 12 dishes with recipes):');
await call('owner', 'owner', 'GET', base); // first visit seeds the default categories (a one-time write); measure the steady state
const overview = await measure('overview', () => call('owner', 'owner', 'GET', base), (r) => {
  eq(r.enabled, true, 'overview is enabled');
  ok(r.items.length > 0 && r.locations.length === 3 && r.warehouse && r.categories.length > 0 && r.units.length > 0 && r.settings, 'overview keeps its full shape');
});
const recipes = await measure('recipes', () => call('recipes', 'owner', 'GET', `${base}/recipes`, { query: `?branch=${ids.branchId}` }), (r) => ok(r.dishes?.length || r.recipes?.length || Array.isArray(r), 'recipes list is not empty'));
const requests = await measure('requests', () => call('distribution', 'owner', 'GET', `${base}/requests`), (r) => ok((r.requests || r).length >= 6, 'requests listed'));
const approvals = await measure('approvals', () => call('approvals', 'owner', 'GET', `${base}/approvals`), (r) => ok(r.approvals.length === 4 && r.approvals.every((a) => a.summary?.kind === 'purchase_order' && a.canDecide), 'four pending purchase orders, each with its summary'));
const pos = await measure('purchaseOrders', () => call('purchasing', 'owner', 'GET', `${base}/purchase-orders`), (r) => ok((r.orders || r).length >= 4, 'purchase orders listed'));
const inv = await measure('branchInventory', () => call('branch', 'manager', 'GET', '/api/inventory', { branch: ids.branchId }), (r) => ok(r.items?.length > 0, 'branch inventory has items'));

const known = await measure('branchKnown', () => call('branch', 'managerKnown', 'GET', '/api/inventory', { branch: ids.branchId }), (r) => ok(r.items?.length === inv.items.length, 'same answer without asking which business the branch is in'));

// ---- a plain GET never writes once everything exists; locations are created only when one is missing ----
{
  const writes = async () => (await db.query(`select (select count(*) from public.stock_locations)::int as locations, (select count(*) from public.stock_categories)::int as categories,
    (select count(*) from public.inventory_events)::int as events, (select count(*) from public.stock_commands)::int as commands`)).rows[0];
  const before = await writes();
  await call('owner', 'owner', 'GET', base);
  await call('recipes', 'owner', 'GET', `${base}/recipes`, { query: `?branch=${ids.branchId}` });
  await call('branch', 'manager', 'GET', '/api/inventory', { branch: ids.branchId });
  eq(await writes(), before, 'GET requests write nothing when locations and categories already exist');

  // A branch without its stock location: the first request makes it (that is the only time a read may write), the next does not.
  const extra = (await db.query(`insert into public.restaurants (owner_id, name, status, business_id, owner_primary) values ($1, 'No location yet', 'live', $2, false) returning id`, [users.owner, biz])).rows[0].id;
  const missing = async () => (await db.query(`select count(*)::int as n from public.stock_locations where restaurant_id = $1`, [extra])).rows[0].n;
  eq(await missing(), 0, 'the new branch has no stock location (the trigger does not create one)');
  counter.reset();
  const first = await call('owner', 'owner', 'GET', base);
  eq(await missing(), 1, 'a missing branch location is created by the first request');
  ok(first.locations.some((l) => l.restaurantId === extra), 'and listed in that same response');
  const afterFirst = await writes();
  await call('owner', 'owner', 'GET', base);
  eq(await writes(), afterFirst, 'the second request writes nothing');
}

// ---- scope: one statement, and the figures it carries ----
{
  counter.reset();
  const scope = await inventoryScope(counter.db, contexts.owner, biz, { ensureLocations: 'active' });
  eq(counter.stats(), { total: 1, depth: 1 }, 'inventoryScope is one query when nothing is missing');
  eq(scope.settings, await getSettings(db, biz), 'scope.settings equals getSettings');
  eq(scope.locationRows.length, scope.locations.length, 'location rows travel with the scope');
}

// ---- together(): parallel on a pool, sequential on a single client ----
{
  counter.reset();
  await together(counter.db, () => counter.db.query('select 1'), () => counter.db.query('select 2'), () => counter.db.query('select 3'));
  eq(counter.stats(), { total: 3, depth: 1 }, 'three independent reads on the pool cost one round trip');
  await counter.db.transaction(async (tx) => {
    ok(!canParallel(tx), 'a transaction client is not parallel safe');
    counter.reset();
    await together(tx, () => tx.query('select 1'), () => tx.query('select 2'));
    eq(counter.stats(), { total: 2, depth: 2 }, 'on a transaction the same reads stay sequential (no concurrent queries on one client)');
  });
}

// ---- near-static reference data is kept in memory on the real pool (never in tests' databases, never inside a transaction) ----
{
  const asPool = new Proxy(counter.db, { get: (obj, prop) => (prop === 'totalCount' ? 0 : prop === 'parallelSafe' ? false : obj[prop]) });
  clearUnitsCache(); clearSettingsCache();
  counter.reset();
  const a = await loadUnits(asPool);
  const b = await loadUnits(asPool);
  eq(counter.stats().total, 1, 'units are read once, then served from memory');
  eq(a, b, 'same units');
  counter.reset();
  const request = {};
  await Promise.all([loadUnits(counter.db, request), loadUnits(counter.db, request), loadUnits(counter.db, request)]);
  eq(counter.stats().total, 1, 'within one request, asking for units three times at once costs one query');

  const { getSettings: settings, setSetting: write } = await import('../../src/inventory/policies.js');
  counter.reset();
  await settings(asPool, biz); await settings(asPool, biz);
  eq(counter.stats().total, 1, 'settings are read once, then served from memory');
  await write(counter.db, { businessId: biz, key: 'low_alert_enabled', value: false, actorId: users.owner });
  eq((await settings(asPool, biz)).low_alert_enabled, false, 'a write is visible at once (the cache is dropped)');
  await write(counter.db, { businessId: biz, key: 'low_alert_enabled', value: true, actorId: users.owner });
  eq((await settings(asPool, biz)).low_alert_enabled, true, 'and again');
  eq((await settings(counter.db, biz)).low_alert_enabled, true, 'a database without a pool answer is never cached');
}

console.log(`\n${count()} checks`);
