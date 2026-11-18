// Shared fixture for the inventory suites: a fresh PGlite database (the base migrations 001-010, plus the inventory ones)
// seeded with one business, one live branch, stock locations, users, a small menu, an extra and a deal.
// Nothing here touches the shared database.
//
// Which inventory migrations (012+) are applied on top of BASE_MIGRATIONS (backend/tests/inv/migrations.js holds the ordered lists):
//   inventoryFixture()                    -> ALL of them (the default: tests run against the schema we ship)
//   inventoryFixture({ extra: [] })       -> none (base 001-010 only, the pre-012 state: migration rehearsal tests start from here)
//   inventoryFixture({ extra: [paths] })  -> exactly those paths, in that order (e.g. inventoryUpTo(13), or inventoryBefore(16))
// rig() (below) is inventoryFixture() plus the people, branch and items most Phase 2 suites need.
import { createUser, freshDatabase } from '../support/pg.js';
import { branchLocation, centerLocation } from '../../src/stock/service.js';
import { setSetting } from '../../src/inventory/policies.js';
import { ALL_INVENTORY_MIGRATIONS, BASE_MIGRATIONS, resolveProposed } from './migrations.js';
import { makeItem } from './helpers.js';

export async function inventoryFixture({ extra } = {}) {
  const db = await freshDatabase({ migrations: [...BASE_MIGRATIONS], extra: extra === undefined ? [...ALL_INVENTORY_MIGRATIONS] : resolveProposed(extra) });
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

  let people = 0;
  /** Another owner of the business (business_members 'owner' + owner of the first branch). Returns the user id. */
  const addOwner = async (email = `owner${++people}@example.test`) => {
    const id = await createUser(db, email, { role: 'owner' });
    await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [businessId, id]);
    await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'owner')`, [branch.id, id]);
    return id;
  };
  /** A further live branch with its stock location and (optionally) a manager. Returns { restaurantId, locationId, managerId }. */
  const addBranch = async (name = `Branch ${people + 2}`, { manager = true } = {}) => {
    const restaurantId = (await one(`insert into public.restaurants (owner_id, name, status, business_id, owner_primary) values ($1, $2, 'live', $3, false) returning id`, [users.owner, name, businessId])).id;
    const locationId = await tx((t) => branchLocation(t, restaurantId));
    let managerId = null;
    if (manager) {
      managerId = await createUser(db, `manager${++people}@example.test`, { role: 'owner' });
      await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'manager')`, [restaurantId, managerId]);
    }
    return { restaurantId, locationId, managerId };
  };
  /** An operations manager overseeing `branchIds`; `canApprove` flips the business setting operations_can_approve. Returns the user id. */
  const addOperations = async ({ branchIds = [branch.id], canApprove = false, email = `ops${++people}@example.test` } = {}) => {
    const id = await createUser(db, email, { role: 'owner' });
    await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'operations')`, [businessId, id]);
    for (const restaurantId of branchIds) await db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessId, id, restaurantId]);
    if (canApprove) await setSetting(db, { businessId, key: 'operations_can_approve', value: true, actorId: users.owner });
    return id;
  };
  /** What lib/auth.js requireUser() hands back, for permissions.inventoryScope(): memberships [[restaurantId, role]], grants [{ businessId, role, branchIds }]. */
  const ctx = (userId, { role = 'owner', memberships = [], grants = [] } = {}) => ({
    user: { id: userId }, profile: { role }, memberships: memberships.map(([rid, r]) => ({ role: r, restaurant: { id: rid } })), grants,
  });

  return {
    db,
    ids: { businessId, branchId: branch.id, centerLocationId, branchLocationId, categoryId, burgerId, friesId, extraId, dealId },
    users,
    helpers: { tx, one, order, addOwner, addBranch, addOperations, ctx },
  };
}

/**
 * The fixture most Phase 2 suites want: inventoryFixture() with the module switched on and, on top of the base data,
 *   people     owner (first), owner2, manager (branch 1 manager), manager2 (branch 2), ops (operations manager on branch 1;
 *              flip operations_can_approve with setSetting), waiter
 *   branches   branch1 (the fixture's), branch2  ({ restaurantId, locationId, managerId })
 *   items      flour and rice (base g shown as kg, packs: 'sack' = 25 kg / 50 kg), both unstocked
 *   contexts   what requireUser() would return for each person, ready for inventoryScope()
 * A supplier helper arrives with migration 015 (P2-03). Same options as inventoryFixture ({ extra }).
 */
export async function rig(options = {}) {
  const f = await inventoryFixture(options);
  const { ids, users, helpers } = f;
  await f.db.query('update public.businesses set inventory_enabled = true where id = $1', [ids.businessId]);
  const owner2 = await helpers.addOwner('owner2@example.test');
  const branch2 = await helpers.addBranch('Second branch');
  const ops = await helpers.addOperations({ branchIds: [ids.branchId] });
  const flour = await makeItem(f.db, ids.businessId, 'Flour', { packs: [{ name: 'sack', factor: 25000 }] });
  const rice = await makeItem(f.db, ids.businessId, 'Rice', { packs: [{ name: 'sack', factor: 50000 }] });
  const { ctx } = helpers;
  const branch1 = { restaurantId: ids.branchId, locationId: ids.branchLocationId, managerId: users.manager };
  const people = { owner: users.owner, owner2, manager: users.manager, manager2: branch2.managerId, ops, waiter: users.waiter };
  const contexts = {
    owner: ctx(users.owner, { memberships: [[ids.branchId, 'owner']], grants: [{ businessId: ids.businessId, role: 'owner', branchIds: null }] }),
    owner2: ctx(owner2, { memberships: [[ids.branchId, 'owner']], grants: [{ businessId: ids.businessId, role: 'owner', branchIds: null }] }),
    ops: ctx(ops, { grants: [{ businessId: ids.businessId, role: 'operations', branchIds: [ids.branchId] }] }),
    manager: ctx(users.manager, { memberships: [[ids.branchId, 'manager']] }),
    manager2: ctx(branch2.managerId, { memberships: [[branch2.restaurantId, 'manager']] }),
    waiter: ctx(users.waiter, { role: 'waiter', memberships: [[ids.branchId, 'waiter']] }),
  };
  return { ...f, people, branches: { branch1, branch2 }, items: { flour, rice }, contexts };
}
