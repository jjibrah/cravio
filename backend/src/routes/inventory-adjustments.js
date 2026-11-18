// Stock adjustments, staff meals and complimentaries API (P3-05, migration 019).
//   Branch side (X-Cravio-Branch names the branch; a manager of branch A is refused at branch B):
//     GET  /api/inventory/adjustments                  this branch's adjustments (?direction=gain|loss &reason= &itemId= &status= &employee= &from= &to= &limit= &before=) + totals
//     POST /api/inventory/adjustments                  { direction, itemId, quantity, unit?, reasonCodeId, note?, photoIds?, id?, commandId? }  -> posted at once, or pending_approval (always, until the owner sets a limit)
//     POST /api/inventory/adjustments/photo            { id, file: { name, type, base64 } }  upload evidence BEFORE saving: `id` is the id you will send with the adjustment (12 MB body limit)
//     GET  /api/inventory/adjustments/:id              one adjustment: photos, approval
//     GET  /api/inventory/allowance                    today's staff-meal and complimentary allowance at this branch: limit, used, left (null limit = none set)
//     POST /api/inventory/staff-meals                  { menuItemId | itemId, quantity, unit?, forWhom?, note?, reasonCodeId?, id?, commandId? }  over the allowance needs a note and tells the owner
//     POST /api/inventory/complimentaries              same body
//     GET  /api/inventory/allowance-records            history of both (?kind=staff_meal|complimentary &overOnly=1 &from= &to= &limit= &before=)
//     GET  /api/inventory/allowance-records/:id
//   Owner / operations (base /api/owner/inventory/:businessId): the same paths without the /api/inventory prefix, with ?locationId= on reads and a locationId in the body of writes.
//     The allowances themselves (staff_meal_allowance_portions, complimentary_allowance_kes) are edited with the existing  PUT /settings/:key  (inv.settings.edit).
//   Approving or rejecting an adjustment that is waiting happens in the Approvals inbox (/approvals/:id/decide); the engine calls the adjustments service.
// Every write: authorize (pool, BEFORE the transaction so a refusal's audit row isn't rolled back) -> one transaction -> once(commandId) -> service.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { invalidateMenu } from '../lib/cache.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, denyAndAudit, inventoryScope } from '../inventory/permissions.js';
import { supabaseStorage, upload } from '../inventory/attachments.js';
import * as adjustments from '../inventory/adjustments.js';
import * as allowances from '../inventory/allowances.js';

const ID = '[0-9a-fA-F-]{36}';
export const BODY_LIMIT = 12_000_000;
const MISSING_SCHEMA = new HttpError(503, 'Adjustments need database updates 012 to 019, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
const ENTITY = 'adjustment';

let realStorage = null;
const defaultStorage = () => (realStorage ||= supabaseStorage());

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }),
  storage = defaultStorage, now = () => new Date() } = {}) {
  adjustments.ensureAdjustmentApprovals();
  const store = () => (typeof storage === 'function' ? storage() : storage);
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };
  const flag = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
  const adjustmentFilters = (q) => ({ direction: q.get('direction') || undefined, reason: q.get('reason') || undefined, itemId: q.get('itemId') || undefined, status: q.get('status') || undefined,
    employee: q.get('employee') || undefined, from: q.get('from') || undefined, to: q.get('to') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined });
  const recordFilters = (q) => ({ kind: q.get('kind') || undefined, overOnly: flag(q.get('overOnly')), from: q.get('from') || undefined, to: q.get('to') || undefined,
    limit: q.get('limit') || undefined, before: q.get('before') || undefined });
  const withoutCommand = (body) => { const { commandId, ...rest } = body; void commandId; return rest; };

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
  const branchRead = (capability, fn) => async ({ request, params, url }) => {
    const ctx = await openBranch(request);
    await authorize(ctx.db, ctx.scope, capability, { locationId: ctx.location.id, entity: ENTITY });
    return safely(() => fn(ctx, params, url?.searchParams || new URLSearchParams()));
  };
  const base = '/api/inventory';
  const branch = (suffix) => new RegExp(`^${base}${suffix}$`);

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

  const adjustAt = (ctx, locationId, body) => transact((t) => once(t, { commandId: body.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind: 'adjustment_create' },
    () => adjustments.createAdjustment(t, ctx.scope, { ...withoutCommand(body), locationId, commandId: body.commandId }, { now: now() })));
  const giveAt = (ctx, kind, locationId, body) => transact((t) => once(t, { commandId: body.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind: `allowance_${kind}` },
    () => allowances.record(t, ctx.scope, { ...withoutCommand(body), kind, locationId }, { now: now() })));
  const touchMenu = (scope, locationId) => {
    const place = scope.locations.find((l) => l.id === String(locationId).toLowerCase());
    if (place?.restaurantId) invalidateMenu(place.restaurantId);     // sold-out state may have changed
  };

  const branchWrite = (fn) => withBody(async ({ request, body }) => {
    const ctx = await openBranch(request);
    await authorize(ctx.db, ctx.scope, 'inv.adjust.create', { locationId: ctx.location.id, entity: ENTITY });
    const result = await safely(() => fn(ctx, body));
    invalidateMenu(ctx.restaurantId);
    return result;
  });
  const ownerWrite = (fn) => withBody(async ({ request, params, body }) => {
    const { db, scope, businessId } = await openOwner(request, params);
    const locationId = body.locationId ? String(body.locationId).toLowerCase() : null;
    await safely(() => authorize(db, scope, 'inv.adjust.create', { locationId, entity: ENTITY }));
    const result = await safely(() => fn({ scope, businessId }, locationId, body));
    if (locationId) touchMenu(scope, locationId);
    return result;
  });

  const KINDS = [['staff-meals', 'staff_meal'], ['complimentaries', 'complimentary']];

  return [
    // ----- Branch: adjustments -----
    { method: 'GET', path: branch('/adjustments'), handler: branchRead('inv.view', (ctx, _p, q) => adjustments.list(ctx.db, ctx.scope, { ...adjustmentFilters(q), locationId: ctx.location.id })) },
    { method: 'POST', path: branch('/adjustments'), handler: branchWrite((ctx, body) => adjustAt(ctx, ctx.location.id, body)) },
    { method: 'POST', path: branch('/adjustments/photo'), bodyLimit: BODY_LIMIT, handler: withBody(async ({ request, body }) => {
      const ctx = await openBranch(request);
      await authorize(ctx.db, ctx.scope, 'inv.adjust.create', { locationId: ctx.location.id, entity: 'attachment' });
      return safely(() => upload(ctx.db, ctx.scope, { entityType: 'adjustment', entityId: body.id, locationId: ctx.location.id, file: body.file, storage: store(), restrictToLocationId: ctx.location.id }));
    }) },
    { method: 'GET', path: branch(`/adjustments/(?<id>${ID})`), handler: async ({ request, params }) => {
      const ctx = await openBranch(request);
      const found = await safely(() => adjustments.locationOf(ctx.db, ctx.businessId, params.id));
      if (found.locationId !== ctx.location.id) throw await denyAndAudit(ctx.db, ctx.scope, 'inv.view', { locationId: found.locationId, entity: ENTITY, entityId: params.id, error: NO_BRANCH() });
      await authorize(ctx.db, ctx.scope, 'inv.view', { locationId: ctx.location.id, entity: ENTITY, entityId: params.id });
      return safely(() => adjustments.get(ctx.db, ctx.scope, params.id));
    } },

    // ----- Branch: staff meals and complimentaries -----
    { method: 'GET', path: branch('/allowance'), handler: branchRead('inv.view', (ctx) => allowances.allowance(ctx.db, ctx.scope, { locationId: ctx.location.id, now: now() })) },
    ...KINDS.map(([slug, kind]) => ({ method: 'POST', path: branch(`/${slug}`), handler: branchWrite((ctx, body) => giveAt(ctx, kind, ctx.location.id, body)) })),
    { method: 'GET', path: branch('/allowance-records'), handler: branchRead('inv.view', (ctx, _p, q) => allowances.list(ctx.db, ctx.scope, { ...recordFilters(q), locationId: ctx.location.id })) },
    { method: 'GET', path: branch(`/allowance-records/(?<id>${ID})`), handler: async ({ request, params }) => {
      const ctx = await openBranch(request);
      const found = await safely(() => allowances.locationOf(ctx.db, ctx.businessId, params.id));
      if (found.locationId !== ctx.location.id) throw await denyAndAudit(ctx.db, ctx.scope, 'inv.view', { locationId: found.locationId, entity: 'allowance', entityId: params.id, error: NO_BRANCH() });
      await authorize(ctx.db, ctx.scope, 'inv.view', { locationId: ctx.location.id, entity: 'allowance', entityId: params.id });
      return safely(() => allowances.get(ctx.db, ctx.scope, params.id));
    } },

    // ----- Owner / operations -----
    { method: 'GET', path: owner('/adjustments'), handler: ownerRead((db, scope, _p, q) => adjustments.list(db, scope, { ...adjustmentFilters(q), locationId: q.get('locationId') || undefined })) },
    { method: 'GET', path: owner(`/adjustments/(?<id>${ID})`), handler: ownerRead((db, scope, params) => adjustments.get(db, scope, params.id)) },
    { method: 'POST', path: owner('/adjustments'), handler: ownerWrite((ctx, locationId, body) => adjustAt(ctx, locationId, body)) },
    { method: 'POST', path: owner('/adjustments/photo'), bodyLimit: BODY_LIMIT, handler: withBody(async ({ request, params, body }) => {
      const { db, scope } = await openOwner(request, params);
      const locationId = body.locationId ? String(body.locationId).toLowerCase() : null;
      await safely(() => authorize(db, scope, 'inv.adjust.create', { locationId, entity: 'attachment' }));
      return safely(() => upload(db, scope, { entityType: 'adjustment', entityId: body.id, locationId, file: body.file, storage: store() }));
    }) },
    { method: 'GET', path: owner('/allowance'), handler: ownerRead((db, scope, _p, q) => allowances.allowance(db, scope, { locationId: q.get('locationId'), now: now() })) },
    ...KINDS.map(([slug, kind]) => ({ method: 'POST', path: owner(`/${slug}`), handler: ownerWrite((ctx, locationId, body) => giveAt(ctx, kind, locationId, body)) })),
    { method: 'GET', path: owner('/allowance-records'), handler: ownerRead((db, scope, _p, q) => allowances.list(db, scope, { ...recordFilters(q), locationId: q.get('locationId') || undefined })) },
    { method: 'GET', path: owner(`/allowance-records/(?<id>${ID})`), handler: ownerRead((db, scope, params) => allowances.get(db, scope, params.id)) },
  ];
}

export const routes = createRoutes();
