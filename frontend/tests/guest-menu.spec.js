import { test, expect } from '@playwright/test';
import { createAdmin } from '../../backend/scripts/clients.js';

// Needs `npm run db:seed` once: owner@gmail.com owns a live "Demo Restaurant" with 8 tables, Mains and Nyama choma.
// Read-only: this file never writes to the database. Carts, requests and events are answered in the browser.
let demoId;
test.beforeAll(async () => {
  // The seeded Demo Restaurant, by its id: other test runs may create restaurants with the same name.
  const { data, error } = await createAdmin().from('restaurants').select('id').eq('id', '106fe2fb-94bb-4f5d-bd0d-bd694004424c').eq('status', 'live').single();
  if (error) throw new Error(`Run npm run db:seed first: no live Demo Restaurant (${error.message}).`);
  demoId = data.id;
});

const unavailable = 'This menu isn’t available right now.';

/** Keeps the Demo Restaurant clean: public writes never leave the browser. Returns the event batches sent. */
async function stubWrites(page) {
  const batches = [];
  await page.route('**/api/public/events', async (route) => { batches.push(route.request().postDataJSON()); await route.fulfill({ status: 202, json: { accepted: 1, dropped: 0 } }); });
  await page.route('**/api/public/carts', (route) => route.fulfill({ status: 500, json: { error: 'Stubbed in tests.' } }));
  await page.route('**/api/public/requests**', (route) => route.fulfill({ json: { table: { number: 3 }, requests: [] } }));
  return batches;
}

test('a live restaurant’s menu renders by id, with tabs that follow the sections', async ({ page }) => {
  await stubWrites(page);
  await page.goto(`/guest-menu?r=${demoId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Demo Restaurant' })).toBeVisible();
  await expect(page).toHaveTitle('Demo Restaurant');
  const tabs = page.getByRole('navigation', { name: 'Menu categories' });
  await expect(tabs.getByRole('link').first()).toHaveAttribute('aria-current', 'true');
  await tabs.getByRole('link', { name: 'Mains', exact: true }).click();
  await expect(tabs.getByRole('link', { name: 'Mains', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('heading', { level: 2, name: 'Mains' })).toBeFocused();
  const dish = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Nyama choma', exact: true }) }).last();
  await expect(dish).toBeVisible();
  await expect(dish).toContainText(/Ksh\s[\d,]+/);
  await expect(page.getByText('Powered by Cravio')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Order now' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Owner navigation' })).toHaveCount(0);
  await expect(page.getByText(/^Table \d+$/)).toHaveCount(0);
});

test('the guest page never downloads the Supabase client or the QR library', async ({ page }) => {
  await stubWrites(page);
  const urls = [];
  page.on('request', (request) => urls.push(request.url()));
  await page.goto(`/guest-menu?r=${demoId}&t=3`);
  await expect(page.getByRole('heading', { level: 1, name: 'Demo Restaurant' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(urls.filter((url) => /supabase-js|@supabase|lib\/supabase|\/supabase-[\w-]+\.js|qrcode/.test(url))).toEqual([]);
});

test('the table number shows when the table exists', async ({ page }) => {
  await stubWrites(page);
  await page.goto(`/guest-menu?r=${demoId}&t=3`);
  await expect(page.getByText('Table 3', { exact: true })).toBeVisible();
});

test('the public API returns only public fields and revalidates with an ETag', async ({ request }) => {
  const response = await request.get(`/api/public/menu/${demoId}?t=999`);
  expect(response.status()).toBe(200);
  // Cached on the server and invalidated on every owner edit; browsers revalidate (304 when unchanged).
  expect(response.headers()['cache-control']).toBe('public, no-cache');
  expect(response.headers().etag).toBeTruthy();
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['categories', 'deals', 'design', 'featuredItemIds', 'items', 'restaurant']);
  expect(Object.keys(body.restaurant).sort()).toEqual(['address', 'area', 'coverUrl', 'id', 'kind', 'logoUrl', 'name', 'openingHours', 'phone', 'theme']);
  expect(body.items.every((item) => item.available === true && typeof item.price === 'number')).toBe(true);
});

test('search finds dishes and deals live, and filters narrow the menu', async ({ page }) => {
  await stubWrites(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/guest-menu?r=${demoId}`);
  const search = page.getByRole('searchbox', { name: 'Search the menu' });
  await search.fill('chai');
  await expect(page.getByRole('heading', { name: /result.*for “chai”/ })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Matching dishes' }).getByRole('heading', { name: 'Kenyan chai' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Menu categories' })).toHaveCount(0);
  await search.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Menu categories' })).toBeVisible();

  await page.getByRole('button', { name: 'Filters' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await sheet.getByRole('button', { name: 'On offer' }).click();
  await sheet.getByRole('button', { name: /^Show \d+ results?$/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters, 1 on' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Matching deals' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Featured' })).toBeVisible();
});

test('the dish sheet adds extras and pairings, deals add as one line, and views are batched as events', async ({ page }) => {
  const batches = await stubWrites(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/guest-menu?r=${demoId}&t=3`);
  await page.getByRole('button', { name: 'Classic beef burger', exact: true }).first().click();
  const dish = page.getByRole('dialog', { name: 'Classic beef burger' });
  await expect(dish.getByRole('heading', { name: 'Goes well with' })).toBeVisible();
  const cheese = dish.getByRole('group', { name: 'Extras for Classic beef burger' }).getByRole('button', { name: /Cheese/ });
  await cheese.click();
  await expect(cheese).toHaveAttribute('aria-pressed', 'true');
  await expect(dish.getByRole('button', { name: /Add to order · Ksh 1,100/ })).toBeVisible();
  await dish.getByRole('group', { name: 'How many Classic beef burger' }).getByRole('button', { name: 'One more' }).click();
  await expect(dish.getByRole('button', { name: /Add to order · Ksh 2,200/ })).toBeVisible();
  await dish.getByRole('button', { name: /Add to order/ }).click();
  await expect(dish).toBeHidden();

  await page.getByRole('button', { name: 'Burger meal', exact: true }).click();
  const deal = page.getByRole('dialog', { name: 'Burger meal' });
  await expect(deal.getByText('What’s in it')).toBeVisible();
  await deal.getByRole('button', { name: /Add to order · Ksh 1,150/ }).click();

  await page.getByRole('button', { name: /3 items · Ksh 3,350/ }).click();
  const cart = page.getByRole('dialog', { name: 'Your order' });
  await expect(cart.getByText('+ Cheese')).toBeVisible();
  await expect(cart.getByText('Classic beef burger, Chips, Stoney tangawizi')).toBeVisible();
  await cart.getByRole('button', { name: 'Clear order' }).click();
  await expect(cart.getByText('Your order is empty.')).toBeVisible();
  await cart.getByRole('button', { name: 'Undo' }).click();
  await expect(cart.getByText('+ Cheese')).toBeVisible();
  await page.keyboard.press('Escape');

  // Hiding the page flushes the batch with a keepalive request.
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => batches.flatMap((batch) => batch.events.map((event) => event.type)).sort()).toEqual(['deal_view', 'dish_view']);
  expect(batches[0]).toMatchObject({ restaurantId: demoId, tableNumber: 3 });
});

test('an old cart saved before extras and deals still opens', async ({ page }) => {
  await stubWrites(page);
  const { items } = await (await page.request.get(`/api/public/menu/${demoId}`)).json();
  const chai = items.find((item) => item.name === 'Kenyan chai');
  await page.goto('/guest-menu');
  await page.evaluate(({ id, itemId }) => localStorage.setItem(`cravio-cart:${id}:3`, JSON.stringify({ lines: [{ itemId, quantity: 2, note: 'Hot' }], code: null, expiresAt: null, saved: null })), { id: demoId, itemId: chai.id });
  await page.goto(`/guest-menu?r=${demoId}&t=3`);
  await page.getByRole('button', { name: /2 items · Ksh 300/ }).click();
  await expect(page.getByRole('dialog', { name: 'Your order' }).getByText('“Hot”')).toBeVisible();
});

for (const [label, id] of [['an unknown', '00000000-0000-4000-8000-000000000000'], ['a malformed', 'not-a-real-id']]) {
  test(`${label} restaurant id shows the unavailable message`, async ({ page, request }) => {
    const response = await request.get(`/api/public/menu/${id}`);
    expect(response.status()).toBe(404);
    expect((await response.json()).error).toBe('This menu isn’t available.');
    await page.goto(`/guest-menu?r=${id}`);
    await expect(page.getByRole('heading', { name: unavailable })).toBeVisible();
    await expect(page.getByText('Please ask a member of staff.')).toBeVisible();
  });
}

test('a network failure offers a retry that recovers', async ({ page }) => {
  let fail = true;
  await page.route('**/api/public/menu/**', (route) => (fail ? route.abort() : route.continue()));
  await page.goto(`/guest-menu?r=${demoId}`);
  await expect(page.getByRole('heading', { name: 'We couldn’t load the menu' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Demo Restaurant' })).toBeVisible();
});

test('without a restaurant the page explains how to open a menu', async ({ page }) => {
  await page.goto('/guest-menu');
  await expect(page.getByRole('heading', { name: 'Guest menu', exact: true })).toBeVisible();
  await expect(page.getByText('The restaurant menu will appear here.')).toBeVisible();
  await expect(page.getByText(/Scan the QR code on your table/)).toBeVisible();
  await expect(page.locator('.sk')).toHaveCount(0);
});

for (const width of [320, 390, 768, 1440]) {
  test(`no horizontal scroll at ${width}px`, async ({ page }) => {
    await stubWrites(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/guest-menu?r=${demoId}&t=3`);
    await expect(page.getByRole('heading', { level: 1, name: 'Demo Restaurant' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // Every tap target in the menu is at least 44px tall.
    const small = await page.locator('.mv-shell button:visible, .mv-tab:visible, .gx-bottom button:visible').evaluateAll((elements) => elements
      .filter((element) => !element.closest('[aria-hidden="true"]') && !element.classList.contains('mv-card-open'))
      .filter((element) => element.getBoundingClientRect().height < 44).map((element) => element.getAttribute('aria-label') || element.textContent));
    expect(small).toEqual([]);
    await page.goto('/guest-menu');
    await expect(page.getByRole('heading', { name: 'Guest menu', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}
