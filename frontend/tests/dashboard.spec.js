import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

async function ownerLogin(page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('owner@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill('12344321');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

async function ownerLogout(page) {
  await page.getByRole('button', { name: 'Profile options' }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('owner navigation, login pill, settings, and new-tab guest menu work', async ({ page }) => {
  let profileRequests = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/me') profileRequests++; });
  await ownerLogin(page);
  const loginPill = page.getByRole('status').filter({ hasText: 'Login successful' });
  await expect(loginPill).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(loginPill).not.toBeVisible();
  const guest = await page.getByRole('link', { name: 'Guest menu', exact: true }).boundingBox();
  const footer = await page.locator('.sidebar-footer').boundingBox();
  const contact = await page.getByRole('link', { name: 'Contact Cravio', exact: true }).boundingBox();
  expect(guest.height).toBeLessThanOrEqual(32);
  expect(guest.y + guest.height).toBeLessThanOrEqual(footer.y);
  // Contact Cravio lives in the top bar beside refresh and notifications.
  expect(contact.y).toBeLessThan(80);
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAttribute('aria-label', 'Notifications (1 unread)');
  await bell.click();
  const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
  await expect(notifications.getByText('Login successful', { exact: true })).toBeVisible();
  await notifications.getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell).toHaveAttribute('aria-label', 'Notifications');
  await expect(notifications).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notifications).not.toBeVisible();
  await expect(bell).toBeFocused();
  await bell.click();
  await notifications.getByRole('button', { name: 'Clear all' }).click();
  await expect(notifications.getByText('No notifications yet.')).toBeVisible();
  await page.getByRole('heading', { name: 'Overview', exact: true }).click();
  await expect(notifications).not.toBeVisible();
  const initialProfileRequests = profileRequests;
  const nav = page.getByRole('navigation', { name: 'Owner navigation' });
  await expect(nav.getByRole('link')).toHaveText(['Overview', 'Orders', 'Tables', 'Products', 'Menu configuration', 'Guest menu', 'Insights']);
  for (const [label, path] of [['Orders', 'orders'], ['Tables', 'tables'], ['Products', 'products'], ['Menu configuration', 'menu'], ['Insights', 'insights'], ['Overview', '']]) {
    const link = nav.getByRole('link', { name: label, exact: true });
    await link.click();
    await expect(page).toHaveURL(`http://localhost:5173/owner${path ? `/${path}` : ''}`);
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
  expect(profileRequests).toBe(initialProfileRequests);
  await page.getByRole('link', { name: 'Contact Cravio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Contact Cravio', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Owner navigation' }).locator('..').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/owner\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile options' })).toHaveAttribute('aria-expanded', 'false');
  const guestLink = page.getByRole('link', { name: 'Guest menu', exact: true });
  await expect(guestLink).toHaveAttribute('target', '_blank');
  const opened = page.waitForEvent('popup');
  await guestLink.click();
  const guestPage = await opened;
  const { data: ownRestaurant } = await createAdmin().from('restaurants').select('id').eq('name', 'Demo Restaurant').limit(1).single();
  await expect(guestPage).toHaveURL(`http://localhost:5173/guest-menu?r=${ownRestaurant.id}`);
  await expect(guestPage.getByRole('heading', { level: 1, name: 'Demo Restaurant' })).toBeVisible();
  expect(await guestPage.evaluate(() => window.opener)).toBeNull();
  await guestPage.close();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Login successful' })).not.toBeVisible();
  await page.goto('/admin/restaurants');
  await expect(page).toHaveURL(/\/owner$/);
  await ownerLogout(page);
  await expect(page.getByRole('status').filter({ hasText: 'Signed out successfully' })).toBeVisible();
});

test('admin has every requested page and profile actions work by keyboard', async ({ page }) => {
  const admin = createAdmin();
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: env.SUPER_ADMIN_EMAIL });
  if (linkError) throw new Error('The reserved admin account must exist before this test.');
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  expect(error).toBeNull();
  const key = `sb-${new URL(env.SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
  try {
    await page.addInitScript(({ key, session }) => {
      if (!sessionStorage.getItem('dashboard-test-session')) {
        localStorage.setItem(key, JSON.stringify(session));
        sessionStorage.setItem('dashboard-test-session', 'true');
      }
    }, { key, session: data.session });
    await page.goto('/admin');
    const nav = page.getByRole('navigation', { name: 'Admin navigation' });
    await expect(nav.getByRole('link')).toHaveText(['Overview', 'Restaurants', 'Performance', 'Money', 'Leads & requests', 'Complaints', 'Users']);
    for (const [label, path] of [['Restaurants', 'restaurants'], ['Performance', 'performance'], ['Money', 'money'], ['Leads & requests', 'leads-requests'], ['Complaints', 'complaints'], ['Overview', '']]) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(`http://localhost:5173/admin${path ? `/${path}` : ''}`);
      await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'Guest menu', exact: true })).toHaveCount(0);
    const profile = page.getByRole('button', { name: 'Profile options' });
    await profile.focus();
    await page.keyboard.press('Enter');
    await expect(profile).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(profile).toHaveAttribute('aria-expanded', 'false');
    await expect(profile).toBeFocused();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await profile.click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally { await client.auth.signOut({ scope: 'local' }); }
});

test('mobile sidebar traps focus, closes on Escape and navigation, and fits small screens', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await ownerLogin(page);
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await bell.click();
  const panel = page.getByRole('region', { name: 'Notifications', exact: true });
  const bounds = await panel.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  const open = page.getByRole('button', { name: 'Open navigation' });
  await open.click();
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(open).toBeFocused();
  await open.click();
  await drawer.getByRole('link', { name: 'Orders', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await expect(drawer).not.toBeVisible();
  for (const label of ['Products', 'Menu configuration']) {
    await open.click();
    await drawer.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(drawer).not.toBeVisible();
  }
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open.click();
  await drawer.getByRole('button', { name: 'Profile options' }).click();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Profile options' })).toHaveAttribute('aria-expanded', 'false');
  await drawer.getByRole('button', { name: 'Profile options' }).click();
  await drawer.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});

test('guest menu without a restaurant is public', async ({ page }) => {
  await page.goto('/guest-menu');
  await expect(page.getByRole('heading', { name: 'Guest menu', exact: true })).toBeVisible();
  await expect(page.getByText('The restaurant menu will appear here.')).toBeVisible();
  await expect(page.getByText(/Scan the QR code on your table/)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Owner navigation' })).toHaveCount(0);
});

test('global search finds pages by keyword and scopes record searches', async ({ page }) => {
  await ownerLogin(page);
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox', { name: 'Search Cravio' });
  await expect(input).toBeFocused();
  await input.fill('o');
  await input.fill('dess');
  await expect(palette.getByRole('option', { selected: true })).toHaveCount(1);
  await expect(palette.getByRole('option').first()).toContainText('Desserts');
  await input.fill('sales');
  await expect(palette.getByRole('option').first()).toContainText('Orders');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('http://localhost:5173/owner/orders');
  await expect(palette).not.toBeVisible();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await input.fill('burrata');
  await palette.getByRole('option', { name: /Search products for “burrata”/ }).click();
  await expect(page).toHaveURL('http://localhost:5173/owner/products?q=burrata');
  await expect(page.getByRole('status').filter({ hasText: 'No products match “burrata” yet.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Clear search for burrata' })).toBeVisible();
  await page.keyboard.press('/');
  await expect(palette).toBeVisible();
  await input.fill('xqzv');
  await expect(palette.getByRole('option')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
  await ownerLogout(page);
});
