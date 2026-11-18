// Suppliers API (P2-04, migration 015).
//   Owner side, base /api/owner/inventory/:businessId/suppliers: the owner edits (inv.purchase.create); the owner and operations managers read
//   (inv.view, prices need inv.cost.view); branch managers and waiters are refused here (403 + a 'denied' audit row).
//   Branch side, /api/inventory/suppliers (X-Cravio-Branch names the branch, as for /api/inventory): a branch manager lists supplier NAMES
//   for the emergency picker and adds an on-the-spot supplier (inv.emergency.create at that branch). No contact, bank or price data
//   beyond what the service allows.
// Pattern for every write: requireUser -> inventoryScope (pool) -> authorize (pool, BEFORE the transaction, so a refused
// attempt's 'denied' audit row isn't rolled back) -> one transaction -> once(commandId) -> service (which audits).
// createRoutes() takes its dependencies so tests can run the real handlers against an in-memory database.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES, businessOfBranch } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, denyAndAudit, inventoryScope } from '../inventory/permissions.js';
import {
  addPrice, bestPrices, completeSupplier, createOnTheSpot, createSupplier, getSupplier, listForBranch, listSuppliers, oversees, priceHistory,
  setSupplierItems, setSupplierStatus, updateSupplier,
} from '../inventory/suppliers.js';

const ID = '[0-9a-fA-F-]{36}';
const base = `/api/owner/inventory/(?<businessId>${ID})/suppliers`;
const path = (suffix = '') => new RegExp(`^${base}${suffix}$`);

const MISSING_SCHEMA = new HttpError(503, 'Suppliers need database updates 012 and 015, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
const flag = (searchParams, key) => ['1', 'true', 'yes'].includes(String(searchParams.get(key) || '').toLowerCase());

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }), now = () => new Date() } = {}) {
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());

  /* ----- owner side ----- */

  async function open(request, params) {
    const context = await authenticate(request);
    const businessId = String(params.businessId).toLowerCase();
    const db = pool();
    const scope = await safely(() => inventoryScope(db, context, businessId));
    return { db, scope };
  }

  /** The capability, and for reads also "owner or operations manager": a branch manager holds inv.view but may not browse the supplier list. */
  async function allow(db, scope, capability, entity, { oversight = false } = {}) {
    await safely(() => authorize(db, scope, capability, { entity }));
    if (oversight && !oversees(scope)) throw await denyAndAudit(db, scope, capability, { entity });
  }

  const read = (capability, fn, { prices = false } = {}) => async ({ request, params, url }) => {
    const { db, scope } = await open(request, params);
    await allow(db, scope, 'inv.view', 'supplier', { oversight: true });
    if (prices) await allow(db, scope, capability, 'supplier_price', { oversight: true });
    return safely(() => fn(db, scope, params, url?.searchParams || new URLSearchParams()));
  };

  const write = (kind, run) => withBody(async ({ request, params, body }) => {
    const { db, scope } = await open(request, params);
    await allow(db, scope, 'inv.purchase.create', kind);
    return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind }, () => run(tx, scope, params, body))));
  });

  /* ----- branch side ----- */

  async function openBranch(request) {
    const context = await authenticate(request);
    const db = pool();
    let restaurantId = requestedBranch(request);
    if (!restaurantId) {
      const membership = selectMembership(context.memberships, null, STAFF_ROLES);
      if (!membership) throw new HttpError(409, 'Choose which branch you are working in. Send the X-Cravio-Branch header.', { code: 'branch_required' });
      restaurantId = String(membership.restaurant.id).toLowerCase();
    }
    const row = await businessOfBranch(db, context, restaurantId);
    if (!row) throw NO_BRANCH();
    const scope = await safely(() => inventoryScope(db, context, row.business_id, { ensureLocations: 'active' }));
    const location = scope.locations.find((l) => l.kind === 'branch' && l.restaurantId === restaurantId) || null;
    await safely(() => authorize(db, scope, 'inv.emergency.create', { locationId: location?.id || null, entity: 'supplier' }));
    if (!location) throw NO_BRANCH();
    return { db, scope, location };
  }

  return [
    // ----- Owner / operations -----
    { method: 'GET', path: path(), handler: read('inv.view', (db, scope, _p, q) => listSuppliers(db, scope,
      { search: q.get('search') || undefined, type: q.get('type') || undefined, status: q.get('status') || undefined, incomplete: flag(q, 'incomplete') })) },
    // Where to buy an item: cheapest first (needs inv.cost.view). ?item=<id>&date=YYYY-MM-DD
    { method: 'GET', path: path('/best-price'), handler: read('inv.cost.view', (db, scope, _p, q) => {
      if (!q.get('item')) throw new HttpError(400, 'Choose the item to compare prices for.', { code: 'item_required' });
      return bestPrices(db, scope, q.get('item'), { date: q.get('date') || undefined, today: today() });
    }, { prices: true }) },
    { method: 'POST', path: path(), handler: write('supplier_create', (db, scope, _p, body) => { const { commandId, ...fields } = body; return createSupplier(db, scope, fields); }) },
    { method: 'GET', path: path(`/(?<id>${ID})`), handler: read('inv.view', (db, scope, params) => getSupplier(db, scope, params.id, { today: today() })) },
    { method: 'PATCH', path: path(`/(?<id>${ID})`), handler: write('supplier_edit', (db, scope, params, body) => { const { commandId, ...patch } = body; return updateSupplier(db, scope, params.id, patch); }) },
    { method: 'POST', path: path(`/(?<id>${ID})/deactivate`), handler: write('supplier_deactivate', (db, scope, params) => setSupplierStatus(db, scope, params.id, 'inactive')) },
    { method: 'POST', path: path(`/(?<id>${ID})/activate`), handler: write('supplier_activate', (db, scope, params) => setSupplierStatus(db, scope, params.id, 'active')) },
    { method: 'POST', path: path(`/(?<id>${ID})/complete`), handler: write('supplier_complete', (db, scope, params) => completeSupplier(db, scope, params.id)) },
    { method: 'PUT', path: path(`/(?<id>${ID})/items`), handler: write('supplier_items', (db, scope, params, body) => setSupplierItems(db, scope, params.id, body.items)) },
    { method: 'GET', path: path(`/(?<id>${ID})/prices`), handler: read('inv.cost.view', (db, scope, params, q) =>
      priceHistory(db, scope, params.id, { itemId: q.get('item') || undefined, unit: q.get('unit') || undefined, today: today() }), { prices: true }) },
    { method: 'POST', path: path(`/(?<id>${ID})/prices`), handler: write('supplier_price', (db, scope, params, body) => {
      const { commandId, ...price } = body;
      return addPrice(db, scope, params.id, price, { today: today() });
    }) },

    // ----- Branch manager: the emergency picker and on-the-spot suppliers -----
    { method: 'GET', path: /^\/api\/inventory\/suppliers$/, handler: async ({ request, url }) => {
      const { db, scope, location } = await openBranch(request);
      const q = url?.searchParams || new URLSearchParams();
      return safely(() => listForBranch(db, scope, location.id, { search: q.get('search') || undefined, itemId: q.get('item') || undefined, today: today() }));
    } },
    { method: 'POST', path: /^\/api\/inventory\/suppliers$/, handler: withBody(async ({ request, body }) => {
      const { db, scope, location } = await openBranch(request);
      return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind: 'supplier_on_the_spot' },
        () => createOnTheSpot(tx, scope, location.id, body))));
    }) },
  ];
}

export const routes = createRoutes();
