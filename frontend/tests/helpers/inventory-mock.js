// Shared mock for the Phase 2 purchasing specs (receiving, approvals, emergency purchases): a fake signed-in session, /api/me, the owner
// overview and the branch stock snapshot. A spec adds its own endpoints through `extra`; any API path not answered gets a 404.
export const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BRANCH = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';
export const WAREHOUSE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const BRANCH_LOCATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const CHICKEN = '11111111-1111-4111-8111-111111111111';
export const RICE = '22222222-2222-4222-8222-222222222222';
export const SUPPLIER = '33333333-3333-4333-8333-333333333333';
export const PO = '66666666-6666-4666-8666-666666666666';
export const GRN = '77777777-7777-4777-8777-777777777777';
export const USER = '99999999-9999-4999-8999-999999999999';
export const API = `/api/owner/inventory/${BUSINESS}`;

export const UNITS = [
  { code: 'g', dimension: 'weight', toBase: '1', label: 'g', plural: 'g' },
  { code: 'kg', dimension: 'weight', toBase: '1000', label: 'kg', plural: 'kg' },
  { code: 'piece', dimension: 'count', toBase: '1', label: 'piece', plural: 'pieces' },
];
const CAPS = ['inv.view', 'inv.cost.view', 'inv.item.edit', 'inv.stock.record', 'inv.settings.edit', 'inv.purchase.create', 'inv.purchase.approve'];
export const locations = [
  { id: WAREHOUSE, kind: 'center', name: 'Warehouse', status: 'active', restaurantId: null, label: 'Warehouse', capabilities: CAPS },
  { id: BRANCH_LOCATION, kind: 'branch', name: 'Abdis Test Restaurant', status: 'active', restaurantId: BRANCH, label: 'Branch', capabilities: CAPS },
];
export const chicken = {
  id: CHICKEN, name: 'Chicken', sku: 'CHK-001', kind: 'raw', baseUnit: 'g', measuredBy: 'weight', displayUnit: 'kg', vatClass: 'standard', archived: false,
  units: [{ id: 'u1', name: 'crate', factor: '10000.0000', forPurchase: true, forRecipe: false, forCount: true, size: '10 kg' }], barcodes: [],
  locations: [], totals: { onHand: '4000', display: { onHand: '4 kg' }, value: '0' }, low: true,
};
export const overview = {
  enabled: true, role: 'owner',
  capabilities: { view: true, costView: true, itemEdit: true, purchaseCreate: true, purchaseApprove: true, stockRecord: true, settingsEdit: true },
  warehouse: locations[0], locations, categories: [], units: UNITS, measuredBy: [], items: [chicken], settings: {},
};
export const ownerAccount = { id: USER, email: 'owner@example.com', name: 'Owner Test', role: 'owner', home: '/owner', onboardingRequired: false,
  businesses: [{ id: BUSINESS, name: 'Abdis Group', role: 'owner', branchIds: null }], branches: [] };
export const managerAccount = { id: USER, email: 'manager@example.com', name: 'Branch Manager', role: 'owner', home: `/branch/${BRANCH}`, onboardingRequired: false, businesses: [],
  branches: [{ id: BRANCH, name: 'Abdis Test Restaurant', role: 'manager', status: 'live', businessId: BUSINESS }] };

const crate = { code: 'crate', label: 'crate', plural: 'crates', kind: 'item', factor: '10000' };
const branchUnits = [{ code: 'kg', label: 'kg', plural: 'kg', kind: 'standard', factor: '1000' }, { code: 'g', label: 'g', plural: 'g', kind: 'standard', factor: '1' }, crate];
const branchItem = (id, name) => ({ id, name, sku: null, categoryId: null, categoryName: null, baseUnit: 'g', displayUnit: 'kg', onHand: '5000.0000', heldForOrders: '0.0000', reserved: '0.0000', available: '5000.0000',
  display: { onHand: '5 kg', heldForOrders: '0 g', reserved: '0 g', available: '5 kg' }, level: null, levelDisplay: { min: null, reorder: null, par: null, max: null }, out: false, low: false,
  countNeeded: false, countNeededReason: null, state: 'ok', status: 'OK', dishes: 1, openExceptions: 0, updatedAt: '2026-11-18T08:00:00Z', units: branchUnits, avgCost: '0.650000', value: '3250.00' });
export const branchSnapshot = () => ({
  location: { id: BRANCH_LOCATION, name: 'Abdis Test Restaurant', restaurantId: BRANCH }, generatedAt: '2026-11-18T09:00:00Z', seeCost: false,
  summary: { items: 2, low: 0, out: 0, countNeeded: 0 }, items: [branchItem(CHICKEN, 'Chicken'), branchItem(RICE, 'Cooking oil')], dishes: { tracked: 0, keepSelling: 0, soldOut: [] }, openExceptions: 0,
});

/** Signs in (owner by default), answers /api/me, the overview and notifications, then hands every other request to `extra`. */
export async function setup(page, { account = ownerAccount, extra = () => false, approvalsPending = 2 } = {}) {
  await page.addInitScript((user) => {
    const session = { access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    localStorage.setItem('sb-zpsyrtbqobuwfnuddbsg-auth-token', JSON.stringify(session));
  }, USER);
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: { id: USER, aud: 'authenticated', email: 'owner@example.com' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname, search, searchParams } = new URL(request.url());
    const method = request.method();
    const json = async (body, status = 200) => { await route.fulfill({ status, json: body }); return true; };
    if (await extra({ route, request, pathname, search, searchParams, method, json })) return;
    if (pathname === '/api/me') return json(account);
    if (pathname === API && method === 'GET') return json(overview);
    if (pathname === '/api/inventory' && method === 'GET') return json(branchSnapshot());
    if (pathname === '/api/notifications' || pathname === '/api/notifications/unread-count') return json(pathname.endsWith('count') ? { count: 0 } : { notifications: [] });
    if (pathname === `${API}/approvals` && searchParams.get('status') === 'pending') return json({ approvals: [], pending: approvalsPending });
    return json({ error: 'Not mocked in this test.' }, 404);
  });
}

/** True when the page scrolls sideways. */
export const scrollsSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

/** A big picture made in the browser (so the test can check it is shrunk before upload). Returns PNG bytes. */
export async function bigPicture(page, width = 3200, height = 2400) {
  const base64 = await page.evaluate(([w, h]) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#c33'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#fff'; ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
    return canvas.toDataURL('image/png').split(',')[1];
  }, [width, height]);
  return Buffer.from(base64, 'base64');
}

/** Width and height of a base64 JPEG, measured in the browser. */
export const pictureSize = (page, base64, type = 'image/jpeg') => page.evaluate(([data, mime]) => new Promise((resolve) => {
  const image = new Image(); image.onload = () => resolve({ width: image.width, height: image.height }); image.src = `data:${mime};base64,${data}`;
}), [base64, type]);
