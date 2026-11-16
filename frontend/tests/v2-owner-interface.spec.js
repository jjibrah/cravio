// Owner / operations interface UI with MOCKED /api/me and /api/owner/* responses (migration 008 isn't applied to the
// shared database yet). Signs in for a real session; every non-GET request is aborted, so nothing is written.
//   V2_BASE_URL=http://localhost:5174 V2_TEST_PASSWORD=… npx playwright test -c playwright.v2.config.js
import { test, expect } from '@playwright/test';

const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ABDIS = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';
const WEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const today = (orders, paid, open, requests) => ({ orders, paidSales: paid, openOrders: open, openRequests: requests, lastOrderAt: new Date(Date.now() - 12 * 60000).toISOString() });
const branches = [
  { id: ABDIS, name: 'Abdis Test Restaurant', status: 'live', location: 'Kilimani', businessId: BUSINESS, canOpenWorkspace: true, today: today(14, 23850, 3, 1), setup: { tables: 14, items: 19, soldOut: 2 } },
  { id: WEST, name: 'Abdis Westlands', status: 'onboarding', location: 'Westlands', businessId: BUSINESS, canOpenWorkspace: false, today: today(0, 0, 0, 0), setup: { tables: 0, items: 0, soldOut: 0 } },
];

async function mockOwner(page, role = 'owner') {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.abort();
    const json = (body) => route.fulfill({ json: body });
    if (url.pathname === '/api/me') {
      const real = await (await route.fetch()).json();
      return json({ ...real, home: '/owner', businesses: [{ id: BUSINESS, name: 'Abdis Group', role, branchIds: role === 'owner' ? null : [ABDIS] }], businessAccessAvailable: true });
    }
    if (url.pathname === '/api/owner/overview') {
      return json({ generatedAt: new Date().toISOString(), timeZone: 'Africa/Nairobi',
        businesses: [{ id: BUSINESS, name: 'Abdis Group', role, branches: role === 'owner' ? branches : [branches[0]] }] });
    }
    if (url.pathname === `/api/owner/branches/${ABDIS}`) {
      return json({ ...branches[0], businessName: 'Abdis Group', businessRole: role, address: 'Argwings Kodhek Rd',
        staff: [{ userId: '1', name: 'Owner Test', role: 'manager', since: '2026-10-01T00:00:00Z' }, { userId: '2', name: 'Wanjiru', role: 'waiter', since: '2026-10-02T00:00:00Z' }],
        last7Days: Array.from({ length: 7 }, (_, i) => ({ day: new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10), orders: 10 + i, paidSales: 15000 + i * 900 })),
        generatedAt: new Date().toISOString() });
    }
    if (url.pathname === `/api/owner/businesses/${BUSINESS}/people`) {
      return json({ businessId: BUSINESS, yourRole: role, canManageAccess: role === 'owner', branches: branches.map(({ id, name }) => ({ id, name })),
        businessAccess: [{ userId: 'u-owner', name: 'Owner Test', role: 'owner', since: '2026-10-01T00:00:00Z', branchIds: null },
          { userId: 'u-ops', name: 'Amina Operations', role: 'operations', since: '2026-11-01T00:00:00Z', branchIds: [ABDIS] }],
        branchStaff: [{ userId: '2', name: 'Wanjiru', branchId: ABDIS, role: 'waiter' }] });
    }
    return route.continue();
  });
}

async function signIn(page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('owner@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('business owner: overview, locations, branch detail, people, and the way into a branch workspace', async ({ page }, info) => {
  await mockOwner(page);
  await signIn(page);
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Abdis Group/ })).toBeVisible();
  await expect(page.getByText('Ksh 23,850').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('owner-overview.png'), fullPage: true });

  // Only a branch with a manager role offers its workspace.
  const rows = page.locator('.biz-branch');
  await expect(rows.filter({ hasText: 'Abdis Test Restaurant' }).getByRole('link', { name: 'Open workspace' })).toBeVisible();
  await expect(rows.filter({ hasText: 'Abdis Westlands' }).getByRole('link', { name: 'Open workspace' })).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Owner navigation' }).getByRole('link', { name: 'Locations' }).click();
  await expect(page.getByRole('button', { name: 'Add branch' })).toBeVisible();
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.getByLabel('Branch name')).toBeVisible();
  await page.screenshot({ path: info.outputPath('owner-locations.png'), fullPage: true });

  await page.goto(`/owner/branches/${ABDIS}`);
  await expect(page.getByRole('heading', { name: 'Abdis Test Restaurant', level: 1 })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await page.screenshot({ path: info.outputPath('owner-branch.png'), fullPage: true });

  await page.getByRole('navigation', { name: 'Owner navigation' }).getByRole('link', { name: 'People & access' }).click();
  await expect(page.getByText('Amina Operations')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Grant operations access' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('owner-people.png'), fullPage: true });

  // Owner → branch workspace via the switcher; legacy branch pages work there.
  await page.getByRole('navigation', { name: 'Switch workspace' }).getByRole('link', { name: /Abdis Test Restaurant/ }).click();
  await expect(page).toHaveURL(new RegExp(`/branch/${ABDIS}$`));
  await expect(page.getByRole('navigation', { name: 'Switch workspace' }).getByRole('link', { name: /Owner overview/ })).toBeVisible();
});

test('operations manager: assigned branch only, no access controls', async ({ page }) => {
  await mockOwner(page, 'operations');
  await signIn(page);
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.locator('.biz-branch')).toHaveCount(1);
  await page.goto('/owner/people');
  await expect(page.getByText('Only the business owner changes access.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Grant operations access' })).toHaveCount(0);
});

test('mobile: owner overview fits without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOwner(page);
  await signIn(page);
  await expect(page.getByRole('heading', { name: /Abdis Group/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
