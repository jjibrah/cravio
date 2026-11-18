// Branch inventory screens (P1-15): Stock, Record stock (count / add / waste), shortfalls, History, the orders deep link
// and the stock alerts in the notification bell. Everything is MOCKED like inventory-owner.spec.js: a fake signed-in session is
// planted in storage, /api/me and every API call are answered here, and any path not listed gets a 404.
//   cd frontend && npx playwright test tests/inventory-branch.spec.js
// These tests need the branch pages routed in App.jsx (INVENTORY_PAGES.branch).
import { test, expect } from '@playwright/test';

const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';
const LOCATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHICKEN = '11111111-1111-4111-8111-111111111111';
const RICE = '22222222-2222-4222-8222-222222222222';
const FLOUR = '33333333-3333-4333-8333-333333333333';
const USER = '99999999-9999-4999-8999-999999999999';
const EXC = '44444444-4444-4444-8444-444444444444';
const ORDER = '55555555-5555-4555-8555-555555555555';

const unitsOf = (base, extra = []) => [
  ...(base === 'g' ? [{ code: 'kg', label: 'kg', plural: 'kg', kind: 'standard', factor: '1000' }, { code: 'g', label: 'g', plural: 'g', kind: 'standard', factor: '1' }] : []),
  ...extra,
];
const crate = { code: 'crate', label: 'crate', plural: 'crates', kind: 'item', factor: '10000' };
const item = (id, name, onHand, shown, extra = {}) => ({
  id, name, sku: null, categoryId: null, categoryName: null, baseUnit: 'g', displayUnit: 'kg', onHand, heldForOrders: '0.0000', reserved: '0.0000', available: onHand,
  display: { onHand: shown, heldForOrders: '0 g', reserved: '0 g', available: shown }, level: null, levelDisplay: { min: null, reorder: '3 kg', par: null, max: null },
  out: false, low: false, countNeeded: false, countNeededReason: null, state: 'ok', status: 'OK', dishes: 2, openExceptions: 0, updatedAt: '2026-11-18T08:00:00Z',
  units: unitsOf('g', [crate]), avgCost: '0.650000', value: '3250.00', ...extra,
});
const chicken = item(CHICKEN, 'Chicken', '5000.0000', '5 kg', { heldForOrders: '1000.0000', available: '4000.0000', display: { onHand: '5 kg', heldForOrders: '1 kg', reserved: '0 g', available: '4 kg' }, low: true, state: 'low', status: 'Low' });
const rice = item(RICE, 'Rice', '0.0000', '0 g', { available: '0.0000', display: { onHand: '0 g', heldForOrders: '0 g', reserved: '0 g', available: '0 g' }, out: true, state: 'out', status: 'Out',
  countNeeded: true, countNeededReason: 'Orders were served without enough of this. Count it to correct the stock.', openExceptions: 1, dishes: 1, value: '0.00' });
const flour = item(FLOUR, 'Flour', '20000.0000', '20 kg', { available: '20000.0000', display: { onHand: '20 kg', heldForOrders: '0 g', reserved: '0 g', available: '20 kg' }, dishes: 0, value: '13000.00' });

const snapshot = ({ items = [chicken, rice, flour], openExceptions = 1, seeCost = true } = {}) => ({
  location: { id: LOCATION, name: 'Abdis Test Restaurant', restaurantId: BRANCH }, generatedAt: '2026-11-18T09:00:00Z', seeCost,
  summary: { items: items.length, low: items.filter((i) => i.state === 'low').length, out: items.filter((i) => i.state === 'out').length, countNeeded: items.filter((i) => i.countNeeded).length,
    ...(seeCost ? { value: '16250.00', valueComplete: true } : {}) },
  items: items.map((i) => (seeCost ? i : { ...i, value: undefined, avgCost: undefined })), dishes: { tracked: 3, keepSelling: 0, soldOut: [] }, openExceptions,
});

const manager = { id: USER, email: 'manager@example.com', name: 'Branch Manager', role: 'owner', home: `/branch/${BRANCH}`, onboardingRequired: false, businesses: [],
  branches: [{ id: BRANCH, name: 'Abdis Test Restaurant', role: 'manager', status: 'live', businessId: BUSINESS }] };

const move = (n, extra = {}) => ({ id: String(1000 - n), itemId: CHICKEN, itemName: 'Chicken', reason: 'count_correction', reasonLabel: 'Count', note: `Counted ${n} kg`, delta: '-200.0000', balanceAfter: '4800.0000',
  display: { delta: '-200 g', balanceAfter: '4.8 kg' }, entered: null, by: { id: USER, name: 'Branch Manager' }, order: null, occurredAt: `2026-11-1${(n % 9) + 1}T10:30:00Z`, createdAt: '2026-11-18T10:30:00Z', ...extra });

async function setup(page, { account = manager, extra = () => false, snap = snapshot() } = {}) {
  await page.addInitScript((user) => {
    const session = { access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'manager@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    localStorage.setItem('sb-zpsyrtbqobuwfnuddbsg-auth-token', JSON.stringify(session));
  }, USER);
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: { id: USER, aud: 'authenticated', email: 'manager@example.com' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (await extra({ route, request, pathname, searchParams, method, json })) return;
    if (pathname === '/api/me') return json(account);
    if (pathname === '/api/inventory' && method === 'GET') return json(snap);
    if (pathname === '/api/notifications/unread-count') return json({ unreadCount: 0 });
    if (pathname === '/api/notifications') return json({ notifications: [], unreadCount: 0, nextBefore: null });
    return json({ error: 'Not mocked in this test.' }, 404);
  });
}

const stock = (page) => page.goto(`/branch/${BRANCH}/inventory`);
const sheet = (page) => page.getByRole('dialog');

test.describe('Stock', () => {
  test('shows on hand, held, available, status badges, what needs attention, and filters', async ({ page }) => {
    await setup(page);
    await stock(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Stock' })).toBeVisible();
    const table = page.getByRole('table');
    for (const name of ['Item', 'On hand', 'Held for open orders', 'Available', 'Status', 'Value']) await expect(table.getByRole('columnheader', { name })).toBeVisible();
    const chickenRow = table.getByRole('row', { name: /Chicken/ });
    await expect(chickenRow).toContainText('5 kg');
    await expect(chickenRow).toContainText('1 kg');
    await expect(chickenRow).toContainText('4 kg');
    await expect(chickenRow).toContainText('Low');
    await expect(chickenRow).toContainText('Used in 2 dishes');
    await expect(table.getByRole('row', { name: /Rice/ })).toContainText('Out');
    await expect(table.getByRole('row', { name: /Rice/ })).toContainText('Count needed');
    await expect(table.getByRole('row', { name: /Flour/ })).toContainText('Ksh 13,000');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention).toContainText('1 item is out');
    await expect(attention).toContainText('1 running low');
    await expect(attention).toContainText('1 needs a count');
    await expect(attention).toContainText('1 order was served short');
    // Low or out only
    await page.getByLabel('Low or out only').check();
    await expect(table.getByRole('row', { name: /Flour/ })).toHaveCount(0);
    await page.getByLabel('Low or out only').uncheck();
    await page.getByLabel('Search items').fill('flo');
    await expect(table.getByRole('row', { name: /Chicken/ })).toHaveCount(0);
    await page.getByLabel('Search items').fill('zzz');
    await expect(page.getByText('No items match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(table.getByRole('row', { name: /Chicken/ })).toBeVisible();
  });

  test('hides value when the person may not see costs', async ({ page }) => {
    await setup(page, { snap: snapshot({ seeCost: false }) });
    await stock(page);
    await expect(page.getByRole('table').getByRole('columnheader', { name: 'On hand' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Value' })).toHaveCount(0);
    await expect(page.getByText('Ksh 13,000')).toHaveCount(0);
  });

  test('item sheet: balance, levels, latest changes and actions', async ({ page }) => {
    await setup(page, { extra: async ({ pathname, json }) => {
      if (pathname === `/api/inventory/items/${CHICKEN}`) { json({ ...chicken, location: {}, movements: [{ id: '1', reason: 'count_correction', reasonLabel: 'Count', note: 'Counted 5 kg', occurredAt: '2026-11-18T10:30:00Z', display: { delta: '-200 g', balanceAfter: '4.8 kg' } }] }); return true; }
      return false;
    } });
    await stock(page);
    await page.getByRole('button', { name: 'Chicken', exact: true }).click();
    const dialog = sheet(page);
    await expect(dialog.getByText('Held for open orders')).toBeVisible();
    await expect(dialog.getByText('Low at')).toBeVisible();
    await expect(dialog.getByText('3 kg')).toBeVisible();
    await expect(dialog.getByText('Latest changes')).toBeVisible();
    await expect(dialog.getByText('18/11/2026 13:30 EAT')).toBeVisible();
    await dialog.getByRole('button', { name: 'Waste', exact: true }).click();
    await expect(sheet(page).getByRole('radio', { name: /Waste/ })).toBeChecked();
    await expect(sheet(page).getByLabel('Item')).toHaveValue(CHICKEN);
  });

  test('guided start when nothing is recorded yet', async ({ page }) => {
    await setup(page, { snap: snapshot({ items: [], openExceptions: 0 }) });
    await stock(page);
    await expect(page.getByText('No stock recorded here yet')).toBeVisible();
    const guide = page.getByRole('list', { name: 'How to get started' });
    for (const step of ['Add your items', 'Count what you have', 'Add recipes', 'You’re done']) await expect(guide).toContainText(step);
    await expect(guide.getByRole('link', { name: 'Open Recipes' })).toHaveAttribute('href', `/branch/${BRANCH}/recipes`);
  });
});

test.describe('Record stock', () => {
  const open = async (page) => { await stock(page); await page.getByRole('button', { name: 'Record stock' }).first().click(); return sheet(page); };

  test('count: live explanation, request body, success message', async ({ page }) => {
    const posts = [];
    await setup(page, { extra: async ({ pathname, method, request, json }) => {
      if (pathname === '/api/inventory/record' && method === 'POST') {
        posts.push(request.postDataJSON());
        json({ kind: 'count', changed: true, itemId: CHICKEN, itemName: 'Chicken', onHand: '4800.0000', display: { onHand: '4.8 kg', change: '-200 g' },
          message: 'Counted 4.8 kg of Chicken. Stock was 5 kg, so it changed by -200 g.', warnings: [] });
        return true;
      }
      return false;
    } });
    const dialog = await open(page);
    await expect(dialog.getByRole('radio', { name: /Count/ })).toBeChecked();
    await dialog.getByLabel('Item').selectOption(CHICKEN);
    await expect(dialog.getByLabel('Unit for How much is there now?')).toHaveValue('kg');
    await dialog.getByLabel('How much is there now?', { exact: true }).fill('4.8');
    await expect(dialog.getByText('You counted 4.8 kg; the books say 5 kg → 0.2 kg less.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save count' }).click();
    await expect(page.getByText('Counted 4.8 kg of Chicken. Stock was 5 kg, so it changed by -200 g.')).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'count', itemId: CHICKEN, quantity: '4.8', unit: 'kg' });
    expect(posts[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(sheet(page)).toHaveCount(0);
  });

  test('add in a pack unit shows what it means and sends the unit and cost', async ({ page }) => {
    const posts = [];
    await setup(page, { extra: async ({ pathname, method, request, json }) => {
      if (pathname === '/api/inventory/record' && method === 'POST') { posts.push(request.postDataJSON()); json({ kind: 'add', changed: true, message: 'Added 400 kg of Chicken. Now 405 kg.', warnings: ['Heads up from the server.'] }); return true; }
      return false;
    } });
    const dialog = await open(page);
    await dialog.getByRole('radio', { name: /Add/ }).check({ force: true });
    await dialog.getByLabel('Item').selectOption(CHICKEN);
    await dialog.getByLabel('Unit for How much came in?').selectOption('crate');
    await dialog.getByLabel('How much came in?', { exact: true }).fill('40');
    await expect(dialog.getByText(/40 crates = 400 kg\. You will have 405 kg\./)).toBeVisible();
    await expect(dialog.getByText('KES per crate')).toBeVisible();
    await dialog.getByLabel(/Cost per crate/).fill('6500');
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(page.getByText('Added 400 kg of Chicken. Now 405 kg.')).toBeVisible();
    await expect(page.getByText('Heads up from the server.')).toBeVisible();
    expect(posts[0]).toMatchObject({ kind: 'add', itemId: CHICKEN, quantity: '40', unit: 'crate', unitCost: '6500' });
  });

  test('large amount: use the suggestion', async ({ page }) => {
    const posts = [];
    await setup(page, { extra: async ({ pathname, method, request, json }) => {
      if (pathname === '/api/inventory/record' && method === 'POST') {
        const body = request.postDataJSON();
        posts.push(body);
        if (!body.confirmLarge && body.quantity === '4000') { json({ error: '4,000 kg is a lot for Chicken. Did you mean 4 kg?', details: { code: 'confirm_large_amount', suggestion: { quantity: '4', unit: 'kg' }, confirmWith: 'confirmLarge' } }, 409); return true; }
        json({ kind: 'count', changed: true, message: 'Counted 4 kg of Chicken.', warnings: [] });
        return true;
      }
      return false;
    } });
    const dialog = await open(page);
    await dialog.getByLabel('Item').selectOption(CHICKEN);
    await dialog.getByLabel('How much is there now?', { exact: true }).fill('4000');
    await dialog.getByRole('button', { name: 'Save count' }).click();
    await expect(dialog.getByText('4,000 kg is a lot for Chicken. Did you mean 4 kg?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Use 4 kg instead' }).click();
    await expect(dialog.getByLabel('How much is there now?', { exact: true })).toHaveValue('4');
    await dialog.getByRole('button', { name: 'Save count' }).click();
    await expect(page.getByText('Counted 4 kg of Chicken.')).toBeVisible();
    expect(posts.map((p) => p.quantity)).toEqual(['4000', '4']);
  });

  test('large amount: "it is right" retries the same command with confirmLarge', async ({ page }) => {
    const posts = [];
    await setup(page, { extra: async ({ pathname, method, request, json }) => {
      if (pathname === '/api/inventory/record' && method === 'POST') {
        const body = request.postDataJSON();
        posts.push(body);
        if (!body.confirmLarge) { json({ error: '4,000 kg is a lot for Chicken. Did you mean 4 kg?', details: { code: 'confirm_large_amount', suggestion: { quantity: '4', unit: 'kg' } } }, 409); return true; }
        json({ kind: 'count', changed: true, message: 'Counted 4,000 kg of Chicken.', warnings: [] });
        return true;
      }
      return false;
    } });
    const dialog = await open(page);
    await dialog.getByLabel('Item').selectOption(CHICKEN);
    await dialog.getByLabel('How much is there now?', { exact: true }).fill('4000');
    await dialog.getByRole('button', { name: 'Save count' }).click();
    await dialog.getByRole('button', { name: 'Yes, 4,000 kg is right' }).click();
    await expect(page.getByText('Counted 4,000 kg of Chicken.')).toBeVisible();
    expect(posts).toHaveLength(2);
    expect(posts[1].confirmLarge).toBe(true);
    expect(posts[1].commandId).toBe(posts[0].commandId);
  });

  test('waste needs a reason, asks to confirm, and says plainly when there is not enough', async ({ page }) => {
    const posts = [];
    await setup(page, { extra: async ({ pathname, method, request, json }) => {
      if (pathname === '/api/inventory/record' && method === 'POST') {
        posts.push(request.postDataJSON());
        json({ error: 'There is only 5 kg of Chicken, so 50 kg can’t be written off.', details: { code: 'insufficient_stock' } }, 409);
        return true;
      }
      return false;
    } });
    const dialog = await open(page);
    await dialog.getByRole('radio', { name: /Waste/ }).check({ force: true });
    await dialog.getByLabel('Item').selectOption(CHICKEN);
    await dialog.getByLabel('How much was thrown away?', { exact: true }).fill('50');
    await dialog.getByRole('button', { name: 'Write off', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Say why Chicken was written off');
    expect(posts).toHaveLength(0);
    for (const reason of ['Spoiled', 'Burned', 'Spilled', 'Expired', 'Other']) await expect(dialog.getByRole('button', { name: reason, exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Other', exact: true }).click();
    await dialog.getByRole('button', { name: 'Write off', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Write a few words');
    await dialog.getByRole('button', { name: 'Spoiled', exact: true }).click();
    await dialog.getByRole('button', { name: 'Write off', exact: true }).click();
    await expect(dialog.getByText(/This can’t be undone/)).toBeVisible();
    expect(posts).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Yes, write it off' }).click();
    await expect(dialog.getByText('There is only 5 kg of Chicken, so 50 kg can’t be written off.')).toBeVisible();
    expect(posts[0]).toMatchObject({ kind: 'waste', itemId: CHICKEN, quantity: '50', unit: 'kg', note: 'spoiled' });
  });
});

test.describe('Shortfalls', () => {
  test('banner opens the list; marking one as checked sends the note', async ({ page }) => {
    const posts = [];
    let open = true;
    await setup(page, { extra: async ({ pathname, method, request, json }) => {
      if (pathname === '/api/inventory/exceptions') {
        json({ location: { id: LOCATION, name: 'x' }, openCount: open ? 1 : 0, exceptions: open ? [{ id: EXC, itemId: RICE, itemName: 'Rice', kind: 'served_short', shortQty: '300.0000', display: { shortQty: '300 g' },
          message: 'Rice was short by 300 g on order #92da2e.', status: 'open', note: null, createdAt: '2026-11-18T09:15:00Z', order: { id: ORDER, shortId: '92da2e', link: `/branch/${BRANCH}/orders?order=92da2e` } }] : [] });
        return true;
      }
      if (pathname === `/api/inventory/exceptions/${EXC}/resolve` && method === 'POST') { posts.push(request.postDataJSON()); open = false; json({ id: EXC, status: 'resolved', message: 'Marked as resolved: Rice.' }); return true; }
      return false;
    } });
    await stock(page);
    await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('1 order was served short');
    await page.getByRole('region', { name: 'Needs attention' }).getByRole('button', { name: 'Review' }).click();
    const dialog = sheet(page);
    await expect(dialog.getByText('These orders were served when the system showed too little stock. Count the item to correct it, then mark it as checked.')).toBeVisible();
    await expect(dialog.getByText('300 g')).toBeVisible();
    await expect(dialog.getByRole('link', { name: '#92da2e' })).toHaveAttribute('href', `/branch/${BRANCH}/orders?order=92da2e`);
    await expect(dialog.getByText('18/11/2026 12:15 EAT')).toBeVisible();
    await dialog.getByLabel('Note about Rice (optional)').fill('Recounted, 2 kg left');
    await dialog.getByRole('button', { name: 'Mark Rice as checked' }).click();
    await expect(page.getByText('Marked as resolved: Rice.')).toBeVisible();
    await expect(dialog.getByText('Nothing to check')).toBeVisible();
    expect(posts[0]).toMatchObject({ note: 'Recounted, 2 kg left' });
    expect(posts[0].commandId).toBeTruthy();
  });
});

test.describe('History', () => {
  test('newest first with who, note and order link; filter by item; load more', async ({ page }) => {
    const calls = [];
    await setup(page, { extra: async ({ pathname, searchParams, json }) => {
      if (pathname === '/api/inventory/history') {
        calls.push(searchParams.toString());
        if (searchParams.get('before') === '900') { json({ location: { id: LOCATION, name: 'x' }, movements: [move(8, { id: '899', note: 'Second page row' })], nextBefore: null }); return true; }
        json({ location: { id: LOCATION, name: 'x' }, nextBefore: searchParams.get('itemId') ? null : '900', movements: [
          move(1, { id: '950', reason: 'served', reasonLabel: 'Served in orders', note: null, by: null, delta: '-300.0000', display: { delta: '-300 g', balanceAfter: '4.7 kg' }, order: { id: ORDER, shortId: '92da2e', link: `/branch/${BRANCH}/orders?order=92da2e` } }),
          move(2, { id: '949', reason: 'adjustment_gain', reasonLabel: 'Stock added', note: 'Delivery', delta: '40000.0000', display: { delta: '+40 kg', balanceAfter: '45 kg' }, entered: { quantity: '4', unit: 'crate' } }),
        ] });
        return true;
      }
      return false;
    } });
    await page.goto(`/branch/${BRANCH}/inventory/history`);
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
    const table = page.getByRole('table');
    for (const name of ['When', 'What', 'Item', 'Change', 'Who', 'Note']) await expect(table.getByRole('columnheader', { name })).toBeVisible();
    const rows = table.getByRole('row');
    await expect(rows.nth(1)).toContainText('Served in orders');
    await expect(rows.nth(1)).toContainText('-300 g');
    await expect(rows.nth(1)).toContainText('System');
    await expect(rows.nth(1).getByRole('link', { name: 'Order #92da2e' })).toHaveAttribute('href', `/branch/${BRANCH}/orders?order=92da2e`);
    await expect(rows.nth(2)).toContainText('+40 kg');
    await expect(rows.nth(2)).toContainText('Branch Manager');
    await expect(rows.nth(2)).toContainText('Delivery');
    await expect(rows.nth(2)).toContainText('Entered as 4 crate');
    await expect(rows.nth(1)).toContainText(/\d{2}\/\d{2}\/2026 \d{2}:\d{2} EAT/);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByText('Second page row')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    expect(calls.at(-1)).toContain('before=900');
    await page.getByLabel('Item').selectOption(CHICKEN);
    await expect(page.getByText('Second page row')).toHaveCount(0);
    await expect.poll(() => calls.at(-1)).toContain(`itemId=${CHICKEN}`);
  });
});

test.describe('Orders deep link', () => {
  test('?order=<shortId> opens that order', async ({ page }) => {
    const opened = [];
    await setup(page, { extra: async ({ pathname, searchParams, json }) => {
      if (pathname === '/api/ops/orders' && searchParams.get('q') === '92da2e') { json({ orders: [{ id: ORDER, shortId: '92da2e' }], total: 1, hasMore: false }); return true; }
      if (pathname === '/api/ops/orders') { json({ orders: [], total: 0, hasMore: false }); return true; }
      if (pathname === `/api/ops/orders/${ORDER}`) { opened.push(pathname); json({ error: 'Not needed here.' }, 404); return true; }
      if (pathname.startsWith('/api/ops/')) { json({}); return true; }
      return false;
    } });
    await page.goto(`/branch/${BRANCH}/orders?order=92da2e`);
    await expect(page).toHaveURL(new RegExp(`order=${ORDER}`));
    await expect.poll(() => opened.length).toBeGreaterThan(0);
    expect(opened.every((path) => path === `/api/ops/orders/${ORDER}`)).toBe(true);
  });
});

test.describe('Stock alerts in the bell', () => {
  test('shows unread, opens the link and marks it read', async ({ page }) => {
    const reads = [];
    let unread = 2;
    const list = () => [
      { id: 'n1', kind: 'stock_out', title: 'Rice ran out', body: 'Rice is at 0 at Abdis Test Restaurant.', link: `/branch/${BRANCH}/inventory`, read: false, createdAt: '2026-11-18T09:00:00Z' },
      { id: 'n2', kind: 'served_short', title: 'Order served short', body: 'Rice was short by 300 g.', link: `/branch/${BRANCH}/inventory/history`, read: false, createdAt: '2026-11-18T08:00:00Z' },
    ].map((n) => ({ ...n, read: n.id === 'n1' && unread < 2 }));
    await setup(page, { extra: async ({ pathname, method, request, json }) => {
      if (pathname === '/api/notifications/unread-count') { json({ unreadCount: unread }); return true; }
      if (pathname === '/api/notifications/read' && method === 'POST') { reads.push(request.postDataJSON()); unread = 1; json({ marked: 1, unreadCount: unread }); return true; }
      if (pathname === '/api/notifications') { json({ notifications: list(), unreadCount: unread, nextBefore: null }); return true; }
      return false;
    } });
    await page.goto(`/branch/${BRANCH}/products`);
    const bell = page.getByRole('button', { name: 'Notifications (2 unread)' });
    await expect(bell).toBeVisible();
    await bell.click();
    const alerts = page.getByRole('region', { name: 'Stock alerts' });
    await expect(alerts.getByText('Order served short')).toBeVisible();
    await alerts.getByRole('button', { name: /Rice ran out/ }).click();
    await expect(page).toHaveURL(new RegExp(`/branch/${BRANCH}/inventory$`));
    expect(reads[0]).toMatchObject({ ids: ['n1'] });
    await expect(page.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
  });

  test('a waiter or a failing endpoint shows no stock alerts and no errors', async ({ page }) => {
    await setup(page, { extra: async ({ pathname, json }) => {
      if (pathname.startsWith('/api/notifications')) { json({ error: 'Nope' }, 500); return true; }
      return false;
    } });
    await page.goto(`/branch/${BRANCH}/products`);
    await page.getByRole('button', { name: 'Notifications' }).click();
    await expect(page.getByText('No notifications yet.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Stock alerts' })).toHaveCount(0);
  });
});

test.describe('Phone width', () => {
  test.use({ viewport: { width: 390, height: 800 } });
  const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  test('Stock, the Record stock sheet and History do not scroll sideways', async ({ page }) => {
    await setup(page, { extra: async ({ pathname, json }) => {
      if (pathname === '/api/inventory/history') { json({ location: {}, nextBefore: null, movements: [move(1), move(2)] }); return true; }
      return false;
    } });
    await stock(page);
    await expect(page.getByRole('button', { name: 'Chicken', exact: true })).toBeVisible();
    await noSideways(page);
    await page.getByRole('button', { name: 'Record stock' }).first().click();
    const dialog = sheet(page);
    await dialog.getByLabel('Item').selectOption(CHICKEN);
    await dialog.getByLabel('How much is there now?', { exact: true }).fill('4.8');
    await expect(dialog.getByText(/You counted 4.8 kg/)).toBeVisible();
    await noSideways(page);
    const box = await dialog.getByRole('button', { name: 'Save count' }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');
    await page.goto(`/branch/${BRANCH}/inventory/history`);
    await expect(page.getByRole('cell', { name: 'Branch Manager' }).first()).toBeVisible();
    await noSideways(page);
  });
});
