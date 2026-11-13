import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

// Owner live operations pages (Overview, Orders, Tables, Products, Menu configuration) against a throwaway
// restaurant created here with the service client and deleted in `finally`. Needs migration 003 applied.
// Never touches the seeded Demo Restaurant.

const service = createAdmin();
const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `Owner-${stamp}-pw`;
const visitor = `owner-ops-${stamp}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function unwrap(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

async function setup() {
  const ctx = { users: [] };
  const email = `cravio-owner-ops-${stamp}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Pages Owner' }, app_metadata: { role: 'owner' },
  });
  if (error) throw new Error(`Could not create the owner: ${error.message}`);
  ctx.users.push(data.user.id);
  ctx.email = email;
  unwrap(await service.from('profiles').upsert({ id: data.user.id, name: 'Pages Owner', role: 'owner' }), 'profile');
  const restaurant = unwrap(await service.from('restaurants').insert({
    owner_id: data.user.id, name: `Pages Test ${stamp}`, status: 'live', went_live_at: new Date().toISOString(), area: 'Kilimani, Nairobi', theme: 'classic',
  }).select('id').single(), 'restaurant');
  ctx.restaurantId = restaurant.id;
  unwrap(await service.from('restaurant_members').insert({ restaurant_id: restaurant.id, user_id: data.user.id, role: 'owner' }), 'member');
  unwrap(await service.from('restaurant_tables').insert([1, 2, 3, 4].map((number) => ({ restaurant_id: restaurant.id, number }))), 'tables');
  const [mains] = unwrap(await service.from('menu_categories').insert([{ restaurant_id: restaurant.id, name: 'Mains', position: 0 }]).select('id'), 'categories');
  const items = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Chicken wings', price: 750, position: 0, available: true },
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Whole tilapia', price: 1000, position: 1, available: true },
  ]).select('id, name'), 'items');
  ctx.items = Object.fromEntries(items.map((item) => [item.name, item.id]));
  const client = createClient(env.SUPABASE_URL, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`Sign-in failed: ${signInError.message}`);
  ctx.token = session.session.access_token;
  return ctx;
}

async function teardown(ctx) {
  if (ctx.restaurantId) {
    const { error } = await service.from('restaurants').delete().eq('id', ctx.restaurantId);
    if (error) console.error('Could not delete the test restaurant:', error.message);
  }
  for (const id of ctx.users) {
    const { error } = await service.auth.admin.deleteUser(id);
    if (error) console.error('Could not delete the test user:', error.message);
  }
}

async function call(request, ctx, method, path, data) {
  const response = await request[method](path, { headers: { Authorization: `Bearer ${ctx.token}` }, ...(data ? { data } : {}) });
  const body = await response.json().catch(() => ({}));
  expect(response.ok(), `${method} ${path}: ${JSON.stringify(body)}`).toBe(true);
  return body;
}
const newOrder = (request, ctx, tableNumber, items) => call(request, ctx, 'post', '/api/ops/orders', { tableNumber, items }).then((body) => body.order);

async function signIn(page, ctx) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(ctx.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

test('owner live pages: overview, analytics, orders, tables, products and menu configuration', async ({ page, request }) => {
  test.setTimeout(240000);
  const ctx = await setup();
  try {
    // Data the pages should pick up: a guest asking for the bill at table 2, a guest ready to order at table 4,
    // and a confirmed order at table 3.
    const guest = await request.post('/api/public/requests', { headers: { 'X-Cravio-Visitor': visitor }, data: { restaurantId: ctx.restaurantId, tableNumber: 2, type: 'bill' } });
    expect(guest.ok()).toBe(true);
    const help = await request.post('/api/public/requests', { headers: { 'X-Cravio-Visitor': visitor }, data: { restaurantId: ctx.restaurantId, tableNumber: 1, type: 'call_waiter' } });
    expect(help.ok()).toBe(true);
    const ready = await request.post('/api/public/carts', { headers: { 'X-Cravio-Visitor': visitor }, data: { restaurantId: ctx.restaurantId, tableNumber: 4, items: [{ itemId: ctx.items['Chicken wings'], quantity: 2 }] } });
    expect(ready.ok()).toBe(true);
    const first = await newOrder(request, ctx, 3, [{ itemId: ctx.items['Chicken wings'], quantity: 1 }, { itemId: ctx.items['Whole tilapia'], quantity: 1 }]);

    await signIn(page, ctx);

    // ---- Overview: needs attention ----
    const attention = page.getByRole('region', { name: /Needs attention/ });
    await expect(attention.getByText('Table 2 wants the bill')).toBeVisible({ timeout: 20000 });
    await expect(attention.getByText('Table 1 needs help')).toBeVisible();
    await expect(attention.getByText(/Confirmed · to serve · Table 3/)).toBeVisible();
    await expect(attention.getByText('Ksh 1,750')).toBeVisible();
    // A guest ready to order: view only, with a link to the table (a waiter confirms it with the guest).
    await expect(attention.getByText('Table 4 is ready to order')).toBeVisible();
    await expect(attention.getByText('2 items')).toBeVisible();
    await expect(attention.getByRole('link', { name: 'Open table 4' })).toHaveAttribute('href', '/owner/tables/4');
    // There is no accept step anywhere.
    await expect(attention.getByRole('button', { name: /Accept order/ })).toHaveCount(0);
    await expect(attention.getByRole('button', { name: `Mark order #${first.shortId} served` })).toBeVisible();
    // Acknowledge: the request stays, marked "on the way".
    await attention.getByRole('button', { name: 'Acknowledge table 1' }).click();
    await expect(attention.getByText(/is on the way/)).toBeVisible();
    await expect(attention.getByRole('button', { name: 'Acknowledge table 1' })).toHaveCount(0);
    // Done: it leaves the list.
    await attention.getByRole('button', { name: 'Done with table 1' }).click();
    await expect(attention.getByText('Table 1 needs help')).toHaveCount(0);
    await expect.poll(async () => (await service.from('service_requests').select('status').eq('restaurant_id', ctx.restaurantId).eq('type', 'call_waiter').single()).data?.status).toBe('resolved');
    // Tables plan shows live state in words.
    const plan = page.getByRole('list', { name: 'Tables' });
    await expect(plan.getByRole('link', { name: /Table 2.*Wants the bill/ })).toBeVisible();
    await expect(plan.getByRole('link', { name: /Table 3.*Ordering/ })).toBeVisible();

    // ---- Analytics range switch ----
    await page.getByRole('tab', { name: 'Analytics' }).click();
    await expect(page.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('article', { name: 'Orders' })).toBeVisible();
    await page.getByRole('radio', { name: '7 days' }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByText('Compared with the 7 days before')).toBeVisible();
    await expect(page.getByRole('article', { name: 'Orders' }).getByText('1', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: '30 days' }).click();
    await expect(page.getByText('Compared with the 30 days before')).toBeVisible();

    // ---- Orders: both views, status line, drawer, advance through to paid ----
    await page.goto('/owner/orders');
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Table 3', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'All orders' }).click();
    const row = page.getByRole('button', { name: new RegExp(`Table 3, order #${first.shortId}, Confirmed`) });
    await expect(row).toBeVisible();
    await expect(row.locator('.o-statusline-word')).toHaveText('Confirmed');
    await expect(row.locator('.o-statusline-node')).toHaveCount(3);
    await expect(row.locator('.o-statusline-node.is-done')).toHaveCount(1);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`order=${first.id}`));
    const drawer = page.getByRole('dialog', { name: `Table 3 · #${first.shortId}` });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Total')).toBeVisible();
    await expect(drawer.getByText('Not yet')).toHaveCount(2); // Served and Paid; Confirmed is done
    await expect(drawer.getByRole('button', { name: /Accept/ })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Mark served' }).click();
    await expect(drawer.getByRole('button', { name: /Mark paid · Ksh 1,750/ })).toBeVisible();
    await drawer.getByRole('button', { name: /Mark paid/ }).click();
    await drawer.getByRole('button', { name: /Confirm Ksh 1,750 paid/ }).click();
    await expect(drawer.getByText('Choose how they paid.')).toBeVisible();
    await drawer.getByRole('radio', { name: 'M-Pesa' }).check();
    await drawer.getByLabel(/Reference/).fill('SKL4ABC12X');
    await drawer.getByRole('button', { name: /Confirm Ksh 1,750 paid/ }).click();
    await expect(drawer.getByText('All done. This order is paid.')).toBeVisible();
    await expect(drawer.getByText(/M-Pesa \(SKL4ABC12X\)/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/order=/);
    const paid = (await service.from('orders').select('status').eq('id', first.id).single()).data;
    expect(paid.status).toBe('paid');

    // Cancel, with a reason. The drawer is deep-linkable.
    const second = await newOrder(request, ctx, 1, [{ itemId: ctx.items['Chicken wings'], quantity: 2 }]);
    await page.goto(`/owner/orders?view=all&order=${second.id}`);
    const cancelDrawer = page.getByRole('dialog', { name: `Table 1 · #${second.shortId}` });
    await expect(cancelDrawer.getByRole('button', { name: 'Mark served' })).toBeVisible();
    await cancelDrawer.getByRole('button', { name: 'Cancel order' }).click();
    await cancelDrawer.getByLabel(/Reason/).fill('Guest left');
    await cancelDrawer.getByRole('button', { name: 'Cancel order' }).click();
    await expect(cancelDrawer.getByText('Nothing to do. This order was cancelled.')).toBeVisible();
    await expect(cancelDrawer.getByText(/“Guest left”/)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('radio', { name: 'Cancelled' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`order #${second.shortId}, Cancelled`) })).toBeVisible();

    // ---- Tables: add tables, detail QR, guarded removal ----
    await page.goto('/owner/tables');
    await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '4 tables' })).toBeVisible();
    await page.getByRole('button', { name: 'Add tables' }).click();
    await page.getByRole('dialog', { name: 'Add tables' }).getByRole('button', { name: 'One more' }).click();
    await page.getByRole('dialog', { name: 'Add tables' }).getByRole('button', { name: 'Add 2 tables' }).click();
    await expect(page.getByRole('heading', { name: '6 tables' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Table 6/ })).toBeVisible();

    await page.goto('/owner/tables/2');
    await expect(page.getByRole('heading', { name: 'Table 2', level: 1 })).toBeVisible();
    await expect(page.getByRole('img', { name: 'QR code for table 2' })).toBeVisible();
    await expect(page.locator('.o-qr svg')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print this QR' })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Open this table’s menu' })).toHaveAttribute('href', new RegExp(`/guest-menu\\?r=${ctx.restaurantId}&t=2$`));
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PNG' }).click();
    expect((await download).suggestedFilename()).toBe('table-2-qr.png');

    await newOrder(request, ctx, 4, [{ itemId: ctx.items['Chicken wings'], quantity: 1 }]);
    await page.goto('/owner/tables/4');
    await page.getByRole('button', { name: 'Remove table 4' }).click();
    await page.getByRole('button', { name: 'Yes, remove table 4' }).click();
    await expect(page.getByText('Table 4 has unpaid orders. Settle them first.')).toBeVisible();
    await page.goto('/owner/tables/6');
    await page.getByRole('button', { name: 'Remove table 6' }).click();
    await page.getByRole('button', { name: 'Yes, remove table 6' }).click();
    await expect(page).toHaveURL(/\/owner\/tables$/);
    await expect(page.getByRole('heading', { name: '5 tables' })).toBeVisible();

    // ---- Products: add a category with "+", add a dish from its dashed card, toggle "On sale" ----
    await page.goto('/owner/products');
    await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
    await expect(page.getByText(/2 dishes · 2 on sale · 0 sold out/)).toBeVisible();
    await page.getByRole('button', { name: 'Add category' }).click();
    const categoryDialog = page.getByRole('dialog', { name: 'New category' });
    await categoryDialog.getByLabel('Name').fill('Desserts');
    await categoryDialog.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByRole('heading', { name: 'Desserts', level: 2 })).toBeVisible();
    await expect(page.getByText('No dishes in Desserts yet', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: /Desserts, 0 products/ })).toHaveAttribute('aria-current', 'true');
    await page.getByRole('button', { name: 'Add dish to Desserts' }).click();
    const editor = page.getByRole('dialog', { name: 'Add product' });
    await editor.getByLabel('Name').fill('Mango sorbet');
    await editor.getByLabel('Price').fill('400');
    await editor.getByRole('button', { name: 'Add product' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit product' }).getByRole('heading', { name: 'Extras' })).toBeVisible();
    await page.keyboard.press('Escape');
    const toggle = page.getByRole('switch', { name: 'Mango sorbet on sale' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toContainText('Sold out');
    await expect.poll(async () => (await service.from('menu_items').select('available').eq('restaurant_id', ctx.restaurantId).eq('name', 'Mango sorbet').single()).data?.available).toBe(false);

    // ---- Menu configuration: change theme ----
    await page.goto('/owner/menu');
    await expect(page.getByRole('heading', { name: 'Menu configuration', exact: true })).toBeVisible();
    // The Menu Studio keeps changes as a draft until "Publish changes".
    await expect(page.getByRole('toolbar', { name: 'Studio' })).toBeVisible({ timeout: 20000 });
    await page.getByRole('tab', { name: 'Colour' }).click();
    await page.getByRole('radio', { name: /Savanna/ }).click();
    await expect(page.getByRole('radio', { name: /Savanna/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Publish changes' }).click();
    await expect(page.getByRole('toolbar', { name: 'Studio' }).getByRole('status')).toHaveText('Published', { timeout: 20000 });
    await expect.poll(async () => (await service.from('restaurants').select('menu_design').eq('id', ctx.restaurantId).single()).data?.menu_design?.theme).toBe('savanna');
    await expect(page.locator('.phone-screen')).toHaveAttribute('data-theme', 'savanna');

    // No horizontal scroll on any width.
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    await teardown(ctx);
  }
});
