import { test, expect } from '@playwright/test';
import { createAdmin } from '../../backend/scripts/clients.js';

// The Menu Studio (/owner/menu) against a throwaway restaurant with its own owner, created with the service client
// and deleted in afterAll. Needs migrations 003 and 004. Never touches owner@gmail.com or the Demo Restaurant.

const service = createAdmin();
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `Studio-${stamp}-pw`;
const ctx = { users: [] };
const unwrap = (result, what) => { if (result.error) throw new Error(`${what}: ${result.error.message}`); return result.data; };
const designOf = async () => (await service.from('restaurants').select('menu_design, theme').eq('id', ctx.restaurantId).single()).data;

test.describe.configure({ mode: 'serial' });
test.setTimeout(90000);

test.beforeAll(async () => {
  test.setTimeout(90000);
  const email = `cravio-studio-owner-${stamp}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Studio Owner' }, app_metadata: { role: 'owner' } });
  if (error) throw new Error(`Could not create the owner: ${error.message}`);
  ctx.users.push(data.user.id);
  ctx.email = email;
  unwrap(await service.from('profiles').upsert({ id: data.user.id, name: 'Studio Owner', role: 'owner' }), 'profile');
  const restaurant = unwrap(await service.from('restaurants').insert({
    owner_id: data.user.id, name: `Studio Test ${stamp}`, status: 'live', went_live_at: new Date().toISOString(), area: 'Kilimani, Nairobi', theme: 'classic',
  }).select('id').single(), 'restaurant');
  ctx.restaurantId = restaurant.id;
  unwrap(await service.from('restaurant_members').insert({ restaurant_id: restaurant.id, user_id: data.user.id, role: 'owner' }), 'member');
  unwrap(await service.from('restaurant_tables').insert([1, 2].map((number) => ({ restaurant_id: restaurant.id, number }))), 'tables');
  const [mains, drinks] = unwrap(await service.from('menu_categories').insert([
    { restaurant_id: restaurant.id, name: 'Mains', position: 0 }, { restaurant_id: restaurant.id, name: 'Drinks', position: 1 },
  ]).select('id, name, position').order('position'), 'categories');
  ctx.categories = { mains: mains.id, drinks: drinks.id };
  const items = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Grilled chicken', description: 'Flame-grilled.', price: 850, position: 0, available: true, featured: true, featured_position: 0 },
    { restaurant_id: restaurant.id, category_id: mains.id, name: 'Pilau', price: 650, position: 1, available: true, featured: false },
    { restaurant_id: restaurant.id, category_id: drinks.id, name: 'Kenyan chai', price: 150, position: 0, available: true, featured: false },
  ]).select('id, name'), 'items');
  ctx.items = Object.fromEntries(items.map((item) => [item.name, item.id]));
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

async function openStudio(page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(ctx.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/owner/, { timeout: 20000 });
  await page.goto('/owner/menu');
  await expect(page.getByRole('heading', { name: 'Menu configuration', exact: true })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Studio' })).toBeVisible({ timeout: 20000 });
}

test('the studio edits a draft with a live preview, undo and redo, and publishes it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sent = [];
  page.on('request', (request) => { if (/\/api\/public\/(carts|requests|events)/.test(request.url())) sent.push(request.url()); });
  await openStudio(page);
  const status = page.getByRole('toolbar', { name: 'Studio' }).getByRole('status');
  const preview = page.getByRole('figure', { name: /Phone preview/ });
  await expect(status).toHaveText('Published');
  await expect(preview.getByRole('heading', { name: `Studio Test ${stamp}` })).toBeVisible();
  await expect(page.locator('.phone-screen')).toHaveAttribute('data-theme', 'classic');

  // Layout: hide Drinks, retitle Featured, move Mains to the top with the keyboard.
  await page.getByRole('button', { name: 'Hide Drinks' }).click();
  await expect(preview.getByRole('heading', { name: 'Drinks' })).toHaveCount(0);
  await expect(status).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: /^Featured/ }).click();
  await page.getByLabel('Title').fill('Chef’s picks');
  await expect(preview.getByRole('heading', { name: 'Chef’s picks' })).toBeVisible();
  const handle = page.getByRole('button', { name: 'Reorder Mains' });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(page.getByRole('list', { name: 'Menu sections, in order' }).getByRole('listitem').first()).toContainText('Mains');

  // Undo and redo with the keyboard (focus outside text fields).
  await page.getByRole('heading', { name: 'Menu configuration' }).click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('list', { name: 'Menu sections, in order' }).getByRole('listitem').first()).not.toContainText('Mains');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.getByRole('list', { name: 'Menu sections, in order' }).getByRole('listitem').first()).toContainText('Mains');

  // Type and colour.
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByRole('radio', { name: /Abril Fatface/ }).click();
  await page.getByRole('tab', { name: 'Colour' }).click();
  await page.getByRole('radio', { name: /Savanna/ }).click();
  await expect(page.locator('.phone-screen')).toHaveAttribute('data-theme', 'savanna');
  const accent = page.getByLabel('Accent (buttons and highlights)', { exact: true });
  await accent.fill('#zzz');
  await expect(page.getByText('Use a hex colour like #111110.')).toBeVisible();
  await accent.fill('#fafafa');
  await expect(page.getByText(/Buttons are hard to see/)).toBeVisible();
  await accent.fill('#1d4ed8');
  await expect(page.getByText(/Readable:/)).toBeVisible();

  // The preview is interactive but sends nothing.
  await preview.getByRole('button', { name: 'Add Grilled chicken' }).first().click();
  await preview.getByRole('button', { name: /1 item · Ksh 850/ }).click();
  const cart = preview.getByRole('dialog', { name: 'Your order' });
  await cart.getByRole('button', { name: 'Show to waiter' }).click();
  await expect(cart.getByText(/Nothing is sent from the preview/)).toBeVisible();
  await cart.getByRole('button', { name: 'Close your order' }).click();

  // Leaving with unpublished changes asks first.
  await page.getByRole('navigation', { name: 'Owner navigation' }).getByRole('link', { name: 'Products', exact: true }).click();
  const leave = page.getByRole('dialog', { name: 'Leave without publishing?' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/\/owner\/menu$/);

  await page.getByRole('button', { name: 'Publish changes' }).click();
  await expect(status).toHaveText('Published', { timeout: 20000 });
  const stored = await designOf();
  expect(stored.theme).toBe('savanna');
  expect(stored.menu_design.fonts.display).toBe('abril');
  expect(stored.menu_design.colors.accent).toBe('#1d4ed8');
  expect(stored.menu_design.sections[0]).toMatchObject({ type: 'category', categoryId: ctx.categories.mains });
  expect(stored.menu_design.sections.find((section) => section.type === 'featured').title).toBe('Chef’s picks');
  expect(stored.menu_design.sections.find((section) => section.categoryId === ctx.categories.drinks).visible).toBe(false);
  expect(sent).toEqual([]);

  // Guests get it on their next load.
  const guest = await page.context().newPage();
  await guest.route('**/api/public/events', (route) => route.fulfill({ status: 202, json: {} }));
  await guest.goto(`/guest-menu?r=${ctx.restaurantId}`);
  await expect(guest.getByRole('heading', { level: 2, name: 'Chef’s picks' })).toBeVisible({ timeout: 20000 });
  await expect(guest.getByRole('heading', { level: 2, name: 'Drinks' })).toHaveCount(0);
  await expect(guest.getByRole('navigation', { name: 'Menu categories' }).getByRole('link').first()).toHaveText('Mains');
  await guest.close();

  // Reset to default is a change like any other: unsaved until published, and undoable.
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await expect(status).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(status).toHaveText('Published');
});

test('an unpublished draft survives a reload on this device', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('tab', { name: 'Footer' }).click();
  await page.getByLabel('Tagline').fill('Karibu sana!');
  await expect(page.getByRole('figure', { name: /Phone preview/ }).getByText('Karibu sana!')).toBeVisible();
  await page.waitForTimeout(500);
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByText('We restored your unpublished draft from this device.')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('toolbar', { name: 'Studio' }).getByRole('status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Discard it' }).click();
  await expect(page.getByRole('toolbar', { name: 'Studio' }).getByRole('status')).toHaveText('Published');
});

test('on a phone the studio switches between Edit and Preview, with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio(page);
  await expect(page.getByRole('tab', { name: 'Layout' })).toBeVisible();
  await page.getByRole('radio', { name: 'Preview' }).click();
  await expect(page.getByRole('figure', { name: /Phone preview/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Layout' })).toBeHidden();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
