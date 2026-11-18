// Inventory recipes API (P1-10): owner (any branch) and branch (own branch) endpoints on the recipes service.
//   Owner  /api/owner/inventory/:businessId/recipes ...       business owner, operations (read) or a branch manager of that business
//   Branch /api/inventory/recipes ...                         the branch named by X-Cravio-Branch (access.js), like routes/stock.js
// Same pattern as routes/inventory-owner.js: authenticate -> inventoryScope (pool) -> authorize (pool, BEFORE the transaction so a
// refused attempt's 'denied' audit row survives) -> one transaction -> once(commandId) -> service (which audits).
// Dish/extra capability checks name the dish's branch location, so a branch manager can't edit another branch's dish.
// createRoutes() takes its dependencies so tests can run the real handlers against an in-memory database.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { invalidateMenu } from '../lib/cache.js';
import { STAFF_ROLES, requestedBranch, selectMembership, businessOfBranch } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, inventoryScope } from '../inventory/permissions.js';
import {
  branchLocationId, dishLocationId, extraLocationId, getExtraRecipe, getRecipe, getVersion, listRecipes, previewDraft, saveExtraRecipe,
  saveRecipe, suggest, versions,
} from '../inventory/recipes.js';

const ID = '[0-9a-fA-F-]{36}';
const owner = (suffix = '') => new RegExp(`^/api/owner/inventory/(?<businessId>${ID})${suffix}$`);
const branch = (suffix = '') => new RegExp(`^/api/inventory${suffix}$`);

const MISSING_012 = new HttpError(503, 'Inventory needs database update 012, which hasn’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_013 = new HttpError(503, 'Inventory needs database update 013 (recipes), which hasn’t been applied yet.', { code: 'inventory_schema_missing' });
const RECIPE_OBJECTS = /recipes|recipe_versions|recipe_lines|menu_extra_recipe_lines|order_stock_lines|stock_menu_availability/;

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }), ai = {} } = {}) {
  /** Turns "migration 012/013 missing" database errors into one plain 503. */
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (['42P01', '42703', '42883'].includes(error?.code)) throw RECIPE_OBJECTS.test(String(error.message)) ? MISSING_013 : MISSING_012;
      throw error;
    }
  };

  async function scopeFor(db, context, businessId) {
    return safely(() => inventoryScope(db, context, businessId, { ensureLocations: 'active' }));
  }

  /** Owner side: the business in the path. */
  async function openOwner(request, params) {
    const context = await authenticate(request);
    const db = pool();
    return { db, scope: await scopeFor(db, context, String(params.businessId).toLowerCase()), restaurantId: undefined };
  }

  /** Branch side: the branch from X-Cravio-Branch (or the caller's only branch); its business from the database. */
  async function openBranch(request) {
    const context = await authenticate(request);
    const membership = selectMembership(context.memberships, requestedBranch(request), STAFF_ROLES);
    if (!membership) throw new HttpError(403, 'You aren’t part of a restaurant yet. Ask your manager to add you.', { code: 'forbidden' });
    const restaurantId = String(membership.restaurant.id).toLowerCase();
    const db = pool();
    const row = await safely(() => businessOfBranch(db, context, restaurantId));
    if (!row) throw new HttpError(404, 'That branch doesn’t exist.', { code: 'branch_not_found' });
    return { db, scope: await scopeFor(db, context, row.business_id), restaurantId };
  }

  const read = (open, capability, fn, { check } = {}) => async ({ request, params, url }) => {
    const { db, scope, restaurantId } = await open(request, params);
    const q = url?.searchParams || new URLSearchParams();
    await safely(() => authorize(db, scope, capability, { entity: 'recipe' }));
    if (check) await safely(() => check(db, scope, params, q, restaurantId));
    return safely(() => fn(db, scope, params, q, restaurantId));
  };

  const write = (open, kind, capability, run, { check } = {}) => withBody(async ({ request, params, body }) => {
    const { db, scope, restaurantId } = await open(request, params);
    await safely(() => authorize(db, scope, capability, { entity: kind }));
    if (check) await safely(() => check(db, scope, params, body, restaurantId));
    const result = await safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind },
      () => run(tx, scope, params, body, restaurantId))));
    const branchId = result?.dish?.restaurantId || result?.extra?.restaurantId;
    if (branchId) invalidateMenu(branchId); // sold-out can change when a recipe changes
    return result;
  });

  // Checks that name the dish's / extra's / branch's stock location (so denials are audited with the location).
  const dishCheck = (capability) => async (db, scope, params, _x, restaurantId) =>
    authorize(db, scope, capability, { locationId: await dishLocationId(db, scope, params.menuItemId, { restaurantId }), entity: 'recipe', entityId: params.menuItemId });
  const extraCheck = (capability) => async (db, scope, params, _x, restaurantId) =>
    authorize(db, scope, capability, { locationId: await extraLocationId(db, scope, params.extraId, { restaurantId }), entity: 'extra_recipe', entityId: params.extraId });
  /** The branch for a list: the branch route's own branch; the owner route's ?branch= (or the only branch). */
  const listBranch = (scope, q, restaurantId) => {
    if (restaurantId) return restaurantId;
    const wanted = q.get('branch');
    const branches = scope.locations.filter((l) => l.restaurantId);
    if (wanted) return wanted.toLowerCase();
    if (branches.length === 1) return branches[0].restaurantId;
    throw new HttpError(400, 'Choose a branch: add ?branch=<branch id>.', { code: 'branch_required', branches: branches.map((l) => ({ id: l.restaurantId, name: l.name })) });
  };
  const listCheck = async (db, scope, _p, q, restaurantId) =>
    authorize(db, scope, 'inv.view', { locationId: branchLocationId(scope, listBranch(scope, q, restaurantId)), entity: 'recipe' });

  // One definition per endpoint, registered for both sides.
  const endpoints = (open, prefix, make) => [
    { method: 'GET', path: make('/recipes'), handler: read(open, 'inv.view', (db, scope, _p, q, restaurantId) => listRecipes(db, scope, { restaurantId: listBranch(scope, q, restaurantId) }), { check: listCheck }) },
    { method: 'GET', path: make(`/recipes/(?<menuItemId>${ID})`), handler: read(open, 'inv.view', (db, scope, params, _q, restaurantId) => getRecipe(db, scope, params.menuItemId, { restaurantId }), { check: dishCheck('inv.view') }) },
    { method: 'PUT', path: make(`/recipes/(?<menuItemId>${ID})`), handler: write(open, 'recipe_save', 'inv.recipe.edit',
      (db, scope, params, body, restaurantId) => saveRecipe(db, scope, params.menuItemId, { lines: body.lines, allowWhenOut: body.allowWhenOut, note: body.note }, { restaurantId }), { check: dishCheck('inv.recipe.edit') }) },
    // Live preview of unsaved lines (sentences + food cost). Reads only; POST because it carries a body.
    { method: 'POST', path: make(`/recipes/(?<menuItemId>${ID})/preview`), handler: withBody(async ({ request, params, body, url }) =>
      read(open, 'inv.view', (db, scope, p, _q, restaurantId) => previewDraft(db, scope, p.menuItemId, { lines: body.lines }, { restaurantId }), { check: dishCheck('inv.view') })({ request, params, url })) },
    { method: 'POST', path: make(`/recipes/(?<menuItemId>${ID})/suggest`), handler: read(open, 'inv.recipe.edit',
      (db, scope, params, _q, restaurantId) => suggest(db, scope, params.menuItemId, { restaurantId, ...ai }), { check: dishCheck('inv.recipe.edit') }) },
    { method: 'GET', path: make(`/recipes/(?<menuItemId>${ID})/versions`), handler: read(open, 'inv.view', (db, scope, params, _q, restaurantId) => versions(db, scope, params.menuItemId, { restaurantId }), { check: dishCheck('inv.view') }) },
    { method: 'GET', path: make(`/recipes/(?<menuItemId>${ID})/versions/(?<versionId>${ID})`), handler: read(open, 'inv.view',
      (db, scope, params, _q, restaurantId) => getVersion(db, scope, params.menuItemId, params.versionId, { restaurantId }), { check: dishCheck('inv.view') }) },
    { method: 'GET', path: make(`${prefix}/(?<extraId>${ID})/recipe`), handler: read(open, 'inv.view', (db, scope, params, _q, restaurantId) => getExtraRecipe(db, scope, params.extraId, { restaurantId }), { check: extraCheck('inv.view') }) },
    { method: 'PUT', path: make(`${prefix}/(?<extraId>${ID})/recipe`), handler: write(open, 'extra_recipe_save', 'inv.recipe.edit',
      (db, scope, params, body, restaurantId) => saveExtraRecipe(db, scope, params.extraId, { lines: body.lines }, { restaurantId }), { check: extraCheck('inv.recipe.edit') }) },
  ];

  return [...endpoints(openOwner, '/extras', owner), ...endpoints(openBranch, '/extras', branch)];
}

export const routes = createRoutes();
