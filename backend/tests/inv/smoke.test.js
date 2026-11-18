// Smoke test for the inventory fixture: seeded rows exist and an order with the burger can be inserted.
// Usage: node backend/tests/inv/smoke.test.js
import assert from 'node:assert/strict';
import { inventoryFixture } from './fixture.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const { db, ids, users, helpers } = await inventoryFixture();
const count = async (sql, p) => (await helpers.one(sql, p)).n;

eq(await count(`select count(*)::int as n from public.businesses where id = $1`, [ids.businessId]), 1, 'one business');
eq(await count(`select count(*)::int as n from public.restaurants where business_id = $1 and status = 'live'`, [ids.businessId]), 1, 'one live branch');
eq((await helpers.one(`select kind from public.stock_locations where id = $1`, [ids.centerLocationId])).kind, 'center', 'center location');
eq((await helpers.one(`select restaurant_id from public.stock_locations where id = $1`, [ids.branchLocationId])).restaurant_id, ids.branchId, 'branch location');
eq(await count(`select count(*)::int as n from public.business_members where business_id = $1 and role = 'owner' and user_id = $2`, [ids.businessId, users.owner]), 1, 'business owner');
eq((await db.query(`select role from public.restaurant_members where restaurant_id = $1 and user_id = any($2) order by role`, [ids.branchId, [users.manager, users.waiter]])).rows.map((r) => r.role), ['manager', 'waiter'], 'branch manager and waiter');
eq((await db.query(`select name from public.menu_items where restaurant_id = $1 order by name`, [ids.branchId])).rows.map((r) => r.name), ['Chicken burger', 'Fries'], 'two menu items');
eq(await count(`select count(*)::int as n from public.menu_item_extras where item_id = $1 and name = 'Extra cheese'`, [ids.burgerId]), 1, 'extra on the burger');
eq(await count(`select count(*)::int as n from public.menu_deal_items where deal_id = $1`, [ids.dealId]), 2, 'deal = burger + fries');

const orderId = await helpers.order([{ itemId: ids.burgerId, name: 'Chicken burger', quantity: 2 }]);
eq(await count(`select count(*)::int as n from public.order_items where order_id = $1`, [orderId]), 1, 'order with a burger inserted');
const dealOrder = await helpers.order([{ kind: 'deal', name: 'Burger combo', quantity: 1, components: [{ itemId: ids.burgerId, name: 'Chicken burger', quantity: 1 }, { itemId: ids.friesId, name: 'Fries', quantity: 1 }] }]);
eq(await count(`select count(*)::int as n from public.order_items where order_id = $1 and kind = 'deal'`, [dealOrder]), 1, 'deal order inserted');

console.log(`Inventory fixture smoke: ${checks} checks passed.`);
await db.close();
