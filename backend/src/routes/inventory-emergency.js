// Emergency purchases API (P2-11, migration 017).
//   Branch side, /api/inventory/emergency (X-Cravio-Branch names the branch; a manager of branch A is refused at branch B):
//     GET    /                  this branch's purchases (?status= open|needs_review|done|finished|<status>[,..] &invoiceStatus= &from= &to= &search= &limit=)
//     GET    /limits            "KES 3,500 left today" for the form (?amount=1200 also says whether that amount is within the limits)
//     GET    /suppliers         the picker: names only (?search=), POST /suppliers adds an on-the-spot supplier { name, phone, kraPin? }
//     POST   /                  create a draft { reason, supplierId | newSupplier, lines: [{ itemId, qty, unit, price }] }
//     GET    /:id               one purchase with lines, approval history and evidence (5-minute signed links)
//     PUT    /:id               edit a draft
//     POST   /:id/submit        send it: authorised at once below the owner's limits, else waiting for the owner
//     POST   /:id/purchased     { paymentMethod, paymentReference, prices: [{ lineId, price }], invoiceStatus?, invoiceNo?, noInvoiceReason? }
//     POST   /:id/receive       { lines?: [{ lineId, qty, unit }], invoiceStatus, invoiceNo?, noInvoiceReason?, paymentReference? }  stock goes up here
//     POST   /:id/cancel        { reason? }
//     POST   /:id/evidence      { file: { name, type, base64 } }  a photo of the goods or the receipt (12 MB body limit like /api/inventory/attachments)
//   Owner side, /api/owner/inventory/:businessId/emergency (owners; operations managers read their branches):
//     GET    /                  all branches (same filters, plus ?locationId=)
//     GET    /:id               detail with evidence links
//     POST   /:id/review        { outcome: 'close' | 'flag', note, clawbackNote }  (inv.emergency.approve)
//   Rejecting or approving a waiting purchase happens in the Approvals inbox (/approvals/:id/decide); that decision reaches the purchase through
//   the approvals engine. Every write: authorize (pool, BEFORE the transaction so a refusal's audit row isn't rolled back) -> one transaction ->
//   once(commandId) -> service (audits). createRoutes() takes its dependencies so tests run the real handlers.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, denyAndAudit, inventoryScope } from '../inventory/permissions.js';
import { upload, supabaseStorage } from '../inventory/attachments.js';
import { createOnTheSpot, listForBranch } from '../inventory/suppliers.js';
import { cancel, create, evidenceTarget, get, limitsFor, list, locationOf, markPurchased, receive, review, submit, update } from '../inventory/emergency.js';

const ID = '[0-9a-fA-F-]{36}';
export const BODY_LIMIT = 12_000_000;
const MISSING_SCHEMA = new HttpError(503, 'Emergency purchases need database updates 012 to 017, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
const ENTITY = 'emergency_purchase';

let realStorage = null;
const defaultStorage = () => (realStorage ||= supabaseStorage());

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }),
  storage = defaultStorage, now = () => new Date() } = {}) {
  const store = () => (typeof storage === 'function' ? storage() : storage);
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };

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
    return { db, scope, location, businessId: row.business_id };
  }

  /** The purchase must belong to THIS branch (another branch's id is a 403 and an audited denial); then the capability at that branch is checked. */
  async function guard(ctx, id, capability) {
    const found = await safely(() => locationOf(ctx.db, ctx.businessId, id));
    if (found.locationId !== ctx.location.id) {
      throw await denyAndAudit(ctx.db, ctx.scope, capability, { locationId: found.locationId, entity: ENTITY, entityId: id, error: NO_BRANCH() });
    }
    await authorize(ctx.db, ctx.scope, capability, { locationId: ctx.location.id, entity: ENTITY, entityId: id });
  }

  const branchRead = (capability, fn) => async ({ request, params, url }) => {
    const ctx = await openBranch(request);
    await authorize(ctx.db, ctx.scope, capability, { locationId: ctx.location.id, entity: ENTITY });
    return safely(() => fn(ctx, params, url?.searchParams || new URLSearchParams()));
  };
  const branchOne = (fn) => async ({ request, params, url }) => {
    const ctx = await openBranch(request);
    await guard(ctx, params.id, 'inv.view');
    return safely(() => fn(ctx, params, url?.searchParams || new URLSearchParams()));
  };
  /** A write on one purchase of this branch. */
  const branchWrite = (kind, run) => withBody(async ({ request, params, body }) => {
    const ctx = await openBranch(request);
    await guard(ctx, params.id, 'inv.emergency.create');
    return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind },
      () => run(tx, ctx.scope, params, body, ctx))));
  });
  const branchCreate = (kind, run) => withBody(async ({ request, body }) => {
    const ctx = await openBranch(request);
    await authorize(ctx.db, ctx.scope, 'inv.emergency.create', { locationId: ctx.location.id, entity: ENTITY });
    return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind },
      () => run(tx, ctx.scope, body, ctx))));
  });
  const filters = (q) => ({ status: q.get('status') || undefined, invoiceStatus: q.get('invoiceStatus') || undefined, from: q.get('from') || undefined,
    to: q.get('to') || undefined, search: q.get('search') || undefined, limit: q.get('limit') || undefined });
  const branchBase = '/api/inventory/emergency';
  const branch = (suffix = '') => new RegExp(`^${branchBase}${suffix}$`);
  const withId = (suffix = '') => branch(`/(?<id>${ID})${suffix}`);

  /* ----- owner ----- */

  async function openOwner(request, params) {
    const context = await authenticate(request);
    const db = pool();
    const scope = await safely(() => inventoryScope(db, context, String(params.businessId).toLowerCase()));
    await safely(() => authorize(db, scope, 'inv.view', { entity: ENTITY }));
    if (!scope.roles.includes('owner') && !scope.roles.includes('operations')) throw await denyAndAudit(db, scope, 'inv.view', { entity: ENTITY });
    return { db, scope, businessId: scope.businessId };
  }
  const ownerBase = `/api/owner/inventory/(?<businessId>${ID})/emergency`;
  const owner = (suffix = '') => new RegExp(`^${ownerBase}${suffix}$`);

  return [
    // ----- Branch -----
    { method: 'GET', path: branch(), handler: branchRead('inv.view', (ctx, _p, q) => list(ctx.db, ctx.scope, { ...filters(q), locationId: ctx.location.id })) },
    { method: 'GET', path: branch('/limits'), handler: branchRead('inv.emergency.create', (ctx, _p, q) => limitsFor(ctx.db, ctx.scope, ctx.location.id, { amountKes: q.get('amount') || null, now: now() })) },
    { method: 'GET', path: branch('/suppliers'), handler: branchRead('inv.emergency.create', (ctx, _p, q) => listForBranch(ctx.db, ctx.scope, ctx.location.id, { search: q.get('search') || undefined, itemId: q.get('itemId') || undefined })) },
    { method: 'POST', path: branch('/suppliers'), handler: branchCreate('emergency_supplier', (tx, scope, body, ctx) => createOnTheSpot(tx, scope, ctx.location.id, body)) },
    { method: 'POST', path: branch(), handler: branchCreate('emergency_create', (tx, scope, body, ctx) => { const { commandId, ...rest } = body; void commandId; return create(tx, scope, { ...rest, locationId: ctx.location.id }, { now: now() }); }) },
    { method: 'GET', path: withId(), handler: branchOne((ctx, params) => get(ctx.db, ctx.scope, params.id, { storage: store(), restrictToLocationId: ctx.location.id })) },
    { method: 'PUT', path: withId(), handler: branchWrite('emergency_update', (tx, scope, params, body) => { const { commandId, ...rest } = body; void commandId; return update(tx, scope, params.id, rest); }) },
    { method: 'POST', path: withId('/submit'), handler: branchWrite('emergency_submit', (tx, scope, params) => submit(tx, scope, params.id, { now: now() })) },
    { method: 'POST', path: withId('/purchased'), handler: branchWrite('emergency_purchased', (tx, scope, params, body) => markPurchased(tx, scope, params.id, body, { now: now() })) },
    { method: 'POST', path: withId('/receive'), handler: branchWrite('emergency_receive', (tx, scope, params, body) => receive(tx, scope, params.id, body, { now: now() })) },
    { method: 'POST', path: withId('/cancel'), handler: branchWrite('emergency_cancel', (tx, scope, params, body) => cancel(tx, scope, params.id, { reason: body.reason, now: now() })) },
    { method: 'POST', path: withId('/evidence'), bodyLimit: BODY_LIMIT, handler: withBody(async ({ request, params, body }) => {
      const ctx = await openBranch(request);
      await guard(ctx, params.id, 'inv.emergency.create');
      return safely(async () => {
        const target = await evidenceTarget(ctx.db, ctx.scope, params.id);
        return upload(ctx.db, ctx.scope, { entityType: 'emergency', entityId: params.id, locationId: target.locationId, file: body.file, storage: store(), restrictToLocationId: ctx.location.id });
      });
    }) },

    // ----- Owner / operations -----
    { method: 'GET', path: owner(), handler: async ({ request, params, url }) => {
      const { db, scope } = await openOwner(request, params);
      const q = url?.searchParams || new URLSearchParams();
      return safely(() => list(db, scope, { ...filters(q), locationId: q.get('locationId') || undefined }));
    } },
    { method: 'GET', path: owner(`/(?<id>${ID})`), handler: async ({ request, params }) => {
      const { db, scope } = await openOwner(request, params);
      return safely(() => get(db, scope, params.id, { storage: store() }));
    } },
    { method: 'POST', path: owner(`/(?<id>${ID})/review`), handler: withBody(async ({ request, params, body }) => {
      const { db, scope, businessId } = await openOwner(request, params);
      const found = await safely(() => locationOf(db, businessId, params.id));
      await authorize(db, scope, 'inv.emergency.approve', { locationId: found.locationId, entity: ENTITY, entityId: params.id });
      return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId, actorId: scope.userId, kind: 'emergency_review' },
        () => review(tx, scope, params.id, { outcome: body.outcome, note: body.note, clawbackNote: body.clawbackNote }, { now: now() }))));
    }) },
  ];
}

export const routes = createRoutes();
