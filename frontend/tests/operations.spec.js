import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

// Live operations API (orders, guest carts, guest requests, scans, tables, analytics, health).
// Needs migration 003 applied and `npm run db:seed` run once (for owner@gmail.com's Demo Restaurant, used only
// read-only to prove another restaurant's data is invisible). Everything else happens in a throwaway restaurant
// with its own owner and waiter, created here with the service client and deleted in afterAll.

const service = createAdmin();
const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `Ops-${stamp}-pw`;
const CODE = /^[ACDEFHJKMNPRTUVWXY34679]{6}$/;

const ctx = { users: [], restaurantId: null };
const visitor = (label) => `test-${label}-${stamp}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function unwrap(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

async function createUser(role, name) {
  const email = `cravio-ops-${role}-${stamp}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { name }, app_metadata: { role },
  });
  if (error) throw new Error(`Could not create the ${role}: ${error.message}`);
  ctx.users.push(data.user.id);
  unwrap(await service.from('profiles').upsert({ id: data.user.id, name, role }), 'profile');
  return { id: data.user.id, email, name };
}

async function signIn(email, password = PASSWORD) {
  const client = createClient(env.SUPABASE_URL, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  return { token: data.session.access_token, client };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const as = (request, token) => ({
  get: (path) => request.get(path, { headers: auth(token) }),
  post: (path, data = {}) => request.post(path, { headers: auth(token), data }),
  patch: (path, data = {}) => request.patch(path, { headers: auth(token), data }),
  put: (path, data = {}) => request.put(path, { headers: auth(token), data }),
  delete: (path) => request.delete(path, { headers: auth(token) }),
});
const guest = (request, id) => ({
  get: (path) => request.get(path, { headers: { 'X-Cravio-Visitor': id } }),
  post: (path, data) => request.post(path, { headers: { 'X-Cravio-Visitor': id }, data }),
});

async function json(response, status) {
  const body = await response.json().catch(() => ({}));
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(90000);
  ctx.owner = await createUser('owner', 'Ops Owner');
  ctx.waiter = await createUser('waiter', 'Ops Waiter');
  const restaurant = unwrap(await service.from('restaurants').insert({
    owner_id: ctx.owner.id, name: `Ops Test ${stamp}`, status: 'live', went_live_at: new Date().toISOString(), area: 'Kilimani, Nairobi',
  }).select('id').single(), 'restaurant');
  ctx.restaurantId = restaurant.id;
  unwrap(await service.from('restaurant_members').insert([
    { restaurant_id: restaurant.id, user_id: ctx.owner.id, role: 'owner' },
    { restaurant_id: restaurant.id, user_id: ctx.waiter.id, role: 'waiter' },
  ]), 'members');
  unwrap(await service.from('restaurant_tables').insert([1, 2, 3, 4].map((number) => ({ restaurant_id: restaurant.id, number }))), 'tables');
  const [mains, drinks] = unwrap(await service.from('menu_categories').insert([
    { restaurant_id: restaurant.id, name: 'Mains', position: 0 }, { restaurant_id: restaurant.id, name: 'Drinks', position: 1 },
  ]).select('id, name, position').order('position'), 'categories');
  ctx.categories = { mains: mains.id, drinks: drinks.id };
  const items = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Chicken wings', price: 750, position: 0, available: true },
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Whole tilapia', price: 1200, position: 1, available: false },
    { restaurant_id: restaurant.id, category_id: drinks.id, name: 'Kenyan chai', price: 150, position: 0, available: true },
  ]).select('id, name'), 'items');
  ctx.items = Object.fromEntries(items.map((item) => [item.name, item.id]));
  ctx.ownerToken = (await signIn(ctx.owner.email)).token;
  ctx.waiterToken = (await signIn(ctx.waiter.email)).token;
});

test.afterAll(async () => {
  if (ctx.restaurantId) {
    const { error } = await service.from('restaurants').delete().eq('id', ctx.restaurantId);
    if (error) console.error('Could not delete the test restaurant:', error.message);
  }
  for (const id of ctx.users) {
    const { error } = await service.auth.admin.deleteUser(id);
    if (error) console.error('Could not delete a test user:', error.message);
  }
});

test('a guest is ready to order, a waiter confirms it by code, then it is served and paid (no accept step)', async ({ request }) => {
  const phone = guest(request, visitor('cart'));
  const waiter = as(request, ctx.waiterToken);
  const { restaurantId, items } = ctx;

  // The guest taps "Ready to order": the cart is saved and they get a short code.
  const saved = await json(await phone.post('/api/public/carts', {
    restaurantId, tableNumber: 2,
    items: [{ itemId: items['Chicken wings'], quantity: 2, note: 'Extra spicy' }, { itemId: items['Kenyan chai'], quantity: 1 }],
  }), 200);
  expect(saved.code).toMatch(CODE);
  expect(saved.status).toBe('ready');
  expect(saved.total).toBe(1650);
  expect(saved.currency).toBe('KES');
  expect(saved.table.number).toBe(2);
  expect(saved.items.map((line) => [line.name, line.quantity, line.unitPrice, line.lineTotal])).toEqual([['Chicken wings', 2, 750, 1500], ['Kenyan chai', 1, 150, 150]]);
  expect(saved.qrValue).toContain(saved.code);
  expect(Date.parse(saved.expiresAt) - Date.now()).toBeGreaterThan(110 * 60 * 1000);

  // Editing the same cart keeps its code.
  const edited = await json(await phone.post('/api/public/carts', { restaurantId, tableNumber: 2, code: saved.code, items: [{ itemId: items['Chicken wings'], quantity: 1 }] }), 200);
  expect(edited.code).toBe(saved.code);
  expect(edited.total).toBe(750);
  await json(await phone.post('/api/public/carts', {
    restaurantId, tableNumber: 2, code: saved.code,
    items: [{ itemId: items['Chicken wings'], quantity: 2, note: 'Extra spicy' }, { itemId: items['Kenyan chai'], quantity: 1 }],
  }), 200);

  // Sold-out dishes, bad quantities and unknown restaurants are refused.
  const soldOut = await json(await phone.post('/api/public/carts', { restaurantId, items: [{ itemId: items['Whole tilapia'], quantity: 1 }] }), 409);
  expect(soldOut.details.reason).toBe('sold_out');
  await json(await phone.post('/api/public/carts', { restaurantId, items: [{ itemId: items['Kenyan chai'], quantity: 21 }] }), 400);
  await json(await phone.post('/api/public/carts', { restaurantId, items: [] }), 400);
  await json(await phone.post('/api/public/carts', { restaurantId: '00000000-0000-4000-8000-000000000000', items: [{ itemId: items['Kenyan chai'] }] }), 404);

  // Staff see "Table 2 is ready to order" on the live screen.
  const ready = await json(await waiter.get('/api/ops/live'), 200);
  // The live feed never carries the guest's code: holding it is the proof the waiter is at the table.
  expect(JSON.stringify(ready)).not.toContain(saved.code);
  expect(ready.readyToOrder.find((cart) => cart.tableNumber === 2)).toMatchObject({
    type: 'ready_to_order', tableNumber: 2, itemCount: 3, total: 1650, currency: 'KES',
  });
  expect(ready.summary.readyToOrder).toBeGreaterThanOrEqual(1);
  expect(ready.tables.find((t) => t.number === 2).readyToOrder).toBe(true);
  // The guest's phone is waiting.
  expect(await json(await phone.get(`/api/public/carts/${saved.code}/status?restaurantId=${restaurantId}`), 200)).toMatchObject({ status: 'ready' });

  // The waiter looks the cart up by code (case and dashes don't matter).
  const typed = `${saved.code.slice(0, 3).toLowerCase()}-${saved.code.slice(3)}`;
  const { cart } = await json(await waiter.get(`/api/ops/carts/${typed}`), 200);
  expect(cart).toMatchObject({ code: saved.code, total: 1650, table: { number: 2 }, hasUnavailableItems: false });
  expect(cart.items).toHaveLength(2);
  await json(await waiter.get('/api/ops/carts/ACDACD'), 404);

  // A bad `via` hint is refused before anything is claimed.
  await json(await waiter.post('/api/ops/orders', { cartCode: saved.code, via: 'telepathy' }), 400);
  // Confirming it creates a "Confirmed" order by the waiter, priced from the menu.
  const created = await json(await waiter.post('/api/ops/orders', { cartCode: saved.code, via: 'typed' }), 200);
  const order = created.order;
  expect(order).toMatchObject({
    status: 'taken', statusLabel: 'Confirmed', source: 'guest_cart', total: 1650, subtotal: 1650, currency: 'KES',
    table: { number: 2 }, nextAction: 'serve', takenBy: { id: ctx.waiter.id, name: 'Ops Waiter' }, canCancel: true,
    payment: { status: 'unpaid' },
  });
  expect(order.shortId).toBe(order.id.slice(0, 6));
  expect(order.items.map((line) => [line.name, line.quantity, line.note])).toEqual([['Chicken wings', 2, 'Extra spicy'], ['Kenyan chai', 1, null]]);
  expect(order.timeline.map((step) => [step.stage, step.label, Boolean(step.at), step.by?.name ?? null])).toEqual([
    ['taken', 'Confirmed', true, 'Ops Waiter'], ['served', 'Served', false, null], ['paid', 'Paid', false, null],
  ]);
  ctx.paidOrder = order;

  // The cart can't be imported twice or edited after it was entered.
  const again = await json(await waiter.get(`/api/ops/carts/${saved.code}`), 409);
  expect(again.details.shortId).toBe(order.shortId);
  await json(await waiter.post('/api/ops/orders', { cartCode: saved.code }), 409);
  await json(await phone.post('/api/public/carts', { restaurantId, code: saved.code, items: [{ itemId: items['Kenyan chai'] }] }), 409);

  // It shows on the live screen; table 2 is ordering and no longer ready to order; the cursor moved.
  const live = await json(await waiter.get('/api/ops/live'), 200);
  expect(live.cursor).not.toBe(ready.cursor);
  expect(live.orders.map((o) => o.id)).toContain(order.id);
  expect(live.readyToOrder.map((cart) => cart.tableNumber)).not.toContain(2);
  expect(live.tables.find((t) => t.number === 2)).toMatchObject({ state: 'ordering', openOrders: 1, unpaidTotal: 1650 });

  // The guest's phone sees it confirmed, with the waiter's first name and the order number.
  expect(await json(await phone.get(`/api/public/carts/${saved.code}/status?restaurantId=${restaurantId}`), 200)).toMatchObject({
    status: 'confirmed', confirmedBy: 'Ops', orderShortId: order.shortId,
  });
  // Another phone can't read it.
  await json(await guest(request, visitor('nosy')).get(`/api/public/carts/${saved.code}/status?restaurantId=${restaurantId}`), 404);

  // taken (Confirmed) -> served -> paid. There is no accept step.
  await json(await waiter.post(`/api/ops/orders/${order.id}/advance`, { from: 'accepted' }), 409);
  const served = (await json(await waiter.post(`/api/ops/orders/${order.id}/advance`, { from: 'taken' }), 200)).order;
  expect(served).toMatchObject({ status: 'served', statusLabel: 'Served', nextAction: 'pay', servedBy: { id: ctx.waiter.id } });
  await json(await waiter.post(`/api/ops/orders/${order.id}/advance`), 409);
  await json(await waiter.post(`/api/ops/orders/${order.id}/pay`, { method: 'bitcoin' }), 400);
  const paid = (await json(await waiter.post(`/api/ops/orders/${order.id}/pay`, { method: 'M-Pesa', reference: 'SKL4ABC12X' }), 200)).order;
  expect(paid).toMatchObject({
    status: 'paid', statusLabel: 'Paid', nextAction: null, canCancel: false, paidBy: { id: ctx.waiter.id },
    payment: { status: 'paid', method: 'mpesa', reference: 'SKL4ABC12X', amount: 1650, provider: 'manual' },
  });

  const detail = (await json(await waiter.get(`/api/ops/orders/${order.id}`), 200)).order;
  expect(detail.timeline.every((step) => step.at && step.by?.id === ctx.waiter.id)).toBe(true);
  const listed = await json(await waiter.get(`/api/ops/orders?q=%23${order.shortId}&status=paid,served`), 200);
  expect(listed.orders.map((o) => o.id)).toContain(order.id);
  expect(listed).toMatchObject({ limit: 50, offset: 0 });
  const live2 = await json(await waiter.get('/api/ops/live'), 200);
  expect(live2.orders.map((o) => o.id)).not.toContain(order.id);
});

test('invalid order transitions return 409 and cancelling follows the rules', async ({ request }) => {
  const waiter = as(request, ctx.waiterToken);
  const owner = as(request, ctx.ownerToken);
  const { items } = ctx;

  // Manual entry from what the guest says (no phone).
  const order = (await json(await waiter.post('/api/ops/orders', { tableNumber: 3, items: [{ itemId: items['Chicken wings'], quantity: 1 }], note: 'Window seat' }), 200)).order;
  expect(order).toMatchObject({ status: 'taken', statusLabel: 'Confirmed', nextAction: 'serve', source: 'waiter', total: 750, note: 'Window seat', table: { number: 3 } });
  await json(await waiter.post(`/api/ops/orders/${order.id}/pay`, { method: 'cash' }), 409); // not served yet
  const stale = await json(await waiter.post(`/api/ops/orders/${order.id}/advance`, { from: 'accepted' }), 409);
  expect(stale.details.status).toBe('taken');
  // The waiter who confirmed it may cancel while it's still Confirmed.
  const cancelled = (await json(await waiter.post(`/api/ops/orders/${order.id}/cancel`, { reason: 'Entered twice' }), 200)).order;
  expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Entered twice', cancelledBy: { id: ctx.waiter.id }, nextAction: null });
  await json(await waiter.post(`/api/ops/orders/${order.id}/advance`), 409);
  await json(await waiter.post(`/api/ops/orders/${order.id}/pay`, { method: 'cash' }), 409);
  await json(await owner.post(`/api/ops/orders/${order.id}/cancel`), 409);

  // Once served, only a manager can cancel.
  const second = (await json(await waiter.post('/api/ops/orders', { tableNumber: 3, items: [{ itemId: items['Kenyan chai'], quantity: 2 }] }), 200)).order;
  expect((await json(await owner.post(`/api/ops/orders/${second.id}/advance`, { from: 'taken' }), 200)).order.status).toBe('served');
  const refused = await json(await waiter.post(`/api/ops/orders/${second.id}/cancel`), 403);
  expect(refused.error).toContain('served');
  await json(await owner.post(`/api/ops/orders/${second.id}/cancel`, { reason: 'Guest left' }), 200);

  // A paid order can't be cancelled.
  await json(await owner.post(`/api/ops/orders/${ctx.paidOrder.id}/cancel`), 409);
  await json(await owner.post(`/api/ops/orders/${ctx.paidOrder.id}/pay`, { method: 'cash' }), 409);

  // Bad input.
  await json(await waiter.post('/api/ops/orders', { tableNumber: 3, items: [{ itemId: items['Whole tilapia'], quantity: 1 }] }), 409);
  await json(await waiter.post('/api/ops/orders', { tableNumber: 99, items: [{ itemId: items['Kenyan chai'] }] }), 404);
  await json(await waiter.post('/api/ops/orders', { items: [{ itemId: items['Kenyan chai'] }] }), 400);
  await json(await waiter.get('/api/ops/orders?status=lost'), 400);
  await json(await waiter.get('/api/ops/orders/00000000-0000-4000-8000-000000000000'), 404);
});

test('guest requests dedupe, then staff acknowledge and resolve them', async ({ request }) => {
  const phone = guest(request, visitor('requests'));
  const waiter = as(request, ctx.waiterToken);
  const { restaurantId } = ctx;

  const before = await json(await waiter.get('/api/ops/live'), 200);
  const unchanged = await json(await waiter.get(`/api/ops/live?since=${before.cursor}`), 200);
  expect(unchanged).toEqual({ changed: false, cursor: before.cursor, serverTime: expect.any(String) });

  const first = await json(await phone.post('/api/public/requests', { restaurantId, tableNumber: 1, type: 'call_waiter' }), 200);
  expect(first).toMatchObject({ deduped: false, request: { type: 'call_waiter', status: 'open' } });
  const duplicate = await json(await phone.post('/api/public/requests', { restaurantId, tableNumber: 1, type: 'call_waiter' }), 200);
  expect(duplicate).toMatchObject({ deduped: true, request: { id: first.request.id } });
  const bill = await json(await phone.post('/api/public/requests', { restaurantId, tableNumber: 1, type: 'bill' }), 200);
  expect(bill.request.id).not.toBe(first.request.id);
  await json(await phone.post('/api/public/requests', { restaurantId, tableNumber: 1, type: 'dessert' }), 400);
  await json(await phone.post('/api/public/requests', { restaurantId, tableNumber: 77, type: 'bill' }), 404);

  const mine = await json(await request.get(`/api/public/requests?restaurantId=${restaurantId}&tableNumber=1`), 200);
  expect(mine.requests.map((r) => r.type).sort()).toEqual(['bill', 'call_waiter']);

  const live = await json(await waiter.get(`/api/ops/live?since=${before.cursor}`), 200);
  expect(live.changed).toBe(true);
  expect(live.requests.filter((r) => r.table.number === 1).map((r) => r.type).sort()).toEqual(['bill', 'call_waiter']);
  expect(live.tables.find((t) => t.number === 1).state).toBe('bill');
  expect(live.requests[0].ageSeconds).toEqual(expect.any(Number));

  const acknowledged = (await json(await waiter.post(`/api/ops/requests/${first.request.id}/acknowledge`), 200)).request;
  expect(acknowledged).toMatchObject({ status: 'acknowledged', acknowledgedBy: { id: ctx.waiter.id, name: 'Ops Waiter' } });
  await json(await waiter.post(`/api/ops/requests/${first.request.id}/acknowledge`), 200); // harmless twice
  const seen = await json(await request.get(`/api/public/requests?restaurantId=${restaurantId}&tableNumber=1`), 200);
  expect(seen.requests.find((r) => r.id === first.request.id).status).toBe('acknowledged');

  const resolved = (await json(await waiter.post(`/api/ops/requests/${first.request.id}/resolve`), 200)).request;
  expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: { id: ctx.waiter.id } });
  await json(await waiter.post(`/api/ops/requests/${first.request.id}/resolve`), 200);
  await json(await waiter.post(`/api/ops/requests/${first.request.id}/acknowledge`), 409);
  await json(await waiter.post(`/api/ops/requests/${bill.request.id}/resolve`), 200);

  // After it's resolved, a new tap opens a new request.
  const next = await json(await phone.post('/api/public/requests', { restaurantId, tableNumber: 1, type: 'call_waiter' }), 200);
  expect(next.request.id).not.toBe(first.request.id);
  await json(await waiter.post(`/api/ops/requests/${next.request.id}/resolve`), 200);

  // Abuse limit: 10 per visitor per 10 minutes.
  const spammer = guest(request, visitor('spam'));
  for (let index = 0; index < 10; index++) await json(await spammer.post('/api/public/requests', { restaurantId, tableNumber: 4, type: 'call_waiter' }), 200);
  const limited = await json(await spammer.post('/api/public/requests', { restaurantId, tableNumber: 4, type: 'call_waiter' }), 429);
  expect(limited.error).toMatch(/wait a few minutes/);
});

test('menu opens are logged as scans, deduped per visitor and table', async ({ request }) => {
  const { restaurantId } = ctx;
  const count = async () => {
    const { count: n, error } = await service.from('menu_scans').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId);
    if (error) throw error;
    return n;
  };
  const start = await count();
  const phone = guest(request, visitor('scan-a'));
  const menu = await json(await phone.get(`/api/public/menu/${restaurantId}?t=2`), 200);
  expect(menu.table).toEqual({ id: expect.any(String), number: 2 });
  expect(menu.items.map((item) => item.name).sort()).toEqual(['Chicken wings', 'Kenyan chai']);
  expect(Object.keys(menu.items[0])).toEqual(expect.arrayContaining(['photoUrl', 'videoUrl', 'videoPosterUrl', 'videoDurationSeconds']));
  await json(await phone.get(`/api/public/menu/${restaurantId}?t=2`), 200); // same visitor and table: deduped
  await json(await phone.get(`/api/public/menu/${restaurantId}?t=3`), 200); // another table counts
  await expect.poll(count, { timeout: 10000 }).toBe(start + 2);
  await json(await guest(request, visitor('scan-b')).get(`/api/public/menu/${restaurantId}?t=2`), 200); // another visitor counts
  await expect.poll(count, { timeout: 10000 }).toBe(start + 3);
  const { data: rows } = await service.from('menu_scans').select('visitor_id').eq('restaurant_id', restaurantId).not('visitor_id', 'is', null).limit(1);
  expect(rows[0].visitor_id).not.toContain('scan-a'); // stored hashed
});

test('analytics, tables and health have the documented shape', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const week = await json(await owner.get('/api/ops/analytics?range=7d'), 200);
  expect(Object.keys(week)).toEqual(expect.arrayContaining(['range', 'timeZone', 'from', 'to', 'totals', 'previousTotals', 'seriesUnit', 'series', 'bestSellers', 'soldOut', 'topTablesByScans', 'topTablesByRevenue']));
  expect(week).toMatchObject({ range: '7d', timeZone: 'Africa/Nairobi', currency: 'KES', seriesUnit: 'day' });
  expect(week.totals).toMatchObject({ menuScans: expect.any(Number), sales: 1650, openBills: { count: 0, amount: 0 }, tablesServed: 1, orders: 1 });
  expect(week.totals.menuScans).toBeGreaterThanOrEqual(3);
  expect(week.previousTotals).toMatchObject({ sales: 0, openBills: null });
  expect(week.series).toHaveLength(7);
  expect(week.series[6]).toMatchObject({ label: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), sales: 1650 });
  expect(week.bestSellers[0]).toMatchObject({ name: 'Chicken wings', quantity: 2, revenue: 1500 });
  expect(week.soldOut.map((item) => item.name)).toEqual(['Whole tilapia']);
  expect(week.topTablesByRevenue[0]).toMatchObject({ number: 2, revenue: 1650 });
  expect(week.topTablesByScans[0]).toMatchObject({ number: 2, scans: 2 });

  const today = await json(await owner.get('/api/ops/analytics'), 200);
  expect(today).toMatchObject({ range: 'today', seriesUnit: 'hour' });
  expect(today.series.at(-1).label).toMatch(/^\d{2}:00$/);
  await json(await owner.get('/api/ops/analytics?range=year'), 400);

  const { tables } = await json(await owner.get('/api/ops/tables'), 200);
  expect(tables.map((t) => t.number)).toEqual([1, 2, 3, 4]);
  expect(tables.find((t) => t.number === 2)).toMatchObject({
    state: 'free', scans: { last7Days: 2, allTime: 2 }, revenue: { last30Days: 1650, allTime: 1650 }, openOrders: 0,
    guestMenuPath: `/guest-menu?r=${ctx.restaurantId}&t=2`,
  });
  const detail = await json(await owner.get('/api/ops/tables/2'), 200);
  expect(detail.scansByDay).toHaveLength(14);
  expect(detail.table).toMatchObject({ number: 2, guestMenuPath: `/guest-menu?r=${ctx.restaurantId}&t=2` });
  expect(detail.recentOrders[0].id).toBe(ctx.paidOrder.id);
  await json(await owner.get('/api/ops/tables/42'), 404);

  const health = await json(await owner.get('/api/ops/health'), 200);
  expect(['ok', 'warning']).toContain(health.status);
  expect(health.database).toMatchObject({ ok: true, latencyMs: expect.any(Number) });
  expect(health.menu).toMatchObject({ live: true, availableItems: 2, unavailableItems: 1 });
  expect(health.staff).toMatchObject({ active: 1, invited: 0 });
  expect(health.checks.map((c) => c.key)).toEqual(['api', 'database', 'menu', 'scans', 'orders', 'staff', 'soldOut']);
});

test('tables can be added, and deleting one is refused while it has unpaid orders', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const waiter = as(request, ctx.waiterToken);
  const added = await json(await owner.post('/api/ops/tables', { count: 2 }), 200);
  expect(added.tables.map((t) => t.number)).toEqual([5, 6]);
  expect(added.total).toBe(6);
  await json(await owner.post('/api/ops/tables', { number: 6 }), 409);
  expect((await json(await owner.post('/api/ops/tables', { number: 10 }), 200)).tables[0].number).toBe(10);
  await json(await owner.post('/api/ops/tables', {}), 400);
  await json(await waiter.post('/api/ops/tables', { count: 1 }), 403);
  await json(await waiter.delete('/api/ops/tables/10'), 403);

  const order = (await json(await waiter.post('/api/ops/orders', { tableNumber: 6, items: [{ itemId: ctx.items['Kenyan chai'] }] }), 200)).order;
  const refused = await json(await owner.delete('/api/ops/tables/6'), 409);
  expect(refused).toMatchObject({ error: 'Table 6 has 1 unpaid order. Finish or cancel it first.', details: { openOrders: 1 } });
  await json(await owner.post(`/api/ops/orders/${order.id}/cancel`), 200);
  expect((await owner.delete('/api/ops/tables/6')).status()).toBe(204);
  expect((await owner.delete('/api/ops/tables/5')).status()).toBe(204);
  expect((await owner.delete('/api/ops/tables/10')).status()).toBe(204);
  await json(await owner.delete('/api/ops/tables/6'), 404);
  const { tables } = await json(await owner.get('/api/ops/tables'), 200);
  expect(tables.map((t) => t.number)).toEqual([1, 2, 3, 4]);
  // The cancelled order keeps its table number after the table is gone.
  expect((await json(await owner.get(`/api/ops/orders/${order.id}`), 200)).order.table).toEqual({ id: null, number: 6 });
});

test('dish video, sold-out toggle and reordering on the menu API', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const waiter = as(request, ctx.waiterToken);
  const folder = `${env.SUPABASE_URL}/storage/v1/object/public/restaurant-media/${ctx.restaurantId}`;
  const wings = ctx.items['Chicken wings'];
  const { item } = await json(await owner.patch(`/api/restaurant/items/${wings}`, {
    videoUrl: `${folder}/videos/wings.mp4`, videoPosterUrl: `${folder}/posters/wings.jpg`, videoDurationSeconds: 12.4,
  }), 200);
  expect(item).toMatchObject({ videoUrl: `${folder}/videos/wings.mp4`, videoPosterUrl: `${folder}/posters/wings.jpg`, videoDurationSeconds: 12.4 });
  await json(await owner.patch(`/api/restaurant/items/${wings}`, { videoDurationSeconds: 16 }), 400);
  await json(await owner.patch(`/api/restaurant/items/${wings}`, { videoUrl: `${env.SUPABASE_URL}/storage/v1/object/public/restaurant-media/00000000-0000-4000-8000-000000000000/videos/x.mp4` }), 400);
  const cleared = (await json(await owner.patch(`/api/restaurant/items/${wings}`, { videoUrl: null }), 200)).item;
  expect(cleared).toMatchObject({ videoUrl: null, videoPosterUrl: null, videoDurationSeconds: null });

  const soldOut = (await json(await owner.patch(`/api/restaurant/items/${ctx.items['Kenyan chai']}`, { available: false }), 200)).item;
  expect(soldOut.available).toBe(false);
  await json(await owner.patch(`/api/restaurant/items/${ctx.items['Kenyan chai']}`, { available: true }), 200);
  await json(await waiter.patch(`/api/restaurant/items/${wings}`, { available: false }), 403);

  const { categories } = await json(await owner.put('/api/restaurant/categories/order', { ids: [ctx.categories.drinks, ctx.categories.mains] }), 200);
  expect(categories.map((c) => c.name)).toEqual(['Drinks', 'Mains']);
  await json(await owner.put('/api/restaurant/categories/order', { ids: [ctx.categories.drinks] }), 400);
  const moved = await json(await owner.put('/api/restaurant/items/order', { categoryId: ctx.categories.drinks, ids: [wings, ctx.items['Kenyan chai']] }), 200);
  expect(moved.items.map((i) => [i.name, i.position])).toEqual([['Chicken wings', 0], ['Kenyan chai', 1]]);
});

test('waiters can’t read analytics or health, and other restaurants’ data is invisible', async ({ request }) => {
  const waiter = as(request, ctx.waiterToken);
  await json(await waiter.get('/api/ops/analytics?range=7d'), 403);
  await json(await waiter.get('/api/ops/health'), 403);
  expect((await request.get('/api/ops/live')).status()).toBe(401);
  expect((await request.get('/api/ops/orders', { headers: auth('invalid') })).status()).toBe(401);

  // Fresh things in the throwaway restaurant...
  const phone = guest(request, visitor('cross'));
  const cart = await json(await phone.post('/api/public/carts', { restaurantId: ctx.restaurantId, tableNumber: 3, items: [{ itemId: ctx.items['Kenyan chai'] }] }), 200);
  const call = await json(await phone.post('/api/public/requests', { restaurantId: ctx.restaurantId, tableNumber: 3, type: 'call_waiter' }), 200);
  const order = ctx.paidOrder;

  // ...are invisible to the Demo Restaurant's owner.
  const demo = await signIn('owner@gmail.com', '12344321');
  const other = as(request, demo.token);
  await json(await other.get(`/api/ops/orders/${order.id}`), 404);
  await json(await other.post(`/api/ops/orders/${order.id}/cancel`), 404);
  await json(await other.get(`/api/ops/carts/${cart.code}`), 404);
  await json(await other.post(`/api/ops/requests/${call.request.id}/acknowledge`), 404);
  const theirs = await json(await other.get(`/api/ops/orders?q=${order.shortId}`), 200);
  expect(theirs.orders.map((o) => o.id)).not.toContain(order.id);
  const theirLive = await json(await other.get('/api/ops/live'), 200);
  expect(theirLive.requests.map((r) => r.id)).not.toContain(call.request.id);

  // Row Level Security agrees when querying Supabase directly.
  const { data: rows, error } = await demo.client.from('orders').select('id').eq('id', order.id);
  expect(error).toBeNull();
  expect(rows).toEqual([]);
  const carts = await demo.client.from('guest_carts').select('id').limit(1);
  expect(carts.error).not.toBeNull();
  const payload = await demo.client.from('payments').select('raw_payload').limit(1);
  expect(payload.error).not.toBeNull();
  await demo.client.auth.signOut({ scope: 'local' });
});
