// Public table sessions (proposed migration 011, docs/v2/TABLE-SESSIONS.md): everyone at a table orders from one
// shared cart. Scanning opens the table's session or asks for its 4-digit join code; members poll the session, change
// the cart line by line and tap "Ready to order", which saves one guest cart for the waiter to scan (the gate stays).
// Before 011 is applied (or without a server database connection) every call answers { available: false } and the
// guest's phone keeps today's per-phone cart.
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { hasConfirmationSchema, findTable, isUuid, priceLines, rateLimit, tableNumber, visitorId, withBody } from '../lib/operations.js';
import { serviceClient } from '../lib/supabase.js';
import { applyOp, getSession, join, leave, openOrGet, ready, sessionsAvailable } from '../lib/table-sessions.js';
import { limitGuest, liveRestaurant } from './public-guest.js';

const TEN_MINUTES = 10 * 60 * 1000;
const UNAVAILABLE = { available: false };
const SESSION_PATH = (action = '') => new RegExp(`^/api/public/table-sessions/(?<id>[0-9a-fA-F-]{36})${action ? `/${action}` : ''}/?$`);

/** Runs fn on the server database when 011 is there; otherwise returns { available: false }. */
async function sessions(fn) {
  let available = false;
  try { available = await withDb((pg) => sessionsAvailable(pg)); } catch { available = false; }
  if (!available) return UNAVAILABLE;
  return { available: true, ...(await withDb(fn, { transaction: false, feature: 'business' })) };
}

function needVisitor(request) {
  const visitor = visitorId(request);
  if (!visitor) throw new HttpError(400, 'Send the X-Cravio-Visitor header.', { field: 'X-Cravio-Visitor' });
  return visitor;
}

async function tableOf(body) {
  const db = serviceClient();
  const restaurant = await liveRestaurant(db, body.restaurantId);
  const number = tableNumber(body.tableNumber);
  return { db, restaurant, table: await findTable(db, restaurant.id, number) };
}

const pricer = (db, restaurantId) => (raw) => priceLines(db, restaurantId, raw, { maxLines: 30, maxQuantity: 20 });

/** POST /api/public/table-sessions { restaurantId, tableNumber, name? } — scanning the table. */
async function open({ request, body }) {
  const visitor = needVisitor(request);
  const { restaurant, table } = await tableOf(body);
  limitGuest('table-open', request, restaurant.id, table.number, { visitorLimit: 60, tableLimit: 200 });
  return sessions((pg) => openOrGet(pg, { restaurantId: restaurant.id, table, visitor, name: body.name }));
}

/** POST /api/public/table-sessions/join { restaurantId, tableNumber, code, name? } */
async function joinTable({ request, body }) {
  const visitor = needVisitor(request);
  const { restaurant, table } = await tableOf(body);
  // Per phone, in memory; the per-table lock (5 wrong codes → 10 minutes) is kept in the database.
  rateLimit([{ key: `table-join:v:${visitor}`, limit: 10, windowMs: TEN_MINUTES }], 'Too many tries. Please wait a few minutes, or ask a waiter.');
  return sessions((pg) => join(pg, { table, visitor, code: body.code, name: body.name }));
}

/** GET /api/public/table-sessions/:id?since=N — members poll this every ~3 s. */
async function read({ request, params, url }) {
  const visitor = needVisitor(request);
  rateLimit([{ key: `table-read:v:${visitor}`, limit: 600, windowMs: TEN_MINUTES }], 'Too many checks. Please wait a minute.');
  const since = url.searchParams.get('since');
  return sessions((pg) => getSession(pg, { sessionId: params.id.toLowerCase(), visitor, since }));
}

async function sessionRestaurant(pg, id) {
  const { rows } = await pg.query(`select restaurant_id from public.table_sessions where id = $1`, [id]);
  if (!rows[0] || !isUuid(rows[0].restaurant_id)) throw new HttpError(404, 'This table’s order has closed. Scan the table again to start a new one.', { reason: 'closed' });
  return rows[0].restaurant_id;
}

/** POST /api/public/table-sessions/:id/ops { type: add|change|quantity|note|remove|clear, … } */
async function op({ request, params, body }) {
  const visitor = needVisitor(request);
  rateLimit([{ key: `table-op:v:${visitor}`, limit: 300, windowMs: TEN_MINUTES }]);
  const id = params.id.toLowerCase();
  return sessions(async (pg) => {
    const restaurantId = await sessionRestaurant(pg, id);
    const { session } = await applyOp(pg, { sessionId: id, visitor, op: body, price: pricer(serviceClient(), restaurantId) });
    return { session };
  });
}

/** POST /api/public/table-sessions/:id/ready — one code and QR for the whole table. */
async function readyToOrder({ request, params }) {
  const visitor = needVisitor(request);
  rateLimit([{ key: `cart:v:${visitor}`, limit: 10, windowMs: TEN_MINUTES }]);
  const id = params.id.toLowerCase();
  const readyColumn = await hasConfirmationSchema(serviceClient());
  return sessions(async (pg) => {
    const restaurantId = await sessionRestaurant(pg, id);
    return ready(pg, { sessionId: id, visitor, price: pricer(serviceClient(), restaurantId), readyColumn });
  });
}

/** POST /api/public/table-sessions/:id/leave — "Order on my own instead" after joining. */
async function leaveTable({ request, params }) {
  const visitor = needVisitor(request);
  return sessions((pg) => leave(pg, { sessionId: params.id.toLowerCase(), visitor }));
}

export const routes = [
  { method: 'POST', path: '/api/public/table-sessions', handler: withBody(open) },
  { method: 'POST', path: '/api/public/table-sessions/join', handler: withBody(joinTable) },
  { method: 'GET', path: SESSION_PATH(), handler: read },
  { method: 'POST', path: SESSION_PATH('ops'), handler: withBody(op) },
  { method: 'POST', path: SESSION_PATH('ready'), handler: withBody(readyToOrder) },
  { method: 'POST', path: SESSION_PATH('leave'), handler: withBody(leaveTable) },
];
