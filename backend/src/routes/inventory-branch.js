// Branch inventory API (P1-12), base /api/inventory. The branch is named by X-Cravio-Branch (as for /api/stock/*); a caller
// with exactly one branch may leave it out. Access is by inventory capability AT THAT BRANCH (permissions.js), so a manager
// of branch A is refused (403 + a 'denied' audit row) at branch B, a waiter can only read availability, and an owner or
// operations manager can act on the branches their business grant covers. Writes: authorize (pool, before the transaction so a
// denial's audit row isn't rolled back) -> one transaction -> once(commandId) -> service.
// Availability keeps working exactly as GET /api/stock/availability does today while inventory is switched off (or 012 is not
// applied): then it only needs branch membership and reads the same SQL function. Everything else says 403 inventory_disabled.
// createRoutes() takes its dependencies so tests can run the real handlers against an in-memory database.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { invalidateMenu } from '../lib/cache.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES, businessOfBranch } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, inventoryScope } from '../inventory/permissions.js';
import {
  availability, exceptionLocation, exceptions, history, itemDetail, record, recordCapability, resolveException, snapshot,
} from '../inventory/branch.js';

const ID = '[0-9a-fA-F-]{36}';
const MISSING_SCHEMA = new HttpError(503, 'Inventory needs database updates 012 and 013, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }) } = {}) {
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };

  /**
   * Who is calling and which branch. Returns { context, db, restaurantId, businessId, scope, location } where `scope` is null
   * when the inventory schema (012) isn't there. A branch that doesn't exist and one the caller can't see look the same (403).
   */
  async function open(request) {
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
    const businessId = row.business_id;
    let scope = null;
    try {
      scope = await inventoryScope(db, context, businessId, { ensureLocations: 'active' });
    } catch (error) {
      if (!MISSING_CODES.includes(error?.code)) throw error;
      scope = null;
    }
    const location = scope?.locations.find((l) => l.kind === 'branch' && l.restaurantId === restaurantId) || null;
    return { context, db, restaurantId, businessId, scope, location };
  }

  /** Inventory must be on and the caller must hold `capability` at this branch (denials are audited). */
  async function allow(ctx, capability, entity) {
    if (!ctx.scope) throw MISSING_SCHEMA;
    await authorize(ctx.db, ctx.scope, capability, { locationId: ctx.location?.id || null, entity });
    if (!ctx.location) throw NO_BRANCH();
  }

  const read = (capability, entity, fn) => async ({ request, url }) => {
    const ctx = await open(request);
    await allow(ctx, capability, entity);
    return safely(() => fn(ctx.db, ctx.scope, ctx.location.id, url?.searchParams || new URLSearchParams(), ctx));
  };

  return [
    // Everything the branch Stock screen needs. ?all=1 lists every active item (for the "add stock" picker).
    { method: 'GET', path: /^\/api\/inventory$/, handler: read('inv.view', 'inventory', (db, scope, loc, q) =>
      snapshot(db, scope, loc, { all: ['1', 'true', 'yes'].includes(String(q.get('all') || '').toLowerCase()) })) },

    // Count, add or waste. Body: { kind: 'count'|'add'|'waste', itemId, quantity, unit, note?, unitCost?, reasonCode?, confirmLarge?, commandId? }
    { method: 'POST', path: /^\/api\/inventory\/record$/, handler: withBody(async ({ request, body }) => {
      const ctx = await open(request);
      const capability = recordCapability(body.kind);
      if (!capability) { // unknown kind: still needs inventory access to get the plain 400
        await allow(ctx, 'inv.stock.record', 'stock_record');
        throw new HttpError(400, 'Choose count, add or waste.', { code: 'bad_kind' });
      }
      await allow(ctx, capability, 'stock_record');
      const result = await safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind: `branch_${body.kind}` },
        () => record(tx, ctx.scope, { locationId: ctx.location.id, kind: body.kind, itemId: body.itemId, quantity: body.quantity, unit: body.unit,
          note: body.note, unitCost: body.unitCost, reasonCode: body.reasonCode, confirmLarge: body.confirmLarge === true, commandId: body.commandId }))));
      invalidateMenu(ctx.restaurantId); // sold-out state may have changed
      return result;
    }) },

    { method: 'GET', path: /^\/api\/inventory\/history$/, handler: read('inv.view', 'history', (db, scope, loc, q) =>
      history(db, scope, loc, { itemId: q.get('itemId') || null, limit: q.get('limit') || 60, before: q.get('before') || null })) },

    { method: 'GET', path: /^\/api\/inventory\/exceptions$/, handler: read('inv.view', 'exceptions', (db, scope, loc, q) =>
      exceptions(db, scope, loc, { status: q.get('status') || 'open' })) },

    { method: 'POST', path: new RegExp(`^/api/inventory/exceptions/(?<id>${ID})/resolve$`), handler: withBody(async ({ request, params, body }) => {
      const ctx = await open(request);
      await allow(ctx, 'inv.exception.resolve', 'stock_exception');
      // An exception at another branch looks like one that doesn't exist.
      const where = await safely(() => exceptionLocation(ctx.db, ctx.scope, params.id));
      if (where !== ctx.location.id) throw new HttpError(404, 'That exception isn’t at this branch.', { code: 'exception_not_found' });
      return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind: 'branch_exception_resolve' },
        () => resolveException(tx, ctx.scope, params.id, { note: body.note, locationId: ctx.location.id }))));
    }) },

    // Waiters and managers (staff). Same response as GET /api/stock/availability.
    { method: 'GET', path: /^\/api\/inventory\/availability$/, async handler({ request }) {
      const ctx = await open(request);
      if (ctx.scope?.enabled) {
        await allow(ctx, 'inv.availability.view', 'availability');
      } else {
        // Inventory is off (or 012 isn't applied): behave exactly like /api/stock/availability does today for main's flow.
        if (!['owner', 'waiter'].includes(ctx.context.profile?.role)) throw new HttpError(403, 'You do not have access to this.');
        if (!selectMembership(ctx.context.memberships, ctx.restaurantId, STAFF_ROLES)) throw NO_BRANCH();
      }
      return { items: await availability(ctx.db, ctx.restaurantId) };
    } },

    { method: 'GET', path: new RegExp(`^/api/inventory/items/(?<id>${ID})$`), handler: async ({ request, params }) => {
      const ctx = await open(request);
      await allow(ctx, 'inv.view', 'inventory');
      return safely(() => itemDetail(ctx.db, ctx.scope, ctx.location.id, params.id));
    } },
  ];
}

export const routes = createRoutes();
