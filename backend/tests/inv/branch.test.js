// Branch inventory API + notifications API (P1-12). Runs the REAL route handlers (routes/inventory-branch.js and
// routes/notifications.js, via createRoutes) against an in-memory database with migrations 012 + 013 applied.
// Usage: node backend/tests/inv/branch.test.js
import assert from 'node:assert/strict';
import { inventoryFixture } from './fixture.js';
import { createUser } from '../support/pg.js';
import { HttpError } from '../../src/lib/http.js';
import { branchLocation } from '../../src/stock/service.js';
import { availability as legacyAvailability } from '../../src/stock/service.js';
import { menuVersion } from '../../src/lib/cache.js';
import { REASONS } from '../../src/inventory/ledger.js';
import { REASON_LABELS } from '../../src/inventory/branch.js';
import { createRoutes as branchRoutes } from '../../src/routes/inventory-branch.js';
import { createRoutes as notificationRoutes } from '../../src/routes/notifications.js';

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

const f = await inventoryFixture({ extra: ['proposed/012_inventory_catalogue.sql', 'proposed/013_inventory_recipes.sql'] });
const { db, ids, users } = f;
const { businessId, branchId, branchLocationId } = ids;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (sql, params) => (await db.query(sql, params)).rows;

// A second branch + manager, an operations manager for branch 1, a stranger and an admin.
const branch2 = (await one(`insert into public.restaurants (owner_id, name, status, business_id, owner_primary) values ($1, 'Second branch', 'live', $2, false) returning id`, [users.owner, businessId])).id;
const branch2Location = await db.transaction((t) => branchLocation(t, branch2));
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
const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
  return contexts[who];
};
const deps = { authenticate, pool: () => db, transact: (fn) => db.transaction(fn) };
const tables = { branch: branchRoutes(deps), notifications: notificationRoutes(deps) };
const call = async (table, as, method, pathname, body, query = '', branch = branchId) => {
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
const api = (as, method, pathname, body, query, branch) => call('branch', as, method, pathname, body, query, branch);
const notes = (as, method, pathname, body, query) => call('notifications', as, method, pathname, body, query, null);

// ---- data helpers ----
const item = async (name, { unit = 'g', display = null, cost = null, low = null } = {}) =>
  (await one(`insert into public.stock_items (business_id, name, unit, display_unit, avg_cost, low_level) values ($1, $2, $3, $4, $5, $6) returning id`, [businessId, name, unit, display, cost, low])).id;
const dish = async (name) => (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, 100) returning id`, [branchId, ids.categoryId, name])).id;
const recipe = async (menuItem, lines, { allow = false } = {}) => {
  const r = await one(`insert into public.recipes (business_id, restaurant_id, menu_item_id, allow_when_out) values ($1, $2, $3, $4) returning id`, [businessId, branchId, menuItem, allow]);
  const v = await one(`insert into public.recipe_versions (business_id, recipe_id, version, created_by) values ($1, $2, 1, $3) returning id`, [businessId, r.id, users.manager]);
  let pos = 0;
  for (const [i, qty] of lines) await db.query(`insert into public.recipe_lines (business_id, version_id, item_id, position, qty_base) values ($1, $2, $3, $4, $5)`, [businessId, v.id, i, pos++, qty]);
  await db.query(`update public.recipes set current_version_id = $2 where id = $1`, [r.id, v.id]);
};
const place = async (lines, status = 'taken') => {
  const o = (await one(`insert into public.orders (restaurant_id, status, taken_by) values ($1, $2, $3) returning id`, [branchId, status, users.waiter])).id;
  await db.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, position, kind, extras, components)
    select $1, $2, (l->>'itemId')::uuid, l->>'name', 100, (l->>'quantity')::int, 100, 0, 'item', '[]'::jsonb, null from jsonb_array_elements($3::jsonb) l`, [o, branchId, JSON.stringify(lines)]);
  return o;
};
const serve = (o) => db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [o, users.waiter]);
const cancel = (o) => db.query(`update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = $2 where id = $1`, [o, users.waiter]);
const onHand = async (i, l = branchLocationId) => Number((await one(`select on_hand from public.stock_balances where location_id = $1 and item_id = $2`, [l, i]))?.on_hand ?? 0);
const denied = (userId) => rows(`select location_id, entity, after from public.inventory_events where action = 'denied' and actor_id = $1 order by id`, [userId]);

const chicken = await item('Chicken', { display: 'kg', cost: '0.5' });
const buns = await item('Buns', { unit: 'piece' });
const burger = ids.burgerId;
await recipe(burger, [[chicken, 200], [buns, 1]]);
await db.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 5000), ($1, $3, 40)`, [branchLocationId, chicken, buns]);

// =============================================================================================================
// 0. Switched off: availability behaves exactly as today; everything else says "switch it on"
// =============================================================================================================
{
  const legacy = await legacyAvailability(db, branchId);
  eq((await api('waiter', 'GET', '/api/inventory/availability')).items, legacy, 'disabled: availability = today’s /api/stock/availability');
  ok(legacy.length === 1 && legacy[0].menuItemId === burger, 'the burger is tracked (via recipe)');
  eq((await api('manager', 'GET', '/api/inventory/availability', undefined, '', null)).items, legacy, 'disabled: no header needed for a one-branch member');
  await refuses(api('manager', 'GET', '/api/inventory'), 403, 'inventory_disabled', /switched on/, 'snapshot refused while off');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 1, unit: 'kg' }), 403, 'inventory_disabled', null, 'record refused while off');
  await refuses(api('stranger', 'GET', '/api/inventory/availability'), 403, 'branch_forbidden', null, 'disabled: stranger still refused availability');
  await refuses(api('manager2', 'GET', '/api/inventory/availability'), 403, 'branch_forbidden', null, 'disabled: other branch’s manager refused availability');
  eq((await denied(manager2)).length, 0, 'disabled refusals are not audited');
}
await db.query('update public.businesses set inventory_enabled = true where id = $1', [businessId]);
await db.query(`update public.stock_items set avg_cost = 0.5 where id = $1`, [chicken]);

// =============================================================================================================
// 1. Snapshot: on hand, held for orders, available, value, flags, dishes
// =============================================================================================================
let heldOrder;
{
  heldOrder = await place([{ itemId: burger, name: 'Chicken burger', quantity: 2 }]); // holds 400 g chicken, 2 buns
  const s = await api('manager', 'GET', '/api/inventory');
  const c = s.items.find((i) => i.id === chicken);
  eq([c.onHand, c.heldForOrders, c.reserved, c.available], ['5000.0000', '400.0000', '0.0000', '4600.0000'], 'on hand 5000 g, 400 g held, 4600 g available');
  eq(c.display, { onHand: '5 kg', heldForOrders: '0.4 kg', reserved: '0 kg', available: '4.6 kg' }, 'friendly kg displays');
  eq([c.value, c.avgCost, c.dishes, c.state, c.low, c.out, c.countNeeded, c.status], ['2500.00', '0.500000', 1, 'ok', false, false, false, 'OK'], 'value, dishes and flags');
  const b = s.items.find((i) => i.id === buns);
  eq([b.onHand, b.heldForOrders, b.available, b.display.available], ['40.0000', '2.0000', '38.0000', '38 pieces'], 'buns counted by the piece');
  eq(s.location, { id: branchLocationId, name: 'Main branch', restaurantId: branchId }, 'location');
  eq([s.summary.items, s.summary.low, s.summary.out, s.summary.countNeeded, s.summary.value, s.summary.valueComplete], [2, 0, 0, 0, '2500.00', false], 'summary counts (buns have no cost, so the total is flagged incomplete)');
  eq([s.dishes.tracked, s.dishes.soldOut, s.openExceptions], [1, [], 0], 'dishes tracked, none sold out, no exceptions');
  ok(typeof s.generatedAt === 'string', 'generatedAt');
  ok(c.units.some((u) => u.code === 'kg'), 'unit dropdown included');

  // Branch-only items: an item with no balance, level or recipe here is hidden unless ?all=1.
  const spare = await item('Spare salt');
  ok(!s.items.some((i) => i.id === spare), 'unrelated catalogue item not listed');
  const all = await api('manager', 'GET', '/api/inventory', undefined, '?all=1');
  ok(all.items.some((i) => i.id === spare), '?all=1 lists the whole catalogue');
  // A level alone makes an item "stocked here"; a recipe line alone makes it "used here" and flags a count.
  await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, reorder) values ($1, $2, $3, 100)`, [branchLocationId, spare, businessId]);
  const withLevel = (await api('manager', 'GET', '/api/inventory')).items.find((i) => i.id === spare);
  eq([withLevel.onHand, withLevel.out, withLevel.low], ['0.0000', true, false], 'a level alone lists it (out, nothing counted)');
  const pepper = await item('Pepper');
  const peppery = await dish('Peppery dish');
  await recipe(peppery, [[pepper, 5]]);
  const used = (await api('manager', 'GET', '/api/inventory')).items.find((i) => i.id === pepper);
  eq([used.onHand, used.countNeeded, used.dishes, used.status], ['0.0000', true, 1, 'Out'], 'used by a recipe but never counted: listed, out, count needed');
  ok(/never been counted/.test(used.countNeededReason), 'plain reason');

  // Low: reorder level 5000 g with 4600 available.
  await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, reorder, min) values ($1, $2, $3, 5000, 1000)
    on conflict (location_id, item_id) do update set reorder = 5000`, [branchLocationId, chicken, businessId]);
  const low = (await api('manager', 'GET', '/api/inventory')).items.find((i) => i.id === chicken);
  eq([low.low, low.state, low.status, low.levelDisplay.reorder], [true, 'low', 'Low', '5 kg'], 'available under the reorder level is Low');
  await db.query(`update public.stock_item_levels set reorder = 1000 where location_id = $1 and item_id = $2`, [branchLocationId, chicken]);

  // Sold out dish (limiting ingredient): hold everything, the dish shows as sold out.
  await db.query(`update public.stock_balances set on_hand = 2 where location_id = $1 and item_id = $2`, [branchLocationId, buns]);
  const so = await api('manager', 'GET', '/api/inventory');
  eq(so.dishes.soldOut.map((d) => [d.name, d.itemName]), [['Chicken burger', 'Buns'], ['Peppery dish', 'Pepper']], 'sold-out dish listed with its limiting ingredient');
  await db.query(`update public.stock_balances set on_hand = 40 where location_id = $1 and item_id = $2`, [branchLocationId, buns]);
  await db.query(`delete from public.recipes where menu_item_id = $1`, [peppery]);
  await db.query(`delete from public.stock_item_levels where item_id = $1`, [spare]);

  // Costs only for cost.view holders; operations sees the snapshot but no records.
  const opsView = await api('ops', 'GET', '/api/inventory');
  ok(opsView.items.length && opsView.items[0].value !== undefined, 'operations holds inv.cost.view');
  const waiterErr = await api('waiter', 'GET', '/api/inventory').catch((e) => e);
  eq(waiterErr.status, 403, 'waiter cannot see the stock snapshot');
}

// =============================================================================================================
// 2. Count
// =============================================================================================================
{
  const r = await api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: chicken, quantity: '4.8', unit: 'kg', note: 'Morning count' });
  eq([r.changed, r.movement.reason, r.movement.delta, r.onHand, r.display.onHand, r.display.change], [true, 'count_correction', '-200.0000', '4800.0000', '4.8 kg', '-0.2 kg'], 'count 4.8 kg vs 5 kg posts -200 g as count_correction');
  eq(r.movement.reasonLabel, 'Count', 'label');
  ok(/Counted 4\.8 kg/.test(r.message) && /Stock was 5 kg/.test(r.message), `plain message: ${r.message}`);
  const mv = await one(`select note, entered_quantity, reason, actor_id from public.stock_movements where id = $1`, [r.movement.id]);
  ok(/^Counted 4\.8 kg \(was 5 kg\): Morning count$/.test(mv.note) && mv.entered_quantity === null && mv.actor_id === users.manager, 'note keeps what was counted; actor recorded');
  const same = await api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: chicken, quantity: 4800, unit: 'g' });
  eq([same.changed, same.movement, same.onHand], [false, null, '4800.0000'], 'count equal to the books posts nothing');
  ok(/^No change/.test(same.message), `no change message: ${same.message}`);
  eq((await rows(`select 1 from public.stock_movements where item_id = $1 and location_id = $2 and reason = 'count_correction'`, [chicken, branchLocationId])).length, 1, 'only one correction row exists');
  // Below what open orders hold: allowed, with a warning.
  const warn = await api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: chicken, quantity: '0.3', unit: 'kg' });
  eq([warn.changed, warn.onHand], [true, '300.0000'], 'a count below the held amount is allowed');
  ok(warn.warnings.length === 1 && /less than the 0\.4 kg held for open orders/.test(warn.warnings[0]), `warning: ${warn.warnings}`);
  await api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: chicken, quantity: 5, unit: 'kg' });
  eq(await onHand(chicken), 5000, 'counted back to 5 kg');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: chicken, quantity: -1, unit: 'kg' }), 400, 'negative_quantity', null, 'negative count');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: chicken, unit: 'kg' }), 400, 'quantity_required', /how much you counted/, 'blank count');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: chicken, quantity: 1, unit: 'L' }), 400, 'unit_mismatch', null, 'wrong unit dimension');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'steal', itemId: chicken, quantity: 1, unit: 'kg' }), 400, 'bad_kind', null, 'unknown kind');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: '00000000-0000-4000-8000-000000000000', quantity: 1, unit: 'kg' }), 404, 'item_not_found', null, 'unknown item');
}

// =============================================================================================================
// 3. Add and waste
// =============================================================================================================
{
  const v0 = menuVersion(branchId);
  const r = await api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 2, unit: 'kg', note: 'Top-up' });
  eq([r.movement.reason, r.movement.delta, r.movement.entered, r.onHand, r.display.change], ['adjustment_gain', '2000.0000', { quantity: '2.0000', unit: 'kg' }, '7000.0000', '+2 kg'], 'add 2 kg -> adjustment_gain, entered kept');
  ok(menuVersion(branchId) > v0, 'the public menu cache is invalidated after a record');

  // With a cost per entered unit: stored per base unit, re-averages the item's cost. Still adjustment_gain.
  const c = await api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 1, unit: 'kg', unitCost: '1000' });
  eq(c.movement.reason, 'adjustment_gain', 'add with a cost stays adjustment_gain');
  const m = await one(`select unit_cost::text as unit_cost, value::text as value from public.stock_movements where id = $1`, [c.movement.id]);
  eq(m, { unit_cost: '1.000000', value: '1000.00' }, 'KES 1,000 per kg is stored as 1.00 per gram');
  const avg = Number((await one(`select avg_cost from public.stock_items where id = $1`, [chicken])).avg_cost);
  ok(avg > 0.5 && avg < 1, `average cost moved towards the new price (${avg})`);
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'waste', itemId: chicken, quantity: 1, unit: 'kg', note: 'x', unitCost: 5 }), 400, 'cost_not_allowed', null, 'cost only with add');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 0, unit: 'kg' }), 400, 'zero_quantity', null, 'zero add');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 1, unit: 'kg', unitCost: -1 }), 400, 'bad_cost', null, 'negative cost');

  // Waste needs a note.
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'waste', itemId: chicken, quantity: 500, unit: 'g' }), 400, 'note_required', /Say why Chicken was written off/, 'waste without a note');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'waste', itemId: chicken, quantity: 500, unit: 'g', note: '   ' }), 400, 'note_required', null, 'blank note');
  const before = await onHand(chicken);
  const w = await api('manager', 'POST', '/api/inventory/record', { kind: 'waste', itemId: chicken, quantity: 500, unit: 'g', note: 'Spoiled in the fridge', reasonCode: 'spoiled' });
  eq([w.movement.reason, w.movement.delta, w.movement.reasonLabel, w.onHand], ['wastage', '-500.0000', 'Waste', String(before - 500) + '.0000'], 'waste posts wastage');
  eq((await one(`select note from public.stock_movements where id = $1`, [w.movement.id])).note, 'spoiled: Spoiled in the fridge', 'reason code goes in front of the note');
  ok(/^Wrote off 0\.5 kg of Chicken\./.test(w.message), `message: ${w.message}`);

  // Stop at zero: over-waste is refused with the ledger's plain message; nothing changes.
  const now = await onHand(chicken);
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'waste', itemId: chicken, quantity: 100, unit: 'kg', note: 'oops', confirmLarge: true }), 409, 'insufficient_stock',
    /Only 7\.5 kg of Chicken left here; you tried to take 100 kg/, 'stop at zero');
  eq(await onHand(chicken), now, 'balance unchanged by the refused waste');

  // Idempotent retry with the same commandId.
  const commandId = '11111111-1111-4111-8111-111111111111';
  const a = await api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: buns, quantity: 10, unit: 'piece', commandId });
  const b = await api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: buns, quantity: 10, unit: 'piece', commandId });
  eq([b.movement.id, await onHand(buns)], [a.movement.id, 50], 'a retried command adds once');
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: buns, quantity: 1, unit: 'piece', commandId: 'nope' }), 400, 'bad_command_id', null, 'bad command id');

  // Items in other units: packs.
  const sack = await item('Rice', { display: 'kg' });
  await db.query(`insert into public.stock_item_units (item_id, name, factor) values ($1, 'sack', 25000)`, [sack]);
  const rice = await api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: sack, quantity: 2, unit: 'sack' });
  eq([rice.onHand, rice.display.onHand], ['50000.0000', '50 kg · 2 sacks'], 'packs convert to base: 2 sacks = 50 kg');
}

// =============================================================================================================
// 4. Large-amount confirmation
// =============================================================================================================
{
  const flour = await item('Flour', { display: 'kg' });
  await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, reorder) values ($1, $2, $3, 1000)`, [branchLocationId, flour, businessId]); // 1 kg normal -> limit 10 kg
  const body = { kind: 'add', itemId: flour, quantity: '4000', unit: 'kg' };
  let err = await api('manager', 'POST', '/api/inventory/record', body).catch((e) => e);
  eq([err.status, err.details.code, err.message], [409, 'confirm_large_amount', '4,000 kg is a lot for Flour. Did you mean 4 kg?'], 'large amount asks "Did you mean 4 kg?"');
  eq([err.details.suggestion, err.details.confirmWith], [{ quantity: '4', unit: 'kg' }, 'confirmLarge'], 'suggestion in the details');
  eq(await onHand(flour), 0, 'nothing posted while unconfirmed');
  const fine = await api('manager', 'POST', '/api/inventory/record', { ...body, quantity: '4' });
  eq(fine.onHand, '4000.0000', 'the suggested 4 kg goes straight through');
  const confirmed = await api('manager', 'POST', '/api/inventory/record', { ...body, confirmLarge: true });
  eq(confirmed.onHand, '4004000.0000', 'confirmLarge: true posts the large amount');
  // Waste and count are checked too; a count is compared as typed.
  err = await api('manager', 'POST', '/api/inventory/record', { kind: 'count', itemId: flour, quantity: 90000, unit: 'kg' }).catch((e) => e);
  eq(err.details?.code, 'confirm_large_amount', 'a huge count asks too');
  // The factor is a setting.
  await db.query(`insert into public.inventory_settings (business_id, key, value) values ($1, 'large_amount_warning_factor', '1000')`, [businessId]);
  const ok1 = await api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: flour, quantity: 500, unit: 'kg' });
  eq(ok1.changed, true, 'with the factor raised to 1000, 500 kg is normal');
  await db.query(`delete from public.inventory_settings where business_id = $1`, [businessId]);
  // No history and no level: nothing to compare with, no warning.
  const salt = await item('Salt');
  eq((await api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: salt, quantity: 999999, unit: 'g' })).changed, true, 'no baseline, no warning');
}

// =============================================================================================================
// 5. History
// =============================================================================================================
let servedOrder;
{
  servedOrder = await place([{ itemId: burger, name: 'Chicken burger', quantity: 1 }]);
  await serve(servedOrder);
  const h = await api('manager', 'GET', '/api/inventory/history', undefined, `?itemId=${chicken}`);
  const served = h.movements.find((m) => m.reason === 'served');
  eq([served.reasonLabel, served.display.delta, served.itemName, served.by.name], ['Served in orders', '-0.2 kg', 'Chicken', 'waiter'], 'served movement: label, friendly delta, actor name');
  eq([served.order.id, served.order.shortId, served.order.link], [servedOrder, servedOrder.slice(0, 6), `/branch/${branchId}/orders?order=${servedOrder.slice(0, 6)}`], 'order short id and link');
  const newest = h.movements.map((m) => Number(m.id));
  eq(newest, [...newest].sort((a, b) => b - a), 'newest first');
  const labels = Object.fromEntries(h.movements.map((m) => [m.reason, m.reasonLabel]));
  eq([labels.count_correction, labels.wastage, labels.adjustment_gain], ['Count', 'Waste', 'Stock added'], 'labels for count, waste and add');
  const add = h.movements.find((m) => m.reason === 'adjustment_gain' && m.entered?.unit === 'kg');
  eq([add.entered.unit, add.by.name], ['kg', 'manager'], 'entered unit and actor on an add');
  ok(h.movements.every((m) => m.unitCost !== undefined), 'cost shown to a cost.view holder');
  for (const reason of Object.keys(REASONS)) ok(typeof REASON_LABELS[reason] === 'string' && REASON_LABELS[reason].length > 2, `every ledger reason has a plain label: ${reason}`);
  eq(h.movements.find((m) => m.reason === 'count_correction').reasonLabel, 'Count', 'count label');
  // Paging.
  const p1 = await api('manager', 'GET', '/api/inventory/history', undefined, '?limit=3');
  eq(p1.movements.length, 3, 'limit');
  ok(p1.nextBefore, 'a cursor is returned when there is more');
  const p2 = await api('manager', 'GET', '/api/inventory/history', undefined, `?limit=3&before=${p1.nextBefore}`);
  ok(p2.movements.length > 0 && Number(p2.movements[0].id) < Number(p1.movements.at(-1).id), 'the next page continues below the cursor');
  await refuses(api('manager', 'GET', '/api/inventory/history', undefined, '?before=abc'), 400, 'bad_cursor', null, 'bad cursor');
  await refuses(api('manager', 'GET', '/api/inventory/history', undefined, '?itemId=nope'), 400, 'bad_id', null, 'bad item id');
  await refuses(api('waiter', 'GET', '/api/inventory/history'), 403, 'forbidden', null, 'waiter has no history');
}

// =============================================================================================================
// 6. Exceptions: a keep-selling dish served short, then resolved
// =============================================================================================================
let exceptionId;
{
  const tomato = await item('Tomatoes', { display: 'kg', cost: '0.2' });
  const salad = await dish('Tomato salad');
  await recipe(salad, [[tomato, 300]], { allow: true });
  await db.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 100)`, [branchLocationId, tomato]);
  const o = await place([{ itemId: salad, name: 'Tomato salad', quantity: 1 }]);
  await serve(o);
  eq(await onHand(tomato), 0, 'served short: stock stops at 0');
  const list = await api('manager', 'GET', '/api/inventory/exceptions');
  eq([list.openCount, list.exceptions.length], [1, 1], 'one open exception');
  const e = list.exceptions[0];
  exceptionId = e.id;
  eq([e.itemName, e.shortQty, e.display.shortQty, e.status, e.order.shortId, e.estimatedValue], ['Tomatoes', '200.0000', '0.2 kg', 'open', o.slice(0, 6), '40.00'], 'exception details');
  ok(new RegExp(`Tomatoes was short by 0\\.2 kg on order #${o.slice(0, 6)}`).test(e.message), `plain message: ${e.message}`);
  const snap = (await api('manager', 'GET', '/api/inventory')).items.find((i) => i.id === tomato);
  eq([snap.openExceptions, snap.countNeeded, snap.out], [1, true, true], 'the snapshot flags the item: count needed');
  ok(/served without enough/.test(snap.countNeededReason), 'reason in plain words');
  eq((await api('manager', 'GET', '/api/inventory')).openExceptions, 1, 'snapshot carries the open exceptions count');

  // The owner and the branch manager were notified by the trigger; the waiter was not.
  const mine = await notes('manager', 'GET', '/api/notifications');
  const n = mine.notifications.find((x) => x.kind === 'stock_exception');
  eq([n.title, n.read, n.entityId, n.link], ['Tomatoes was short at Main branch', false, exceptionId, `/branch/${branchId}/inventory`], 'branch manager notified of the exception');
  eq((await notes('owner', 'GET', '/api/notifications')).notifications.some((x) => x.kind === 'stock_exception' && x.entityId === exceptionId), true, 'owner notified too');
  eq((await notes('waiter', 'GET', '/api/notifications')).notifications.length, 0, 'waiter gets nothing');

  // Others cannot resolve; the right branch manager can.
  await refuses(api('waiter', 'POST', `/api/inventory/exceptions/${exceptionId}/resolve`, {}), 403, 'forbidden', null, 'waiter cannot resolve');
  await refuses(api('ops', 'POST', `/api/inventory/exceptions/${exceptionId}/resolve`, {}), 403, 'forbidden', null, 'operations cannot resolve');
  await refuses(api('manager2', 'POST', `/api/inventory/exceptions/${exceptionId}/resolve`, {}, '', branch2), 404, 'exception_not_found', null, 'other branch’s manager at their own branch: not found');
  await refuses(api('manager', 'POST', '/api/inventory/exceptions/00000000-0000-4000-8000-000000000000/resolve', {}), 404, 'exception_not_found', null, 'unknown exception');
  eq((await one(`select status from public.stock_exceptions where id = $1`, [exceptionId])).status, 'open', 'still open after refusals');
  const r = await api('manager', 'POST', `/api/inventory/exceptions/${exceptionId}/resolve`, { note: 'Counted: tomatoes were fine, just re-stocked.' });
  eq([r.status, r.itemName], ['resolved', 'Tomatoes'], 'resolved');
  const row = await one(`select status, resolved_by, resolved_at is not null as at, note from public.stock_exceptions where id = $1`, [exceptionId]);
  eq([row.status, row.resolved_by, row.at, row.note], ['resolved', users.manager, true, 'Counted: tomatoes were fine, just re-stocked.'], 'who, when and why are stored');
  const ev = await one(`select actor_id, location_id, before, after from public.inventory_events where entity = 'stock_exception' and action = 'resolve' and entity_id = $1`, [exceptionId]);
  eq([ev.actor_id, ev.location_id, ev.before.status, ev.after.status], [users.manager, branchLocationId, 'open', 'resolved'], 'resolution is audited');
  await refuses(api('manager', 'POST', `/api/inventory/exceptions/${exceptionId}/resolve`, {}), 409, 'already_resolved', null, 'cannot resolve twice');
  eq((await api('manager', 'GET', '/api/inventory/exceptions')).exceptions, [], 'open list is empty now');
  eq((await api('manager', 'GET', '/api/inventory/exceptions', undefined, '?status=resolved')).exceptions.map((x) => x.status), ['resolved'], 'resolved list');
  eq((await api('manager', 'GET', '/api/inventory/exceptions', undefined, '?status=all')).exceptions.length, 1, 'all list');
  await refuses(api('manager', 'GET', '/api/inventory/exceptions', undefined, '?status=bogus'), 400, 'bad_status', null, 'bad status');
  eq((await api('manager', 'GET', '/api/inventory')).openExceptions, 0, 'snapshot count back to 0');
}

// =============================================================================================================
// 7. Branch isolation (T-SEC-1) and roles
// =============================================================================================================
{
  const before = (await denied(manager2)).length;
  await refuses(api('manager2', 'GET', '/api/inventory'), 403, 'forbidden', null, 'T-SEC-1 other branch’s manager: snapshot');
  await refuses(api('manager2', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 1, unit: 'kg' }), 403, 'forbidden', null, 'T-SEC-1: record');
  await refuses(api('manager2', 'GET', '/api/inventory/history'), 403, 'forbidden', null, 'T-SEC-1: history');
  await refuses(api('manager2', 'GET', '/api/inventory/exceptions'), 403, 'forbidden', null, 'T-SEC-1: exceptions');
  await refuses(api('manager2', 'GET', `/api/inventory/items/${chicken}`), 403, 'forbidden', null, 'T-SEC-1: item detail');
  await refuses(api('manager2', 'GET', '/api/inventory/availability'), 403, 'forbidden', null, 'T-SEC-1: availability of another branch');
  const events = await denied(manager2);
  eq(events.length - before, 6, 'every refusal wrote a denied audit event');
  eq(events.at(-1).location_id, branchLocationId, 'the denial names the branch they tried to reach');
  eq((await onHand(chicken, branch2Location)), 0, 'nothing was posted at either branch');

  // A branch manager works at their own branch.
  const own = await api('manager2', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 3, unit: 'kg' }, '', branch2);
  eq([own.onHand, own.display.onHand], ['3000.0000', '3 kg'], 'manager2 adds stock at branch 2');
  ok(await onHand(chicken) > 0 && await onHand(chicken) !== 3000, 'branch 1 balance is its own');
  const snap2 = await api('manager2', 'GET', '/api/inventory', undefined, '', branch2);
  eq(snap2.items.map((i) => i.name), ['Chicken'], 'branch 2 lists only what it stocks');
  eq(snap2.items[0].onHand, '3000.0000', 'branch 2 sees its own number');
  const detail = await api('manager', 'GET', `/api/inventory/items/${chicken}`);
  ok(detail.movements.every((m) => m.locationId === branchLocationId), 'item detail at branch 1 has no branch 2 movements');
  eq([detail.location.locationId, detail.location.heldForOrders, detail.location.display.heldForOrders], [branchLocationId, '400.0000', '0.4 kg'], 'item detail: this branch’s balance with held');
  ok(detail.movements.length > 0 && detail.movements.every((m) => typeof m.reasonLabel === 'string'), 'detail movements are labelled');
  ok(detail.locations === undefined && detail.totals === undefined, 'no other locations leak into the detail');
  ok(detail.compatibleUnits.length > 0, 'unit dropdown');
  // No header: a member of one branch uses it; an owner of the business with a membership too; an unknown branch is refused.
  eq((await api('manager2', 'GET', '/api/inventory', undefined, '', null)).location.id, branch2Location, 'no header = my only branch');
  await refuses(api('ops', 'GET', '/api/inventory', undefined, '', null), 409, 'branch_required', null, 'a caller with no branch membership must name one');
  eq((await api('ops', 'GET', '/api/inventory')).location.id, branchLocationId, 'operations manager can read their assigned branch');
  await refuses(api('ops', 'GET', '/api/inventory', undefined, '', branch2), 403, 'forbidden', null, 'operations manager: not their branch');
  await refuses(api('manager', 'GET', '/api/inventory', undefined, '', '00000000-0000-4000-8000-000000000000'), 403, 'branch_forbidden', null, 'unknown branch looks like a forbidden one');
  await refuses(api('manager', 'GET', '/api/inventory', undefined, '', 'not-a-uuid'), 400, 'branch_invalid', null, 'malformed branch header');
  eq((await api('owner', 'GET', '/api/inventory', undefined, '', branch2)).location.id, branch2Location, 'the business owner can open any branch of theirs');
  await refuses(api('stranger', 'GET', '/api/inventory'), 403, 'forbidden', null, 'stranger');
  await refuses(api('admin', 'GET', '/api/inventory'), 403, 'forbidden', null, 'admin never sees stock');
  await refuses(api('nobody', 'GET', '/api/inventory'), 401, null, null, 'signed out');

  // Waiter: availability only.
  const w = await api('waiter', 'GET', '/api/inventory/availability');
  ok(Array.isArray(w.items), 'waiter reads availability');
  for (const [method, path, body] of [['GET', '/api/inventory'], ['GET', '/api/inventory/history'], ['GET', '/api/inventory/exceptions'], ['GET', `/api/inventory/items/${chicken}`],
    ['POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 1, unit: 'kg' }], ['POST', '/api/inventory/record', { kind: 'count', itemId: chicken, quantity: 1, unit: 'kg' }],
    ['POST', '/api/inventory/record', { kind: 'waste', itemId: chicken, quantity: 1, unit: 'kg', note: 'x' }]]) {
    await refuses(api('waiter', method, path, body), 403, 'forbidden', null, `waiter refused: ${method} ${path} ${body?.kind || ''}`);
  }
  ok((await denied(users.waiter)).length >= 7, 'the waiter’s refusals are audited');
  // Operations can look but not touch.
  await refuses(api('ops', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 1, unit: 'kg' }), 403, 'forbidden', null, 'operations cannot record');
}

// =============================================================================================================
// 8. Availability: same shape as today
// =============================================================================================================
{
  const legacy = await legacyAvailability(db, branchId);
  for (const who of ['waiter', 'manager', 'owner']) {
    eq((await api(who, 'GET', '/api/inventory/availability')).items, legacy, `${who}: enabled availability equals stock/service availability()`);
  }
  ok(legacy.length >= 2, 'several dishes tracked');
  eq(Object.keys(legacy[0]).sort(), ['allowWhenOut', 'available', 'menuItemId', 'servings', 'soldOut'], 'the shape the waiter app reads');
  ok(typeof legacy[0].available === 'number' && typeof legacy[0].soldOut === 'boolean', 'numbers and booleans, as today');
  eq((await api('waiter', 'GET', '/api/inventory/availability', undefined, '', null)).items, legacy, 'no header: the waiter’s only branch');
}

// =============================================================================================================
// 9. Notifications API
// =============================================================================================================
{
  const mgr = await notes('manager', 'GET', '/api/notifications');
  ok(mgr.notifications.length >= 1, 'manager has notifications');
  eq(mgr.unreadCount, mgr.notifications.filter((n) => !n.read).length, 'unread count in the list');
  eq((await notes('manager', 'GET', '/api/notifications/unread-count')).unreadCount, mgr.unreadCount, 'unread-count endpoint');
  ok(mgr.notifications.every((n) => ['stock_out', 'stock_exception'].includes(n.kind)), 'stock alerts only');
  const first = mgr.notifications[0];
  // Another user's id is ignored.
  const ownerOnly = await rows(`select id from public.notifications where recipient_id = $1 and id <> all($2::uuid[]) limit 1`, [users.owner, mgr.notifications.map((n) => n.id)]);
  ok(ownerOnly.length === 1, 'there is an owner-only notification to try to steal');
  const stolen = await notes('manager', 'POST', '/api/notifications/read', { ids: [ownerOnly[0].id] });
  eq(stolen.marked, 0, 'marking someone else’s notification marks nothing');
  eq((await one(`select read_at is null as unread from public.notifications where id = $1`, [ownerOnly[0].id])).unread, true, 'their row is still unread');
  const done = await notes('manager', 'POST', '/api/notifications/read', { ids: [first.id] });
  eq([done.marked, done.unreadCount], [1, mgr.unreadCount - 1], 'one marked read');
  eq((await notes('manager', 'POST', '/api/notifications/read', { ids: [first.id] })).marked, 0, 'marking again changes nothing');
  eq((await notes('manager', 'GET', '/api/notifications', undefined, '?unread=1')).notifications.some((n) => n.id === first.id), false, 'unread filter hides it');
  const page = await notes('manager', 'GET', '/api/notifications', undefined, '?limit=1');
  eq([page.notifications.length, typeof page.nextBefore], [1, mgr.notifications.length > 1 ? 'string' : 'object'], 'paging marker');
  await refuses(notes('manager', 'GET', '/api/notifications', undefined, '?before=yesterday-ish'), 400, 'bad_cursor', null, 'bad cursor');
  const all = await notes('manager', 'POST', '/api/notifications/read', { all: true });
  eq(all.unreadCount, 0, 'mark all read');
  eq((await notes('manager', 'GET', '/api/notifications/unread-count')).unreadCount, 0, 'unread count 0');
  ok((await notes('owner', 'GET', '/api/notifications/unread-count')).unreadCount > 0, 'the owner’s own unread rows are untouched');
  await refuses(notes('manager', 'POST', '/api/notifications/read', {}), 400, 'ids_required', null, 'must say what to mark');
  await refuses(notes('manager', 'POST', '/api/notifications/read', { ids: ['x'] }), 400, 'bad_id', null, 'bad id');
  await refuses(notes('nobody', 'GET', '/api/notifications'), 401, null, null, 'signed out');
  eq((await notes('stranger', 'GET', '/api/notifications')).notifications, [], 'a signed-in user with nothing gets an empty list');
}

// =============================================================================================================
// 10. Switch off again: record refused, availability keeps working
// =============================================================================================================
{
  await db.query('update public.businesses set inventory_enabled = false where id = $1', [businessId]);
  await refuses(api('manager', 'POST', '/api/inventory/record', { kind: 'add', itemId: chicken, quantity: 1, unit: 'kg' }), 403, 'inventory_disabled', null, 'record refused again');
  eq((await api('waiter', 'GET', '/api/inventory/availability')).items, await legacyAvailability(db, branchId), 'availability unchanged when switched off');
  await cancel(heldOrder);
}

console.log(`branch.test.js: ${checks} checks passed`);
