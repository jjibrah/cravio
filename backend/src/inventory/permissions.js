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
import { effectiveSettings } from './policies.js';

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
 * ONE database round trip for everything it needs (business flag, restaurants, stock locations, the business-level settings);
 * a second one only when `ensureLocations` finds a location row missing. Pass a transaction or the pool.
 * ensureLocations: true      create any missing branch/warehouse location row first (needs a writable db), unless the caller is a platform admin.
 * ensureLocations: 'active'  the same, but only when inventory is on and the caller has some role in the business (what the routes want):
 *                            never writes when every location already exists, so a plain GET stays a read.
 * Returns:
 *   { businessId, userId, role, roles, enabled, centerLocationId, locations: [{id, kind, restaurantId, name}],
 *     locationCaps: Map<locationId, Set<cap>>, businessCaps: Set<cap>, settings: { key: value } }
 * `settings` are the business-wide effective settings (what getSettings(db, businessId) returns), loaded with the scope so a handler
 * need not ask again. Non-enumerable: `locationRows` (every location with code and status, for listLocations / the warehouse) and
 * `locationsComplete` (the warehouse and every branch have a location row).
 */
export async function inventoryScope(db, context, businessId, { ensureLocations = false } = {}) {
  let facts;
  try { facts = await loadFacts(db, businessId); } catch (error) {
    if (error?.code !== '42P01') throw error;
    facts = await loadFactsPiecemeal(db, businessId, context?.profile?.role === 'admin'); // an older schema (no 012 tables yet): same answers, more round trips
  }
  if (!facts) throw new HttpError(404, 'That business isn’t yours.');
  const biz = { id: facts.id, inventory_enabled: facts.inventory_enabled };
  const userId = context?.user?.id || null;
  const scope = { businessId: biz.id, userId, role: 'none', roles: [], enabled: biz.inventory_enabled === true, centerLocationId: null,
    locations: [], locationCaps: new Map(), businessCaps: new Set(), settings: null };

  const isAdmin = context?.profile?.role === 'admin';
  const grant = (context?.grants || []).find((g) => String(g.businessId).toLowerCase() === String(biz.id).toLowerCase());
  const restaurants = facts.restaurants;
  const mine = (context?.memberships || []).filter((m) => m.restaurant && restaurants.includes(m.restaurant.id));

  let rows = facts.locations;
  if (!isAdmin && ensureLocations) {
    const hasRole = grant?.role === 'owner' || grant?.role === 'operations' || mine.some((m) => MANAGER_ROLES.includes(m.role) || m.role === 'waiter');
    const wanted = ensureLocations === true || (scope.enabled && hasRole);
    const missing = !rows.some((l) => l.kind === 'center') || restaurants.some((id) => !rows.some((l) => l.restaurant_id === id));
    if (wanted && missing) {
      await centerLocation(db, biz.id);
      for (const id of restaurants) await branchLocation(db, id);
      rows = (await db.query(LOCATIONS_SQL, [biz.id])).rows;
    }
  }
  scope.locations = rows.map((l) => ({ id: l.id, kind: l.kind, restaurantId: l.restaurant_id, name: l.name }));
  Object.defineProperty(scope, 'locationRows', { value: rows, enumerable: false, writable: true });
  // true when the warehouse and one location per branch are all present (so nothing needs creating before reading them)
  Object.defineProperty(scope, 'locationsComplete', { value: rows.some((l) => l.kind === 'center') && restaurants.every((id) => rows.some((l) => l.restaurant_id === id)), enumerable: false, writable: true });
  scope.centerLocationId = scope.locations.find((l) => l.kind === 'center')?.id || null;
  scope.settings = effectiveSettings(facts.settings);
  if (isAdmin) { scope.role = 'admin'; scope.roles = ['admin']; return scope; }

  const settings = scope.settings;
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

const LOCATIONS_SQL = `select l.id, l.kind, l.restaurant_id, l.name, l.code, l.status, coalesce(r.name, l.name) as display_name
  from public.stock_locations l left join public.restaurants r on r.id = l.restaurant_id where l.business_id = $1 order by l.kind, l.name`;

/** Everything the scope needs from the database, in ONE statement. */
async function loadFacts(db, businessId) {
  const { rows } = await db.query(
    `select b.id, b.inventory_enabled,
       coalesce((select json_agg(r.id) from public.restaurants r where r.business_id = b.id), '[]'::json) as restaurants,
       coalesce((select json_agg(json_build_object('id', l.id, 'kind', l.kind, 'restaurant_id', l.restaurant_id, 'name', l.name, 'code', l.code,
           'status', l.status, 'display_name', coalesce(r.name, l.name)) order by l.kind, l.name)
         from public.stock_locations l left join public.restaurants r on r.id = l.restaurant_id where l.business_id = b.id), '[]'::json) as locations,
       coalesce((select json_agg(json_build_object('key', s.key, 'value', s.value)) from public.inventory_settings s
         where s.business_id = b.id and s.location_id is null), '[]'::json) as settings
     from public.businesses b where b.id = $1`, [businessId]);
  return rows[0] ? { ...rows[0], restaurants: asJson(rows[0].restaurants), locations: asJson(rows[0].locations), settings: asJson(rows[0].settings) } : null;
}
const asJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

/** The old way (four statements), for a database where the settings table doesn't exist yet. */
async function loadFactsPiecemeal(db, businessId, isAdmin) {
  const biz = (await db.query('select id, inventory_enabled from public.businesses where id = $1', [businessId])).rows[0];
  if (!biz) return null;
  const restaurants = (await db.query('select id from public.restaurants where business_id = $1', [biz.id])).rows.map((r) => r.id);
  const locations = (await db.query(LOCATIONS_SQL, [biz.id])).rows;
  // Platform admins never read settings (they get no capabilities), so they work before 012 too.
  const settings = isAdmin ? [] : (await db.query('select key, value from public.inventory_settings where business_id = $1 and location_id is null', [biz.id])).rows;
  return { ...biz, restaurants, locations, settings };
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
