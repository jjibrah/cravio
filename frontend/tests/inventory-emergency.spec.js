// Branch Purchases (P2-17): emergency buys from "New purchase" to "Goods arrived". MOCKED like inventory-purchasing.spec.js; any API path
// not listed gets a 404. The mock keeps one purchase and moves it along as the screen calls the steps.
//   cd frontend && npx playwright test tests/inventory-emergency.spec.js
import { test, expect } from '@playwright/test';
import { BRANCH, BRANCH_LOCATION, RICE, bigPicture, managerAccount, pictureSize, scrollsSideways, setup } from './helpers/inventory-mock';

const EP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SUP = '33333333-3333-4333-8333-333333333333';
const E = '/api/inventory/emergency';
const purchase = (patch = {}) => ({
  id: EP, number: 'EP-2026-0004', status: 'draft', locationId: BRANCH_LOCATION, locationName: 'Abdis Test Restaurant', requestedByName: 'Branch Manager', supplierId: SUP, supplierName: 'Mama Njeri Market', supplierIncomplete: false,
  reason: 'Oil ran out', estimatedTotal: '2400.00', approvedTotal: null, actualTotal: null, paymentMethod: null, paymentReference: null, invoiceStatus: null, invoiceNo: null, noInvoiceReason: null,
  createdAt: '2026-11-18T06:55:00.000Z', submittedAt: null, reviewNote: null,
  lines: [{ id: 'el1', position: 0, itemId: RICE, itemName: 'Cooking oil', qty: '2', unit: 'kg', estimatedUnitPrice: '1200.00', estimatedTotal: '2400.00', actualUnitPrice: null, actualTotal: null, received: null }],
  approvals: [], evidence: [], ...patch,
});

/** Limits: 'within' (KES 3,500 left today, 3,000 a purchase), 'none' (no limit set). */
function emergencyApi({ limits = 'within', start = [], after = 'authorised' } = {}) {
  const state = { purchases: [...start], sent: { create: [], submit: [], purchased: [], evidence: [], receive: [], cancel: [] }, limitsAsked: [] };
  const find = () => state.purchases[0];
  const handler = async ({ request, pathname, searchParams, method, json }) => {
    if (pathname === `${E}/limits`) {
      const amount = Number(searchParams.get('amount')) || 0;
      state.limitsAsked.push(amount);
      if (limits === 'none') return json({ hasLimit: false, message: 'No limit set for Abdis Test Restaurant. The owner will be asked.', preview: amount ? { needsApproval: true, reasons: ['No limit is set for this branch.'], safeDefault: true } : null });
      const over = amount > 3000;
      return json({ hasLimit: true, perTransactionKes: '3000.00', perDayKes: '4000.00', leftTodayKes: '3500.00', leftWeekKes: '9000.00', message: 'Within your limit: Ksh 3,000 per purchase, Ksh 3,500 left today.',
        preview: amount ? { needsApproval: over, reasons: over ? ['More than the Ksh 3,000 limit per purchase.'] : [], safeDefault: false } : null });
    }
    if (pathname === `${E}/suppliers` && method === 'GET') return json({ suppliers: [{ id: SUP, name: 'Mama Njeri Market', type: 'informal', incomplete: false }] });
    if (pathname === E && method === 'GET') return json({ purchases: state.purchases, counts: {} });
    if (pathname === E && method === 'POST') { state.sent.create.push(request.postDataJSON()); state.purchases = [purchase()]; return json(find()); }
    if (pathname === `${E}/${EP}` && method === 'GET') return json(find());
    if (pathname === `${E}/${EP}/submit`) {
      state.sent.submit.push(request.postDataJSON());
      state.purchases = [purchase({ status: after, approvedTotal: after === 'authorised' ? '2400.00' : null })];
      return json({ ...find(), evaluation: { needsApproval: after !== 'authorised', limits: { message: 'Within your limit: Ksh 1,100 left today.' } }, replayed: false });
    }
    if (pathname === `${E}/${EP}/purchased`) {
      const body = request.postDataJSON(); state.sent.purchased.push(body);
      state.purchases = [purchase({ status: 'purchased', approvedTotal: '2400.00', actualTotal: '2500.00', paymentMethod: body.paymentMethod, paymentReference: body.paymentReference || null,
        invoiceStatus: body.invoiceStatus, invoiceNo: body.invoiceNo || null, noInvoiceReason: body.noInvoiceReason || null,
        lines: [{ ...purchase().lines[0], actualUnitPrice: '1250.00', actualTotal: '2500.00' }], evidence: state.sent.evidence.length ? [{ id: 'ev', mime: 'image/jpeg', name: 'p.jpg' }] : [] })];
      return json(find());
    }
    if (pathname === `${E}/${EP}/evidence`) { state.sent.evidence.push(request.postDataJSON()); return json({ id: 'att', name: 'p.jpg' }); }
    if (pathname === `${E}/${EP}/receive`) {
      state.sent.receive.push(request.postDataJSON());
      return json({ ...find(), status: 'received', stock: [{ itemId: RICE, itemName: 'Cooking oil', added: '1.5 kg', unitCost: '1.25', onHand: '6500' }], flags: [], repeatAlerts: [] });
    }
    if (pathname === `${E}/${EP}/cancel`) { state.sent.cancel.push(request.postDataJSON()); state.purchases = [purchase({ status: 'cancelled' })]; return json(find()); }
    return false;
  };
  handler.state = state;
  return handler;
}

const url = `/branch/${BRANCH}/inventory/purchases`;
const sheet = (page) => page.getByRole('dialog');

async function fillNewPurchase(page, { price = '1200', supplier = SUP } = {}) {
  await page.getByRole('button', { name: 'New purchase' }).click();
  await expect(sheet(page).getByRole('button', { name: 'Close' })).toBeFocused(); // the sheet takes focus first; typing before that would be lost
  // The item list loads in the background: type again until it has arrived.
  await expect(async () => {
    await sheet(page).getByLabel('What do you need to buy?').fill('');
    await sheet(page).getByLabel('What do you need to buy?').fill('oil');
    await sheet(page).getByRole('button', { name: /Cooking oil/ }).click({ timeout: 1500 });
  }).toPass({ timeout: 10000 });
  await sheet(page).getByLabel('Cooking oil amount', { exact: true }).fill('2');
  await sheet(page).getByLabel('Cooking oil price', { exact: true }).fill(price);
  if (supplier) await sheet(page).getByLabel('Who are you buying from?').selectOption(supplier);
}

test.describe('new purchase', () => {
  test('the limits line says "approved straight away" or "the owner will be asked" as the amount grows', async ({ page }) => {
    const api = emergencyApi();
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    await expect(page.getByText('Within your limit: Ksh 3,000 per purchase, Ksh 3,500 left today.')).toBeVisible();
    await expect(page.getByText('No purchases yet')).toBeVisible();
    await fillNewPurchase(page, { price: '1200' });
    await expect(sheet(page).getByRole('status').filter({ hasText: 'left today' })).toHaveText('Ksh 3,500 left today — this purchase will be approved straight away.');
    await sheet(page).getByLabel('Cooking oil price', { exact: true }).fill('2000');
    await expect(sheet(page).getByRole('status').filter({ hasText: 'Over your limit' })).toContainText('Over your limit — the owner will be asked.');
    expect(api.state.limitsAsked).toContain(2400);
    expect(api.state.limitsAsked).toContain(4000);
  });

  test('with no limit set the owner is always asked', async ({ page }) => {
    await setup(page, { account: managerAccount, extra: emergencyApi({ limits: 'none' }) });
    await page.goto(url);
    await fillNewPurchase(page);
    await expect(sheet(page).getByText('No limit has been set for this branch yet, so the owner will be asked.')).toBeVisible();
  });

  test('needs a reason and a supplier, then sends a new on-the-spot supplier and the items', async ({ page }) => {
    const api = emergencyApi({ after: 'authorised' });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    await fillNewPurchase(page, { supplier: '__new' });
    await sheet(page).getByRole('button', { name: 'Send purchase' }).click();
    await expect(sheet(page).getByText('Enter the name of the shop or trader.')).toBeVisible();
    await sheet(page).getByLabel('Name of the shop or trader').fill('Mama Njeri Market');
    await sheet(page).getByLabel('Their phone number').fill('0712 345 678');
    await sheet(page).getByRole('button', { name: 'Send purchase' }).click();
    await expect(sheet(page).getByText(/Say why this can’t wait/)).toBeVisible();
    await sheet(page).getByLabel('Why can’t this wait?').fill('Oil ran out');
    await sheet(page).getByRole('button', { name: 'Send purchase' }).click();
    await expect(sheet(page).getByText(/EP-2026-0004 is approved. Go ahead and buy it/)).toBeVisible();
    expect(api.state.sent.create[0]).toMatchObject({ reason: 'Oil ran out', newSupplier: { name: 'Mama Njeri Market', phone: '0712 345 678' },
      lines: [{ itemId: RICE, qty: '2', unit: 'kg', price: '1200' }] });
    expect(api.state.sent.create[0].supplierId).toBeUndefined();
    expect(api.state.sent.submit).toHaveLength(1);
  });

  test('over the limit it is sent to the owner and the card says so, with the next step', async ({ page }) => {
    await setup(page, { account: managerAccount, extra: emergencyApi({ after: 'pending_approval' }) });
    await page.goto(url);
    await fillNewPurchase(page);
    await sheet(page).getByLabel('Why can’t this wait?').fill('Oil ran out');
    await sheet(page).getByRole('button', { name: 'Send purchase' }).click();
    await expect(sheet(page).getByText(/was sent to the owner. You will be told when they decide/)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Done' }).click();
    const card = page.getByRole('listitem').filter({ hasText: 'EP-2026-0004' });
    await expect(card).toContainText('Waiting for the owner');
    await expect(card).toContainText('Wait for the owner to decide');
  });
});

test.describe('I’ve bought it', () => {
  const authorised = purchase({ status: 'authorised', approvedTotal: '2400.00' });

  test('checks the M-Pesa code, and with no invoice needs a reason, a reference and a photo (shrunk before it is sent)', async ({ page }) => {
    const api = emergencyApi({ start: [authorised] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    const card = page.getByRole('listitem').filter({ hasText: 'EP-2026-0004' });
    await expect(card).toContainText('Go ahead and buy');
    await card.getByRole('button', { name: /I’ve bought it/ }).click();
    await sheet(page).getByLabel('Cooking oil price paid', { exact: true }).fill('1250');
    await sheet(page).getByRole('radio', { name: /M-Pesa/ }).check({ force: true });
    await sheet(page).getByLabel('M-Pesa code').fill('shk7q2');
    await expect(sheet(page).getByText(/That doesn’t look like an M-Pesa code. A code has 10 capital letters and numbers, like SHK7Q2X9LM/)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'I’ve bought it' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Enter the M-Pesa code from the message');
    await sheet(page).getByLabel('M-Pesa code').fill('shk7q2x9lm');
    await expect(sheet(page).getByLabel('M-Pesa code')).toHaveValue('SHK7Q2X9LM');
    await sheet(page).getByRole('radio', { name: /No invoice/ }).check({ force: true });
    await sheet(page).getByRole('button', { name: 'I’ve bought it' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('With no invoice, say why');
    await sheet(page).getByLabel('Why is there no invoice?').fill('Market trader, no receipts');
    await sheet(page).getByRole('button', { name: 'I’ve bought it' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('take a photo of the goods or the shop’s slip');
    expect(api.state.sent.purchased).toHaveLength(0);
    // The camera input asks for the back camera on a phone.
    const input = sheet(page).locator('input[type=file]');
    await expect(input).toHaveAttribute('capture', 'environment');
    await expect(input).toHaveAttribute('accept', 'image/*');
    await input.setInputFiles({ name: 'goods.png', mimeType: 'image/png', buffer: await bigPicture(page, 4000, 3000) });
    await expect(sheet(page).getByAltText('The photo you added')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'I’ve bought it' }).click();
    await expect(sheet(page).getByRole('button', { name: 'Goods arrived' })).toBeVisible();
    expect(api.state.sent.purchased[0]).toMatchObject({ paymentMethod: 'mpesa', paymentReference: 'SHK7Q2X9LM', invoiceStatus: 'none', noInvoiceReason: 'Market trader, no receipts', prices: [{ lineId: 'el1', price: '1250' }] });
    const photo = api.state.sent.evidence[0].file;
    expect(photo).toMatchObject({ type: 'image/jpeg', name: 'goods.jpg' });
    const size = await pictureSize(page, photo.base64);
    expect(size).toEqual({ width: 1600, height: 1200 });
  });

  test('an invoice needs its number; cash needs no code', async ({ page }) => {
    const api = emergencyApi({ start: [authorised] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    await page.getByRole('button', { name: /I’ve bought it EP-2026-0004|I’ve bought it/ }).first().click();
    await sheet(page).getByRole('radio', { name: /eTIMS invoice/ }).check({ force: true });
    await sheet(page).getByRole('button', { name: 'I’ve bought it' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Enter the eTIMS invoice number printed on the receipt.');
    await sheet(page).getByLabel('eTIMS invoice number').fill('KRA-0042');
    await sheet(page).getByRole('button', { name: 'I’ve bought it' }).click();
    await expect(sheet(page).getByRole('button', { name: 'Goods arrived' })).toBeVisible();
    expect(api.state.sent.purchased[0]).toMatchObject({ paymentMethod: 'cash', invoiceStatus: 'etims', invoiceNo: 'KRA-0042', prices: [{ lineId: 'el1', price: '1200' }] });
    expect(api.state.sent.purchased[0].paymentReference).toBeUndefined();
    expect(api.state.sent.evidence).toHaveLength(0);
  });
});

test.describe('goods arrived', () => {
  test('records what really arrived and shows the stock that was added', async ({ page }) => {
    const bought = purchase({ status: 'purchased', approvedTotal: '2400.00', actualTotal: '2500.00', invoiceStatus: 'other', invoiceNo: 'R-1', paymentMethod: 'cash' });
    const api = emergencyApi({ start: [bought] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    const card = page.getByRole('listitem').filter({ hasText: 'EP-2026-0004' });
    await expect(card).toContainText('Bought — receive the goods');
    await card.getByRole('button', { name: /Goods arrived/ }).click();
    await expect(sheet(page).getByLabel('Cooking oil arrived', { exact: true })).toHaveValue('2');
    await expect(sheet(page).getByText('You bought 2 kg')).toBeVisible();
    await sheet(page).getByLabel('Cooking oil arrived', { exact: true }).fill('1.5');
    await sheet(page).getByRole('button', { name: 'Goods arrived' }).click();
    await expect(sheet(page).getByText('Added 1.5 kg Cooking oil to your stock')).toBeVisible();
    expect(api.state.sent.receive[0]).toEqual(expect.objectContaining({ lines: [{ lineId: 'el1', qty: '1.5' }] }));
    expect(api.state.sent.evidence).toHaveLength(0);
  });

  test('with no invoice and no photo yet, the photo is asked for first', async ({ page }) => {
    const bought = purchase({ status: 'purchased', approvedTotal: '2400.00', invoiceStatus: 'none', noInvoiceReason: 'Market trader', paymentMethod: 'cash', paymentReference: 'slip 12' });
    const api = emergencyApi({ start: [bought] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    await page.getByRole('button', { name: /Goods arrived EP-2026-0004|Goods arrived/ }).first().click();
    await sheet(page).getByRole('button', { name: 'Goods arrived' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('With no invoice, take a photo of the goods first.');
    expect(api.state.sent.receive).toHaveLength(0);
    await sheet(page).locator('input[type=file]').setInputFiles({ name: 'goods.png', mimeType: 'image/png', buffer: await bigPicture(page, 800, 600) });
    await sheet(page).getByRole('button', { name: 'Goods arrived' }).click();
    await expect(sheet(page).getByText('Added 1.5 kg Cooking oil to your stock')).toBeVisible();
    expect(api.state.sent.evidence).toHaveLength(1);
    expect(api.state.sent.receive).toHaveLength(1);
  });
});

test.describe('other states', () => {
  test('a purchase the owner sent back shows why, and a waiting one can be cancelled', async ({ page }) => {
    const rejected = purchase({ status: 'rejected', approvals: [{ id: 'a', status: 'rejected', decisionNote: 'Buy it at the wholesaler instead' }] });
    const api = emergencyApi({ start: [rejected] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    const card = page.getByRole('listitem').filter({ hasText: 'EP-2026-0004' });
    await expect(card).toContainText('Sent back by the owner');
    await card.getByRole('button', { name: 'Open EP-2026-0004' }).click();
    await expect(sheet(page)).toContainText('The owner said: “Buy it at the wholesaler instead”');
  });

  test('cancelling asks first', async ({ page }) => {
    const api = emergencyApi({ start: [purchase({ status: 'pending_approval' })] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(url);
    await page.getByRole('button', { name: 'Open EP-2026-0004' }).click();
    await sheet(page).getByRole('button', { name: 'Cancel this purchase' }).click();
    expect(api.state.sent.cancel).toHaveLength(0);
    await sheet(page).getByLabel('Why (optional)').fill('Found some in the freezer');
    await sheet(page).getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect.poll(() => api.state.sent.cancel.length).toBe(1);
    expect(api.state.sent.cancel[0]).toMatchObject({ reason: 'Found some in the freezer' });
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 760 } });
  test('the list, the new purchase form and the buying step fit the screen with big buttons', async ({ page }) => {
    await setup(page, { account: managerAccount, extra: emergencyApi({ start: [purchase({ status: 'authorised', approvedTotal: '2400.00' })] }) });
    await page.goto(url);
    await expect(page.getByText('EP-2026-0004 · Mama Njeri Market')).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    expect((await page.getByRole('button', { name: /I’ve bought it EP-2026-0004/ }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole('button', { name: 'New purchase' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: /I’ve bought it EP-2026-0004/ }).click();
    await expect(sheet(page).getByLabel('M-Pesa code')).toHaveCount(0);
    expect(await scrollsSideways(page)).toBe(false);
    for (const button of await sheet(page).getByRole('button', { name: /I’ve bought it|Cancel this purchase/ }).all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await sheet(page).getByRole('radio', { name: /M-Pesa/ }).check({ force: true });
    await expect(sheet(page).getByLabel('M-Pesa code')).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
  });
});
