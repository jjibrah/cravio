import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

async function openDashboard(page, role) {
  let client;
  if (role === 'admin') {
    const admin = createAdmin();
    const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: env.SUPER_ADMIN_EMAIL });
    if (error) throw new Error('The configured admin account must exist.');
    client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error: verifyError } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
    expect(verifyError).toBeNull();
    const key = `sb-${new URL(env.SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
    await page.addInitScript(({ key, session }) => {
      if (!sessionStorage.getItem('refresh-test-session')) {
        localStorage.setItem(key, JSON.stringify(session));
        sessionStorage.setItem('refresh-test-session', 'true');
      }
    }, { key, session: data.session });
  } else {
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(`${role}@gmail.com`);
    await page.getByLabel('Password', { exact: true }).fill('12344321');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`http://localhost:5173/${role}`);
  }
  const path = role === 'waiter' ? '/waiter/services' : role === 'owner' ? '/owner/orders' : '/admin/restaurants';
  const title = role === 'waiter' ? 'Services' : role === 'owner' ? 'Orders' : 'Restaurants';
  await page.goto(path);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return { path, title, dispose: async () => { if (client) await client.auth.signOut({ scope: 'local' }); } };
}

async function logout(page, role) {
  if (role === 'waiter') await page.getByRole('button', { name: 'Open profile' }).click();
  else {
    if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Profile options' }).click();
  }
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
}

for (const role of ['admin', 'owner', 'waiter']) {
  test(`${role} refresh keeps the current tab and header while reloading data`, async ({ page }) => {
    const { path, title, dispose } = await openDashboard(page, role);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let requests = 0;
    await page.route('**/api/me', async (route) => { requests++; await gate; await route.continue(); });
    const refresh = page.locator('button.refresh-button');
    const originalHeading = await page.getByRole('heading', { name: title, exact: true }).elementHandle();
    await page.evaluate(() => { window.refreshTestMarker = true; });
    try {
      await refresh.click();
      await expect(refresh).toHaveAttribute('aria-busy', 'true');
      await expect(refresh).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(page.getByRole('status', { name: 'Loading CRAVIO' })).toHaveCount(0);
      await expect.poll(() => requests).toBe(1);
      await refresh.click({ force: true });
      expect(requests).toBe(1);
    } finally { release(); }
    try {
      await expect(refresh).toHaveAttribute('aria-busy', 'false');
      await expect(page).toHaveURL(`http://localhost:5173${path}`);
      expect(await originalHeading.evaluate((element) => element.isConnected)).toBe(false);
      expect(await page.evaluate(() => window.refreshTestMarker)).toBe(true);
      await page.setViewportSize({ width: 320, height: 740 });
      await expect(refresh).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await logout(page, role);
    } finally { await dispose(); }
  });
}

test('refresh failure keeps the page available, supports retry, and rejects invalid sessions', async ({ page }) => {
  await openDashboard(page, 'owner');
  await page.route('**/api/me', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Refresh failed. Please try again.' }) }));
  const refresh = page.locator('button.refresh-button');
  await refresh.click();
  await expect(page.getByRole('alert')).toHaveText('Refresh failed. Please try again.');
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await expect(refresh).toHaveAttribute('aria-busy', 'false');
  await page.unroute('**/api/me');
  const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/me');
  await refresh.click();
  expect((await reloaded).status()).toBe(200);
  await expect(refresh).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('alert')).not.toBeVisible();
  await page.route('**/api/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Your session expired. Please sign in again.' }) }));
  await refresh.click();
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).not.toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Your session expired. Please sign in again.');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('alert')).not.toBeVisible();
});
