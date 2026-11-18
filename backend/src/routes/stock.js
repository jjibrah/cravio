// Inventory API (migration 009; units, packs and recipes from 012).
//   /api/stock/*        – the branch named by X-Cravio-Branch; branch managers act, waiters read availability.
//   /api/owner/stock/*  – the main center and requests of a business; business owners act, operations view.
// The caller's access is checked here (membership / business grant) and again inside src/stock/service.js
// (records must belong to that branch or business). Writes run in one transaction; pass commandId to make a
// retried write return its first result instead of repeating.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { invalidateMenu } from '../lib/cache.js';
import { withDb } from '../lib/db.js';
import { MANAGER_ROLES } from '../lib/access.js';
import { managerContext, staffContext, withBody } from '../lib/operations.js';
import {
  adjust, availability, branchLocation, branchSnapshot, businessSnapshot, cancelDispatch, cancelRequest, centerLocation,
  correctOrder, createItem, dispatch, findByCode, linkMenuItem, once, receive, reviewRequest, submitRequest, updateItem,
} from '../stock/service.js';
import { saveRecipe, suggestionInput } from '../stock/recipes.js';
import { suggestLegacy } from '../ai/legacy-recipe.js';
import { database } from '../lib/pool.js';

const ID = '[0-9a-fA-F-]{36}';
const stockDb = (fn, transaction = true) => withDb(fn, { transaction, feature: 'stock' });

async function branch(request) {
  const context = await managerContext(request);
  return context;
}

/** Runs a branch write: resolves the branch's business and stock location inside the transaction. */
function branchWrite(kind, fn, { menuChanges = true } = {}) {
  return withBody(async ({ request, params, body }) => {
    const { restaurantId, user } = await branch(request);
    const result = await stockDb(async (db) => {
      const { rows } = await db.query('select business_id from public.restaurants where id = $1', [restaurantId]);
      const ctx = { businessId: rows[0].business_id, restaurantId, actorId: user.id, locationId: await branchLocation(db, restaurantId) };
      return once(db, { commandId: body.commandId, businessId: ctx.businessId, actorId: user.id, kind }, () => fn(db, ctx, params, body));
    });
    if (menuChanges) invalidateMenu(restaurantId);
    return result;
  });
}

/** The business an owner/operations user acts on, with their role in it. */
async function business(request, businessId, { write = false } = {}) {
  const context = await requireUser(request);
  if (context.grants === undefined) throw new HttpError(503, 'The owner interface needs database update 008, which hasn’t been applied yet.', { code: 'business_schema_missing' });
  const grant = (context.grants || []).find((g) => g.businessId === String(businessId).toLowerCase());
  if (!grant) throw new HttpError(404, 'That business isn’t yours.');
  if (write && grant.role !== 'owner') throw new HttpError(403, 'Only the business owner can do this.');
  return { ...context, grant };
}

function ownerWrite(kind, fn) {
  return withBody(async ({ request, params, body }) => {
    const { user } = await business(request, params.businessId, { write: true });
    const businessId = params.businessId.toLowerCase();
    const result = await stockDb((db) => once(db, { commandId: body.commandId, businessId, actorId: user.id, kind },
      () => fn(db, { businessId, actorId: user.id }, params, body)));
    if (result?.restaurantId) invalidateMenu(result.restaurantId);
    return result;
  });
}

export const routes = [
  // ----- Branch -----
  { method: 'GET', path: '/api/stock', async handler({ request }) {
    const { restaurantId } = await branch(request);
    return stockDb((db) => branchSnapshot(db, restaurantId), false);
  } },
  { method: 'GET', path: '/api/stock/availability', async handler({ request }) {
    const { restaurantId } = await staffContext(request);
    return { items: await stockDb((db) => availability(db, restaurantId), false) };
  } },
  { method: 'POST', path: '/api/stock/items', handler: branchWrite('item', (db, ctx, _p, body) => createItem(db, ctx, body), { menuChanges: false }) },
  { method: 'POST', path: '/api/stock/adjust', handler: branchWrite('adjust', (db, ctx, _p, body) => adjust(db, ctx, body)) },
  { method: 'PATCH', path: new RegExp(`^/api/stock/items/(?<id>${ID})$`), handler: branchWrite('item_edit', (db, ctx, params, body) => updateItem(db, ctx, params.id, body)) },
  // Recipes: several ingredients per dish, any compatible unit. Saving replaces the dish's single link.
  { method: 'PUT', path: new RegExp(`^/api/stock/recipes/(?<id>${ID})$`), handler: branchWrite('recipe', (db, ctx, params, body) => saveRecipe(db, ctx, params.id, body)) },
  // AI draft of a recipe (OpenRouter). Returns a draft only; nothing is saved. 503 when OPENROUTER_API_KEY isn't set.
  { method: 'POST', path: '/api/stock/recipes/suggest', handler: withBody(async ({ request, body }) => {
    const { restaurantId, user } = await branch(request);
    let businessId;
    const input = await stockDb(async (db) => {
      const { rows } = await db.query('select business_id from public.restaurants where id = $1', [restaurantId]);
      businessId = rows[0].business_id;
      return suggestionInput(db, { businessId, restaurantId }, String(body.menuItemId || ''));
    }, false);
    // Metered and limited like every AI call (ai/gateway.js): no allowance row = off.
    return suggestLegacy(database(), { businessId, actorId: user?.id || null }, input);
  }) },
  { method: 'PUT', path: new RegExp(`^/api/stock/links/(?<id>${ID})$`), handler: branchWrite('link', (db, ctx, params, body) => linkMenuItem(db, ctx, params.id, body)) },
  { method: 'POST', path: new RegExp(`^/api/stock/orders/(?<id>${ID})/correction$`), handler: branchWrite('correction', (db, ctx, params, body) => correctOrder(db, ctx, params.id, body)) },
  { method: 'POST', path: '/api/stock/requests', handler: branchWrite('request', (db, ctx, _p, body) => submitRequest(db, ctx, body), { menuChanges: false }) },
  { method: 'POST', path: new RegExp(`^/api/stock/requests/(?<id>${ID})/cancel$`), handler: branchWrite('request_cancel', (db, ctx, params) => cancelRequest(db, ctx, params.id), { menuChanges: false }) },
  { method: 'POST', path: new RegExp(`^/api/stock/transfers/(?<id>${ID})/receive$`), handler: branchWrite('receive', (db, ctx, params, body) => receive(db, ctx, params.id, body)) },
  // A dispatch code (typed or scanned from the QR) → which of the caller's branches it is going to.
  { method: 'GET', path: /^\/api\/stock\/receive\/(?<code>[A-Za-z0-9]{1,20})$/, async handler({ request, params }) {
    const { memberships } = await requireUser(request);
    const managed = (memberships || []).filter((row) => row.restaurant && MANAGER_ROLES.includes(row.role)).map((row) => row.restaurant.id);
    if (!managed.length) throw new HttpError(403, 'Only branch managers receive dispatches.');
    return stockDb((db) => findByCode(db, params.code, managed), false);
  } },

  // ----- Owner / main center -----
  { method: 'GET', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})$`), async handler({ request, params }) {
    const { grant } = await business(request, params.businessId);
    const snapshot = await stockDb((db) => businessSnapshot(db, grant.businessId), false);
    if (grant.role === 'owner') return { ...snapshot, role: 'owner' };
    // Operations managers see only their assigned branches.
    const mine = new Set(grant.branchIds || []);
    return { ...snapshot, role: grant.role,
      branches: snapshot.branches.filter((b) => mine.has(b.id)),
      items: snapshot.items.map((item) => ({ ...item, branches: Object.fromEntries(Object.entries(item.branches).filter(([id]) => mine.has(id))) })),
      requests: snapshot.requests.filter((r) => mine.has(r.branchId)), transfers: snapshot.transfers.filter((t) => mine.has(t.branchId)) };
  } },
  { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/items$`), handler: ownerWrite('item', (db, ctx, _p, body) => createItem(db, ctx, body)) },
  { method: 'PATCH', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/items/(?<id>${ID})$`), handler: ownerWrite('item_edit', (db, ctx, params, body) => updateItem(db, ctx, params.id, body)) },
  { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/adjust$`), handler: ownerWrite('adjust', async (db, ctx, _p, body) => adjust(db, { ...ctx, locationId: await centerLocation(db, ctx.businessId) }, body)) },
  { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/requests/(?<id>${ID})/review$`), handler: ownerWrite('review', (db, ctx, params, body) => reviewRequest(db, ctx, params.id, body)) },
  { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/dispatches$`), handler: ownerWrite('dispatch', (db, ctx, _p, body) => dispatch(db, ctx, body)) },
  { method: 'POST', path: new RegExp(`^/api/owner/stock/(?<businessId>${ID})/dispatches/(?<id>${ID})/cancel$`), handler: ownerWrite('dispatch_cancel', (db, ctx, params) => cancelDispatch(db, ctx, params.id)) },
];
