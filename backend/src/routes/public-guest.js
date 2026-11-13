// Public guest actions (no sign-in): "Ready to order" (save the cart and ask for a waiter), follow that cart until a
// waiter confirms it, and call the waiter / ask for the bill. Guests never create orders: the waiter confirms
// the order with the guest at the table (docs/ORDER-FLOW.md). Writes use the service client after validating
// the restaurant is live.
import { HttpError } from '../lib/http.js';
import {
  CART_TTL_MS, REQUEST_TYPES, cartQrValue, check, cleanCartCode, clientAddress, findTable, hasConfirmationSchema, isUuid, iso,
  must, namesFor, newCartCode, priceLines, rateLimit, requestOut, tableNumber, visitorId, withBody,
} from '../lib/operations.js';
import { serviceClient } from '../lib/supabase.js';

const UNAVAILABLE = 'This menu isn’t available.';
const TEN_MINUTES = 10 * 60 * 1000;

async function liveRestaurant(db, restaurantId) {
  if (!isUuid(restaurantId)) throw new HttpError(404, UNAVAILABLE);
  const restaurant = must(await db.from('restaurants').select('id, status').eq('id', restaurantId.toLowerCase()).maybeSingle());
  if (!restaurant || restaurant.status !== 'live') throw new HttpError(404, UNAVAILABLE);
  return restaurant;
}

/** Per visitor (or, without a visitor id, per connection) and per table. In memory: see lib/operations.js. */
function limitGuest(kind, request, restaurantId, table) {
  const visitor = visitorId(request);
  rateLimit([
    { key: `${kind}:v:${visitor || `ip:${clientAddress(request)}`}`, limit: 10, windowMs: TEN_MINUTES },
    ...(table ? [{ key: `${kind}:t:${restaurantId}:${table}`, limit: 20, windowMs: TEN_MINUTES }] : []),
  ]);
  return visitor;
}

function cartOut(cart, lines, total, table, readyAt) {
  return {
    code: cart.code,
    status: 'ready',
    readyAt: iso(readyAt),
    expiresAt: iso(cart.expires_at),
    table: table ? { id: table.id, number: table.number } : null,
    items: lines,
    total,
    currency: 'KES',
    qrValue: cartQrValue(cart.code),
  };
}

let lastPurge = 0;
/** Expired carts that nobody claimed are deleted a day later. Fire-and-forget, at most every 10 minutes. */
function purgeOldCarts(db) {
  if (Date.now() - lastPurge < TEN_MINUTES) return;
  lastPurge = Date.now();
  db.from('guest_carts').delete().is('claimed_at', null).lt('expires_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .then(({ error }) => { if (error) console.error('[guest carts] purge failed:', error.code || error.message); }, () => {});
}

async function insertCart(db, row) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCartCode();
    const { data, error } = await db.from('guest_carts').insert({ ...row, code }).select('id, code, expires_at').single();
    if (!error) return data;
    if (error.code !== '23505') check(error);
    // The code belongs to an unclaimed cart. If that cart has expired, free the code for next time.
    await db.from('guest_carts').delete().eq('code', code).is('claimed_at', null).lt('expires_at', new Date().toISOString());
  }
  throw new HttpError(503, 'We couldn’t save your order just now. Please try again.');
}

async function saveCart({ request, body }) {
  const db = serviceClient();
  const restaurant = await liveRestaurant(db, body.restaurantId);
  const number = tableNumber(body.tableNumber, { required: false });
  const visitor = limitGuest('cart', request, restaurant.id, number);
  const table = number ? await findTable(db, restaurant.id, number) : null;
  const { lines, stored: items, subtotal } = await priceLines(db, restaurant.id, body.items, { maxLines: 30, maxQuantity: 20 });
  const expiresAt = new Date(Date.now() + CART_TTL_MS).toISOString();
  // Saving is "Ready to order": it marks the cart ready, which puts "Table 7 is ready to order" on the staff screens.
  const readyAt = new Date().toISOString();
  const ready = (await hasConfirmationSchema(db)) ? { ready_at: readyAt } : {};
  purgeOldCarts(db);

  const code = body.code === undefined || body.code === null || body.code === '' ? null : cleanCartCode(body.code);
  if (body.code && !code) throw new HttpError(400, 'That cart code isn’t valid.', { field: 'code' });
  if (code) {
    const existing = must(await db.from('guest_carts').select('id, code, restaurant_id, table_id, visitor_id, expires_at, claimed_at')
      .eq('code', code).eq('restaurant_id', restaurant.id).order('created_at', { ascending: false }).limit(1).maybeSingle());
    const mine = existing && (!existing.visitor_id || existing.visitor_id === visitor);
    if (mine && existing.claimed_at) {
      throw new HttpError(409, 'Your waiter has already entered this order. Start a new one to add more.', { reason: 'claimed' });
    }
    if (mine && new Date(existing.expires_at) > new Date()) {
      const update = { items, expires_at: expiresAt, ...ready, ...(table ? { table_id: table.id } : {}) };
      const { data, error } = await db.from('guest_carts').update(update).eq('id', existing.id).is('claimed_at', null)
        .select('id, code, expires_at, table_id').maybeSingle();
      check(error);
      if (!data) throw new HttpError(409, 'Your waiter has already entered this order. Start a new one to add more.', { reason: 'claimed' });
      const savedTable = table || (data.table_id ? must(await db.from('restaurant_tables').select('id, number').eq('id', data.table_id).maybeSingle()) : null);
      return cartOut(data, lines, subtotal, savedTable, readyAt);
    }
    // Unknown, expired, or someone else's code: fall through and start a fresh cart with a new code.
  }

  const cart = await insertCart(db, {
    restaurant_id: restaurant.id, table_id: table?.id || null, items, visitor_id: visitor, expires_at: expiresAt, ...ready,
  });
  return cartOut(cart, lines, subtotal, table, readyAt);
}

/**
 * GET /api/public/carts/:code/status?restaurantId=… — the guest's phone polls this (about every 5 s) after
 * "Ready to order", to show "Order confirmed ✓" once a waiter confirms it. Only the phone that saved the cart
 * (same X-Cravio-Visitor) can read it; anyone else gets 404, as for an unknown code.
 */
async function cartStatus({ request, params, url }) {
  const restaurantId = url.searchParams.get('restaurantId');
  if (!isUuid(restaurantId)) throw new HttpError(400, 'restaurantId is required.', { field: 'restaurantId' });
  const visitor = visitorId(request);
  if (!visitor) throw new HttpError(400, 'Send the X-Cravio-Visitor header.', { field: 'X-Cravio-Visitor' });
  const code = cleanCartCode(params.code);
  if (!code) throw new HttpError(400, 'That cart code isn’t valid.', { field: 'code' });
  rateLimit([{ key: `cart-status:v:${visitor}`, limit: 300, windowMs: TEN_MINUTES }], 'Too many checks. Please wait a minute.');

  const db = serviceClient();
  const cart = must(await db.from('guest_carts').select('id, code, expires_at, claimed_at, claimed_by, claimed_order_id')
    .eq('code', code).eq('restaurant_id', restaurantId.toLowerCase()).eq('visitor_id', visitor)
    .order('created_at', { ascending: false }).limit(1).maybeSingle());
  if (!cart) throw new HttpError(404, 'We couldn’t find that code. Tap Ready to order again.');

  // Claimed and the order saved: confirmed. (Claimed without an order yet means the waiter is saving it right now.)
  if (cart.claimed_at && cart.claimed_order_id) {
    const names = await namesFor(db, [cart.claimed_by]);
    const name = cart.claimed_by ? names.get(cart.claimed_by) : null;
    return {
      status: 'confirmed',
      confirmedBy: name ? String(name).trim().split(/\s+/)[0] : null,
      confirmedAt: iso(cart.claimed_at),
      orderShortId: cart.claimed_order_id.slice(0, 6),
    };
  }
  if (!cart.claimed_at && new Date(cart.expires_at) <= new Date()) return { status: 'expired', expiresAt: iso(cart.expires_at) };
  return { status: 'ready', expiresAt: iso(cart.expires_at) };
}

async function createRequest({ request, body }) {
  const db = serviceClient();
  const restaurant = await liveRestaurant(db, body.restaurantId);
  const number = tableNumber(body.tableNumber);
  if (!REQUEST_TYPES.includes(body.type)) throw new HttpError(400, 'Choose call_waiter, bill or payment.', { field: 'type' });
  limitGuest('request', request, restaurant.id, number);
  const table = await findTable(db, restaurant.id, number);
  const columns = 'id, table_id, type, status, created_at, acknowledged_at, resolved_at';

  const { data, error } = await db.from('service_requests')
    .insert({ restaurant_id: restaurant.id, table_id: table.id, type: body.type }).select(columns).single();
  if (!error) return { request: guestRequestOut(data), deduped: false };
  if (error.code !== '23505') check(error);
  // Already open or acknowledged for this table and type: return that one.
  const existing = must(await db.from('service_requests').select(columns)
    .eq('table_id', table.id).eq('type', body.type).in('status', ['open', 'acknowledged']).maybeSingle());
  if (!existing) throw new HttpError(503, 'We couldn’t send that just now. Please try again.');
  return { request: guestRequestOut(existing), deduped: true };
}

function guestRequestOut(row) {
  const { id, type, typeLabel, status, createdAt, acknowledgedAt } = requestOut(row, null);
  return { id, type, typeLabel, status, createdAt, acknowledgedAt };
}

async function listRequests({ url }) {
  const db = serviceClient();
  const restaurant = await liveRestaurant(db, url.searchParams.get('restaurantId'));
  const number = tableNumber(url.searchParams.get('tableNumber'));
  const table = await findTable(db, restaurant.id, number);
  const rows = must(await db.from('service_requests').select('id, table_id, type, status, created_at, acknowledged_at, resolved_at')
    .eq('table_id', table.id).in('status', ['open', 'acknowledged']).order('created_at'));
  return { table: { id: table.id, number: table.number }, requests: rows.map(guestRequestOut) };
}

/* ---------- Menu events: dish views, video plays, deal views ---------- */

const EVENT_TYPES = ['dish_view', 'video_play', 'deal_view'];
const MAX_EVENTS = 50;
let lastEventError = 0;

/**
 * Validates a batch and answers 202 at once; the events are written in the background (deduped in SQL per
 * visitor, type and dish/deal for 10 minutes). Invalid individual events are dropped, not rejected, so a
 * guest's phone is never blocked by analytics.
 */
async function logEvents({ request, response, body }) {
  if (!isUuid(body.restaurantId)) throw new HttpError(400, 'restaurantId is required.', { field: 'restaurantId' });
  if (!Array.isArray(body.events)) throw new HttpError(400, 'Send events as a list.', { field: 'events' });
  if (body.events.length > MAX_EVENTS) throw new HttpError(400, `Send up to ${MAX_EVENTS} events at a time.`, { field: 'events' });
  let number = null;
  try { number = tableNumber(body.tableNumber, { required: false }); } catch { number = null; }
  const visitor = visitorId(request);
  rateLimit([{ key: `events:v:${visitor || `ip:${clientAddress(request)}`}`, limit: 60, windowMs: TEN_MINUTES }],
    'Too many events. Please slow down.');

  const now = Date.now();
  const events = [];
  for (const event of body.events) {
    if (!event || typeof event !== 'object' || !EVENT_TYPES.includes(event.type)) continue;
    const isDeal = event.type === 'deal_view';
    const target = isDeal ? event.dealId : event.itemId;
    if (!isUuid(target)) continue;
    let at = now;
    if (event.at !== undefined && event.at !== null) {
      const parsed = Date.parse(event.at);
      // Accept client times from the last 24 hours (phones batch while offline); otherwise use the server's.
      if (Number.isFinite(parsed) && parsed <= now + 60_000 && parsed >= now - 24 * 3600_000) at = Math.min(parsed, now);
    }
    events.push({ type: event.type, item_id: isDeal ? null : target.toLowerCase(), deal_id: isDeal ? target.toLowerCase() : null, at: new Date(at).toISOString() });
  }

  if (events.length) {
    try {
      serviceClient().rpc('log_menu_events', {
        p_restaurant: body.restaurantId.toLowerCase(), p_table_number: number, p_visitor: visitor, p_events: events,
      }).then(({ error }) => {
        // Log at most once a minute (for example before migration 004 is applied).
        if (error && Date.now() - lastEventError > 60_000) { lastEventError = Date.now(); console.error('[menu events] not logged:', error.code || error.message); }
      }, () => {});
    } catch { /* never let analytics affect the guest */ }
  }
  response.statusCode = 202;
  return { accepted: events.length, dropped: body.events.length - events.length };
}

export const routes = [
  { method: 'POST', path: '/api/public/events', handler: withBody(logEvents) },
  { method: 'POST', path: '/api/public/carts', handler: withBody(saveCart) },
  { method: 'GET', path: /^\/api\/public\/carts\/(?<code>[A-Za-z0-9-]{1,16})\/status\/?$/, handler: cartStatus },
  { method: 'POST', path: '/api/public/requests', handler: withBody(createRequest) },
  { method: 'GET', path: '/api/public/requests', handler: listRequests },
];
