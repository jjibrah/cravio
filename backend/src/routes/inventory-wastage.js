// Wastage and reason codes API (P3-04, migration 019).
//   Branch side (X-Cravio-Branch names the branch; a manager of branch A is refused at branch B):
//     GET  /api/inventory/reason-codes?kind=wastage|adjustment|staff_meal|complimentary     the chips for the form (active only; the defaults are seeded on first read)
//     GET  /api/inventory/wastage                      this branch's wastage log (?reason= &itemId= &menuItemId= &employee= &status= &from= &to= &limit= &before=) + totals by reason
//     POST /api/inventory/wastage                      { itemId | menuItemId, quantity, unit?, reasonCodeId, note?, photoIds?, id?, commandId? }  -> posted at once, or pending_approval
//     POST /api/inventory/wastage/photo                { id, file: { name, type, base64 } }  upload a photo BEFORE recording: `id` is the id you will send with the record (12 MB body limit)
//     GET  /api/inventory/wastage/:id                  one record: lines, photos (ids; open them through /api/inventory/attachments), approval
//   Owner / operations (base /api/owner/inventory/:businessId):
//     GET  /wastage  /wastage/:id                      all branches (+ ?locationId=); operations managers see their branches
//     POST /wastage                                    the owner records anywhere: same body plus locationId;  POST /wastage/photo { id, locationId, file }
//     GET  /reason-codes?kind=&includeInactive=1       POST /reason-codes { kind, label, code?, needsPhoto?, needsNote? }     PUT /reason-codes/:id { label?, needsPhoto?, needsNote?, active?, position? }
//   Approving or rejecting a record that is waiting happens in the Approvals inbox (/approvals/:id/decide); the engine calls the wastage service.
// Every write: authorize (pool, BEFORE the transaction so a refusal's audit row isn't rolled back) -> one transaction -> once(commandId) -> service.
// createRoutes() takes its dependencies so tests run the real handlers.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { invalidateMenu } from '../lib/cache.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES, businessOfBranch } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, denyAndAudit, inventoryScope } from '../inventory/permissions.js';
import { supabaseStorage, upload } from '../inventory/attachments.js';
import * as reasons from '../inventory/reasons.js';
import { ensureWastageApprovals, get, list, locationOf, record } from '../inventory/wastage.js';

const ID = '[0-9a-fA-F-]{36}';
export const BODY_LIMIT = 12_000_000;
const MISSING_SCHEMA = new HttpError(503, 'Wastage needs database updates 012 to 019, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
const ENTITY = 'wastage';

let realStorage = null;
const defaultStorage = () => (realStorage ||= supabaseStorage());

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }),
  storage = defaultStorage, now = () => new Date() } = {}) {
  ensureWastageApprovals();
  const store = () => (typeof storage === 'function' ? storage() : storage);
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };
  const filters = (q) => ({ reason: q.get('reason') || undefined, itemId: q.get('itemId') || undefined, menuItemId: q.get('menuItemId') || undefined, employee: q.get('employee') || undefined,
    status: q.get('status') || undefined, from: q.get('from') || undefined, to: q.get('to') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined });
  const recordInput = (body) => { const { commandId, ...rest } = body; void commandId; return rest; };

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
    const row = await safely(() => businessOfBranch(db, context, restaurantId));
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

  const recordAt = (ctx, locationId, body) => transact((t) => once(t, { commandId: body.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind: 'wastage_record' },
    () => record(t, ctx.scope, { ...recordInput(body), locationId, commandId: body.commandId }, { now: now() })));

  return [
    // ----- Branch -----
    { method: 'GET', path: branch('/reason-codes'), handler: branchRead('inv.view', (ctx, _p, q) => reasons.list(ctx.db, ctx.scope, { kind: q.get('kind') || 'wastage' })) },
    { method: 'GET', path: branch('/wastage'), handler: branchRead('inv.view', (ctx, _p, q) => list(ctx.db, ctx.scope, { ...filters(q), locationId: ctx.location.id })) },
    { method: 'POST', path: branch('/wastage'), handler: withBody(async ({ request, body }) => {
      const ctx = await openBranch(request);
      await authorize(ctx.db, ctx.scope, 'inv.adjust.create', { locationId: ctx.location.id, entity: ENTITY });
      const result = await safely(() => recordAt(ctx, ctx.location.id, body));
      invalidateMenu(ctx.restaurantId);   // sold-out state may have changed
      return result;
    }) },
    { method: 'POST', path: branch('/wastage/photo'), bodyLimit: BODY_LIMIT, handler: withBody(async ({ request, body }) => {
      const ctx = await openBranch(request);
      await authorize(ctx.db, ctx.scope, 'inv.adjust.create', { locationId: ctx.location.id, entity: 'attachment' });
      return safely(() => upload(ctx.db, ctx.scope, { entityType: 'wastage', entityId: body.id, locationId: ctx.location.id, file: body.file, storage: store(), restrictToLocationId: ctx.location.id }));
    }) },
    { method: 'GET', path: branch(`/wastage/(?<id>${ID})`), handler: async ({ request, params }) => {
      const ctx = await openBranch(request);
      const found = await safely(() => locationOf(ctx.db, ctx.businessId, params.id));
      if (found.locationId !== ctx.location.id) throw await denyAndAudit(ctx.db, ctx.scope, 'inv.view', { locationId: found.locationId, entity: ENTITY, entityId: params.id, error: NO_BRANCH() });
      await authorize(ctx.db, ctx.scope, 'inv.view', { locationId: ctx.location.id, entity: ENTITY, entityId: params.id });
      return safely(() => get(ctx.db, ctx.scope, params.id));
    } },

    // ----- Owner / operations -----
    { method: 'GET', path: owner('/reason-codes'), handler: ownerRead((db, scope, _p, q) => reasons.list(db, scope, { kind: q.get('kind') || 'wastage', includeInactive: ['1', 'true', 'yes'].includes(String(q.get('includeInactive') || '').toLowerCase()) })) },
    { method: 'POST', path: owner('/reason-codes'), handler: withBody(async ({ request, params, body }) => {
      const { db, scope } = await openOwner(request, params);
      await safely(() => authorize(db, scope, 'inv.settings.edit', { entity: 'reason_code' }));
      return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind: 'reason_create' },
        () => reasons.create(tx, scope, { kind: body.kind, label: body.label, code: body.code, needsPhoto: body.needsPhoto, needsNote: body.needsNote }))));
    }) },
    { method: 'PUT', path: owner(`/reason-codes/(?<id>${ID})`), handler: withBody(async ({ request, params, body }) => {
      const { db, scope } = await openOwner(request, params);
      await safely(() => authorize(db, scope, 'inv.settings.edit', { entity: 'reason_code', entityId: params.id }));
      const { commandId, ...patch } = body;
      return safely(() => transact((tx) => once(tx, { commandId, businessId: scope.businessId, actorId: scope.userId, kind: 'reason_update' }, () => reasons.update(tx, scope, params.id, patch))));
    }) },
    { method: 'GET', path: owner('/wastage'), handler: ownerRead((db, scope, _p, q) => list(db, scope, { ...filters(q), locationId: q.get('locationId') || undefined })) },
    { method: 'GET', path: owner(`/wastage/(?<id>${ID})`), handler: ownerRead((db, scope, params) => get(db, scope, params.id)) },
    { method: 'POST', path: owner('/wastage'), handler: withBody(async ({ request, params, body }) => {
      const { db, scope, businessId } = await openOwner(request, params);
      await safely(() => authorize(db, scope, 'inv.adjust.create', { locationId: body.locationId ? String(body.locationId).toLowerCase() : null, entity: ENTITY }));
      const ctx = { scope, businessId };
      const result = await safely(() => recordAt(ctx, body.locationId, body));
      const place = scope.locations.find((l) => l.id === String(body.locationId).toLowerCase());
      if (place?.restaurantId) invalidateMenu(place.restaurantId);
      return result;
    }) },
    { method: 'POST', path: owner('/wastage/photo'), bodyLimit: BODY_LIMIT, handler: withBody(async ({ request, params, body }) => {
      const { db, scope } = await openOwner(request, params);
      const locationId = body.locationId ? String(body.locationId).toLowerCase() : null;
      await safely(() => authorize(db, scope, 'inv.adjust.create', { locationId, entity: 'attachment' }));
      return safely(() => upload(db, scope, { entityType: 'wastage', entityId: body.id, locationId, file: body.file, storage: store() }));
    }) },
  ];
}

export const routes = createRoutes();
