// Receive goods and returns (P2-15), owner and branch. MOCKED like inventory-purchasing.spec.js: a fake session, /api/me and every
// call answered here; any API path not listed gets a 404.
//   cd frontend && npx playwright test tests/inventory-receiving.spec.js
import { test, expect } from '@playwright/test';
import { API, BRANCH, CHICKEN, GRN, PO, RICE, SUPPLIER, WAREHOUSE, bigPicture, managerAccount, pictureSize, scrollsSideways, setup } from './helpers/inventory-mock';

const supplier = { id: SUPPLIER, name: 'Karibu Poultry', type: 'formal', status: 'active', phone: '254712345678' };
const order = (patch = {}) => ({
  id: PO, number: 'PO-2026-0001', status: 'sent', expectedDate: '2026-11-10', notes: null, selfApproved: false,
  supplier: { id: SUPPLIER, name: 'Karibu Poultry', phone: '254712345678', contactName: 'Wanjiru' }, deliverTo: { id: WAREHOUSE, name: 'Warehouse', kind: 'warehouse' },
  createdBy: 'u', receiving: 'none', receipts: [],
  lines: [
    { id: 'l1', position: 0, itemId: CHICKEN, itemName: 'Chicken', qty: '3', unit: 'crate', unitFactor: '10000', qtyBase: '30000', quantity: '30 kg', receivedBase: '0', received: '0 kg',
      outstandingBase: '30000', outstanding: '30 kg', outstandingInUnit: '3', unitPrice: '6500.00', lineTotal: '19500.00' },
    { id: 'l2', position: 1, itemId: RICE, itemName: 'Rice', qty: '20', unit: 'kg', unitFactor: '1000', qtyBase: '20000', quantity: '20 kg', receivedBase: '0', received: '0 kg',
      outstandingBase: '20000', outstanding: '20 kg', outstandingInUnit: '20', unitPrice: '150.00', lineTotal: '3000.00' },
  ],
  totals: { subtotal: '22500.00', vat: '0.00', total: '22500.00' }, ...patch,
});
const listed = (o) => ({ id: o.id, number: o.number, status: o.status, supplierId: SUPPLIER, supplierName: 'Karibu Poultry', deliverToLocationId: WAREHOUSE, expectedDate: o.expectedDate, lineCount: o.lines.length, total: o.totals.total });
const receipt = (patch = {}) => ({
  id: GRN, number: 'GRN-2026-0001', status: 'posted', location: { id: WAREHOUSE, name: 'Warehouse', kind: 'warehouse' }, supplier: { id: SUPPLIER, name: 'Karibu Poultry' },
  poId: PO, poNumber: 'PO-2026-0001', unplanned: false, unplannedReason: null, receivedAt: '2026-11-18T08:30:00.000Z', deliveryNoteNo: null, invoiceId: null, lines: [
    { id: 'g1', position: 0, poLineId: 'l1', itemId: CHICKEN, itemName: 'Chicken', qty: '2', unit: 'crate', receivedBase: '20000', received: '20 kg', rejectedBase: '10000', rejected: '10 kg', rejectReason: 'Damaged',
      batchNo: null, expiryDate: null, posted: true, returnedBase: '0.0000', costPerUnit: '7800.00', value: '15600.00' },
  ], value: '15600.00', ...patch,
});
const receiptRow = (r) => ({ id: r.id, number: r.number, status: r.status, locationId: WAREHOUSE, supplierId: SUPPLIER, supplierName: 'Karibu Poultry', poId: r.poId, poNumber: r.poNumber, unplanned: !r.poId, lineCount: r.lines.length, receivedAt: r.receivedAt });
const sheet = (page) => page.getByRole('dialog');

/** The owner's receiving endpoints, recording what was sent. */
function receivingApi({ orders = [order()], receipts = [], onReceive, onPost } = {}) {
  const sent = { receive: [], invoice: [], upload: [], reverse: [], returns: [] };
  const handler = async ({ request, pathname, searchParams, method, json }) => {
    if (pathname === `${API}/purchase-orders` && method === 'GET') return json({ orders: orders.map(listed), nextBefore: null });
    if (pathname === `${API}/purchase-orders/${PO}` && method === 'GET') return json({ order: orders[0] });
    if (pathname === `${API}/suppliers` && method === 'GET') return json({ suppliers: [supplier] });
    if (pathname === `${API}/goods-receipts` && method === 'GET') return json({ receipts: receipts.map(receiptRow), nextBefore: null });
    if (pathname === `${API}/goods-receipts` && method === 'POST') {
      const body = request.postDataJSON(); sent.receive.push(body);
      return onReceive ? onReceive(body, sent.receive.length, json) : json({ receipt: receipt(), warnings: [{ code: 'price_variance', message: 'Chicken cost 20% more than the order price on GRN-2026-0001.' }], replayed: false });
    }
    if (pathname === `${API}/goods-receipts/${GRN}` && method === 'GET') return json({ receipt: receipts[0] || receipt() });
    if (pathname === `${API}/goods-receipts/${GRN}/reverse` && method === 'POST') {
      const body = request.postDataJSON(); sent.reverse.push(body);
      return onPost ? onPost('reverse', body, sent.reverse.length, json) : json({ receipt: receipt({ status: 'reversed' }), warnings: [], replayed: false });
    }
    if (pathname === `${API}/supplier-invoices` && method === 'POST') { sent.invoice.push(request.postDataJSON()); return json({ invoice: { id: 'inv1', invoiceStatus: sent.invoice.at(-1).invoiceStatus, invoiceNo: sent.invoice.at(-1).invoiceNo, amount: sent.invoice.at(-1).amount } }); }
    if (pathname === `${API}/attachments` && method === 'POST') { sent.upload.push(request.postDataJSON()); return json({ id: 'att1', name: 'x.jpg' }); }
    if (pathname === `${API}/supplier-returns` && method === 'GET') return json({ returns: [] });
    if (pathname === `${API}/supplier-returns` && method === 'POST') {
      const body = request.postDataJSON(); sent.returns.push(body);
      return json({ return: { id: 'ret1', number: 'RET-2026-0001', status: 'posted', creditTotal: '7800.00', lines: [{ id: 'rl1', qty: '1 crate', itemName: 'Chicken' }] } });
    }
    void searchParams;
    return false;
  };
  handler.sent = sent;
  return handler;
}

test.describe('receive against an order', () => {
  test('lists expected deliveries, then records a partly rejected delivery with a price change and the supplier invoice', async ({ page }) => {
    const api = receivingApi();
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/receive');
    await expect(page.getByRole('heading', { level: 1, name: 'Receive goods' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Expected deliveries' })).toBeVisible();
    await expect(page.getByText('PO-2026-0001 · Karibu Poultry')).toBeVisible();
    await expect(page.getByText('(late)')).toBeVisible();

    await page.getByRole('button', { name: 'Receive PO-2026-0001' }).click();
    await expect(sheet(page).getByText('Step 1 of 2: What arrived')).toBeVisible();
    // Everything still due is filled in, in the unit it was ordered in.
    await expect(sheet(page).getByLabel('Chicken received', { exact: true })).toHaveValue('3');
    await expect(sheet(page).getByLabel('Rice received', { exact: true })).toHaveValue('20');
    await expect(sheet(page).getByText('Ordered 30 kg · still due 30 kg')).toBeVisible();
    // Batch and expiry stay folded away until wanted.
    await expect(sheet(page).getByText('More details (batch, expiry date)').first()).toBeVisible();
    await expect(sheet(page).getByLabel('Batch number').first()).toBeHidden();

    await sheet(page).getByLabel('Chicken received', { exact: true }).fill('2');
    await sheet(page).getByLabel('Chicken rejected', { exact: true }).fill('1');
    // A rejected amount needs its reason.
    await sheet(page).getByRole('button', { name: 'Next: supplier invoice' }).click();
    await expect(sheet(page).getByText('Chicken: say why you rejected some.')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Damaged' }).click();
    await sheet(page).getByLabel('Chicken price').fill('7800');
    await expect(sheet(page).getByText(/20% more than the order price \(Ksh 6,500\)/)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Next: supplier invoice' }).click();

    await expect(sheet(page).getByText('Step 2 of 2: Supplier invoice')).toBeVisible();
    await sheet(page).getByRole('radio', { name: /eTIMS invoice/ }).check({ force: true });
    await sheet(page).getByRole('button', { name: 'Add to stock' }).click();
    await expect(sheet(page).getByText('Enter the invoice number.')).toBeVisible();
    await sheet(page).getByLabel('Invoice number').fill('INV-77');
    await sheet(page).getByRole('textbox', { name: 'eTIMS number' }).fill('ETIMS-991');
    await sheet(page).getByLabel('Invoice total', { exact: true }).fill('16000');
    await sheet(page).getByLabel('VAT', { exact: true }).fill('2206');
    // A big photo is shrunk before it is sent.
    await sheet(page).locator('input[type=file]').setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: await bigPicture(page) });
    await expect(sheet(page).getByAltText('The photo you added')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Add to stock' }).click();

    await expect(sheet(page).getByText('Added 20 kg Chicken to the Warehouse')).toBeVisible();
    await expect(sheet(page).getByText('Rejected 10 kg Chicken (Damaged). It was not added to stock.')).toBeVisible();
    await expect(sheet(page).getByText('Chicken cost 20% more than the order price on GRN-2026-0001.')).toBeVisible();
    await expect(sheet(page).getByText(/Invoice saved: eTIMS invoice INV-77/)).toBeVisible();

    const [received] = api.sent.receive;
    expect(received).toMatchObject({ post: true, poId: PO });
    expect(received.lines).toEqual([
      { poLineId: 'l1', unit: 'crate', receivedQty: '2', rejectedQty: '1', rejectReason: 'Damaged', unitCost: '7800' },
      { poLineId: 'l2', unit: 'kg', receivedQty: '20' },
    ]);
    expect(api.sent.invoice[0]).toMatchObject({ supplierId: SUPPLIER, poId: PO, grnIds: [GRN], invoiceStatus: 'etims', invoiceNo: 'INV-77', etimsInvoiceNo: 'ETIMS-991', amount: '16000', vat: '2206' });
    const upload = api.sent.upload[0];
    expect(upload).toMatchObject({ entityType: 'invoice', entityId: 'inv1', file: { type: 'image/jpeg', name: 'invoice.jpg' } });
    const size = await pictureSize(page, upload.file.base64);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1600);
    expect(size.width).toBe(1600);
  });

  test('over-delivery asks first, and only a yes sends it again with the confirmation', async ({ page }) => {
    const api = receivingApi({ onReceive: (body, n, json) => (body.confirmOverDelivery ? json({ receipt: receipt(), warnings: [{ code: 'over_delivery', message: 'Chicken: 4 crates received, 3 ordered (accepted)' }], replayed: false })
      : json({ error: 'Chicken: you are receiving 40 kg but only 30 kg is still due on PO-2026-0001. That puts the total 33.3% over the order (the allowance is 5%). Check the count, or confirm that you accept the extra.',
        details: { code: 'over_delivery', needsConfirmation: true, items: [] } }, 409)) });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/receive');
    await page.getByRole('button', { name: 'Receive PO-2026-0001' }).click();
    await sheet(page).getByLabel('Chicken received', { exact: true }).fill('4');
    await expect(sheet(page).getByText('That is more than is still due. You will be asked to confirm it.')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Next: supplier invoice' }).click();
    await sheet(page).getByRole('radio', { name: /I’ll add it later/ }).check({ force: true });
    await sheet(page).getByRole('button', { name: 'Add to stock' }).click();
    await expect(sheet(page).getByRole('alert').filter({ hasText: '33.3% over the order' })).toBeVisible();
    expect(api.sent.receive).toHaveLength(1);
    expect(api.sent.receive[0].confirmOverDelivery).toBeUndefined();
    // "Let me check the count" goes back and sends nothing.
    await sheet(page).getByRole('button', { name: 'Let me check the count' }).click();
    await expect(sheet(page).getByText('Step 1 of 2: What arrived')).toBeVisible();
    expect(api.sent.receive).toHaveLength(1);
    await sheet(page).getByRole('button', { name: 'Next: supplier invoice' }).click();
    await sheet(page).getByRole('button', { name: 'Add to stock' }).click();
    await sheet(page).getByRole('button', { name: 'Yes, I accept the extra' }).click();
    await expect(sheet(page).getByText('Added 20 kg Chicken to the Warehouse')).toBeVisible();
    expect(api.sent.receive).toHaveLength(3);
    expect(api.sent.receive[2].confirmOverDelivery).toBe(true);
    // The invoice was left for later, so none was sent.
    expect(api.sent.invoice).toHaveLength(0);
  });
});

test.describe('receive without an order', () => {
  test('needs a supplier and a reason, then sends the items without an order', async ({ page }) => {
    const api = receivingApi();
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/receive');
    await page.getByRole('button', { name: 'Receive without an order' }).click();
    await sheet(page).getByRole('button', { name: 'Next: supplier invoice' }).click();
    await expect(sheet(page).getByText('Choose who delivered it.')).toBeVisible();
    await sheet(page).getByLabel('Who delivered it?').selectOption(SUPPLIER);
    await sheet(page).getByRole('button', { name: 'Next: supplier invoice' }).click();
    await expect(sheet(page).getByText(/Say why there is no order/)).toBeVisible();
    await sheet(page).getByLabel('Why is there no order?').fill('Supplier brought extra');
    await sheet(page).getByLabel('Add what arrived').fill('chick');
    await sheet(page).getByRole('button', { name: /Chicken/ }).click();
    await sheet(page).getByLabel('Chicken received', { exact: true }).fill('5');
    await sheet(page).getByRole('button', { name: 'Next: supplier invoice' }).click();
    await sheet(page).getByRole('radio', { name: /I’ll add it later/ }).check({ force: true });
    await sheet(page).getByRole('button', { name: 'Add to stock' }).click();
    await expect(sheet(page).getByText(/is posted/)).toBeVisible();
    expect(api.sent.receive[0]).toMatchObject({ post: true, supplierId: SUPPLIER, unplannedReason: 'Supplier brought extra', locationId: WAREHOUSE });
    expect(api.sent.receive[0].poId).toBeUndefined();
    expect(api.sent.receive[0].lines).toEqual([{ itemId: CHICKEN, unit: 'kg', receivedQty: '5' }]);
  });
});

test.describe('receipts: reverse and return', () => {
  test('reversing asks for a reason, explains itself and shows a refusal in plain words', async ({ page }) => {
    const api = receivingApi({ receipts: [receipt()], orders: [], onPost: (kind, body, n, json) => (n === 1
      ? json({ error: 'Some of this delivery has already been used, so it can’t be reversed. Chicken: 20 kg came in, only 5 kg is still here.', details: { code: 'cannot_reverse' } }, 409)
      : json({ receipt: receipt({ status: 'reversed' }), warnings: [], replayed: false })) });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/receive');
    await expect(page.getByText('Nothing is on its way')).toBeVisible();
    await page.getByRole('button', { name: 'Open GRN-2026-0001' }).click();
    await expect(sheet(page).getByText('20 kg received')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Reverse this receipt' }).click();
    await expect(sheet(page).getByText(/takes the goods it added back out of stock/)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Yes, reverse this receipt' }).click();
    await expect(sheet(page).getByText('Say why you are reversing this receipt.')).toBeVisible();
    expect(api.sent.reverse).toHaveLength(0);
    await sheet(page).getByLabel('Why are you reversing it?').fill('Entered twice');
    await sheet(page).getByRole('button', { name: 'Yes, reverse this receipt' }).click();
    await expect(sheet(page).getByText(/already been used, so it can’t be reversed/)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Yes, reverse this receipt' }).click();
    await expect(sheet(page).getByRole('button', { name: 'Reverse this receipt' })).toBeVisible();
    expect(api.sent.reverse).toEqual([expect.objectContaining({ reason: 'Entered twice' }), expect.objectContaining({ reason: 'Entered twice' })]);
  });

  test('a return cannot be more than what is still here, and shows the credit', async ({ page }) => {
    const api = receivingApi({ receipts: [receipt()], orders: [] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/receive');
    await page.getByRole('button', { name: 'Open GRN-2026-0001' }).click();
    await sheet(page).getByRole('button', { name: 'Return to supplier' }).click();
    await expect(sheet(page).getByText('Up to 2 crates can still be sent back.')).toBeVisible();
    await sheet(page).getByLabel('Chicken to send back').fill('3');
    await sheet(page).getByLabel('Why?').fill('Spoiled');
    await sheet(page).getByRole('button', { name: 'Send back to supplier' }).click();
    await expect(sheet(page).getByText('Only 2 crates of Chicken can still be sent back.')).toBeVisible();
    expect(api.sent.returns).toHaveLength(0);
    await sheet(page).getByLabel('Chicken to send back').fill('1');
    await expect(sheet(page).getByText(/the credit is what you paid for these goods: Ksh 7,800/)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Send back to supplier' }).click();
    await expect(sheet(page).getByText('Credit from the supplier: Ksh 7,800.')).toBeVisible();
    expect(api.sent.returns[0]).toMatchObject({ grnId: GRN, reason: 'Spoiled', lines: [{ grnLineId: 'g1', qty: '1', unit: 'crate' }] });
  });
});

test.describe('branch manager', () => {
  const expected = { orders: [order({ deliverTo: { id: 'b', name: 'Abdis Test Restaurant', kind: 'branch' } })].map((o) => ({ ...o, lines: o.lines.map(({ unitPrice, lineTotal, ...rest }) => rest), totals: undefined })) };

  test('Stock shows expected deliveries and receives them without prices or invoices', async ({ page }) => {
    const sent = [];
    await setup(page, { account: managerAccount, extra: async ({ request, pathname, method, json }) => {
      if (pathname === '/api/inventory/purchase-orders/expected') return json(expected);
      if (pathname === '/api/inventory/goods-receipts' && method === 'POST') { sent.push(request.postDataJSON()); return json({ receipt: receipt({ location: { id: 'b', name: 'Abdis Test Restaurant', kind: 'branch' } }), warnings: [], replayed: false }); }
      return false;
    } });
    await page.goto(`/branch/${BRANCH}/inventory`);
    await expect(page.getByRole('heading', { name: 'Expected deliveries' })).toBeVisible();
    await page.getByRole('button', { name: 'Receive PO-2026-0001' }).click();
    await expect(sheet(page).getByLabel('Chicken received', { exact: true })).toHaveValue('3');
    await expect(sheet(page).getByLabel('Chicken price')).toHaveCount(0);
    await expect(sheet(page).getByText('Step 1 of 2')).toHaveCount(0);
    await sheet(page).getByLabel('Rice rejected', { exact: true }).fill('2');
    await sheet(page).getByRole('button', { name: 'Other' }).click();
    await sheet(page).getByLabel('What was wrong?').fill('Wet bag');
    await sheet(page).getByRole('button', { name: 'Add to stock' }).click();
    await expect(sheet(page).getByText('Added 20 kg Chicken to Abdis Test Restaurant')).toBeVisible();
    expect(sent[0]).toMatchObject({ post: true, poId: PO });
    expect(sent[0].lines).toEqual([
      { poLineId: 'l1', unit: 'crate', receivedQty: '3' },
      { poLineId: 'l2', unit: 'kg', receivedQty: '20', rejectedQty: '2', rejectReason: 'Wet bag' },
    ]);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 760 } });
  test('the page and the receive sheet fit the screen and buttons are easy to hit', async ({ page }) => {
    await setup(page, { extra: receivingApi({ receipts: [receipt()] }) });
    await page.goto('/owner/inventory/receive');
    await expect(page.getByText('PO-2026-0001 · Karibu Poultry')).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    const receive = page.getByRole('button', { name: 'Receive PO-2026-0001' });
    expect((await receive.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await receive.click();
    await expect(sheet(page).getByLabel('Chicken received', { exact: true })).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    for (const button of await sheet(page).getByRole('button', { name: /Next: supplier invoice|Cancel/ }).all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  });
});
