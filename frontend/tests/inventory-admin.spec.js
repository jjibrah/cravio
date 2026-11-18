// P1-17 admin Inventory module switch. Everything is MOCKED like inventory-owner.spec.js: a fake signed-in admin session is planted
// in storage and every admin call is answered here; any API path not listed gets a 404. No backend or database is touched.
//   cd frontend && npx playwright test tests/inventory-admin.spec.js
import { test, expect } from '@playwright/test';

const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '99999999-9999-4999-8999-999999999999';
const admin = { id: USER, email: 'admin@example.com', name: 'Platform Admin', role: 'admin', home: '/admin', onboardingRequired: false, businesses: [], branches: [] };
const stock = { items: 3, trackedDishes: 1, out: 0, requestsWaiting: 0, inTransit: 0, shortDeliveries30d: 0 };

const state = { enabled: false, posts: [], events: [] };
const detail = () => ({
  id: BUSINESS, name: 'Abdis Group', createdAt: '2026-01-01T00:00:00Z', branches: [], access: [{ userId: 'u1', name: 'Owner One', email: 'o@example.com', role: 'owner', since: '2026-01-01T00:00:00Z', lastSignInAt: null, branchIds: null }],
  stock, inventoryEnabled: state.enabled, history: state.events,
});
const row = (id, name, inventoryEnabled) => ({ id, name, createdAt: '2026-01-01T00:00:00Z', status: 'live', owners: [{ userId: 'u1', name: 'Owner One', email: 'o@example.com' }], operations: 0,
  branches: [{ id: `${id}-b`, name: 'Main', status: 'live', location: 'CBD' }], staff: 2, orders30d: 5, paid30d: 1200, lastOrderAt: null, stock, inventoryEnabled });
const event = () => ({ id: 1, action: state.enabled ? 'inventory_enabled' : 'inventory_disabled', text: state.enabled ? 'switched Inventory on' : 'switched Inventory off',
  at: new Date().toISOString(), business: { id: BUSINESS, name: 'Abdis Group' }, branch: null, actor: { id: USER, name: 'Platform Admin', email: 'admin@example.com' }, subject: null,
  role: null, note: 'Pilot', viaAdmin: true });

test.beforeEach(async ({ page }) => {
  state.enabled = false; state.posts = []; state.events = [];
  await page.addInitScript((user) => {
    const session = { access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'admin@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    localStorage.setItem('sb-zpsyrtbqobuwfnuddbsg-auth-token', JSON.stringify(session));
  }, USER);
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: { id: USER, aud: 'authenticated', email: 'admin@example.com' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/api/me') return json(admin);
    if (pathname === `/api/admin/businesses/${BUSINESS}/inventory` && method === 'POST') {
      const body = request.postDataJSON();
      state.posts.push(body); state.enabled = body.enabled; state.events = [event()];
      return json({ id: BUSINESS, inventoryEnabled: state.enabled, changed: true });
    }
    if (pathname === `/api/admin/businesses/${BUSINESS}` && method === 'GET') return json(detail());
    if (pathname === '/api/admin/businesses' && method === 'GET') {
      const rows = [row(BUSINESS, 'Abdis Group', state.enabled), row(OTHER, 'Mama Oliech', false)];
      return json({ businesses: rows, counts: { all: 2, live: 2, onboarding: 0, noOwner: 0, branches: 2 }, stockAvailable: true, currency: 'KES' });
    }
    if (pathname === '/api/admin/activity') return json({ events: state.events });
    if (pathname === '/api/notifications' || pathname === '/api/notifications/unread-count') return json(pathname.endsWith('count') ? { count: 0 } : { notifications: [] });
    return json({ error: 'Not mocked in this test.' }, 404);
  });
});

test('admin switches Inventory on from the business page, with a confirm', async ({ page }) => {
  await page.goto(`/admin/businesses/${BUSINESS}`);
  const panel = page.locator('section, div').filter({ has: page.getByRole('heading', { name: 'Inventory module' }) }).last();
  await expect(page.getByTestId('inventory-status')).toHaveText('Off');
  await expect(page.getByText('When on, the owner and branch managers get Stock, Items, Recipes and History.')).toBeVisible();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Switch on', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Switch Inventory on?')).toBeVisible();
  expect(state.posts).toEqual([]);   // nothing is sent before the confirm
  await dialog.getByLabel(/Note/).fill('Pilot');
  await dialog.getByRole('button', { name: 'Switch Inventory on' }).click();
  await expect(page.getByTestId('inventory-status')).toHaveText('On');
  expect(state.posts).toEqual([{ enabled: true, reason: 'Pilot' }]);
  await expect(page.getByText('switched Inventory on').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch off', exact: true })).toBeVisible();
});

test('switching off warns that nothing is deleted and sends enabled:false', async ({ page }) => {
  state.enabled = true;
  await page.goto(`/admin/businesses/${BUSINESS}`);
  await expect(page.getByTestId('inventory-status')).toHaveText('On');
  await page.getByRole('button', { name: 'Switch off', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Owners and managers will go back to the old Inventory page. Nothing is deleted.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(state.posts).toEqual([]);
  await page.getByRole('button', { name: 'Switch off', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch Inventory off' }).click();
  await expect(page.getByTestId('inventory-status')).toHaveText('Off');
  expect(state.posts).toEqual([{ enabled: false }]);
});

test('businesses list shows an "Inventory on" chip only where it is on', async ({ page }) => {
  state.enabled = true;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/businesses');
  await expect(page.getByRole('row').filter({ hasText: 'Abdis Group' })).toContainText('Inventory on');
  await expect(page.getByRole('row').filter({ hasText: 'Mama Oliech' })).not.toContainText('Inventory on');
});

test('activity page words the switch events plainly', async ({ page }) => {
  state.enabled = true; state.events = [event()];
  await page.goto('/admin/activity');
  const item = page.getByRole('listitem').filter({ hasText: 'switched Inventory on' });
  await expect(item).toContainText('Platform Admin');
  await expect(item).toContainText('Abdis Group');
  await expect(item).toContainText('“Pilot”');
});

test('when the inventory update is not applied the panel says so and has no switch', async ({ page }) => {
  await page.route(`**/api/admin/businesses/${BUSINESS}`, (route) => route.fulfill({ json: { ...detail(), inventoryEnabled: null, stock: null } }));
  await page.goto(`/admin/businesses/${BUSINESS}`);
  await expect(page.getByText('Not available yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch on', exact: true })).toHaveCount(0);
});
