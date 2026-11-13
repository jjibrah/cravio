import { test, expect } from '@playwright/test';

// Speed guards: route-level code splitting, an in-shell navigation that keeps the sidebar and top bar,
// and reloads that render from the cached account instead of the full-screen loader.
// Read-only against the seeded Demo Restaurant owner.

// Measured on the production build (npm run build): /login loads ~501 KB of JavaScript
// (React + router ~258 KB, Supabase ~216 KB, the app shell and sign-in ~30 KB), down from one 885 KB file.
const LOGIN_JS_BUDGET = 560 * 1024;
// Code for other areas that the sign-in page must not download.
const NOT_ON_LOGIN = /OverviewPage|OrdersPage|TablesPage|ProductsPage|UsersPage|OnboardingPage|WaiterLayout|GuestMenuPage|LandingPage|qrcode/;

/** Flags any appearance of the full-screen CRAVIO loader from the first paint on. */
async function watchLoader(page) {
  await page.addInitScript(() => {
    window.__sawLoader = false;
    const check = () => { if (document.querySelector('[aria-label="Loading CRAVIO"]')) window.__sawLoader = true; };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
}

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

test('the sign-in page loads only its own code, within the JavaScript budget', async ({ page }) => {
  const scripts = [];
  page.on('response', async (response) => {
    if (response.request().resourceType() !== 'script') return;
    const body = await response.body().catch(() => null);
    scripts.push({ url: response.url(), bytes: body?.length || 0 });
  });
  await page.goto('/login');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await page.waitForLoadState('load');
  const loaded = [...scripts];
  const names = loaded.map((entry) => new URL(entry.url).pathname);
  expect(names.filter((name) => NOT_ON_LOGIN.test(name)), 'other areas’ code on /login').toEqual([]);
  // The byte budget applies to the production build; the dev server serves unbundled, unminified modules.
  const dev = names.some((name) => name.startsWith('/@vite/'));
  const total = loaded.reduce((sum, entry) => sum + entry.bytes, 0);
  test.info().annotations.push({ type: 'login-js', description: `${Math.round(total / 1024)} KB in ${loaded.length} files${dev ? ' (dev server)' : ''}` });
  if (!dev) expect(total).toBeLessThan(LOGIN_JS_BUDGET);
});

test('owner navigation keeps the shell and never shows the full-screen loader', async ({ page }) => {
  await ownerLogin(page);
  await page.evaluate(() => {
    window.__sawLoader = false;
    window.__lostShell = false;
    new MutationObserver(() => {
      if (document.querySelector('[aria-label="Loading CRAVIO"]')) window.__sawLoader = true;
      if (!document.querySelector('aside.sidebar') || !document.querySelector('.dashboard-topnav')) window.__lostShell = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const nav = page.getByRole('navigation', { name: 'Owner navigation' });
  for (const [label, path] of [['Orders', '/owner/orders'], ['Tables', '/owner/tables'], ['Overview', '/owner']]) {
    await nav.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: label, exact: true, level: 1 })).toBeVisible();
  }
  // Back on the Overview, the cached live data renders at once (no tile skeleton).
  await expect(page.locator('.table-tile').first()).toBeVisible({ timeout: 1000 });
  expect(await page.evaluate(() => window.__sawLoader)).toBe(false);
  expect(await page.evaluate(() => window.__lostShell)).toBe(false);
  await ownerLogout(page);
});

test('reloading /owner renders from the cached account while /api/me revalidates', async ({ page }) => {
  await ownerLogin(page);
  await watchLoader(page);
  // Hold /api/me well past the time the page needs: the page must not wait for it.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let profileRequests = 0;
  await page.route('**/api/me', async (route) => { profileRequests++; await gate; await route.continue().catch(() => {}); });
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('navigation', { name: 'Owner navigation' })).toBeVisible();
    expect(await page.evaluate(() => window.__sawLoader)).toBe(false);
    await expect.poll(() => profileRequests).toBe(1);
    // The background check doesn't block the Refresh button.
    await expect(page.locator('button.refresh-button')).toHaveAttribute('aria-busy', 'false');
  } finally { release(); }
  await page.unroute('**/api/me', { behavior: 'wait' });
  // An invalid session still wins: a 401 on refresh drops the cached account.
  await page.route('**/api/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Your session expired. Please sign in again.' }) }));
  await page.locator('button.refresh-button').click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('cravio-account:')))).toEqual([]);
  await page.unroute('**/api/me');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});
