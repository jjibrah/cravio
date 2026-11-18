// The 009 request / review / dispatch / receive endpoints (moved out of routes/stock.js in P2-25 so that file stays thin; same URLs, bodies and responses).
//   * business with inventory_enabled = false  -> src/stock/service.js, untouched (main's behaviour, byte for byte)
//   * business with inventory_enabled = true   -> src/inventory/legacy-bridge.js, which runs distribution.js (one engine, one set of rows)
// Both run in the same transaction with the same commandId idempotency (kind names unchanged).
// createFlowRoutes() takes its dependencies so tests run the real handlers against a test database.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { invalidateMenu } from '../lib/cache.js';
import { withDb } from '../lib/db.js';
import { managerContext as realManagerContext, withBody } from '../lib/operations.js';
import { branchLocation, cancelDispatch, cancelRequest, once, receive, reviewRequest, submitRequest, dispatch } from '../stock/service.js';
import * as bridge from '../inventory/legacy-bridge.js';

const ID = '[0-9a-fA-F-]{36}';

async function realBusiness(request, businessId, { write = false } = {}) {
  const context = await requireUser(request);
  if (context.grants === undefined) throw new HttpError(503, 'The owner interface needs database update 008, which hasn’t been applied yet.', { code: 'business_schema_missing' });
  const grant = (context.grants || []).find((g) => g.businessId === String(businessId).toLowerCase());
  if (!grant) throw new HttpError(404, 'That business isn’t yours.');
  if (write && grant.role !== 'owner') throw new HttpError(403, 'Only the business owner can do this.');
  return { ...context, grant };
}

export function createFlowRoutes({ managerContext = realManagerContext, ownerContext = realBusiness, transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }), bust = invalidateMenu } = {}) {
  /** A branch write: resolves the branch's business and stock location inside the transaction, then runs 009 or the bridge. */
  const branchWrite = (kind, legacy, bridged, { menuChanges = true } = {}) => withBody(async ({ request, params, body }) => {
    const context = await managerContext(request);
    const { restaurantId, user } = context;
    const result = await transact(async (db) => {
      const { rows } = await db.query('select business_id from public.restaurants where id = $1', [restaurantId]);
      const ctx = { businessId: rows[0].business_id, restaurantId, actorId: user.id, locationId: await branchLocation(db, restaurantId) };
      return once(db, { commandId: body.commandId, businessId: ctx.businessId, actorId: user.id, kind },
        async () => ((await bridge.switched(db, ctx.businessId)) ? bridged(db, { ...ctx, context }, params, body) : legacy(db, ctx, params, body)));
    });
    if (menuChanges) bust(restaurantId);
    return result;
  });

  const ownerWrite = (kind, legacy, bridged) => withBody(async ({ request, params, body }) => {
    const context = await ownerContext(request, params.businessId, { write: true });
    const businessId = params.businessId.toLowerCase();
    const result = await transact((db) => once(db, { commandId: body.commandId, businessId, actorId: context.user.id, kind },
      async () => {
        const ctx = { businessId, actorId: context.user.id };
        return (await bridge.switched(db, businessId)) ? bridged(db, { ...ctx, context }, params, body) : legacy(db, ctx, params, body);
      }));
    if (result?.restaurantId) bust(result.restaurantId);
    return result;
  });

  return [
    { method: 'POST', path: '/api/stock/requests', handler: branchWrite('request', (db, ctx, _p, body) => submitRequest(db, ctx, body), bridge.submitRequest, { menuChanges: false }) },
    { method: 'POST', path: new RegExp(`^/api/stock/requests/(?<id>${ID})/cancel$`), handler: branchWrite('request_cancel', (db, ctx, params) => cancelRequest(db, ctx, params.id), bridge.cancelRequest, { menuChanges: false }) },
    { method: 'POST', path: new RegExp(`^/api/stock/transfers/(?<id>${ID})/receive$`), handler: branchWrite('receive', (db, ctx, params, body) => receive(db, ctx, params.id, body), bridge.receive) },
    { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/requests/(?<id>${ID})/review$`), handler: ownerWrite('review', (db, ctx, params, body) => reviewRequest(db, ctx, params.id, body), bridge.reviewRequest) },
    { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/dispatches$`), handler: ownerWrite('dispatch', (db, ctx, _p, body) => dispatch(db, ctx, body), bridge.dispatch) },
    { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/dispatches/(?<id>${ID})/cancel$`), handler: ownerWrite('dispatch_cancel', (db, ctx, params) => cancelDispatch(db, ctx, params.id), bridge.cancelDispatch) },
  ];
}

export const flowRoutes = createFlowRoutes();
