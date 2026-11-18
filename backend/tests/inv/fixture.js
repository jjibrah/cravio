// Shared fixture for the inventory suites: a fresh PGlite database (all committed migrations, plus any `extra`
// proposed migrations) seeded with one business, one live branch, stock locations, users, a small menu, an extra and a deal.
// Nothing here touches the shared database.
import { createUser, freshDatabase } from '../support/pg.js';
import { branchLocation, centerLocation } from '../../src/stock/service.js';

export async function inventoryFixture({ extra = [] } = {}) {
  const db = await freshDatabase({ extra });
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const tx = (fn) => db.transaction(fn);

  const users = {
    owner: await createUser(db, 'owner@example.test', { role: 'owner' }),
    manager: await createUser(db, 'manager@example.test', { role: 'owner' }),
    waiter: await createUser(db, 'waiter@example.test', { role: 'waiter' }),
  };

  // The restaurant insert creates the business (migration 008); the branch is that business's first branch.
  const branch = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Main branch', 'live') returning id, business_id`, [users.owner]);
  const businessId = branch.business_id;
  await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [businessId, users.owner]);
  await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'manager'), ($1, $4, 'waiter')`,
    [branch.id, users.owner, users.manager, users.waiter]);

  const centerLocationId = await tx((t) => centerLocation(t, businessId));
  const branchLocationId = await tx((t) => branchLocation(t, branch.id));

  const categoryId = (await one(`insert into public.menu_categories (restaurant_id, name) values ($1, 'Mains') returning id`, [branch.id])).id;
  const dish = async (name, price) => (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, $4) returning id`, [branch.id, categoryId, name, price])).id;
  const burgerId = await dish('Chicken burger', 500);
  const friesId = await dish('Fries', 200);
  const extraId = (await one(`insert into public.menu_item_extras (restaurant_id, item_id, name, price) values ($1, $2, 'Extra cheese', 50) returning id`, [branch.id, burgerId])).id;
  const dealId = (await one(`insert into public.menu_deals (restaurant_id, name, price) values ($1, 'Burger combo', 600) returning id`, [branch.id])).id;
  await db.query(`insert into public.menu_deal_items (deal_id, restaurant_id, item_id, quantity, position) values ($1, $2, $3, 1, 0), ($1, $2, $4, 1, 1)`, [dealId, branch.id, burgerId, friesId]);

  /** Inserts an order with the given lines [{ itemId, name, quantity, kind?, components? }], the way inventory-v2.js does. */
  const order = (lines, status = 'taken') => tx(async (t) => {
    const id = (await t.query(`insert into public.orders (restaurant_id, status, taken_by) values ($1, $2, $3) returning id`, [branch.id, status, users.waiter])).rows[0].id;
    await t.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, kind, components)
      select $1, $2, (l->>'itemId')::uuid, l->>'name', 100, (l->>'quantity')::int, 100, coalesce(l->>'kind', 'item'), l->'components'
      from jsonb_array_elements($3::jsonb) l`, [id, branch.id, JSON.stringify(lines)]);
    return id;
  });

  return {
    db,
    ids: { businessId, branchId: branch.id, centerLocationId, branchLocationId, categoryId, burgerId, friesId, extraId, dealId },
    users,
    helpers: { tx, one, order },
  };
}
