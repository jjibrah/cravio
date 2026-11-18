// Recipes (P1-16): the dish list with portions and food cost, the recipe sheet (lines, live preview, save as a new version, stop tracking,
// AI draft, version history, extras) for the owner (any branch) and a branch manager (own branch). Everything is MOCKED like
// inventory-owner.spec.js: a fake session in storage, every call answered here, any other API path gets a 404.
//   cd frontend && npx playwright test tests/inventory-recipes.spec.js
// (The branch-manager tests need Recipes wired into INVENTORY_PAGES in App.jsx: branch `recipes: { on: BranchRecipesPage }`.)
import { test, expect } from '@playwright/test';

const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';
const BRANCH_2 = '206fe2fb-94bb-4f5d-bd0d-bd694004424c';
const WAREHOUSE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOC_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LOC_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CHICKEN = '11111111-1111-4111-8111-111111111111';
const CHEESE = '22222222-2222-4222-8222-222222222222';
const BURGER = '33333333-3333-4333-8333-333333333333';
const PIZZA = '44444444-4444-4444-8444-444444444444';
const FRIES = '55555555-5555-4555-8555-555555555555';
const WINGS = '66666666-6666-4666-8666-666666666666';
const EXTRA = '77777777-7777-4777-8777-777777777777';
const V2 = '88888888-8888-4888-8888-888888888888';
const V1 = '99999999-9999-4999-8999-999999999998';
const USER = '99999999-9999-4999-8999-999999999999';

const UNITS = [
  { code: 'mg', dimension: 'weight', toBase: '0.001', label: 'mg', plural: 'mg' },
  { code: 'g', dimension: 'weight', toBase: '1', label: 'g', plural: 'g' },
  { code: 'kg', dimension: 'weight', toBase: '1000', label: 'kg', plural: 'kg' },
  { code: 'piece', dimension: 'count', toBase: '1', label: 'piece', plural: 'pieces' },
];
const ALL = ['inv.view', 'inv.cost.view', 'inv.item.edit', 'inv.stock.record', 'inv.settings.edit'];
const place = (id, name, restaurantId) => ({ id, kind: restaurantId ? 'branch' : 'center', name, code: null, status: 'active', restaurantId, label: restaurantId ? 'Branch' : 'Warehouse', capabilities: ALL });
const item = (id, name) => ({ id, name, sku: null, kind: 'raw', storage: null, categoryId: null, categoryName: null, baseUnit: 'g', measuredBy: 'weight', displayUnit: 'kg', yieldPct: 100,
  notes: null, archived: false, units: [], barcodes: [], locations: [], totals: { display: {} }, low: false });
const overview = (branches = 1) => ({
  enabled: true, role: 'owner', capabilities: { view: true, costView: true, itemEdit: true, recipeEdit: true, stockRecord: true, settingsEdit: true },
  warehouse: place(WAREHOUSE, 'Warehouse', null),
  locations: [place(WAREHOUSE, 'Warehouse', null), place(LOC_1, 'Abdis Test Restaurant', BRANCH), ...(branches > 1 ? [place(LOC_2, 'Abdis Westlands', BRANCH_2)] : [])],
  categories: [], units: UNITS, measuredBy: [{ value: 'weight', label: 'Weight', baseUnit: 'g' }], items: [item(CHICKEN, 'Chicken'), item(CHEESE, 'Cheese')], settings: {},
});

const dishes = [
  { id: BURGER, name: 'Chicken burger', category: 'Burgers', price: 600, available: true, tracked: true, source: 'recipe', version: 2, lineCount: 1, allowWhenOut: false,
    portions: 12, limitingItem: { id: CHICKEN, name: 'Chicken' }, soldOut: false, foodCost: { cost: '186.00', costPct: '31.0', unknown: [] } },
  { id: PIZZA, name: 'Cheese pizza', category: 'Pizza', price: 900, available: true, tracked: true, source: 'recipe', version: 1, lineCount: 1, allowWhenOut: false,
    portions: 0, limitingItem: { id: CHEESE, name: 'Cheese' }, soldOut: true, foodCost: { cost: null, costPct: null, unknown: ['Cheese'] } },
  { id: WINGS, name: 'Wings', category: 'Pizza', price: 500, available: true, tracked: true, source: 'link', version: null, lineCount: 1, allowWhenOut: false,
    portions: 40, limitingItem: { id: CHICKEN, name: 'Chicken' }, soldOut: false, foodCost: { cost: '90.00', costPct: '18.0', unknown: [] } },
  { id: FRIES, name: 'Fries', category: 'Sides', price: 200, available: true, tracked: false, source: 'none', version: null, lineCount: 0, allowWhenOut: false,
    portions: null, limitingItem: null, soldOut: false, foodCost: undefined },
];
const list = (restaurantId = BRANCH, { cost = true, edit = true, branchName = 'Abdis Test Restaurant' } = {}) => ({
  restaurantId, branchName, canSeeCost: cost, canEdit: edit,
  summary: { dishes: 4, tracked: 3, untracked: 1, soldOut: 1 },
  dishes: dishes.map((d) => (cost ? d : { ...d, foodCost: undefined })),
});

const units = (extra = []) => [
  { code: 'mg', label: 'mg', plural: 'mg', kind: 'standard' }, { code: 'g', label: 'g', plural: 'g', kind: 'standard' }, { code: 'kg', label: 'kg', plural: 'kg', kind: 'standard' }, ...extra];
const chickenLine = { itemId: CHICKEN, name: 'Chicken', archived: false, baseUnit: 'g', qtyBase: '200.0000', display: '200 g', entered: { quantity: '200.0000', unit: 'g' },
  yieldPct: 100, takeawayOnly: false, compatibleUnits: units() };
const SENTENCE = '1 Chicken burger uses 285.7 g Chicken (200 g at 70% usable)';
const burgerView = (patch = {}) => ({
  dish: { id: BURGER, name: 'Chicken burger', price: 600, currency: 'KES', category: 'Burgers', restaurantId: BRANCH, branchName: 'Abdis Test Restaurant' },
  source: 'recipe', tracked: true, allowWhenOut: false, version: { id: V2, version: 2, note: null, createdAt: '2026-11-10T10:00:00Z', createdBy: { id: USER, name: 'Amina' } },
  lines: [chickenLine], preview: [SENTENCE], foodCost: { cost: '186.00', costPct: '31.0', unknown: [] }, link: null,
  versions: [
    { id: V2, version: 2, note: 'More chicken', createdAt: '2026-11-10T10:00:00Z', supersededAt: null, current: true, used: true, lineCount: 1, createdBy: { id: USER, name: 'Amina' } },
    { id: V1, version: 1, note: null, createdAt: '2026-11-01T10:00:00Z', supersededAt: '2026-11-10T10:00:00Z', current: false, used: true, lineCount: 1, createdBy: { id: USER, name: 'Amina' } },
  ],
  extras: [{ id: EXTRA, name: 'Extra cheese', price: 50, available: true, tracked: false, lines: [], preview: [] }],
  canEdit: true, canSeeCost: true, ...patch,
});

const ownerAccount = { id: USER, email: 'owner@example.com', name: 'Owner Test', role: 'owner', home: '/owner', onboardingRequired: false,
  businesses: [{ id: BUSINESS, name: 'Abdis Group', role: 'owner', branchIds: null }], branches: [] };
const managerAccount = { id: USER, email: 'manager@example.com', name: 'Branch Manager', role: 'owner', home: `/branch/${BRANCH}`, onboardingRequired: false, businesses: [],
  branches: [{ id: BRANCH, name: 'Abdis Test Restaurant', role: 'manager', status: 'live', businessId: BUSINESS }] };

/** Session + every call mocked. `handle` sees the recipe calls first; calls it doesn't answer fall through to the defaults. */
async function setup(page, { account = ownerAccount, branches = 1, handle = () => false } = {}) {
  await page.addInitScript((user) => {
    const session = { access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    localStorage.setItem('sb-zpsyrtbqobuwfnuddbsg-auth-token', JSON.stringify(session));
  }, USER);
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: { id: USER, aud: 'authenticated', email: 'owner@example.com' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    const json = async (data, status = 200) => { await route.fulfill({ status, json: data }); return true; };
    if (await handle({ pathname, searchParams, method, body, json })) return;
    if (pathname === '/api/me') return json(account);
    if (pathname === `/api/owner/inventory/${BUSINESS}` && method === 'GET') return json(overview(branches));
    if (pathname === `/api/owner/inventory/${BUSINESS}/recipes` && method === 'GET') return json(list(searchParams.get('branch') || BRANCH));
    if (pathname === '/api/inventory/recipes' && method === 'GET') return json(list());
    if (pathname === '/api/inventory' && method === 'GET') {
      if (searchParams.get('all')) return json({ items: [{ id: CHICKEN, name: 'Chicken', baseUnit: 'g', units: units() }, { id: CHEESE, name: 'Cheese', baseUnit: 'g', units: units() }] });
      return json({ items: [] });
    }
    if (pathname === '/api/notifications' || pathname === '/api/notifications/unread-count') return json(pathname.endsWith('count') ? { count: 0 } : { notifications: [] });
    return json({ error: 'Not mocked in this test.' }, 404);
  });
}

const OWNER_BASE = `/api/owner/inventory/${BUSINESS}/recipes`;
const recipeCalls = ({ view = burgerView(), preview, save, suggest, extra } = {}) => async ({ pathname, method, body, json }) => {
  if (pathname === `${OWNER_BASE}/${BURGER}` && method === 'GET') return json(view) || true;
  if (pathname === `${OWNER_BASE}/${BURGER}/preview` && method === 'POST') return preview ? preview(body, json) : json({ dish: { id: BURGER, name: 'Chicken burger' }, preview: [], foodCost: view.foodCost }) || true;
  if (pathname === `${OWNER_BASE}/${BURGER}` && method === 'PUT') return save ? save(body, json) : false;
  if (pathname === `${OWNER_BASE}/${BURGER}/suggest` && method === 'POST') return suggest ? suggest(body, json) : false;
  if (pathname === `/api/owner/inventory/${BUSINESS}/extras/${EXTRA}/recipe` && method === 'PUT') return extra ? extra(body, json) : false;
  if (pathname === `${OWNER_BASE}/${BURGER}/versions/${V1}` && method === 'GET') return json({ dish: { id: BURGER, name: 'Chicken burger' },
    version: { id: V1, version: 1, note: null, createdAt: '2026-11-01T10:00:00Z', current: false, used: true, createdBy: { id: USER, name: 'Amina' } },
    lines: [{ ...chickenLine, entered: { quantity: '150.0000', unit: 'g' }, qtyBase: '150.0000' }], preview: ['1 Chicken burger uses 150 g Chicken'], foodCost: { cost: '140.00', costPct: '23.3', unknown: [] } }) || true;
  return false;
};
const openBurger = async (page) => {
  await page.getByRole('button', { name: 'Edit recipe for Chicken burger' }).click();
  return page.getByRole('dialog');
};

test.describe('recipes list', () => {
  test('shows dishes by category with status, portions, limiting ingredient, sold out and food cost', async ({ page }) => {
    await setup(page);
    await page.goto('/owner/inventory/recipes');
    await expect(page.getByRole('heading', { level: 1, name: 'Recipes' })).toBeVisible();
    await expect(page.getByText('3 of 4 dishes have a recipe. Dishes without one don’t change stock.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Burgers' })).toBeVisible();
    const burger = page.getByRole('listitem').filter({ hasText: 'Chicken burger' });
    await expect(burger.getByText('Tracked')).toBeVisible();
    await expect(burger.getByText('12 left — Chicken runs out first')).toBeVisible();
    await expect(burger.getByText('Ksh 186 · 31% of the price')).toBeVisible();
    const pizza = page.getByRole('listitem').filter({ hasText: 'Cheese pizza' });
    await expect(pizza.getByText('Sold out', { exact: true })).toBeVisible();
    await expect(pizza.getByText('Cost unknown — no price for Cheese')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Wings' }).getByText('Uses old link')).toBeVisible();
    const fries = page.getByRole('listitem').filter({ hasText: 'Fries' });
    await expect(fries.getByText('Not tracked')).toBeVisible();
    await expect(fries.getByRole('button', { name: 'Add recipe for Fries' })).toBeVisible();
  });

  test('search and “Not tracked yet” filter the list', async ({ page }) => {
    await setup(page);
    await page.goto('/owner/inventory/recipes');
    await page.getByLabel('Search dishes').fill('pizza');
    await expect(page.getByText('Cheese pizza')).toBeVisible();
    await expect(page.getByText('Chicken burger')).toHaveCount(0);
    await page.getByLabel('Search dishes').fill('');
    await page.getByLabel(/Not tracked yet/).check();
    await expect(page.getByRole('listitem').filter({ hasText: 'Fries' })).toBeVisible();
    await expect(page.getByText('Chicken burger')).toHaveCount(0);
  });

  test('without cost permission no cost is shown', async ({ page }) => {
    await setup(page, { handle: async ({ pathname, json }) => (pathname === `${OWNER_BASE}` ? json(list(BRANCH, { cost: false })) || true : false) });
    await page.goto('/owner/inventory/recipes');
    await expect(page.getByText('12 left — Chicken runs out first')).toBeVisible();
    await expect(page.getByText(/Ksh 186/)).toHaveCount(0);
    await expect(page.getByText(/Cost unknown/)).toHaveCount(0);
  });

  test('owner picks which branch’s dishes to see, and it is remembered', async ({ page }) => {
    const asked = [];
    await setup(page, { branches: 2, handle: async ({ pathname, searchParams, json }) => {
      if (pathname === OWNER_BASE) { asked.push(searchParams.get('branch')); return false; }
      return false;
    } });
    await page.goto('/owner/inventory/recipes');
    await expect(page.getByText('Chicken burger')).toBeVisible();
    expect(asked.at(-1)).toBe(BRANCH);
    await page.getByLabel('Branch').selectOption({ label: 'Abdis Westlands' });
    await expect.poll(() => asked.at(-1)).toBe(BRANCH_2);
    await page.reload();
    await expect(page.getByLabel('Branch')).toHaveValue(BRANCH_2);
    await expect.poll(() => asked.at(-1)).toBe(BRANCH_2);
  });
});

test.describe('recipe sheet', () => {
  test('adding 150 g of a kg item shows the preview and cost, and Save sends the right body and says the new version', async ({ page }) => {
    const previews = [];
    const saves = [];
    await setup(page, { handle: recipeCalls({
      preview: (body, json) => { previews.push(body); return json({ dish: { id: BURGER, name: 'Chicken burger' }, preview: [SENTENCE, '1 Chicken burger uses 150 g Cheese'],
        foodCost: { cost: '240.00', costPct: '40.0', unknown: [] } }) || true; },
      save: (body, json) => { saves.push(body); return json(burgerView({ version: { id: 'v3', version: 3, note: 'More cheese', createdAt: '2026-11-18T10:00:00Z', createdBy: null } })) || true; },
    }) });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await expect(sheet.getByText(SENTENCE)).toBeVisible();
    await expect(sheet.getByText('Ksh 186')).toBeVisible();
    await expect(sheet.getByText('31% of the Ksh 600 price')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Save recipe' })).toBeDisabled();

    await sheet.getByRole('button', { name: 'Add ingredient', exact: true }).click();
    await sheet.getByRole('searchbox', { name: /Search items/ }).fill('chee');
    await sheet.getByRole('option', { name: 'Cheese' }).click();
    // The unit box offers the item's compatible units, with grams (its smallest everyday unit) preselected.
    const unit = sheet.getByRole('combobox', { name: 'Unit for Amount of Cheese' });
    await expect(unit).toHaveValue('g');
    await expect(unit.locator('option')).toHaveText(['mg', 'g', 'kg']);
    await sheet.getByRole('spinbutton', { name: 'Amount of Cheese' }).fill('150');
    await expect(sheet.getByText('1 Chicken burger uses 150 g Cheese')).toBeVisible();
    await expect(sheet.getByText('Ksh 240')).toBeVisible();
    await expect(sheet.getByText('40% of the Ksh 600 price')).toBeVisible();
    expect(previews.at(-1).lines).toEqual([{ itemId: CHICKEN, quantity: '200', unit: 'g' }, { itemId: CHEESE, quantity: '150', unit: 'g' }]);

    await sheet.getByLabel(/What changed/).fill('More cheese');
    await sheet.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByText('Saved as version 3.')).toBeVisible();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ lines: [{ itemId: CHICKEN, quantity: '200', unit: 'g' }, { itemId: CHEESE, quantity: '150', unit: 'g' }], allowWhenOut: false, note: 'More cheese' });
    expect(saves[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('missing price shows “Unknown” in plain words, never 0', async ({ page }) => {
    await setup(page, { handle: recipeCalls({ preview: (body, json) => json({ dish: { id: BURGER, name: 'Chicken burger' }, preview: ['1 Chicken burger uses 30 g Cheese'],
      foodCost: { cost: null, costPct: null, unknown: ['Cheese', 'Buns'] } }) || true }) });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await sheet.getByRole('spinbutton', { name: 'Amount of Chicken' }).fill('250');
    await expect(sheet.getByText('Unknown', { exact: true })).toBeVisible();
    await expect(sheet.getByText(/No price yet for Cheese and Buns/)).toBeVisible();
  });

  test('a duplicate item is explained plainly, and Save again retries the same command', async ({ page }) => {
    const ids = [];
    await setup(page, { handle: recipeCalls({ save: (body, json) => {
      ids.push(body.commandId);
      return json({ error: 'Chicken is in the recipe twice. Combine the amounts into one line.', details: { code: 'duplicate_item' } }, 400) || true;
    } }) });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await sheet.getByRole('spinbutton', { name: 'Amount of Chicken' }).fill('250');
    await sheet.getByRole('button', { name: 'Save recipe' }).click();
    await expect(sheet.getByText('Chicken is already in this recipe — change its amount instead.')).toBeVisible();
    await sheet.getByRole('button', { name: 'Save recipe' }).click();
    await expect.poll(() => ids.length).toBe(2);
    expect(ids[1]).toBe(ids[0]);
  });

  test('the item list does not offer an item that is already in the recipe', async ({ page }) => {
    await setup(page, { handle: recipeCalls() });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await sheet.getByRole('button', { name: 'Add ingredient', exact: true }).click();
    await expect(sheet.getByRole('option', { name: /Chicken/ })).toBeDisabled();
    await expect(sheet.getByText('Already in this recipe')).toBeVisible();
  });

  test('Draft with AI fills the lines for review and saves nothing', async ({ page }) => {
    const saves = [];
    await setup(page, { handle: recipeCalls({
      suggest: (body, json) => json({ draft: true, menuItemId: BURGER, lines: [
        { itemId: CHICKEN, name: 'Chicken', quantity: 180, unit: 'g', newItem: false },
        { itemId: CHEESE, name: 'Cheese', quantity: 30, unit: 'g', newItem: false, warning: 'Suggested in cups, but Cheese is counted in g. Check the amount.' },
        { itemId: null, name: 'Brioche bun', quantity: 1, unit: 'piece', newItem: true, warning: 'Not a stock item yet.' }], note: '' }) || true,
      save: (body, json) => { saves.push(body); return json(burgerView()) || true; },
    }) });
    await page.goto('/owner/inventory/recipes');
    const burger = await openBurger(page);
    await burger.getByRole('spinbutton', { name: 'Amount of Chicken' }).fill('250');
    await burger.getByRole('button', { name: 'Draft with AI' }).click();
    await expect(burger.getByText('Replace the ingredients you’ve entered with an AI draft?')).toBeVisible();
    await burger.getByRole('button', { name: 'Replace with draft' }).click();
    await expect(burger.getByRole('spinbutton', { name: 'Amount of Chicken' })).toHaveValue('180');
    await expect(burger.getByRole('spinbutton', { name: 'Amount of Cheese' })).toHaveValue('30');
    await expect(burger.getByText(/AI draft: check every amount before you save/)).toBeVisible();
    await expect(burger.getByText('Suggested in cups, but Cheese is counted in g. Check the amount.')).toBeVisible();
    await expect(burger.getByText(/Brioche bun .* isn’t one of your items yet/)).toBeVisible();
    expect(saves).toHaveLength(0);
  });

  test('when AI isn’t set up (503) a short hint appears and the lines are untouched', async ({ page }) => {
    await setup(page, { handle: recipeCalls({ suggest: (body, json) => json({ error: 'AI is not configured.', details: { code: 'ai_not_configured' } }, 503) || true }) });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await sheet.getByRole('button', { name: 'Draft with AI' }).click();
    await expect(sheet.getByText('AI drafting isn’t set up yet. You can add the ingredients yourself.')).toBeVisible();
    await expect(sheet.getByRole('spinbutton', { name: 'Amount of Chicken' })).toHaveValue('200');
  });

  test('Stop tracking asks first, then saves an empty recipe', async ({ page }) => {
    const saves = [];
    await setup(page, { handle: recipeCalls({ save: (body, json) => { saves.push(body); return json(burgerView({ tracked: false, source: 'none', version: null, lines: [], preview: [], foodCost: undefined })) || true; } }) });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await sheet.getByRole('button', { name: 'Stop tracking this dish' }).click();
    await expect(sheet.getByText(/Selling it will no longer change stock/)).toBeVisible();
    expect(saves).toHaveLength(0);
    await sheet.getByRole('button', { name: 'Keep tracking' }).click();
    await sheet.getByRole('button', { name: 'Stop tracking this dish' }).click();
    await sheet.getByRole('button', { name: 'Yes, stop tracking' }).click();
    await expect(page.getByText('Chicken burger no longer changes stock.')).toBeVisible();
    expect(saves).toHaveLength(1);
    expect(saves[0].lines).toEqual([]);
  });

  test('keep selling when out is explained plainly and sent', async ({ page }) => {
    const saves = [];
    await setup(page, { handle: recipeCalls({ save: (body, json) => { saves.push(body); return json(burgerView({ allowWhenOut: true })) || true; } }) });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await sheet.getByRole('switch', { name: 'Keep selling when out' }).click();
    await expect(sheet.getByText(/Orders still go through when stock shows zero/)).toBeVisible();
    await sheet.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByText(/Saved as version/)).toBeVisible();
    expect(saves[0].allowWhenOut).toBe(true);
  });

  test('version history marks versions used by orders and opens an old one read-only', async ({ page }) => {
    await setup(page, { handle: recipeCalls() });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await expect(sheet.getByRole('heading', { name: 'Version history' })).toBeVisible();
    await expect(sheet.getByText('Used by orders')).toHaveCount(2);
    await sheet.getByRole('button', { name: 'View version 1' }).click();
    const old = sheet.getByRole('region', { name: 'Version 1' });
    await expect(old.getByText('1 Chicken burger uses 150 g Chicken')).toBeVisible();
    await expect(old.getByText('Ksh 140')).toBeVisible();
    await expect(old.getByText(/Orders were taken with this version/)).toBeVisible();
    await old.getByRole('button', { name: 'Start from this version' }).click();
    await expect(sheet.getByRole('spinbutton', { name: 'Amount of Chicken' })).toHaveValue('150');
  });

  test('an extra’s own recipe is saved on its own', async ({ page }) => {
    const saves = [];
    await setup(page, { handle: recipeCalls({ extra: (body, json) => { saves.push(body); return json({ extra: { id: EXTRA, name: 'Extra cheese', price: 50 }, tracked: true,
      lines: [{ ...chickenLine, itemId: CHEESE, name: 'Cheese', entered: { quantity: '30.0000', unit: 'g' }, qtyBase: '30.0000' }], preview: ['1 Extra cheese uses 30 g Cheese'],
      foodCost: { cost: '12.00', costPct: '24.0', unknown: [] } }) || true; } }) });
    await page.goto('/owner/inventory/recipes');
    const sheet = await openBurger(page);
    await expect(sheet.getByText('Adding it doesn’t change stock.')).toBeVisible();
    await sheet.getByRole('button', { name: 'Add ingredients for Extra cheese' }).click();
    const form = sheet.getByRole('form', { name: 'Ingredients for Extra cheese' });
    await form.getByRole('searchbox').fill('chee');
    await form.getByRole('option', { name: 'Cheese' }).click();
    await form.getByRole('spinbutton', { name: 'Amount of Cheese' }).fill('30');
    await form.getByRole('button', { name: 'Save extra' }).click();
    await expect(page.getByText('Extra cheese saved.')).toBeVisible();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ lines: [{ itemId: CHEESE, quantity: '30', unit: 'g' }] });
    await expect(sheet.getByText('1 Extra cheese uses 30 g Cheese')).toBeVisible();
    await expect(sheet.getByText(/Cost Ksh 12 · 24% of the price/)).toBeVisible();
  });

  test('read-only for someone who can look but not change (operations manager)', async ({ page }) => {
    await setup(page, { handle: async (call) => {
      if (call.pathname === OWNER_BASE) return call.json(list(BRANCH, { edit: false })) || true;
      return recipeCalls({ view: burgerView({ canEdit: false }) })(call);
    } });
    await page.goto('/owner/inventory/recipes');
    await page.getByRole('button', { name: 'View recipe for Chicken burger' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(/only the owner or this branch’s manager can change it/)).toBeVisible();
    await expect(sheet.locator('.rc-readlines').getByText('Chicken')).toBeVisible();
    await expect(sheet.locator('.rc-readlines').getByText('200 g')).toBeVisible();
    await expect(sheet.getByRole('textbox')).toHaveCount(0);
    await expect(sheet.getByRole('spinbutton')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Save recipe' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Draft with AI' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Stop tracking this dish' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /Add ingredients for/ })).toHaveCount(0);
  });
});

test.describe('branch manager', () => {
  const branchCalls = (call) => {
    const { pathname, method, json } = call;
    if (pathname === `/api/inventory/recipes/${BURGER}` && method === 'GET') return json(burgerView()) || true;
    if (pathname === `/api/inventory/recipes/${BURGER}/preview` && method === 'POST') return json({ dish: { id: BURGER, name: 'Chicken burger' }, preview: ['1 Chicken burger uses 200 g Chicken'], foodCost: burgerView().foodCost }) || true;
    return false;
  };

  test('manager sees only their branch’s recipes (no branch picker) and can open one', async ({ page }) => {
    await setup(page, { account: managerAccount, handle: branchCalls });
    await page.goto(`/branch/${BRANCH}/recipes`);
    await expect(page.getByRole('heading', { level: 1, name: 'Recipes' })).toBeVisible();
    await expect(page.getByText('12 left — Chicken runs out first')).toBeVisible();
    await expect(page.getByRole('main').getByRole('combobox', { name: 'Branch' })).toHaveCount(0);
    const sheet = await openBurger(page);
    await expect(sheet.getByText(SENTENCE)).toBeVisible();
    await sheet.getByRole('button', { name: 'Add ingredient', exact: true }).click();
    await sheet.getByRole('searchbox', { name: /Search items/ }).fill('chee');
    await expect(sheet.getByRole('option', { name: 'Cheese' })).toBeVisible();
  });
});

test.describe('phone width', () => {
  test('the list and the sheet fit without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await setup(page, { handle: recipeCalls() });
    await page.goto('/owner/inventory/recipes');
    await expect(page.getByText('12 left — Chicken runs out first')).toBeVisible();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Edit recipe for Chicken burger' }).click();
    await expect(page.getByText(SENTENCE)).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    const sheetOverflow = await page.evaluate(() => { const el = document.querySelector('.rc-sheet'); const box = el.closest('[class*="sheet"], dialog') || el; return el.scrollWidth - box.clientWidth; });
    expect(sheetOverflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole('spinbutton', { name: 'Amount of Chicken' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Chicken' })).toBeVisible();
  });
});
