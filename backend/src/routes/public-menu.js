// Owned by the guest menu work: public, read-only menu for live restaurants.
// Also logs a menu scan per open (see logScan), without ever failing or slowing the response.
//
// Speed: the menu is built once per restaurant and cached in memory for 60 seconds (lib/cache.js), already
// serialised (and gzipped on first use). Every owner write that changes what guests see calls
// invalidateMenu(restaurantId), so edits show up on the next request. Scans are still logged on every
// request, before the cached body is served. Responses carry an ETag; If-None-Match gets a 304.
import { HttpError, PreparedJson } from '../lib/http.js';
import { videoOut, withVideoColumns } from '../lib/menu-media.js';
import { dealSummary, hasMerchSchema, loadDeals, resolveDesign } from '../lib/menu-merch.js';
import { menuCache, menuVersion } from '../lib/cache.js';
import { visitorId } from '../lib/operations.js';
import { serviceClient } from '../lib/supabase.js';

const UNAVAILABLE = 'This menu isn’t available.';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UNAVAILABLE_TTL_MS = 30_000;

/* Only these columns ever leave the server. Never owner_id, members, invites or onboarding progress. */
const RESTAURANT_COLUMNS = 'id, name, kind, area, address, opening_hours, phone, logo_url, cover_url, theme, status';
const ITEM_COLUMNS = 'id, category_id, name, description, price, currency, photo_url, position, available';

const restaurantOut = (r) => ({
  id: r.id, name: r.name, kind: r.kind, area: r.area, address: r.address, openingHours: r.opening_hours,
  phone: r.phone, logoUrl: r.logo_url, coverUrl: r.cover_url, theme: r.theme,
});
const categoryOut = (c) => ({ id: c.id, name: c.name });

function must(result) {
  if (result.error) throw result.error;
  return result.data;
}

/** The table number from `?t=`, or null when absent or not a whole number in range. */
function tableParam(url) {
  const raw = url.searchParams.get('t');
  if (!raw || !/^\d{1,3}$/.test(raw.trim())) return null;
  const number = Number(raw.trim());
  return number >= 1 && number <= 999 ? number : null;
}

let lastScanError = 0;
/** Fire-and-forget: records the open (deduped per visitor and table for 30 minutes in SQL). Never throws. */
function logScan(db, restaurantId, tableId, visitor) {
  try {
    db.rpc('log_menu_scan', { p_restaurant: restaurantId, p_table: tableId, p_visitor: visitor })
      .then(({ error }) => {
        // Log at most once a minute (for example before migration 003 is applied).
        if (error && Date.now() - lastScanError > 60_000) { lastScanError = Date.now(); console.error('[menu scans] not logged:', error.code || error.message); }
      }, () => {});
  } catch { /* never let logging affect the menu */ }
}

/** Public shape of a deal (only live deals reach guests). */
const publicDeal = (summary) => ({
  id: summary.id, name: summary.name, description: summary.description, price: summary.price, regularPrice: summary.regularPrice,
  saving: summary.saving, savingPercent: summary.savingPercent, currency: summary.currency, photoUrl: summary.photoUrl,
  photoUrls: summary.photoUrls, startsAt: summary.startsAt, endsAt: summary.endsAt,
  items: summary.items.map(({ itemId, name, quantity, unitPrice, photoUrl }) => ({ itemId, name, quantity, unitPrice, photoUrl })),
});

/** Reads everything guests see in one parallel round of queries. */
async function buildMenu(db, id) {
  const merch = await hasMerchSchema(db);
  const itemColumns = `${await withVideoColumns(db, ITEM_COLUMNS)}${merch ? ', featured, featured_position' : ''}`;
  const [restaurant, categories, items, tables, extras, pairings, deals] = await Promise.all([
    db.from('restaurants').select(`${RESTAURANT_COLUMNS}${merch ? ', menu_design' : ''}`).eq('id', id).maybeSingle().then(must),
    db.from('menu_categories').select('id, name, position').eq('restaurant_id', id).order('position').order('name').then(must),
    db.from('menu_items').select(itemColumns).eq('restaurant_id', id).eq('available', true).order('position').order('name').then(must),
    db.from('restaurant_tables').select('id, number').eq('restaurant_id', id).then(must),
    merch ? db.from('menu_item_extras').select('id, item_id, name, price, position').eq('restaurant_id', id).eq('available', true).order('position').order('name').then(must) : [],
    merch ? db.from('menu_item_pairings').select('item_id, paired_item_id, position').eq('restaurant_id', id).order('position').then(must) : [],
    merch ? loadDeals(db, id) : [],
  ]);
  if (!restaurant || restaurant.status !== 'live') return { unavailable: true };

  // Items follow their category's position, then their own.
  const order = new Map(categories.map((category, index) => [category.id, index]));
  const sorted = items
    .filter((item) => order.has(item.category_id))
    .sort((a, b) => order.get(a.category_id) - order.get(b.category_id) || a.position - b.position);
  const available = new Map(sorted.map((item) => [item.id, item]));

  const extrasByItem = new Map();
  for (const extra of extras) {
    extrasByItem.set(extra.item_id, [...(extrasByItem.get(extra.item_id) || []), { id: extra.id, name: extra.name, price: Number(extra.price) }]);
  }
  const pairsByItem = new Map();
  for (const pair of pairings) {
    if (!available.has(pair.paired_item_id)) continue; // only dishes a guest can add
    pairsByItem.set(pair.item_id, [...(pairsByItem.get(pair.item_id) || []), pair.paired_item_id]);
  }
  const now = Date.now();
  const liveDeals = deals.map(({ deal, components }) => dealSummary(deal, components, available, now))
    .filter((summary) => summary.visibleToGuests).map(publicDeal);
  const featuredItemIds = sorted.filter((item) => item.featured)
    .sort((a, b) => (a.featured_position ?? 0) - (b.featured_position ?? 0)).map((item) => item.id);

  const body = {
    restaurant: restaurantOut(restaurant),
    design: resolveDesign(restaurant.menu_design, { theme: restaurant.theme, categories }),
    categories: categories.map(categoryOut),
    items: sorted.map((i) => ({
      id: i.id, categoryId: i.category_id, name: i.name, description: i.description, price: Number(i.price),
      currency: i.currency, photoUrl: i.photo_url, available: i.available, ...videoOut(i),
      featured: Boolean(i.featured),
      extras: extrasByItem.get(i.id) || [],
      pairedItemIds: (pairsByItem.get(i.id) || []).slice(0, 6),
    })),
    featuredItemIds,
    deals: liveDeals,
  };
  const json = JSON.stringify(body);
  return {
    json,
    tables: new Map(tables.map((table) => [table.number, { id: table.id, number: table.number }])),
    variants: new Map(),
    // Deals start and end on their own: don't serve a cached menu past the next boundary.
    nextChangeAt: deals.reduce((next, { deal }) => {
      for (const at of [deal.starts_at, deal.ends_at]) {
        const t = at ? Date.parse(at) : null;
        if (t && t > now && (!next || t < next)) next = t;
      }
      return next;
    }, null),
  };
}

const pending = new Map();

/** The cached menu for a restaurant, building it at most once at a time. */
async function menuEntry(db, id) {
  const cached = menuCache.get(id);
  if (cached && !(cached.nextChangeAt && cached.nextChangeAt <= Date.now())) return cached;
  if (pending.has(id)) return pending.get(id);
  const version = menuVersion(id);
  const build = buildMenu(db, id).then((entry) => {
    // Skip caching if a write invalidated this menu while it was being read.
    if (version === menuVersion(id)) {
      const ttl = entry.unavailable ? UNAVAILABLE_TTL_MS : Math.max(1000, Math.min(60_000, entry.nextChangeAt ? entry.nextChangeAt - Date.now() : 60_000));
      menuCache.set(id, entry, ttl);
    }
    return entry;
  }).finally(() => pending.delete(id));
  pending.set(id, build);
  return build;
}

/** The serialised body for one table (or none), with the table spliced into the cached JSON. */
function variant(entry, table) {
  const key = table ? table.number : 0;
  let prepared = entry.variants.get(key);
  if (!prepared) {
    const json = table ? `${entry.json.slice(0, -1)},"table":${JSON.stringify(table)}}` : entry.json;
    prepared = new PreparedJson(json);
    entry.variants.set(key, prepared);
  }
  return prepared;
}

const matches = (header, etag) => Boolean(header) && header.split(',').some((tag) => {
  const value = tag.trim();
  return value === '*' || value === etag || value.replace(/^W\//, '') === etag.replace(/^W\//, '');
});

async function publicMenu({ request, response, url, params }) {
  const id = params.restaurantId.toLowerCase();
  const db = serviceClient();
  const entry = await menuEntry(db, id);
  if (entry.unavailable) throw new HttpError(404, UNAVAILABLE);

  const number = tableParam(url);
  const table = number ? entry.tables.get(number) || null : null;
  logScan(db, id, table?.id || null, visitorId(request));

  const prepared = variant(entry, table);
  // Browsers revalidate every time (cheap with the ETag), so owners' edits and scans are never hidden by a cache.
  response.setHeader('Cache-Control', 'public, no-cache');
  response.setHeader('ETag', prepared.etag);
  if (matches(request.headers['if-none-match'], prepared.etag)) {
    response.writeHead(304);
    response.end();
    return undefined;
  }
  return prepared;
}

export const routes = [
  { method: 'GET', path: new RegExp(`^/api/public/menu/(?<restaurantId>${UUID})/?$`), handler: publicMenu },
  // Malformed ids get the same calm 404 as unknown ones, rather than the generic "Not found".
  { method: 'GET', path: /^\/api\/public\/menu(?:\/[^/]*)?\/?$/, handler: () => { throw new HttpError(404, UNAVAILABLE); } },
];
