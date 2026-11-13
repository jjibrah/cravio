// Live operations: shared helpers for routes/operations.js (staff) and routes/public-guest.js (guests).
import { createHash, randomInt } from 'node:crypto';
import { requireRole } from './auth.js';
import { HttpError } from './http.js';
import { findMembership, isMissingSchema, pickMembership, text } from './restaurants.js';
import { hasMerchSchema, parseLine, resolveLines, storedLine } from './menu-merch.js';
import { nameCache } from './cache.js';
import { serviceClient } from './supabase.js';

export const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

/* ---------- Time: the group operates in Kenya (EAT, UTC+3, no daylight saving) ---------- */

export const TIME_ZONE = 'Africa/Nairobi';
const OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight in Nairobi at the start of the day containing `date`, `daysAgo` days back. */
export function nairobiMidnight(date = new Date(), daysAgo = 0) {
  const local = new Date(date.getTime() + OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET_MS - daysAgo * DAY_MS);
}

/** 'YYYY-MM-DD' or 'HH:00' in Nairobi time. */
export function nairobiLabel(date, unit) {
  const local = new Date(new Date(date).getTime() + OFFSET_MS).toISOString();
  return unit === 'hour' ? `${local.slice(11, 13)}:00` : local.slice(0, 10);
}

/**
 * Parses a `from`/`to` query value: an ISO timestamp, or a date 'YYYY-MM-DD' meaning that Nairobi day.
 * For `to`, a date means the end of that day (exclusive upper bound = next midnight).
 */
export function parseDateParam(value, label, { end = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const midnight = new Date(`${value}T00:00:00+03:00`);
    if (Number.isNaN(midnight.getTime())) throw new HttpError(400, `${label} must be a date like 2026-10-31.`);
    return end ? new Date(midnight.getTime() + DAY_MS) : midnight;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} must be a date like 2026-10-31 or an ISO time.`);
  return date;
}

export const iso = (value) => (value ? new Date(value).toISOString() : null);
export const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/* ---------- Requests ---------- */

/** Wraps a handler so `body` is always a plain object (JSON null, arrays and strings become {}). */
export const withBody = (handler) => (context) => handler({
  ...context, body: context.body && typeof context.body === 'object' && !Array.isArray(context.body) ? context.body : {},
});

/* ---------- Errors ---------- */

const NOT_INSTALLED = 'Live operations aren’t available yet. The database update hasn’t been applied.';

/** Turns Supabase errors into clear HTTP errors; unknown ones are rethrown (logged as a 503 by the server). */
export function check(error, messages = {}) {
  if (!error) return;
  if (error instanceof HttpError) throw error;
  if (isMissingSchema(error) || ['42703', '42883', 'PGRST202', 'PGRST204'].includes(error.code)) throw new HttpError(503, NOT_INSTALLED);
  if (error.code === '23505') throw new HttpError(409, messages.duplicate || 'That already exists.');
  if (error.code === '23514' || error.code === '22P02') throw new HttpError(400, messages.invalid || 'Some details are invalid. Check them and try again.');
  if (error.code === '42501') throw new HttpError(403, 'You do not have access to this.');
  throw error;
}

export function must(result, messages) {
  check(result.error, messages);
  return result.data;
}

/* ---------- Who is calling ---------- */

/**
 * Any member of a restaurant: owner, manager (profile role 'owner') or waiter.
 * Returns the caller's RLS client, their membership role and restaurant.
 */
export async function staffContext(request) {
  const context = await requireRole(request, 'owner', 'waiter');
  let membership;
  try { membership = context.memberships ? pickMembership(context.memberships) : await findMembership(context.client, context.user.id); }
  catch (error) { check(error); }
  if (!membership) throw new HttpError(403, 'You aren’t part of a restaurant yet. Ask your manager to add you.');
  const role = membership.role;
  return {
    ...context, role, isManager: role === 'owner' || role === 'manager',
    restaurant: membership.restaurant, restaurantId: membership.restaurant.id,
  };
}

/** Owners and managers only. */
export async function managerContext(request) {
  const context = await staffContext(request);
  if (!context.isManager) throw new HttpError(403, 'Only owners and managers can do this.');
  return context;
}

/** Display names for user ids. Profiles are readable only by their owner under RLS, so this uses the service client. */
export async function namesFor(service, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const names = new Map();
  const missing = [];
  for (const id of unique) {
    const cached = nameCache.get(id);
    if (cached === undefined) missing.push(id); else names.set(id, cached);
  }
  if (!missing.length) return names;
  const { data, error } = await service.from('profiles').select('id, name').in('id', missing);
  if (error) { console.error('[operations] staff names failed:', error.code || error.message); return names; }
  // Cached for 5 minutes; renames call invalidateUser, which drops the name.
  for (const row of data) { names.set(row.id, row.name); nameCache.set(row.id, row.name); }
  return names;
}

export const person = (names, id) => (id ? { id, name: names.get(id) || 'Former staff' } : null);

/* ---------- Tables ---------- */

export function tableNumber(value, { required = true, label = 'tableNumber' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, 'Choose a table.', { field: label });
    return null;
  }
  const number = typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isInteger(number) || number < 1 || number > 999) throw new HttpError(400, 'Table numbers go from 1 to 999.', { field: label });
  return number;
}

export async function findTable(db, restaurantId, number) {
  const table = must(await db.from('restaurant_tables').select('id, number, label, section_id')
    .eq('restaurant_id', restaurantId).eq('number', number).maybeSingle());
  if (!table) throw new HttpError(404, `Table ${number} doesn’t exist here.`, { field: 'tableNumber' });
  return table;
}

/** Guest menu link path for a table. */
export const guestMenuPath = (restaurantId, number) => `/guest-menu?r=${restaurantId}${number ? `&t=${number}` : ''}`;

/* ---------- Order lines ---------- */

/**
 * Validates requested lines and prices them from the current menu (dishes with extras, and deals).
 * @param db Supabase client that can read the restaurant's menu
 * @param raw [{ itemId, quantity, note?, extraIds? } | { dealId, quantity, note? }]
 * @returns {{ lines: Array<Line>, stored: Array<object>, subtotal: number }}
 *   Line: { kind, itemId, dealId, name, unitPrice, extras, extrasTotal, unitTotal, quantity, note, lineTotal, components? }
 *   stored: the lines in the shape saved in guest_carts.items
 */
export async function priceLines(db, restaurantId, raw, { maxLines = 30, maxQuantity = 20 } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Add at least one dish.', { field: 'items' });
  if (raw.length > maxLines) throw new HttpError(400, `An order can have up to ${maxLines} lines.`, { field: 'items' });
  const wanted = raw.map((entry, index) => parseLine(entry, index, maxQuantity));
  let resolved;
  try { resolved = await resolveLines(db, restaurantId, wanted); } catch (error) { check(error); }
  const problem = resolved.find((entry) => entry.problem)?.problem;
  if (problem) {
    const { status, message, index, ...rest } = problem;
    throw new HttpError(status, message, status === 503 ? undefined : { field: 'items', index, ...rest });
  }
  const lines = resolved.map((entry) => entry.line);
  const subtotal = lines.reduce((sum, line) => sum + Math.round(line.lineTotal * 100), 0) / 100;
  return { lines, stored: wanted.map(storedLine), subtotal };
}

/**
 * Re-prices a saved cart without failing: lines whose dish, extra or deal was removed or is unavailable are
 * flagged. Used when staff look a cart up before importing it.
 */
export async function previewCartLines(db, restaurantId, saved) {
  const raw = Array.isArray(saved) ? saved : [];
  const wanted = [];
  const out = [];
  raw.forEach((entry, index) => {
    try { wanted.push({ index, line: parseLine(entry, index, 99) }); }
    catch { out[index] = { kind: 'item', itemId: entry?.itemId || null, dealId: entry?.dealId || null, name: entry?.name || 'Removed dish', unitPrice: 0, extras: [], extrasTotal: 0, unitTotal: 0, quantity: Number(entry?.quantity) || 1, note: entry?.note || null, lineTotal: 0, available: false, unavailableReason: 'missing' }; }
  });
  let resolved;
  try { resolved = await resolveLines(db, restaurantId, wanted.map((w) => w.line)); } catch (error) { check(error); }
  let cents = 0;
  resolved.forEach((entry, position) => {
    const { index, line } = wanted[position];
    if (entry.line) {
      cents += Math.round(entry.line.lineTotal * 100);
      out[index] = { ...entry.line, available: true };
      return;
    }
    const known = line.kind === 'deal'
      ? { kind: 'deal', itemId: null, dealId: line.dealId, name: 'Deal no longer available', extras: [] }
      : { kind: 'item', itemId: line.itemId, dealId: null, name: raw[index]?.name || 'Removed dish', extras: [] };
    const { name, unitPrice = 0 } = entry.problem;
    const reason = { missing: 'missing', sold_out: 'sold_out', extra_missing: 'extra_unavailable', extra_sold_out: 'extra_unavailable', deal_unavailable: 'deal_unavailable', not_installed: 'missing' }[entry.problem.reason] || 'missing';
    out[index] = {
      ...known, ...(name ? { name } : {}), unitPrice, extrasTotal: 0, unitTotal: unitPrice, quantity: line.quantity, note: line.note,
      lineTotal: Math.round(unitPrice * 100 * line.quantity) / 100,
      available: false, unavailableReason: reason, unavailableMessage: entry.problem.message,
    };
  });
  // Unavailable lines still show their name and today's price when we know them, but don't count in the total.
  return { lines: out, total: cents / 100 };
}

/* ---------- Guest carts ---------- */

export const CART_ALPHABET = 'ACDEFHJKMNPRTUVWXY34679';
export const CART_TTL_MS = 2 * 60 * 60 * 1000;

export function newCartCode() {
  let code = '';
  for (let index = 0; index < 6; index++) code += CART_ALPHABET[randomInt(CART_ALPHABET.length)];
  return code;
}

/** Normalises a typed code ("acd 347", "ACD-347") or returns null when it can't be a cart code. */
export function cleanCartCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${CART_ALPHABET}]{6}$`).test(code) ? code : null;
}

/** What a guest's QR encodes: a link into the waiter app that carries the code. Staff scanners can also read a bare code. */
export function cartQrValue(code) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/waiter/cart/${code}`;
}

/* ---------- Visitors (anonymous, no PII) ---------- */

/**
 * The guest's anonymous id from `X-Cravio-Visitor` (8–64 of A–Z a–z 0–9 _ -), hashed so the raw id never
 * reaches the database. Null when absent or malformed.
 */
export function visitorId(request) {
  const raw = request.headers['x-cravio-visitor'];
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(raw)) return null;
  return createHash('sha256').update(`cravio-visitor:${raw}`).digest('hex').slice(0, 32);
}

/* ---------- In-memory rate limits for public writes ---------- */

// One process, in memory: resets on restart and isn't shared between instances. Swap for Redis or a
// database counter before running more than one backend instance.
const hits = new Map();
let lastSweep = Date.now();

/**
 * Sliding-window limiter. Throws 429 when any key is over its limit.
 * @param checks [{ key, limit, windowMs }]
 */
export function rateLimit(checks, message = 'That’s a lot of taps. Please wait a few minutes, or ask a member of staff.') {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    for (const [key, times] of hits) if (!times.length || now - times[times.length - 1] > 30 * 60_000) hits.delete(key);
    lastSweep = now;
  }
  for (const { key, limit, windowMs } of checks) {
    const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);
    hits.set(key, recent);
    if (recent.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      throw new HttpError(429, message, { retryAfterSeconds: retryAfter });
    }
  }
  for (const { key } of checks) hits.get(key).push(now);
}

/** The key used when a guest sends no visitor id: the socket address, kept only in memory. */
export const clientAddress = (request) => request.socket?.remoteAddress || 'unknown';

/* ---------- Orders ---------- */

// The agreed flow (docs/ORDER-FLOW.md): an order is created `taken` ("Confirmed", with the guest at the table),
// then served, then paid. `accepted` is no longer entered; older accepted orders read as Confirmed and can be served.
export const ORDER_STATUSES = ['taken', 'accepted', 'served', 'paid', 'cancelled'];
export const ACTIVE_STATUSES = ['taken', 'accepted', 'served'];
export const STATUS_LABELS = { taken: 'Confirmed', accepted: 'Confirmed', served: 'Served', paid: 'Paid', cancelled: 'Cancelled' };
export const NEXT_ACTION = { taken: 'serve', accepted: 'serve', served: 'pay' };
export const PAYMENT_METHODS = ['cash', 'mpesa', 'card', 'other'];
export const REQUEST_TYPES = ['call_waiter', 'bill', 'payment'];
export const REQUEST_LABELS = { call_waiter: 'Call waiter', bill: 'Bill requested', payment: 'Wants to pay' };
/** How an order was confirmed (migration 005): the guest's QR scanned, its code typed, or entered by staff. */
export const CONFIRMATIONS = ['qr', 'code', 'manual'];
export const CONFIRMATION_LABELS = {
  qr: 'Confirmed with the guest (QR)',
  code: 'Confirmed with the guest (typed code)',
  manual: 'Entered by waiter, not confirmed by the guest',
};

export const ORDER_COLUMNS = 'id, short_id, restaurant_id, table_id, table_number, status, taken_by, taken_at, accepted_by, accepted_at, '
  + 'served_by, served_at, paid_by, paid_at, cancelled_by, cancelled_at, cancel_reason, note, subtotal, total, currency, source, '
  + 'guest_cart_id, created_at, updated_at';
export const ORDER_ITEM_COLUMNS = 'id, item_id, name, unit_price, quantity, note, line_total, position';
/** Order line columns added by migration 004. */
export const ORDER_ITEM_MERCH_COLUMNS = 'kind, deal_id, extras, components';
export const PAYMENT_COLUMNS = 'id, provider, provider_reference, method, status, amount, currency, created_at, confirmed_at';
export const ORDER_SELECT = `${ORDER_COLUMNS}, items:order_items(${ORDER_ITEM_COLUMNS}), payments(${PAYMENT_COLUMNS})`;

/* ---------- Is migration 005 applied? ---------- */

let flowInstalled = null; // true once seen; false is re-checked after a minute
let flowCheckedAt = 0;

/**
 * True when migration 005's columns (orders.confirmation, guest_carts.ready_at) exist. Cached like hasMerchSchema.
 * Always probes with the service client: browsers' RLS clients can't read guest_carts at all.
 */
export async function hasConfirmationSchema(service = serviceClient()) {
  if (flowInstalled === true) return true;
  if (flowInstalled === false && Date.now() - flowCheckedAt < 60_000) return false;
  const db = service;
  const [orders, carts] = await Promise.all([
    db.from('orders').select('confirmation').limit(1),
    db.from('guest_carts').select('ready_at').limit(1),
  ]);
  const error = orders.error || carts.error;
  flowCheckedAt = Date.now();
  if (!error) flowInstalled = true;
  else if (['42703', 'PGRST204', '42P01', 'PGRST205'].includes(error.code)) flowInstalled = false;
  else flowInstalled = null; // unrelated failure: decide next time
  return flowInstalled === true;
}

/** The order select, with extras and deal columns once 004 is applied, and `confirmation` once 005 is. */
export async function orderSelect(db) {
  const [merch, flow] = await Promise.all([hasMerchSchema(db), hasConfirmationSchema()]);
  const columns = flow ? `${ORDER_COLUMNS}, confirmation` : ORDER_COLUMNS;
  const lines = merch ? `${ORDER_ITEM_COLUMNS}, ${ORDER_ITEM_MERCH_COLUMNS}` : ORDER_ITEM_COLUMNS;
  return `${columns}, items:order_items(${lines}), payments(${PAYMENT_COLUMNS})`;
}

/** API shape of one order line. Lines saved before 004 are plain dishes without extras. */
export function orderLineOut(line) {
  const extras = Array.isArray(line.extras) ? line.extras.map((e) => ({ id: e.id ?? null, name: e.name, price: money(e.price) })) : [];
  const extrasTotal = money(extras.reduce((sum, e) => sum + e.price, 0));
  const kind = line.kind === 'deal' ? 'deal' : 'item';
  return {
    id: line.id, kind, itemId: line.item_id, dealId: line.deal_id ?? null, name: line.name,
    unitPrice: money(line.unit_price), extras, extrasTotal, unitTotal: money(Number(line.unit_price) + extrasTotal),
    quantity: line.quantity, note: line.note, lineTotal: money(line.line_total),
    components: kind === 'deal' && Array.isArray(line.components)
      ? line.components.map((c) => ({ itemId: c.itemId ?? null, name: c.name, quantity: Number(c.quantity) || 1, unitPrice: money(c.unitPrice) }))
      : null,
  };
}

export const staffIdsOf = (orders) => orders.flatMap((o) => [o.taken_by, o.accepted_by, o.served_by, o.paid_by, o.cancelled_by]);

/**
 * Whether `user` may cancel `order` now: managers any unpaid order; the waiter who confirmed it while it is
 * still Confirmed (not yet served).
 */
export function canCancel(order, context) {
  if (!ACTIVE_STATUSES.includes(order.status)) return false;
  return context.isManager || (['taken', 'accepted'].includes(order.status) && order.taken_by === context.user.id);
}

function paymentSummary(order) {
  const succeeded = (order.payments || []).filter((p) => p.status === 'succeeded')
    .sort((a, b) => String(b.confirmed_at).localeCompare(String(a.confirmed_at)));
  const latest = succeeded[0];
  if (!latest) return { status: order.status === 'paid' ? 'paid' : 'unpaid', method: null, reference: null, amount: null, paidAt: iso(order.paid_at) };
  return {
    status: 'paid', method: latest.method, reference: latest.provider_reference, amount: money(latest.amount),
    provider: latest.provider, paidAt: iso(latest.confirmed_at),
  };
}

/** API shape of an order row loaded with ORDER_SELECT. */
export function orderOut(order, names, context, { timeline = false } = {}) {
  const items = (order.items || []).slice().sort((a, b) => a.position - b.position).map(orderLineOut);
  const out = {
    id: order.id,
    shortId: order.short_id,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status],
    table: order.table_number ? { id: order.table_id, number: order.table_number } : null,
    note: order.note,
    items,
    itemCount: items.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: money(order.subtotal),
    total: money(order.total),
    currency: order.currency,
    source: order.source,
    confirmation: order.confirmation ?? null,
    confirmationLabel: CONFIRMATION_LABELS[order.confirmation] || null,
    takenAt: iso(order.taken_at), takenBy: person(names, order.taken_by),
    acceptedAt: iso(order.accepted_at), acceptedBy: person(names, order.accepted_by),
    servedAt: iso(order.served_at), servedBy: person(names, order.served_by),
    paidAt: iso(order.paid_at), paidBy: person(names, order.paid_by),
    cancelledAt: iso(order.cancelled_at), cancelledBy: person(names, order.cancelled_by), cancelReason: order.cancel_reason,
    payment: paymentSummary(order),
    nextAction: NEXT_ACTION[order.status] || null,
    canCancel: context ? canCancel(order, context) : false,
    createdAt: iso(order.created_at),
    updatedAt: iso(order.updated_at),
  };
  if (timeline) {
    // Confirmed -> Served -> Paid. The taken stage is the confirmation; `accepted` (older orders) isn't a step.
    const confirmed = order.confirmation === 'manual' ? 'Entered' : 'Confirmed';
    out.timeline = [
      ['taken', confirmed, order.taken_at, order.taken_by],
      ['served', 'Served', order.served_at, order.served_by], ['paid', 'Paid', order.paid_at, order.paid_by],
    ].map(([stage, label, at, by]) => ({
      stage, label, at: iso(at), by: at ? person(names, by) : null,
      ...(stage === 'taken' ? { confirmation: order.confirmation ?? null } : {}),
    }));
  }
  return out;
}

export function requestOut(row, names, now = Date.now()) {
  return {
    id: row.id, type: row.type, typeLabel: REQUEST_LABELS[row.type], status: row.status,
    table: row.table ? { id: row.table_id, number: row.table.number } : { id: row.table_id, number: null },
    createdAt: iso(row.created_at),
    ageSeconds: Math.max(0, Math.round((now - new Date(row.created_at).getTime()) / 1000)),
    acknowledgedAt: iso(row.acknowledged_at), acknowledgedBy: names ? person(names, row.acknowledged_by) : null,
    resolvedAt: iso(row.resolved_at), resolvedBy: names ? person(names, row.resolved_by) : null,
  };
}

/**
 * Table state, most urgent first:
 * bill (an unresolved bill/payment request) > attention (an unresolved call_waiter) > ordering (an unpaid order) > free.
 */
export function tableState({ requestTypes = [], openOrders = 0 }) {
  if (requestTypes.includes('bill') || requestTypes.includes('payment')) return 'bill';
  if (requestTypes.length) return 'attention';
  if (openOrders > 0) return 'ordering';
  return 'free';
}
