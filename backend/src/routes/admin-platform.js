// Cravio admin: platform overview, restaurants, performance, money, and the support queue
// (Leads & requests, Complaints). Every handler checks requireRole(request, 'admin') first, then reads with
// the service client. Tables from later migrations (003 operations, 006 support) are optional: when one is
// missing its numbers come back empty and `available` says so, instead of failing the page.
import { requireRole } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { serviceClient } from '../lib/supabase.js';
import { fail, isMissingTable, listAuthUsers } from '../lib/admin-users.js';
import { money, nairobiLabel, nairobiMidnight, withBody } from '../lib/operations.js';
import { SUPPORT_COLUMNS, supportMissing, supportOut } from './support.js';

const PAGE = 1000;
const MAX_ROWS = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_SUPPORT = ['open', 'in_progress'];
const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const SUPPORT_TYPES = ['question', 'problem', 'billing', 'feature', 'complaint', 'lead'];
const LEAD_TYPES = ['lead', 'question', 'problem', 'billing', 'feature'];
const REQUEST = /^\/api\/admin\/requests\/(?<id>[0-9a-fA-F-]{36})$/;

async function adminContext(request) {
  await requireRole(request, 'admin');
  return serviceClient();
}

const missing = (error) => isMissingTable(error) || supportMissing(error) || ['42703', 'PGRST204'].includes(error?.code);

/**
 * Every row a query returns, paged 1,000 at a time (PostgREST's cap), up to MAX_ROWS.
 * `build` must return a fresh, ordered query each call.
 * @returns {{ rows: object[], available: boolean, truncated?: boolean }}
 */
async function selectAll(label, build) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) {
      if (missing(error)) return { rows: [], available: false };
      fail(label, error, 'Could not load platform data. Please try again.');
    }
    rows.push(...data);
    if (data.length < PAGE) return { rows, available: true };
  }
  console.warn(`[admin-platform] ${label}: stopped at ${MAX_ROWS} rows`);
  return { rows, available: true, truncated: true };
}

const RESTAURANT_FIELDS = 'id, owner_id, name, kind, area, address, phone, status, created_at, went_live_at';
const loadRestaurants = (service) => selectAll('restaurants', () => service.from('restaurants').select(RESTAURANT_FIELDS).order('id'));
const loadProfiles = (service) => selectAll('profiles', () => service.from('profiles').select('id, name, role').order('id'));

/** Non-cancelled orders created since `from`, plus paid orders paid since `from`, in one pass. */
const loadOrders = (service, from) => selectAll('orders', () => service.from('orders')
  .select('id, restaurant_id, status, total, created_at, taken_at, served_at, paid_at')
  .or(`created_at.gte."${from.toISOString()}",paid_at.gte."${from.toISOString()}"`)
  .order('id'));

const countBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) map.set(row[key], (map.get(row[key]) || 0) + 1);
  return map;
};

/** Nairobi days from `from` to today, as 'YYYY-MM-DD' keys with zeroed counters. */
function dayBuckets(from, now, fields) {
  const days = [];
  for (let t = from.getTime(); t <= now.getTime(); t += DAY_MS) {
    days.push({ date: nairobiLabel(new Date(t), 'day'), ...Object.fromEntries(fields.map((f) => [f, 0])) });
  }
  const index = new Map(days.map((day, i) => [day.date, i]));
  return { days, at: (value) => days[index.get(nairobiLabel(value, 'day'))] };
}

const inRange = (value, from, to = null) => {
  if (!value) return false;
  const t = new Date(value).getTime();
  return t >= from.getTime() && (!to || t < to.getTime());
};

function parseRange(value, allowed, fallback) {
  const range = value || fallback;
  if (!allowed.includes(range)) throw new HttpError(400, `Unknown range. Use ${allowed.join(', ')}.`);
  return range;
}

const rangeStart = (range, now) => {
  if (range === 'month') {
    const local = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 3 * 60 * 60 * 1000);
  }
  return nairobiMidnight(now, Number.parseInt(range, 10) - 1);
};

/* ---------- Support queue ---------- */

function cleanTypes(value) {
  if (!value) return null;
  const list = String(value).split(',').map((t) => t.trim()).filter(Boolean);
  if (list.length === 1 && list[0] === 'leads') return LEAD_TYPES;
  if (!list.every((t) => SUPPORT_TYPES.includes(t))) throw new HttpError(400, `Unknown type. Use ${SUPPORT_TYPES.join(', ')} or leads.`);
  return list;
}

async function decorateRequests(service, rows) {
  const restaurantIds = [...new Set(rows.map((r) => r.restaurant_id).filter(Boolean))];
  const userIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
  const [restaurants, people] = await Promise.all([
    restaurantIds.length ? service.from('restaurants').select('id, name, status, area').in('id', restaurantIds) : { data: [] },
    userIds.length ? service.from('profiles').select('id, name').in('id', userIds) : { data: [] },
  ]);
  const byRestaurant = new Map((restaurants.data || []).map((r) => [r.id, r]));
  const byPerson = new Map((people.data || []).map((p) => [p.id, p.name]));
  return rows.map((row) => {
    const restaurant = byRestaurant.get(row.restaurant_id);
    return {
      ...supportOut(row),
      restaurant: restaurant ? { id: restaurant.id, name: restaurant.name, status: restaurant.status, area: restaurant.area } : null,
      createdByName: byPerson.get(row.created_by) || null,
    };
  });
}

const matches = (row, q) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [row.subject, row.message, row.contactName, row.contactEmail, row.contactPhone, row.restaurant?.name, row.adminNote]
    .some((value) => value && value.toLowerCase().includes(needle));
};

export const routes = [
  {
    method: 'GET',
    path: '/api/admin/overview',
    async handler({ request }) {
      const service = await adminContext(request);
      const now = new Date();
      const today = nairobiMidnight(now);
      const weekStart = nairobiMidnight(now, 6);
      const [restaurants, profiles, orders, support] = await Promise.all([
        loadRestaurants(service),
        loadProfiles(service),
        loadOrders(service, weekStart),
        selectAll('support', () => service.from('support_requests').select(SUPPORT_COLUMNS).in('status', OPEN_SUPPORT).order('created_at', { ascending: false })),
      ]);

      const byStatus = { live: 0, onboarding: 0 };
      for (const r of restaurants.rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      const roles = countBy(profiles.rows, 'role');

      const { days, at } = dayBuckets(weekStart, now, ['orders', 'revenue']);
      const totals = { ordersToday: 0, revenueToday: 0, orders7d: 0, revenue7d: 0 };
      for (const o of orders.rows) {
        if (o.status !== 'cancelled' && inRange(o.created_at, weekStart)) {
          totals.orders7d += 1;
          if (inRange(o.created_at, today)) totals.ordersToday += 1;
          const day = at(o.created_at); if (day) day.orders += 1;
        }
        if (o.status === 'paid' && inRange(o.paid_at, weekStart)) {
          const amount = Number(o.total || 0);
          totals.revenue7d += amount;
          if (inRange(o.paid_at, today)) totals.revenueToday += amount;
          const day = at(o.paid_at); if (day) day.revenue += amount;
        }
      }

      const openComplaints = support.rows.filter((r) => r.type === 'complaint').length;
      const recent = await decorateRequests(service, support.rows.slice(0, 6));
      const newest = [...restaurants.rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6)
        .map((r) => ({ id: r.id, name: r.name, status: r.status, kind: r.kind, area: r.area, createdAt: r.created_at, wentLiveAt: r.went_live_at }));

      return {
        available: { operations: orders.available, support: support.available },
        restaurants: { total: restaurants.rows.length, byStatus },
        people: { owners: roles.get('owner') || 0, waiters: roles.get('waiter') || 0, admins: roles.get('admin') || 0 },
        requests: { open: support.rows.length - openComplaints, complaints: openComplaints },
        orders: {
          today: totals.ordersToday, last7d: totals.orders7d,
          revenueToday: money(totals.revenueToday), revenue7d: money(totals.revenue7d), currency: 'KES',
        },
        series: days.map((d) => ({ ...d, revenue: money(d.revenue) })),
        newestRestaurants: newest,
        recentRequests: recent,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/restaurants',
    async handler({ request }) {
      const service = await adminContext(request);
      const now = new Date();
      const since = nairobiMidnight(now, 29);
      const restaurants = await loadRestaurants(service);
      if (!restaurants.available) return { restaurants: [], counts: { all: 0 }, available: { operations: false } };

      let emails = new Map();
      const [profiles, tables, items, members, orders] = await Promise.all([
        loadProfiles(service),
        selectAll('tables', () => service.from('restaurant_tables').select('id, restaurant_id').order('id')),
        selectAll('menu items', () => service.from('menu_items').select('id, restaurant_id').order('id')),
        selectAll('members', () => service.from('restaurant_members').select('restaurant_id, user_id, role').order('user_id')),
        loadOrders(service, since),
        listAuthUsers(service).then((users) => { emails = new Map(users.map((u) => [u.id, u.email?.toLowerCase() || null])); })
          .catch((error) => console.warn('[admin-platform] owner emails unavailable:', error.message)),
      ]);

      const names = new Map(profiles.rows.map((p) => [p.id, p.name]));
      const tableCount = countBy(tables.rows, 'restaurant_id');
      const itemCount = countBy(items.rows, 'restaurant_id');
      const staffCount = countBy(members.rows.filter((m) => m.role !== 'owner'), 'restaurant_id');
      const usage = new Map();
      for (const o of orders.rows) {
        const u = usage.get(o.restaurant_id) || { orders: 0, revenue: 0 };
        if (o.status !== 'cancelled' && inRange(o.created_at, since)) u.orders += 1;
        if (o.status === 'paid' && inRange(o.paid_at, since)) u.revenue += Number(o.total || 0);
        usage.set(o.restaurant_id, u);
      }
      const lastOrder = new Map();
      for (const o of orders.rows) {
        if (o.created_at > (lastOrder.get(o.restaurant_id) || '')) lastOrder.set(o.restaurant_id, o.created_at);
      }
      // Restaurants with no order in the window: look up their latest one, a few at a time.
      if (orders.available) {
        const quiet = restaurants.rows.filter((r) => !lastOrder.has(r.id)).map((r) => r.id);
        for (let i = 0; i < quiet.length; i += 10) {
          await Promise.all(quiet.slice(i, i + 10).map(async (id) => {
            const { data } = await service.from('orders').select('created_at').eq('restaurant_id', id)
              .order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (data) lastOrder.set(id, data.created_at);
          }));
        }
      }

      const rows = restaurants.rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        kind: r.kind,
        area: r.area,
        address: r.address,
        phone: r.phone,
        created_at: r.created_at,
        went_live_at: r.went_live_at,
        owner: { id: r.owner_id, name: names.get(r.owner_id) || null, email: emails.get(r.owner_id) || null },
        tables: tableCount.get(r.id) || 0,
        menuItems: itemCount.get(r.id) || 0,
        staff: staffCount.get(r.id) || 0,
        orders30d: usage.get(r.id)?.orders || 0,
        revenue30d: money(usage.get(r.id)?.revenue || 0),
        lastOrderAt: lastOrder.get(r.id) || null,
      })).sort((a, b) => a.name.localeCompare(b.name));

      const counts = { all: rows.length };
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      return { restaurants: rows, counts, currency: 'KES', available: { operations: orders.available } };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/performance',
    async handler({ request, url }) {
      const service = await adminContext(request);
      const range = parseRange(url.searchParams.get('range'), ['7d', '30d', '90d'], '30d');
      const now = new Date();
      const from = rangeStart(range, now);
      const [restaurants, orders, scans, guestRequests] = await Promise.all([
        loadRestaurants(service),
        loadOrders(service, from),
        selectAll('scans', () => service.from('menu_scans').select('id, restaurant_id, created_at').gte('created_at', from.toISOString()).order('id')),
        selectAll('guest requests', () => service.from('service_requests').select('id, restaurant_id, created_at, acknowledged_at, resolved_at')
          .gte('created_at', from.toISOString()).order('id')),
      ]);

      const { days, at } = dayBuckets(from, now, ['orders', 'scans', 'requests']);
      const per = new Map(restaurants.rows.map((r) => [r.id, {
        id: r.id, name: r.name, status: r.status, area: r.area,
        orders: 0, cancelled: 0, scans: 0, guestRequests: 0, serveMs: 0, served: 0, answerMs: 0, answered: 0,
        activeDays: new Set(), lastOrderAt: null,
      }]));
      const get = (id) => per.get(id);

      for (const o of orders.rows) {
        if (!inRange(o.created_at, from)) continue;
        const r = get(o.restaurant_id); if (!r) continue;
        if (o.status === 'cancelled') { r.cancelled += 1; continue; }
        r.orders += 1;
        r.activeDays.add(nairobiLabel(o.created_at, 'day'));
        if (!r.lastOrderAt || o.created_at > r.lastOrderAt) r.lastOrderAt = o.created_at;
        const day = at(o.created_at); if (day) day.orders += 1;
        if (o.served_at && o.taken_at) {
          const ms = new Date(o.served_at) - new Date(o.taken_at);
          if (ms >= 0 && ms < 6 * 60 * 60 * 1000) { r.serveMs += ms; r.served += 1; }
        }
      }
      for (const s of scans.rows) {
        const r = get(s.restaurant_id); if (r) r.scans += 1;
        const day = at(s.created_at); if (day) day.scans += 1;
      }
      for (const g of guestRequests.rows) {
        const r = get(g.restaurant_id); if (!r) continue;
        r.guestRequests += 1;
        const day = at(g.created_at); if (day) day.requests += 1;
        const answeredAt = g.acknowledged_at || g.resolved_at;
        if (answeredAt) {
          const ms = new Date(answeredAt) - new Date(g.created_at);
          if (ms >= 0 && ms < 2 * 60 * 60 * 1000) { r.answerMs += ms; r.answered += 1; }
        }
      }

      const minutes = (ms, n) => (n ? Math.round((ms / n / 60000) * 10) / 10 : null);
      const rows = [...per.values()].map((r) => ({
        id: r.id, name: r.name, status: r.status, area: r.area,
        orders: r.orders, cancelled: r.cancelled, scans: r.scans, guestRequests: r.guestRequests,
        ordersPerScan: r.scans ? Math.round((r.orders / r.scans) * 100) / 100 : null,
        avgServeMinutes: minutes(r.serveMs, r.served),
        avgAnswerMinutes: minutes(r.answerMs, r.answered),
        activeDays: r.activeDays.size,
        lastOrderAt: r.lastOrderAt,
      })).sort((a, b) => b.orders - a.orders || b.scans - a.scans || a.name.localeCompare(b.name));

      const sum = (key) => rows.reduce((total, r) => total + r[key], 0);
      const all = [...per.values()];
      return {
        range, from: from.toISOString(), to: now.toISOString(),
        available: { operations: orders.available && scans.available && guestRequests.available },
        totals: {
          orders: sum('orders'), cancelled: sum('cancelled'), scans: sum('scans'), guestRequests: sum('guestRequests'),
          activeRestaurants: rows.filter((r) => r.orders > 0).length,
          restaurants: rows.length,
          avgServeMinutes: minutes(all.reduce((t, r) => t + r.serveMs, 0), all.reduce((t, r) => t + r.served, 0)),
          avgAnswerMinutes: minutes(all.reduce((t, r) => t + r.answerMs, 0), all.reduce((t, r) => t + r.answered, 0)),
        },
        series: days,
        restaurants: rows,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/money',
    async handler({ request, url }) {
      const service = await adminContext(request);
      const range = parseRange(url.searchParams.get('range'), ['month', '30d', '90d'], 'month');
      const now = new Date();
      const from = rangeStart(range, now);
      // The previous period of the same length, for the comparison line.
      const previousFrom = new Date(from.getTime() - (now.getTime() - from.getTime()));
      const [restaurants, orders, payments] = await Promise.all([
        loadRestaurants(service),
        loadOrders(service, previousFrom),
        selectAll('payments', () => service.from('payments').select('id, restaurant_id, method, status, amount, created_at, confirmed_at')
          .gte('created_at', from.toISOString()).order('id')),
      ]);

      const { days, at } = dayBuckets(from, now, ['revenue', 'paidOrders']);
      const per = new Map(restaurants.rows.map((r) => [r.id, {
        id: r.id, name: r.name, status: r.status, area: r.area, revenue: 0, paidOrders: 0, openOrders: 0, openValue: 0, cancelledValue: 0,
      }]));
      let previousRevenue = 0;
      for (const o of orders.rows) {
        const amount = Number(o.total || 0);
        const r = per.get(o.restaurant_id);
        if (o.status === 'paid' && inRange(o.paid_at, previousFrom, from)) previousRevenue += amount;
        if (!r) continue;
        if (o.status === 'paid' && inRange(o.paid_at, from)) {
          r.revenue += amount; r.paidOrders += 1;
          const day = at(o.paid_at); if (day) { day.revenue += amount; day.paidOrders += 1; }
        }
        if (inRange(o.created_at, from)) {
          if (['taken', 'accepted', 'served'].includes(o.status)) { r.openOrders += 1; r.openValue += amount; }
          if (o.status === 'cancelled') r.cancelledValue += amount;
        }
      }

      const methods = new Map();
      for (const p of payments.rows) {
        if (p.status !== 'succeeded') continue;
        const m = methods.get(p.method) || { method: p.method, amount: 0, count: 0 };
        m.amount += Number(p.amount || 0); m.count += 1;
        methods.set(p.method, m);
      }

      const rows = [...per.values()].map((r) => ({
        ...r,
        revenue: money(r.revenue), openValue: money(r.openValue), cancelledValue: money(r.cancelledValue),
        avgTicket: r.paidOrders ? money(r.revenue / r.paidOrders) : null,
      })).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
      const revenue = rows.reduce((t, r) => t + r.revenue, 0);
      const paidOrders = rows.reduce((t, r) => t + r.paidOrders, 0);

      return {
        range, from: from.toISOString(), to: now.toISOString(), currency: 'KES',
        available: { operations: orders.available, payments: payments.available },
        totals: {
          revenue: money(revenue), paidOrders, avgTicket: paidOrders ? money(revenue / paidOrders) : null,
          previousRevenue: money(previousRevenue),
          openValue: money(rows.reduce((t, r) => t + r.openValue, 0)),
          payingRestaurants: rows.filter((r) => r.revenue > 0).length,
        },
        series: days.map((d) => ({ ...d, revenue: money(d.revenue) })),
        methods: [...methods.values()].map((m) => ({ ...m, amount: money(m.amount) })).sort((a, b) => b.amount - a.amount),
        restaurants: rows,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/requests',
    async handler({ request, url }) {
      const service = await adminContext(request);
      const types = cleanTypes(url.searchParams.get('type'));
      const status = url.searchParams.get('status') || '';
      if (status && !SUPPORT_STATUSES.includes(status)) throw new HttpError(400, `Unknown status. Use ${SUPPORT_STATUSES.join(', ')}.`);
      const q = url.searchParams.get('q')?.trim().slice(0, 120) || '';

      let query = service.from('support_requests').select(SUPPORT_COLUMNS).order('created_at', { ascending: false }).limit(500);
      if (types) query = query.in('type', types);
      const { data, error } = await query;
      if (error) {
        if (missing(error)) return { available: false, requests: [], counts: { all: 0, open: 0, in_progress: 0, resolved: 0, closed: 0 } };
        fail('list requests', error, 'Could not load requests. Please try again.');
      }
      const searched = (await decorateRequests(service, data)).filter((row) => matches(row, q));
      const counts = { all: searched.length, open: 0, in_progress: 0, resolved: 0, closed: 0 };
      for (const row of searched) counts[row.status] += 1;
      return { available: true, requests: status ? searched.filter((r) => r.status === status) : searched, counts };
    },
  },
  {
    method: 'PATCH',
    path: REQUEST,
    handler: withBody(async ({ request, params, body }) => {
      const service = await adminContext(request);
      const update = {};
      if (Object.hasOwn(body, 'status')) {
        if (!SUPPORT_STATUSES.includes(body.status)) throw new HttpError(400, 'Choose a status: open, in progress, resolved or closed.', { field: 'status' });
        update.status = body.status;
      }
      if (Object.hasOwn(body, 'adminNote')) {
        if (body.adminNote !== null && typeof body.adminNote !== 'string') throw new HttpError(400, 'The note must be text.', { field: 'adminNote' });
        const note = body.adminNote?.trim() || null;
        if (note && note.length > 4000) throw new HttpError(400, 'Keep the note under 4,000 characters.', { field: 'adminNote' });
        update.admin_note = note;
      }
      if (!Object.keys(update).length) throw new HttpError(400, 'Send a new status or note.');

      const { data: current, error: readError } = await service.from('support_requests').select('id, status, resolved_at').eq('id', params.id).maybeSingle();
      if (readError) {
        if (missing(readError)) throw new HttpError(503, 'Support requests aren’t available yet. The database update hasn’t been applied.');
        fail('read request', readError, 'Could not load this request. Please try again.');
      }
      if (!current) throw new HttpError(404, 'That request doesn’t exist.');
      if (update.status) {
        const done = ['resolved', 'closed'].includes(update.status);
        update.resolved_at = done ? current.resolved_at || new Date().toISOString() : null;
      }

      const { data, error } = await service.from('support_requests').update(update).eq('id', params.id).select(SUPPORT_COLUMNS).single();
      if (error) fail('update request', error, 'Could not save this request. Please try again.');
      const [row] = await decorateRequests(service, [data]);
      return { request: row, message: 'Request updated.' };
    }),
  },
];
