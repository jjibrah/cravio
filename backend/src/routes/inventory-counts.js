// Stock counts API (P3-08, migration 020): full, cycle and spot counts, blind option, several counters, recount, review, one approval per session.
//   Branch side (X-Cravio-Branch names the branch; a manager of branch A is refused at branch B):
//     GET  /api/inventory/counts                       this branch's counts (?status=a,b &type= &limit= &before=)
//     GET  /api/inventory/counts/suggest               cycle-count suggestions (?n=20 &by=oldest|value)
//     POST /api/inventory/counts                       { type: full|cycle|spot, blind?, categoryIds?, itemIds?, zone?, note?, start? (default true), commandId? }
//     POST /api/inventory/counts/spot                  { items: [{ itemId, quantity, unit? }], note?, confirmLarge?, commandId? }  one-shot spot count
//     GET  /api/inventory/counts/:id                   header: status, progress, review totals, approval (never a line's expected number)
//     GET  /api/inventory/counts/:id/sheet             the counter's sheet (a BLIND count has no expected number, variance or other counter's entry anywhere)
//     POST /api/inventory/counts/:id/start             the snapshot (when created with start: false)
//     POST /api/inventory/counts/:id/entries           { lineId | itemId, quantity, unit?, note?, confirmLarge?, commandId? }  append-only
//     POST /api/inventory/counts/:id/finish            { skips?: [{ itemId, reason }], skipRemaining?: 'reason' }  -> under review
//     GET  /api/inventory/counts/:id/review            reviewer's table (expected, entries, movements since, difference, KES); not before counting is finished
//     POST /api/inventory/counts/:id/recount           { lineId | itemId, note? }
//     POST /api/inventory/counts/:id/choose            { lineId | itemId, entryId }  which counter's number applies
//     POST /api/inventory/counts/:id/submit            freezes the numbers; posts (no difference / within the owner's limits) or asks for ONE approval
//     POST /api/inventory/counts/:id/cancel            { note? }
//     GET  /api/inventory/counts/:id/report            the variance report (per line, KES, totals, % of stock value)
//   Owner / operations (base /api/owner/inventory/:businessId): the same paths without the /api/inventory prefix, with ?locationId= on reads and a locationId in the body of creates.
//   The decision itself (approve / reject) happens in the Approvals inbox (/approvals/:id/decide, capability inv.count.approve); the engine calls the counts service.
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
import * as counts from '../inventory/counts.js';

const ID = '[0-9a-fA-F-]{36}';
const MISSING_SCHEMA = new HttpError(503, 'Stock counts need database updates 012 to 020, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
const ENTITY = 'count';

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }), now = () => new Date() } = {}) {
  counts.ensureCountApprovals();
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };
  const without = (body) => { const { commandId, ...rest } = body || {}; void commandId; return rest; };

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
  /* ----- owner ----- */
  async function openOwner(request, params) {
    const context = await authenticate(request);
    const db = pool();
    const scope = await safely(() => inventoryScope(db, context, String(params.businessId).toLowerCase()));
    await safely(() => authorize(db, scope, 'inv.view', { entity: ENTITY }));
    if (!scope.roles.includes('owner') && !scope.roles.includes('operations')) throw await denyAndAudit(db, scope, 'inv.view', { entity: ENTITY });
    return { db, scope, businessId: scope.businessId, location: null, restaurantId: null };
  }

  /** open(): the caller's context (branch or owner). `where(ctx, body|query)` is the location an action without a count id is for. */
  const side = (kind) => (kind === 'branch' ? openBranch : openOwner);
  const base = { branch: '/api/inventory', owner: `/api/owner/inventory/(?<businessId>${ID})` };
  const pathOf = (kind, suffix) => new RegExp(`^${base[kind]}${suffix}$`);

  /** Authorizes `capability` at the count's own place, and for a branch refuses a count that belongs to another place. Runs BEFORE any transaction. */
  async function guardCount(ctx, kind, id, capability) {
    const found = await safely(() => counts.locationOf(ctx.db, ctx.businessId, id));
    if (kind === 'branch' && found.locationId !== ctx.location.id) {
      throw await denyAndAudit(ctx.db, ctx.scope, capability, { locationId: found.locationId, entity: ENTITY, entityId: id, error: NO_BRANCH() });
    }
    await authorize(ctx.db, ctx.scope, capability, { locationId: found.locationId, entity: ENTITY, entityId: id });
    return found;
  }
  const touch = (ctx, locationId) => {
    const place = ctx.scope.locations.find((l) => l.id === locationId);
    if (place?.restaurantId) invalidateMenu(place.restaurantId);        // a posted count changes what can be sold
  };
  const query = (url) => url?.searchParams || new URLSearchParams();

  const routes = [];
  for (const kind of ['branch', 'owner']) {
    const open = side(kind);
    const at = (ctx, input) => (kind === 'branch' ? ctx.location.id : String(input?.locationId || '').toLowerCase() || null);
    const read = (suffix, capability, fn) => routes.push({ method: 'GET', path: pathOf(kind, suffix), handler: async ({ request, params, url }) => {
      const ctx = await open(request, params);
      if (params.id) await guardCount(ctx, kind, params.id, capability);
      else await authorize(ctx.db, ctx.scope, capability, { locationId: kind === 'branch' ? ctx.location.id : (query(url).get('locationId') || null), entity: ENTITY });
      return safely(() => fn(ctx, params, query(url)));
    } });
    const write = (suffix, action, fn, { capability = 'inv.count.run', touches = true } = {}) => routes.push({ method: 'POST', path: pathOf(kind, suffix), handler: withBody(async ({ request, params, body }) => {
      const ctx = await open(request, params);
      let locationId;
      if (params.id) locationId = (await guardCount(ctx, kind, params.id, capability)).locationId;
      else { locationId = at(ctx, body); await authorize(ctx.db, ctx.scope, capability, { locationId, entity: ENTITY }); }
      const result = await safely(() => transact((t) => once(t, { commandId: body?.commandId, businessId: ctx.businessId, actorId: ctx.scope.userId, kind: `count_${action}` }, () => fn(t, ctx, params, body || {}, locationId))));
      if (touches) touch(ctx, locationId);
      return result;
    }) });

    read('/counts', 'inv.view', (ctx, _p, q) => counts.list(ctx.db, ctx.scope, { locationId: kind === 'branch' ? ctx.location.id : q.get('locationId') || undefined, status: q.get('status') || undefined,
      type: q.get('type') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined }));
    read('/counts/suggest', 'inv.count.run', (ctx, _p, q) => counts.suggestCycle(ctx.db, ctx.scope, kind === 'branch' ? ctx.location.id : q.get('locationId'), { n: q.get('n') || 20, by: q.get('by') || 'oldest' }));
    write('/counts', 'create', (t, ctx, _p, body, locationId) => counts.create(t, ctx.scope, { ...without(body), locationId, commandId: body.commandId }, { now: now() }), { touches: false });
    write('/counts/spot', 'spot', (t, ctx, _p, body, locationId) => counts.spotCount(t, ctx.scope, { ...without(body), locationId, commandId: body.commandId }, { now: now() }));
    read(`/counts/(?<id>${ID})`, 'inv.view', (ctx, p) => counts.get(ctx.db, ctx.scope, p.id));
    read(`/counts/(?<id>${ID})/sheet`, 'inv.count.run', (ctx, p) => counts.sheet(ctx.db, ctx.scope, p.id));
    read(`/counts/(?<id>${ID})/review`, 'inv.count.run', (ctx, p) => counts.review(ctx.db, ctx.scope, p.id));
    read(`/counts/(?<id>${ID})/report`, 'inv.view', (ctx, p) => counts.report(ctx.db, ctx.scope, p.id));
    write(`/counts/(?<id>${ID})/start`, 'start', (t, ctx, p) => counts.start(t, ctx.scope, p.id, { now: now() }), { touches: false });
    write(`/counts/(?<id>${ID})/entries`, 'entry', (t, ctx, p, body) => counts.enterCount(t, ctx.scope, p.id, without(body), { now: now() }), { touches: false });
    write(`/counts/(?<id>${ID})/finish`, 'finish', (t, ctx, p, body) => counts.finishCounting(t, ctx.scope, p.id, without(body), { now: now() }), { touches: false });
    write(`/counts/(?<id>${ID})/recount`, 'recount', (t, ctx, p, body) => counts.requestRecount(t, ctx.scope, p.id, without(body)), { touches: false });
    write(`/counts/(?<id>${ID})/choose`, 'choose', (t, ctx, p, body) => counts.chooseEntry(t, ctx.scope, p.id, without(body)), { touches: false });
    write(`/counts/(?<id>${ID})/submit`, 'submit', (t, ctx, p) => counts.submitReview(t, ctx.scope, p.id, { now: now() }));
    write(`/counts/(?<id>${ID})/cancel`, 'cancel', (t, ctx, p, body) => counts.cancel(t, ctx.scope, p.id, { note: body.note, now: now() }), { touches: false });
  }
  return routes;
}

export const routes = createRoutes();
