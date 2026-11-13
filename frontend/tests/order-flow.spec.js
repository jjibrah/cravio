import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

// The agreed order flow (docs/ORDER-FLOW.md), end to end:
// guest "Ready to order" → staff see "Table N is ready to order" → the waiter scans the QR (or types the code) →
// "Check with the guest" → Confirm order (Confirmed, no accept step) → the guest's phone shows "Order confirmed ✓"
// → Mark served → Mark paid. A manual order is marked "not confirmed by the guest". Owners see how each order was
// confirmed, and extras and deal contents on every order line.
//
// NEEDS MIGRATION 005 (backend/db/migrations/005_order_confirmation.sql: orders.confirmation, guest_carts.ready_at).
// Every test here fails in beforeAll with a clear message until it is applied (npm run db:migrate).
// Needs 003 and 004 too. Everything happens in a throwaway restaurant created here and deleted in afterAll.

const service = createAdmin();
const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `Flow-${stamp}-pw`;
const ctx = { users: [], restaurantId: null };
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const unwrap = (result, what) => { if (result.error) throw new Error(`${what}: ${result.error.message}`); return result.data; };
const visitor = (label) => `flow-${label}-${stamp}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const CLOCK = '\\d{2}:\\d{2}';

async function createUser(role, name) {
  const email = `cravio-flow-${role}-${stamp}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { name }, app_metadata: { role } });
  if (error) throw new Error(`Could not create the ${role}: ${error.message}`);
  ctx.users.push(data.user.id);
  unwrap(await service.from('profiles').upsert({ id: data.user.id, name, role }), 'profile');
  return { id: data.user.id, email, name };
}

async function token(email) {
  const client = createClient(env.SUPABASE_URL, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  return data.session.access_token;
}

async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const as = (request, bearer) => ({
  get: (path) => request.get(path, { headers: { Authorization: `Bearer ${bearer}` } }),
  post: (path, data = {}) => request.post(path, { headers: { Authorization: `Bearer ${bearer}` }, data }),
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
const orderRow = async (id) => unwrap(await service.from('orders').select('status, confirmation, accepted_at, served_at, paid_at').eq('id', id).single(), 'order');

test.describe.configure({ mode: 'serial' });
test.setTimeout(150000);

test.beforeAll(async () => {
  test.setTimeout(90000);
  // Fail loudly (not skip) until 005 is applied.
  const probe = await service.from('orders').select('confirmation').limit(1);
  const carts = await service.from('guest_carts').select('ready_at').limit(1);
  if (probe.error || carts.error) {
    throw new Error('Migration 005 is not applied (orders.confirmation / guest_carts.ready_at missing). Run `npm run db:migrate`, then run order-flow.spec.js again.');
  }
  ctx.owner = await createUser('owner', 'Fl Owner');
  ctx.waiter = await createUser('waiter', 'Fl Waiter');
  const restaurant = unwrap(await service.from('restaurants').insert({
    owner_id: ctx.owner.id, name: `Order Flow ${stamp}`, status: 'live', went_live_at: new Date().toISOString(), area: 'Kilimani, Nairobi',
  }).select('id').single(), 'restaurant');
  ctx.restaurantId = restaurant.id;
  unwrap(await service.from('restaurant_members').insert([
    { restaurant_id: restaurant.id, user_id: ctx.owner.id, role: 'owner' },
    { restaurant_id: restaurant.id, user_id: ctx.waiter.id, role: 'waiter' },
  ]), 'members');
  unwrap(await service.from('restaurant_tables').insert([1, 2, 3, 4, 5].map((number) => ({ restaurant_id: restaurant.id, number }))), 'tables');
  const [mains, drinks] = unwrap(await service.from('menu_categories').insert([
    { restaurant_id: restaurant.id, name: 'Mains', position: 0 }, { restaurant_id: restaurant.id, name: 'Drinks', position: 1 },
  ]).select('id, position').order('position'), 'categories');
  const items = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Classic beef burger', price: 950, position: 0, available: true },
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Chips', price: 250, position: 1, available: true },
    { restaurant_id: restaurant.id, category_id: drinks.id, name: 'Kenyan chai', price: 150, position: 0, available: true },
  ]).select('id, name'), 'items');
  ctx.items = Object.fromEntries(items.map((item) => [item.name, item.id]));
  const [cheese] = unwrap(await service.from('menu_item_extras').insert([
    { restaurant_id: restaurant.id, item_id: ctx.items['Classic beef burger'], name: 'Cheese', price: 150, position: 0 },
  ]).select('id'), 'extras');
  ctx.cheese = cheese.id;
  const deal = unwrap(await service.from('menu_deals').insert({ restaurant_id: restaurant.id, name: 'Burger meal', price: 1150, position: 0 }).select('id').single(), 'deal');
  unwrap(await service.from('menu_deal_items').insert([
    { deal_id: deal.id, restaurant_id: restaurant.id, item_id: ctx.items['Classic beef burger'], quantity: 1, position: 0 },
    { deal_id: deal.id, restaurant_id: restaurant.id, item_id: ctx.items.Chips, quantity: 1, position: 1 },
    { deal_id: deal.id, restaurant_id: restaurant.id, item_id: ctx.items['Kenyan chai'], quantity: 1, position: 2 },
  ]), 'deal items');
  ctx.dealId = deal.id;
  ctx.waiterToken = await token(ctx.waiter.email);
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

test('API: ready to order → confirmed by QR, by typed code, or entered by hand → served → paid, never accepted', async ({ request }) => {
  const waiter = as(request, ctx.waiterToken);
  const { restaurantId, items } = ctx;

  // Ready to order: the cart is saved and marked ready.
  const phoneA = guest(request, visitor('a'));
  const saved = await json(await phoneA.post('/api/public/carts', { restaurantId, tableNumber: 1, items: [{ itemId: items['Kenyan chai'], quantity: 2 }] }), 200);
  expect(saved).toMatchObject({ status: 'ready' });
  const stored = unwrap(await service.from('guest_carts').select('ready_at').eq('code', saved.code).eq('restaurant_id', restaurantId).single(), 'cart');
  expect(stored.ready_at).toBeTruthy();
  const before = await json(await waiter.get('/api/ops/live'), 200);
  expect(before.readyToOrder).toEqual([expect.objectContaining({ type: 'ready_to_order', tableNumber: 1, id: expect.any(String), itemCount: 2, total: 300, readyAt: expect.any(String) })]);
  // Unchanged: the cursor says so.
  expect(await json(await waiter.get(`/api/ops/live?since=${before.cursor}`), 200)).toMatchObject({ changed: false });
  expect(await json(await phoneA.get(`/api/public/carts/${saved.code}/status?restaurantId=${restaurantId}`), 200)).toMatchObject({ status: 'ready' });

  // Scanned QR: confirmation 'qr'.
  const qr = (await json(await waiter.post('/api/ops/orders', { cartCode: saved.code, via: 'scan' }), 200)).order;
  expect(qr).toMatchObject({ status: 'taken', statusLabel: 'Confirmed', nextAction: 'serve', confirmation: 'qr', confirmationLabel: 'Confirmed with the guest (QR)', source: 'guest_cart' });
  expect(qr.timeline).toEqual([
    expect.objectContaining({ stage: 'taken', label: 'Confirmed', confirmation: 'qr', by: { id: ctx.waiter.id, name: 'Fl Waiter' } }),
    expect.objectContaining({ stage: 'served', at: null }), expect.objectContaining({ stage: 'paid', at: null }),
  ]);
  expect((await orderRow(qr.id)).confirmation).toBe('qr');
  // The alert clears and the cursor moves; the guest's phone sees "confirmed".
  const after = await json(await waiter.get(`/api/ops/live?since=${before.cursor}`), 200);
  expect(after.changed).toBe(true);
  expect(after.readyToOrder).toEqual([]);
  expect(await json(await phoneA.get(`/api/public/carts/${saved.code}/status?restaurantId=${restaurantId}`), 200)).toEqual({
    status: 'confirmed', confirmedBy: 'Fl', confirmedAt: expect.any(String), orderShortId: qr.shortId,
  });

  // Confirmed → served → paid. No accepted time is recorded.
  const served = (await json(await waiter.post(`/api/ops/orders/${qr.id}/advance`, { from: 'taken' }), 200)).order;
  expect(served).toMatchObject({ status: 'served', nextAction: 'pay', acceptedAt: null });
  await json(await waiter.post(`/api/ops/orders/${qr.id}/advance`, { from: 'served' }), 409);
  const paid = (await json(await waiter.post(`/api/ops/orders/${qr.id}/pay`, { from: 'served', method: 'cash' }), 200)).order;
  expect(paid.timeline.map((step) => [step.stage, Boolean(step.at)])).toEqual([['taken', true], ['served', true], ['paid', true]]);
  expect(await orderRow(qr.id)).toMatchObject({ status: 'paid', confirmation: 'qr', accepted_at: null });

  // Typed code (or no hint): confirmation 'code'.
  const phoneB = guest(request, visitor('b'));
  const typedCart = await json(await phoneB.post('/api/public/carts', { restaurantId, tableNumber: 2, items: [{ itemId: items.Chips }] }), 200);
  const typed = (await json(await waiter.post('/api/ops/orders', { cartCode: typedCart.code, via: 'typed' }), 200)).order;
  expect(typed).toMatchObject({ confirmation: 'code', confirmationLabel: 'Confirmed with the guest (typed code)' });
  const hintless = await json(await guest(request, visitor('c')).post('/api/public/carts', { restaurantId, tableNumber: 2, items: [{ itemId: items.Chips }] }), 200);
  expect((await json(await waiter.post('/api/ops/orders', { cartCode: hintless.code }), 200)).order.confirmation).toBe('code');

  // No cart: manual, entered by the waiter and not confirmed by the guest. `via` doesn't change that.
  const manual = (await json(await waiter.post('/api/ops/orders', { tableNumber: 3, items: [{ itemId: items.Chips }], via: 'scan' }), 200)).order;
  expect(manual).toMatchObject({ status: 'taken', confirmation: 'manual', confirmationLabel: 'Entered by waiter, not confirmed by the guest', source: 'waiter' });
  expect(manual.timeline[0]).toMatchObject({ stage: 'taken', label: 'Entered', confirmation: 'manual' });

  // An expired code reads as expired for the guest and is gone from the live screen.
  const phoneD = guest(request, visitor('d'));
  const old = await json(await phoneD.post('/api/public/carts', { restaurantId, tableNumber: 4, items: [{ itemId: items.Chips }] }), 200);
  unwrap(await service.from('guest_carts').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('code', old.code).eq('restaurant_id', restaurantId), 'expire');
  expect(await json(await phoneD.get(`/api/public/carts/${old.code}/status?restaurantId=${restaurantId}`), 200)).toMatchObject({ status: 'expired' });
  expect((await json(await waiter.get('/api/ops/live'), 200)).readyToOrder.map((c) => c.tableNumber)).not.toContain(4);
  await json(await waiter.post('/api/ops/orders', { cartCode: old.code }), 410);
});

test('phones: guest Ready to order → waiter types the code from Services → Check with the guest → Confirm → guest sees "Order confirmed ✓" → served → paid', async ({ browser, request }) => {
  const guestPage = await (await browser.newContext(phone)).newPage();
  await guestPage.goto(`/guest-menu?r=${ctx.restaurantId}&t=5`);
  await guestPage.getByRole('button', { name: 'Classic beef burger', exact: true }).click();
  const dish = guestPage.getByRole('dialog', { name: 'Classic beef burger' });
  await dish.getByRole('group', { name: 'Extras for Classic beef burger' }).getByRole('button', { name: /Cheese/ }).click();
  await dish.getByRole('button', { name: /Add to order · Ksh 1,100/ }).click();
  await guestPage.getByRole('button', { name: 'Add Burger meal' }).click();
  await guestPage.getByRole('button', { name: /2 items · Ksh 2,250/ }).click();
  await guestPage.getByRole('dialog', { name: 'Your order' }).getByRole('button', { name: 'Ready to order' }).click();
  const card = guestPage.getByRole('dialog', { name: 'Ready to order' });
  await expect(card.getByText('A waiter is on the way. Show them this code.')).toBeVisible({ timeout: 20000 });
  const code = (await card.locator('.gx-code').getAttribute('aria-label')).replace(/^Code /, '').replace(/\s/g, '');

  const waiter = await (await browser.newContext(phone)).newPage();
  await signIn(waiter, ctx.waiter.email);
  await expect(waiter.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible({ timeout: 20000 });
  await waiter.goto('/waiter/services');
  const ready = waiter.getByRole('article', { name: 'Table 5 is ready to order' });
  await expect(ready).toBeVisible({ timeout: 20000 });
  await expect(ready.getByText(/2 items · Ksh 2,250/)).toBeVisible();
  await expect(ready.getByText(code)).toHaveCount(0); // the code is never shown to staff
  await expect(ready.getByRole('button', { name: 'Scan code' })).toBeVisible();
  await ready.getByRole('button', { name: 'Type code' }).click();
  const sheet = waiter.getByRole('dialog', { name: 'Type the guest’s code' });
  await sheet.getByRole('textbox').fill(code.toLowerCase());
  await sheet.getByRole('button', { name: 'Open the guest’s order' }).click();
  await expect(waiter).toHaveURL(new RegExp(`/waiter/cart/${code}\\?via=typed`));

  await expect(waiter.getByRole('heading', { name: 'Check with the guest' })).toBeVisible({ timeout: 20000 });
  const lines = waiter.getByRole('list', { name: 'Order lines' });
  await expect(lines.getByText('+ Cheese')).toBeVisible();
  await expect(lines.getByText('Classic beef burger, Chips, Kenyan chai')).toBeVisible();
  await expect(waiter.getByText('Is that all?')).toBeVisible();
  await expect(waiter.getByRole('button', { name: /Accept/ })).toHaveCount(0);
  await waiter.getByRole('button', { name: /Confirm order · Ksh 2,250/ }).click();
  await expect(waiter.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 20000 });

  const done = guestPage.getByRole('dialog', { name: 'Order confirmed ✓' });
  await expect(done).toBeVisible({ timeout: 20000 });
  await expect(done.getByText(new RegExp(`^Fl confirmed your order at ${CLOCK} · #[0-9a-f]{6}$`))).toBeVisible();
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(guestPage.getByRole('button', { name: /items · Ksh/ })).toHaveCount(0); // the cart reset

  const [{ id: orderId }] = unwrap(await service.from('orders').select('id').eq('restaurant_id', ctx.restaurantId).eq('table_number', 5), 'order');
  ctx.typedOrder = orderId;
  expect(await orderRow(orderId)).toMatchObject({ status: 'taken', confirmation: 'code' });

  await waiter.getByRole('link', { name: 'Go to Services' }).click();
  await expect(waiter.getByRole('article', { name: 'Table 5 is ready to order' })).toHaveCount(0, { timeout: 20000 });
  const order = waiter.getByRole('article', { name: /Confirmed · to serve Table 5/ });
  await expect(order).toBeVisible({ timeout: 20000 });
  await order.getByRole('button', { name: 'Mark served' }).click();
  const served = waiter.getByRole('article', { name: /Served · waiting to pay Table 5/ });
  await served.getByRole('button', { name: 'Mark paid' }).click({ timeout: 20000 });
  await served.getByRole('radio', { name: 'Cash' }).click();
  await served.getByRole('button', { name: 'Mark paid · Ksh 2,250' }).click();
  await expect(waiter.getByRole('article', { name: /Table 5/ })).toHaveCount(0, { timeout: 20000 });
  expect(await orderRow(orderId)).toMatchObject({ status: 'paid', confirmation: 'code', accepted_at: null });

  // The QR link (what the guest's QR opens) counts as a scan.
  const qrCart = await json(await guest(request, visitor('qr')).post('/api/public/carts', { restaurantId: ctx.restaurantId, tableNumber: 4, items: [{ itemId: ctx.items['Kenyan chai'] }] }), 200);
  await waiter.goto(new URL(qrCart.qrValue).pathname);
  await expect(waiter.getByRole('heading', { name: 'Check with the guest' })).toBeVisible({ timeout: 20000 });
  await waiter.getByRole('button', { name: /Confirm order · Ksh 150/ }).click();
  await expect(waiter.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 20000 });
  const [qrOrder] = unwrap(await service.from('orders').select('id, confirmation').eq('guest_cart_id', (await service.from('guest_carts').select('id').eq('code', qrCart.code).eq('restaurant_id', ctx.restaurantId).single()).data.id), 'qr order');
  expect(qrOrder.confirmation).toBe('qr');
  ctx.qrOrder = qrOrder.id;

  // No phone: entered by the waiter, marked as not confirmed by the guest.
  await waiter.goto('/waiter/order/new?table=3');
  await expect(waiter.getByRole('heading', { name: 'No phone? Enter the order yourself' })).toBeVisible({ timeout: 20000 });
  await expect(waiter.getByText('It’ll be marked as not confirmed by the guest.')).toBeVisible();
  await waiter.getByRole('button', { name: 'Add Kenyan chai' }).click();
  await waiter.getByRole('button', { name: /Review order · 1 item · Ksh 150/ }).click();
  await expect(waiter.getByText(/marked as not confirmed by the guest/)).toBeVisible();
  await waiter.getByRole('button', { name: /Enter order · Ksh 150/ }).click();
  await expect(waiter.getByRole('heading', { name: 'Order entered' })).toBeVisible({ timeout: 20000 });
  const manual = unwrap(await service.from('orders').select('id, confirmation').eq('restaurant_id', ctx.restaurantId).eq('table_number', 3).eq('source', 'waiter').order('created_at', { ascending: false }).limit(1).single(), 'manual');
  expect(manual.confirmation).toBe('manual');
  ctx.manualOrder = manual.id;

  await guestPage.context().close();
  await waiter.context().close();
});

test('owner: ready to order in Needs attention; Confirmed → Served → Paid; how each order was confirmed; extras and deals on lines', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await json(await guest(request, visitor('owner')).post('/api/public/carts', { restaurantId: ctx.restaurantId, tableNumber: 1, items: [{ itemId: ctx.items.Chips, quantity: 3 }] }), 200);
  await signIn(page, ctx.owner.email);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible({ timeout: 20000 });
  const attention = page.getByRole('region', { name: /Needs attention/ });
  await expect(attention.getByText('Table 1 is ready to order')).toBeVisible({ timeout: 20000 });
  await expect(attention.getByText('3 items')).toBeVisible();
  await expect(attention.getByRole('link', { name: 'Open table 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Accept/ })).toHaveCount(0);

  // The order list: three-step status, extras and deal contents, and a warning tag on the manual order.
  await page.goto('/owner/orders?view=all&range=7d');
  const typedRow = page.getByRole('button', { name: new RegExp(`order #${ctx.typedOrder.slice(0, 6)}, Paid`) });
  await expect(typedRow).toBeVisible({ timeout: 20000 });
  await expect(typedRow.locator('.o-statusline-node')).toHaveCount(3);
  await expect(typedRow.getByText('Classic beef burger + Cheese')).toBeVisible();
  await expect(typedRow.getByText('Burger meal: Classic beef burger, Chips, Kenyan chai')).toBeVisible();
  const manualRow = page.getByRole('button', { name: new RegExp(`order #${ctx.manualOrder.slice(0, 6)}, Confirmed, not confirmed by the guest`) });
  await expect(manualRow.getByText('Not confirmed by the guest')).toBeVisible();
  await page.getByRole('radio', { name: 'Confirmed' }).click();
  await expect(manualRow).toBeVisible();
  await expect(typedRow).toHaveCount(0);

  // The drawer: lines with extras and deals, and the timeline in words.
  await page.goto(`/owner/orders?view=all&range=7d&order=${ctx.typedOrder}`);
  const typed = page.getByRole('dialog', { name: new RegExp(`Table 5 · #${ctx.typedOrder.slice(0, 6)}`) });
  await expect(typed.getByText('+ Cheese')).toBeVisible({ timeout: 20000 });
  await expect(typed.getByText('Burger meal: Classic beef burger, Chips, Kenyan chai')).toBeVisible();
  await expect(typed.getByText('Confirmed with the guest (typed code)')).toBeVisible();
  const confirmedStep = typed.locator('.o-timeline-step').first();
  await expect(confirmedStep.locator('.o-timeline-label')).toHaveText('Confirmed');
  await expect(confirmedStep.locator('.o-timeline-detail')).toHaveText(new RegExp(`^with the guest by Fl Waiter at ${CLOCK} \\(typed code\\)$`));
  await expect(typed.locator('.o-timeline-step')).toHaveCount(3);
  await expect(typed.getByText('Accepted')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto(`/owner/orders?view=all&range=7d&order=${ctx.qrOrder}`);
  const qr = page.getByRole('dialog', { name: /Table 4/ });
  await expect(qr.locator('.o-timeline-step').first().locator('.o-timeline-detail')).toHaveText(new RegExp(`with the guest by Fl Waiter at ${CLOCK} \\(QR\\)`), { timeout: 20000 });
  await expect(qr.getByRole('button', { name: 'Mark served' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(`/owner/orders?view=all&range=7d&order=${ctx.manualOrder}`);
  const manual = page.getByRole('dialog', { name: /Table 3/ });
  const entered = manual.locator('.o-timeline-step').first();
  await expect(entered.locator('.o-timeline-label')).toHaveText('Entered', { timeout: 20000 });
  await expect(entered.getByText('Not confirmed by the guest')).toBeVisible();
  await expect(manual.getByText('Entered by waiter, not confirmed by the guest')).toBeVisible();
  await page.keyboard.press('Escape');

  // The table page lists its orders with extras and deal contents too.
  await page.goto('/owner/tables/5');
  await expect(page.getByText('Classic beef burger + Cheese')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Burger meal: Classic beef burger, Chips, Kenyan chai')).toBeVisible();
});
