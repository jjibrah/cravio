// Speed of the inventory screens: the feature switch comes from /api/me, saved answers show at once and refresh behind
// them, identical requests are shared, and the badge/bell polling stays gentle. MOCKED like the other inventory specs.
//   cd frontend && npx playwright test tests/inventory-speed.spec.js
import { test, expect } from '@playwright/test';
import { API, BUSINESS, USER, chicken, overview, ownerAccount, setup } from './helpers/inventory-mock';

const withFlag = (on) => ({ ...ownerAccount, businesses: [{ ...ownerAccount.businesses[0], inventoryEnabled: on }] });
const named = (name) => ({ ...overview, items: [{ ...chicken, name }] });
const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts GETs by path while letting the shared mock answer. */
function counter() {
  const calls = {};
  const extra = ({ pathname, method }) => { if (method === 'GET') calls[pathname] = (calls[pathname] || 0) + 1; return false; };
  return { calls, extra };
}

test.describe('inventory speed', () => {
  test('the Stock page asks for the overview once (no second call from the sidebar)', async ({ page }) => {
    const { calls, extra } = counter();
    await setup(page, { account: withFlag(true), extra });
    await page.goto('/owner/inventory');
    await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByText('Chicken').first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(calls[API]).toBe(1);
  });

  test('an older server without the field: the sidebar and the Stock page still share one overview request', async ({ page }) => {
    const { calls, extra } = counter();
    await setup(page, { account: ownerAccount, extra });
    await page.goto('/owner/inventory');
    await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByText('Chicken').first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(calls[API]).toBe(1);
  });

  test('the switch comes from /api/me: no overview call to draw the navigation', async ({ page }) => {
    const { calls, extra } = counter();
    await setup(page, { account: withFlag(true), extra });
    await page.goto('/owner');
    await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Items' })).toBeVisible();
    expect(calls[API] || 0).toBe(0);
  });

  test('a business switched on later shows up after the window regains focus', async ({ page }) => {
    const account = withFlag(false);
    const { calls, extra } = counter();
    await setup(page, { account, extra });
    await page.goto('/owner');
    await expect(page.getByRole('link', { name: 'Inventory' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Approvals' })).toHaveCount(0);
    account.businesses[0].inventoryEnabled = true; // Cravio switches it on while the tab is open
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Items' })).toBeVisible();
    expect(calls[API] || 0).toBe(0);
  });

  test('a page that sees enabled:true while /api/me said off re-reads the account', async ({ page }) => {
    const account = withFlag(false);
    await setup(page, { account, extra: ({ pathname, method, json }) => {
      if (pathname === API && method === 'GET') { account.businesses[0].inventoryEnabled = true; return json(overview); } // the server has switched on since
      return false;
    } });
    await page.goto('/owner/inventory/items');
    await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible({ timeout: 15000 });
  });

  test('saved data shows at once on a reload, with "Updating…" until the fresh answer replaces it', async ({ page }) => {
    await setup(page, { account: withFlag(true), extra: async ({ pathname, method, json }) => {
      if (pathname === API && method === 'GET') { await DELAY(2500); return json(named('Chicken fresh')); }
      return false;
    } });
    // What the last visit left in this tab's storage (a minute old, so it is refreshed).
    await page.addInitScript(([user, key, data]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      sessionStorage.setItem(`cravio-swr:${user}|null|${key}`, JSON.stringify({ at: Date.now() - 60000, data }));
    }, [USER, API, named('Chicken saved')]);
    await page.goto('/owner/inventory');
    await expect(page.getByText('Chicken saved').first()).toBeVisible({ timeout: 2000 }); // before the 2.5 s answer
    await expect(page.getByText('Loading inventory')).toHaveCount(0);
    await expect(page.getByTestId('updating')).toBeVisible();
    await expect(page.getByText('Chicken fresh').first()).toBeVisible();
    await expect(page.getByText('Chicken saved')).toHaveCount(0);
    await expect(page.getByTestId('updating')).toHaveCount(0);
  });

  test('revisiting a screen after leaving it shows the earlier answer instantly, then the new one', async ({ page }) => {
    let version = 'Chicken one';
    await setup(page, { account: withFlag(true), extra: async ({ pathname, method, json }) => {
      if (pathname === API && method === 'GET') { const body = named(version); if (version !== 'Chicken one') await DELAY(2000); return json(body); }
      return false;
    } });
    await page.goto('/owner/inventory');
    await expect(page.getByText('Chicken one').first()).toBeVisible();
    await page.getByRole('link', { name: 'Suppliers' }).click();
    // The items changed on the server meanwhile, and a write elsewhere marked the saved copy stale.
    version = 'Chicken two';
    await page.evaluate(async () => { const { invalidate } = await import('/src/lib/cache.js'); invalidate('/api/owner/inventory'); });
    await page.getByRole('link', { name: 'Stock' }).click();
    await expect(page.getByText('Chicken one').first()).toBeVisible({ timeout: 1500 });
    await expect(page.getByText('Chicken two').first()).toBeVisible();
  });

  test('a write drops the saved copy of that list', async ({ page }) => {
    await setup(page, { account: withFlag(true), extra: ({ pathname, method, json }) => (pathname === `${API}/categories` && method === 'POST' ? json({ id: 'c1', name: 'Dry' }) : false) });
    await page.goto('/owner/inventory');
    await expect(page.getByText('Chicken').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((name) => name.startsWith('cravio-swr:')).length)).toBeGreaterThan(0);
    await page.evaluate(async (path) => { const { api } = await import('/src/lib/api.js'); await api(path, { method: 'POST', body: { name: 'Dry' } }); }, `${API}/categories`);
    await expect.poll(() => page.evaluate((path) => Object.keys(sessionStorage).some((name) => name.endsWith(`|${path}`)), API)).toBe(false);
  });

  test('two components asking for the same URL at once share one request', async ({ page }) => {
    const { calls, extra: count } = counter();
    const extra = (call) => (call.pathname === `${API}/suppliers` ? (count(call), call.json({ suppliers: [] })) : count(call));
    await setup(page, { account: withFlag(true), extra });
    await page.goto('/owner');
    await page.evaluate(async (path) => {
      const { api } = await import('/src/lib/api.js');
      await Promise.all([api(path), api(path), api(path)]);
    }, `${API}/suppliers`);
    expect(calls[`${API}/suppliers`]).toBe(1);
  });

  test('hovering a sidebar link starts that page\'s main GET', async ({ page }) => {
    const { calls, extra } = counter();
    await setup(page, { account: withFlag(true), extra });
    await page.goto('/owner');
    await expect(page.getByRole('link', { name: 'Suppliers' })).toBeVisible();
    expect(calls[`${API}/suppliers`] || 0).toBe(0);
    await page.getByRole('link', { name: 'Suppliers' }).hover();
    await expect.poll(() => calls[`${API}/suppliers`] || 0).toBe(1);
    await expect.poll(() => calls[API] || 0).toBe(1);
  });

  test('the approvals badge and the bell poll every 60 s while visible, and pause while hidden', async ({ page }) => {
    await page.clock.install();
    const { calls, extra } = counter();
    await setup(page, { account: withFlag(true), extra });
    await page.goto('/owner');
    const approvals = () => calls[`${API}/approvals`] || 0;
    const bell = () => calls['/api/notifications/unread-count'] || 0;
    await expect.poll(approvals).toBe(1);
    await expect.poll(bell).toBe(1);
    await page.clock.runFor(61000);
    await expect.poll(approvals).toBe(2);
    await expect.poll(bell).toBe(2);
    // Tab hidden: nothing runs, however long it stays that way.
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(300000);
    await page.waitForTimeout(300);
    expect(approvals()).toBe(2);
    expect(bell()).toBe(2);
    // Back in view after a long time: one refresh each, then the gentle rhythm resumes.
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(approvals).toBe(3);
    await expect.poll(bell).toBe(3);
  });
});
void BUSINESS;
