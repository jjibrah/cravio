// v2 interface routing, READ-ONLY: signs in and navigates; never saves, submits orders or changes settings,
// so it is safe against the shared development database. Run with the v2 config:
//   npx playwright test -c playwright.v2.config.js
// Needs the v2 backend and frontend running (see docs/v2/HANDOFF.md) and V2_TEST_PASSWORD set.
import { test, expect } from '@playwright/test';

const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('legacy owner lands in the branch-manager workspace, not the owner interface', async ({ page }) => {
  const branchHeaders = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/ops') || url.pathname.startsWith('/api/restaurant')) branchHeaders.add(request.headers()['x-cravio-branch'] || 'missing');
  });
  await signIn(page, 'owner@gmail.com');
  await expect(page).toHaveURL(/\/branch\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  const branchId = page.url().split('/branch/')[1];
  // Every branch-scoped API call names the branch from the URL.
  expect([...branchHeaders]).toEqual([branchId]);

  // Branch pages keep working under the new base path, and their links stay inside it.
  for (const [link, heading] of [['Orders', 'Orders'], ['Tables', 'Tables'], ['Products', 'Products'], ['Insights', 'Insights']]) {
    await page.getByRole('navigation', { name: 'Branch navigation' }).getByRole('link', { name: link, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/branch/${branchId}/${link.toLowerCase()}`));
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
  }
  await page.goto(`/branch/${branchId}/tables/1`);
  await expect(page.getByRole('link', { name: 'Tables' }).first()).toHaveAttribute('href', `/branch/${branchId}/tables`);

  // Old /owner deep links resolve to the same page in the branch workspace.
  await page.goto('/owner/orders?view=all');
  await expect(page).toHaveURL(new RegExp(`/branch/${branchId}/orders\\?view=all$`));
  await page.goto('/owner/tables/3');
  await expect(page).toHaveURL(new RegExp(`/branch/${branchId}/tables/3$`));

  // No business grant: the owner interface is not offered and redirects home.
  await page.goto('/owner');
  await expect(page).toHaveURL(new RegExp(`/branch/${branchId}$`));
  // A branch the account doesn't manage is refused.
  await page.goto('/branch/0f743f69-0386-4ce6-8c51-f03b417e2784');
  await expect(page).toHaveURL(new RegExp(`/branch/${branchId}$`));
});

test('waiter lands in the waiter app scoped to their branch and cannot open branch or owner areas', async ({ page }) => {
  const headers = new Set();
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/ops')) headers.add(request.headers()['x-cravio-branch'] || 'missing'); });
  await signIn(page, 'waiter@gmail.com');
  await expect(page).toHaveURL(/\/waiter$/);
  await expect(page.locator('.waiter-restaurant-name')).toHaveText('Abdis Test Restaurant');
  await page.getByRole('navigation', { name: 'Waiter navigation' }).getByRole('link', { name: 'Menu' }).click();
  await expect(page.getByRole('heading').first()).toBeVisible();
  expect([...headers].every((value) => value === '106fe2fb-94bb-4f5d-bd0d-bd694004424c')).toBe(true);
  await page.goto('/branch/106fe2fb-94bb-4f5d-bd0d-bd694004424c/orders');
  await expect(page).toHaveURL(/\/waiter$/);
  await page.goto('/owner');
  await expect(page).toHaveURL(/\/waiter$/);
});

test('guest menu QR link still opens without signing in', async ({ page }) => {
  await page.goto('/guest-menu?r=106fe2fb-94bb-4f5d-bd0d-bd694004424c&t=1');
  await expect(page.getByText('Abdis Test Restaurant').first()).toBeVisible();
});
