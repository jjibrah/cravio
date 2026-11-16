// Inventory screens. First test is real and read-only (before migration 009 the page explains it isn't on yet).
// The others MOCK /api/stock and /api/owner/stock responses and abort every write, so nothing reaches the database.
import { test, expect } from '@playwright/test';

const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');
const ABDIS = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';
const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEMS = { fanta: '11111111-1111-4111-8111-111111111111', pilau: '22222222-2222-4222-8222-222222222222' };
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

const branchSnapshot = {
  businessId: BUSINESS, generatedAt: ago(0), unit: 'serving',
  items: [
    { id: ITEMS.fanta, name: 'Fanta 300ml', unit: 'serving', active: true, onHand: 14, reserved: 2, available: 12, lowLevel: 10, state: 'ok', dishes: 1 },
    { id: ITEMS.pilau, name: 'Pilau', unit: 'serving', active: true, onHand: 1, reserved: 0, available: 1, lowLevel: 5, state: 'low', dishes: 2 },
  ],
  dishes: [{ id: 'd1', name: 'Fanta', manuallySoldOut: false, link: { itemId: ITEMS.fanta, servings: 1, allowWhenOut: false } },
    { id: 'd2', name: 'Pilau (large)', manuallySoldOut: false, link: { itemId: ITEMS.pilau, servings: 2, allowWhenOut: false } },
    { id: 'd3', name: 'Tea', manuallySoldOut: false, link: null }],
  incoming: [{ id: 't1', number: 4, code: 'ABCDEFGH23', status: 'in_transit', note: null, requestId: 'r1', branchId: ABDIS, branchName: 'Abdis Test Restaurant',
    dispatchedAt: ago(40), receivedAt: null, lines: [{ itemId: ITEMS.pilau, name: 'Pilau', quantity: 20, received: null }] }],
  requests: [{ id: 'r1', number: 7, status: 'dispatched', note: 'Weekend', reviewNote: null, branchId: ABDIS, branchName: 'Abdis Test Restaurant', createdAt: ago(120), reviewedAt: ago(90),
    lines: [{ itemId: ITEMS.pilau, name: 'Pilau', requested: 25, approved: 20 }] }],
  movements: [{ id: 3, itemId: ITEMS.fanta, name: 'Fanta 300ml', change: -2, balance: 14, reason: 'served', note: null, at: ago(5), by: 'Waiter' },
    { id: 2, itemId: ITEMS.fanta, name: 'Fanta 300ml', change: 16, balance: 16, reason: 'count', note: 'Opening stock', at: ago(300), by: 'Branch Manager' }],
};
const ownerSnapshot = {
  businessId: BUSINESS, generatedAt: ago(0), unit: 'serving', role: 'owner', center: { id: 'c', name: 'Main center' },
  items: [{ id: ITEMS.fanta, name: 'Fanta 300ml', unit: 'serving', lowLevel: 10, centerOnHand: 120, branches: { [ABDIS]: 14 } },
    { id: ITEMS.pilau, name: 'Pilau', unit: 'serving', lowLevel: 5, centerOnHand: 40, branches: { [ABDIS]: 1 } }],
  branches: [{ id: ABDIS, name: 'Abdis Test Restaurant', status: 'live' }],
  requests: [{ id: 'r2', number: 8, status: 'submitted', note: 'Running low', reviewNote: null, branchId: ABDIS, branchName: 'Abdis Test Restaurant', createdAt: ago(10), reviewedAt: null,
    lines: [{ itemId: ITEMS.fanta, name: 'Fanta 300ml', requested: 24, approved: null }] }, branchSnapshot.requests[0]],
  transfers: [branchSnapshot.incoming[0]],
  centerMovements: [{ id: 9, itemId: ITEMS.fanta, name: 'Fanta 300ml', change: 120, balance: 120, reason: 'added', note: 'Supplier delivery', at: ago(600), by: 'Owner' }],
};

async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function mock(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET') return route.abort();
    if (pathname === '/api/stock') return route.fulfill({ json: branchSnapshot });
    if (pathname === `/api/owner/stock/${BUSINESS}`) return route.fulfill({ json: ownerSnapshot });
    if (pathname === '/api/owner/overview') return route.fulfill({ json: { generatedAt: ago(0), businesses: [{ id: BUSINESS, name: 'Abdis Test Restaurant', role: 'owner', branches: [] }] } });
    return route.continue();
  });
}

test('before migration 009 the branch Inventory page says it isn’t switched on (real, read-only)', async ({ page }) => {
  await signIn(page, 'manager@gmail.com');
  await expect(page).toHaveURL(new RegExp(`/branch/${ABDIS}$`));
  await page.getByRole('navigation', { name: 'Branch navigation' }).getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByText('Inventory isn’t switched on yet')).toBeVisible();
});

test('branch manager: stock, dish links, requests, deliveries and history (mocked)', async ({ page }, info) => {
  await mock(page);
  await signIn(page, 'manager@gmail.com');
  await expect(page).toHaveURL(new RegExp(`/branch/${ABDIS}$`));
  await page.goto(`/branch/${ABDIS}/inventory`);
  await expect(page.getByRole('cell', { name: '12 servings' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Pilau is low' })).toBeVisible();
  await page.getByRole('button', { name: 'Count / add / waste' }).first().click();
  await expect(page.getByLabel('Counted on hand now')).toBeVisible();
  await page.screenshot({ path: info.outputPath('branch-stock.png'), fullPage: true });
  await page.getByRole('radio', { name: /Dish links/ }).click();
  await expect(page.getByText('2 servings of Pilau per dish')).toBeVisible();
  await page.getByRole('radio', { name: /Deliveries/ }).click();
  await page.getByRole('button', { name: 'Receive' }).click();
  await expect(page.getByLabel(/Pilau/)).toHaveValue('20');
  await page.screenshot({ path: info.outputPath('branch-receive.png'), fullPage: true });
  await page.getByRole('radio', { name: /History/ }).click();
  await expect(page.getByText('Opening stock')).toBeVisible();
});

test('QR link opens the right branch delivery (mocked lookup)', async ({ page }) => {
  await mock(page);
  await page.route('**/api/stock/receive/ABCDEFGH23', (route) => route.fulfill({ json: { id: 't1', number: 4, status: 'in_transit', branchId: ABDIS } }));
  await signIn(page, 'manager@gmail.com');
  await expect(page).toHaveURL(new RegExp(`/branch/${ABDIS}$`));
  await page.goto('/receive/ABCDEFGH23');
  await expect(page.getByRole('button', { name: 'Confirm receipt' })).toBeVisible();
});

test('business owner: center stock, request review and dispatch note with QR (mocked)', async ({ page }, info) => {
  await mock(page);
  await signIn(page, 'owner@gmail.com');
  await expect(page).toHaveURL(/\/owner$/);
  await page.goto('/owner/inventory');
  await expect(page.getByRole('columnheader', { name: 'Main center' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '120 servings' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('owner-stock.png'), fullPage: true });
  await page.getByRole('radio', { name: /Requests/ }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('owner-review.png'), fullPage: true });
  await page.getByRole('radio', { name: /Dispatches/ }).click();
  await page.getByRole('button', { name: 'Note & QR' }).click();
  await expect(page.getByRole('img', { name: /QR code for dispatch ABCDEFGH23/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('owner-dispatch-note.png'), fullPage: true });
});
