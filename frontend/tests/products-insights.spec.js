import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

// The owner's Products page (cards, filters, list reorder, editor sections, categories, featured, deals) and the
// Insights page, against a throwaway restaurant created here with the service client and deleted in `finally`.
// Needs migrations 003 and 004 applied. Never touches the seeded Demo Restaurant.

const service = createAdmin();
const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `Prod-${stamp}-pw`;

function unwrap(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

async function setup() {
  const ctx = { users: [] };
  ctx.email = `cravio-products-${stamp}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email: ctx.email, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Products Owner' }, app_metadata: { role: 'owner' },
  });
  if (error) throw new Error(`Could not create the owner: ${error.message}`);
  ctx.users.push(data.user.id);
  unwrap(await service.from('profiles').upsert({ id: data.user.id, name: 'Products Owner', role: 'owner' }), 'profile');
  const restaurant = unwrap(await service.from('restaurants').insert({
    owner_id: data.user.id, name: `Products Test ${stamp}`, status: 'live', went_live_at: new Date().toISOString(), area: 'Kilimani, Nairobi', theme: 'classic',
  }).select('id').single(), 'restaurant');
  ctx.restaurantId = restaurant.id;
  unwrap(await service.from('restaurant_members').insert({ restaurant_id: restaurant.id, user_id: data.user.id, role: 'owner' }), 'member');
  unwrap(await service.from('restaurant_tables').insert([1, 2].map((number) => ({ restaurant_id: restaurant.id, number }))), 'tables');
  const categories = unwrap(await service.from('menu_categories').insert([
    { restaurant_id: restaurant.id, name: 'Mains', position: 0 }, { restaurant_id: restaurant.id, name: 'Sides', position: 1 },
  ]).select('id, name'), 'categories');
  ctx.categories = Object.fromEntries(categories.map((category) => [category.name, category.id]));
  const items = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: ctx.categories.Mains, name: 'Beef burger', price: 950, position: 0, available: true },
    { restaurant_id: restaurant.id, category_id: ctx.categories.Mains, name: 'Grilled chicken', price: 850, position: 1, available: true },
    { restaurant_id: restaurant.id, category_id: ctx.categories.Mains, name: 'Whole tilapia', price: 1200, position: 2, available: false },
    { restaurant_id: restaurant.id, category_id: ctx.categories.Sides, name: 'Chips', price: 250, position: 0, available: true },
  ]).select('id, name'), 'items');
  ctx.items = Object.fromEntries(items.map((item) => [item.name, item.id]));
  const client = createClient(env.SUPABASE_URL, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data: session, error: signInError } = await client.auth.signInWithPassword({ email: ctx.email, password: PASSWORD });
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

async function signIn(page, ctx) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(ctx.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

const item = (ctx, name) => service.from('menu_items').select('*').eq('id', ctx.items[name]).single().then((result) => result.data);

test('products: cards, filters, reorder, editor sections, categories, featured and deals', async ({ page }) => {
  test.setTimeout(240000);
  const ctx = await setup();
  try {
    await signIn(page, ctx);
    await page.goto('/owner/products');
    await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
    await expect(page.getByText('4 dishes · 3 on sale · 1 sold out · 0 featured')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Dishes/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Mains', level: 2 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add dish to Sides' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a photo of Chips' })).toBeVisible();

    // "On sale" is optimistic and saved.
    const sale = page.getByRole('switch', { name: 'Chips on sale' });
    await sale.click();
    await expect(sale).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await item(ctx, 'Chips')).available).toBe(false);
    await sale.click();
    await expect.poll(async () => (await item(ctx, 'Chips')).available).toBe(true);

    // Featured star, then the featured strip.
    await page.getByRole('button', { name: 'Feature Grilled chicken' }).click();
    await expect(page.getByRole('button', { name: 'Feature Grilled chicken' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await item(ctx, 'Grilled chicken')).featured).toBe(true);
    await expect(page.getByRole('region', { name: 'Featured' }).getByRole('button', { name: /1\. Grilled chicken/ })).toBeVisible();

    // Filters live in the URL.
    await page.getByLabel('Status').selectOption('soldout');
    await expect(page).toHaveURL(/status=soldout/);
    await expect(page.getByRole('switch', { name: 'Whole tilapia on sale' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Beef burger on sale' })).toHaveCount(0);
    await page.getByLabel('Status').selectOption('');
    await page.getByRole('button', { name: 'Featured', exact: true }).click();
    await expect(page).toHaveURL(/featured=1/);
    await expect(page.getByRole('switch', { name: /on sale$/ })).toHaveCount(1);
    await page.getByRole('button', { name: 'Featured', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search your menu' }).fill('zzz');
    await expect(page.getByText('No products match “zzz” yet.')).toBeVisible();
    await page.getByRole('link', { name: 'Clear search for zzz' }).click();

    // List view: move Grilled chicken up (PUT /items/order).
    await page.getByRole('radio', { name: 'List' }).click();
    await expect(page).toHaveURL(/view=list/);
    await page.getByRole('button', { name: 'Move Grilled chicken up' }).click();
    await expect.poll(async () => (await item(ctx, 'Grilled chicken')).position).toBe(0);
    await page.getByRole('radio', { name: 'Cards' }).click();

    // Editor: details, extras, pairings with mirror, featured position.
    await page.getByRole('button', { name: 'Beef burger', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit product' });
    await expect(editor.getByRole('heading', { name: 'Goes well with' })).toBeVisible();
    await editor.getByLabel('Description').fill('Beef, cheese and pickles.');
    await editor.getByRole('button', { name: 'Save details' }).click();
    await expect(editor.locator('#pe-details').getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect.poll(async () => (await item(ctx, 'Beef burger')).description).toBe('Beef, cheese and pickles.');

    await editor.getByLabel('New extra name').fill('Cheese');
    await editor.getByLabel('New extra price in Ksh').fill('150');
    await editor.getByRole('button', { name: 'Add extra' }).click();
    await expect(editor.getByRole('status').filter({ hasText: 'Cheese added' })).toBeVisible();
    await expect(editor.getByRole('switch', { name: 'Cheese available' })).toBeVisible();
    const extras = async () => unwrap(await service.from('menu_item_extras').select('name, price, available').eq('item_id', ctx.items['Beef burger']), 'extras');
    await expect.poll(async () => (await extras()).map((extra) => `${extra.name}:${Number(extra.price)}`)).toEqual(['Cheese:150']);
    await editor.getByRole('switch', { name: 'Cheese available' }).click();
    await expect.poll(async () => (await extras())[0]?.available).toBe(false);

    await editor.getByRole('button', { name: 'Suggest Chips' }).click();
    await editor.getByLabel(/Also suggest Beef burger there/).check();
    await editor.getByRole('button', { name: 'Save suggestions' }).click();
    await expect(editor.getByText(/Also suggested on Chips/)).toBeVisible();
    const pairs = async (from) => unwrap(await service.from('menu_item_pairings').select('paired_item_id').eq('item_id', ctx.items[from]), 'pairings').map((row) => row.paired_item_id);
    await expect.poll(() => pairs('Beef burger')).toEqual([ctx.items.Chips]);
    await expect.poll(() => pairs('Chips')).toEqual([ctx.items['Beef burger']]);

    await editor.getByRole('switch', { name: 'Feature on your menu' }).click();
    await expect(editor.getByRole('switch', { name: 'Featured on your menu' })).toHaveAttribute('aria-checked', 'true');
    await editor.getByLabel('Position').selectOption('0');
    await expect.poll(async () => (await item(ctx, 'Beef burger')).featured_position).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'Featured' }).getByRole('button', { name: /1\. Beef burger/ })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Beef burger on sale' }).locator('xpath=ancestor::li[1]')).toContainText('1 pairing');

    // Manage categories: rename and reorder.
    await page.getByRole('button', { name: 'Manage categories' }).click();
    const manage = page.getByRole('dialog', { name: 'Manage categories' });
    await manage.getByLabel('Name of category 2').fill('Sides & extras');
    await manage.getByRole('button', { name: 'Save' }).click();
    await expect(manage.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await manage.getByRole('button', { name: 'Move Sides & extras up' }).click();
    await expect.poll(async () => unwrap(await service.from('menu_categories').select('name, position').eq('id', ctx.categories.Sides).single(), 'category')).toEqual({ name: 'Sides & extras', position: 0 });
    await page.keyboard.press('Escape');

    // Deals: empty state, create one (with the saving shown live), toggle it off.
    await page.getByRole('tab', { name: /Deals/ }).click();
    await expect(page).toHaveURL(/tab=deals/);
    await expect(page.getByRole('heading', { name: 'No deals yet' })).toBeVisible();
    await page.getByRole('button', { name: 'New deal' }).first().click();
    const deal = page.getByRole('dialog', { name: 'New deal' });
    await deal.getByLabel('Name', { exact: true }).fill('Burger meal');
    await deal.getByLabel('Add a dish to the deal').fill('burger');
    await deal.getByRole('button', { name: 'Add Beef burger' }).click();
    await deal.getByLabel('Add a dish to the deal').fill('chips');
    await deal.getByRole('button', { name: 'Add Chips' }).click();
    await deal.getByLabel('Deal price').fill('1300');
    await expect(deal.getByText(/This deal costs Ksh\s100 more/)).toBeVisible();
    await deal.getByLabel('Deal price').fill('1100');
    await expect(deal.getByText(/Ksh\s100 \(8%\)/)).toBeVisible();
    await deal.getByRole('button', { name: 'Add deal' }).click();
    await expect(deal).toBeHidden();
    const card = page.locator('.dl-card').filter({ hasText: 'Burger meal' });
    await expect(card.getByText(/Save Ksh\s100/)).toBeVisible();
    await expect(card.getByText('Active', { exact: true }).first()).toBeVisible();
    const dealRow = async () => unwrap(await service.from('menu_deals').select('id, price, active').eq('restaurant_id', ctx.restaurantId), 'deals');
    await expect.poll(async () => (await dealRow()).map((row) => Number(row.price))).toEqual([1100]);
    await page.getByRole('switch', { name: 'Burger meal active' }).click();
    await expect.poll(async () => (await dealRow())[0]?.active).toBe(false);

    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    await teardown(ctx);
  }
});

test('insights: empty state, then KPIs, charts, range and dish table', async ({ page, request }) => {
  test.setTimeout(180000);
  const ctx = await setup();
  try {
    await signIn(page, ctx);
    await page.goto('/owner/insights');
    await expect(page.getByRole('heading', { name: 'Insights', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Insights fill in as guests scan your menu' })).toBeVisible();
    await expect(page.getByText('No menu scans or orders yet in this period.')).toBeVisible();

    const response = await request.post('/api/ops/orders', { headers: { Authorization: `Bearer ${ctx.token}` }, data: { tableNumber: 1, items: [{ itemId: ctx.items['Beef burger'], quantity: 2 }] } });
    expect(response.ok()).toBe(true);

    await page.getByRole('radio', { name: '7 days' }).click();
    await expect(page).toHaveURL(/range=7d/);
    const orders = page.getByRole('article', { name: 'Orders' });
    await expect(orders.getByText('2', { exact: true }).or(orders.getByText('1', { exact: true }))).toBeVisible();
    await expect(orders.getByText('New')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Busy hours' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Day by day' })).toBeVisible();
    await expect(page.getByText(/Staff up around \d\d:00/)).toBeVisible();

    // Table fallback and the line chart metric switch.
    const day = page.getByRole('region', { name: 'Day by day' });
    await day.getByRole('radio', { name: 'Sales' }).click();
    await expect(day.getByText(/Paid sales each day/)).toBeVisible();
    await day.getByRole('button', { name: 'Table' }).click();
    await expect(day.getByRole('columnheader', { name: 'Paid sales' })).toBeVisible();
    await expect(day.getByRole('row')).toHaveCount(8);

    // Dish table: server sort in the URL.
    const dishes = page.getByRole('region', { name: 'Dish performance' });
    await expect(dishes.getByRole('row', { name: /Beef burger/ })).toContainText('2');
    await dishes.getByRole('button', { name: /^Dish/ }).click();
    await expect(page).toHaveURL(/sort=name/);
    await expect(dishes.locator('tbody th').first()).toContainText('Beef burger');
    await expect(dishes.getByRole('columnheader', { name: /Dish/ })).toHaveAttribute('aria-sort', 'ascending');
    await dishes.getByRole('searchbox', { name: 'Find a dish or deal' }).fill('chips');
    await expect(dishes.locator('tbody tr')).toHaveCount(1);

    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    await teardown(ctx);
  }
});
