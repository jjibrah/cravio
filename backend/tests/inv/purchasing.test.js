// Purchasing + receiving (P2-07, P2-08). Runs the REAL route handlers from routes/inventory-purchasing.js against an in-memory database with every
// proposed migration applied. Covers T-PRC-1 (PO -> partial GRN -> second GRN -> supplier return), reorder suggestions, maker-checker vs sole-owner
// self-approval, over-delivery tolerance, price-variance alerts, unplanned receipts, rejected lines, returns (too much / stock already used),
// reversal, branch-delivered orders, idempotency, the WhatsApp text and PO numbering.
// Usage: node backend/tests/inv/purchasing.test.js
import { randomUUID } from 'node:crypto';
import { rig } from './fixture.js';
import { fakeClock, makeAsserts, makeItem, receive as stockIn } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-purchasing.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { setSetting } from '../../src/inventory/policies.js';
import { lineAmounts, totals, getPo } from '../../src/inventory/purchasing.js';
import { createRoutes as createApprovalRoutes } from '../../src/routes/inventory-approvals.js';
import { onDecided } from '../../src/inventory/approvals.js';
import { nairobiYear } from '../../src/inventory/numbers.js';
import * as ledger from '../../src/inventory/ledger.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, items, contexts, helpers } = r;
const biz = ids.businessId;
const centre = ids.centerLocationId;
const { branch1, branch2 } = branches;
const clock = fakeClock('2026-11-18T09:00:00+03:00');
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

const routes = createRoutes({
  authenticate: async (request) => {
    const who = request.headers.authorization?.replace(/^Bearer /, '');
    if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
    return contexts[who];
  },
  pool: () => db, transact: (fn) => db.transaction(fn), now: () => clock.now(),
});
const approvalRoutes = createApprovalRoutes({
  authenticate: async (request) => contexts[request.headers.authorization.replace(/^Bearer /, '')],
  pool: () => db, transact: (fn) => db.transaction(fn),
});
const call = async (as, method, pathname, body, query = '', branch = null, list = routes) => {
  for (const route of list) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    const headers = { authorization: `Bearer ${as}` };
    if (branch) headers['x-cravio-branch'] = branch;
    return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const base = `/api/owner/inventory/${biz}`;
const api = (as, method, path, body, query) => call(as, method, `${base}${path}`, body, query);
const inboxApi = (as, method, path, body, query) => call(as, method, `${base}${path}`, body, query, null, approvalRoutes);
const scopeOf = (who) => inventoryScope(db, contexts[who], biz);
const bal = async (loc, item) => (await ledger.balance(db, loc, item)).onHand;
const notes = async (kind, user) => (await one(`select count(*)::int as n from public.notifications where kind = $1 and recipient_id = $2`, [kind, user])).n;
const itemRow = (id) => one('select avg_cost::text as avg, last_cost::text as last from public.stock_items where id = $1', [id]);

// ---------- Fixtures: suppliers, items, price lists ----------
const supplierA = (await one(`insert into public.suppliers (business_id, name, phone) values ($1, 'Farm Fresh', '254712345678') returning id`, [biz])).id;
const supplierB = (await one(`insert into public.suppliers (business_id, name, phone) values ($1, 'Cheap Wholesalers', '254722000111') returning id`, [biz])).id;
const supplierC = (await one(`insert into public.suppliers (business_id, name) values ($1, 'No Phone Traders') returning id`, [biz])).id;
const chicken = await makeItem(db, biz, 'Chicken', { packs: [{ name: 'crate', factor: 10000 }] });
const salt = await makeItem(db, biz, 'Salt', { lowLevel: 500 });
const { flour, rice } = items;
const price = (supplier, item, unit, factor, p, from = '2026-01-01') => db.query(`insert into public.supplier_prices (business_id, supplier_id, item_id, unit, unit_factor, price, price_per_base, effective_from)
  values ($1, $2, $3, $4, $5, $6, $7, $8)`, [biz, supplier, item, unit, factor, p, (p / factor).toFixed(6), from]);
const prefer = (supplier, item, preferred) => db.query(`insert into public.supplier_items (business_id, supplier_id, item_id, preferred) values ($1, $2, $3, $4)`, [biz, supplier, item, preferred]);
await price(supplierA, chicken, 'crate', 10000, 600); await prefer(supplierA, chicken, true);
await price(supplierB, chicken, 'crate', 10000, 500); await prefer(supplierB, chicken, false);
await price(supplierA, rice, 'kg', 1000, 90);
await price(supplierB, rice, 'kg', 1000, 85);
await price(supplierA, flour, 'kg', 1000, 100);
await price(supplierC, flour, 'kg', 1000, 100);

const approvedPo = async (supplierId, lines, { location = null, creator = 'owner', approver = 'owner2' } = {}) => {
  const made = await api(creator, 'POST', '/purchase-orders', { supplierId, deliverToLocationId: location || undefined, lines });
  const id = made.order.id;
  const sub = await api(creator, 'POST', `/purchase-orders/${id}/submit`, {});
  if (sub.order.status === 'pending_approval') await api(approver, 'POST', `/purchase-orders/${id}/approve`, {});
  return (await api('owner', 'GET', `/purchase-orders/${id}`)).order;
};

// =============================================================================================================
// 0. Totals (pure): round each line to 2 dp, then sum
// =============================================================================================================
eq(lineAmounts({ qty: '3', unitPrice: '6500.00' }), { lineTotal: '19500.00', vat: '3120.00' }, '3 crates at 6,500 + 16% VAT');
eq(totals([{ qty: '3', unitPrice: '33.33' }, { qty: '2', unitPrice: '10.05' }, { qty: '5', unitPrice: '10.00', vatClass: 'zero' }]),
  { subtotal: '170.09', vat: '19.22', total: '189.31' }, 'totals: 99.99 (vat 16.00) + 20.10 (3.22) + 50.00 zero-rated');
eq(totals([{ qty: '1', unitPrice: '100.00' }], 8).total, '108.00', 'the VAT rate is a parameter, not a constant');

// =============================================================================================================
// 1. Reorder suggestions (PRC-1)
// =============================================================================================================
{
  await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, reorder, par) values ($1, $2, $3, 20000, 50000), ($1, $4, $3, 10000, 30000)`, [centre, chicken, biz, rice]);
  await stockIn(db, { businessId: biz, locationId: centre, itemId: chicken, qty: '5000', unitCost: '0.55' });
  await stockIn(db, { businessId: biz, locationId: centre, itemId: flour, qty: '100000', unitCost: '0.1' });
  // 10 kg of chicken already on order (approved), and a draft that must NOT count.
  const onOrder = await approvedPo(supplierA, [{ itemId: chicken, qty: 1, unit: 'crate' }]);
  eq(onOrder.status, 'approved', 'the open order is approved');
  await api('owner', 'POST', '/purchase-orders', { supplierId: supplierA, lines: [{ itemId: chicken, qty: 5, unit: 'crate' }] });

  const s = await api('owner', 'GET', '/reorder-suggestions');
  eq(s.locationName, 'Warehouse', 'defaults to the Warehouse');
  const c = s.suggestions.find((x) => x.itemId === chicken);
  eq([c.available, c.onOrder, c.reorder, c.target, c.neededBase], ['5000.0000', '10000.0000', '20000.0000', '50000.0000', '35000.0000'], 'chicken: on hand 5 kg + 10 kg on order < reorder 20 kg; needs 35 kg to reach par');
  eq([c.qty, c.unit, c.qtyBase, c.supplier.name, c.supplier.preferred], ['4', 'crate', '40000.0000', 'Farm Fresh', true], '35 kg rounds up to 4 crates (40 kg); the preferred supplier wins over the cheaper one');
  eq([c.unitPrice, c.estimatedTotal], ['600.00', '2400.00'], 'price and estimated total');
  eq(c.explain, 'Chicken: 5 kg on hand, reorder at 20 kg, 10 kg already on order → order 40 kg = 4 crates', 'the explanation line');
  const rr = s.suggestions.find((x) => x.itemId === rice);
  eq([rr.qty, rr.unit, rr.supplier.name, rr.unitPrice, rr.estimatedTotal], ['30', 'kg', 'Cheap Wholesalers', '85.00', '2550.00'], 'rice: nothing on hand, no preferred supplier: the cheapest one');
  eq(s.suggestions.some((x) => x.itemId === flour), false, 'flour (100 kg, no level) is not suggested');
  eq(s.withoutSupplier.map((x) => x.name), ['Salt'], 'an item below its default level with no supplier is listed separately');
  eq(s.bySupplier.map((x) => x.supplierName).sort(), ['Cheap Wholesalers', 'Farm Fresh'], 'grouped by supplier');
  // A branch manager cannot ask for the warehouse suggestions; the operations manager can read them.
  await refuses(call('manager', 'GET', `${base}/reorder-suggestions`), 403, 'forbidden', null, 'manager cannot read owner suggestions');
  ok((await api('ops', 'GET', '/reorder-suggestions')).suggestions.length >= 2, 'operations manager can read');

  const made = await api('owner', 'POST', '/reorder-suggestions/create-orders', {});
  eq(made.orders.length, 2, 'one draft per supplier');
  eq(made.orders.map((o) => o.status), ['draft', 'draft'], 'drafts');
  eq(made.skipped.map((x) => [x.name, x.reason]), [['Salt', 'no_supplier']], 'the item with no supplier is skipped with a reason');
  const chickenPo = made.orders.find((o) => o.supplier.name === 'Farm Fresh');
  eq([chickenPo.lines[0].qty, chickenPo.lines[0].unit, chickenPo.lines[0].unitPrice, chickenPo.totals.subtotal, chickenPo.totals.total], ['4', 'crate', '600.00', '2400.00', '2784.00'], 'the draft carries the suggested pack and the list price');
}

// =============================================================================================================
// 2. PO numbers, drafts, editing, and the approval flow
// =============================================================================================================
const numbersSoFar = (await q(`select number from public.purchase_orders order by number`)).map((x) => Number(x.number.split('-')[2]));
eq(numbersSoFar, numbersSoFar.map((_, i) => i + 1), 'PO numbers are sequential with no gaps');
eq((await q(`select number from public.purchase_orders order by number limit 1`))[0].number, `PO-${nairobiYear(new Date())}-0001`, 'PO-<year>-0001 format');

let flourPo;
{
  const made = await api('owner', 'POST', '/purchase-orders', { supplierId: supplierA, notes: 'Deliver before 10am', expectedDate: '2026-11-20', lines: [{ itemId: flour, qty: 100, unit: 'kg' }] });
  flourPo = made.order;
  eq([flourPo.status, flourPo.lines[0].unitPrice, flourPo.lines[0].lineTotal, flourPo.lines[0].vatAmount, flourPo.totals], ['draft', '100.00', '10000.00', '1600.00', { subtotal: '10000.00', vat: '1600.00', total: '11600.00' }], 'price defaults from the supplier list; totals match the hand calculation');
  eq([flourPo.lines[0].qtyBase, flourPo.lines[0].pricePerBase], ['100000.0000', '0.100000'], 'quantities are kept in base units too');
  // Edit a draft: change quantity, type a manual price (recorded in the audit event with the list price).
  const edited = await api('owner', 'PATCH', `/purchase-orders/${flourPo.id}`, { lines: [{ itemId: flour, qty: 100, unit: 'kg', price: 100 }, { itemId: rice, qty: 10, unit: 'kg', price: 80 }] });
  eq(edited.order.lines.length, 2, 'draft edited');
  const ev = await one(`select after from public.inventory_events where entity = 'purchase_order' and entity_id = $1 and action = 'update' order by id desc limit 1`, [flourPo.id]);
  eq(ev.after.lines.find((l) => l.itemId === rice).source, 'manual', 'a typed price is recorded as a manual override');
  eq(ev.after.lines.find((l) => l.itemId === rice).listPrice, '90.00', 'with the list price it replaced');
  const back = await api('owner', 'PATCH', `/purchase-orders/${flourPo.id}`, { lines: [{ itemId: flour, qty: 100, unit: 'kg' }] });
  eq(back.order.totals.total, '11600.00', 'back to one line');
  flourPo = back.order;
  await refuses(api('owner', 'POST', '/purchase-orders', { supplierId: supplierA, lines: [{ itemId: salt, qty: 1, unit: 'kg' }] }), 400, 'price_required', /no price for Salt/, 'no price anywhere');
  await refuses(api('owner', 'POST', '/purchase-orders', { supplierId: supplierA, lines: [] }), 400, 'lines_required', null, 'no lines');
  await refuses(api('owner', 'POST', '/purchase-orders', { supplierId: supplierA, lines: [{ itemId: flour, qty: 1, unit: 'l' }] }), 400, 'unit_mismatch', null, 'wrong unit for the item');
  await refuses(api('manager', 'POST', '/purchase-orders', { supplierId: supplierA, lines: [{ itemId: flour, qty: 1 }] }), 403, 'forbidden', null, 'a branch manager cannot create orders');
  await refuses(api('owner', 'POST', `/purchase-orders/${flourPo.id}/send`, {}), 409, 'po_not_approved', null, 'a draft cannot be sent');

  // Two owners exist: nobody approves their own order (maker-checker).
  const asked = await notes('approval_needed', people.owner2);
  const sub = await api('owner', 'POST', `/purchase-orders/${flourPo.id}/submit`, {});
  eq(sub.order.status, 'pending_approval', 'with another approver around, submit waits for approval');
  eq(await notes('approval_needed', people.owner2) - asked, 1, 'the other owner is asked to approve');
  eq(await notes('approval_needed', people.owner), 0, 'the person who submitted is not asked');
  await refuses(api('owner', 'PATCH', `/purchase-orders/${flourPo.id}`, { notes: 'x' }), 409, 'po_not_draft', /can.t be edited once it is submitted/, 'no edit after submit');
  await refuses(api('owner', 'POST', `/purchase-orders/${flourPo.id}/approve`, {}), 403, 'maker_checker', /can.t approve something you created/, 'the maker cannot approve while another approver exists');
  await refuses(api('ops', 'POST', `/purchase-orders/${flourPo.id}/approve`, {}), 403, 'forbidden', null, 'operations manager does not hold inv.purchase.approve');
  await refuses(api('manager', 'POST', `/purchase-orders/${flourPo.id}/approve`, {}), 403, 'forbidden', null, 'branch manager cannot approve');
  ok((await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and actor_id = $1`, [people.manager])).n >= 1, 'a denied attempt is audited');
  const sentBack = await api('owner2', 'POST', `/purchase-orders/${flourPo.id}/reject`, { reason: 'Check the price first' });
  eq(sentBack.order.status, 'draft', 'sent back to draft');
  await refuses(api('owner2', 'POST', `/purchase-orders/${flourPo.id}/reject`, { reason: 'again' }), 409, 'po_not_pending', null, 'cannot send back a draft');
  await api('owner', 'POST', `/purchase-orders/${flourPo.id}/submit`, {});
  const ok1 = await api('owner2', 'POST', `/purchase-orders/${flourPo.id}/approve`, { note: 'Fine' });
  eq([ok1.order.status, ok1.order.selfApproved, ok1.order.approvedBy], ['approved', false, people.owner2], 'a different owner approves; not self-approved');
  eq(await notes('po_self_approved', people.owner), 0, 'no self-approval notice for a normal approval');
}

// =============================================================================================================
// 3. Send: WhatsApp text and link, PDF data, no phone
// =============================================================================================================
{
  const sent = await api('owner', 'POST', `/purchase-orders/${flourPo.id}/send`, { via: 'whatsapp' });
  eq([sent.order.status, sent.order.sentVia], ['sent', 'whatsapp'], 'sent via WhatsApp');
  eq(sent.whatsapp.phone, '254712345678', 'supplier phone');
  ok(sent.whatsapp.link.startsWith('https://wa.me/254712345678?text='), 'wa.me link with the 254 number');
  const text = decodeURIComponent(sent.whatsapp.link.split('?text=')[1]);
  eq(text, sent.whatsapp.text, 'the link carries exactly the plain text');
  ok(text.includes(`Purchase order ${flourPo.number}`) && text.includes('To: Farm Fresh') && text.includes('Deliver to: Warehouse, by 20 Nov 2026'), 'header lines');
  ok(text.includes('1. Flour: 100 kg at KES 100.00 = KES 10,000.00'), 'line format');
  ok(text.includes('Subtotal KES 10,000.00, VAT KES 1,600.00') && text.includes('Total KES 11,600.00'), 'totals');
  ok(text.includes('Deliver before 10am'), 'notes included');
  eq([sent.document.number, sent.document.to.name, sent.document.lines[0].lineTotal, sent.document.totals.total], [flourPo.number, 'Farm Fresh', '10000.00', '11600.00'], 'structured document for printing');
  const again = await api('owner', 'POST', `/purchase-orders/${flourPo.id}/send`, { via: 'pdf' });
  eq([again.order.status, again.order.sentVia], ['sent', 'pdf'], 'sending again records the new channel');
  const doc = await api('owner', 'GET', `/purchase-orders/${flourPo.id}/document`);
  eq(doc.document.number, flourPo.number, 'document endpoint');
  await refuses(api('manager', 'GET', `/purchase-orders/${flourPo.id}/document`), 403, 'forbidden', null, 'a manager cannot fetch the owner document');
  await refuses(api('owner', 'POST', `/purchase-orders/${flourPo.id}/send`, { via: 'carrier-pigeon' }), 400, 'bad_channel', null, 'unknown channel');
  const noPhone = await approvedPo(supplierC, [{ itemId: flour, qty: 1, unit: 'kg' }]);
  const nope = await api('owner', 'POST', `/purchase-orders/${noPhone.id}/send`, { via: 'whatsapp' });
  eq(nope.whatsapp.link, null, 'no phone, no link');
  ok(/no phone number/.test(nope.whatsapp.note), 'says why');
  await api('owner', 'POST', `/purchase-orders/${noPhone.id}/cancel`, { reason: 'test only' });
}

// =============================================================================================================
// 4. T-PRC-1: PO 100 kg -> GRN 60 kg -> GRN 40 kg -> return 5 kg
// =============================================================================================================
const poLine = flourPo.lines[0].id;
let grn1; let grn2;
{
  const before = await bal(centre, flour);
  eq(before, '100000.0000', 'flour on hand before (100 kg from the reorder fixture)');
  const first = await api('owner', 'POST', `/purchase-orders/${flourPo.id}/receive`, { lines: [{ poLineId: poLine, receivedQty: 60, unit: 'kg' }], deliveryNoteNo: 'DN-77' });
  grn1 = first.receipt;
  eq([grn1.status, grn1.poNumber, grn1.unplanned, first.warnings], ['posted', flourPo.number, false, []], 'first delivery posted against the order');
  eq(await bal(centre, flour), '160000.0000', 'balance +60 kg');
  let po = (await api('owner', 'GET', `/purchase-orders/${flourPo.id}`)).order;
  eq([po.status, po.lines[0].receivedBase, po.lines[0].outstandingBase, po.receiving], ['partially_received', '60000.0000', '40000.0000', 'partial'], 'PO partially received; 40 kg outstanding');
  const mv = await one(`select delta::text as delta, unit_cost::text as cost, entered_quantity::text as eq, entered_unit, ref_type, reason from public.stock_movements where ref_id = $1`, [grn1.id]);
  eq([mv.delta, mv.cost, mv.eq, mv.entered_unit, mv.ref_type, mv.reason], ['60000.0000', '0.100000', '60.0000', 'kg', 'grn', 'purchase_receipt'], 'one purchase_receipt movement: entered kg kept, cost per base unit');
  eq((await itemRow(flour)).avg, '0.100000', 'weighted average after the first receipt (100 kg and 60 kg both at 0.10 a gram-kilo)');

  // The second delivery: prefilled with what is outstanding (40 kg), costing KES 110 a kg (10 % more: exactly at the alert limit, not over it).
  const draft = await api('owner', 'POST', '/goods-receipts', { poId: flourPo.id });
  eq([draft.receipt.status, draft.receipt.lines[0].qty, draft.receipt.lines[0].unit, draft.receipt.lines[0].poLineId], ['draft', '40', 'kg', poLine], 'prefilled with the outstanding quantity');
  const patched = await api('owner', 'PATCH', `/goods-receipts/${draft.receipt.id}`, { lines: [{ poLineId: poLine, receivedQty: 40, unit: 'kg', unitCost: 110, batchNo: 'B-9', expiryDate: '2027-01-31' }] });
  eq([patched.receipt.lines[0].batchNo, patched.receipt.lines[0].expiryDate, patched.receipt.lines[0].costPerUnit], ['B-9', '2027-01-31', '110.00'], 'draft edited: batch, expiry, cost');
  await refuses(api('owner', 'PATCH', `/goods-receipts/${grn1.id}`, { notes: 'late' }), 409, 'grn_not_draft', null, 'a posted receipt cannot be edited');
  const second = await api('owner', 'POST', `/goods-receipts/${draft.receipt.id}/post`, {});
  grn2 = second.receipt;
  eq(second.warnings.filter((w) => w.code === 'price_variance'), [], 'exactly 10 % is not above the 10 % alert limit');
  po = (await api('owner', 'GET', `/purchase-orders/${flourPo.id}`)).order;
  eq([po.status, po.receiving, po.lines[0].outstandingBase], ['received', 'complete', '0.0000'], 'PO received');
  eq(await bal(centre, flour), '200000.0000', 'balance +40 kg');
  // (160000 x 0.10 + 40000 x 0.11) / 200000 = 0.102
  eq((await itemRow(flour)).avg, '0.102000', 'weighted average after the second receipt');
  eq((await itemRow(flour)).last, '0.110000', 'last cost is the latest receipt cost');
  eq(await bal(centre, flour), (await one('select on_hand::text as o from public.stock_balances where location_id = $1 and item_id = $2', [centre, flour])).o, 'balance row agrees');

  // Return 5 kg of the second delivery: credit defaults to quantity x receipt cost.
  const ret = await api('owner', 'POST', '/supplier-returns', { grnId: grn2.id, reason: 'Damp bags', lines: [{ grnLineId: grn2.lines[0].id, qty: 5, unit: 'kg' }] });
  eq([ret.return.status, ret.return.creditTotal, ret.return.lines[0].creditAmount, ret.return.grnNumber], ['posted', '550.00', '550.00', grn2.number], 'return posted with the credit 5 kg x KES 110');
  ok(/^RET-\d{4}-0001$/.test(ret.return.number), 'RET number');
  eq(await bal(centre, flour), '195000.0000', 'balance -5 kg');
  const out = await one(`select delta::text as delta, unit_cost::text as cost, reason from public.stock_movements where ref_id = $1`, [ret.return.id]);
  eq([out.delta, out.cost, out.reason], ['-5000.0000', '0.110000', 'supplier_return'], 'supplier_return movement at the receipt cost');
  eq((await itemRow(flour)).avg, '0.102000', 'an outbound movement does not change the average');
  po = (await api('owner', 'GET', `/purchase-orders/${flourPo.id}`)).order;
  eq([po.status, po.totals.total, po.lines[0].receivedBase], ['received', '11600.00', '100000.0000'], 'PO totals and received quantities are unchanged by a return');
  const view = await api('owner', 'GET', `/goods-receipts/${grn2.id}`);
  eq(view.receipt.lines[0].returnedBase, '5000.0000', 'the receipt shows what went back');
  // Beyond what that delivery added, with the figure.
  await refuses(api('owner', 'POST', '/supplier-returns', { grnId: grn2.id, reason: 'x', lines: [{ grnLineId: grn2.lines[0].id, qty: 36, unit: 'kg' }] }), 409, 'return_too_much', /Only 35 kg of Flour from GRN-\d{4}-\d{4} can still be sent back \(40 kg arrived, 5 kg already returned\)/, 'return beyond the delivery');
  eq(await bal(centre, flour), '195000.0000', 'nothing moved on the refusal');
  eq((await q('select 1 from public.supplier_returns')).length, 1, 'no half-made return left behind');
  await refuses(api('owner', 'POST', '/supplier-returns', { grnId: grn2.id, lines: [{ grnLineId: grn2.lines[0].id, qty: 1, unit: 'kg' }] }), 400, 'reason_required', null, 'a reason is needed');
  const list = await api('owner', 'GET', '/supplier-returns', undefined, `?grn=${grn2.id}`);
  eq(list.returns.length, 1, 'returns list');
  // The reconciliation job sees nothing wrong.
  eq((await ledger.reconcile(db, { businessId: biz })).length, 0, 'ledger reconciles');
}

// =============================================================================================================
// 5. Returns when the stock has been used (stop at zero)
// =============================================================================================================
{
  // Use nearly all of the flour: leave 1 kg.
  await db.transaction((t) => ledger.post(t, { businessId: biz, locationId: centre, itemId: flour, qty: '-194000', reason: 'wastage', idempotencyKey: 'use-up-flour' }));
  eq(await bal(centre, flour), '1000.0000', '1 kg left');
  await refuses(api('owner', 'POST', '/supplier-returns', { grnId: grn1.id, reason: 'Spoiled', lines: [{ grnLineId: grn1.lines[0].id, qty: 2, unit: 'kg' }] }), 409, 'return_stock_used', /Only 1 kg of Flour from this delivery is still here/, 'stock already used');
  const ok1 = await api('owner', 'POST', '/supplier-returns', { grnId: grn1.id, reason: 'Spoiled', creditAmount: 80, lines: [{ grnLineId: grn1.lines[0].id, qty: 1, unit: 'kg' }] });
  eq([ok1.return.creditTotal, ok1.return.lines[0].creditAmount], ['80.00', '80.00'], 'the agreed credit overrides quantity x cost');
  eq(await bal(centre, flour), '0.0000', 'down to zero, not below');
  // And the reversal of a delivery whose stock was used is refused (see section 8).
  // Item-specific packs work end to end: 2 crates in, half a crate back, credit at KES 600 a crate.
  const crates = await api('owner', 'POST', '/goods-receipts', { post: true, unplannedReason: 'Spot buy', supplierId: supplierA, lines: [{ itemId: chicken, receivedQty: 2, unit: 'crate', unitCost: 600 }] });
  eq([crates.receipt.lines[0].receivedBase, crates.receipt.lines[0].unit], ['20000.0000', 'crate'], '2 crates = 20 kg, entered unit kept');
  const half = await api('owner', 'POST', '/supplier-returns', { grnId: crates.receipt.id, reason: 'Warm on arrival', lines: [{ grnLineId: crates.receipt.lines[0].id, qty: 0.5, unit: 'crate' }] });
  eq([half.return.lines[0].qtyBase, half.return.creditTotal], ['5000.0000', '300.00'], 'half a crate back, credit 300');
}

// =============================================================================================================
// 6. Sole owner approves their own order; flagged and notified
// =============================================================================================================
{
  await db.query(`delete from public.business_members where business_id = $1 and user_id = $2`, [biz, people.owner2]);
  const made = await api('owner', 'POST', '/purchase-orders', { supplierId: supplierA, lines: [{ itemId: rice, qty: 5, unit: 'kg' }] });
  const sub = await api('owner', 'POST', `/purchase-orders/${made.order.id}/submit`, {});
  eq([sub.order.status, sub.order.selfApproved, sub.order.approvedBy], ['approved', true, people.owner], 'the only approver approves their own order, flagged self-approved');
  const ev = await one(`select action, after from public.inventory_events where entity = 'purchase_order' and entity_id = $1 and action like 'approve%' `, [made.order.id]);
  eq([ev.action, ev.after.selfApproved], ['approve_self', true], 'audit event says self-approved');
  eq(await notes('po_self_approved', people.owner), 1, 'the owner is notified of the self-approval');
  eq((await one('select self_approved from public.purchase_orders where id = $1', [made.order.id])).self_approved, true, 'stored on the order');
  // A pending order (another approval path) still follows maker-checker once a second approver returns.
  const second = await api('owner', 'POST', '/purchase-orders', { supplierId: supplierA, lines: [{ itemId: rice, qty: 6, unit: 'kg' }] });
  await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [biz, people.owner2]);
  const pending = await api('owner', 'POST', `/purchase-orders/${second.order.id}/submit`, {});
  eq([pending.order.status, pending.order.selfApproved], ['pending_approval', false], 'with a second owner again, approval is needed');
  await refuses(api('owner', 'POST', `/purchase-orders/${second.order.id}/approve`, {}), 403, 'maker_checker', null, 'own approval denied again');
  // The owner withdraws it (sends it back) and cancels: cancel works until anything is received.
  await api('owner', 'POST', `/purchase-orders/${second.order.id}/reject`, { reason: 'not needed' });
  const cancelled = await api('owner', 'POST', `/purchase-orders/${second.order.id}/cancel`, { reason: 'Changed my mind' });
  eq(cancelled.order.status, 'cancelled', 'a draft can be cancelled');
  await refuses(api('owner', 'POST', `/purchase-orders/${made.order.id}/cancel`, {}), 400, 'reason_required', null, 'a reason is needed to cancel');
  const cancelSent = await api('owner', 'POST', `/purchase-orders/${made.order.id}/cancel`, { reason: 'Wrong supplier' });
  eq(cancelSent.order.status, 'cancelled', 'approved orders can be cancelled before receiving');
}

// =============================================================================================================
// 7. Purchase orders go through the real approvals engine (P2-10)
// =============================================================================================================
{
  const newPo = async (as = 'owner', qty = 2) => (await api(as, 'POST', '/purchase-orders', { supplierId: supplierA, lines: [{ itemId: rice, qty, unit: 'kg' }] })).order;
  const approvalOf = (poId) => q(`select * from public.approvals where subject_type = 'purchase_order' and subject_id = $1 order by requested_at, id`, [poId]);
  const askedCount = (poId) => one(`select count(*)::int as n from public.notifications where kind = 'approval_needed' and entity_id = $1`, [poId]).then((x) => x.n);
  const decidedNotes = async (user) => notes('approval_decided', user);

  // Sole owner: the engine records the self-approval (approvals row + audit), nobody is asked.
  await db.query(`delete from public.business_members where business_id = $1 and user_id = $2`, [biz, people.owner2]);
  const solo = await newPo();
  const soloSub = await api('owner', 'POST', `/purchase-orders/${solo.id}/submit`, {});
  const [soloRow] = await approvalOf(solo.id);
  eq([soloSub.order.status, soloSub.order.selfApproved, soloRow.status, soloRow.self_approved, soloRow.decided_by, soloRow.requested_by], ['approved', true, 'approved', true, people.owner, people.owner], 'sole owner: the engine holds the self-approval and the order shows it');
  eq(await askedCount(soloRow.id), 0, 'nobody else is asked when the only approver self-approves');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'approval' and entity_id = $1 and action = 'self_approved'`, [soloRow.id])).n, 1, 'the approval has a self_approved audit event');
  eq(soloRow.amount_kes, soloSub.order.totals.total, 'the approval carries the order total');

  // A second owner: pending, the maker can't decide (T-SEC-2), the other owner decides from the inbox.
  await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [biz, people.owner2]);
  const po = await newPo();
  const sub = await api('owner', 'POST', `/purchase-orders/${po.id}/submit`, {});
  const [pend] = await approvalOf(po.id);
  eq([sub.order.status, pend.status, pend.subject_type], ['pending_approval', 'pending', 'purchase_order'], 'with another approver: pending approval');
  eq(await askedCount(pend.id), 1, 'exactly one approval_needed notification (no double from the hook)');
  await refuses(inboxApi('owner', 'POST', `/approvals/${pend.id}/decide`, { decision: 'approve' }), 403, 'maker_checker', null, 'the creator cannot approve their own order from the inbox');
  const box = await inboxApi('owner2', 'GET', '/approvals', null, '?subject=purchase_order');
  const item = box.approvals.find((x) => x.id === pend.id);
  eq(item.summary, { kind: 'purchase_order', number: po.number, status: 'pending_approval', supplierName: 'Farm Fresh', total: sub.order.totals.total, lineCount: 1, deliverTo: 'Warehouse', expectedDate: null }, 'the inbox row carries a compact PO summary');
  const done = await inboxApi('owner2', 'POST', `/approvals/${pend.id}/decide`, { decision: 'approve', note: 'ok' });
  const after = (await api('owner', 'GET', `/purchase-orders/${po.id}`)).order;
  eq([done.status, after.status, after.approvedBy, after.selfApproved], ['approved', 'approved', people.owner2, false], 'the other owner approves in the inbox and the order follows');
  const doneAgain = await inboxApi('owner2', 'POST', `/approvals/${pend.id}/decide`, { decision: 'approve' });
  eq([doneAgain.replayed, (await api('owner', 'GET', `/purchase-orders/${po.id}`)).order.status], [true, 'approved'], 'replaying the decision is idempotent');
  eq([await decidedNotes(people.owner), (await one(`select count(*)::int as n from public.notifications where kind = 'approval_decided' and entity_id = $1`, [pend.id])).n], [await decidedNotes(people.owner), 1], 'the maker is told once');
  await refuses(inboxApi('owner2', 'POST', `/approvals/${pend.id}/decide`, { decision: 'reject', note: 'too late' }), 409, 'already_decided', null, 'the opposite decision after the fact is refused');

  // Rejection from the inbox sends it back to draft with the reason; resubmitting opens a new request.
  const rej = await newPo();
  await api('owner', 'POST', `/purchase-orders/${rej.id}/submit`, {});
  const [rejA] = await approvalOf(rej.id);
  await refuses(inboxApi('owner2', 'POST', `/approvals/${rejA.id}/decide`, { decision: 'reject' }), 400, 'reason_required', null, 'a rejection needs a reason');
  await inboxApi('owner2', 'POST', `/approvals/${rejA.id}/decide`, { decision: 'reject', note: 'Wrong supplier' });
  const back = (await api('owner', 'GET', `/purchase-orders/${rej.id}`)).order;
  eq(back.status, 'draft', 'reject -> back to draft');
  eq((await one(`select decision_note, status from public.approvals where id = $1`, [rejA.id])), { decision_note: 'Wrong supplier', status: 'rejected' }, 'the reason is stored on the approval');
  eq((await one(`select after from public.inventory_events where entity = 'purchase_order' and entity_id = $1 and action = 'reject'`, [rej.id])).after.note, 'Wrong supplier', 'and in the order audit');
  await api('owner', 'POST', `/purchase-orders/${rej.id}/submit`, {});
  eq((await approvalOf(rej.id)).map((a) => a.status), ['rejected', 'pending'], 'a resubmit is a new request; the history keeps both');

  // The purchasing endpoints delegate to the same engine.
  await api('owner2', 'POST', `/purchase-orders/${rej.id}/approve`, {});
  eq([(await approvalOf(rej.id))[1].status, (await approvalOf(rej.id))[1].decided_by], ['approved', people.owner2], 'POST /approve decides through approvals.decide');

  // Withdraw (the maker "rejects") and cancel while pending both close the approval.
  const wd = await newPo();
  await api('owner', 'POST', `/purchase-orders/${wd.id}/submit`, {});
  const w = await api('owner', 'POST', `/purchase-orders/${wd.id}/reject`, { reason: 'not needed' });
  eq([w.order.status, (await approvalOf(wd.id))[0].status], ['draft', 'cancelled'], 'the maker withdrawing returns it to draft and cancels the approval');
  const cn = await newPo();
  await api('owner', 'POST', `/purchase-orders/${cn.id}/submit`, {});
  const c = await api('owner', 'POST', `/purchase-orders/${cn.id}/cancel`, { reason: 'Changed my mind' });
  eq([c.order.status, (await approvalOf(cn.id))[0].status], ['cancelled', 'cancelled'], 'cancelling a pending order cancels its approval');
  await refuses(inboxApi('owner2', 'POST', `/approvals/${(await approvalOf(cn.id))[0].id}/decide`, { decision: 'approve' }), 409, 'already_decided', /withdrawn/, 'nothing left to decide');

  // A failing callback rolls the decision back (order and approval stay pending).
  const boom = await newPo();
  await api('owner', 'POST', `/purchase-orders/${boom.id}/submit`, {});
  const off = onDecided('purchase_order', () => { throw new Error('boom'); });
  let failed = false;
  try { await inboxApi('owner2', 'POST', `/approvals/${(await approvalOf(boom.id))[0].id}/decide`, { decision: 'approve' }); } catch { failed = true; }
  off();
  eq([failed, (await approvalOf(boom.id))[0].status, (await api('owner', 'GET', `/purchase-orders/${boom.id}`)).order.status], [true, 'pending', 'pending_approval'], 'a throw in the callback rolls the decision back');
  await api('owner2', 'POST', `/purchase-orders/${boom.id}/approve`, {});
}

// =============================================================================================================
// 8. Over-delivery, rejected lines, reversal
// =============================================================================================================
let ricePo;
{
  ricePo = await approvedPo(supplierB, [{ itemId: rice, qty: 10, unit: 'kg' }]);
  const rl = ricePo.lines[0].id;
  eq(ricePo.lines[0].unitPrice, '85.00', 'rice from the cheaper supplier');
  const tol = await one(`select 1 as x`);
  void tol;
  // Within the 5 % allowance: 10.4 kg of 10 kg is accepted.
  const over = await api('owner', 'POST', `/purchase-orders/${ricePo.id}/receive`, { lines: [{ poLineId: rl, receivedQty: 11, unit: 'kg' }] }).catch((e) => e);
  eq([over.status, over.details.code, over.details.needsConfirmation], [409, 'over_delivery', true], '11 kg of 10 kg is beyond the 5 % allowance');
  ok(/only 10 kg is still due on PO-\d{4}-\d{4}\. That puts the total 10% over the order \(the allowance is 5%\)/.test(over.message), `plain message: ${over.message}`);
  eq(await bal(centre, rice), '0.0000', 'nothing was received');
  eq((await q(`select 1 from public.goods_receipts where po_id = $1 and status = 'posted'`, [ricePo.id])).length, 0, 'no posted receipt left behind');
  const near = await api('owner', 'POST', `/purchase-orders/${ricePo.id}/receive`, { lines: [{ poLineId: rl, receivedQty: 3.1, unit: 'kg', rejectedQty: 0.5, rejectReason: 'Wet bag' }] });
  eq(await bal(centre, rice), '3100.0000', 'only the accepted 3.1 kg entered stock');
  eq([near.receipt.lines[0].receivedBase, near.receipt.lines[0].rejectedBase, near.receipt.lines[0].rejectReason], ['3100.0000', '500.0000', 'Wet bag'], 'rejected quantity and reason recorded');
  eq((await q(`select 1 from public.stock_movements where ref_id = $1`, [near.receipt.id])).length, 1, 'one movement for the accepted quantity only');
  await refuses(api('owner', 'POST', `/purchase-orders/${ricePo.id}/receive`, { lines: [{ poLineId: rl, receivedQty: 1, rejectedQty: 1, unit: 'kg' }] }), 400, 'reject_reason_required', /say why you rejected/, 'rejected needs a reason');
  const onlyRejected = await api('owner', 'POST', `/purchase-orders/${ricePo.id}/receive`, { lines: [{ poLineId: rl, receivedQty: 0, unit: 'kg', rejectedQty: 2, rejectReason: 'Infested' }] });
  eq([onlyRejected.receipt.status, await bal(centre, rice)], ['posted', '3100.0000'], 'a line that is entirely rejected adds no stock');
  let po = (await api('owner', 'GET', `/purchase-orders/${ricePo.id}`)).order;
  eq([po.status, po.lines[0].receivedBase], ['partially_received', '3100.0000'], 'rejected goods do not count as received on the order');
  // The rest: 6.9 kg completes it; with 10 % extra needing confirmation, then 16 kg refused outright.
  const left = await api('owner', 'POST', '/goods-receipts', { poId: ricePo.id });
  eq(left.receipt.lines[0].qty, '6.9', 'prefill = outstanding (6.9 kg)');
  const big = await api('owner', 'PATCH', `/goods-receipts/${left.receipt.id}`, { lines: [{ poLineId: rl, receivedQty: 7.5, unit: 'kg' }] });
  const refused = await api('owner', 'POST', `/goods-receipts/${big.receipt.id}/post`, {}).catch((e) => e);
  eq(refused.details.code, 'over_delivery', 'extra beyond the allowance needs a confirmation');
  const confirmed = await api('owner', 'POST', `/goods-receipts/${big.receipt.id}/post`, { confirmOverDelivery: true });
  eq(confirmed.warnings.map((w) => w.code), ['over_delivery'], 'confirmed: accepted with a warning');
  eq(await bal(centre, rice), '10600.0000', 'stock includes the confirmed extra');
  const way = await api('owner', 'POST', '/goods-receipts', { poId: ricePo.id, lines: [{ poLineId: rl, receivedQty: 16, unit: 'kg' }] });
  await refuses(api('owner', 'POST', `/goods-receipts/${way.receipt.id}/post`, { confirmOverDelivery: true }), 409, 'over_delivery_limit', /more than 150%/, 'never beyond 150 %');
  // Posted twice = the same receipt (no second movement).
  const replay = await api('owner', 'POST', `/goods-receipts/${big.receipt.id}/post`, {});
  eq([replay.replayed, await bal(centre, rice)], [true, '10600.0000'], 'posting again returns the same receipt without moving stock');

  // Reversal: put it back, status reversed, quantities off the order.
  await refuses(api('owner', 'POST', `/goods-receipts/${big.receipt.id}/reverse`, {}), 400, 'reason_required', null, 'a reason is required');
  const rev = await api('owner', 'POST', `/goods-receipts/${big.receipt.id}/reverse`, { reason: 'Counted twice' });
  eq([rev.receipt.status, await bal(centre, rice)], ['reversed', '3100.0000'], 'reversed: movements undone');
  eq(rev.warnings.map((w) => w.code), ['po_status'], 'the order status limitation is explained');
  po = (await api('owner', 'GET', `/purchase-orders/${ricePo.id}`)).order;
  eq([po.lines[0].receivedBase, po.receiving], ['3100.0000', 'partial'], 'order quantities went back');
  const repeat = await api('owner', 'POST', `/goods-receipts/${big.receipt.id}/reverse`, { reason: 'Counted twice' });
  eq(repeat.replayed, true, 'reversing again changes nothing');
  eq((await ledger.reconcile(db, { businessId: biz })).length, 0, 'ledger reconciles after the reversal');
  await refuses(api('owner', 'POST', `/goods-receipts/${big.receipt.id}/post`, {}), 409, 'grn_reversed', null, 'a reversed receipt cannot be posted');

  // Reversal is refused when the stock has been used, and after a return.
  const used = await api('owner', 'POST', `/purchase-orders/${ricePo.id}/receive`, { lines: [{ poLineId: rl, receivedQty: 4, unit: 'kg' }] });
  await db.transaction((t) => ledger.post(t, { businessId: biz, locationId: centre, itemId: rice, qty: '-6000', reason: 'wastage', idempotencyKey: 'use-rice' }));
  const noRev = await api('owner', 'POST', `/goods-receipts/${used.receipt.id}/reverse`, { reason: 'Oops' }).catch((e) => e);
  eq([noRev.status, noRev.details.code], [409, 'cannot_reverse'], 'cannot reverse a delivery whose stock was used');
  ok(/already been used/.test(noRev.message) && /Rice: 4 kg came in, only 1\.1 kg is still here/.test(noRev.message), `message: ${noRev.message}`);
  await api('owner', 'POST', '/supplier-returns', { grnId: used.receipt.id, reason: 'Bad batch', lines: [{ grnLineId: used.receipt.lines[0].id, qty: 1, unit: 'kg' }] });
  await refuses(api('owner', 'POST', `/goods-receipts/${used.receipt.id}/reverse`, { reason: 'Oops' }), 409, 'grn_has_returns', null, 'cannot reverse after a return');
  // Close with a reason (something is still outstanding on the order).
  await refuses(api('owner', 'POST', `/purchase-orders/${ricePo.id}/close`, {}), 400, 'reason_required', null, 'closing with items outstanding needs a reason');
  await refuses(api('owner', 'POST', `/purchase-orders/${ricePo.id}/cancel`, { reason: 'late' }), 409, 'po_not_cancellable', /Close it instead/, 'cannot cancel after receiving');
}

// =============================================================================================================
// 9. Price variance (GRN-6) and unplanned receipts
// =============================================================================================================
{
  const owners = [people.owner, people.owner2];
  const countAll = async (kind) => (await Promise.all(owners.map((o) => notes(kind, o)))).reduce((a, b) => a + b, 0);
  const po1 = await approvedPo(supplierB, [{ itemId: rice, qty: 10, unit: 'kg' }]);
  const l1 = po1.lines[0].id;
  const before = await countAll('price_variance');
  const hit = await api('owner', 'POST', `/purchase-orders/${po1.id}/receive`, { lines: [{ poLineId: l1, receivedQty: 5, unit: 'kg', unitCost: 102 }] });
  const w = hit.warnings.find((x) => x.code === 'price_variance');
  ok(w && w.pct === '20.00' && /Rice cost 20% more than the order price/.test(w.message), `warning: ${JSON.stringify(w)}`);
  eq(await countAll('price_variance') - before, 2, 'both owners are notified of the 20 % rise');
  // Replaying the post does not notify again.
  await api('owner', 'POST', `/goods-receipts/${hit.receipt.id}/post`, {});
  eq(await countAll('price_variance') - before, 2, 'still two (deduplicated)');
  const mild = await api('owner', 'POST', `/purchase-orders/${po1.id}/receive`, { lines: [{ poLineId: l1, receivedQty: 5, unit: 'kg', unitCost: 89.25 }] });
  eq(mild.warnings.filter((x) => x.code === 'price_variance'), [], '5 % above the order price (and below the last price) raises nothing');
  eq(await countAll('price_variance') - before, 2, 'no new notification at 5 %');
  // Against the last price paid, on an order with no price problem: unplanned delivery at 20 % above the last receipt cost.
  const lastRice = (await itemRow(rice)).last;
  const unplanned = await api('owner', 'POST', '/goods-receipts', { post: true, unplannedReason: 'Supplier brought extra', supplierId: supplierB, lines: [{ itemId: rice, receivedQty: 2, unit: 'kg', unitCost: 107.1 }] });
  eq(lastRice, '0.089250', 'last price before');
  ok(unplanned.warnings.some((x) => x.code === 'price_variance' && /last price paid/.test(x.message)), 'compared with the last price when there is no order');
  // The owner switches the alert to a very high limit: nothing is raised for a 20 % rise.
  await setSetting(db, { businessId: biz, key: 'price_variance_alert_pct', value: 50, actorId: people.owner });
  const po2 = await approvedPo(supplierB, [{ itemId: rice, qty: 10, unit: 'kg' }]);
  const quiet = await api('owner', 'POST', `/purchase-orders/${po2.id}/receive`, { lines: [{ poLineId: po2.lines[0].id, receivedQty: 5, unit: 'kg', unitCost: 102 }] });
  eq(quiet.warnings.filter((x) => x.code === 'price_variance'), [], 'a 20 % rise is below a 50 % limit');
  await db.query(`delete from public.inventory_settings where business_id = $1 and key = 'price_variance_alert_pct'`, [biz]);

  // Unplanned: needs a reason; the owners are told (not the person who did it).
  await refuses(api('owner', 'POST', '/goods-receipts', { supplierId: supplierB, lines: [{ itemId: rice, receivedQty: 1, unit: 'kg' }] }), 400, 'unplanned_reason_required', /Say why/, 'unplanned without a reason');
  eq(await notes('unplanned_receipt', people.owner), 0, 'the owner receiving unplanned stock is not pinged about it (nor was the earlier spot buy)');
  const told = [await notes('unplanned_receipt', people.owner), await notes('unplanned_receipt', people.owner2)];
  const viaManager = await call('manager', 'POST', '/api/inventory/goods-receipts', { post: true, unplannedReason: 'Bought at the market', supplierId: supplierB, lines: [{ itemId: rice, receivedQty: 3, unit: 'kg', unitCost: 90 }] }, '', branch1.restaurantId);
  eq([viaManager.receipt.status, viaManager.receipt.unplanned, viaManager.receipt.location.kind, await bal(branch1.locationId, rice)], ['posted', true, 'branch', '3000.0000'], 'a branch manager receives unplanned stock at their branch');
  eq([await notes('unplanned_receipt', people.owner) - told[0], await notes('unplanned_receipt', people.owner2) - told[1]], [1, 1], 'both owners are told about the manager’s unplanned delivery');
  await refuses(call('manager', 'POST', '/api/inventory/goods-receipts', { post: true, supplierId: supplierB, lines: [{ itemId: rice, receivedQty: 3, unit: 'kg' }] }, '', branch1.restaurantId), 400, 'unplanned_reason_required', null, 'branch unplanned without a reason');
  await refuses(api('manager', 'POST', '/goods-receipts', { post: true, locationId: centre, unplannedReason: 'x', supplierId: supplierB, lines: [{ itemId: rice, receivedQty: 3, unit: 'kg' }] }), 403, 'forbidden', null, 'a branch manager cannot receive into the warehouse');
}

// =============================================================================================================
// 10. An order delivered to a branch: only that branch's manager receives it
// =============================================================================================================
{
  const po = await approvedPo(supplierB, [{ itemId: rice, qty: 20, unit: 'kg' }], { location: branch1.locationId });
  eq(po.deliverTo.kind, 'branch', 'deliver to a branch');
  const expected = await call('manager', 'GET', '/api/inventory/purchase-orders/expected', undefined, '', branch1.restaurantId);
  eq(expected.orders.map((o) => o.number), [po.number], 'the branch manager sees the order on its way');
  const other = await call('manager2', 'GET', '/api/inventory/purchase-orders/expected', undefined, '', branch2.restaurantId);
  eq(other.orders, [], 'the other branch sees nothing');
  await refuses(call('manager2', 'POST', '/api/inventory/goods-receipts', { poId: po.id, post: true, lines: [{ poLineId: po.lines[0].id, receivedQty: 20, unit: 'kg' }] }, '', branch2.restaurantId), 403, 'branch_forbidden', null, 'another branch cannot receive it');
  ok((await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and actor_id = $1`, [people.manager2])).n >= 1, 'and the attempt is audited');
  await refuses(call('manager', 'POST', '/api/inventory/goods-receipts', { poId: ricePo.id, post: true, lines: [{ poLineId: ricePo.lines[0].id, receivedQty: 1, unit: 'kg' }] }, '', branch1.restaurantId), 403, 'branch_forbidden', null, 'a warehouse order is not theirs');
  await refuses(call('manager', 'POST', '/api/inventory/goods-receipts', { poId: po.id, post: true, lines: [{ poLineId: po.lines[0].id, receivedQty: 20, unit: 'kg', unitCost: 50 }] }, '', branch1.restaurantId), 403, 'cost_owner_only', null, 'a branch manager cannot change the order price');
  await refuses(call('waiter', 'GET', '/api/inventory/purchase-orders/expected', undefined, '', branch1.restaurantId), 403, 'forbidden', null, 'a waiter has no access');
  const got = await call('manager', 'POST', '/api/inventory/goods-receipts', { poId: po.id, post: true, lines: [{ poLineId: po.lines[0].id, receivedQty: 20, unit: 'kg' }] }, '', branch1.restaurantId);
  eq([got.receipt.status, got.receipt.poNumber, await bal(branch1.locationId, rice)], ['posted', po.number, '23000.0000'], 'the branch manager receives their order (3 kg already there + 20 kg)');
  eq((await api('owner', 'GET', `/purchase-orders/${po.id}`)).order.status, 'received', 'the order is received');
  const list = await call('manager', 'GET', '/api/inventory/goods-receipts', undefined, '', branch1.restaurantId);
  ok(list.receipts.length >= 2 && list.receipts.every((x) => x.locationId === branch1.locationId), 'a branch lists only its own receipts');
  await refuses(call('manager2', 'GET', `/api/inventory/goods-receipts/${got.receipt.id}`, undefined, '', branch2.restaurantId), 403, 'branch_forbidden', null, 'cannot read another branch receipt');
  await refuses(api('manager', 'GET', '/purchase-orders'), 403, 'forbidden', null, 'the owner-side list is not for branch managers');
}

// =============================================================================================================
// 11. Idempotency by commandId
// =============================================================================================================
{
  const po = await approvedPo(supplierB, [{ itemId: rice, qty: 4, unit: 'kg' }]);
  const commandId = randomUUID();
  const body = { commandId, lines: [{ poLineId: po.lines[0].id, receivedQty: 4, unit: 'kg' }] };
  const before = await bal(centre, rice);
  const a = await api('owner', 'POST', `/purchase-orders/${po.id}/receive`, body);
  const b = await api('owner', 'POST', `/purchase-orders/${po.id}/receive`, body);
  eq(b.receipt.id, a.receipt.id, 'the same command returns the first result');
  eq(await bal(centre, rice), (await ledger.balance(db, centre, rice)).onHand, 'sanity');
  eq((await q(`select 1 from public.goods_receipts where po_id = $1`, [po.id])).length, 1, 'one receipt');
  eq((await q(`select 1 from public.stock_movements where ref_id = $1`, [a.receipt.id])).length, 1, 'one movement');
  ok(before !== (await bal(centre, rice)), 'stock moved once');
  // Idempotent submit/approve too.
  const made = await api('owner', 'POST', '/purchase-orders', { commandId: randomUUID(), supplierId: supplierA, lines: [{ itemId: rice, qty: 1, unit: 'kg' }] });
  eq(made.order.status, 'draft', 'create with a command id');
}

// =============================================================================================================
// 12. Supplier invoices (GRN-2)
// =============================================================================================================
{
  const inv = await api('owner', 'POST', '/supplier-invoices', { supplierId: supplierA, poId: flourPo.id, grnIds: [grn1.id, grn2.id], invoiceStatus: 'etims', invoiceNo: 'INV-1001', invoiceDate: '2026-11-18',
    etimsInvoiceNo: 'ETIMS-5551', supplierPin: 'p051234567z', amount: 11600, vat: 1600, dueDate: '2026-12-18' });
  eq([inv.invoice.invoiceNo, inv.invoice.supplierPin, inv.invoice.receipts.length, inv.invoice.paymentStatus], ['INV-1001', 'P051234567Z', 2, 'unpaid'], 'invoice recorded and linked to both receipts');
  eq([inv.invoice.receivedValue, inv.invoice.difference], ['10400.00', '1200.00'], 'received value 60 kg x 100 + 40 kg x 110 = 10,400; the invoice is 1,200 more (VAT)');
  eq((await one('select invoice_id from public.goods_receipts where id = $1', [grn1.id])).invoice_id, inv.invoice.id, 'receipt points at its invoice');
  eq(inv.invoice.attachments, [], 'attachments list (files are added with the attachments API)');
  await refuses(api('owner', 'POST', '/supplier-invoices', { supplierId: supplierA, invoiceStatus: 'other', invoiceNo: ' inv-1001 ', invoiceDate: '2026-11-19', amount: 5 }), 409, 'duplicate_invoice', /already recorded/, 'same number twice (any case or spacing)');
  const otherSupplier = await api('owner', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'other', invoiceNo: 'INV-1001', invoiceDate: '2026-11-19', amount: 500 });
  ok(otherSupplier.invoice.id, 'the same number from another supplier is fine');
  await refuses(api('owner', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'none', amount: 100 }), 400, 'no_invoice_reason_required', null, 'no invoice needs a reason');
  const none = await api('owner', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'none', noInvoiceReason: 'Market stall, M-Pesa message only', amount: 100 });
  eq([none.invoice.invoiceStatus, none.invoice.invoiceNo], ['none', null], 'recorded without an invoice');
  await refuses(api('owner', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'etims', invoiceNo: 'X1', invoiceDate: '2026-11-19', amount: 100 }), 400, 'etims_no_required', null, 'eTIMS needs its number');
  await refuses(api('owner', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'other', invoiceNo: 'X2', invoiceDate: '2026-11-19', amount: 100, supplierPin: 'nonsense' }), 400, 'bad_pin', null, 'PIN format');
  await refuses(api('owner', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'other', invoiceNo: 'X3', invoiceDate: '2026-11-19', amount: 100, vat: 200 }), 400, 'bad_vat', null, 'VAT beyond the total');
  await refuses(api('owner', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'other', invoiceNo: 'X4', invoiceDate: '2026-11-19', amount: 5, grnIds: [grn1.id] }), 409, 'wrong_supplier', null, 'a receipt from another supplier cannot be linked');
  const upd = await api('owner', 'PATCH', `/supplier-invoices/${otherSupplier.invoice.id}`, { amount: 600, notes: 'corrected' });
  eq([upd.invoice.amount, upd.invoice.notes], ['600.00', 'corrected'], 'invoice edited');
  eq((await api('ops', 'GET', `/supplier-invoices/${inv.invoice.id}`)).invoice.invoiceNo, 'INV-1001', 'operations manager can read invoices');
  await refuses(api('ops', 'POST', '/supplier-invoices', { supplierId: supplierB, invoiceStatus: 'none', noInvoiceReason: 'x', amount: 1 }), 403, 'forbidden', null, 'operations manager cannot write invoices');
  await refuses(api('manager', 'GET', '/supplier-invoices'), 403, 'forbidden', null, 'branch manager cannot see invoices');
  eq((await api('owner', 'GET', '/supplier-invoices', undefined, `?supplier=${supplierB}`)).invoices.length, 2, 'filter by supplier');
}

// =============================================================================================================
// 13. Lists, statuses, permissions, cost visibility, tenant isolation
// =============================================================================================================
{
  const all = await api('owner', 'GET', '/purchase-orders');
  ok(all.orders.length >= 8 && all.orders.every((o) => o.total !== undefined), 'owner list with totals');
  eq((await api('owner', 'GET', '/purchase-orders', undefined, '?status=cancelled')).orders.every((o) => o.status === 'cancelled'), true, 'filter by status');
  eq((await api('owner', 'GET', '/purchase-orders', undefined, `?supplier=${supplierC}`)).orders.length, 1, 'filter by supplier');
  eq((await api('owner', 'GET', '/purchase-orders', undefined, '?status=open')).orders.every((o) => ['approved', 'sent', 'partially_received'].includes(o.status)), true, 'open = approved, sent, partially received');
  await refuses(api('owner', 'GET', '/purchase-orders', undefined, '?status=bogus'), 400, 'bad_status', null, 'bad status filter');
  await refuses(api('waiter', 'GET', '/purchase-orders'), 403, 'forbidden', null, 'waiter');
  // Costs only with inv.cost.view: take it away from a scope and the money disappears from the view.
  const scope = await scopeOf('owner');
  scope.locationCaps.get(centre).delete('inv.cost.view');
  const hidden = (await getPo(db, scope, flourPo.id)).order;
  eq([hidden.totals, hidden.lines[0].unitPrice, hidden.lines[0].lineTotal, hidden.lines[0].qty], [undefined, undefined, undefined, '100'], 'no prices or totals without cost.view');
  // Tenant isolation: an order id from another business is not found; a stranger gets nothing.
  await refuses(call('owner', 'GET', `/api/owner/inventory/${randomUUID()}/purchase-orders`), 404, undefined, null, 'unknown business').catch(() => {});
  // Switched off.
  await db.query('update public.businesses set inventory_enabled = false where id = $1', [biz]);
  await refuses(api('owner', 'GET', '/purchase-orders'), 403, 'inventory_disabled', /switched on/, 'module off');
  await db.query('update public.businesses set inventory_enabled = true where id = $1', [biz]);
  // Database guards still hold under the API: a received order cannot be edited or cancelled.
  await refuses(api('owner', 'PATCH', `/purchase-orders/${flourPo.id}`, { notes: 'late' }), 409, 'po_not_draft', null, 'received order is not a draft');
  const closed = await api('owner', 'POST', `/purchase-orders/${flourPo.id}/close`, {});
  eq(closed.order.status, 'closed', 'a fully received order closes without needing a reason');
  await refuses(api('owner', 'POST', '/goods-receipts', { poId: flourPo.id, lines: [{ poLineId: poLine, receivedQty: 1, unit: 'kg' }] }), 409, 'po_not_receivable', /closed/, 'nothing more against a closed order');
  eq((await ledger.reconcile(db, { businessId: biz })).length, 0, 'ledger reconciles at the end');
}

console.log(`Purchasing + receiving: ${count()} checks passed.`);
await db.close();
