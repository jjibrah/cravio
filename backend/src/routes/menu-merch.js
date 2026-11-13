// Menu merchandising for owners and managers (migration 004): the menu overview, featured dishes,
// pairings, extras, deals and the guest menu design ("Studio").
// Reads use the caller's RLS client; writes use the service client after managerContext has checked the
// caller manages this restaurant and every referenced row was checked to belong to it.
// Every write drops the restaurant's cached public menu (invalidateMenu), so guests see it at once.
import { HttpError } from '../lib/http.js';
import { invalidateMenu } from '../lib/cache.js';
import { videoOut, withVideoColumns } from '../lib/menu-media.js';
import {
  LIMITS, dealSummary, designOptions, loadDeals, normalizeDesign, requireMerch, resolveDesign, storedDesign,
} from '../lib/menu-merch.js';
import { UUID, check, managerContext, money, must, parseDateParam, withBody } from '../lib/operations.js';
import { mediaUrl, price, text } from '../lib/restaurants.js';
import { serviceClient } from '../lib/supabase.js';

const UUID_RE = new RegExp(`^${UUID}$`);
const DAY_MS = 24 * 60 * 60 * 1000;
const ITEM_PATH = (suffix) => new RegExp(`^/api/restaurant/items/(?<id>${UUID})/${suffix}/?$`);
const EXTRA_PATH = new RegExp(`^/api/restaurant/extras/(?<id>${UUID})/?$`);
const DEAL_PATH = new RegExp(`^/api/restaurant/deals/(?<id>${UUID})/?$`);
const BASE_ITEM_COLUMNS = 'id, category_id, name, description, price, currency, photo_url, position, available, source, featured, featured_position';
const EXTRA_COLUMNS = 'id, item_id, name, price, position, available';

/* ---------- Context and helpers ---------- */

/** Managers only, 004 applied. Writes go through `write`, which invalidates the public menu afterwards. */
async function context(request) {
  const ctx = await managerContext(request);
  await requireMerch(serviceClient());
  return { ...ctx, db: serviceClient() };
}

const write = (handler) => async (args) => {
  const ctx = await context(args.request);
  try {
    return await handler(args, ctx);
  } finally {
    invalidateMenu(ctx.restaurantId);
  }
};

function idList(value, label, { max, min = 0, field = 'ids' } = {}) {
  if (!Array.isArray(value)) throw new HttpError(400, `Send the ${label} as a list of ids.`, { field });
  if (value.length < min) throw new HttpError(400, `Choose at least ${min} ${label}.`, { field });
  if (max !== undefined && value.length > max) throw new HttpError(400, `Choose up to ${max} ${label}.`, { field });
  if (value.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) throw new HttpError(400, `Each of the ${label} must be an id.`, { field });
  const ids = value.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new HttpError(400, `Each of the ${label} can appear only once.`, { field });
  return ids;
}

/** Throws 400 unless every id is a dish of this restaurant. Returns the rows. */
async function requireItems(db, restaurantId, ids, field = 'itemIds') {
  if (!ids.length) return [];
  const rows = must(await db.from('menu_items').select('id, name, price, available, photo_url').eq('restaurant_id', restaurantId).in('id', ids));
  if (rows.length !== ids.length) throw new HttpError(400, 'One of those dishes no longer exists. Refresh and try again.', { field });
  return rows;
}

async function requireItem(db, restaurantId, id) {
  const row = must(await db.from('menu_items').select('id, name').eq('restaurant_id', restaurantId).eq('id', id.toLowerCase()).maybeSingle());
  if (!row) throw new HttpError(404, 'That item no longer exists.');
  return row;
}

const extraOut = (e) => ({ id: e.id, itemId: e.item_id, name: e.name, price: money(e.price), position: e.position, available: e.available });

/** 30-day numbers per dish and deal for the owner's cards: { id -> { views, videoPlays, orderedQuantity, sales } }. */
async function stats30d(client, restaurantId) {
  const now = new Date();
  const { data, error } = await client.rpc('ops_dish_performance', {
    p_restaurant: restaurantId, p_from: new Date(now.getTime() - 30 * DAY_MS).toISOString(), p_to: now.toISOString(),
  });
  if (error) { console.error('[menu] 30-day stats failed:', error.code || error.message); return new Map(); }
  return new Map(data.map((row) => [row.ref_id, {
    views: Number(row.views), videoPlays: Number(row.plays),
    orderedQuantity: Number(row.direct_quantity) + Number(row.deal_quantity),
    sales: money(Number(row.direct_sales) + Number(row.deal_sales)),
  }]));
}
const NO_STATS = { views: 0, videoPlays: 0, orderedQuantity: 0, sales: 0 };

/* ---------- Menu overview ---------- */

async function menuOverview({ request }) {
  const { client, restaurantId } = await context(request);
  const itemColumns = await withVideoColumns(client, BASE_ITEM_COLUMNS);
  const [categories, items, extras, pairings, deals, stats] = await Promise.all([
    client.from('menu_categories').select('id, name, position').eq('restaurant_id', restaurantId).order('position').then((r) => must(r)),
    client.from('menu_items').select(itemColumns).eq('restaurant_id', restaurantId).order('position').order('name').then((r) => must(r)),
    client.from('menu_item_extras').select(EXTRA_COLUMNS).eq('restaurant_id', restaurantId).order('position').order('name').then((r) => must(r)),
    client.from('menu_item_pairings').select('item_id, paired_item_id, position').eq('restaurant_id', restaurantId).order('position').then((r) => must(r)),
    loadDeals(client, restaurantId).catch((error) => check(error)),
    stats30d(client, restaurantId),
  ]);
  const extrasByItem = new Map();
  for (const extra of extras) extrasByItem.set(extra.item_id, [...(extrasByItem.get(extra.item_id) || []), extraOut(extra)]);
  const pairsByItem = new Map();
  for (const pair of pairings) pairsByItem.set(pair.item_id, [...(pairsByItem.get(pair.item_id) || []), pair.paired_item_id]);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const order = new Map(categories.map((c, index) => [c.id, index]));
  const sorted = items.slice().sort((a, b) => (order.get(a.category_id) ?? 99) - (order.get(b.category_id) ?? 99) || a.position - b.position);

  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, position: c.position })),
    items: sorted.map((i) => ({
      id: i.id, categoryId: i.category_id, name: i.name, description: i.description, price: money(i.price), currency: i.currency,
      photoUrl: i.photo_url, position: i.position, available: i.available, source: i.source, ...videoOut(i),
      featured: Boolean(i.featured), featuredPosition: i.featured ? i.featured_position ?? null : null,
      extras: extrasByItem.get(i.id) || [],
      pairedItemIds: pairsByItem.get(i.id) || [],
      stats30d: stats.get(i.id) || NO_STATS,
    })),
    featuredItemIds: items.filter((i) => i.featured).sort((a, b) => (a.featured_position ?? 0) - (b.featured_position ?? 0)).map((i) => i.id),
    deals: deals.map(({ deal, components }) => ({ ...dealSummary(deal, components, itemsById), stats30d: stats.get(deal.id) || NO_STATS })),
    limits: LIMITS,
  };
}

/* ---------- Featured ---------- */

async function setFeatured({ body }, { db, restaurantId }) {
  const ids = idList(body.itemIds, 'featured dishes', { max: LIMITS.featured, field: 'itemIds' });
  await requireItems(db, restaurantId, ids);
  let clear = db.from('menu_items').update({ featured: false, featured_position: null }).eq('restaurant_id', restaurantId).eq('featured', true);
  if (ids.length) clear = clear.not('id', 'in', `(${ids.join(',')})`);
  check((await clear).error);
  for (const result of await Promise.all(ids.map((id, position) => db.from('menu_items')
    .update({ featured: true, featured_position: position }).eq('id', id).eq('restaurant_id', restaurantId)))) check(result.error);
  return { featuredItemIds: ids };
}

/* ---------- Pairings ---------- */

async function pairedIds(db, itemId) {
  return must(await db.from('menu_item_pairings').select('paired_item_id').eq('item_id', itemId).order('position')).map((r) => r.paired_item_id);
}

async function setPairings({ body, params }, { db, restaurantId }) {
  const item = await requireItem(db, restaurantId, params.id);
  const ids = idList(body.itemIds, 'paired dishes', { max: LIMITS.pairingsPerDish, field: 'itemIds' });
  if (ids.includes(item.id)) throw new HttpError(400, 'A dish can’t be paired with itself.', { field: 'itemIds' });
  if (body.mirror !== undefined && typeof body.mirror !== 'boolean') throw new HttpError(400, 'mirror must be true or false.', { field: 'mirror' });
  await requireItems(db, restaurantId, ids);
  check((await db.from('menu_item_pairings').delete().eq('item_id', item.id)).error);
  if (ids.length) {
    check((await db.from('menu_item_pairings').insert(ids.map((paired, position) => ({
      restaurant_id: restaurantId, item_id: item.id, paired_item_id: paired, position,
    })))).error);
  }
  // mirror: also suggest this dish on each paired dish (appended, if that dish has room and doesn't have it yet).
  const mirrored = [];
  if (body.mirror && ids.length) {
    const reverse = must(await db.from('menu_item_pairings').select('item_id, paired_item_id, position').in('item_id', ids));
    for (const target of ids) {
      const theirs = reverse.filter((row) => row.item_id === target);
      if (theirs.some((row) => row.paired_item_id === item.id) || theirs.length >= LIMITS.pairingsPerDish) continue;
      const position = theirs.reduce((max, row) => Math.max(max, row.position), -1) + 1;
      const { error } = await db.from('menu_item_pairings').insert({ restaurant_id: restaurantId, item_id: target, paired_item_id: item.id, position });
      if (!error) mirrored.push(target);
      else if (error.code !== '23505') check(error);
    }
  }
  return { itemId: item.id, pairedItemIds: await pairedIds(db, item.id), mirroredItemIds: mirrored };
}

async function deletePairing({ params }, { db, restaurantId }) {
  const item = await requireItem(db, restaurantId, params.id);
  check((await db.from('menu_item_pairings').delete().eq('item_id', item.id).eq('paired_item_id', params.pairedId.toLowerCase())).error);
}

/* ---------- Extras ---------- */

function extraFields(body, { partial = false } = {}) {
  const fields = {};
  const name = text(body.name, 'the extra’s name', { max: 60, required: !partial });
  if (name !== undefined || !partial) { if (!name) throw new HttpError(400, 'Enter the extra’s name.', { field: 'name' }); fields.name = name; }
  if (body.price !== undefined || !partial) {
    try { fields.price = price(body.price); } catch (error) { throw new HttpError(400, error.message, { field: 'price' }); }
  }
  if (body.available !== undefined) {
    if (typeof body.available !== 'boolean') throw new HttpError(400, 'available must be true or false.', { field: 'available' });
    fields.available = body.available;
  }
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || body.position < 0 || body.position > 1000) throw new HttpError(400, 'Position is invalid.', { field: 'position' });
    fields.position = body.position;
  }
  return fields;
}

async function createExtra({ body, params }, { db, restaurantId }) {
  const item = await requireItem(db, restaurantId, params.id);
  const fields = extraFields(body);
  const existing = must(await db.from('menu_item_extras').select('position').eq('item_id', item.id));
  if (existing.length >= LIMITS.extrasPerDish) throw new HttpError(400, `A dish can have up to ${LIMITS.extrasPerDish} extras.`);
  if (fields.position === undefined) fields.position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
  const row = must(await db.from('menu_item_extras').insert({ ...fields, restaurant_id: restaurantId, item_id: item.id }).select(EXTRA_COLUMNS).single(),
    { duplicate: `${item.name} already has an extra called “${fields.name}”.` });
  return { extra: extraOut(row) };
}

async function updateExtra({ body, params }, { db, restaurantId }) {
  const fields = extraFields(body, { partial: true });
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to save.');
  const row = must(await db.from('menu_item_extras').update(fields).eq('id', params.id.toLowerCase()).eq('restaurant_id', restaurantId)
    .select(EXTRA_COLUMNS).maybeSingle(), { duplicate: `This dish already has an extra called “${fields.name}”.` });
  if (!row) throw new HttpError(404, 'That extra no longer exists.');
  return { extra: extraOut(row) };
}

async function deleteExtra({ params }, { db, restaurantId }) {
  check((await db.from('menu_item_extras').delete().eq('id', params.id.toLowerCase()).eq('restaurant_id', restaurantId)).error);
}

async function orderExtras({ body, params }, { db, restaurantId }) {
  const item = await requireItem(db, restaurantId, params.id);
  const ids = idList(body.ids, 'extras', { max: LIMITS.extrasPerDish });
  const existing = must(await db.from('menu_item_extras').select('id').eq('item_id', item.id));
  const known = new Set(existing.map((row) => row.id));
  if (ids.length !== existing.length || ids.some((id) => !known.has(id))) {
    throw new HttpError(400, 'Send every extra of this dish once, in the new order. Refresh and try again.', { field: 'ids' });
  }
  for (const result of await Promise.all(ids.map((id, position) => db.from('menu_item_extras').update({ position }).eq('id', id)))) check(result.error);
  const rows = must(await db.from('menu_item_extras').select(EXTRA_COLUMNS).eq('item_id', item.id).order('position'));
  return { itemId: item.id, extras: rows.map(extraOut) };
}

/* ---------- Deals ---------- */

function dateField(value, label, { end = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a date like 2026-12-01 or an ISO time.`, { field: label });
  try { return parseDateParam(value, label, { end }).toISOString(); } catch (error) { throw new HttpError(400, error.message, { field: label }); }
}

/** Validates deal fields. `current` is the existing row on PATCH. Returns { fields, components? }. */
function dealFields(body, restaurantId, { partial = false, current = null } = {}) {
  const fields = {};
  const name = text(body.name, 'the deal’s name', { max: 60, required: !partial });
  if (name !== undefined || !partial) { if (!name) throw new HttpError(400, 'Enter the deal’s name.', { field: 'name' }); fields.name = name; }
  const description = text(body.description, 'the description', { max: 200 });
  if (description !== undefined) fields.description = description;
  if (body.price !== undefined || !partial) {
    try { fields.price = price(body.price); } catch (error) { throw new HttpError(400, error.message, { field: 'price' }); }
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be true or false.', { field: 'active' });
    fields.active = body.active;
  }
  const starts = dateField(body.startsAt, 'startsAt');
  if (starts !== undefined) fields.starts_at = starts;
  const ends = dateField(body.endsAt, 'endsAt', { end: true });
  if (ends !== undefined) fields.ends_at = ends;
  const finalStart = fields.starts_at !== undefined ? fields.starts_at : current?.starts_at;
  const finalEnd = fields.ends_at !== undefined ? fields.ends_at : current?.ends_at;
  if (finalStart && finalEnd && Date.parse(finalEnd) <= Date.parse(finalStart)) throw new HttpError(400, 'The deal must end after it starts.', { field: 'endsAt' });
  try {
    const photo = mediaUrl(body.photoUrl, restaurantId, 'the deal photo', 'image', 'deals');
    if (photo !== undefined) fields.photo_url = photo;
  } catch (error) { throw new HttpError(400, error.message, { field: 'photoUrl' }); }
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || body.position < 0 || body.position > 1000) throw new HttpError(400, 'Position is invalid.', { field: 'position' });
    fields.position = body.position;
  }

  let components;
  if (body.items !== undefined || !partial) {
    if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Add the dishes in this deal.', { field: 'items' });
    if (body.items.length > LIMITS.dealComponents) throw new HttpError(400, `A deal can have up to ${LIMITS.dealComponents} different dishes.`, { field: 'items' });
    const seen = new Set();
    components = body.items.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || !UUID_RE.test(entry.itemId || '')) throw new HttpError(400, `Dish ${index + 1} of the deal needs an itemId.`, { field: 'items', index });
      const quantity = entry.quantity === undefined ? 1 : entry.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new HttpError(400, 'Each dish in a deal needs a quantity from 1 to 20.', { field: 'items', index });
      const itemId = entry.itemId.toLowerCase();
      if (seen.has(itemId)) throw new HttpError(400, 'Each dish can appear once in a deal; raise its quantity instead.', { field: 'items', index });
      seen.add(itemId);
      return { item_id: itemId, quantity, position: index };
    });
    if (components.reduce((sum, c) => sum + c.quantity, 0) < 2) throw new HttpError(400, 'A deal needs at least 2 dishes (or one dish with quantity 2).', { field: 'items' });
  }
  return { fields, components };
}

async function dealOut(db, restaurantId, id) {
  const [entry] = await loadDeals(db, restaurantId, [id]).catch((error) => check(error));
  if (!entry) throw new HttpError(404, 'That deal no longer exists.');
  const itemIds = entry.components.map((c) => c.item_id);
  const items = itemIds.length ? must(await db.from('menu_items').select('id, name, price, available, photo_url').in('id', itemIds)) : [];
  return dealSummary(entry.deal, entry.components, new Map(items.map((i) => [i.id, i])));
}

async function saveComponents(db, restaurantId, dealId, components) {
  check((await db.from('menu_deal_items').delete().eq('deal_id', dealId)).error);
  check((await db.from('menu_deal_items').insert(components.map((c) => ({ ...c, deal_id: dealId, restaurant_id: restaurantId })))).error);
}

async function listDeals({ request }) {
  const { client, restaurantId } = await context(request);
  const [deals, items] = await Promise.all([
    loadDeals(client, restaurantId).catch((error) => check(error)),
    client.from('menu_items').select('id, name, price, available, photo_url').eq('restaurant_id', restaurantId).then((r) => must(r)),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  return { deals: deals.map(({ deal, components }) => dealSummary(deal, components, byId)) };
}

async function getDeal({ request, params }) {
  const { client, restaurantId } = await context(request);
  return { deal: await dealOut(client, restaurantId, params.id.toLowerCase()) };
}

async function createDeal({ body }, { db, restaurantId }) {
  const { fields, components } = dealFields(body, restaurantId);
  await requireItems(db, restaurantId, components.map((c) => c.item_id), 'items');
  const existing = must(await db.from('menu_deals').select('position').eq('restaurant_id', restaurantId));
  if (existing.length >= LIMITS.deals) throw new HttpError(400, `You can have up to ${LIMITS.deals} deals.`);
  if (fields.position === undefined) fields.position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
  const deal = must(await db.from('menu_deals').insert({ ...fields, restaurant_id: restaurantId }).select('id').single());
  try {
    await saveComponents(db, restaurantId, deal.id, components);
  } catch (error) {
    await db.from('menu_deals').delete().eq('id', deal.id);
    throw error;
  }
  return { deal: await dealOut(db, restaurantId, deal.id) };
}

async function updateDeal({ body, params }, { db, restaurantId }) {
  const id = params.id.toLowerCase();
  const current = must(await db.from('menu_deals').select('id, starts_at, ends_at').eq('id', id).eq('restaurant_id', restaurantId).maybeSingle());
  if (!current) throw new HttpError(404, 'That deal no longer exists.');
  const { fields, components } = dealFields(body, restaurantId, { partial: true, current });
  if (!Object.keys(fields).length && !components) throw new HttpError(400, 'Nothing to save.');
  if (components) await requireItems(db, restaurantId, components.map((c) => c.item_id), 'items');
  if (Object.keys(fields).length) check((await db.from('menu_deals').update(fields).eq('id', id).eq('restaurant_id', restaurantId)).error);
  if (components) await saveComponents(db, restaurantId, id, components);
  return { deal: await dealOut(db, restaurantId, id) };
}

async function deleteDeal({ params }, { db, restaurantId }) {
  check((await db.from('menu_deals').delete().eq('id', params.id.toLowerCase()).eq('restaurant_id', restaurantId)).error);
}

async function orderDeals({ body }, { db, restaurantId }) {
  const ids = idList(body.ids, 'deals', { max: LIMITS.deals });
  const existing = must(await db.from('menu_deals').select('id').eq('restaurant_id', restaurantId));
  const known = new Set(existing.map((row) => row.id));
  if (ids.length !== existing.length || ids.some((id) => !known.has(id))) throw new HttpError(400, 'Send every deal once, in the new order. Refresh and try again.', { field: 'ids' });
  for (const result of await Promise.all(ids.map((id, position) => db.from('menu_deals').update({ position }).eq('id', id).eq('restaurant_id', restaurantId)))) check(result.error);
  const [deals, items] = await Promise.all([
    loadDeals(db, restaurantId),
    db.from('menu_items').select('id, name, price, available, photo_url').eq('restaurant_id', restaurantId).then((r) => must(r)),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  return { deals: deals.map(({ deal, components }) => dealSummary(deal, components, byId)) };
}

/* ---------- Menu design ---------- */

async function designState(client, restaurantId) {
  const [restaurant, categories] = await Promise.all([
    client.from('restaurants').select('theme, menu_design').eq('id', restaurantId).single().then((r) => must(r)),
    client.from('menu_categories').select('id, name, position').eq('restaurant_id', restaurantId).order('position').then((r) => must(r)),
  ]);
  return {
    design: storedDesign(restaurant.menu_design),
    isDefault: !restaurant.menu_design,
    resolved: resolveDesign(restaurant.menu_design, { theme: restaurant.theme, categories }),
    options: designOptions(),
  };
}

async function getDesign({ request }) {
  const { client, restaurantId } = await context(request);
  return designState(client, restaurantId);
}

async function putDesign({ body }, { db, client, restaurantId }) {
  if (!('design' in body)) throw new HttpError(400, 'Send { design: { … } }, or { design: null } to go back to the defaults.', { field: 'design' });
  const design = body.design === null ? null : normalizeDesign(body.design);
  const update = { menu_design: design, ...(design?.theme ? { theme: design.theme } : {}) };
  check((await db.from('restaurants').update(update).eq('id', restaurantId)).error);
  return designState(client, restaurantId);
}

/* ---------- Routes ---------- */

export const routes = [
  { method: 'GET', path: '/api/restaurant/menu', handler: menuOverview },
  { method: 'PUT', path: '/api/restaurant/featured', handler: withBody(write(setFeatured)) },
  { method: 'PUT', path: ITEM_PATH('pairings'), handler: withBody(write(setPairings)) },
  { method: 'DELETE', path: new RegExp(`^/api/restaurant/items/(?<id>${UUID})/pairings/(?<pairedId>${UUID})/?$`), handler: withBody(write(deletePairing)) },
  { method: 'POST', path: ITEM_PATH('extras'), handler: withBody(write(createExtra)) },
  { method: 'PUT', path: ITEM_PATH('extras/order'), handler: withBody(write(orderExtras)) },
  { method: 'PATCH', path: EXTRA_PATH, handler: withBody(write(updateExtra)) },
  { method: 'DELETE', path: EXTRA_PATH, handler: withBody(write(deleteExtra)) },
  { method: 'GET', path: '/api/restaurant/deals', handler: listDeals },
  { method: 'POST', path: '/api/restaurant/deals', handler: withBody(write(createDeal)) },
  { method: 'PUT', path: '/api/restaurant/deals/order', handler: withBody(write(orderDeals)) },
  { method: 'GET', path: DEAL_PATH, handler: getDeal },
  { method: 'PATCH', path: DEAL_PATH, handler: withBody(write(updateDeal)) },
  { method: 'DELETE', path: DEAL_PATH, handler: withBody(write(deleteDeal)) },
  { method: 'GET', path: '/api/restaurant/menu-design', handler: getDesign },
  { method: 'PUT', path: '/api/restaurant/menu-design', handler: withBody(write(putDesign)) },
];
