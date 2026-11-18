// Requests, deliveries and returns (P2-26 owner, P2-27 branch). MOCKED like inventory-receiving.spec.js: a fake session, /api/me and every call
// answered here; any API path not listed gets a 404.
//   cd frontend && npx playwright test tests/inventory-distribution.spec.js
import { test, expect } from '@playwright/test';
import { API, BRANCH, BRANCH_LOCATION, CHICKEN, WAREHOUSE, branchSnapshot, managerAccount, scrollsSideways, setup } from './helpers/inventory-mock';

const REQ = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRF = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRF2 = 'bbbb3333-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DISC = 'dddd4444-dddd-4ddd-8ddd-dddddddddddd';
const OTHER = 'ffff5555-ffff-4fff-8fff-ffffffffffff';
const CODE = 'KQ7M2XPR4T';
const sheet = (page) => page.getByRole('dialog');
/** A sheet moves focus to its first field a frame after it opens; wait for that before typing so it cannot steal focus mid-word. */
const opened = async (page) => {
  await expect(sheet(page)).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

const line = (patch = {}) => ({
  itemId: CHICKEN, name: 'Chicken', unit: 'g', requested: '20000.0000', approved: null, dispatched: '0.0000', received: '0.0000', remaining: null, held: '0.0000', entered: null,
  requestedDisplay: '20 kg', approvedDisplay: null, dispatchedDisplay: '0 g', receivedDisplay: '0 g',
  warehouse: { onHand: '18000.0000', reserved: '0.0000', available: '18000.0000', availableDisplay: '18 kg' }, short: false, ...patch,
});
const request = (patch = {}) => ({
  id: REQ, number: 7, ref: 'REQ-2026-0007', status: 'submitted', kind: 'stock', branchId: BRANCH, branchName: 'Abdis Test Restaurant', priority: 'normal', neededBy: '2026-11-20', note: 'Big booking on Saturday',
  reviewNote: null, needsAttention: false, requestedByName: 'Branch Manager', createdAt: '2026-11-18T07:00:00.000Z', hasRemainder: false, lines: [line()], transfers: [], ...patch,
});
const approved = () => request({ status: 'partially_approved', reviewNote: 'Only 15 until Friday', hasRemainder: true,
  lines: [line({ approved: '15000.0000', approvedDisplay: '15 kg', remaining: '15000.0000', held: '15000.0000' })] });

const noteOf = (patch = {}) => ({ ref: 'TRF-2026-0007', number: 7, code: CODE, qr: { code: CODE, path: `/receive/${CODE}` }, direction: 'out', from: 'Warehouse', to: 'Abdis Test Restaurant',
  dispatchedAt: '2026-11-18T08:00:00.000Z', dispatchedBy: 'Owner Test', driver: 'Juma', vehicle: 'KDA 123A', note: null, requestRef: 'REQ-2026-0007', lines: [{ itemId: CHICKEN, name: 'Chicken', quantity: '10000.0000', display: '10 kg', unit: 'g' }], ...patch });
const transfer = (patch = {}) => ({
  id: TRF, number: 7, ref: 'TRF-2026-0007', direction: 'out', status: 'in_transit', requestId: REQ, requestRef: 'REQ-2026-0007', fromLocationId: WAREHOUSE, fromName: 'Warehouse', fromBranchId: null,
  toLocationId: BRANCH_LOCATION, toName: 'Abdis Test Restaurant', toBranchId: BRANCH, note: null, dispatchedAt: '2026-11-18T08:00:00.000Z', dispatchedByName: 'Owner Test', receivedAt: null, receivedByName: null,
  approvedAt: null, awaitingApproval: false, awaitingDispatch: false, inTransit: true, code: CODE, qr: { code: CODE, path: `/receive/${CODE}` },
  lines: [{ itemId: CHICKEN, name: 'Chicken', unit: 'g', quantity: '20000.0000', received: '0.0000', damaged: '0.0000', over: '0.0000', outstanding: '20000.0000', display: '20 kg', receivedDisplay: '0 g', unitCost: null }],
  discrepancies: [], deliveryNote: noteOf(), approval: null, ...patch,
});
const shortfall = (patch = {}) => ({ id: DISC, itemId: CHICKEN, name: 'Chicken', kind: 'short', quantity: '2000.0000', display: '2 kg', valueKes: null, status: 'open', bearer: null, resolution: null, note: 'Two boxes were missing', createdAt: '2026-11-18T09:00:00.000Z', ...patch });

/** The owner's endpoints. `state` is what the lists answer; `sent` records every write. */
function ownerApi({ inbox = [request()], toSend = [], active = [], received = [], rejected = [], onReview, onDispatch, detail } = {}) {
  const sent = { review: [], prepare: [], dispatch: [], direct: [], cancel: [], resolve: [], request: [] };
  const handler = async ({ request: req, pathname, searchParams, method, json }) => {
    if (pathname === `${API}/requests/inbox`) return json({ requests: inbox, needsAttention: [] });
    if (pathname === `${API}/requests` && method === 'GET') return json({ requests: searchParams.get('status') === 'rejected' ? rejected : toSend, nextBefore: null });
    if (pathname === `${API}/dispatches` && method === 'GET') return json({ transfers: searchParams.get('status') === 'active' ? active : received });
    if (pathname === `${API}/dispatches` && method === 'POST') { const body = req.postDataJSON(); sent.direct.push(body); return json({ transfer: transfer({ id: TRF2, ref: 'TRF-2026-0008', deliveryNote: noteOf({ ref: 'TRF-2026-0008', requestRef: null }) }), request: null }); }
    if (pathname === `${API}/dispatches/${TRF}` && method === 'GET') return json({ transfer: detail || transfer() });
    if (pathname === `${API}/dispatches/${TRF}/cancel`) { sent.cancel.push(req.postDataJSON()); return json({ transfer: transfer({ status: 'cancelled' }) }); }
    if (pathname === `${API}/requests/${REQ}/review`) {
      const body = req.postDataJSON(); sent.review.push(body);
      return onReview ? onReview(body, json) : json({ request: approved() });
    }
    if (pathname === `${API}/requests/${REQ}/prepare`) {
      sent.prepare.push(req.postDataJSON());
      return json({ request: { id: REQ, ref: 'REQ-2026-0007', number: 7, status: 'preparing', branchId: BRANCH, branchName: 'Abdis Test Restaurant' },
        lines: [{ itemId: CHICKEN, name: 'Chicken', qtyBase: '15000.0000', baseUnit: 'g', display: '15 kg', pack: { name: 'crate', factor: '10000', count: '1.50' }, location: 'Cold room / Meat', storage: 'Cold room', category: 'Meat', warehouseOnHand: '18000.0000' }] });
    }
    if (pathname === `${API}/requests/${REQ}/dispatch`) {
      const body = req.postDataJSON(); sent.dispatch.push(body);
      return onDispatch ? onDispatch(body, json) : json({ transfer: transfer(), request: approved() });
    }
    if (pathname === `${API}/discrepancies/${DISC}/resolve`) { sent.resolve.push(req.postDataJSON()); return json({ discrepancy: { id: DISC, status: 'resolved' } }); }
    void req;
    return false;
  };
  handler.sent = sent;
  return handler;
}

test.describe('owner: Requests & transfers', () => {
  test('approves 15 of 20 with a reason, prepares the pick list, sends part of it and gets a delivery note with a QR code', async ({ page }) => {
    const api = ownerApi({ toSend: [approved()] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/requests');
    await expect(page.getByRole('heading', { level: 1, name: 'Requests & transfers' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Waiting for review/ })).toContainText('1');
    await expect(page.getByText('REQ-2026-0007 · Abdis Test Restaurant')).toBeVisible();

    await page.getByRole('button', { name: 'Review REQ-2026-0007' }).click();
    // Filled in with the smaller of what was asked (20 kg) and what the Warehouse has free (18 kg), in kg.
    await expect(sheet(page).getByText('The Warehouse has 18 kg free.')).toBeVisible();
    await expect(sheet(page).getByLabel('Chicken approved', { exact: true })).toHaveValue('18');
    await sheet(page).getByLabel('Chicken approved', { exact: true }).fill('15');
    await expect(sheet(page).getByText('Less than the 20 kg they asked for.')).toBeVisible();
    // Approving less needs a reason.
    await sheet(page).getByRole('button', { name: 'Approve and hold the stock' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Tell the branch why');
    await sheet(page).getByLabel(/Message for the branch/).fill('Only 15 until Friday');
    await sheet(page).getByRole('button', { name: 'Approve and hold the stock' }).click();
    await expect.poll(() => api.sent.review.length).toBe(1);
    const review = api.sent.review[0];
    expect(review).toMatchObject({ decision: 'approve', note: 'Only 15 until Friday', lines: [{ itemId: CHICKEN, approved: '15', unit: 'kg' }] });
    expect(review.commandId).toBeTruthy();

    // To send: prepare (pick list), then send 10 of the 15.
    await expect(page.getByRole('tab', { name: /To send/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Chicken 15 kg of 20 kg')).toBeVisible();
    await page.getByRole('button', { name: 'Prepare REQ-2026-0007' }).click();
    await expect(sheet(page).getByText('Chicken: 15 kg')).toBeVisible();
    await expect(sheet(page).getByText(/Kept in: Cold room \/ Meat/)).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Print the pick list' })).toBeVisible();
    expect(api.sent.prepare).toHaveLength(1);
    await sheet(page).getByRole('button', { name: 'Send it now' }).click();

    await expect(sheet(page).getByLabel('Chicken to send', { exact: true })).toHaveValue('15');
    await sheet(page).getByLabel('Chicken to send', { exact: true }).fill('10');
    await expect(sheet(page).getByText('The rest stays held for Abdis Test Restaurant and can be sent later.')).toBeVisible();
    await sheet(page).getByLabel('Driver').fill('Juma');
    await sheet(page).getByLabel('Vehicle').fill('KDA 123A');
    await sheet(page).getByRole('button', { name: 'Send the delivery' }).click();
    await expect.poll(() => api.sent.dispatch.length).toBe(1);
    expect(api.sent.dispatch[0]).toMatchObject({ lines: [{ itemId: CHICKEN, quantity: '10', unit: 'kg' }], driver: 'Juma', vehicle: 'KDA 123A' });

    // The delivery note: the number, the code, a big QR code, and ways to print or share it.
    await expect(sheet(page).getByText('TRF-2026-0007 is on its way to Abdis Test Restaurant.')).toBeVisible();
    await expect(sheet(page).getByRole('img', { name: `QR code for delivery ${CODE}` }).locator('svg')).toBeVisible();
    await expect(sheet(page).getByText(CODE, { exact: true })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Share' })).toBeVisible();
    const box = await sheet(page).getByRole('img', { name: /QR code/ }).boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(150);
  });

  test('says in plain words when the Warehouse does not have enough, and shows the server’s refusal', async ({ page }) => {
    const short = request({ lines: [line({ warehouse: { onHand: '12000.0000', reserved: '0.0000', available: '12000.0000', availableDisplay: '12 kg' }, short: true })] });
    const api = ownerApi({ inbox: [short], onReview: (body, json) => (body.decision === 'reject' ? json({ request: request({ status: 'rejected' }) }) : json({ error: 'Only 12 kg of Chicken is free at the Warehouse right now. Approve less.', details: { code: 'insufficient_available', itemId: CHICKEN } }, 409)) });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/requests');
    await expect(page.getByText('Not enough in the Warehouse for all of it.')).toBeVisible();
    await page.getByRole('button', { name: 'Review REQ-2026-0007' }).click();
    await expect(sheet(page).getByText(/There is not enough Chicken in the Warehouse for all of this/)).toBeVisible();
    await expect(sheet(page).getByLabel('Chicken approved', { exact: true })).toHaveValue('12');
    await sheet(page).getByLabel('Chicken approved', { exact: true }).fill('0');
    await expect(sheet(page).getByText('None of Chicken will be sent.')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Approve and hold the stock' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Approve at least one item');
    await sheet(page).getByLabel('Chicken approved', { exact: true }).fill('15');
    await sheet(page).getByLabel(/Message for the branch/).fill('Best I can do');
    await sheet(page).getByRole('button', { name: 'Approve and hold the stock' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Only 12 kg of Chicken is free at the Warehouse right now');
    // The other way out: say no, with a reason.
    await sheet(page).getByRole('button', { name: 'Say no to this request' }).click();
    await sheet(page).getByRole('button', { name: 'Turn the request down' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Say why you are saying no');
    await sheet(page).getByLabel('Why are you saying no?').fill('Out of stock until Friday');
    await sheet(page).getByRole('button', { name: 'Turn the request down' }).click();
    await expect.poll(() => api.sent.review.at(-1)?.decision).toBe('reject');
    expect(api.sent.review.at(-1)).toMatchObject({ decision: 'reject', note: 'Out of stock until Friday' });
  });

  test('cancels a delivery on the way after a confirmation', async ({ page }) => {
    const api = ownerApi({ inbox: [], active: [transfer()] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/requests');
    await page.getByRole('tab', { name: /On the way/ }).click();
    await expect(page.getByText(`TRF-2026-0007 · Warehouse to Abdis Test Restaurant`)).toBeVisible();
    await expect(page.getByText(new RegExp(`Code ${CODE}`))).toBeVisible();
    await page.getByRole('button', { name: 'Cancel TRF-2026-0007' }).click();
    await expect(page.getByText('Take TRF-2026-0007 back? The stock goes back to Warehouse.')).toBeVisible();
    expect(api.sent.cancel).toHaveLength(0);
    await page.getByRole('button', { name: 'Not now' }).click();
    expect(api.sent.cancel).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancel TRF-2026-0007' }).click();
    await page.getByRole('button', { name: 'Yes, cancel the delivery' }).click();
    await expect.poll(() => api.sent.cancel.length).toBe(1);
    // The delivery note can be opened again from the list.
    await page.getByRole('button', { name: 'Delivery note TRF-2026-0007' }).click();
    await expect(sheet(page).getByRole('img', { name: `QR code for delivery ${CODE}` })).toBeVisible();
  });

  test('settles a delivery that arrived short: who pays, a note, and a found-it partial', async ({ page }) => {
    const arrived = transfer({ status: 'received', inTransit: false, receivedAt: '2026-11-18T09:00:00.000Z', receivedByName: 'Branch Manager', deliveryNote: null,
      lines: [{ itemId: CHICKEN, name: 'Chicken', unit: 'g', quantity: '20000.0000', received: '18000.0000', damaged: '0.0000', over: '0.0000', outstanding: '0.0000', display: '20 kg', receivedDisplay: '18 kg', unitCost: null }],
      discrepancies: [shortfall()] });
    const api = ownerApi({ inbox: [], received: [arrived], detail: arrived });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/requests');
    await expect(page.getByRole('tab', { name: /Done/ })).toContainText('1');
    await page.getByRole('tab', { name: /Done/ }).click();
    await expect(page.getByText('1 to decide')).toBeVisible();
    await page.getByRole('button', { name: 'Decide TRF-2026-0007' }).click();
    await expect(sheet(page).getByText('Short: 2 kg of Chicken')).toBeVisible();
    await expect(sheet(page).getByText('The branch wrote: “Two boxes were missing”')).toBeVisible();
    // The choices are in plain words.
    for (const text of ['It is really lost', 'Found it: the goods turned up', 'It never left Warehouse']) await expect(sheet(page).getByText(text)).toBeVisible();
    await expect(sheet(page).getByText('Carrier', { exact: true })).toBeVisible();
    await expect(sheet(page).getByText('The transporter pays.')).toBeVisible();
    await expect(sheet(page).getByText('We absorb it at the Warehouse.')).toBeVisible();
    await expect(sheet(page).getByText('The branch (Abdis Test Restaurant) absorbs it.')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Save this decision' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Choose who pays');
    await sheet(page).locator('label', { hasText: 'Carrier' }).click();
    await sheet(page).getByLabel('What happened?').fill('Driver confirmed two boxes fell off');
    await sheet(page).getByRole('button', { name: 'Save this decision' }).click();
    await expect.poll(() => api.sent.resolve.length).toBe(1);
    expect(api.sent.resolve[0]).toMatchObject({ bearer: 'carrier', resolution: 'write_off', note: 'Driver confirmed two boxes fell off' });

    // Found it: no one pays; part of it turned up (1 of 2 kg).
    await sheet(page).locator('label', { hasText: 'Found it: the goods turned up' }).click();
    await expect(sheet(page).getByText('Who pays for it?')).toBeHidden();
    await sheet(page).getByLabel('Chicken that turned up', { exact: true }).fill('1');
    await sheet(page).getByLabel('What happened?').fill('One box found in the van');
    await sheet(page).getByRole('button', { name: 'Save this decision' }).click();
    await expect.poll(() => api.sent.resolve.length).toBe(2);
    expect(api.sent.resolve[1]).toMatchObject({ resolution: 'arrived_later', quantity: '1000', note: 'One box found in the van' });
  });

  test('notification links open the right tab (?tab=problems) and a delivery to count (?receive=)', async ({ page }) => {
    const arrived = transfer({ status: 'received', inTransit: false, deliveryNote: null, discrepancies: [shortfall()] });
    await setup(page, { extra: ownerApi({ inbox: [], received: [arrived], detail: transfer({ toLocationId: WAREHOUSE, toName: 'Warehouse', fromLocationId: BRANCH_LOCATION, fromName: 'Abdis Test Restaurant', direction: 'return' }) }) });
    await page.goto('/owner/inventory/requests?tab=problems');
    await expect(page.getByRole('tab', { name: /Done/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Decide TRF-2026-0007' })).toBeVisible();
    await page.goto(`/owner/inventory/requests?receive=${TRF}`);
    await expect(sheet(page).getByLabel('Chicken arrived in good order', { exact: true })).toHaveValue('20');
  });

  test('sends stock without a request', async ({ page }) => {
    const api = ownerApi({ inbox: [] });
    await setup(page, { extra: api });
    await page.goto('/owner/inventory/requests');
    await page.getByRole('button', { name: 'Send stock without a request' }).click();
    await opened(page);
    await sheet(page).getByLabel('Which branch?').selectOption(BRANCH);
    await sheet(page).getByLabel('What are you sending?').fill('Chick');
    await sheet(page).getByRole('button', { name: 'Chicken' }).click();
    await sheet(page).getByLabel('Chicken to send', { exact: true }).fill('5');
    await sheet(page).getByRole('button', { name: 'Send the delivery' }).click();
    await expect.poll(() => api.sent.direct.length).toBe(1);
    expect(api.sent.direct[0]).toMatchObject({ branchId: BRANCH, lines: [{ itemId: CHICKEN, quantity: '5', unit: 'kg' }] });
    await expect(sheet(page).getByRole('img', { name: /QR code for delivery/ })).toBeVisible();
  });

  test('old ?view=requests links open the new page', async ({ page }) => {
    await setup(page, { extra: ownerApi({ inbox: [] }) });
    await page.goto('/owner/inventory?view=requests');
    await expect(page).toHaveURL(/\/owner\/inventory\/requests$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Requests & transfers' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Requests & transfers' }).first()).toBeVisible();
  });

  test('works at phone width: no sideways scroll and big buttons', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, { extra: ownerApi({ toSend: [approved()] }) });
    await page.goto('/owner/inventory/requests');
    await expect(page.getByRole('button', { name: 'Review REQ-2026-0007' })).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    expect((await page.getByRole('button', { name: 'Review REQ-2026-0007' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'Review REQ-2026-0007' }).click();
    expect(await scrollsSideways(page)).toBe(false);
    for (const button of await sheet(page).getByRole('button', { name: /Approve and hold the stock|Say no to this request/ }).all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  });
});

/* ---------- the branch ---------- */

const snapshotWithHold = () => {
  const snapshot = branchSnapshot();
  snapshot.items[0] = { ...snapshot.items[0], onHand: '5000.0000', heldForOrders: '2000.0000', available: '3000.0000', display: { ...snapshot.items[0].display, heldForOrders: '2 kg', available: '3 kg' } };
  return snapshot;
};

function branchApi({ requests = [], transfers = [], suggestions, held = false, onReceive, onDispatch, siblings = true } = {}) {
  const sent = { ask: [], receive: [], returns: [], move: [], dispatch: [], cancel: [] };
  const handler = async ({ request: req, pathname, method, json }) => {
    if (pathname === '/api/inventory' && held) return json(snapshotWithHold());
    if (pathname === '/api/inventory/requests/suggestions') return json(suggestions || { suggestions: [{ itemId: CHICKEN, name: 'Chicken', unit: 'g', par: '10000.0000', onHand: '2000.0000', held: '0.0000', available: '2000.0000', incoming: '0.0000',
      suggested: '10000.0000', suggestedDisplay: '10 kg', pack: { name: 'crate', factor: '10000' }, avgDailyUse: null, daysCover: null }] });
    if (pathname === '/api/inventory/requests' && method === 'GET') return json({ requests, nextBefore: null });
    if (pathname === '/api/inventory/requests' && method === 'POST') { sent.ask.push(req.postDataJSON()); return json({ request: request({ status: 'submitted' }) }); }
    if (/^\/api\/inventory\/requests\/[^/]+\/cancel$/.test(pathname)) { sent.cancel.push(req.postDataJSON()); return json({ request: request({ status: 'cancelled' }) }); }
    if (pathname === '/api/inventory/transfers' && method === 'GET') return json({ transfers });
    if (pathname === `/api/inventory/transfers/${TRF}` && method === 'GET') return json({ transfer: transfers.find((t) => t.id === TRF) || transfer() });
    if (pathname === `/api/inventory/transfers/${TRF}/receive`) {
      const body = req.postDataJSON(); sent.receive.push(body);
      return onReceive ? onReceive(body, json) : json({ transfer: transfer({ status: 'received', lines: [{ ...transfer().lines[0], received: '17000.0000', receivedDisplay: '17 kg' }] }), closed: true,
        discrepanciesOpened: [{ id: 'x1', itemId: CHICKEN, name: 'Chicken', kind: 'short', quantity: '2000.0000', display: '2 kg' }, { id: 'x2', itemId: CHICKEN, name: 'Chicken', kind: 'damaged', quantity: '1000.0000', display: '1 kg' }] });
    }
    if (pathname === `/api/inventory/transfers/${TRF2}/dispatch`) { sent.dispatch.push(req.postDataJSON()); return onDispatch(json); }
    if (pathname === '/api/inventory/returns') {
      sent.returns.push(req.postDataJSON());
      return json({ transfer: transfer({ id: TRF2, ref: 'TRF-2026-0009', direction: 'return', toName: 'Warehouse', deliveryNote: noteOf({ ref: 'TRF-2026-0009', direction: 'return', from: 'Abdis Test Restaurant', to: 'Warehouse', requestRef: null }) }), pendingApproval: false });
    }
    if (pathname === '/api/inventory/branch-transfers') { sent.move.push(req.postDataJSON()); return json({ transfer: transfer({ id: TRF2, ref: 'TRF-2026-0010', direction: 'branch_to_branch', status: 'pending_approval', awaitingApproval: true, deliveryNote: null }), approvalId: 'ap1' }); }
    if (pathname === '/api/inventory/branches' && siblings) return json({ branches: [{ id: OTHER, name: 'Westlands Branch' }] });
    if (pathname === `/api/inventory/receive/${CODE}`) return json({ transfer: transfer() });
    return false;
  };
  handler.sent = sent;
  return handler;
}
const URL_BRANCH = `/branch/${BRANCH}/inventory/requests`;

test.describe('branch: Requests & deliveries', () => {
  test('asks the Warehouse with suggested amounts and sends the request', async ({ page }) => {
    const api = branchApi();
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(URL_BRANCH);
    await expect(page.getByRole('heading', { level: 1, name: 'Requests & deliveries' })).toBeVisible();
    await page.getByRole('button', { name: 'Ask the Warehouse' }).click();
    await opened(page);
    // The suggestion is one crate (10 kg), with why.
    await expect(sheet(page).getByLabel('Chicken amount', { exact: true })).toHaveValue('1');
    await expect(sheet(page).locator('#ln-' + CHICKEN + '-unit')).toHaveValue('crate');
    await expect(sheet(page).getByText('You keep 10 kg; 2 kg here.')).toBeVisible();
    // Add another item and a note, then send.
    await sheet(page).getByLabel('Add something else').fill('oil');
    await sheet(page).getByRole('button', { name: 'Cooking oil' }).click();
    await sheet(page).getByLabel('Cooking oil amount', { exact: true }).fill('3');
    await sheet(page).getByLabel(/Needed by/).fill('2026-11-25');
    await sheet(page).getByLabel(/Note for the owner/).fill('Big booking');
    await sheet(page).getByRole('button', { name: 'Send request' }).click();
    await expect.poll(() => api.sent.ask.length).toBe(1);
    expect(api.sent.ask[0]).toMatchObject({ note: 'Big booking', neededBy: '2026-11-25', submit: true,
      lines: [{ itemId: CHICKEN, quantity: '1', unit: 'crate' }, { quantity: '3', unit: 'kg' }] });
    await expect(sheet(page).getByText(/was sent to the owner/)).toBeVisible();
  });

  test('shows each request with what was approved and what happens next, and cancels one', async ({ page }) => {
    const api = branchApi({ requests: [approved(), request({ id: 'cccc9999-cccc-4ccc-8ccc-cccccccccccc', ref: 'REQ-2026-0008', status: 'submitted' })] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(URL_BRANCH);
    await expect(page.getByText('Chicken: 15 kg of 20 kg approved')).toBeVisible();
    await expect(page.getByText('The owner approved less than you asked for.')).toBeVisible();
    await expect(page.getByText('The owner said: “Only 15 until Friday”')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel REQ-2026-0008' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect.poll(() => api.sent.cancel.length).toBe(1);
  });

  test('receives a delivery: short and damaged need a note, then the owner is told', async ({ page }) => {
    const api = branchApi({ transfers: [transfer()] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(URL_BRANCH);
    await expect(page.getByText(`TRF-2026-0007 · From Warehouse`)).toBeVisible();
    await page.getByRole('button', { name: 'Receive TRF-2026-0007' }).click();
    // Everything expected is filled in, in kg.
    await expect(sheet(page).getByLabel('Chicken arrived in good order', { exact: true })).toHaveValue('20');
    await sheet(page).getByLabel('Chicken arrived in good order', { exact: true }).fill('17');
    await sheet(page).getByLabel('Chicken damaged', { exact: true }).fill('1');
    await expect(sheet(page).getByText('Chicken: 2 kg short, 1 kg damaged.')).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Confirm what arrived' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Write a note saying what happened');
    expect(api.sent.receive).toHaveLength(0);
    await sheet(page).getByLabel(/^Note/).fill('Two boxes missing, one wet');
    await sheet(page).getByRole('button', { name: 'Confirm what arrived' }).click();
    await expect.poll(() => api.sent.receive.length).toBe(1);
    expect(api.sent.receive[0]).toMatchObject({ note: 'Two boxes missing, one wet', final: true, lines: [{ itemId: CHICKEN, received: '17', damaged: '1', over: '0', unit: 'kg' }] });
    await expect(sheet(page).getByText('Added 17 kg Chicken to this branch')).toBeVisible();
    await expect(sheet(page).getByText('Short: 2 kg of Chicken. The owner was told.')).toBeVisible();
    await expect(sheet(page).getByText('Damaged: 1 kg of Chicken. The owner was told.')).toBeVisible();
  });

  test('"more is coming" saves part of a delivery and keeps it open; too much extra is refused in plain words', async ({ page }) => {
    const api = branchApi({ transfers: [transfer()], onReceive: (body, json) => (body.lines[0].over !== '0'
      ? json({ error: 'Chicken: 3 kg more than was sent is over the 5% extra allowed (1 kg). Count again, or ask the owner.', details: { code: 'over_delivery_too_large' } }, 409)
      : json({ transfer: transfer({ status: 'partially_received', lines: [{ ...transfer().lines[0], received: '10000.0000', receivedDisplay: '10 kg' }] }), closed: false, discrepanciesOpened: [] })) });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(URL_BRANCH);
    await page.getByRole('button', { name: 'Receive TRF-2026-0007' }).click();
    await sheet(page).getByLabel('Chicken arrived in good order', { exact: true }).fill('10');
    // Nothing is short while more is coming, so no note is needed.
    await sheet(page).getByLabel('More is coming: this is only part of the delivery').check();
    await expect(sheet(page).getByText(/short/)).toBeHidden();
    // An over-delivery the server refuses.
    await sheet(page).getByText('Got more than was sent?').click();
    await sheet(page).getByLabel('Chicken extra', { exact: true }).fill('3');
    await sheet(page).getByLabel(/^Note/).fill('Extra bag in the van');
    await sheet(page).getByRole('button', { name: 'Save what arrived' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('over the 5% extra allowed');
    await sheet(page).getByLabel('Chicken extra', { exact: true }).fill('');
    await sheet(page).getByRole('button', { name: 'Save what arrived' }).click();
    await expect.poll(() => api.sent.receive.length).toBe(2);
    expect(api.sent.receive[1]).toMatchObject({ final: false, lines: [{ received: '10', damaged: '0', over: '0', unit: 'kg' }] });
    await expect(sheet(page).getByText(/is partly received/)).toBeVisible();
  });

  test('a QR link (?receive=) opens the receive form; typing the code finds the delivery', async ({ page }) => {
    const api = branchApi({ transfers: [transfer()] });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(`${URL_BRANCH}?receive=${TRF}`);
    await expect(sheet(page).getByLabel('Chicken arrived in good order', { exact: true })).toHaveValue('20');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
    await page.getByLabel(/Have a code from a delivery note/).fill(CODE);
    await page.getByRole('button', { name: 'Find the delivery' }).click();
    await expect(sheet(page).getByLabel('Chicken arrived in good order', { exact: true })).toBeVisible();
    // The old inventory link with ?receive= lands here too.
    await page.goto(`/branch/${BRANCH}/inventory?receive=${TRF}`);
    await expect(page).toHaveURL(new RegExp(`/inventory/requests\\?receive=${TRF}`));
  });

  test('returns stock to the Warehouse, and explains when stock is held for open orders', async ({ page }) => {
    const api = branchApi({ held: true });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(URL_BRANCH);
    await page.getByRole('button', { name: 'Return to the Warehouse' }).click();
    await opened(page);
    await sheet(page).getByLabel('What are you sending?').fill('Chick');
    await expect(sheet(page).getByText('3 kg can leave')).toBeVisible();
    await sheet(page).getByRole('button', { name: /Chicken/ }).click();
    await expect(sheet(page).getByText(/You have 3 kg here that can leave; 2 kg is kept for open orders/)).toBeVisible();
    await sheet(page).getByLabel('Chicken amount', { exact: true }).fill('4');
    await sheet(page).getByLabel('Why is it going back?').fill('Ordered too much');
    await sheet(page).getByRole('button', { name: 'Send back to the Warehouse' }).click();
    await expect(sheet(page).getByRole('alert')).toContainText('Only 3 kg of Chicken can leave here (2 kg is kept for open orders)');
    expect(api.sent.returns).toHaveLength(0);
    await sheet(page).getByLabel('Chicken amount', { exact: true }).fill('2');
    await sheet(page).getByRole('button', { name: 'Send back to the Warehouse' }).click();
    await expect.poll(() => api.sent.returns.length).toBe(1);
    expect(api.sent.returns[0]).toMatchObject({ reason: 'Ordered too much', lines: [{ itemId: CHICKEN, quantity: '2', unit: 'kg' }] });
    await expect(sheet(page).getByText('TRF-2026-0009 is on its way to the Warehouse.')).toBeVisible();
    await expect(sheet(page).getByRole('img', { name: /QR code for delivery/ })).toBeVisible();
  });

  test('asks to move stock to another branch: waiting for the owner, then the refusal when it is held', async ({ page }) => {
    const waiting = transfer({ id: TRF2, ref: 'TRF-2026-0010', direction: 'branch_to_branch', status: 'pending_approval', awaitingApproval: false, awaitingDispatch: true, approvedAt: '2026-11-18T10:00:00.000Z',
      fromLocationId: BRANCH_LOCATION, fromName: 'Abdis Test Restaurant', toLocationId: 'eeee6666-eeee-4eee-8eee-eeeeeeeeeeee', toName: 'Westlands Branch', inTransit: false, deliveryNote: null, code: undefined });
    const api = branchApi({ transfers: [waiting], held: true, onDispatch: (json) => json({ error: 'Only 3 kg of Chicken can leave here (2 kg is held for open orders). Send less, or ask for a smaller transfer.', details: { code: 'insufficient_available' } }, 409) });
    await setup(page, { account: managerAccount, extra: api });
    await page.goto(URL_BRANCH);
    await page.getByRole('button', { name: 'Send to another branch' }).click();
    await opened(page);
    await sheet(page).getByLabel('Which branch gets it?').selectOption(OTHER);
    await sheet(page).getByLabel('What are you sending?').fill('Chick');
    await sheet(page).getByRole('button', { name: /Chicken/ }).click();
    await sheet(page).getByLabel('Chicken amount', { exact: true }).fill('1');
    await sheet(page).getByRole('button', { name: 'Ask the owner to approve' }).click();
    await expect.poll(() => api.sent.move.length).toBe(1);
    expect(api.sent.move[0]).toMatchObject({ toBranchId: OTHER, lines: [{ itemId: CHICKEN, quantity: '1', unit: 'kg' }] });
    await expect(sheet(page).getByText(/TRF-2026-0010 is waiting for the owner to approve it/)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Done' }).click();
    // Approved: the source branch presses Send; the server refuses because the stock is held.
    await expect(page.getByText('The owner approved it. Press Send when the goods leave.')).toBeVisible();
    await page.getByRole('button', { name: 'Send TRF-2026-0010' }).click();
    await expect(page.getByRole('alert')).toContainText('2 kg is held for open orders');
  });

  test('works at phone width: no sideways scroll and big buttons', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, { account: managerAccount, extra: branchApi({ transfers: [transfer()], requests: [approved()] }) });
    await page.goto(URL_BRANCH);
    await expect(page.getByRole('button', { name: 'Receive TRF-2026-0007' })).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    for (const name of ['Receive TRF-2026-0007', 'Ask the Warehouse', 'Return to the Warehouse', 'Send to another branch']) expect((await page.getByRole('button', { name }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'Receive TRF-2026-0007' }).click();
    expect(await scrollsSideways(page)).toBe(false);
    for (const button of await sheet(page).getByRole('button', { name: /Confirm what arrived|Cancel/ }).all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    for (const input of await sheet(page).locator('input[type=number]').all()) expect((await input.boundingBox()).height).toBeGreaterThanOrEqual(44);
  });
});
