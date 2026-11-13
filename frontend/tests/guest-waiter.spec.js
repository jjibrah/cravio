import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAdmin } from '../../backend/scripts/clients.js';

// Guest cart ("Ready to order") and requests on the public menu, the waiter app (confirm with the guest by code,
// Services, Tables, payment), the QR cart page and dish video checks. Works with or without migration 005
// (order-flow.spec.js covers what needs it). Everything happens in a throwaway restaurant with its own owner and
// waiter, created with the service client and deleted in afterAll. Needs migration 003.

const service = createAdmin();
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `Gw-${stamp}-pw`;
const ctx = { users: [], restaurantId: null };
const unwrap = (result, what) => { if (result.error) throw new Error(`${what}: ${result.error.message}`); return result.data; };
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function createUser(role, name) {
  const email = `cravio-gw-${role}-${stamp}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { name }, app_metadata: { role } });
  if (error) throw new Error(`Could not create the ${role}: ${error.message}`);
  ctx.users.push(data.user.id);
  unwrap(await service.from('profiles').upsert({ id: data.user.id, name, role }), 'profile');
  return { id: data.user.id, email, name };
}

async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);
test.use({ ...phone });

test.beforeAll(async () => {
  test.setTimeout(90000);
  ctx.owner = await createUser('owner', 'Gw Owner');
  ctx.waiter = await createUser('waiter', 'Gw Waiter');
  const restaurant = unwrap(await service.from('restaurants').insert({
    owner_id: ctx.owner.id, name: `Guest Waiter ${stamp}`, status: 'live', went_live_at: new Date().toISOString(), area: 'Kilimani, Nairobi',
  }).select('id').single(), 'restaurant');
  ctx.restaurantId = restaurant.id;
  unwrap(await service.from('restaurant_members').insert([
    { restaurant_id: restaurant.id, user_id: ctx.owner.id, role: 'owner' },
    { restaurant_id: restaurant.id, user_id: ctx.waiter.id, role: 'waiter' },
  ]), 'members');
  unwrap(await service.from('restaurant_tables').insert([1, 2, 3, 4].map((number) => ({ restaurant_id: restaurant.id, number }))), 'tables');
  const [mains, drinks] = unwrap(await service.from('menu_categories').insert([
    { restaurant_id: restaurant.id, name: 'Mains', position: 0 }, { restaurant_id: restaurant.id, name: 'Drinks', position: 1 },
  ]).select('id, position').order('position'), 'categories');
  const items = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Chicken wings', description: 'Peri-peri wings.', price: 750, position: 0, available: true },
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Whole tilapia', price: 1200, position: 1, available: false },
    { restaurant_id: restaurant.id, category_id: drinks.id, name: 'Kenyan chai', price: 150, position: 0, available: true },
  ]).select('id, name'), 'items');
  ctx.items = Object.fromEntries(items.map((item) => [item.name, item.id]));
  // Merchandising (migration 004): a burger with extras, and a deal.
  const [burger] = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Classic beef burger', price: 950, position: 2, available: true },
  ]).select('id'), 'burger');
  ctx.items['Classic beef burger'] = burger.id;
  const extras = unwrap(await service.from('menu_item_extras').insert([
    { restaurant_id: restaurant.id, item_id: burger.id, name: 'Cheese', price: 150, position: 0 },
    { restaurant_id: restaurant.id, item_id: burger.id, name: 'Bacon', price: 200, position: 1 },
  ]).select('id, name'), 'extras');
  ctx.extras = Object.fromEntries(extras.map((extra) => [extra.name, extra.id]));
  const deal = unwrap(await service.from('menu_deals').insert({ restaurant_id: restaurant.id, name: 'Burger and chai', price: 1000, position: 0 }).select('id').single(), 'deal');
  unwrap(await service.from('menu_deal_items').insert([
    { deal_id: deal.id, restaurant_id: restaurant.id, item_id: burger.id, quantity: 1, position: 0 },
    { deal_id: deal.id, restaurant_id: restaurant.id, item_id: ctx.items['Kenyan chai'], quantity: 1, position: 1 },
  ]), 'deal items');
  ctx.dealId = deal.id;
});

test.afterAll(async () => {
  if (ctx.restaurantId) {
    for (const kind of ['videos', 'posters', 'items']) {
      const { data } = await service.storage.from('restaurant-media').list(`${ctx.restaurantId}/${kind}`);
      if (data?.length) await service.storage.from('restaurant-media').remove(data.map((file) => `${ctx.restaurantId}/${kind}/${file.name}`));
    }
    const { error } = await service.from('restaurants').delete().eq('id', ctx.restaurantId);
    if (error) console.error('Could not delete the test restaurant:', error.message);
  }
  for (const id of ctx.users) {
    const { error } = await service.auth.admin.deleteUser(id);
    if (error) console.error('Could not delete a test user:', error.message);
  }
});

test('a guest builds a cart and taps Ready to order; the waiter confirms it with the guest by code; the guest sees it confirmed', async ({ browser }) => {
  const guest = await (await browser.newContext(phone)).newPage();
  await guest.goto(`/guest-menu?r=${ctx.restaurantId}&t=2`);
  await expect(guest.getByRole('heading', { level: 1, name: `Guest Waiter ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect(guest.getByText('Whole tilapia')).toHaveCount(0); // sold out: hidden from guests

  await guest.getByRole('button', { name: 'Add Chicken wings' }).click();
  await guest.getByRole('button', { name: 'One more Chicken wings' }).click();
  await expect(guest.getByRole('group', { name: 'Chicken wings in your order' }).locator('output')).toHaveText('2');
  await guest.getByRole('button', { name: 'Kenyan chai', exact: true }).click();
  const dish = guest.getByRole('dialog', { name: 'Kenyan chai' });
  await dish.getByRole('button', { name: 'Add a note for the kitchen' }).click();
  await dish.getByLabel(/Note for the kitchen/).fill('No sugar');
  await dish.getByRole('button', { name: /Add to order · Ksh 150/ }).click();
  await expect(dish).toBeHidden();

  // The cart survives a reload (localStorage per restaurant and table).
  await guest.reload();
  const bar = guest.getByRole('button', { name: /3 items · Ksh 1,650/ });
  await expect(bar).toBeVisible({ timeout: 20000 });
  await bar.click();
  const cart = guest.getByRole('dialog', { name: 'Your order' });
  await expect(cart.getByText('“No sugar”')).toBeVisible();
  await cart.getByRole('button', { name: 'Ready to order' }).click();
  const card = guest.getByRole('dialog', { name: 'Ready to order' });
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByText('A waiter is on the way. Show them this code.')).toBeVisible();
  const spelled = await card.locator('.gx-code').getAttribute('aria-label');
  const code = spelled.replace(/^Code /, '').replace(/\s/g, '');
  expect(code).toMatch(/^[ACDEFHJKMNPRTUVWXY34679]{6}$/);
  await expect(card.locator('.gx-qr svg')).toBeVisible();
  await expect(card.getByText(/Valid for 2 hours/)).toBeVisible();
  await expect(card.getByText('Ksh 1,650')).toBeVisible();
  ctx.code = code;

  const page = await (await browser.newContext(phone)).newPage();
  await signIn(page, ctx.waiter.email);
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto('/waiter/order/new?table=2');
  await page.getByLabel('Guest’s code', { exact: true }).fill(`${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  // Straight to the review with the guest: their list, "Is that all?", Confirm order.
  await expect(page.getByRole('heading', { name: 'Check with the guest' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('list', { name: 'Order lines' }).getByText('No sugar')).toBeVisible();
  await expect(page.getByText('Is that all?')).toBeVisible();
  await page.getByRole('button', { name: /Confirm order · Ksh 1,650/ }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 20000 });

  // The guest's phone turns to "Order confirmed ✓" by itself, and the order on the phone resets.
  const done = guest.getByRole('dialog', { name: 'Order confirmed ✓' });
  await expect(done).toBeVisible({ timeout: 20000 });
  await expect(done.getByText(/^Gw confirmed your order at \d{2}:\d{2} · #[0-9a-f]{6}$/)).toBeVisible();
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(guest.getByRole('button', { name: /items · Ksh/ })).toHaveCount(0);

  await page.getByRole('link', { name: 'Go to Services' }).click();
  const order = page.getByRole('article', { name: /Confirmed · to serve Table 2/ });
  await expect(order).toBeVisible({ timeout: 20000 });
  await expect(order.getByText('2×')).toBeVisible();
  await expect(order.getByRole('button', { name: 'Mark served' })).toBeVisible();
  await expect(order.getByRole('button', { name: /Accept/ })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Table 2 is ready to order' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Waiter navigation' }).getByRole('link', { name: 'Tables', exact: true }).click();
  await expect(page.getByRole('button', { name: /Table 2.*Ordering/ })).toBeVisible({ timeout: 20000 });
  await guest.context().close();
  await page.context().close();
});

test('extras and deals: the guest orders a burger with cheese and a deal; the waiter checks it with them, adds more, and the order keeps them', async ({ browser }) => {
  const guest = await (await browser.newContext(phone)).newPage();
  await guest.goto(`/guest-menu?r=${ctx.restaurantId}&t=4`);
  await guest.getByRole('button', { name: 'Classic beef burger', exact: true }).click();
  const dish = guest.getByRole('dialog', { name: 'Classic beef burger' });
  await dish.getByRole('group', { name: 'Extras for Classic beef burger' }).getByRole('button', { name: /Cheese/ }).click();
  await dish.getByRole('button', { name: /Add to order · Ksh 1,100/ }).click();
  await guest.getByRole('button', { name: 'Add Burger and chai' }).click();
  await guest.getByRole('button', { name: /2 items · Ksh 2,100/ }).click();
  const cart = guest.getByRole('dialog', { name: 'Your order' });
  await expect(cart.getByText('+ Cheese')).toBeVisible();
  await cart.getByRole('button', { name: 'Ready to order' }).click();
  const card = guest.getByRole('dialog', { name: 'Ready to order' });
  await expect(card.getByText('+ Cheese')).toBeVisible({ timeout: 20000 });
  await expect(card.getByText('Deal: Classic beef burger, Kenyan chai')).toBeVisible();
  const code = (await card.locator('.gx-code').getAttribute('aria-label')).replace(/^Code /, '').replace(/\s/g, '');

  const page = await (await browser.newContext(phone)).newPage();
  await signIn(page, ctx.waiter.email);
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto(`/waiter/cart/${code}`);
  await expect(page.getByRole('heading', { name: 'Check with the guest' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('list', { name: 'Order lines' }).getByText('+ Cheese')).toBeVisible();
  // The guest wants more: another burger with bacon, and one more deal.
  await page.getByRole('button', { name: 'Add more' }).click();
  await page.getByRole('button', { name: 'Add Classic beef burger with extras' }).click();
  const sheet = page.getByRole('dialog', { name: 'Classic beef burger: extras' });
  await sheet.getByRole('button', { name: /Bacon/ }).click();
  await sheet.getByRole('button', { name: 'Add · Ksh 1,150' }).click();
  await page.getByRole('button', { name: 'One more Burger and chai' }).click();
  await page.getByRole('button', { name: /Check with the guest · 4 items · Ksh 4,250/ }).click();
  const lines = page.getByRole('list', { name: 'Order lines' });
  await expect(lines.getByText('+ Cheese')).toBeVisible();
  await expect(lines.getByText('+ Bacon')).toBeVisible();
  await expect(lines.getByText('Classic beef burger, Kenyan chai')).toBeVisible();
  await page.getByRole('button', { name: /Confirm order · Ksh 4,250/ }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/Ksh 4,250/)).toBeVisible();

  const { data: rows } = await service.from('orders').select('id, total').eq('restaurant_id', ctx.restaurantId).eq('table_number', 4);
  expect(rows.length).toBe(1);
  expect(Number(rows[0].total)).toBe(4250);
  await page.getByRole('link', { name: 'Go to Services' }).click();
  const order = page.getByRole('article', { name: /Table 4/ });
  await expect(order.getByText('+ Cheese')).toBeVisible({ timeout: 20000 });
  await expect(order.getByText('Classic beef burger, Kenyan chai')).toBeVisible();
  await guest.context().close();
  await page.context().close();
});

test('a guest calls the waiter; the waiter acknowledges, the guest sees "On the way", then Done', async ({ browser }) => {
  const guest = await (await browser.newContext(phone)).newPage();
  await guest.goto(`/guest-menu?r=${ctx.restaurantId}&t=3`);
  await guest.getByRole('button', { name: 'Call waiter', exact: true }).click();
  await expect(guest.getByRole('button', { name: 'Call waiter: Sent' })).toBeDisabled({ timeout: 20000 });
  await expect(guest.getByRole('status').filter({ hasText: 'a waiter will come' })).toBeVisible();

  const page = await (await browser.newContext(phone)).newPage();
  await signIn(page, ctx.waiter.email);
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto('/waiter/services');
  const request = page.getByRole('article', { name: 'Table 3: Call waiter' });
  await expect(request).toBeVisible({ timeout: 20000 });
  await request.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(request.getByText(/on the way/i)).toBeVisible({ timeout: 20000 });
  await expect(guest.getByRole('button', { name: 'Call waiter: On the way' })).toBeVisible({ timeout: 25000 });

  await request.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('article', { name: 'Table 3: Call waiter' })).toHaveCount(0, { timeout: 20000 });
  await expect(guest.getByRole('button', { name: 'Call waiter: Done' })).toBeVisible({ timeout: 25000 });
  await expect(guest.getByRole('button', { name: 'Call waiter', exact: true })).toBeEnabled({ timeout: 20000 });

  // Without a table, guests are asked to scan the table's code instead.
  await guest.goto(`/guest-menu?r=${ctx.restaurantId}`);
  await expect(guest.getByText('Scan the code on your table to call a waiter.')).toBeVisible({ timeout: 20000 });
  await expect(guest.getByRole('button', { name: 'Call waiter' })).toHaveCount(0);
  await guest.context().close();
  await page.context().close();
});

test('the waiter moves the confirmed order to served and paid from the table sheet (no accept step)', async ({ page }) => {
  await signIn(page, ctx.waiter.email);
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: /Table 2/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Table 2' });
  await expect(sheet.getByRole('list', { name: /Status: Confirmed, step 1 of 3/ })).toBeVisible({ timeout: 20000 });
  await expect(sheet.getByRole('button', { name: /Accept/ })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Mark served' }).click();
  await sheet.getByRole('button', { name: 'Mark paid' }).click({ timeout: 20000 });
  await sheet.getByRole('radio', { name: 'M-Pesa' }).click();
  await sheet.getByLabel(/M-Pesa code/).fill('SKL4ABC12X');
  await sheet.getByRole('button', { name: 'Mark paid · Ksh 1,650' }).click();
  await expect(sheet.getByText('Nothing open. The table is free.')).toBeVisible({ timeout: 20000 });
  const { data } = await service.from('orders').select('status').eq('restaurant_id', ctx.restaurantId).eq('table_number', 2);
  expect(data.map((row) => row.status)).toEqual(['paid']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Table 2.*Free/ })).toBeVisible({ timeout: 20000 });
});

test('the QR link opens the cart import page, and unknown or claimed codes are explained', async ({ page, request }) => {
  const saved = await request.post('/api/public/carts', {
    headers: { 'X-Cravio-Visitor': `gw-qr-${stamp}`.slice(0, 60) },
    data: { restaurantId: ctx.restaurantId, tableNumber: 4, items: [{ itemId: ctx.items['Kenyan chai'], quantity: 2 }] },
  });
  const { code, qrValue } = await saved.json();
  expect(qrValue).toContain(`/waiter/cart/${code}`);

  // Signed out: sign in, then land back on the cart.
  await page.goto(`/waiter/cart/${code}`);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email', { exact: true }).fill(ctx.waiter.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/waiter/cart/${code}$`), { timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Guest’s order', exact: true })).toBeVisible();
  await expect(page.getByText('Table 4', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Check with the guest' })).toBeVisible();
  await page.getByRole('button', { name: /Confirm order · Ksh 300/ }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 20000 });

  await page.goto(`/waiter/cart/${code}`);
  await expect(page.getByRole('heading', { name: 'Already confirmed' })).toBeVisible({ timeout: 20000 });
  await page.goto('/waiter/cart/ACDACD');
  await expect(page.getByRole('heading', { name: 'We couldn’t find that order' })).toBeVisible({ timeout: 20000 });
});

test('dish video: a clip over 15 seconds is refused before upload; a short one uploads with a poster', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'cravio-video-'));
  const long = join(dir, 'long.mp4');
  const short = join(dir, 'short.mp4');
  let haveFfmpeg = true;
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=22:size=160x120:rate=12', '-pix_fmt', 'yuv420p', long]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=24', '-pix_fmt', 'yuv420p', short]);
  } catch { haveFfmpeg = false; }

  await signIn(page, ctx.owner.email);
  await expect(page).toHaveURL(/\/owner/, { timeout: 20000 });
  await page.goto('/onboarding/photos');
  const slot = page.getByLabel('Add a photo or video of Chicken wings');
  await expect(slot).toBeAttached({ timeout: 20000 });

  if (!haveFfmpeg) {
    // No ffmpeg: fake a 22-second clip by stubbing the metadata the browser reports.
    await page.evaluate(() => Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get: () => 22, configurable: true }));
    writeFileSync(long, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  }
  await slot.setInputFiles(long);
  await expect(page.getByText('This clip is 22 seconds. Keep it to 15 seconds or less.')).toBeVisible({ timeout: 20000 });
  let { data } = await service.from('menu_items').select('video_url').eq('id', ctx.items['Chicken wings']).single();
  expect(data.video_url).toBeNull();

  test.skip(!haveFfmpeg, 'ffmpeg is needed to make a real short clip for the upload half.');
  await slot.setInputFiles(short);
  await expect(page.getByRole('button', { name: 'Remove the video of Chicken wings' })).toBeVisible({ timeout: 40000 });
  ({ data } = await service.from('menu_items').select('video_url, video_poster_url, video_duration_seconds').eq('id', ctx.items['Chicken wings']).single());
  expect(data.video_url).toMatch(new RegExp(`/restaurant-media/${ctx.restaurantId}/videos/[\\w-]+\\.mp4$`));
  expect(data.video_poster_url).toMatch(new RegExp(`/restaurant-media/${ctx.restaurantId}/posters/[\\w-]+\\.jpg$`));
  expect(Number(data.video_duration_seconds)).toBeCloseTo(3, 0);

  // The guest menu shows the poster with a play badge, and the dish sheet plays it large.
  await page.goto(`/guest-menu?r=${ctx.restaurantId}&t=1`);
  await expect(page.locator('.mv-dish-photo.is-video video')).toHaveAttribute('playsinline', '', { timeout: 20000 });
  await page.getByRole('button', { name: 'Chicken wings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Chicken wings' }).getByLabel('Video of Chicken wings')).toBeVisible();
});

