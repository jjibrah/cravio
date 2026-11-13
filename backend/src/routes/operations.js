// Live restaurant operations for staff: needs-attention feed, orders, guest-cart import, tables,
// analytics and system health. Reads go through the caller's RLS client; writes use the service
// client only after staffContext/managerContext has checked membership and role in code.
import { createHash, randomUUID } from 'node:crypto';
import { statusOf } from '../lib/admin-users.js';
import { HttpError } from '../lib/http.js';
import {
  ACTIVE_STATUSES, hasConfirmationSchema, orderSelect, withBody, ORDER_STATUSES, PAYMENT_METHODS, STATUS_LABELS, TIME_ZONE, UUID, canCancel, check,
  cleanCartCode, findTable, guestMenuPath, iso, managerContext, money, must, nairobiLabel, nairobiMidnight, namesFor,
  orderOut, parseDateParam, previewCartLines, priceLines, requestOut, staffContext, staffIdsOf, tableNumber, tableState,
} from '../lib/operations.js';
import { text } from '../lib/restaurants.js';
import { serviceClient } from '../lib/supabase.js';
import { invalidateMenu } from '../lib/cache.js';
import { hasMerchSchema } from '../lib/menu-merch.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TABLES = 200;
const REQUEST_COLUMNS = 'id, table_id, type, status, created_at, acknowledged_by, acknowledged_at, resolved_by, resolved_at, table:restaurant_tables(number)';
const ORDER_PATH = (action = '') => new RegExp(`^/api/ops/orders/(?<id>${UUID})${action ? `/${action}` : ''}/?$`);
const REQUEST_PATH = (action) => new RegExp(`^/api/ops/requests/(?<id>${UUID})/${action}/?$`);
const TABLE_PATH = /^\/api\/ops\/tables\/(?<number>\d{1,3})\/?$/;

const sectionOf = (sections, id) => {
  const section = id ? sections.find((s) => s.id === id) : null;
  return section ? { id: section.id, name: section.name } : null;
};

/* ---------- Orders: loading and presenting ---------- */

async function present(context, rows, options) {
  const names = await namesFor(serviceClient(), staffIdsOf(rows));
  return rows.map((row) => orderOut(row, names, context, options));
}

async function loadOrder(context, id, { timeline = true } = {}) {
  const row = must(await context.client.from('orders').select(await orderSelect(context.client)).eq('id', id).eq('restaurant_id', context.restaurantId).maybeSingle());
  if (!row) throw new HttpError(404, 'That order doesn’t exist.');
  return (await present(context, [row], { timeline }))[0];
}

/** The order's current status (service client, scoped to the caller's restaurant), or 404. */
async function currentOrder(db, context, id, columns = 'id, status, taken_by, table_id, total, currency') {
  const row = must(await db.from('orders').select(columns).eq('id', id).eq('restaurant_id', context.restaurantId).maybeSingle());
  if (!row) throw new HttpError(404, 'That order doesn’t exist.');
  return row;
}

function expectStatus(order, from) {
  if (from === undefined || from === null) return;
  if (!ORDER_STATUSES.includes(from)) throw new HttpError(400, 'from must be taken, accepted, served, paid or cancelled.', { field: 'from' });
  if (from !== order.status) throw changed(order.status);
}

const changed = (status) => new HttpError(409, `This order just changed: it’s ${STATUS_LABELS[status].toLowerCase()} now. Refresh to see the latest.`, { status });
const finished = (status) => new HttpError(409, status === 'paid' ? 'This order is already paid.' : 'This order was cancelled.', { status });

/* ---------- Guest carts ---------- */

async function findCart(db, restaurantId, code) {
  const cart = must(await db.from('guest_carts').select('id, code, table_id, items, created_at, expires_at, claimed_at, claimed_order_id')
    .eq('code', code).eq('restaurant_id', restaurantId)
    .order('claimed_at', { ascending: true, nullsFirst: true }).order('created_at', { ascending: false }).limit(1).maybeSingle());
  if (!cart) throw new HttpError(404, `We couldn’t find cart ${code}. Check the code, or ask the guest to show it again.`);
  if (cart.claimed_at) {
    const shortId = cart.claimed_order_id ? cart.claimed_order_id.slice(0, 6) : null;
    throw new HttpError(409, shortId ? `This cart was already entered as order #${shortId}.` : 'This cart was already entered.', { orderId: cart.claimed_order_id, shortId });
  }
  if (new Date(cart.expires_at) <= new Date()) throw new HttpError(410, 'This code has expired. Ask the guest to tap “Ready to order” again.');
  return cart;
}

function cartCodeParam(value) {
  const code = cleanCartCode(value);
  if (!code) throw new HttpError(400, 'Cart codes are 6 letters and numbers, like ACD347.', { field: 'cartCode' });
  return code;
}

/* ---------- Ready to order: guest carts waiting for a waiter ---------- */

/**
 * Carts whose guest tapped "Ready to order" and that nobody has confirmed yet (unclaimed, unexpired).
 * Service client: guest_carts are never readable by browsers. Before migration 005 there is no ready_at, so
 * every active cart counts as ready (saving a cart was already "Show to waiter").
 */
async function readyCarts(restaurantId, now) {
  const db = serviceClient();
  const flow = await hasConfirmationSchema(db);
  let query = db.from('guest_carts').select(`id, code, table_id, items, created_at, updated_at, expires_at${flow ? ', ready_at' : ''}`)
    .eq('restaurant_id', restaurantId).is('claimed_at', null).gt('expires_at', now);
  if (flow) query = query.not('ready_at', 'is', null);
  return must(await query.order('id'));
}

/** Folds the ready carts into the live cursor, so a new, edited, confirmed or expired cart changes it. */
function cursorWithCarts(cursor, carts) {
  if (!carts.length) return cursor;
  const fingerprint = carts.map((cart) => `${cart.id}:${cart.updated_at}:${cart.ready_at || ''}:${cart.expires_at}`).join(',');
  return createHash('md5').update(`${cursor}|${fingerprint}`).digest('hex');
}

/** Attention items for ready carts, priced from today's menu in one pass (unavailable lines don't count). */
async function readyCartsOut(restaurantId, carts, tables) {
  if (!carts.length) return [];
  const all = carts.flatMap((cart) => (Array.isArray(cart.items) ? cart.items : []));
  const { lines } = await previewCartLines(serviceClient(), restaurantId, all);
  let at = 0;
  return carts.map((cart) => {
    const own = lines.slice(at, at + (Array.isArray(cart.items) ? cart.items.length : 0));
    at += own.length;
    const available = own.filter((line) => line.available);
    const table = tables.find((t) => t.id === cart.table_id);
    return {
      type: 'ready_to_order',
      tableNumber: table?.number ?? null,
      table: table ? { id: table.id, number: table.number } : null,
      // Never send the code itself: holding it is the proof the waiter is at the table with the guest.
      id: cart.id,
      itemCount: available.reduce((sum, line) => sum + line.quantity, 0),
      total: money(available.reduce((sum, line) => sum + line.lineTotal, 0)),
      currency: 'KES',
      readyAt: iso(cart.ready_at || cart.updated_at || cart.created_at),
      expiresAt: iso(cart.expires_at),
    };
  }).sort((a, b) => a.readyAt.localeCompare(b.readyAt));
}

/* ---------- Handlers ---------- */

async function live({ request, url }) {
  const context = await staffContext(request);
  const { client, restaurantId } = context;
  const serverTime = new Date().toISOString();
  // Fingerprint first: anything that changes while we read below shows up as a new cursor next poll.
  const [base, carts] = await Promise.all([
    client.rpc('ops_live_cursor', { p_restaurant: restaurantId }).then((result) => must(result)),
    readyCarts(restaurantId, serverTime),
  ]);
  const cursor = cursorWithCarts(base, carts);
  if (url.searchParams.get('since') === cursor) return { changed: false, cursor, serverTime };

  const select = await orderSelect(client);
  const [requests, orders, tables, sections] = (await Promise.all([
    client.from('service_requests').select(REQUEST_COLUMNS).eq('restaurant_id', restaurantId).in('status', ['open', 'acknowledged']).order('created_at'),
    client.from('orders').select(select).eq('restaurant_id', restaurantId).in('status', ACTIVE_STATUSES).order('created_at'),
    client.from('restaurant_tables').select('id, number, label, section_id').eq('restaurant_id', restaurantId).order('number'),
    client.from('restaurant_sections').select('id, name, position').eq('restaurant_id', restaurantId).order('position'),
  ])).map((result) => must(result));

  const names = await namesFor(serviceClient(), [...staffIdsOf(orders), ...requests.map((r) => r.acknowledged_by)]);
  const now = Date.parse(serverTime);
  const requestsOut = requests.map((row) => requestOut(row, names, now))
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt));
  const ordersOut = orders.map((row) => orderOut(row, names, context));
  const readyOut = await readyCartsOut(restaurantId, carts, tables);

  const tablesOut = tables.map((table) => {
    const tableRequests = requestsOut.filter((r) => r.table.id === table.id);
    const tableOrders = ordersOut.filter((o) => o.table?.id === table.id);
    const requestTypes = [...new Set(tableRequests.map((r) => r.type))];
    return {
      id: table.id, number: table.number, label: table.label, section: sectionOf(sections, table.section_id),
      state: tableState({ requestTypes, openOrders: tableOrders.length }),
      readyToOrder: readyOut.some((cart) => cart.table?.id === table.id),
      openOrders: tableOrders.length,
      unpaidTotal: money(tableOrders.reduce((sum, o) => sum + o.total, 0)),
      requestTypes,
      oldestRequestAt: tableRequests.reduce((min, r) => (!min || r.createdAt < min ? r.createdAt : min), null),
    };
  });
  const states = { free: 0, ordering: 0, attention: 0, bill: 0 };
  for (const table of tablesOut) states[table.state] += 1;

  return {
    changed: true, cursor, serverTime,
    requests: requestsOut,
    orders: ordersOut,
    readyToOrder: readyOut,
    tables: tablesOut,
    summary: {
      openRequests: requestsOut.filter((r) => r.status === 'open').length, activeRequests: requestsOut.length, activeOrders: ordersOut.length,
      readyToOrder: readyOut.length, tables: states,
    },
  };
}

async function requestAction(action, { request, params }) {
  const context = await staffContext(request);
  const db = serviceClient();
  const id = params.id.toLowerCase();
  const now = new Date().toISOString();
  const row = must(await db.from('service_requests').select('id, status').eq('id', id).eq('restaurant_id', context.restaurantId).maybeSingle());
  if (!row) throw new HttpError(404, 'That request doesn’t exist.');
  if (action === 'acknowledge') {
    if (row.status === 'resolved') throw new HttpError(409, 'This request is already resolved.', { status: row.status });
    if (row.status === 'open') {
      check((await db.from('service_requests').update({ status: 'acknowledged', acknowledged_by: context.user.id, acknowledged_at: now })
        .eq('id', id).eq('status', 'open')).error);
    }
  } else if (row.status !== 'resolved') {
    check((await db.from('service_requests').update({ status: 'resolved', resolved_by: context.user.id, resolved_at: now })
      .eq('id', id).in('status', ['open', 'acknowledged'])).error);
  }
  // Acknowledging twice or resolving twice is harmless: the request comes back as it is.
  const saved = must(await context.client.from('service_requests').select(REQUEST_COLUMNS).eq('id', id).single());
  const names = await namesFor(db, [saved.acknowledged_by, saved.resolved_by]);
  return { request: requestOut(saved, names) };
}

async function lookupCart({ request, params }) {
  const context = await staffContext(request);
  const db = serviceClient();
  const cart = await findCart(db, context.restaurantId, cartCodeParam(params.code));
  const [{ lines, total }, table] = await Promise.all([
    previewCartLines(db, context.restaurantId, cart.items),
    cart.table_id ? db.from('restaurant_tables').select('id, number').eq('id', cart.table_id).maybeSingle().then((r) => must(r)) : null,
  ]);
  return {
    cart: {
      code: cart.code, table: table ? { id: table.id, number: table.number } : null, items: lines, total, currency: 'KES',
      hasUnavailableItems: lines.some((line) => !line.available), createdAt: iso(cart.created_at), expiresAt: iso(cart.expires_at),
    },
  };
}

/**
 * How the order was confirmed (docs/ORDER-FLOW.md). With a guest cart: 'qr' when the waiter scanned the guest's QR
 * (`via: 'scan'`), 'code' when they typed the code (`via: 'typed'`, the default). Without a cart: 'manual'.
 */
function confirmationOf(body, hasCart) {
  if (body.via !== undefined && body.via !== null && !['scan', 'typed'].includes(body.via)) {
    throw new HttpError(400, 'via must be scan or typed.', { field: 'via' });
  }
  if (!hasCart) return 'manual';
  return body.via === 'scan' ? 'qr' : 'code';
}

async function createOrder({ request, body }) {
  const context = await staffContext(request);
  const { restaurantId, user } = context;
  const db = serviceClient();
  const now = new Date().toISOString();

  const confirmation = confirmationOf(body, Boolean(body.cartCode));
  const cart = body.cartCode ? await findCart(db, restaurantId, cartCodeParam(body.cartCode)) : null;
  const rawItems = cart && (body.items === undefined || (Array.isArray(body.items) && !body.items.length)) ? cart.items : body.items;
  const { lines, subtotal } = await priceLines(db, restaurantId, rawItems, { maxLines: 50, maxQuantity: 50 });
  const note = text(body.note, 'the note', { max: 280 }) ?? null;

  let table = null;
  if (body.tableNumber !== undefined && body.tableNumber !== null) table = await findTable(db, restaurantId, tableNumber(body.tableNumber));
  else if (body.tableNumber === undefined && cart?.table_id) table = must(await db.from('restaurant_tables').select('id, number').eq('id', cart.table_id).maybeSingle());
  if (!table && body.tableNumber !== null) throw new HttpError(400, 'Choose a table, or send tableNumber: null for takeaway.', { field: 'tableNumber' });

  if (cart) {
    const claimed = must(await db.from('guest_carts').update({ claimed_at: now, claimed_by: user.id })
      .eq('id', cart.id).is('claimed_at', null).gt('expires_at', now).select('id').maybeSingle());
    if (!claimed) throw new HttpError(409, 'Someone just entered this cart. Check the orders list.');
  }
  const unclaim = () => cart && db.from('guest_carts').update({ claimed_at: null, claimed_by: null }).eq('id', cart.id).then(() => {}, () => {});

  const id = randomUUID();
  // `taken` is "Confirmed": the waiter confirmed it with the guest (or entered it by hand, `confirmation: 'manual'`).
  const { error } = await db.from('orders').insert({
    id, restaurant_id: restaurantId, table_id: table?.id || null, table_number: table?.number || null, status: 'taken',
    taken_by: user.id, taken_at: now, note, subtotal, total: subtotal, currency: 'KES',
    source: cart ? 'guest_cart' : 'waiter', guest_cart_id: cart?.id || null,
    ...((await hasConfirmationSchema(db)) ? { confirmation } : {}),
  });
  if (error) { await unclaim(); check(error); }
  const merch = await hasMerchSchema(db);
  const { error: itemsError } = await db.from('order_items').insert(lines.map((line, position) => ({
    order_id: id, restaurant_id: restaurantId, item_id: line.itemId, name: line.name, unit_price: line.unitPrice,
    quantity: line.quantity, note: line.note, line_total: line.lineTotal, position,
    // Snapshots, so the order keeps what was chosen even if the menu changes (migration 004).
    ...(merch ? {
      kind: line.kind, deal_id: line.dealId || null,
      extras: line.extras.map(({ id: extraId, name, price }) => ({ id: extraId, name, price })),
      components: line.kind === 'deal' ? line.components : null,
    } : {}),
  })));
  if (itemsError) {
    await db.from('orders').delete().eq('id', id);
    await unclaim();
    check(itemsError);
  }
  if (cart) check((await db.from('guest_carts').update({ claimed_order_id: id }).eq('id', cart.id)).error);
  return { order: await loadOrder(context, id) };
}

async function listOrders({ request, url }) {
  const context = await staffContext(request);
  const params = url.searchParams;
  const limit = params.has('limit') ? Number(params.get('limit')) : 50;
  const offset = params.has('offset') ? Number(params.get('offset')) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'limit must be between 1 and 100.');
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be 0 or more.');

  let query = context.client.from('orders').select(await orderSelect(context.client), { count: 'exact' }).eq('restaurant_id', context.restaurantId);
  const statuses = (params.get('status') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.some((status) => !ORDER_STATUSES.includes(status))) throw new HttpError(400, 'status must be a comma list of taken, accepted, served, paid, cancelled.');
  if (statuses.length) query = query.in('status', statuses);
  if (params.get('tableNumber')) query = query.eq('table_number', tableNumber(params.get('tableNumber')));
  const from = parseDateParam(params.get('from'), 'from');
  const to = parseDateParam(params.get('to'), 'to', { end: true });
  if (from) query = query.gte('created_at', from.toISOString());
  if (to) query = query.lt('created_at', to.toISOString());
  const q = (params.get('q') || '').trim().replace(/^#/, '').toLowerCase();
  if (q) {
    if (!/^[0-9a-f]{1,6}$/.test(q)) throw new HttpError(400, 'Search by order number, like 92da2e.');
    query = query.like('short_id', `${q}%`);
  }
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  check(error);
  const orders = await present(context, data);
  return { orders, total: count ?? orders.length, limit, offset, hasMore: offset + orders.length < (count ?? 0) };
}

async function getOrder({ request, params }) {
  const context = await staffContext(request);
  return { order: await loadOrder(context, params.id.toLowerCase()) };
}

/**
 * Confirmed (`taken`, or `accepted` on older orders) -> served. Paying is POST /pay. Before migration 005 the
 * database still requires an accepted time on served orders, so it is set to the serving time (the timeline
 * doesn't show an accepted step).
 */
async function advanceOrder({ request, params, body }) {
  const context = await staffContext(request);
  const db = serviceClient();
  const order = await currentOrder(db, context, params.id.toLowerCase());
  expectStatus(order, body.from);
  if (order.status === 'served') throw new HttpError(409, 'This order has been served. Mark it paid to finish.', { status: order.status });
  if (order.status === 'paid' || order.status === 'cancelled') throw finished(order.status);
  if (!['taken', 'accepted'].includes(order.status)) throw changed(order.status);
  const now = new Date().toISOString();
  const update = { status: 'served', served_by: context.user.id, served_at: now };
  if (order.status === 'taken' && !(await hasConfirmationSchema(db))) Object.assign(update, { accepted_by: context.user.id, accepted_at: now });
  const saved = must(await db.from('orders').update(update)
    .eq('id', order.id).eq('status', order.status).select('id').maybeSingle());
  if (!saved) throw changed((await currentOrder(db, context, order.id)).status);
  return { order: await loadOrder(context, order.id) };
}

async function payOrder({ request, params, body }) {
  const context = await staffContext(request);
  const db = serviceClient();
  const method = typeof body.method === 'string' ? body.method.toLowerCase().replace(/[\s-]/g, '') : '';
  if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, 'Choose how they paid: cash, mpesa, card or other.', { field: 'method' });
  const reference = text(body.reference, 'the reference', { max: 60 }) ?? null;
  const order = await currentOrder(db, context, params.id.toLowerCase());
  expectStatus(order, body.from);
  if (order.status === 'paid' || order.status === 'cancelled') throw finished(order.status);
  if (order.status !== 'served') throw new HttpError(409, 'Serve this order before marking it paid.', { status: order.status });

  const now = new Date().toISOString();
  const saved = must(await db.from('orders').update({ status: 'paid', paid_by: context.user.id, paid_at: now })
    .eq('id', order.id).eq('status', 'served').select('id').maybeSingle());
  if (!saved) throw changed((await currentOrder(db, context, order.id)).status);
  const { error } = await db.from('payments').insert({
    restaurant_id: context.restaurantId, order_id: order.id, provider: 'manual', provider_reference: reference, method,
    status: 'succeeded', amount: order.total, currency: order.currency, recorded_by: context.user.id, confirmed_at: now,
  });
  if (error) {
    await db.from('orders').update({ status: 'served', paid_by: null, paid_at: null }).eq('id', order.id).eq('status', 'paid');
    check(error);
  }

  // Nothing left to pay at this table: close its bill and payment requests.
  if (order.table_id) {
    const { count } = await db.from('orders').select('id', { count: 'exact', head: true }).eq('table_id', order.table_id).in('status', ACTIVE_STATUSES);
    if (count === 0) {
      const { error: resolveError } = await db.from('service_requests').update({ status: 'resolved', resolved_by: context.user.id, resolved_at: now })
        .eq('table_id', order.table_id).in('type', ['bill', 'payment']).in('status', ['open', 'acknowledged']);
      if (resolveError) console.error('[operations] auto-resolve bill requests failed:', resolveError.code || resolveError.message);
    }
  }
  return { order: await loadOrder(context, order.id) };
}

async function cancelOrder({ request, params, body }) {
  const context = await staffContext(request);
  const db = serviceClient();
  const reason = text(body.reason, 'the reason', { max: 200 }) ?? null;
  const order = await currentOrder(db, context, params.id.toLowerCase());
  expectStatus(order, body.from);
  if (order.status === 'paid') throw new HttpError(409, 'A paid order can’t be cancelled.', { status: order.status });
  if (order.status === 'cancelled') throw new HttpError(409, 'This order is already cancelled.', { status: order.status });
  if (!canCancel(order, context)) {
    throw new HttpError(403, order.taken_by === context.user.id
      ? 'This order has been served, so only a manager can cancel it now.'
      : 'Only a manager, or the waiter who took it, can cancel this order.');
  }
  const saved = must(await db.from('orders').update({ status: 'cancelled', cancelled_by: context.user.id, cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq('id', order.id).eq('status', order.status).select('id').maybeSingle());
  if (!saved) throw changed((await currentOrder(db, context, order.id)).status);
  return { order: await loadOrder(context, order.id) };
}

/* ---------- Analytics ---------- */

const RANGES = {
  today: { days: 1, unit: 'hour' }, '7d': { days: 7, unit: 'day' }, '30d': { days: 30, unit: 'day' }, '90d': { days: 90, unit: 'day' },
};
const PERFORMANCE_SORTS = ['sales', 'quantity', 'views', 'plays', 'conversion', 'name'];

const totalsOut = (row) => ({
  menuScans: Number(row?.menu_scans || 0), orders: Number(row?.orders || 0), cancelledOrders: Number(row?.cancelled_orders || 0),
  paidOrders: Number(row?.paid_orders || 0), sales: money(row?.sales), tablesServed: Number(row?.tables_served || 0),
});

/** Resolves an optional RPC (added by migration 004): null when the function isn't installed yet. */
async function optional(query) {
  const { data, error } = await query;
  if (error && ['PGRST202', '42883', 'PGRST205', '42P01'].includes(error.code)) return null;
  check(error);
  return data;
}

const round2 = (value) => Math.round(value * 100) / 100;
const ratio = (a, b) => (b > 0 ? round2(a / b) : 0);

/** A headline number with its previous-period comparison. `isNew` when the previous period had nothing. */
function metric(value, previous, extra = {}) {
  if (value === null || value === undefined) return { value: null, previous: null, delta: null, deltaPercent: null, isNew: false, ...extra };
  return {
    value, previous, delta: round2(value - previous),
    deltaPercent: previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : null,
    isNew: previous === 0 && value > 0,
    ...extra,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summaryLine(scans, orders, peak) {
  if (!scans && !orders) return 'No menu scans or orders yet in this period.';
  const head = scans ? `${plural(scans, 'menu scan')} led to ${plural(orders, 'order')}` : `${plural(orders, 'order')} were taken with no menu scans logged`;
  return peak ? `${head}; the busiest hour is ${peak.label}.` : `${head}.`;
}

function busyHoursOut(rows) {
  if (!rows) return null;
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const row = rows.find((r) => Number(r.hour_of_day) === hour);
    return { hour, label: `${String(hour).padStart(2, '0')}:00`, scans: Number(row?.scans || 0), orders: Number(row?.orders || 0) };
  });
  const by = hours.some((h) => h.orders > 0) ? 'orders' : hours.some((h) => h.scans > 0) ? 'scans' : null;
  const peak = by ? hours.reduce((best, h) => (h[by] > best[by] || (h[by] === best[by] && h[by === 'orders' ? 'scans' : 'orders'] > best[by === 'orders' ? 'scans' : 'orders']) ? h : best)) : null;
  return { hours, peakHour: peak ? { ...peak } : null, peakBy: by };
}

function performanceOut(rows, items, sort, dir) {
  if (!rows) return null;
  const info = new Map(items.map((item) => [item.id, item]));
  const out = rows.map((row) => {
    const direct = Number(row.direct_quantity);
    const viaDeals = Number(row.deal_quantity);
    const views = Number(row.views);
    const quantity = direct + viaDeals;
    const base = {
      kind: row.kind, id: row.ref_id, name: row.name, views, videoPlays: Number(row.plays),
      orderedQuantity: quantity, directQuantity: direct, dealQuantity: viaDeals,
      sales: money(Number(row.direct_sales) + Number(row.deal_sales)), directSales: money(row.direct_sales), dealSales: money(row.deal_sales),
      conversionRate: views > 0 ? round2(quantity / views) : null,
    };
    if (row.kind === 'deal') return { ...base, dealId: row.ref_id };
    const item = info.get(row.ref_id);
    return {
      ...base, itemId: row.ref_id, categoryId: item?.category_id || null, categoryName: item?.category?.name || null,
      price: item ? money(item.price) : null, available: item ? item.available : null, photoUrl: item?.photo_url || null,
    };
  });
  const key = { sales: 'sales', quantity: 'orderedQuantity', views: 'views', plays: 'videoPlays', conversion: 'conversionRate', name: 'name' }[sort];
  const sign = dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    if (key === 'name') return sign * a.name.localeCompare(b.name);
    const av = a[key] ?? -1;
    const bv = b[key] ?? -1;
    return sign * (av - bv) || b.sales - a.sales || b.orderedQuantity - a.orderedQuantity || a.name.localeCompare(b.name);
  });
  return out;
}

async function analytics({ request, url }) {
  const context = await managerContext(request);
  const { client, restaurantId } = context;
  const range = url.searchParams.get('range') || 'today';
  const spec = RANGES[range];
  if (!spec) throw new HttpError(400, 'range must be today, 7d, 30d or 90d.');
  const sort = url.searchParams.get('sort') || 'sales';
  if (!PERFORMANCE_SORTS.includes(sort)) throw new HttpError(400, `sort must be one of ${PERFORMANCE_SORTS.join(', ')}.`);
  const dir = url.searchParams.get('dir') || (sort === 'name' ? 'asc' : 'desc');
  if (!['asc', 'desc'].includes(dir)) throw new HttpError(400, 'dir must be asc or desc.');
  const now = new Date();
  const from = nairobiMidnight(now, spec.days - 1);
  const shift = spec.days * DAY_MS;
  const prevFrom = new Date(from.getTime() - shift);
  const prevTo = new Date(now.getTime() - shift);
  const window = (a, b) => ({ p_restaurant: restaurantId, p_from: a.toISOString(), p_to: b.toISOString() });

  // One round of parallel queries. The 004 functions resolve to null until that migration is applied.
  const [[current, previous, series, best, tableStats, tables, items, open], busy, engagement, prevEngagement, performance] = await Promise.all([
    Promise.all([
      client.rpc('ops_totals', window(from, now)).single(),
      client.rpc('ops_totals', window(prevFrom, prevTo)).single(),
      client.rpc('ops_series', { ...window(from, now), p_unit: spec.unit, p_tz: TIME_ZONE }),
      client.rpc('ops_best_sellers', { ...window(from, now), p_limit: 5 }),
      client.rpc('ops_table_stats', { p_restaurant: restaurantId, p_scans_since: from.toISOString(), p_revenue_since: from.toISOString() }),
      client.from('restaurant_tables').select('id, number').eq('restaurant_id', restaurantId),
      client.from('menu_items').select('id, name, price, available, photo_url, category_id, category:menu_categories(name)').eq('restaurant_id', restaurantId).order('name'),
      client.from('orders').select('total').eq('restaurant_id', restaurantId).in('status', ACTIVE_STATUSES),
    ]).then((results) => results.map((result) => must(result))),
    optional(client.rpc('ops_busy_hours', { ...window(from, now), p_tz: TIME_ZONE })),
    optional(client.rpc('ops_engagement_totals', window(from, now)).maybeSingle()),
    optional(client.rpc('ops_engagement_totals', window(prevFrom, prevTo)).maybeSingle()),
    optional(client.rpc('ops_dish_performance', window(from, now))),
  ]);

  const numberOf = new Map(tables.map((t) => [t.id, t.number]));
  const stats = tableStats.map((row) => ({ tableId: row.table_id, number: numberOf.get(row.table_id), scans: Number(row.scans_recent), revenue: money(row.revenue_recent), orders: Number(row.orders_recent) }));
  const top = (key) => stats.filter((row) => row[key] > 0).sort((a, b) => b[key] - a[key] || a.number - b.number).slice(0, 5);
  const openBills = { count: open.length, amount: money(open.reduce((sum, row) => sum + Number(row.total), 0)) };
  const cur = totalsOut(current);
  const prev = totalsOut(previous);
  const views = engagement ? Number(engagement.dish_views || 0) : null;
  const prevViews = prevEngagement ? Number(prevEngagement.dish_views || 0) : null;
  const busyHours = busyHoursOut(busy);
  const average = (sales, paid) => (paid > 0 ? money(sales / paid) : 0);

  return {
    range, timeZone: TIME_ZONE, currency: 'KES',
    from: from.toISOString(), to: now.toISOString(),
    previousFrom: prevFrom.toISOString(), previousTo: prevTo.toISOString(),
    totals: { menuScans: cur.menuScans, orders: cur.orders, sales: cur.sales, openBills, tablesServed: cur.tablesServed, paidOrders: cur.paidOrders, cancelledOrders: cur.cancelledOrders },
    previousTotals: { menuScans: prev.menuScans, orders: prev.orders, sales: prev.sales, openBills: null, tablesServed: prev.tablesServed, paidOrders: prev.paidOrders, cancelledOrders: prev.cancelledOrders },
    kpis: {
      menuScans: metric(cur.menuScans, prev.menuScans),
      dishViews: metric(views, prevViews),
      viewsPerScan: metric(views === null ? null : ratio(views, cur.menuScans), prevViews === null ? null : ratio(prevViews, prev.menuScans)),
      videoPlays: metric(engagement ? Number(engagement.video_plays || 0) : null, prevEngagement ? Number(prevEngagement.video_plays || 0) : null),
      orders: metric(cur.orders, prev.orders),
      averageOrder: metric(average(cur.sales, cur.paidOrders), average(prev.sales, prev.paidOrders), { basis: 'Paid sales ÷ paid orders in the period (by time paid).' }),
      paidSales: metric(cur.sales, prev.sales),
    },
    seriesUnit: spec.unit,
    series: series.map((point) => ({
      start: iso(point.bucket), label: nairobiLabel(point.bucket, spec.unit),
      scans: Number(point.scans), orders: Number(point.orders), sales: money(point.sales),
    })),
    busyHours,
    bestSellers: best.map((row) => ({ itemId: row.item_id, name: row.name, quantity: Number(row.quantity), revenue: money(row.revenue) })),
    dishPerformance: performanceOut(performance, items, sort, dir),
    dishPerformanceSort: { sort, dir },
    soldOut: items.filter((item) => !item.available).map((item) => ({ id: item.id, name: item.name, price: money(item.price), categoryId: item.category_id, categoryName: item.category?.name || null })),
    topTablesByScans: top('scans').map(({ tableId, number, scans }) => ({ tableId, number, scans })),
    topTablesByRevenue: top('revenue').map(({ tableId, number, revenue, orders }) => ({ tableId, number, revenue, orders })),
    summary: summaryLine(cur.menuScans, cur.orders, busyHours?.peakHour),
  };
}

/* ---------- Tables ---------- */

async function activeRequestsByTable(client, restaurantId) {
  const rows = must(await client.from('service_requests').select('table_id, type').eq('restaurant_id', restaurantId).in('status', ['open', 'acknowledged']));
  const byTable = new Map();
  for (const row of rows) byTable.set(row.table_id, [...new Set([...(byTable.get(row.table_id) || []), row.type])]);
  return byTable;
}

function tableStatsOut(row) {
  return {
    scans: { last7Days: Number(row?.scans_recent || 0), allTime: Number(row?.scans_all || 0) },
    revenue: { last30Days: money(row?.revenue_recent), allTime: money(row?.revenue_all) },
    ordersLast30Days: Number(row?.orders_recent || 0),
    openOrders: Number(row?.open_orders || 0),
    lastScanAt: iso(row?.last_scan_at),
  };
}

async function listTables({ request }) {
  const context = await staffContext(request);
  const { client, restaurantId } = context;
  const now = Date.now();
  const [tables, sections, stats, requests] = await Promise.all([
    client.from('restaurant_tables').select('id, number, label, section_id').eq('restaurant_id', restaurantId).order('number').then((r) => must(r)),
    client.from('restaurant_sections').select('id, name, position').eq('restaurant_id', restaurantId).order('position').then((r) => must(r)),
    client.rpc('ops_table_stats', { p_restaurant: restaurantId, p_scans_since: new Date(now - 7 * DAY_MS).toISOString(), p_revenue_since: new Date(now - 30 * DAY_MS).toISOString() }).then((r) => must(r)),
    activeRequestsByTable(client, restaurantId),
  ]);
  const statsById = new Map(stats.map((row) => [row.table_id, row]));
  const out = tables.map((table) => {
    const numbers = tableStatsOut(statsById.get(table.id));
    const requestTypes = requests.get(table.id) || [];
    return {
      id: table.id, number: table.number, label: table.label, section: sectionOf(sections, table.section_id),
      state: tableState({ requestTypes, openOrders: numbers.openOrders }), requestTypes,
      ...numbers, guestMenuPath: guestMenuPath(restaurantId, table.number),
    };
  });
  return { tables: out, sections: sections.map((s) => ({ id: s.id, name: s.name, position: s.position })) };
}

async function addTables({ request, body }) {
  const context = await managerContext(request);
  const { client, restaurantId } = context;
  const hasCount = body.count !== undefined;
  const hasNumber = body.number !== undefined;
  if (hasCount === hasNumber) throw new HttpError(400, 'Send either count (add that many tables) or number (add one table).');
  let sectionId = null;
  if (body.sectionId !== undefined && body.sectionId !== null) {
    const section = must(await client.from('restaurant_sections').select('id').eq('restaurant_id', restaurantId).eq('id', String(body.sectionId)).maybeSingle());
    if (!section) throw new HttpError(400, 'That section doesn’t exist.', { field: 'sectionId' });
    sectionId = section.id;
  }
  const existing = must(await client.from('restaurant_tables').select('number').eq('restaurant_id', restaurantId));
  const numbers = new Set(existing.map((t) => t.number));
  let wanted;
  if (hasNumber) {
    const number = tableNumber(body.number, { label: 'number' });
    if (numbers.has(number)) throw new HttpError(409, `Table ${number} already exists.`, { field: 'number' });
    wanted = [number];
  } else {
    if (!Number.isInteger(body.count) || body.count < 1 || body.count > 50) throw new HttpError(400, 'Add between 1 and 50 tables at a time.', { field: 'count' });
    const start = (existing.length ? Math.max(...numbers) : 0) + 1;
    wanted = Array.from({ length: body.count }, (_, index) => start + index);
    if (wanted[wanted.length - 1] > 999) throw new HttpError(400, 'Table numbers can’t go above 999.', { field: 'count' });
  }
  if (existing.length + wanted.length > MAX_TABLES) throw new HttpError(400, `You can have up to ${MAX_TABLES} tables. Contact Cravio for more.`);
  const created = must(await client.from('restaurant_tables')
    .insert(wanted.map((number) => ({ restaurant_id: restaurantId, number, section_id: sectionId })))
    .select('id, number, label, section_id'), { duplicate: 'One of those table numbers already exists. Refresh and try again.' });
  invalidateMenu(restaurantId);
  return {
    tables: created.sort((a, b) => a.number - b.number).map((t) => ({ id: t.id, number: t.number, label: t.label, sectionId: t.section_id, guestMenuPath: guestMenuPath(restaurantId, t.number) })),
    total: existing.length + created.length,
  };
}

async function deleteTable({ request, params }) {
  const context = await managerContext(request);
  const { client, restaurantId } = context;
  const table = await findTable(client, restaurantId, tableNumber(params.number));
  const { count, error } = await client.from('orders').select('id', { count: 'exact', head: true }).eq('table_id', table.id).in('status', ACTIVE_STATUSES);
  check(error);
  if (count > 0) {
    throw new HttpError(409, `Table ${table.number} has ${count} unpaid order${count === 1 ? '' : 's'}. Finish or cancel ${count === 1 ? 'it' : 'them'} first.`, { openOrders: count });
  }
  check((await client.from('restaurant_tables').delete().eq('id', table.id)).error);
  invalidateMenu(restaurantId);
}

async function getTable({ request, params }) {
  const context = await staffContext(request);
  const { client, restaurantId } = context;
  const table = await findTable(client, restaurantId, tableNumber(params.number));
  const now = new Date();
  const select = await orderSelect(client);
  const [series, stats, recent, requests, section] = await Promise.all([
    client.rpc('ops_series', { p_restaurant: restaurantId, p_from: nairobiMidnight(now, 13).toISOString(), p_to: now.toISOString(), p_unit: 'day', p_tz: TIME_ZONE, p_table: table.id }),
    client.rpc('ops_table_stats', { p_restaurant: restaurantId, p_scans_since: new Date(now - 7 * DAY_MS).toISOString(), p_revenue_since: new Date(now - 30 * DAY_MS).toISOString() }),
    client.from('orders').select(select).eq('restaurant_id', restaurantId).eq('table_id', table.id).order('created_at', { ascending: false }).limit(10),
    client.from('service_requests').select(REQUEST_COLUMNS).eq('table_id', table.id).in('status', ['open', 'acknowledged']).order('created_at'),
    table.section_id ? client.from('restaurant_sections').select('id, name').eq('id', table.section_id).maybeSingle() : Promise.resolve({ data: null }),
  ]).then((results) => results.map((result) => must(result)));
  const numbers = tableStatsOut(stats.find((row) => row.table_id === table.id));
  const names = await namesFor(serviceClient(), [...staffIdsOf(recent), ...requests.map((r) => r.acknowledged_by)]);
  const requestTypes = [...new Set(requests.map((r) => r.type))];
  return {
    table: {
      id: table.id, number: table.number, label: table.label, section: section ? { id: section.id, name: section.name } : null,
      state: tableState({ requestTypes, openOrders: numbers.openOrders }), guestMenuPath: guestMenuPath(restaurantId, table.number),
    },
    totals: numbers,
    scansByDay: series.map((point) => ({ date: nairobiLabel(point.bucket, 'day'), scans: Number(point.scans), orders: Number(point.orders), sales: money(point.sales) })),
    recentOrders: recent.map((row) => orderOut(row, names, context)),
    requests: requests.map((row) => requestOut(row, names)),
  };
}

/* ---------- Health ---------- */

async function health({ request }) {
  const context = await managerContext(request);
  const { client, restaurantId } = context;
  const started = performance.now();
  const ping = await client.from('restaurants').select('id, status').eq('id', restaurantId).maybeSingle();
  const latencyMs = Math.round(performance.now() - started);
  const databaseOk = !ping.error && Boolean(ping.data);

  const [items, lastScan, lastOrder, members, invites] = await Promise.all([
    client.from('menu_items').select('id, available').eq('restaurant_id', restaurantId),
    client.from('menu_scans').select('created_at').eq('restaurant_id', restaurantId).order('created_at', { ascending: false }).limit(1),
    client.from('orders').select('created_at').eq('restaurant_id', restaurantId).order('created_at', { ascending: false }).limit(1),
    client.from('restaurant_members').select('user_id, role').eq('restaurant_id', restaurantId),
    client.from('staff_invites').select('status').eq('restaurant_id', restaurantId),
  ]).then((results) => results.map((result) => must(result)));

  const service = serviceClient();
  const staff = { active: 0, invited: 0, suspended: 0, total: 0 };
  await Promise.all(members.filter((m) => m.role !== 'owner').map(async (member) => {
    const { data } = await service.auth.admin.getUserById(member.user_id);
    if (!data?.user) return;
    staff[statusOf(data.user)] += 1;
    staff.total += 1;
  }));
  const pendingInvites = { queued: invites.filter((i) => i.status === 'queued').length, failed: invites.filter((i) => i.status === 'failed').length };
  pendingInvites.total = pendingInvites.queued + pendingInvites.failed;
  const availableItems = items.filter((i) => i.available).length;
  const unavailableItems = items.length - availableItems;
  const status = ping.data?.status || context.restaurant.status;
  const menuLive = status === 'live' && availableItems > 0;
  const lastScanAt = iso(lastScan[0]?.created_at);
  const lastOrderAt = iso(lastOrder[0]?.created_at);
  const scansRecently = lastScanAt && Date.now() - Date.parse(lastScanAt) < 7 * DAY_MS;

  const checks = [
    { key: 'api', label: 'Cravio server', status: 'ok', detail: 'Responding normally.' },
    {
      key: 'database', label: 'Database', status: databaseOk && latencyMs < 1000 ? 'ok' : 'warning',
      detail: !databaseOk ? 'The database didn’t answer. Orders may not save.' : latencyMs < 1000 ? `Answered in ${latencyMs} ms.` : `Slow right now (${latencyMs} ms).`,
    },
    {
      key: 'menu', label: 'Guest menu', status: menuLive ? 'ok' : 'warning',
      detail: status !== 'live' ? 'Your restaurant isn’t live yet, so guests can’t open the menu.'
        : availableItems ? `Live with ${plural(availableItems, 'dish', 'dishes')} available.` : 'Every dish is marked sold out.',
    },
    {
      key: 'scans', label: 'Menu scans', status: status !== 'live' || scansRecently ? 'ok' : 'warning',
      detail: scansRecently ? 'Guests are opening your menu.' : 'No guest has opened your menu in the last 7 days. Check the QR codes on your tables.',
    },
    { key: 'orders', label: 'Orders', status: 'ok', detail: lastOrderAt ? 'Staff are entering orders.' : 'No orders yet.' },
    {
      key: 'staff', label: 'Staff', status: pendingInvites.failed ? 'warning' : 'ok',
      detail: pendingInvites.failed ? `${plural(pendingInvites.failed, 'invite')} couldn’t be sent. Check the email addresses.`
        : `${staff.active} active, ${staff.invited} invited${pendingInvites.queued ? `, ${pendingInvites.queued} waiting to send` : ''}.`,
    },
    { key: 'soldOut', label: 'Sold out', status: 'ok', detail: unavailableItems ? `${plural(unavailableItems, 'dish is', 'dishes are')} marked sold out.` : 'Everything is available.' },
  ];

  return {
    status: checks.some((c) => c.status === 'warning') ? 'warning' : 'ok',
    checkedAt: new Date().toISOString(),
    checks,
    api: { ok: true },
    database: { ok: databaseOk, latencyMs },
    menu: { live: menuLive, restaurantStatus: status, availableItems, unavailableItems },
    lastScanAt, lastOrderAt,
    staff,
    pendingInvites,
    unavailableItems,
  };
}

export const routes = [
  { method: 'GET', path: '/api/ops/live', handler: live },
  { method: 'POST', path: REQUEST_PATH('acknowledge'), handler: (ctx) => requestAction('acknowledge', ctx) },
  { method: 'POST', path: REQUEST_PATH('resolve'), handler: (ctx) => requestAction('resolve', ctx) },
  { method: 'GET', path: /^\/api\/ops\/carts\/(?<code>[A-Za-z0-9-]{1,16})\/?$/, handler: lookupCart },
  { method: 'POST', path: '/api/ops/orders', handler: withBody(createOrder) },
  { method: 'GET', path: '/api/ops/orders', handler: listOrders },
  { method: 'GET', path: ORDER_PATH(), handler: getOrder },
  { method: 'POST', path: ORDER_PATH('advance'), handler: withBody(advanceOrder) },
  { method: 'POST', path: ORDER_PATH('pay'), handler: withBody(payOrder) },
  { method: 'POST', path: ORDER_PATH('cancel'), handler: withBody(cancelOrder) },
  { method: 'GET', path: '/api/ops/analytics', handler: analytics },
  { method: 'GET', path: '/api/ops/tables', handler: listTables },
  { method: 'POST', path: '/api/ops/tables', handler: withBody(addTables) },
  { method: 'GET', path: TABLE_PATH, handler: getTable },
  { method: 'DELETE', path: TABLE_PATH, handler: deleteTable },
  { method: 'GET', path: '/api/ops/health', handler: health },
];
