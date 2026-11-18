// Recipes service + API (P1-10) on a throwaway in-memory database with migrations 012 + 013 applied.
// Runs the REAL route handlers from routes/inventory-recipes.js (createRoutes) with injected identity and database, like catalogue.test.js.
// The AI call is never real: globalThis.fetch is stubbed.
// Usage: node backend/tests/inv/recipes.test.js
import assert from 'node:assert/strict';
import { inventoryFixture } from './fixture.js';
import { createUser } from '../support/pg.js';
import { branchLocation } from '../../src/stock/service.js';
import { createRoutes } from '../../src/routes/inventory-recipes.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import * as ledger from '../../src/inventory/ledger.js';
import * as catalogue from '../../src/inventory/catalogue.js';
import * as recipes from '../../src/inventory/recipes.js';
import { HttpError } from '../../src/lib/http.js';

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

const f = await inventoryFixture({ extra: ['migrations/012_inventory_catalogue.sql', 'migrations/013_inventory_recipes.sql', 'migrations/014_ai_gateway.sql'] });
const { db, ids, users } = f;
const { businessId, branchId, branchLocationId, burgerId, friesId, extraId, categoryId } = ids;
const tx = (fn) => db.transaction(fn);
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;

// A second branch (with a dish), its manager, an operations manager for branch 1, a stranger.
const branch2 = (await one(`insert into public.restaurants (owner_id, name, status, business_id, owner_primary) values ($1, 'Second branch', 'live', $2, false) returning id`, [users.owner, businessId])).id;
await tx((t) => branchLocation(t, branch2));
const category2 = (await one(`insert into public.menu_categories (restaurant_id, name) values ($1, 'Mains') returning id`, [branch2])).id;
const dish2 = (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, 'Branch 2 stew', 300) returning id`, [branch2, category2])).id;
const manager2 = await createUser(db, 'manager2@example.test', { role: 'owner' });
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'manager')`, [branch2, manager2]);
const ops = await createUser(db, 'ops@example.test', { role: 'owner' });
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'operations')`, [businessId, ops]);
await db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessId, ops, branchId]);

await db.query('update public.businesses set inventory_enabled = true where id = $1', [businessId]);
const ctx = (userId, { role = 'owner', memberships = [], grants = [] } = {}) => ({
  user: { id: userId }, profile: { role }, memberships: memberships.map(([rid, r]) => ({ role: r, restaurant: { id: rid } })), grants,
});
const contexts = {
  owner: ctx(users.owner, { memberships: [[branchId, 'owner']], grants: [{ businessId, role: 'owner', branchIds: null }] }),
  ops: ctx(ops, { grants: [{ businessId, role: 'operations', branchIds: [branchId] }] }),
  manager: ctx(users.manager, { memberships: [[branchId, 'manager']] }),
  manager2: ctx(manager2, { memberships: [[branch2, 'manager']] }),
  waiter: ctx(users.waiter, { role: 'waiter', memberships: [[branchId, 'waiter']] }),
};
const scopeOf = (who) => inventoryScope(db, contexts[who], businessId, { ensureLocations: true });

const makeApi = (pool = () => db, ai = {}) => {
  const routes = createRoutes({
    authenticate: async (request) => {
      const who = request.headers.authorization?.replace(/^Bearer /, '');
      if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
      return contexts[who];
    },
    pool, transact: (fn) => db.transaction(fn), ai,
  });
  return async (as, method, pathname, body, { query = '', branch } = {}) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.path.exec(pathname);
      if (!m) continue;
      const headers = { authorization: `Bearer ${as}`, ...(branch ? { 'x-cravio-branch': branch } : {}) };
      return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
    }
    throw new Error(`No route for ${method} ${pathname}`);
  };
};
const api = makeApi();
const base = `/api/owner/inventory/${businessId}`;

// ---- Catalogue: chicken (70% usable, 0.35 per g), eggs (tray = 30), cheese (no cost yet), rice (kg) ----
const owner = await scopeOf('owner');
const mk = (body) => tx((t) => catalogue.createItem(t, owner, body));
const chicken = await mk({ name: 'Chicken', baseUnit: 'weight', displayUnit: 'kg', yieldPct: 70 });
const eggs = await mk({ name: 'Eggs', baseUnit: 'count', units: [{ name: 'tray', factor: '30 piece' }] });
const cheese = await mk({ name: 'Cheese', baseUnit: 'weight' });
const rice = await mk({ name: 'Rice', baseUnit: 'weight', displayUnit: 'kg' });
const cost = (item, value) => db.query('update public.stock_items set avg_cost = $2 where id = $1', [item.id, value]);
await cost(chicken, '0.35');
await cost(eggs, '0.1');
await cost(rice, '0.2');
const stock = (item, qty, key) => tx((t) => ledger.post(t, { businessId, locationId: branchLocationId, itemId: item.id, qty, reason: 'opening', idempotencyKey: key, actorId: users.owner }));
const dish = async (name, price = 100, rid = branchId, cat = categoryId) => (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, $4) returning id`, [rid, cat, name, price])).id;
const put = (as, id, lines, more = {}, opts) => api(as, 'PUT', `${base}/recipes/${id}`, { lines, ...more }, opts);
const L = (item, quantity, unit) => ({ itemId: item.id, quantity, ...(unit ? { unit } : {}) });
const cancel = (o) => db.query(`update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = $2 where id = $1`, [o, users.waiter]);
const versionRows = (id) => all(`select v.version, v.superseded_at, r.current_version_id = v.id as current from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where r.menu_item_id = $1 order by v.version`, [id]);

// ===== 1. Entered units are stored in the base unit; yield sentence =====
const v1 = await put('owner', burgerId, [L(chicken, 200, 'g')], { note: 'first' });
eq(v1.version.version, 1, 'first save is version 1');
eq(v1.source, 'recipe', 'source recipe');
eq(v1.lines[0].qtyBase, '200.0000', '200 g stored as 200 g');
eq(v1.lines[0].entered, { quantity: '200.0000', unit: 'g' }, 'entered quantity and unit kept');
eq(v1.preview, ['1 Chicken burger uses 285.7 g Chicken (200 g at 70% usable)'], 'plain sentence with yield');
const v2 = await put('owner', burgerId, [L(chicken, '0.2', 'kg'), L(eggs, 1, 'tray')]);
eq(v2.version.version, 2, 'second save is version 2');
eq(v2.lines.map((l) => [l.name, l.qtyBase]), [['Chicken', '200.0000'], ['Eggs', '30.0000']], '0.2 kg = 200 g and 1 tray = 30 pieces, stored in base units');
eq(v2.lines[0].entered, { quantity: '0.2000', unit: 'kg' }, 'entered 0.2 kg kept');
eq(v2.lines[1].entered, { quantity: '1.0000', unit: 'tray' }, 'entered 1 tray kept');
ok(/1 Chicken burger uses 0\.286 kg Chicken \(0\.2 kg at 70% usable\)/.test(v2.preview[0]), `sentence in the unit typed: ${v2.preview[0]}`);
eq(v2.preview[1], '1 Chicken burger uses 1 tray Eggs', 'no yield text at 100%');
eq(v2.versions.map((v) => [v.version, v.current]), [[2, true], [1, false]], 'history lists both, newest first');
eq(v2.versions[1].note, 'first', 'note kept');
ok(v2.versions[0].createdBy.name, 'author name shown');
await refuses(put('owner', burgerId, [L(chicken, 200, 'ml')]), 400, 'unit_mismatch', /Can’t use/, 'wrong dimension refused');
await refuses(put('owner', burgerId, [L(chicken, 0)]), 400, 'not_positive', null, 'zero refused');
await refuses(put('owner', burgerId, [L(chicken, -5, 'g')]), 400, 'not_positive', null, 'negative refused');
await refuses(put('owner', burgerId, [{ itemId: chicken.id, quantity: 'lots' }]), 400, null, /isn’t a number/, 'text refused');
eq((await versionRows(burgerId)).length, 2, 'refused saves wrote nothing');

// ===== 2. Duplicates are refused; archived and foreign items are refused =====
await refuses(put('owner', burgerId, [L(chicken, 100, 'g'), L(chicken, 50, 'g')]), 400, 'duplicate_item', /twice/, 'same item twice refused');
const old = await mk({ name: 'Old stock', baseUnit: 'weight' });
await tx((t) => catalogue.archiveItem(t, owner, old.id));
await refuses(put('owner', burgerId, [L(old, 10, 'g')]), 400, 'item_archived', /archived/, 'archived item refused');
await refuses(put('owner', burgerId, [{ itemId: '00000000-0000-4000-8000-000000000000', quantity: 1 }]), 404, 'item_not_found', null, 'unknown item refused');
eq((await versionRows(burgerId)).length, 2, 'still two versions');

// ===== 3. A used version never changes; every save is a new version =====
await stock(chicken, '5000', 'open-chicken');
await stock(eggs, '300', 'open-eggs');
await put('owner', burgerId, [L(chicken, 200, 'g')]); // v3
const order1 = await f.helpers.order([{ itemId: burgerId, name: 'Chicken burger', quantity: 1 }]);
const snap1 = await one(`select s.qty_base::text as qty, s.recipe_version_id, v.version from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id
  join public.recipe_versions v on v.id = s.recipe_version_id where oi.order_id = $1`, [order1]);
eq([snap1.qty, snap1.version], ['285.7143', 3], 'the order snapshotted version 3 with the yield applied');
const v4 = await put('owner', burgerId, [L(chicken, 150, 'g')]);
eq(v4.version.version, 4, 'saving after an order is a new version');
const old3 = await api('owner', 'GET', `${base}/recipes/${burgerId}/versions/${v4.versions.find((v) => v.version === 3).id}`);
eq(old3.lines[0].qtyBase, '200.0000', 'version 3 still has its 200 g');
eq(old3.version.used, true, 'version 3 is marked used');
ok(old3.version.supersededAt, 'version 3 superseded');
await assert.rejects(db.query(`update public.recipe_lines set qty_base = 1 where version_id = $1`, [snap1.recipe_version_id]), /used by orders/);
checks++;
eq((await one(`select qty_base::text as q from public.order_stock_lines where order_item_id = (select id from public.order_items where order_id = $1)`, [order1])).q, '285.7143', 'the order keeps what it needed');
eq((await api('owner', 'GET', `${base}/recipes/${burgerId}/versions`)).versions.map((v) => v.version), [4, 3, 2, 1], 'versions endpoint');
await refuses(api('owner', 'GET', `${base}/recipes/${burgerId}/versions/00000000-0000-4000-8000-000000000000`), 404, 'version_not_found', null, 'unknown version');
await cancel(order1);

// ===== 4. Emptying stops tracking and keeps history; the 009 link is handled =====
const stopped = await put('owner', burgerId, []);
eq([stopped.source, stopped.tracked, stopped.lines], ['none', false, []], 'empty list = untracked');
eq(stopped.versions.length, 4, 'history kept');
eq((await one('select current_version_id from public.recipes where menu_item_id = $1', [burgerId])).current_version_id, null, 'no current version');
eq((await all('select * from public.stock_menu_availability($1) where menu_item_id = $2', [branchId, burgerId])).length, 0, 'dish is not tracked by serving');
const restarted = await put('owner', burgerId, [L(chicken, 100, 'g')]);
eq(restarted.version.version, 5, 'tracking again continues the version numbers');
// A 009 link: in force until a recipe replaces it; emptying the recipe must not bring it back.
await db.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings, allow_when_out) values ($1, $2, $3, 2, true)`, [friesId, branchId, rice.id]);
const linked = await api('owner', 'GET', `${base}/recipes/${friesId}`);
eq([linked.source, linked.tracked, linked.link.inForce, linked.lines.map((l) => [l.name, l.qtyBase]), linked.allowWhenOut], ['link', true, true, [['Rice', '2.0000']], true], 'link shown as the dish’s source');
const fries1 = await put('owner', friesId, [L(rice, 150, 'g'), L(cheese, 10, 'g')]);
eq([fries1.source, fries1.link, fries1.allowWhenOut], ['recipe', null, true], 'recipe replaces the link and keeps its keep-selling switch');
eq((await all('select 1 from public.menu_item_stock where menu_item_id = $1', [friesId])).length, 0, 'link deleted');
const fries0 = await put('owner', friesId, []);
eq([fries0.source, fries0.tracked], ['none', false], 'emptied dish does not fall back to a link');
const fries2 = await put('owner', friesId, [L(rice, 150, 'g')], { allowWhenOut: false });
eq(fries2.allowWhenOut, false, 'allowWhenOut can be switched off');
await put('owner', friesId, [L(rice, 150, 'g')]);
eq((await api('owner', 'GET', `${base}/recipes/${friesId}`)).allowWhenOut, false, 'allowWhenOut kept when not sent');

// ===== 5. Food cost: exact, null when anything is unknown, hidden without cost.view =====
const costDish = await dish('Cost dish', 3);
const two = await put('owner', costDish, [L(rice, 0.5, 'kg'), L(eggs, 1, 'piece')]); // rice 500 g x 0.2 = 100; egg 1 x 0.1 = 0.1
eq(two.foodCost, { cost: '100.10', costPct: '3336.7', unknown: [] }, 'exact cost and % of price');
const cd = await dish('Yield dish', 3);
await mk({ name: 'Odd', baseUnit: 'weight', yieldPct: 70 }).then((odd) => cost(odd, '0.1').then(() => put('owner', cd, [L(odd, 100, 'g')])));
eq((await api('owner', 'GET', `${base}/recipes/${cd}`)).foodCost.cost, '14.29', '100 g / 0.7 x 0.1 = 14.2857… rounds to 14.29 (no floating point)');
const third = await dish('Third', 1);
const costs = await mk({ name: 'Tenth', baseUnit: 'weight' }); const costs2 = await mk({ name: 'Fifth', baseUnit: 'weight' });
await cost(costs, '0.1'); await cost(costs2, '0.2');
eq((await put('owner', third, [L(costs, 1, 'g'), L(costs2, 1, 'g')])).foodCost.cost, '0.30', '0.1 + 0.2 is exactly 0.30');
const unknownDish = await dish('Mystery', 100);
const mystery = await put('owner', unknownDish, [L(chicken, 100, 'g'), L(cheese, 20, 'g')]);
eq(mystery.foodCost, { cost: null, costPct: null, unknown: ['Cheese'] }, 'unknown cost is null (not 0) and names the item');
eq(mystery.lines.find((l) => l.name === 'Cheese').cost, null, 'unknown line cost null');
eq(await recipes.foodCost(db, owner, unknownDish), { cost: null, costPct: null, unknown: ['Cheese'] }, 'foodCost() agrees');
eq(await recipes.foodCost(db, owner, { menuItemId: unknownDish, lines: [L(chicken, 100, 'g')] }), { cost: '50.00', costPct: '50.0', unknown: [] }, 'foodCost() of draft lines (100 g / 0.7 x 0.35)');
const draft = await api('owner', 'POST', `${base}/recipes/${burgerId}/preview`, { lines: [L(chicken, 200, 'g')] });
eq([draft.preview, draft.foodCost.cost], [['1 Chicken burger uses 285.7 g Chicken (200 g at 70% usable)'], '100.00'], 'live preview of unsaved lines');
const noCost = { ...owner, locationCaps: new Map([...owner.locationCaps].map(([k, v]) => [k, new Set([...v].filter((c) => c !== 'inv.cost.view'))])) };
const hidden = await recipes.getRecipe(db, noCost, unknownDish);
ok(!('foodCost' in hidden) && hidden.canSeeCost === false && hidden.lines.every((l) => !('cost' in l)), 'cost hidden without inv.cost.view');
eq(await recipes.foodCost(db, noCost, unknownDish), null, 'foodCost() null without inv.cost.view');
ok((await recipes.listRecipes(db, noCost, { restaurantId: branchId })).dishes.every((d) => !('foodCost' in d)), 'list hides cost too');
ok('foodCost' in (await api('manager', 'GET', '/api/inventory/recipes/' + unknownDish, undefined, { branch: branchId })), 'a branch manager sees cost at their branch');

// ===== 6. Permissions =====
const auditCount = async (who, action) => (await one(`select count(*)::int as n from public.inventory_events where actor_id = $1 and action = $2`, [who, action])).n;
const burgerNow = (await api('owner', 'GET', `${base}/recipes/${burgerId}`)).version.version;
eq((await put('manager', burgerId, [L(chicken, 120, 'g')])).version.version, burgerNow + 1, 'branch manager edits their own branch through the owner path');
const stewBefore = await auditCount(manager2, 'denied');
await refuses(put('manager2', burgerId, [L(chicken, 1, 'g')]), 403, 'forbidden', null, 'a manager of another branch can’t edit');
eq(await auditCount(manager2, 'denied'), stewBefore + 1, 'the refusal is audited (denied)');
await refuses(api('manager2', 'GET', `${base}/recipes/${burgerId}`), 403, 'forbidden', null, 'nor read it');
eq((await put('owner', dish2, [L(rice, 100, 'g')])).dish.restaurantId, branch2, 'owner edits any branch');
await refuses(put('manager', dish2, [L(rice, 100, 'g')]), 403, 'forbidden', null, 'branch 1 manager can’t edit branch 2');
const opsRead = await api('ops', 'GET', `${base}/recipes/${burgerId}`);
eq([opsRead.canEdit, opsRead.canSeeCost], [false, true], 'operations manager reads (with cost) but can’t edit');
await refuses(put('ops', burgerId, [L(chicken, 1, 'g')]), 403, 'forbidden', null, 'operations manager is read-only');
await refuses(api('ops', 'GET', `${base}/recipes/${dish2}`), 403, 'forbidden', null, 'operations sees only assigned branches');
await refuses(api('waiter', 'GET', `${base}/recipes/${burgerId}`), 403, 'forbidden', null, 'waiter can’t read');
await refuses(put('waiter', burgerId, [L(chicken, 1, 'g')]), 403, 'forbidden', null, 'nor edit');
await refuses(put('owner', '00000000-0000-4000-8000-000000000000', []), 404, 'dish_not_found', null, 'unknown dish');

// Branch routes: own branch via X-Cravio-Branch.
const bget = (as, id, branch = branchId) => api(as, 'GET', `/api/inventory/recipes/${id}`, undefined, { branch });
eq((await bget('manager', burgerId)).dish.name, 'Chicken burger', 'branch GET');
const bput = await api('manager', 'PUT', `/api/inventory/recipes/${burgerId}`, { lines: [L(chicken, 130, 'g')] }, { branch: branchId });
eq(bput.lines[0].qtyBase, '130.0000', 'branch PUT');
await refuses(bget('manager', dish2), 404, 'dish_not_found', null, 'a dish of another branch is not found on this branch’s route');
await refuses(bget('manager2', burgerId), 403, 'branch_forbidden', null, 'branch header for a branch you aren’t in');
await refuses(bget('waiter', burgerId), 403, 'forbidden', null, 'waiter 403 on branch route');
eq((await api('manager2', 'PUT', `/api/inventory/recipes/${dish2}`, { lines: [L(rice, 50, 'g')] })).lines[0].qtyBase, '50.0000', 'branch 2 manager edits branch 2 (single branch, no header needed)');

// ===== 7. Extras =====
await stock(cheese, '1000', 'open-cheese');
const ex = await api('owner', 'PUT', `${base}/extras/${extraId}/recipe`, { lines: [L(cheese, 20, 'g')] });
eq([ex.tracked, ex.lines[0].qtyBase, ex.preview], [true, '20.0000', ['1 Extra cheese uses 20 g Cheese']], 'extra recipe saved');
eq((await api('owner', 'GET', `${base}/recipes/${burgerId}`)).extras.map((e) => [e.name, e.tracked, e.lines.length]), [['Extra cheese', true, 1]], 'extras listed with their lines');
const placeWithExtra = async () => {
  const o = (await one(`insert into public.orders (restaurant_id, status, taken_by) values ($1, 'taken', $2) returning id`, [branchId, users.waiter])).id;
  await db.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, kind, extras) values ($1, $2, $3, 'Chicken burger', 100, 2, 200, 'item', $4::jsonb)`,
    [o, branchId, burgerId, JSON.stringify([{ id: extraId, name: 'Extra cheese' }])]);
  return o;
};
const o2 = await placeWithExtra();
eq(await all(`select s.source, si.name, s.qty_base::text as qty from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id join public.stock_items si on si.id = s.item_id
  where oi.order_id = $1 and s.source = 'extra'`, [o2]), [{ source: 'extra', name: 'Cheese', qty: '40.0000' }], 'a new order snapshots the extra’s recipe (2 x 20 g)');
await api('owner', 'PUT', `${base}/extras/${extraId}/recipe`, { lines: [L(cheese, 50, 'g')] });
eq((await one(`select s.qty_base::text as q from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id where oi.order_id = $1 and s.source = 'extra'`, [o2])).q, '40.0000', 'editing the extra later does not change that order');
await cancel(o2);
await refuses(api('manager2', 'PUT', `${base}/extras/${extraId}/recipe`, { lines: [] }), 403, 'forbidden', null, 'another branch’s manager can’t edit the extra');
await refuses(api('owner', 'PUT', `${base}/extras/${extraId}/recipe`, { lines: [L(cheese, 1, 'g'), L(cheese, 2, 'g')] }), 400, 'duplicate_item', null, 'extras refuse duplicates too');
eq((await api('manager', 'PUT', `/api/inventory/extras/${extraId}/recipe`, { lines: [] }, { branch: branchId })).tracked, false, 'branch route empties an extra');
eq((await api('owner', 'GET', `${base}/extras/${extraId}/recipe`)).tracked, false, 'extra recipe GET');

// ===== 8. Audit with diff =====
const events = await all(`select action, before, after from public.inventory_events where entity = 'recipe' and entity_id = (select id from public.recipes where menu_item_id = $1) and action in ('save', 'stop_tracking') order by id`, [burgerId]);
ok(events.length >= 6, 'every save is audited');
ok(events.some((e) => e.action === 'stop_tracking'), 'stop is audited');
const last = events.at(-1);
ok(last.after.lines && last.before.lines && last.after.dish === 'Chicken burger', 'diff has before/after lines');

// ===== 9. Idempotent PUT =====
const cmd = '11111111-1111-4111-8111-111111111111';
const dd = await dish('Idempotent', 10);
const first = await put('owner', dd, [L(rice, 100, 'g')], { commandId: cmd });
const again = await put('owner', dd, [L(rice, 999, 'g')], { commandId: cmd });
eq(again.version.version, 1, 'a retry returns the first result');
eq((await versionRows(dd)).length, 1, 'and does not write a second version');
eq(again.lines[0].qtyBase, first.lines[0].qtyBase, 'same lines');
await refuses(api('owner', 'PUT', `${base}/extras/${extraId}/recipe`, { lines: [], commandId: cmd }), 409, 'command_conflict', null, 'the id can’t be reused for another action');

// ===== 10. listRecipes: portions, limiting ingredient, sold out =====
await db.query('delete from public.menu_item_stock'); // keep only dishes we set up here
const lb = await dish('List burger', 400);
await put('owner', lb, [L(chicken, 200, 'g'), L(eggs, 1, 'piece')]);
const lf = await dish('List fries', 100);
await put('owner', lf, [L(rice, 250, 'g')], { allowWhenOut: true });
const ln = await dish('List salad', 100);
await stock(rice, '100', 'open-rice-small');
await db.query(`update public.stock_balances set on_hand = 1000 where location_id = $1 and item_id = $2`, [branchLocationId, chicken.id]);
await db.query(`update public.stock_balances set on_hand = 100 where location_id = $1 and item_id = $2`, [branchLocationId, eggs.id]);
let list = await api('owner', 'GET', `${base}/recipes`, undefined, { query: `?branch=${branchId}` });
const row = (name) => list.dishes.find((d) => d.name === name);
eq([row('List burger').source, row('List burger').portions, row('List burger').limitingItem.name, row('List burger').soldOut], ['recipe', 3, 'Chicken', false], '1000 g / 285.7 g = 3 portions, chicken limits');
eq([row('List salad').source, row('List salad').tracked, row('List salad').portions], ['none', false, null], 'untracked dish');
eq([row('List fries').soldOut, row('List fries').allowWhenOut], [false, true], 'keep-selling dish is never sold out');
eq(row('List burger').foodCost, { cost: '100.10', costPct: '25.0', unknown: [] }, 'list has cost and % for those who may see it');
eq(list.summary.dishes, list.dishes.length, 'summary counts dishes');
await db.query(`update public.stock_balances set on_hand = 100 where location_id = $1 and item_id = $2`, [branchLocationId, chicken.id]);
list = await api('manager', 'GET', '/api/inventory/recipes', undefined, { branch: branchId });
eq([row('List burger').portions, row('List burger').soldOut], [0, true], '100 g of chicken: sold out');
eq(list.summary.soldOut >= 1, true, 'summary counts sold out');
await refuses(api('owner', 'GET', `${base}/recipes`), 400, 'branch_required', null, 'owner must choose a branch when there are several');
await refuses(api('owner', 'GET', `${base}/recipes`, undefined, { query: `?branch=${'00000000-0000-4000-8000-000000000000'}` }), 404, 'branch_not_found', null, 'unknown branch');
await refuses(api('manager2', 'GET', `${base}/recipes`, undefined, { query: `?branch=${branchId}` }), 403, 'forbidden', null, 'another branch’s manager can’t list this branch');
eq((await api('ops', 'GET', `${base}/recipes`, undefined, { query: `?branch=${branchId}` })).canEdit, false, 'operations manager lists read-only');

// ===== 11. AI suggestion: draft only, fetch stubbed =====
const realFetch = globalThis.fetch;
const savedKey = process.env.OPENROUTER_API_KEY;
let calls = 0; let sent = null;
globalThis.fetch = async (url, init) => {
  calls++; sent = JSON.parse(init.body);
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ lines: [
    { name: 'chicken', quantity: 180, unit: 'grams' }, { name: 'Brioche bun', quantity: 1, unit: 'piece' }, { name: 'Rice', quantity: 2, unit: 'tray' }, { name: 'Eggs', quantity: 1, unit: 'trays' },
  ], note: 'Typical burger' }) } }] }) };
};
delete process.env.OPENROUTER_API_KEY;
const sdish = await dish('AI burger', 100);
await refuses(api('owner', 'POST', `${base}/recipes/${sdish}/suggest`, {}), 503, 'ai_not_configured', null, 'no key -> 503');
eq(calls, 0, 'no network call without a key');
process.env.OPENROUTER_API_KEY = 'test-key';
// P2-33: the draft goes through the AI gateway, so the business needs an allowance (no row = AI off, not unmetered).
await refuses(api('owner', 'POST', `${base}/recipes/${sdish}/suggest`, {}), 403, 'ai_off', /AI suggestions are off/, 'no allowance -> AI off');
eq(calls, 0, 'and still no network call');
await db.query(`insert into public.ai_business_settings (business_id, enabled) values ($1, true)`, [businessId]);
await db.query(`insert into public.ai_limits (business_id, monthly_budget_kes) values ($1, 1000)`, [businessId]);
const suggestion = await api('owner', 'POST', `${base}/recipes/${sdish}/suggest`, {});
eq(calls, 1, 'one stubbed call');
eq((await all(`select feature, status from public.ai_usage`)).map((r) => [r.feature, r.status]), [['recipe_draft', 'ok']], 'the draft was metered');
eq(suggestion.draft, true, 'marked as a draft');
eq(suggestion.lines[0], { itemId: chicken.id, name: 'Chicken', quantity: 180, unit: 'g', newItem: false }, 'matched to the existing item with a valid unit code');
eq(suggestion.lines[1].newItem, true, 'unknown ingredient flagged as a new item');
ok(suggestion.lines[2].warning && suggestion.lines[2].unit === 'g', 'a unit that doesn’t fit the item falls back to its base unit with a warning');
eq([suggestion.lines[3].itemId, suggestion.lines[3].unit], [eggs.id, 'tray'], 'the item’s own unit (tray) is accepted');
ok(!JSON.stringify(sent).includes('0.35') && !JSON.stringify(sent).includes('500'), 'no costs or prices are sent');
eq((await all('select 1 from public.recipes where menu_item_id = $1', [sdish])).length, 0, 'suggesting saved nothing');
const saved = await put('owner', sdish, suggestion.lines.filter((l) => l.itemId && !l.warning).map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit })));
eq(saved.lines.length, 2, 'the manager can save the reviewed draft as it is (unit codes are valid for units.js)');
await refuses(api('manager2', 'POST', `${base}/recipes/${sdish}/suggest`, {}), 403, 'forbidden', null, 'suggest needs recipe.edit at that branch');
await refuses(api('ops', 'POST', `${base}/recipes/${sdish}/suggest`, {}), 403, 'forbidden', null, 'operations can’t suggest');
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) });
// A different dish: the gateway answers an identical request from its cache (no second charge), so reusing sdish would not reach the stub.
const sdish2 = await dish('AI burger 2', 100);
await refuses(api('owner', 'POST', `${base}/recipes/${sdish2}/suggest`, {}), 502, 'ai_bad_answer', null, 'unusable answer -> 502');
eq((await all(`select status from public.ai_usage order by created_at`)).map((r) => r.status), ['ok', 'rejected'], 'an unusable answer is metered as rejected');
const cachedAgain = await api('owner', 'POST', `${base}/recipes/${sdish}/suggest`, {});
eq(cachedAgain.lines.length, suggestion.lines.length, 'asking again for the same dish is answered from the gateway cache');
globalThis.fetch = realFetch;
if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;

// ===== 12. Missing migration 013 -> one plain 503 =====
const without013 = makeApi(() => ({ query: async (sql, params) => {
  if (/public\.recipes/.test(sql)) throw Object.assign(new Error('relation "public.recipes" does not exist'), { code: '42P01' });
  return db.query(sql, params);
} }));
await refuses(without013('owner', 'GET', `${base}/recipes/${burgerId}`), 503, 'inventory_schema_missing', /database update 013/, 'missing 013 tables');

console.log(`recipes.test.js: ${checks} checks passed`);
process.exit(0);
