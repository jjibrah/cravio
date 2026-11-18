// Distribution API (P2-21 / P2-22, migration 018): stock requests, approval that reserves, preparing, dispatch, receiving, returns, branch -> branch transfers.
// Services: backend/src/inventory/distribution.js. Every write: authorize (pool, BEFORE the transaction so a refusal's audit row isn't rolled back) -> one transaction
// -> once(commandId) -> service. Send a `commandId` (a UUID) with every POST/PUT: a retry then returns the first result instead of repeating it.
//
//   BRANCH  (X-Cravio-Branch names the branch; a manager of branch A is refused (403) at branch B; a waiter is refused everywhere here)
//     GET  /api/inventory/requests?status=open|<status,..>&limit=&before=       this branch's requests (lines, held amounts, deliveries)
//     POST /api/inventory/requests                  { lines:[{ itemId, quantity, unit? }], note?, neededBy?, priority?, submit? (false = draft) }
//     GET  /api/inventory/requests/suggestions      what to ask for: par - available - incoming, rounded up to the main pack
//     GET  /api/inventory/requests/:id              PUT /requests/:id (edit a draft)   POST /requests/:id/submit   POST /requests/:id/cancel { reason? }
//     GET  /api/inventory/transfers?direction=&status=active|..                 deliveries to/from this branch (on its way is visible to both sides)
//     GET  /api/inventory/transfers/:id             lines, discrepancies, dispatch note JSON + QR payload ({ code, path: '/receive/CODE' })
//     POST /api/inventory/transfers/:id/receive     { lines:[{ itemId, received, damaged?, over?, unit? }], note?, final? }    destination branch
//     POST /api/inventory/transfers/:id/dispatch    { note?, driver?, vehicle? }       the SOURCE branch sends an approved branch -> branch transfer / return
//     POST /api/inventory/transfers/:id/cancel      withdraw a transfer that has not been sent
//     GET  /api/inventory/receive/:code             the QR landing: the delivery with this 10-letter code (403 unless you receive at its destination)
//     POST /api/inventory/receive/:code             same body as /transfers/:id/receive
//     POST /api/inventory/returns                   { lines, reason, note?, driver?, vehicle? }   this branch -> Warehouse (dispatches at once unless returns_need_approval)
//     POST /api/inventory/branch-transfers          { toBranchId | fromBranchId (a restaurant id; the other end is this branch), lines, note? }   needs the owner's approval
//   OWNER / OPERATIONS  (base /api/owner/inventory/:businessId; the owner acts, operations managers read, and approve only with operations_can_approve)
//     GET  /requests?status=&branchId=&limit=&before=      GET /requests/inbox (submitted, with what the Warehouse has per line; also needs-attention requests)
//     GET  /requests/suggestions?branchId=                 GET /requests/:id          POST /requests { branchId, ...same body as the branch }
//     POST /requests/:id/review    { decision: 'approve'|'reject', note?, lines?:[{ itemId, approved, unit? }] }    approve reserves each line at the Warehouse
//     POST /requests/:id/prepare   -> the pick list;  GET /requests/:id/pick-list
//     POST /requests/:id/dispatch  { lines?:[{ itemId, quantity, unit? }], note?, driver?, vehicle? }    partial allowed (the rest stays reserved)
//     POST /requests/:id/cancel    { reason? }
//     GET  /dispatches?direction=&status=&locationId=      GET /dispatches/:id          POST /dispatches { branchId, lines, note?, driver?, vehicle? }  (direct dispatch)
//     POST /dispatches/:id/cancel  before any receipt: stock goes back to the sender, a request's hold is put back
//     POST /dispatches/:id/receive same body as the branch receive (the Warehouse side receiving a return)
//     POST /dispatches/:id/send    send an approved branch -> branch transfer / return on the branch's behalf
//     POST /returns { branchId, lines, reason }    POST /branch-transfers { fromBranchId, toBranchId, lines, note? }
//     GET  /api/inventory/branches                  the OTHER active branches of this business a transfer can go to: [{ id (restaurant id), locationId, name }] (names only)
//   DISCREPANCIES (P2-23)  GET /discrepancies?status=open|resolved|all&branchId=&from=&to=&kind=   GET /discrepancies/:id   (owner base and branch base; the branch sees its own deliveries, read only)
//     POST /api/owner/inventory/:businessId/discrepancies/:id/resolve  { bearer: 'carrier'|'source'|'destination', resolution: 'write_off'|'arrived_later'|'returned_to_source'|'source_deducts', note, quantity? }
//   Approving or rejecting a branch -> branch transfer happens in the Approvals inbox (/approvals/:id/decide); the engine calls distribution.applyTransferDecision.
// createRoutes() takes its dependencies so tests run the real handlers.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { invalidateMenu } from '../lib/cache.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, can, denyAndAudit, inventoryScope } from '../inventory/permissions.js';
import * as dist from '../inventory/distribution.js';
import * as disc from '../inventory/discrepancies.js';

const ID = '[0-9a-fA-F-]{36}';
const MISSING_SCHEMA = new HttpError(503, 'Distribution needs database updates 012 to 018, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
const ENTITY = 'stock_request';

const strip = (body) => { const { commandId, ...rest } = body || {}; void commandId; return rest; };

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }), now = () => new Date() } = {}) {
  dist.ensureDistributionApprovals();
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };
  /** Branch menus show sold-out state from stock: refresh the branches a delivery touched. */
  const bust = (result) => {
    const t = result?.transfer;
    for (const id of new Set([t?.fromBranchId, t?.toBranchId].filter(Boolean))) invalidateMenu(id);
    return result;
  };
  const run = (tx, scope, businessId, kind, body, fn) => once(tx, { commandId: body?.commandId, businessId, actorId: scope.userId, kind }, fn);

  /* ----- branch ----- */

  async function openBranch(request) {
    const context = await authenticate(request);
    const db = pool();
    let restaurantId = requestedBranch(request);
    if (!restaurantId) {
      const membership = selectMembership(context.memberships, null, STAFF_ROLES);
      if (!membership) throw new HttpError(409, 'Choose which branch you are working in. Send the X-Cravio-Branch header.', { code: 'branch_required' });
      restaurantId = String(membership.restaurant.id).toLowerCase();
    }
    const row = (await safely(() => db.query('select business_id from public.restaurants where id = $1', [restaurantId]))).rows[0];
    if (!row) throw NO_BRANCH();
    const scope = await safely(() => inventoryScope(db, context, row.business_id));
    const location = scope.locations.find((l) => l.kind === 'branch' && l.restaurantId === restaurantId) || null;
    if (!location || !(scope.locationCaps.get(location.id)?.size)) throw NO_BRANCH();
    return { db, scope, location, businessId: row.business_id, restaurantId };
  }
  const base = '/api/inventory';
  const branch = (suffix) => new RegExp(`^${base}${suffix}$`);
  const branchRead = (capability, fn) => async ({ request, params, url }) => {
    const ctx = await openBranch(request);
    await authorize(ctx.db, ctx.scope, capability, { locationId: ctx.location.id, entity: ENTITY });
    return safely(() => fn(ctx, params, url?.searchParams || new URLSearchParams()));
  };
  /** Refuses (403 + audit) when the delivery doesn't involve this branch in the way the action needs: 'from', 'to' or 'either'. */
  async function transferGuard(ctx, id, side, capability) {
    const info = await safely(() => dist.transferLocations(ctx.db, ctx.businessId, id));
    const ok = side === 'from' ? info.fromLocationId === ctx.location.id : side === 'to' ? info.toLocationId === ctx.location.id : [info.fromLocationId, info.toLocationId].includes(ctx.location.id);
    if (!ok) throw await denyAndAudit(ctx.db, ctx.scope, capability, { locationId: ctx.location.id, entity: 'transfer', entityId: id, error: NO_BRANCH() });
    return info;
  }
  async function requestGuard(ctx, id, capability) {
    const info = await safely(() => dist.requestLocation(ctx.db, ctx.businessId, id));
    if (info.restaurantId !== ctx.restaurantId) throw await denyAndAudit(ctx.db, ctx.scope, capability, { locationId: ctx.location.id, entity: ENTITY, entityId: id, error: NO_BRANCH() });
  }
  const branchWrite = (kind, capability, guard, fn) => withBody(async ({ request, params, body }) => {
    const ctx = await openBranch(request);
    if (guard) await guard(ctx, params.id, capability);
    await authorize(ctx.db, ctx.scope, capability, { locationId: ctx.location.id, entity: kind.startsWith('request') ? ENTITY : 'transfer', entityId: params.id });
    return bust(await safely(() => transact((tx) => run(tx, ctx.scope, ctx.businessId, kind, body, () => fn(tx, ctx, params, strip(body))))));
  });
  const listArgs = (q) => ({ status: q.get('status') || undefined, direction: q.get('direction') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined });

  /** A delivery by its code, authorised against the caller (any business: the code decides which). */
  async function openCode(request, params) {
    const context = await authenticate(request);
    const db = pool();
    const found = await safely(() => dist.codeOwner(db, params.code));
    const scope = await safely(() => inventoryScope(db, context, found.businessId));
    await safely(() => authorize(db, scope, 'inv.transfer.receive', { locationId: found.toLocationId, entity: 'transfer', entityId: found.transferId }));
    return { db, scope, found };
  }

  /* ----- owner ----- */

  async function openOwner(request, params) {
    const context = await authenticate(request);
    const db = pool();
    const scope = await safely(() => inventoryScope(db, context, String(params.businessId).toLowerCase()));
    await safely(() => authorize(db, scope, 'inv.view', { entity: ENTITY }));
    if (!scope.roles.includes('owner') && !scope.roles.includes('operations')) throw await denyAndAudit(db, scope, 'inv.view', { entity: ENTITY });
    return { db, scope, businessId: scope.businessId };
  }
  const ownerBase = `/api/owner/inventory/(?<businessId>${ID})`;
  const owner = (suffix) => new RegExp(`^${ownerBase}${suffix}$`);
  const ownerRead = (fn) => async ({ request, params, url }) => {
    const { db, scope } = await openOwner(request, params);
    return safely(() => fn(db, scope, params, url?.searchParams || new URLSearchParams()));
  };
  /** locate(db, scope, params, body) -> the location the capability is checked at (default: the Warehouse). */
  const ownerWrite = (kind, capability, locate, fn) => withBody(async ({ request, params, body }) => {
    const { db, scope, businessId } = await openOwner(request, params);
    const locationId = locate ? await safely(() => locate(db, scope, params, body)) : scope.centerLocationId;
    await safely(() => authorize(db, scope, capability, { locationId, entity: ENTITY, entityId: params.id }));
    return bust(await safely(() => transact((tx) => run(tx, scope, businessId, kind, body, () => fn(tx, scope, params, strip(body))))));
  });
  const atRequest = async (db, scope, params) => (await dist.requestLocation(db, scope.businessId, params.id)).locationId;
  const atTransferFrom = async (db, scope, params) => (await dist.transferLocations(db, scope.businessId, params.id)).fromLocationId;
  const atTransferTo = async (db, scope, params) => (await dist.transferLocations(db, scope.businessId, params.id)).toLocationId;
  /** The sending place, or the receiving one when that is where the caller may approve (operations managers approve at branches, not at the Warehouse). */
  const atDiscrepancy = async (db, scope, params) => {
    const l = await disc.locationsOf(db, scope.businessId, params.id);
    return can(scope, 'inv.adjust.approve', { locationId: l.fromLocationId }) ? l.fromLocationId : l.toLocationId;
  };
  const atBranch = async (_db, scope, _p, body) => dist.branchLocationOf(scope, body.branchId ?? body.fromBranchId).id;

  return [
    // ----- Branch: requests -----
    { method: 'GET', path: branch('/requests'), handler: branchRead('inv.view', (ctx, _p, q) => dist.listRequests(ctx.db, ctx.scope, { ...listArgs(q), locationId: ctx.location.id })) },
    { method: 'GET', path: branch('/requests/suggestions'), handler: branchRead('inv.request.create', (ctx) => dist.suggestRequest(ctx.db, ctx.scope, ctx.location.id)) },
    { method: 'POST', path: branch('/requests'), handler: branchWrite('request_create', 'inv.request.create', null, (tx, ctx, _p, body) => dist.createRequest(tx, ctx.scope, { ...body, locationId: ctx.location.id }, { now: now() })) },
    { method: 'GET', path: branch(`/requests/(?<id>${ID})`), handler: async ({ request, params }) => {
      const ctx = await openBranch(request);
      await requestGuard(ctx, params.id, 'inv.view');
      await authorize(ctx.db, ctx.scope, 'inv.view', { locationId: ctx.location.id, entity: ENTITY, entityId: params.id });
      return safely(() => dist.getRequest(ctx.db, ctx.scope, params.id));
    } },
    { method: 'PUT', path: branch(`/requests/(?<id>${ID})`), handler: branchWrite('request_edit', 'inv.request.create', requestGuard, (tx, ctx, params, body) => dist.editDraft(tx, ctx.scope, params.id, body)) },
    { method: 'POST', path: branch(`/requests/(?<id>${ID})/submit`), handler: branchWrite('request_submit', 'inv.request.create', requestGuard, (tx, ctx, params) => dist.submit(tx, ctx.scope, params.id, { now: now() })) },
    { method: 'POST', path: branch(`/requests/(?<id>${ID})/cancel`), handler: branchWrite('request_cancel', 'inv.request.create', requestGuard, (tx, ctx, params, body) => dist.cancel(tx, ctx.scope, params.id, { reason: body.reason })) },

    // ----- Branch: deliveries -----
    { method: 'GET', path: branch('/transfers'), handler: branchRead('inv.view', (ctx, _p, q) => dist.listTransfers(ctx.db, ctx.scope, { ...listArgs(q), locationId: ctx.location.id })) },
    { method: 'GET', path: branch(`/transfers/(?<id>${ID})`), handler: async ({ request, params }) => {
      const ctx = await openBranch(request);
      await transferGuard(ctx, params.id, 'either', 'inv.view');
      await authorize(ctx.db, ctx.scope, 'inv.view', { locationId: ctx.location.id, entity: 'transfer', entityId: params.id });
      return safely(() => dist.getTransfer(ctx.db, ctx.scope, params.id));
    } },
    { method: 'POST', path: branch(`/transfers/(?<id>${ID})/receive`), handler: branchWrite('transfer_receive', 'inv.transfer.receive', (ctx, id, cap) => transferGuard(ctx, id, 'to', cap),
      (tx, ctx, params, body) => dist.receive(tx, ctx.scope, params.id, body, { now: now() })) },
    { method: 'POST', path: branch(`/transfers/(?<id>${ID})/dispatch`), handler: branchWrite('transfer_dispatch', 'inv.request.create', (ctx, id, cap) => transferGuard(ctx, id, 'from', cap),
      (tx, ctx, params, body) => dist.dispatchTransfer(tx, ctx.scope, params.id, body, { now: now() })) },
    { method: 'POST', path: branch(`/transfers/(?<id>${ID})/cancel`), handler: branchWrite('transfer_cancel', 'inv.request.create', (ctx, id, cap) => transferGuard(ctx, id, 'either', cap),
      (tx, ctx, params) => dist.cancelTransfer(tx, ctx.scope, params.id)) },
    { method: 'GET', path: branch('/receive/(?<code>[^/]+)'), handler: async ({ request, params }) => {
      const { db, scope, found } = await openCode(request, params);
      return safely(() => dist.getTransfer(db, scope, found.transferId));
    } },
    { method: 'POST', path: branch('/receive/(?<code>[^/]+)'), handler: withBody(async ({ request, params, body }) => {
      const { db, scope, found } = await openCode(request, params);
      void db;
      return bust(await safely(() => transact((tx) => run(tx, scope, scope.businessId, 'transfer_receive', body, () => dist.receive(tx, scope, found.transferId, strip(body), { now: now() })))));
    }) },

    // ----- Branch: returns and branch -> branch -----
    { method: 'GET', path: branch('/branches'), handler: branchRead('inv.request.create', async (ctx) => {
      const ids = ctx.scope.locations.filter((l) => l.kind === 'branch' && l.id !== ctx.location.id).map((l) => l.id);
      const rows = ids.length ? (await ctx.db.query(`select l.id, l.restaurant_id, coalesce(r.name, l.name) as name from public.stock_locations l left join public.restaurants r on r.id = l.restaurant_id
        where l.business_id = $1 and l.id = any($2::uuid[]) and l.status = 'active' and l.archived_at is null order by 3`, [ctx.businessId, ids])).rows : [];
      return { branches: rows.map((x) => ({ id: x.restaurant_id, locationId: x.id, name: x.name })) };
    }) },
    { method: 'POST', path: branch('/returns'), handler: branchWrite('return_start', 'inv.request.create', null, (tx, ctx, _p, body) => dist.startReturn(tx, ctx.scope, { ...body, locationId: ctx.location.id }, { now: now() })) },
    { method: 'POST', path: branch('/branch-transfers'), handler: branchWrite('branch_transfer_request', 'inv.request.create', null, (tx, ctx, _p, body) => {
      const from = body.fromBranchId ?? ctx.restaurantId;
      const to = body.toBranchId ?? ctx.restaurantId;
      if (from !== ctx.restaurantId && to !== ctx.restaurantId) throw new HttpError(403, 'A transfer has to start or end at your own branch.', { code: 'branch_forbidden' });
      return dist.requestBranchTransfer(tx, ctx.scope, { ...body, fromLocationId: dist.branchLocationOf(ctx.scope, from).id, toLocationId: dist.branchLocationOf(ctx.scope, to).id }, { now: now() });
    }) },

    // ----- Branch: discrepancies on this branch's deliveries (read only) -----
    { method: 'GET', path: branch('/discrepancies'), handler: branchRead('inv.view', (ctx, _p, q) => disc.list(ctx.db, ctx.scope, { status: q.get('status') || undefined, from: q.get('from'), to: q.get('to'), kind: q.get('kind'), branchId: ctx.restaurantId })) },
    { method: 'GET', path: branch(`/discrepancies/(?<id>${ID})`), handler: async ({ request, params }) => {
      const ctx = await openBranch(request);
      const info = await safely(() => disc.locationsOf(ctx.db, ctx.businessId, params.id));
      if (![info.fromLocationId, info.toLocationId].includes(ctx.location.id)) throw await denyAndAudit(ctx.db, ctx.scope, 'inv.view', { locationId: ctx.location.id, entity: 'discrepancy', entityId: params.id, error: NO_BRANCH() });
      return safely(() => disc.get(ctx.db, ctx.scope, params.id));
    } },

    // ----- Owner / operations -----
    { method: 'GET', path: owner('/requests'), handler: ownerRead((db, scope, _p, q) => dist.listRequests(db, scope, { ...listArgs(q), locationId: q.get('branchId') ? dist.branchLocationOf(scope, q.get('branchId')).id : undefined })) },
    { method: 'GET', path: owner('/requests/inbox'), handler: ownerRead((db, scope) => dist.inbox(db, scope, { now: now() })) },
    { method: 'GET', path: owner('/requests/suggestions'), handler: ownerRead((db, scope, _p, q) => dist.suggestRequest(db, scope, dist.branchLocationOf(scope, q.get('branchId')).id)) },
    { method: 'GET', path: owner(`/requests/(?<id>${ID})`), handler: ownerRead((db, scope, params) => dist.getRequest(db, scope, params.id)) },
    { method: 'POST', path: owner('/requests'), handler: ownerWrite('request_create', 'inv.request.create', (_d, scope, _p, body) => dist.branchLocationOf(scope, body.branchId).id,
      (tx, scope, _p, body) => dist.createRequest(tx, scope, { ...body, locationId: dist.branchLocationOf(scope, body.branchId).id }, { now: now() })) },
    { method: 'POST', path: owner(`/requests/(?<id>${ID})/review`), handler: ownerWrite('request_review', 'inv.request.approve', atRequest, (tx, scope, params, body) => dist.review(tx, scope, params.id, body, { now: now() })) },
    { method: 'POST', path: owner(`/requests/(?<id>${ID})/prepare`), handler: ownerWrite('request_prepare', 'inv.transfer.dispatch', null, (tx, scope, params) => dist.startPreparing(tx, scope, params.id, { now: now() })) },
    { method: 'GET', path: owner(`/requests/(?<id>${ID})/pick-list`), handler: async ({ request, params }) => {
      const { db, scope } = await openOwner(request, params);
      await safely(() => authorize(db, scope, 'inv.transfer.dispatch', { locationId: scope.centerLocationId, entity: ENTITY, entityId: params.id }));
      return safely(() => dist.pickList(db, scope, params.id));
    } },
    { method: 'POST', path: owner(`/requests/(?<id>${ID})/dispatch`), handler: ownerWrite('request_dispatch', 'inv.transfer.dispatch', null, (tx, scope, params, body) => dist.dispatch(tx, scope, { ...body, requestId: params.id }, { now: now() })) },
    { method: 'POST', path: owner(`/requests/(?<id>${ID})/cancel`), handler: ownerWrite('request_cancel', 'inv.request.approve', atRequest, (tx, scope, params, body) => dist.cancel(tx, scope, params.id, { reason: body.reason })) },

    { method: 'GET', path: owner('/dispatches'), handler: ownerRead((db, scope, _p, q) => dist.listTransfers(db, scope, { ...listArgs(q), locationId: q.get('locationId') || undefined })) },
    { method: 'GET', path: owner(`/dispatches/(?<id>${ID})`), handler: ownerRead((db, scope, params) => dist.getTransfer(db, scope, params.id)) },
    { method: 'POST', path: owner('/dispatches'), handler: ownerWrite('dispatch_direct', 'inv.transfer.dispatch', null, (tx, scope, _p, body) => dist.dispatch(tx, scope, { ...body, requestId: undefined }, { now: now() })) },
    { method: 'POST', path: owner(`/dispatches/(?<id>${ID})/cancel`), handler: ownerWrite('dispatch_cancel', 'inv.transfer.dispatch', atTransferFrom, (tx, scope, params) => dist.cancelDispatch(tx, scope, params.id, { now: now() })) },
    { method: 'POST', path: owner(`/dispatches/(?<id>${ID})/receive`), handler: ownerWrite('transfer_receive', 'inv.transfer.receive', atTransferTo, (tx, scope, params, body) => dist.receive(tx, scope, params.id, body, { now: now() })) },
    { method: 'POST', path: owner(`/dispatches/(?<id>${ID})/send`), handler: ownerWrite('transfer_dispatch', 'inv.request.create', atTransferFrom, (tx, scope, params, body) => dist.dispatchTransfer(tx, scope, params.id, body, { now: now() })) },
    { method: 'GET', path: owner('/receive/(?<code>[^/]+)'), handler: async ({ request, params }) => {
      const { db, scope } = await openOwner(request, params);
      return safely(() => dist.findByCode(db, scope, params.code));
    } },
    { method: 'GET', path: owner('/discrepancies'), handler: ownerRead((db, scope, _p, q) => disc.list(db, scope, { status: q.get('status') || undefined, branchId: q.get('branchId') || undefined, from: q.get('from'), to: q.get('to'), kind: q.get('kind') || undefined, limit: q.get('limit') || undefined })) },
    { method: 'GET', path: owner(`/discrepancies/(?<id>${ID})`), handler: ownerRead((db, scope, params) => disc.get(db, scope, params.id)) },
    { method: 'POST', path: owner(`/discrepancies/(?<id>${ID})/resolve`), handler: ownerWrite('discrepancy_resolve', 'inv.adjust.approve', atDiscrepancy, (tx, scope, params, body) => disc.resolve(tx, scope, params.id, body, { now: now() })) },
    { method: 'POST', path: owner('/returns'), handler: ownerWrite('return_start', 'inv.request.create', atBranch, (tx, scope, _p, body) => dist.startReturn(tx, scope, { ...body, locationId: dist.branchLocationOf(scope, body.branchId).id }, { now: now() })) },
    { method: 'POST', path: owner('/branch-transfers'), handler: ownerWrite('branch_transfer_request', 'inv.request.create', (_d, scope, _p, body) => dist.branchLocationOf(scope, body.fromBranchId).id,
      (tx, scope, _p, body) => dist.requestBranchTransfer(tx, scope, { ...body, fromLocationId: dist.branchLocationOf(scope, body.fromBranchId).id, toLocationId: dist.branchLocationOf(scope, body.toBranchId).id }, { now: now() })) },
  ];
}

export const routes = createRoutes();
