// Owner inventory screens (P1-13 navigation, P1-14 owner screens). Everything is MOCKED: a fake signed-in session is planted in
// storage, /api/me and every inventory call are answered here, and any API path not listed gets a 404. Nothing reaches the
// backend or the database, so this needs no password and no seeded data.
//   cd frontend && npx playwright test tests/inventory-owner.spec.js
import { test, expect } from '@playwright/test';

const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';
const WAREHOUSE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BRANCH_LOCATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHICKEN = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';

const UNITS = [
  { code: 'mg', dimension: 'weight', toBase: '0.001', label: 'mg', plural: 'mg' },
  { code: 'g', dimension: 'weight', toBase: '1', label: 'g', plural: 'g' },
  { code: 'kg', dimension: 'weight', toBase: '1000', label: 'kg', plural: 'kg' },
  { code: 'ml', dimension: 'volume', toBase: '1', label: 'ml', plural: 'ml' },
  { code: 'l', dimension: 'volume', toBase: '1000', label: 'L', plural: 'L' },
  { code: 'piece', dimension: 'count', toBase: '1', label: 'piece', plural: 'pieces' },
  { code: 'serving', dimension: 'serving', toBase: '1', label: 'serving', plural: 'servings' },
];
const MEASURED_BY = [
  { value: 'weight', label: 'Weight', baseUnit: 'g', example: 'flour, chicken, rice' },
  { value: 'volume', label: 'Volume', baseUnit: 'ml', example: 'oil, milk, juice' },
  { value: 'count', label: 'Count', baseUnit: 'piece', example: 'eggs, buns, bottles' },
  { value: 'servings', label: 'Servings', baseUnit: 'serving', example: 'prepared portions' },
];
const ALL = ['inv.view', 'inv.cost.view', 'inv.item.edit', 'inv.stock.record', 'inv.settings.edit'];
const locations = [
  { id: WAREHOUSE, kind: 'center', name: 'Warehouse', code: null, status: 'active', restaurantId: null, label: 'Warehouse', capabilities: ALL },
  { id: BRANCH_LOCATION, kind: 'branch', name: 'Abdis Test Restaurant', code: null, status: 'active', restaurantId: BRANCH, label: 'Branch', capabilities: ALL },
];
const entry = (locationId, locationName, kind, onHand, shown, extra = {}) => ({ locationId, locationName, kind, onHand, reserved: '0.0000', available: onHand,
  display: { onHand: shown, reserved: '0 g', available: shown }, low: false, level: null, levelDisplay: null, value: '0.00', ...extra });
const chicken = {
  id: CHICKEN, name: 'Chicken', sku: 'CHK-001', kind: 'raw', storage: 'frozen', categoryId: 'cat-meat', categoryName: 'Meat and poultry',
  baseUnit: 'g', measuredBy: 'weight', displayUnit: 'kg', yieldPct: 85, vatClass: 'standard', notes: null, lowLevel: '20000.0000', lowLevelDisplay: '20 kg',
  archived: false, archivedAt: null, units: [{ id: 'u1', name: 'crate', factor: '10000.0000', forPurchase: true, forRecipe: false, forCount: true, size: '10 kg' }], barcodes: [],
  locations: [entry(WAREHOUSE, 'Warehouse', 'center', '38400.0000', '38.4 kg'), entry(BRANCH_LOCATION, 'Abdis Test Restaurant', 'branch', '4000.0000', '4 kg', { low: true })],
  totals: { onHand: '42400.0000', reserved: '0.0000', available: '42400.0000', display: { onHand: '42.4 kg', reserved: '0 g', available: '42.4 kg' }, value: '27560.00' }, low: true, avgCost: '0.650000', lastCost: '0.650000',
};
const overview = (enabled = true) => (enabled ? {
  enabled: true, role: 'owner',
  capabilities: { view: true, costView: true, itemEdit: true, recipeEdit: true, stockRecord: true, settingsEdit: true },
  warehouse: locations[0], locations, categories: [{ id: 'cat-meat', name: 'Meat and poultry', parentId: null, position: 0, active: true, itemCount: 1 }],
  units: UNITS, measuredBy: MEASURED_BY, items: [chicken], settings: {},
} : { enabled: false, role: 'owner', capabilities: {}, warehouse: null, locations: [], categories: [], units: [], measuredBy: MEASURED_BY, items: [], settings: null,
  message: 'Inventory isn’t switched on for this business yet.' });

const ownerAccount = { id: USER, email: 'owner@example.com', name: 'Owner Test', role: 'owner', home: '/owner', onboardingRequired: false,
  businesses: [{ id: BUSINESS, name: 'Abdis Group', role: 'owner', branchIds: null }], branches: [] };
const managerAccount = { id: USER, email: 'manager@example.com', name: 'Branch Manager', role: 'owner', home: `/branch/${BRANCH}`, onboardingRequired: false, businesses: [],
  branches: [{ id: BRANCH, name: 'Abdis Test Restaurant', role: 'manager', status: 'live', businessId: BUSINESS }] };

/** A signed-in session in storage (the Supabase client reads it without calling the network) and every API call mocked. */
async function setup(page, { account = ownerAccount, inventory = true, extra = () => false } = {}) {
  await page.addInitScript((user) => {
    const session = { access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    localStorage.setItem('sb-zpsyrtbqobuwfnuddbsg-auth-token', JSON.stringify(session));
  }, USER);
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: { id: USER, aud: 'authenticated', email: 'owner@example.com' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (await extra({ route, request, pathname, search, method, json })) return;
    if (pathname === '/api/me') return json(account);
    if (pathname === `/api/owner/inventory/${BUSINESS}` && method === 'GET') return json(overview(inventory));
    if (pathname === '/api/inventory' && method === 'GET') return inventory ? json({ items: [] }) : json({ error: 'Inventory is off.', details: { code: 'inventory_disabled' } }, 403);
    if (pathname === '/api/notifications' || pathname === '/api/notifications/unread-count') return json(pathname.endsWith('count') ? { count: 0 } : { notifications: [] });
    return json({ error: 'Not mocked in this test.' }, 404);
  });
}

const sidebar = (page) => page.getByRole('navigation', { name: 'Owner navigation' });

test.describe('inventory off', () => {
  test('keeps today’s single Inventory entry and shows a friendly panel on the new pages', async ({ page }) => {
    await setup(page, { inventory: false });
    await page.goto('/owner/inventory/items');
    await expect(page.getByText('Inventory isn’t switched on for this business yet.')).toBeVisible();
    await expect(page.getByText('Contact Cravio to switch it on.')).toBeVisible();
    await expect(sidebar(page).getByRole('link', { name: 'Inventory', exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('Operations', { exact: true })).toHaveCount(0);
    await expect(sidebar(page).getByRole('link', { name: 'Items', exact: true })).toHaveCount(0);
    // Today's page keeps its place at /owner/inventory.
    await page.goto('/owner/inventory?view=requests');
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  });
});

test.describe('inventory on: navigation', () => {
  test('owner sidebar shows an Operations group; old ?view= links still land on Stock', async ({ page }) => {
    await setup(page);
    await page.goto('/owner/inventory?view=requests');
    await expect(sidebar(page).getByText('Operations', { exact: true })).toBeVisible();
    for (const name of ['Stock', 'Items', 'Recipes', 'History']) await expect(sidebar(page).getByRole('link', { name, exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole('link', { name: 'Inventory', exact: true })).toHaveCount(0);
    await expect(sidebar(page).getByText('Business', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole('link', { name: 'Locations' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Stock' })).toBeVisible();
    // Stock is the active entry on /inventory, not on /inventory/items.
    await expect(sidebar(page).getByRole('link', { name: 'Stock', exact: true })).toHaveClass(/is-active/);
    await sidebar(page).getByRole('link', { name: 'Items', exact: true }).click();
    await expect(page).toHaveURL(/\/owner\/inventory\/items$/);
    await expect(sidebar(page).getByRole('link', { name: 'Stock', exact: true })).not.toHaveClass(/is-active/);
    await sidebar(page).getByRole('link', { name: 'Recipes', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Recipes' })).toBeVisible();
    await page.goto('/owner/inventory?view=history');
    await expect(page).toHaveURL(/\/owner\/inventory\/history$/);
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  });

  test('branch sidebar: Operations (Stock, History) and Menu → Recipes, with coming-next pages', async ({ page }) => {
    await setup(page, { account: managerAccount });
    await page.goto(`/branch/${BRANCH}/recipes`);
    const nav = page.getByRole('navigation', { name: 'Branch navigation' });
    await expect(nav.getByText('Operations', { exact: true })).toBeVisible();
    for (const name of ['Stock', 'History', 'Recipes']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Inventory', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Recipes' })).toBeVisible();
    await nav.getByRole('link', { name: 'History', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/branch/${BRANCH}/inventory/history$`));
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  });

  test('branch with inventory off keeps the single Inventory entry', async ({ page }) => {
    await setup(page, { account: managerAccount, inventory: false });
    await page.goto(`/branch/${BRANCH}/products`);
    const nav = page.getByRole('navigation', { name: 'Branch navigation' });
    await expect(nav.getByRole('link', { name: 'Inventory', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Recipes', exact: true })).toHaveCount(0);
  });
});

test.describe('inventory on: owner screens', () => {
  test('Stock shows items by place with low badges, value and filters', async ({ page }) => {
    await setup(page);
    await page.goto('/owner/inventory');
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Warehouse' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Abdis Test Restaurant' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Value' })).toBeVisible();
    await expect(table.getByText('38.4 kg')).toBeVisible();
    await expect(table.getByText('Low', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('1 running low');
    await page.getByLabel('Search items').fill('zzz');
    await expect(page.getByText('No items match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(table.getByText('38.4 kg')).toBeVisible();
    await expect(page.getByRole('button', { name: /Download as spreadsheet/ })).toBeVisible();
  });

  test('add an item measured by weight in kg with a crate pack sends the right request', async ({ page }) => {
    let created = null;
    await setup(page, {
      extra: async ({ request, pathname, method, json }) => {
        if (method === 'POST' && pathname === `/api/owner/inventory/${BUSINESS}/items`) {
          created = request.postDataJSON();
          json({ ...chicken, id: '22222222-2222-4222-8222-222222222222', name: created.name });
          return true;
        }
        return false;
      },
    });
    await page.goto('/owner/inventory/items');
    await page.getByRole('button', { name: 'Add item' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add item' });
    await drawer.getByLabel('Name', { exact: true }).fill('Beef');
    await expect(drawer.getByText('How is it measured?')).toBeVisible();
    await expect(drawer.getByLabel('Show amounts in')).toHaveValue('kg');
    await drawer.getByRole('button', { name: 'Add a pack' }).click();
    await drawer.getByLabel('Pack 1 name').fill('Crate');
    await drawer.getByLabel('How much one Crate holds', { exact: true }).fill('10');
    await expect(drawer.getByText('1 crate = 10 kg')).toBeVisible();
    await drawer.getByRole('button', { name: 'Add item' }).click();
    await expect.poll(() => created).not.toBeNull();
    expect(created).toMatchObject({ name: 'Beef', baseUnit: 'g', displayUnit: 'kg', units: [{ name: 'Crate', factor: { quantity: '10', unit: 'kg' } }] });
    expect(created.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a server refusal is shown in plain words and Save can be pressed again with the same command', async ({ page }) => {
    const ids = [];
    await setup(page, {
      extra: async ({ request, pathname, method, json }) => {
        if (method === 'POST' && pathname === `/api/owner/inventory/${BUSINESS}/items/${CHICKEN}/archive`) {
          ids.push(request.postDataJSON().commandId);
          json({ error: 'Chicken still has stock: 38.4 kg in the Warehouse. Count it to zero first, or record waste.', details: { code: 'stock_left' } }, 409);
          return true;
        }
        return false;
      },
    });
    await page.goto(`/owner/inventory/items?item=${CHICKEN}`);
    const drawer = page.getByRole('dialog', { name: 'Chicken' });
    await drawer.getByRole('button', { name: 'Archive Chicken' }).click();
    await expect(drawer.getByText('Archive Chicken?', { exact: false }).first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Yes, archive it' }).click();
    await expect(drawer.getByRole('alert')).toContainText('Count it to zero first');
    await drawer.getByRole('button', { name: 'Archive Chicken' }).click();
    await drawer.getByRole('button', { name: 'Yes, archive it' }).click();
    await expect.poll(() => ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
  });

  test('opening stock: 40 crates shows = 400 kg and posts the lines', async ({ page }) => {
    let posted = null;
    await setup(page, {
      extra: async ({ request, pathname, search, method, json }) => {
        if (pathname === `/api/owner/inventory/${BUSINESS}/opening` && method === 'GET') {
          expect(search).toContain(`location=${WAREHOUSE}`);
          json({ locationId: WAREHOUSE, locationName: 'Warehouse', canRecord: true, counts: { items: 2, withOpening: 1, waiting: 1 }, items: [
            { itemId: CHICKEN, name: 'Chicken', code: 'CHK-001', baseUnit: 'g', displayUnit: 'kg', hasOpening: false, openingSetAt: null, opening: null, onHand: '0.0000', display: '0 kg', canSetOpening: true, units: ['crate'] },
            { itemId: 'e1', name: 'Eggs', code: null, baseUnit: 'piece', displayUnit: null, hasOpening: true, openingSetAt: '2026-11-01T08:00:00Z', opening: { movementId: '5', quantity: '60', unit: 'piece' }, onHand: '60.0000', display: '60 pieces', canSetOpening: false, units: [] }] });
          return true;
        }
        if (pathname === `/api/owner/inventory/${BUSINESS}/opening` && method === 'POST') {
          posted = request.postDataJSON();
          json({ locationId: WAREHOUSE, locationName: 'Warehouse', posted: 1, skipped: 0, results: [{ itemId: CHICKEN, itemName: 'Chicken', status: 'posted', display: '400 kg', quantity: '40', unit: 'crate' }] });
          return true;
        }
        return false;
      },
    });
    await page.goto('/owner/inventory');
    await page.getByRole('button', { name: 'Record opening stock' }).click();
    const drawer = page.getByRole('dialog', { name: 'Record opening stock' });
    await expect(drawer.getByText('Already set')).toBeVisible();
    await expect(drawer.getByText('60 pieces')).toBeVisible();
    await drawer.getByLabel('How much Chicken is there', { exact: true }).fill('40');
    await drawer.getByLabel('Unit for How much Chicken is there').selectOption({ label: 'crates' });
    await expect(drawer.getByText('= 400 kg')).toBeVisible();
    await drawer.getByLabel(/Cost of Chicken per/).fill('650');
    await drawer.getByRole('button', { name: /Save opening stock for 1 item/ }).click();
    await expect(drawer.getByText('Chicken: 400 kg')).toBeVisible();
    expect(posted).toMatchObject({ locationId: WAREHOUSE, lines: [{ itemId: CHICKEN, quantity: '40', unit: 'crate', unitCost: '650' }] });
  });

  test('CSV import: a dry run with an error keeps Import disabled; a clean file enables it', async ({ page }) => {
    let checks = 0;
    const row = (line, name, action, extra = {}) => ({ line, name, action, messages: [], warnings: [], changes: [], opening: null, ...extra });
    await setup(page, {
      extra: async ({ pathname, method, json }) => {
        if (pathname === `/api/owner/inventory/${BUSINESS}/import/dry-run` && method === 'POST') {
          checks += 1;
          json(checks === 1
            ? { ok: false, dryRun: true, summary: { create: 1, update: 0, skip: 0, errors: 1, warnings: 0, openings: 0 }, fileWarnings: [], columns: [],
              rows: [row(2, 'Rice', 'create', { changes: ['Create the item'] }), row(3, 'Mystery', 'error', { messages: ['“Mystery” needs a measure: weight, volume, count or servings.'] })] }
            : { ok: true, dryRun: true, summary: { create: 2, update: 0, skip: 0, errors: 0, warnings: 0, openings: 0 }, fileWarnings: [], columns: [],
              rows: [row(2, 'Rice', 'create', { changes: ['Create the item'] }), row(3, 'Flour', 'create', { changes: ['Create the item'] })] });
          return true;
        }
        return false;
      },
    });
    await page.goto('/owner/inventory/items');
    await page.getByRole('button', { name: 'Import' }).click();
    const drawer = page.getByRole('dialog', { name: 'Import items from a spreadsheet' });
    await drawer.getByLabel(/Or paste it here/).fill('name,measured_by\nRice,weight\nMystery,');
    await drawer.getByRole('button', { name: 'Check the file' }).click();
    await expect(drawer.getByText('needs a measure')).toBeVisible();
    await expect(drawer.getByRole('button', { name: /^Import \d+ items?$/ })).toBeDisabled();
    await drawer.getByLabel(/Or paste it here/).fill('name,measured_by\nRice,weight\nFlour,weight');
    await drawer.getByRole('button', { name: 'Check the file' }).click();
    await expect(drawer.getByRole('button', { name: 'Import 2 items' })).toBeEnabled();
  });

  test('History explains there is one item at a time and lists its movements', async ({ page }) => {
    await setup(page, {
      extra: async ({ pathname, method, json }) => {
        if (pathname === `/api/owner/inventory/${BUSINESS}/items/${CHICKEN}` && method === 'GET') {
          json({ ...chicken, movements: [{ id: '1', locationId: WAREHOUSE, locationName: 'Warehouse', reason: 'opening', note: 'Opening stock', occurredAt: '2026-11-17T08:00:00Z',
            delta: '400000', balanceAfter: '400000', display: { delta: '+400 kg', balanceAfter: '400 kg' }, entered: { quantity: '40', unit: 'crate' } }] });
          return true;
        }
        return false;
      },
    });
    await page.goto('/owner/inventory/history');
    await expect(page.getByText('Pick an item to see its latest stock changes.')).toBeVisible();
    await page.getByLabel('Item', { exact: true }).selectOption({ label: 'Chicken' });
    await expect(page.getByRole('cell', { name: '+400 kg' })).toBeVisible();
    await expect(page.getByText('Opening stock').first()).toBeVisible();
  });
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const noOverflow = async (page) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  };

  test('Stock, Items and History do not scroll sideways', async ({ page }) => {
    await setup(page);
    for (const [path, heading] of [['/owner/inventory', 'Stock'], ['/owner/inventory/items', 'Items'], ['/owner/inventory/history', 'History']]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole('status', { name: /Loading/ })).toHaveCount(0);
      await noOverflow(page);
    }
  });

  test('the add-item sheet fits a phone', async ({ page }) => {
    await setup(page);
    await page.goto('/owner/inventory/items');
    await page.getByRole('button', { name: 'Add item' }).click();
    const sheet = page.getByRole('dialog', { name: 'Add item' });
    await expect(sheet.getByLabel('Name', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Add a pack' }).click();
    await noOverflow(page);
    const box = await sheet.boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);
  });
});
