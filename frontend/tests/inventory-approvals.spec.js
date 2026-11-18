// Approvals inbox (P2-16): Waiting for you, Decided and Branch purchases, with approve / send back. MOCKED like
// inventory-purchasing.spec.js; any API path not listed gets a 404.
//   cd frontend && npx playwright test tests/inventory-approvals.spec.js
import { test, expect } from '@playwright/test';
import { API, BRANCH_LOCATION, CHICKEN, PO, scrollsSideways, setup } from './helpers/inventory-mock';

const EP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EP2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TINY = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const approval = (patch) => ({ id: 'a-1', businessId: 'b', subject: 'purchase_order', subjectId: PO, locationId: null, locationName: null, approverCapability: 'inv.purchase.approve', requestedBy: 'u2',
  requestedByName: 'Wanjiru (manager)', requestedAt: '2026-11-18T07:00:00.000Z', amountKes: '22500.00', reasons: [], safeDefault: false, status: 'pending', decidedBy: null, decidedByName: null,
  decidedAt: null, decisionNote: null, selfApproved: false, canDecide: true, selfApproval: false, ...patch });
const poApproval = approval({ id: 'a-po', reasons: ['Over the Ksh 20,000 limit for orders.'],
  summary: { kind: 'purchase_order', number: 'PO-2026-0007', status: 'pending_approval', supplierName: 'Farm Fresh', total: '22500.00', lineCount: 3, deliverTo: 'Warehouse', expectedDate: '2026-11-20' } });
const emergencyApproval = approval({ id: 'a-ep', subject: 'emergency_purchase', subjectId: EP, locationId: BRANCH_LOCATION, locationName: 'Abdis Test Restaurant', approverCapability: 'inv.emergency.approve',
  amountKes: '3200.00', safeDefault: true, reasons: ['No limit is set for Abdis Test Restaurant. The owner is asked.'] });
const wastageApproval = approval({ id: 'a-w', subject: 'wastage', subjectId: 'w1', locationName: 'Abdis Test Restaurant', amountKes: '1800.00', reasons: ['More than Ksh 1,000 per record.'] });
const emergency = (patch = {}) => ({ id: EP, number: 'EP-2026-0004', status: 'pending_approval', locationId: BRANCH_LOCATION, locationName: 'Abdis Test Restaurant', requestedByName: 'Branch Manager', supplierId: 's', supplierName: 'Mama Njeri Market',
  supplierIncomplete: true, reason: 'Chicken ran out, 30 covers booked', estimatedTotal: '3200.00', approvedTotal: null, actualTotal: null, paymentMethod: null, invoiceStatus: null, invoiceNo: null, noInvoiceReason: null,
  submittedAt: '2026-11-18T07:00:00.000Z', createdAt: '2026-11-18T06:55:00.000Z', reviewNote: null, clawbackNote: null,
  lines: [{ id: 'el1', itemId: CHICKEN, itemName: 'Chicken', qty: '2', unit: 'kg', estimatedUnitPrice: '1600.00', estimatedTotal: '3200.00', actualUnitPrice: null, actualTotal: null, received: null }],
  approvals: [], evidence: [{ id: 'ev1', name: 'goods.gif', mime: 'image/gif', url: TINY }], ...patch });
const row = (p) => ({ id: p.id, number: p.number, status: p.status, locationName: p.locationName, supplierName: p.supplierName, reason: p.reason, estimatedTotal: p.estimatedTotal, actualTotal: p.actualTotal,
  invoiceStatus: p.invoiceStatus, createdAt: p.createdAt });

/** The approvals and emergency endpoints with a little state, so a decided card leaves the waiting list. */
function approvalsApi({ pending = [poApproval, emergencyApproval, wastageApproval], decided = [], purchases = [], onDecide } = {}) {
  const state = { pending: [...pending], decided: [...decided], decisions: [], reviews: [], purchases: [...purchases] };
  const handler = async ({ request, pathname, searchParams, method, json }) => {
    if (pathname === `${API}/approvals` && searchParams.get('limit')) {
      const list = searchParams.get('status') === 'pending' ? state.pending : state.decided;
      return json({ approvals: list, pending: state.pending.length });
    }
    if (pathname === `${API}/approvals` && searchParams.get('status') === 'pending') return json({ approvals: [], pending: state.pending.length });
    const decide = /\/approvals\/([^/]+)\/decide$/.exec(pathname);
    if (decide && method === 'POST') {
      const body = request.postDataJSON(); state.decisions.push({ id: decide[1], ...body });
      if (onDecide) return onDecide(body, state.decisions.length, json);
      const found = state.pending.find((a) => a.id === decide[1]);
      state.pending = state.pending.filter((a) => a.id !== decide[1]);
      state.decided.unshift({ ...found, status: body.decision === 'approve' ? 'approved' : 'rejected', decidedByName: 'Owner Test', decidedAt: '2026-11-18T09:00:00.000Z', decisionNote: body.note || null });
      return json({ ...found, status: 'approved' });
    }
    if (pathname === `${API}/emergency` && method === 'GET') return json({ purchases: state.purchases.map(row), counts: {} });
    if (pathname === `${API}/emergency/${EP}` && method === 'GET') return json(emergency());
    if (pathname === `${API}/emergency/${EP2}` && method === 'GET') return json(state.purchases[0]);
    if (pathname === `${API}/emergency/${EP2}/review` && method === 'POST') { state.reviews.push(request.postDataJSON()); return json({ ...state.purchases[0], status: 'closed' }); }
    return false;
  };
  handler.state = state;
  return handler;
}

const waiting = (page) => page.getByRole('tabpanel');

test.describe('approvals inbox', () => {
  test('waiting for you: each card says who asked, what, how much and why it came to you', async ({ page }) => {
    await setup(page, { extra: approvalsApi() });
    await page.goto('/owner/inventory/approvals');
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Waiting for you/ })).toContainText('3');
    // Purchase order.
    const po = waiting(page).getByRole('listitem').filter({ hasText: 'Purchase order · Ksh 22,500' });
    await expect(po).toContainText('Asked by Wanjiru (manager)');
    await expect(po).toContainText('PO-2026-0007');
    await expect(po).toContainText('Farm Fresh');
    await expect(po).toContainText('3 lines');
    await expect(po).toContainText('Warehouse');
    await expect(po).toContainText('Over the Ksh 20,000 limit for orders.');
    // Emergency purchase: the branch, the items, the reason, the supplier and the photo.
    const ep = waiting(page).getByRole('listitem').filter({ hasText: 'Emergency purchase' });
    await expect(ep).toContainText('Abdis Test Restaurant');
    await expect(ep).toContainText('Chicken');
    await expect(ep).toContainText('2 kg');
    await expect(ep).toContainText('Chicken ran out, 30 covers booked');
    await expect(ep).toContainText('Mama Njeri Market (new, details missing)');
    await expect(ep.getByRole('img', { name: 'goods.gif' })).toBeVisible();
    // The detail tiles are as tall as their text, and the item line reads with separators.
    for (const tile of await ep.locator('.rcv-facts > div').all()) expect((await tile.boundingBox()).height).toBeLessThan(120);
    await expect(ep.getByRole('list', { name: 'Items' }).getByRole('listitem')).toHaveText('Chicken — 2 kg · about Ksh 1,600 each · Ksh 3,200');
    for (const tile of await waiting(page).getByRole('listitem').filter({ hasText: 'PO-2026-0007' }).locator('.rcv-facts > div').all()) expect((await tile.boundingBox()).height).toBeLessThan(120);
    await expect(ep).toContainText('No limit is set for Abdis Test Restaurant');
    // Anything else: a plain generic card.
    await expect(waiting(page).getByRole('listitem').filter({ hasText: 'Wastage · Ksh 1,800' })).toContainText('More than Ksh 1,000 per record.');
  });

  test('approving asks first and sends the decision; the card leaves the list and the badge drops', async ({ page }) => {
    const api = approvalsApi();
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/approvals');
    await page.getByRole('button', { name: 'Approve PO-2026-0007' }).click();
    await expect(page.getByRole('group', { name: 'Confirm approval' })).toContainText('Approve Ksh 22,500 for this purchase order?');
    expect(api.state.decisions).toHaveLength(0);
    await page.getByLabel('Note (optional)').fill('Go ahead');
    await page.getByRole('button', { name: 'Yes, approve' }).click();
    await expect(waiting(page).getByText('PO-2026-0007')).toHaveCount(0);
    expect(api.state.decisions[0]).toMatchObject({ id: 'a-po', decision: 'approve', note: 'Go ahead' });
    await expect(page.getByRole('tab', { name: /Waiting for you/ })).toContainText('2');
    await expect(page.getByRole('navigation', { name: 'Owner navigation' }).getByRole('link', { name: /Approvals/ })).toContainText('2');
  });

  test('sending back needs a reason', async ({ page }) => {
    const api = approvalsApi();
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/approvals');
    const ep = waiting(page).getByRole('listitem').filter({ hasText: 'Emergency purchase' });
    await ep.getByRole('button', { name: /Send back/ }).click();
    await ep.getByRole('button', { name: 'Send back', exact: true }).click();
    await expect(ep.getByText('Say what needs to change, so the person who asked knows.')).toBeVisible();
    expect(api.state.decisions).toHaveLength(0);
    await ep.getByLabel('Why are you sending it back?').fill('Use the market price');
    await ep.getByRole('button', { name: 'Send back', exact: true }).click();
    await expect(waiting(page).getByText('Emergency purchase')).toHaveCount(0);
    expect(api.state.decisions[0]).toMatchObject({ id: 'a-ep', decision: 'reject', note: 'Use the market price' });
  });

  test('a request you cannot decide yourself says why, and a refusal is shown in plain words', async ({ page }) => {
    const blocked = approval({ id: 'a-own', blocked: 'You asked for this, so another approver has to decide it.', canDecide: false, summary: poApproval.summary });
    await setup(page, { extra: approvalsApi({ pending: [blocked, poApproval], onDecide: (body, n, json) => json({ error: 'This was already approved by Another Owner.', details: { code: 'already_decided' } }, 409) }) });
    await page.goto('/owner/inventory/approvals');
    await expect(waiting(page).getByText('You asked for this, so another approver has to decide it.')).toBeVisible();
    await page.getByRole('button', { name: 'Approve PO-2026-0007' }).click();
    await page.getByRole('button', { name: 'Yes, approve' }).click();
    await expect(page.getByText('This was already approved by Another Owner.')).toBeVisible();
  });

  test('decided shows who decided, the note and a Self-approved chip', async ({ page }) => {
    const decided = [
      approval({ id: 'd1', status: 'approved', selfApproved: true, canDecide: undefined, decidedByName: 'Owner Test', decidedAt: '2026-11-18T08:00:00.000Z', summary: poApproval.summary }),
      approval({ id: 'd2', status: 'rejected', subject: 'wastage', subjectId: 'w2', amountKes: '900.00', decidedByName: 'Owner Test', decidedAt: '2026-11-17T08:00:00.000Z', decisionNote: 'Count it again first' }),
    ];
    await setup(page, { extra: approvalsApi({ decided }) });
    await page.goto('/owner/inventory/approvals');
    await page.getByRole('tab', { name: 'Decided' }).click();
    const first = waiting(page).getByRole('listitem').filter({ hasText: 'PO-2026-0007' });
    await expect(first.getByText('Self-approved', { exact: true })).toBeVisible();
    await expect(first).toContainText('Approved by Owner Test');
    await expect(first).toContainText('You were the only person who could approve this');
    await expect(first.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    const second = waiting(page).getByRole('listitem').filter({ hasText: 'Wastage' });
    await expect(second).toContainText('Sent back by Owner Test');
    await expect(second).toContainText('“Count it again first”');
    await expect(second.getByText('Self-approved', { exact: true })).toHaveCount(0);
  });

  test('nothing waiting shows a calm empty state', async ({ page }) => {
    await setup(page, { extra: approvalsApi({ pending: [] }) });
    await page.goto('/owner/inventory/approvals');
    await expect(page.getByText('Nothing needs your approval')).toBeVisible();
  });
});

test.describe('branch purchases (owner)', () => {
  const received = (patch) => emergency({ id: EP2, number: 'EP-2026-0005', status: 'under_review', invoiceStatus: 'none', noInvoiceReason: 'Market trader', paymentMethod: 'mpesa', paymentReference: 'SHK7Q2X9LM',
    actualTotal: '3600.00', approvedTotal: '3200.00', reviewNote: 'No invoice: Market trader Cost Ksh 3,600, which is 12.5% more than the Ksh 3,200 authorised.', ...patch });

  test('lists purchases that need a look first, and closes one after review with a note', async ({ page }) => {
    const api = approvalsApi({ purchases: [received()] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/approvals');
    await page.getByRole('tab', { name: 'Branch purchases' }).click();
    await expect(page.getByRole('button', { name: 'Needs a look 1' })).toHaveAttribute('aria-pressed', 'true');
    const card = waiting(page).getByRole('listitem').filter({ hasText: 'EP-2026-0005' });
    await expect(card).toContainText('No invoice');
    await expect(card).toContainText('Received — the owner will check');
    await card.getByRole('button', { name: 'Review EP-2026-0005' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('Market trader');
    await expect(sheet).toContainText('M-Pesa (SHK7Q2X9LM)');
    await sheet.getByLabel('Note').fill('Spoke to the manager');
    await sheet.getByLabel(/Money to get back/).fill('Ksh 400 over the price');
    await sheet.getByRole('button', { name: 'Looks fine, close it' }).click();
    await expect.poll(() => api.state.reviews.length).toBe(1);
    expect(api.state.reviews[0]).toMatchObject({ outcome: 'close', note: 'Spoke to the manager', clawbackNote: 'Ksh 400 over the price' });
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 760 } });
  test('cards fit, nothing scrolls sideways and the buttons are easy to hit', async ({ page }) => {
    await setup(page, { extra: approvalsApi() });
    await page.goto('/owner/inventory/approvals');
    await expect(page.getByText('PO-2026-0007').first()).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    for (const name of ['Approve PO-2026-0007', 'Send back PO-2026-0007']) expect((await page.getByRole('button', { name }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.getByRole('tab', { name: 'Branch purchases' }).click();
    expect(await scrollsSideways(page)).toBe(false);
  });
});
