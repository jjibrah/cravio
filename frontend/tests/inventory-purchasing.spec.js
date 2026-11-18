// Purchasing screens (P2-12 navigation, P2-13 Suppliers, P2-14 Purchase orders). Everything is MOCKED like inventory-owner.spec.js:
// a fake signed-in session, /api/me and every inventory call answered here, and any API path not listed gets a 404.
//   cd frontend && npx playwright test tests/inventory-purchasing.spec.js
import { test, expect } from '@playwright/test';

const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';
const WAREHOUSE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BRANCH_LOCATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHICKEN = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '33333333-3333-4333-8333-333333333333';
const KIOSK = '44444444-4444-4444-8444-444444444444';
const NEW_SUPPLIER = '55555555-5555-4555-8555-555555555555';
const PO = '66666666-6666-4666-8666-666666666666';
const USER = '99999999-9999-4999-8999-999999999999';
const API = `/api/owner/inventory/${BUSINESS}`;

const UNITS = [
  { code: 'mg', dimension: 'weight', toBase: '0.001', label: 'mg', plural: 'mg' },
  { code: 'g', dimension: 'weight', toBase: '1', label: 'g', plural: 'g' },
  { code: 'kg', dimension: 'weight', toBase: '1000', label: 'kg', plural: 'kg' },
  { code: 'ml', dimension: 'volume', toBase: '1', label: 'ml', plural: 'ml' },
  { code: 'l', dimension: 'volume', toBase: '1000', label: 'L', plural: 'L' },
  { code: 'piece', dimension: 'count', toBase: '1', label: 'piece', plural: 'pieces' },
];
const CAPS = ['inv.view', 'inv.cost.view', 'inv.item.edit', 'inv.stock.record', 'inv.settings.edit', 'inv.purchase.create', 'inv.purchase.approve'];
const locations = [
  { id: WAREHOUSE, kind: 'center', name: 'Warehouse', status: 'active', restaurantId: null, label: 'Warehouse', capabilities: CAPS },
  { id: BRANCH_LOCATION, kind: 'branch', name: 'Abdis Test Restaurant', status: 'active', restaurantId: BRANCH, label: 'Branch', capabilities: CAPS },
];
const chicken = {
  id: CHICKEN, name: 'Chicken', sku: 'CHK-001', kind: 'raw', baseUnit: 'g', measuredBy: 'weight', displayUnit: 'kg', vatClass: 'standard', archived: false,
  units: [{ id: 'u1', name: 'crate', factor: '10000.0000', forPurchase: true, forRecipe: false, forCount: true, size: '10 kg' }], barcodes: [],
  locations: [], totals: { onHand: '4000', display: { onHand: '4 kg' }, value: '0' }, low: true,
};
const overview = {
  enabled: true, role: 'owner',
  capabilities: { view: true, costView: true, itemEdit: true, purchaseCreate: true, purchaseApprove: true, stockRecord: true, settingsEdit: true },
  warehouse: locations[0], locations, categories: [], units: UNITS, measuredBy: [], items: [chicken], settings: {},
};
const ownerAccount = { id: USER, email: 'owner@example.com', name: 'Owner Test', role: 'owner', home: '/owner', onboardingRequired: false,
  businesses: [{ id: BUSINESS, name: 'Abdis Group', role: 'owner', branchIds: null }], branches: [] };
const managerAccount = { id: USER, email: 'manager@example.com', name: 'Branch Manager', role: 'owner', home: `/branch/${BRANCH}`, onboardingRequired: false, businesses: [],
  branches: [{ id: BRANCH, name: 'Abdis Test Restaurant', role: 'manager', status: 'live', businessId: BUSINESS }] };

const supplier = (patch = {}) => ({ id: SUPPLIER, name: 'Karibu Poultry', type: 'formal', contactName: 'Wanjiru', phone: '254712345678', email: null, address: null, kraPin: 'P051234567K',
  paymentTermsDays: 30, paymentMethod: 'mpesa', status: 'active', incomplete: false, notes: null, mpesaTill: '123456', mpesaPaybill: null, mpesaAccount: null, bankDetails: null, ...patch });
const priceRow = (patch) => ({ id: `p-${patch.effectiveFrom}`, supplierId: SUPPLIER, itemId: CHICKEN, itemName: 'Chicken', unit: 'crate', unitFactor: '10000', note: null, scheduled: false, current: false, ...patch });
const row6000 = priceRow({ price: '6000.00', pricePerBase: '0.600000', effectiveFrom: '2026-10-01', current: true });
const row6500 = priceRow({ price: '6500.00', pricePerBase: '0.650000', effectiveFrom: '2026-11-01', current: true });

const order = (patch = {}) => ({
  id: PO, number: 'PO-2026-0001', status: 'draft', expectedDate: null, notes: null, selfApproved: false,
  supplier: { id: SUPPLIER, name: 'Karibu Poultry', phone: '254712345678', contactName: 'Wanjiru' }, deliverTo: { id: WAREHOUSE, name: 'Warehouse', kind: 'warehouse' },
  createdBy: USER, approvedBy: null, approvedAt: null, sentAt: null, sentVia: null, cancelledAt: null, cancelReason: null, createdAt: '2026-11-18T08:00:00.000Z', receiving: 'none', receipts: [],
  lines: [{ id: 'l1', position: 0, itemId: CHICKEN, itemName: 'Chicken', qty: '3', unit: 'crate', unitFactor: '10000', qtyBase: '30000', quantity: '30 kg', receivedBase: '0', received: '0 kg',
    outstandingBase: '30000', outstanding: '30 kg', unitPrice: '6500.00', lineTotal: '19500.00', vatAmount: '3120.00' }],
  totals: { subtotal: '19500.00', vat: '3120.00', total: '22620.00' }, ...patch,
});
const suggestions = {
  locationId: WAREHOUSE, locationName: 'Warehouse',
  suggestions: [{ itemId: CHICKEN, name: 'Chicken', supplier: { id: SUPPLIER, name: 'Karibu Poultry', preferred: true }, unit: 'crate', qty: '3', qtyBase: '30000', unitPrice: '6500.00', estimatedTotal: '19500.00',
    explain: 'Chicken: 4 kg on hand, reorder at 20 kg → order 30 kg = 3 crates' }],
  bySupplier: [{ supplierId: SUPPLIER, supplierName: 'Karibu Poultry', itemIds: [CHICKEN], estimatedTotal: '19500.00' }], withoutSupplier: [],
};
const listed = (o) => ({ id: o.id, number: o.number, status: o.status, supplierId: SUPPLIER, supplierName: 'Karibu Poultry', deliverToLocationId: WAREHOUSE, expectedDate: o.expectedDate,
  selfApproved: o.selfApproved, lineCount: o.lines.length, createdAt: o.createdAt, total: o.totals.total });
const documentOf = (o) => ({
  document: { title: 'Purchase order', number: o.number, dateText: '18 Nov 2026', from: { name: 'Abdis Group' }, to: { name: 'Karibu Poultry', contactName: 'Wanjiru', phone: '254712345678' },
    deliverTo: 'Warehouse', expectedDateText: null, paymentTermsDays: 30, notes: null,
    lines: [{ n: 1, item: 'Chicken', qty: '3', unit: 'crate', unitPrice: '6500.00', vat: '3120.00', lineTotal: '19500.00' }], totals: o.totals, currency: 'KES' },
  text: `Purchase order ${o.number}`,
  whatsapp: { phone: '254712345678', text: `Purchase order ${o.number}`, link: `https://wa.me/254712345678?text=Purchase%20order%20${o.number}`, note: null },
});

async function setup(page, { account = ownerAccount, inventory = true, extra = () => false } = {}) {
  await page.addInitScript((user) => {
    const session = { access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    localStorage.setItem('sb-zpsyrtbqobuwfnuddbsg-auth-token', JSON.stringify(session));
    window.__printed = 0;
    window.print = () => { window.__printed += 1; };
  }, USER);
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: { id: USER, aud: 'authenticated', email: 'owner@example.com' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    const method = request.method();
    const json = async (body, status = 200) => { await route.fulfill({ status, json: body }); return true; };
    if (await extra({ route, request, pathname, search, method, json })) return;
    if (pathname === '/api/me') return json(account);
    if (pathname === API && method === 'GET') return json(inventory ? overview : { enabled: false, role: 'owner', capabilities: {}, warehouse: null, locations: [], categories: [], units: [], measuredBy: [], items: [], settings: null });
    if (pathname === '/api/inventory' && method === 'GET') return inventory ? json({ items: [] }) : json({ error: 'Inventory is off.', details: { code: 'inventory_disabled' } }, 403);
    if (pathname === '/api/notifications' || pathname === '/api/notifications/unread-count') return json(pathname.endsWith('count') ? { count: 0 } : { notifications: [] });
    if (pathname === `${API}/approvals`) return json({ approvals: [], pending: 2 });
    return json({ error: 'Not mocked in this test.' }, 404);
  });
}

/** The suppliers API with state, so a saved price shows up in the next read. */
function suppliersApi({ prices = [row6500], suppliers = [supplier()], posted = {} } = {}) {
  const state = { prices: [...prices], posted };
  const current = () => {
    const sorted = [...state.prices].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    return sorted.map((p, i) => ({ ...p, current: i === 0 }));
  };
  const handler = async ({ request, pathname, method, json }) => {
    if (pathname === `${API}/suppliers` && method === 'GET') return json({ suppliers: suppliers.map((s) => ({ ...s, itemCount: s.id === SUPPLIER ? 1 : 0 })) }) || true;
    if (pathname === `${API}/suppliers` && method === 'POST') { state.posted.supplier = request.postDataJSON(); return json({ supplier: supplier({ id: NEW_SUPPLIER, ...state.posted.supplier }), warnings: [] }) || true; }
    if (pathname === `${API}/suppliers/${NEW_SUPPLIER}` && method === 'GET') return json({ supplier: supplier({ id: NEW_SUPPLIER, name: state.posted.supplier.name }), items: [], openOrders: 0, prices: [], priceHistory: [] }) || true;
    if (pathname === `${API}/suppliers/${SUPPLIER}` && method === 'GET') {
      const all = current();
      return json({ supplier: suppliers.find((s) => s.id === SUPPLIER) || supplier(), openOrders: 0,
        items: [{ itemId: CHICKEN, name: 'Chicken', archived: false, baseUnit: 'g', displayUnit: 'kg', purchaseUnit: 'crate', preferred: true }], prices: all.filter((p) => p.current), priceHistory: all }) || true;
    }
    if (pathname === `${API}/suppliers/${SUPPLIER}/prices` && method === 'POST') {
      const body = request.postDataJSON();
      state.posted.price = body;
      state.prices.push(priceRow({ price: `${Number(body.price).toFixed(2)}`, pricePerBase: (Number(body.price) / 10000).toFixed(6), effectiveFrom: body.effectiveFrom }));
      return json({ price: {}, previous: {}, changePct: '8.33', warnings: [], backdated: false }) || true;
    }
    return false;
  };
  handler.state = state;
  return handler;
}
const chain = (...handlers) => async (args) => { for (const h of handlers) { if (await h(args)) return true; } return false; };

const sidebar = (page) => page.getByRole('navigation', { name: 'Owner navigation' });

test.describe('navigation', () => {
  test('purchasing entries show only when inventory is on, and open their pages', async ({ page }) => {
    await setup(page);
    await page.goto('/owner/inventory/receive');
    const nav = sidebar(page);
    await expect(nav.getByText('Purchasing', { exact: true })).toBeVisible();
    for (const name of ['Suppliers', 'Purchase orders', 'Receive goods', 'Approvals']) await expect(nav.getByRole('link', { name })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Receive goods' })).toBeVisible();
    await expect(page.getByText('Receiving goods is coming soon')).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Receive goods' })).toHaveClass(/is-active/);
    // The Approvals entry shows how many decisions are waiting.
    await expect(nav.getByRole('link', { name: /Approvals/ })).toContainText('2');
    await nav.getByRole('link', { name: /Approvals/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Stock', exact: true })).not.toHaveClass(/is-active/);
    // A notification link to one order lands on the Purchase orders page with that order.
    await page.goto(`/owner/inventory/purchase-orders/${PO}`);
    await expect(page).toHaveURL(new RegExp(`/owner/inventory/purchase-orders\\?po=${PO}`));
  });

  test('nothing from Purchasing shows while inventory is off', async ({ page }) => {
    await setup(page, { inventory: false });
    await page.goto('/owner/inventory/suppliers');
    await expect(page.getByText('Inventory isn’t switched on for this business yet.')).toBeVisible();
    for (const name of ['Suppliers', 'Purchase orders', 'Receive goods', 'Approvals']) await expect(sidebar(page).getByRole('link', { name })).toHaveCount(0);
    await expect(sidebar(page).getByText('Purchasing', { exact: true })).toHaveCount(0);
  });

  test('branch sidebar gets Purchases only with inventory on', async ({ page }) => {
    await setup(page, { account: managerAccount });
    await page.goto(`/branch/${BRANCH}/inventory/purchases`);
    const nav = page.getByRole('navigation', { name: 'Branch navigation' });
    await expect(nav.getByRole('link', { name: 'Purchases', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Purchases' })).toBeVisible();
  });

  test('branch with inventory off has no Purchases entry', async ({ page }) => {
    await setup(page, { account: managerAccount, inventory: false });
    await page.goto(`/branch/${BRANCH}/products`);
    await expect(page.getByRole('navigation', { name: 'Branch navigation' }).getByRole('link', { name: 'Purchases', exact: true })).toHaveCount(0);
  });
});

test.describe('suppliers', () => {
  test('lists suppliers, filters by kind and shows "needs details" for ones added on the spot', async ({ page }) => {
    const api = suppliersApi({ suppliers: [supplier(), supplier({ id: KIOSK, name: 'Corner Kiosk', type: 'one_off', phone: '254733111222', contactName: null, incomplete: true, paymentTermsDays: 0, paymentMethod: 'cash' })] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/suppliers');
    const table = page.getByRole('table');
    await expect(table.getByRole('button', { name: 'Karibu Poultry' })).toBeVisible();
    await expect(table.getByText('Pay within 30 days')).toBeVisible();
    await expect(table.getByText('Pay on delivery')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('1 supplier needs details');
    await page.getByLabel('Kind of supplier').selectOption('one_off');
    await expect(table.getByRole('button', { name: 'Karibu Poultry' })).toHaveCount(0);
    await expect(table.getByText('Needs details')).toBeVisible();
    await page.getByLabel('Kind of supplier').selectOption('');
    await page.getByLabel('Search suppliers').fill('zzz');
    await expect(page.getByText('No suppliers match')).toBeVisible();
  });

  test('add a supplier: phone 0712… becomes 254712…, KRA PIN is optional, request body is right', async ({ page }) => {
    const api = suppliersApi({ suppliers: [] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/suppliers');
    await expect(page.getByText('No suppliers yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add supplier' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add supplier' });
    await drawer.getByLabel('Supplier name').fill('Mama Mboga Fresh');
    await drawer.getByText('Informal', { exact: true }).click();
    await drawer.getByLabel('Phone number').fill('0712 345 678');
    await expect(drawer.getByText('254712345678')).toBeVisible();
    await drawer.getByLabel('Phone number').fill('12345');
    await expect(drawer.getByText('That doesn’t look like a Kenyan mobile number.')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Add supplier' })).toBeDisabled();
    await drawer.getByLabel('Phone number').fill('+254 712 345 678');
    await drawer.getByLabel('Contact person').fill('Mama Njeri');
    await drawer.getByLabel('Payment terms in days').fill('7');
    await drawer.getByLabel('How do you pay them?').selectOption('mpesa');
    await drawer.getByLabel('M-Pesa till number').fill('567890');
    await drawer.getByRole('button', { name: 'Add supplier' }).click();
    await expect.poll(() => api.state.posted.supplier).toBeTruthy();
    expect(api.state.posted.supplier).toMatchObject({ name: 'Mama Mboga Fresh', type: 'informal', phone: '254712345678', contactName: 'Mama Njeri', kraPin: '', paymentTermsDays: 7, paymentMethod: 'mpesa', mpesaTill: '567890' });
    expect(api.state.posted.supplier.commandId).toMatch(/^[0-9a-f-]{36}$/);
    // The new supplier opens, ready for its first price.
    await expect(page.getByRole('dialog', { name: 'Mama Mboga Fresh' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a price' })).toBeVisible();
  });

  test('a supplier shows what it supplies per pack, and a new price lands first in the history with the change', async ({ page }) => {
    const api = suppliersApi({ prices: [row6000] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/suppliers');
    await page.getByRole('button', { name: 'Karibu Poultry' }).click();
    const drawer = page.getByRole('dialog', { name: 'Karibu Poultry' });
    await expect(drawer.getByText('Pay within 30 days')).toBeVisible();
    await expect(drawer.getByText('Ksh 6,000 per crate (10 kg) · Ksh 600/kg').first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Add a price' }).click();
    const form = page.getByRole('dialog', { name: 'Add a price' });
    await form.getByLabel('Which item?').fill('chick');
    await form.getByRole('button', { name: 'Chicken' }).click();
    await form.getByLabel('The price is for one…').selectOption('crate');
    await form.getByLabel('Price per crate').fill('6500');
    await expect(form.getByText('1 crate = 10 kg')).toBeVisible();
    await expect(form.getByText('Ksh 650/kg')).toBeVisible();
    await form.getByRole('button', { name: 'Save price' }).click();
    await expect.poll(() => api.state.posted.price).toBeTruthy();
    expect(api.state.posted.price).toMatchObject({ itemId: CHICKEN, unit: 'crate', price: '6500' });
    expect(api.state.posted.price.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(api.state.posted.price.commandId).toMatch(/^[0-9a-f-]{36}$/);
    // Back on the supplier: the new price is in use, the old one is history, newest first, with the change.
    const back = page.getByRole('dialog', { name: 'Karibu Poultry' });
    const history = back.getByRole('region', { name: 'Price history' });
    await expect(history.getByText('Ksh 6,500 per crate (10 kg) · Ksh 650/kg')).toBeVisible();
    const entries = history.locator('li');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText('Ksh 6,500 per crate');
    await expect(entries.nth(0)).toContainText('in use now');
    await expect(entries.nth(0)).toContainText('+8.3% since last time');
    await expect(entries.nth(1)).toContainText('Ksh 6,000 per crate');
  });

  test('deactivating asks first', async ({ page }) => {
    let off = null;
    const api = suppliersApi();
    await setup(page, { extra: async (args) => {
      if (args.method === 'POST' && args.pathname === `${API}/suppliers/${SUPPLIER}/deactivate`) { off = args.request.postDataJSON(); args.json({ supplier: supplier({ status: 'inactive' }) }); return true; }
      return api(args);
    } });
    await page.goto(`/owner/inventory/suppliers?supplier=${SUPPLIER}`);
    const drawer = page.getByRole('dialog', { name: 'Karibu Poultry' });
    await drawer.getByRole('button', { name: 'Deactivate supplier' }).click();
    await expect(drawer.getByText('You won’t be able to order from them until you activate them again.')).toBeVisible();
    await drawer.getByRole('button', { name: 'Yes, deactivate' }).click();
    await expect.poll(() => off).not.toBeNull();
    expect(off.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

test.describe('purchase orders', () => {
  const orderApi = ({ current = order(), posted = {}, extra = () => false } = {}) => {
    const state = { order: current, posted };
    const handler = async (args) => {
      const { request, pathname, method, json } = args;
      if (await extra(args, state)) return true;
      if (pathname === `${API}/reorder-suggestions` && method === 'GET') return json(suggestions) || true;
      if (pathname === `${API}/reorder-suggestions/create-orders` && method === 'POST') { state.posted.create = request.postDataJSON(); return json({ orders: [state.order], skipped: [] }) || true; }
      if (pathname === `${API}/purchase-orders` && method === 'GET') return json({ orders: [listed(state.order)], nextBefore: null }) || true;
      if (pathname === `${API}/purchase-orders` && method === 'POST') { state.posted.order = request.postDataJSON(); return json({ order: state.order }) || true; }
      if (pathname === `${API}/purchase-orders/${PO}` && method === 'GET') return json({ order: state.order }) || true;
      if (pathname === `${API}/purchase-orders/${PO}/document` && method === 'GET') return json(documentOf(state.order)) || true;
      return false;
    };
    handler.state = state;
    return handler;
  };

  test('list shows status chips with counts and the self-approved mark', async ({ page }) => {
    const api = orderApi({ current: order({ status: 'approved', selfApproved: true, approvedAt: '2026-11-18T09:00:00Z', approvedBy: USER }) });
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto('/owner/inventory/purchase-orders');
    const chips = page.getByRole('group', { name: 'Filter by status' });
    await expect(chips.getByRole('button', { name: 'All 1' })).toBeVisible();
    await expect(chips.getByRole('button', { name: 'Approved 1' })).toBeVisible();
    await expect(chips.getByRole('button', { name: 'Draft' })).toHaveCount(0);
    const table = page.getByRole('table');
    await expect(table.getByRole('button', { name: 'PO-2026-0001' })).toBeVisible();
    await expect(table.getByText('Self-approved')).toBeVisible();
    await expect(table.getByText('Ksh 22,620')).toBeVisible();
  });

  test('suggested orders: one tap creates a draft per supplier and opens it', async ({ page }) => {
    const api = orderApi();
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto('/owner/inventory/purchase-orders');
    const panel = page.getByRole('region', { name: /Suggested orders/ });
    await expect(panel.getByText('Order from Karibu Poultry')).toBeVisible();
    await expect(panel.getByText('1 item: Chicken · about Ksh 19,500')).toBeVisible();
    await panel.getByText('Why these items?').click();
    await expect(panel.getByText('Chicken: 4 kg on hand, reorder at 20 kg → order 30 kg = 3 crates')).toBeVisible();
    await panel.getByRole('button', { name: 'Create orders' }).click();
    await expect.poll(() => api.state.posted.create).toBeTruthy();
    expect(api.state.posted.create).toMatchObject({ locationId: WAREHOUSE });
    expect(api.state.posted.create.commandId).toMatch(/^[0-9a-f-]{36}$/);
    const drawer = page.getByRole('dialog', { name: 'PO-2026-0001' });
    await expect(drawer.getByText('Draft', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Submit for approval' })).toBeVisible();
  });

  test('a new order: lines in packs show what they are in kg, the price starts from the list, totals add VAT', async ({ page }) => {
    const api = orderApi();
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto('/owner/inventory/purchase-orders');
    await page.getByRole('button', { name: 'New purchase order' }).click();
    const drawer = page.getByRole('dialog', { name: 'New purchase order' });
    await drawer.getByLabel('Supplier', { exact: true }).selectOption(SUPPLIER);
    await drawer.getByLabel('Add an item').fill('chick');
    await expect(drawer.getByText('On this supplier’s price list')).toBeVisible();
    await drawer.getByRole('button', { name: /Chicken/ }).click();
    // Starts in the pack the supplier prices it in, with the list price.
    await expect(drawer.getByLabel('Unit for Chicken')).toHaveValue('crate');
    await expect(drawer.getByLabel('Price of Chicken per crate')).toHaveValue('6500');
    await drawer.getByLabel('How much').fill('3');
    await expect(drawer.getByText('3 crates = 30 kg')).toBeVisible();
    const sums = drawer.getByLabel('Order total');
    await expect(sums).toContainText('Subtotal');
    await expect(sums).toContainText('Ksh 19,500');
    await expect(sums).toContainText('VAT (16%)');
    await expect(sums).toContainText('Ksh 3,120');
    await expect(sums).toContainText('Ksh 22,620');
    // Another unit re-prices from the list: kg is Ksh 650 each.
    await drawer.getByLabel('Unit for Chicken').selectOption('kg');
    await expect(drawer.getByLabel('Price of Chicken per kg')).toHaveValue('650');
    await drawer.getByLabel('Unit for Chicken').selectOption('crate');
    await drawer.getByLabel('Price of Chicken per crate').fill('7000');
    await expect(drawer.getByText('Changed from the price list (Ksh 6,500 per crate).')).toBeVisible();
    await expect(drawer.getByLabel('Order total')).toContainText('Ksh 24,360');
    await drawer.getByRole('button', { name: 'Save draft order' }).click();
    await expect.poll(() => api.state.posted.order).toBeTruthy();
    expect(api.state.posted.order).toMatchObject({ supplierId: SUPPLIER, deliverToLocationId: WAREHOUSE, lines: [{ itemId: CHICKEN, qty: '3', unit: 'crate', price: '7000' }] });
    expect(api.state.posted.order.commandId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('dialog', { name: 'PO-2026-0001' })).toBeVisible();
  });

  test('a price taken from the list is not sent as an override', async ({ page }) => {
    const api = orderApi();
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto('/owner/inventory/purchase-orders');
    await page.getByRole('button', { name: 'New purchase order' }).click();
    const drawer = page.getByRole('dialog', { name: 'New purchase order' });
    await drawer.getByLabel('Supplier', { exact: true }).selectOption(SUPPLIER);
    await drawer.getByLabel('Add an item').fill('chick');
    await drawer.getByRole('button', { name: /Chicken/ }).click();
    await drawer.getByLabel('How much').fill('2');
    await drawer.getByRole('button', { name: 'Save draft order' }).click();
    await expect.poll(() => api.state.posted.order).toBeTruthy();
    expect(api.state.posted.order.lines).toEqual([{ itemId: CHICKEN, qty: '2', unit: 'crate' }]);
  });

  test('submit: self-approved says so in plain words', async ({ page }) => {
    const submitted = {};
    const api = orderApi({ extra: async ({ request, pathname, method, json }, state) => {
      if (method === 'POST' && pathname === `${API}/purchase-orders/${PO}/submit`) {
        submitted.body = request.postDataJSON();
        state.order = order({ status: 'approved', selfApproved: true, approvedBy: USER, approvedAt: '2026-11-18T09:00:00.000Z' });
        json({ order: state.order });
        return true;
      }
      return false;
    } });
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto(`/owner/inventory/purchase-orders?po=${PO}`);
    const drawer = page.getByRole('dialog', { name: 'PO-2026-0001' });
    await drawer.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(drawer.getByText('Approved — you are the only approver, so it was approved straight away.')).toBeVisible();
    await expect(drawer.getByText('Self-approved').first()).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Send to supplier' })).toBeVisible();
    expect(submitted.body.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('submit: when someone else must approve, it says "Waiting for approval"', async ({ page }) => {
    const api = orderApi({ extra: async ({ pathname, method, json }, state) => {
      if (method === 'POST' && pathname === `${API}/purchase-orders/${PO}/submit`) { state.order = order({ status: 'pending_approval' }); json({ order: state.order }); return true; }
      return false;
    } });
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto(`/owner/inventory/purchase-orders?po=${PO}`);
    const drawer = page.getByRole('dialog', { name: 'PO-2026-0001' });
    await drawer.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(drawer.getByText('Waiting for approval. The people who approve orders have been told.')).toBeVisible();
    await expect(drawer.getByRole('list', { name: 'What has happened' })).toContainText('Waiting for approval');
  });

  test('send shows the order as a document with a WhatsApp link, and print marks it sent', async ({ page, context }) => {
    const sends = [];
    await context.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>WhatsApp</p>' }));
    const api = orderApi({ current: order({ status: 'approved', approvedAt: '2026-11-18T09:00:00.000Z', approvedBy: USER }), extra: async ({ request, pathname, method, json }, state) => {
      if (method === 'POST' && pathname === `${API}/purchase-orders/${PO}/send`) {
        const body = request.postDataJSON(); sends.push(body);
        state.order = order({ status: 'sent', sentAt: '2026-11-18T10:00:00.000Z', sentVia: body.via, approvedAt: '2026-11-18T09:00:00.000Z', approvedBy: USER });
        json({ order: state.order, ...documentOf(state.order) });
        return true;
      }
      return false;
    } });
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto(`/owner/inventory/purchase-orders?po=${PO}`);
    const drawer = page.getByRole('dialog', { name: 'PO-2026-0001' });
    await drawer.getByRole('button', { name: 'Send to supplier' }).click();
    const sheet = page.getByRole('dialog', { name: 'Send PO-2026-0001' });
    const doc = sheet.getByRole('article', { name: 'Purchase order PO-2026-0001' });
    await expect(doc).toContainText('Karibu Poultry');
    await expect(doc).toContainText('3 crates');
    await expect(doc).toContainText('Ksh 22,620');
    const whatsapp = sheet.getByRole('link', { name: 'Send on WhatsApp' });
    await expect(whatsapp).toHaveAttribute('href', /^https:\/\/wa\.me\/254712345678\?text=/);
    await expect(whatsapp).toHaveAttribute('target', '_blank');
    await sheet.getByRole('button', { name: 'Print or save as PDF' }).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0]).toMatchObject({ via: 'pdf' });
    expect(sends[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
    await sheet.getByRole('button', { name: 'Back to the order' }).click();
    await expect(page.getByRole('dialog', { name: 'PO-2026-0001' }).getByText('Sent', { exact: true }).first()).toBeVisible();
  });

  test('WhatsApp opens the link and marks the order sent that way', async ({ page, context }) => {
    const sends = [];
    await context.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>WhatsApp</p>' }));
    const api = orderApi({ current: order({ status: 'approved' }), extra: async ({ request, pathname, method, json }, state) => {
      if (method === 'POST' && pathname === `${API}/purchase-orders/${PO}/send`) { sends.push(request.postDataJSON()); state.order = order({ status: 'sent' }); json({ order: state.order, ...documentOf(state.order) }); return true; }
      return false;
    } });
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto(`/owner/inventory/purchase-orders?po=${PO}`);
    await page.getByRole('dialog', { name: 'PO-2026-0001' }).getByRole('button', { name: 'Send to supplier' }).click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Send on WhatsApp' }).click();
    expect((await popup).url()).toContain('https://wa.me/254712345678');
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0].via).toBe('whatsapp');
  });

  test('cancel needs a reason and asks before it does anything', async ({ page }) => {
    const cancelled = {};
    const api = orderApi({ current: order({ status: 'approved' }), extra: async ({ request, pathname, method, json }, state) => {
      if (method === 'POST' && pathname === `${API}/purchase-orders/${PO}/cancel`) {
        cancelled.body = request.postDataJSON(); state.order = order({ status: 'cancelled', cancelledAt: '2026-11-18T11:00:00.000Z', cancelReason: cancelled.body.reason }); json({ order: state.order }); return true;
      }
      return false;
    } });
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto(`/owner/inventory/purchase-orders?po=${PO}`);
    const drawer = page.getByRole('dialog', { name: 'PO-2026-0001' });
    await drawer.getByRole('button', { name: 'Cancel order' }).click();
    const confirm = drawer.getByRole('alertdialog', { name: 'Cancel this order?' });
    const yes = confirm.getByRole('button', { name: 'Yes, cancel the order' });
    await expect(yes).toBeDisabled();
    await confirm.getByLabel('Why are you cancelling this order?').fill('Supplier is out of stock');
    await expect(yes).toBeEnabled();
    await yes.click();
    await expect.poll(() => cancelled.body).toBeTruthy();
    expect(cancelled.body).toMatchObject({ reason: 'Supplier is out of stock' });
    await expect(drawer.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    await expect(drawer.getByRole('list', { name: 'What has happened' })).toContainText('Supplier is out of stock');
  });

  test('someone who cannot create orders sees them read-only', async ({ page }) => {
    const api = orderApi({ current: order({ status: 'approved' }) });
    const readOnly = { ...overview, capabilities: { view: true, costView: true } };
    await setup(page, { extra: async (args) => {
      if (args.pathname === API && args.method === 'GET') { args.json(readOnly); return true; }
      return api(args);
    } });
    await page.goto(`/owner/inventory/purchase-orders?po=${PO}`);
    const drawer = page.getByRole('dialog', { name: 'PO-2026-0001' });
    await expect(drawer.getByText('You can look at this order but not change it.')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Send to supplier' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New purchase order' })).toHaveCount(0);
  });
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const noSideways = async (page) => {
    const wide = await page.evaluate(() => {
      const over = [...document.querySelectorAll('body *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1 && !el.closest('.inv-table-wrap, .o-segmented, .visually-hidden, .po-print-root, [aria-hidden=true]');
      }).slice(0, 3).map((el) => `${el.tagName}.${el.className}`);
      return { page: document.documentElement.scrollWidth - window.innerWidth, over };
    });
    expect(wide.page, JSON.stringify(wide.over)).toBeLessThanOrEqual(0);
    expect(wide.over).toEqual([]);
  };

  test('suppliers: cards, 44px targets, no sideways scrolling, also in the sheets', async ({ page }) => {
    await setup(page, { extra: suppliersApi() });
    await page.goto('/owner/inventory/suppliers');
    await expect(page.getByRole('button', { name: 'Karibu Poultry' })).toBeVisible();
    await noSideways(page);
    const add = await page.getByRole('button', { name: 'Add supplier' }).boundingBox();
    expect(add.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'Karibu Poultry' }).click();
    const sheet = page.getByRole('dialog', { name: 'Karibu Poultry' });
    await expect(sheet.getByText('Price history')).toBeVisible();
    await noSideways(page);
    for (const name of ['Add a price', 'Edit details']) expect((await sheet.getByRole('button', { name }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await sheet.getByRole('button', { name: 'Edit details' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit Karibu Poultry' })).toBeVisible();
    await noSideways(page);
  });

  test('purchase orders: chips wrap, the list is cards, the editor fits', async ({ page }) => {
    const api = (() => {
      const state = { order: order() };
      return async ({ pathname, method, json }) => {
        if (pathname === `${API}/reorder-suggestions` && method === 'GET') return json(suggestions) || true;
        if (pathname === `${API}/purchase-orders` && method === 'GET') return json({ orders: [listed(state.order)], nextBefore: null }) || true;
        return false;
      };
    })();
    await setup(page, { extra: chain(api, suppliersApi()) });
    await page.goto('/owner/inventory/purchase-orders');
    await expect(page.getByRole('button', { name: 'PO-2026-0001' })).toBeVisible();
    await noSideways(page);
    expect((await page.getByRole('button', { name: 'New purchase order' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole('button', { name: 'Create orders' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole('button', { name: /^All/ }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'New purchase order' }).click();
    const sheet = page.getByRole('dialog', { name: 'New purchase order' });
    await sheet.getByLabel('Supplier', { exact: true }).selectOption(SUPPLIER);
    await sheet.getByLabel('Add an item').fill('chick');
    await sheet.getByRole('button', { name: /Chicken/ }).click();
    await sheet.getByLabel('How much').fill('3');
    await expect(sheet.getByText('3 crates = 30 kg')).toBeVisible();
    await noSideways(page);
  });
});
