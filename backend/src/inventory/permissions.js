// Inventory permissions (07 §0.5): a small capability map in code, checked on the server, scoped by location.
//
// Where identity comes from (nothing new is stored):
//   context.grants       business_members: 'owner' (every branch) | 'operations' (branchIds = assigned branches)
//   context.memberships  restaurant_members: owner|manager -> branch manager, waiter -> waiter
//   context.profile.role 'admin' = platform admin
// inventoryScope() turns that into capabilities per stock location (warehouse + one per branch) and a few
// business-wide capabilities. can()/requireCan() are pure and synchronous on that scope.
import { HttpError } from '../lib/http.js';
import { MANAGER_ROLES } from '../lib/access.js';
import { branchLocation, centerLocation } from '../stock/service.js';
import { record } from './audit.js';
import { getSettings } from './policies.js';

export const CAPABILITIES = Object.freeze([
  'inv.view', 'inv.cost.view', 'inv.item.edit', 'inv.recipe.edit', 'inv.stock.record',
  'inv.adjust.create', 'inv.adjust.approve', 'inv.request.create', 'inv.request.approve',
  'inv.transfer.dispatch', 'inv.transfer.receive', 'inv.purchase.create', 'inv.purchase.approve',
  'inv.emergency.create', 'inv.emergency.approve', 'inv.count.run', 'inv.count.approve',
  'inv.exception.resolve', 'inv.report.view', 'inv.settings.edit', 'inv.availability.view',
]);

/** Capabilities that belong to the business, not to one place (the catalogue and the settings). */
export const BUSINESS_CAPABILITIES = Object.freeze(['inv.item.edit', 'inv.settings.edit']);

// ---- Role defaults. Each is the set granted at a location the person is allowed to act at. ----

// Business owner: everything, at every location of the business including the warehouse. Owners are the only
// people who approve by default and the only ones who change settings or buy for the warehouse.
const OWNER = CAPABILITIES;

// Operations manager: oversight. Sees and costs stock and reports at assigned branches (and the warehouse, read only).
// They approve nothing unless the business turns on setting 'operations_can_approve' (then request + adjust approvals,
// on assigned branches only). They never edit the catalogue, record stock or change settings.
const OPERATIONS = ['inv.view', 'inv.cost.view', 'inv.report.view', 'inv.availability.view'];
const OPERATIONS_APPROVER = ['inv.request.approve', 'inv.adjust.approve'];
const OPERATIONS_WAREHOUSE = ['inv.view', 'inv.cost.view', 'inv.report.view'];

// Branch manager (restaurant_members owner|manager): runs their own branch's stock. Cannot approve their own
// adjustments/emergency buys/counts, cannot dispatch from or buy for the warehouse, cannot change settings.
// 'inv.item.edit' is business-wide and only given when setting 'branch_can_add_items' is on (default on),
// because today's 009 lets branch managers create and edit stock items (routes/stock.js, managerContext).
const BRANCH_MANAGER = [
  'inv.view', 'inv.cost.view', 'inv.recipe.edit', 'inv.stock.record', 'inv.adjust.create', 'inv.request.create',
  'inv.transfer.receive', 'inv.emergency.create', 'inv.count.run', 'inv.exception.resolve', 'inv.report.view', 'inv.availability.view',
];

// Waiter: can see what is available to sell at their branch. Nothing else in Phase 1.
const WAITER = ['inv.availability.view'];

// Platform admin: nothing. Admins never see a business's stock records (entitlement lives outside this module).

/** The table above as data, for docs and tests. */
export const ROLE_DEFAULTS = Object.freeze({
  owner: OWNER, operations: OPERATIONS, operations_approver: OPERATIONS_APPROVER, operations_warehouse: OPERATIONS_WAREHOUSE,
  branch_manager: BRANCH_MANAGER, waiter: WAITER, admin: [],
});

const RANK = ['owner', 'operations', 'branch_manager', 'waiter'];
export const DISABLED_MESSAGE = 'Inventory isn’t switched on for this business yet.';

const forbidden = (message = 'You don’t have access to this.', details = {}) => new HttpError(403, message, { code: 'forbidden', ...details });

/**
 * Builds the caller's inventory scope for one business. `context` is the requireUser() result.
 * Does the DB lookups (business flag, restaurants, stock locations, two settings); pass a transaction or the pool.
 * { ensureLocations: true } first creates missing branch/warehouse location rows (needs a writable db).
 * Returns:
 *   { businessId, userId, role, roles, enabled, centerLocationId, locations: [{id, kind, restaurantId, name}],
 *     locationCaps: Map<locationId, Set<cap>>, businessCaps: Set<cap> }
 */
export async function inventoryScope(db, context, businessId, { ensureLocations = false } = {}) {
  const biz = (await db.query('select id, inventory_enabled from public.businesses where id = $1', [businessId])).rows[0];
  if (!biz) throw new HttpError(404, 'That business isn’t yours.');
  const userId = context?.user?.id || null;
  const scope = { businessId: biz.id, userId, role: 'none', roles: [], enabled: biz.inventory_enabled === true, centerLocationId: null,
    locations: [], locationCaps: new Map(), businessCaps: new Set() };

  const isAdmin = context?.profile?.role === 'admin';
  const grant = (context?.grants || []).find((g) => String(g.businessId).toLowerCase() === String(biz.id).toLowerCase());
  const restaurants = (await db.query('select id from public.restaurants where business_id = $1', [biz.id])).rows.map((r) => r.id);
  const mine = (context?.memberships || []).filter((m) => m.restaurant && restaurants.includes(m.restaurant.id));

  if (ensureLocations && !isAdmin) {
    await centerLocation(db, biz.id);
    for (const id of restaurants) await branchLocation(db, id);
  }
  scope.locations = (await db.query(
    'select id, kind, restaurant_id, name from public.stock_locations where business_id = $1 order by kind, name', [biz.id])).rows
    .map((l) => ({ id: l.id, kind: l.kind, restaurantId: l.restaurant_id, name: l.name }));
  scope.centerLocationId = scope.locations.find((l) => l.kind === 'center')?.id || null;
  if (isAdmin) { scope.role = 'admin'; scope.roles = ['admin']; return scope; }

  const settings = await getSettings(db, biz.id);
  const give = (locationId, caps) => {
    if (!locationId) return;
    if (!scope.locationCaps.has(locationId)) scope.locationCaps.set(locationId, new Set());
    for (const cap of caps) scope.locationCaps.get(locationId).add(cap);
  };
  const branchLoc = (restaurantId) => scope.locations.find((l) => l.restaurantId === restaurantId)?.id;
  const roles = new Set();

  if (grant?.role === 'owner') {
    roles.add('owner');
    for (const l of scope.locations) give(l.id, OWNER);
    for (const cap of BUSINESS_CAPABILITIES) scope.businessCaps.add(cap);
  } else if (grant?.role === 'operations') {
    roles.add('operations');
    give(scope.centerLocationId, OPERATIONS_WAREHOUSE);
    for (const restaurantId of (grant.branchIds || []).filter((id) => restaurants.includes(id))) {
      give(branchLoc(restaurantId), settings.operations_can_approve ? [...OPERATIONS, ...OPERATIONS_APPROVER] : OPERATIONS);
    }
  }
  for (const m of mine) {
    if (MANAGER_ROLES.includes(m.role)) {
      roles.add('branch_manager');
      give(branchLoc(m.restaurant.id), BRANCH_MANAGER);
      if (settings.branch_can_add_items) scope.businessCaps.add('inv.item.edit');
    } else if (m.role === 'waiter') {
      roles.add('waiter');
      give(branchLoc(m.restaurant.id), WAITER);
    }
  }
  scope.roles = RANK.filter((r) => roles.has(r));
  scope.role = scope.roles[0] || 'none';
  return scope;
}

/** The denial for this check, or null when allowed. Pure. */
function denial(scope, capability, { locationId = null } = {}, { allowDisabled = false } = {}) {
  if (!CAPABILITIES.includes(capability)) throw new TypeError(`Unknown capability ${capability}.`);
  if (scope.role === 'none' || scope.role === 'admin') return forbidden();
  if (!scope.enabled && !allowDisabled) return new HttpError(403, DISABLED_MESSAGE, { code: 'inventory_disabled' });
  if (!hasCapability(scope, capability, locationId)) return forbidden();
  return null;
}

function hasCapability(scope, capability, locationId) {
  if (BUSINESS_CAPABILITIES.includes(capability)) return scope.businessCaps.has(capability);
  if (locationId) return Boolean(scope.locationCaps.get(locationId)?.has(capability));
  // No place named: "can this person ever do this here?" (menus, buttons). Real actions must name the location.
  return [...scope.locationCaps.values()].some((caps) => caps.has(capability));
}

/** True when the scope allows the capability (at locationId when given). Also false when inventory is switched off. */
export const can = (scope, capability, { locationId = null, allowDisabled = false } = {}) => denial(scope, capability, { locationId }, { allowDisabled }) === null;

/** Throws 403 { code: 'forbidden' | 'inventory_disabled' } when not allowed. Synchronous; does not audit (see authorize). */
export function requireCan(scope, capability, options = {}) {
  const error = denial(scope, capability, options, options);
  if (error) throw error;
}

/** Location ids where the scope holds the capability (empty for business-wide ones; use can() for those). */
export const locationsWith = (scope, capability) => [...scope.locationCaps].filter(([, caps]) => caps.has(capability)).map(([id]) => id);

/**
 * Records a 'denied' audit event and returns the 403 to throw. Write it with a db that is NOT inside the
 * transaction about to be rolled back, or the event rolls back with it.
 */
export async function denyAndAudit(db, scope, capability, { locationId = null, entity = 'permission', entityId = null, error = forbidden() } = {}) {
  try {
    await record(db, { businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity, entityId,
      action: 'denied', before: null, after: { capability, locationId } });
  } catch (e) { console.error('[inventory] could not audit a denial:', e.message); }
  return error;
}

/** requireCan + audit: on a forbidden attempt writes the 'denied' event, then throws 403. Disabled-module refusals aren't audited. */
export async function authorize(db, scope, capability, options = {}) {
  const error = denial(scope, capability, options, options);
  if (!error) return;
  if (error.details?.code === 'inventory_disabled') throw error;
  throw await denyAndAudit(db, scope, capability, { ...options, error });
}

/** Maker-checker (T-SEC-2): whoever created something cannot approve it. */
export function assertDifferentPeople(createdBy, approverId) {
  if (createdBy && approverId && String(createdBy).toLowerCase() === String(approverId).toLowerCase()) {
    throw new HttpError(403, 'You can’t approve something you created. Ask another manager.', { code: 'maker_checker' });
  }
}
