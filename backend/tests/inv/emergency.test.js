// Emergency purchases (P2-11, migration 017). Runs the REAL service and the REAL route handlers (routes/inventory-emergency.js, plus the approvals
// routes for the owner's decision) against an in-memory database with every proposed migration applied and a fake evidence bucket. No network.
// Covers T-EMP-1..4, safe default (no limit set = owner approves every buy), day/week windows in Africa/Nairobi on a fake clock, category rules,
// branch isolation, M-Pesa codes, on-the-spot suppliers, EMP-7 repeat alerts (weekly dedupe), receiving more than authorised, owner review.
// Usage: node backend/tests/inv/emergency.test.js
import { rig } from './fixture.js';
import { fakeClock, fakeStorage, makeAsserts, makeItem } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-emergency.js';
import { createRoutes as approvalRoutes } from '../../src/routes/inventory-approvals.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { setSetting } from '../../src/inventory/policies.js';
import { decide, deleteRule, setRule } from '../../src/inventory/approvals.js';
import * as emergency from '../../src/inventory/emergency.js';
import * as ledger from '../../src/inventory/ledger.js';
import { createUser } from '../support/pg.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, items, contexts, helpers } = r;
const biz = ids.businessId;
const B1 = branches.branch1.locationId;
const B2 = branches.branch2.locationId;
const clock = fakeClock('2026-11-18T09:00:00+03:00');   // a Wednesday, Nairobi
const storage = fakeStorage({ clock });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const uuid = () => crypto.randomUUID();
const scopeOf = (who) => inventoryScope(db, contexts[who], biz);
const asTx = async (who, fn) => { const scope = await scopeOf(who); return db.transaction((t) => fn(t, scope)); };

// ---- a third branch, a category item, a stranger and another business ----
const branch3 = await helpers.addBranch('Third branch');
contexts.manager3 = helpers.ctx(branch3.managerId, { memberships: [[branch3.restaurantId, 'manager']] });
const B3 = branch3.locationId;
const sugar = await makeItem(db, biz, 'Sugar');
const oil = await makeItem(db, biz, 'Cooking oil');
const meat = (await one(`insert into public.stock_categories (business_id, name) values ($1, 'Meat and poultry') returning id`, [biz])).id;
const chicken = await makeItem(db, biz, 'Chicken');
await db.query('update public.stock_items set category_id = $2 where id = $1', [chicken, meat]);
const { flour, rice } = items;
const stranger = await createUser(db, 'emp-stranger@example.test', { role: 'owner' });
const otherOwner = await createUser(db, 'emp-other-owner@example.test', { role: 'owner' });
const otherRestaurant = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning id, business_id`, [otherOwner]);
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.business_id, otherOwner]);
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.id, otherOwner]);
await db.query('update public.businesses set inventory_enabled = true where id = $1', [otherRestaurant.business_id]);
const all = { ...contexts, stranger: helpers.ctx(stranger),
  otherOwner: helpers.ctx(otherOwner, { memberships: [[otherRestaurant.id, 'owner']], grants: [{ businessId: otherRestaurant.business_id, role: 'owner', branchIds: null }] }) };
const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!all[who]) throw new HttpError(401, 'Please sign in to continue.');
  return all[who];
};
const common = { authenticate, pool: () => db, transact: (fn) => db.transaction(fn) };
const routes = createRoutes({ ...common, storage, now: clock.now });
const approvalsApi = approvalRoutes(common);
const run = async (table, as, method, pathname, body, query = '', branch = null) => {
  for (const route of table) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    const headers = { authorization: `Bearer ${as}` };
    if (branch) headers['x-cravio-branch'] = branch;
    return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const call = (as, method, pathname, body, query, branch) => run(routes, as, method, pathname, body, query, branch);
const BR = { manager: ids.branchId, manager2: branches.branch2.restaurantId, manager3: branch3.restaurantId, owner: ids.branchId };
const mgr = (who, method, suffix, body, query) => call(who, method, `/api/inventory/emergency${suffix}`, body, query, BR[who]);
const own = (who, method, suffix, body, query) => call(who, method, `/api/owner/inventory/${biz}/emergency${suffix}`, body, query);
const jpeg = (tag = 'a') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]);
const pdf = (tag = 'a') => Buffer.from(`%PDF-1.7\n${tag.repeat(40)}\n%%EOF`);
const file = (bytes, type, name = 'goods.jpg') => ({ name, type, base64: bytes.toString('base64') });
const photo = (who, id, tag) => mgr(who, 'POST', `/${id}/evidence`, { file: file(jpeg(tag), 'image/jpeg') });

const L = (itemId, qty, price, unit) => ({ itemId, qty, price, ...(unit ? { unit } : {}) });
const draft = (who, lines, extra = {}) => mgr(who, 'POST', '', { reason: 'Ran out during lunch service', supplierId: supplierId, lines, ...extra });
const mkSupplier = async (name) => (await one(`insert into public.suppliers (business_id, name, type, status) values ($1, $2, 'informal', 'active') returning id`, [biz, name])).id;
const supplierId = await mkSupplier('Kamau Wholesalers');
const pricesOf = (d, price) => d.lines.map((l) => ({ lineId: l.id, price }));
const rule = (fields) => asTx('owner', (t, s) => setRule(t, s, { subject: 'emergency_purchase', ...fields }));
const state = (id) => one('select * from public.emergency_purchases where id = $1', [id]);
const onHand = async (location, item) => Number((await one('select coalesce(sum(on_hand), 0)::text as n from public.stock_balances where location_id = $1 and item_id = $2', [location, item])).n);
const notes = (user, kind) => q(`select * from public.notifications where recipient_id = $1 and kind = $2 order by created_at`, [user, kind]);
const dbError = (p) => p.catch((e) => { throw new HttpError(400, e.message, { code: 'db' }); });
const denied = async (who) => (await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and actor_id = $1`, [who])).n;

/* ======================================================================================================== */
// 1. T-EMP-1: below the owner's limits -> authorised at once, stock on receipt at the real cost
/* ======================================================================================================== */
await rule({ locationId: B1, perTransactionKes: 5000, perDayKes: 8000, perWeekKes: 20000 });
let A;
{
  const lim = await mgr('manager', 'GET', '/limits', undefined, '?amount=1500');
  eq([lim.hasLimit, lim.leftTodayKes, lim.leftWeekKes, lim.preview.needsApproval], [true, '8000.00', '20000.00', false], 'the form sees what is left and that 1,500 would pass');
  ok(/KES 8,000 left today/.test(lim.message), 'limits in plain words');
  eq((await mgr('manager', 'GET', '/limits', undefined, '?amount=9000')).preview.needsApproval, true, 'a bigger amount is flagged before sending');

  const created = await draft('manager', [L(flour, 10, 150, 'kg')], { supplierId: undefined, newSupplier: { name: 'Mama Mboga', phone: '0712345678' } });
  A = created.id;
  eq([created.status, created.number, created.estimatedTotal, created.locationName], ['draft', 'EP-2026-0001', '1500.00', 'Main branch'], 'a draft with a number');
  eq([created.supplierName, created.supplierIncomplete], ['Mama Mboga', true], 'the on-the-spot supplier is saved as incomplete (EMP-4)');
  const sup = await one(`select type, incomplete, phone, created_by from public.suppliers where name = 'Mama Mboga'`);
  eq([sup.type, sup.incomplete, sup.created_by], ['one_off', true, people.manager], 'one-off supplier flagged for the owner to complete');
  eq(created.lines[0].qtyBase, '10000', 'lines keep kg and base units');

  const sent = await mgr('manager', 'POST', `/${A}/submit`, { commandId: uuid() });
  eq([sent.status, sent.autoAuthorised, sent.approvedTotal, sent.evaluation.needsApproval], ['authorised', true, '1500.00', false], 'below every limit: authorised at once');
  ok(/KES 6,500 left today/.test(sent.evaluation.limits.message), 'and it says how much is left: ' + sent.evaluation.limits.message);
  eq((await notes(people.owner, 'approval_needed')).length, 0, 'nobody was bothered');

  await refuses(mgr('manager', 'POST', `/${A}/receive`, { invoiceStatus: 'etims', invoiceNo: 'X1' }), 409, 'not_purchased', /Record what you paid first/);
  await refuses(mgr('manager', 'POST', `/${A}/purchased`, { paymentMethod: 'cheque', prices: pricesOf(sent, 160) }), 400, 'bad_payment_method');
  await refuses(mgr('manager', 'POST', `/${A}/purchased`, { paymentMethod: 'cash', prices: [] }), 400, 'price_required', /price you paid for Flour/);
  const bought = await mgr('manager', 'POST', `/${A}/purchased`, { paymentMethod: 'cash', paymentReference: 'Receipt 4471', prices: pricesOf(sent, 160) });
  eq([bought.status, bought.actualTotal, bought.paymentMethod], ['purchased', '1600.00', 'cash'], 'what was really paid');
  eq(bought.warnings, [], 'within the estimate: no warning');
  eq(await onHand(B1, flour), 0, 'no stock until the goods are received');
  await refuses(mgr('manager', 'POST', `/${A}/purchased`, { paymentMethod: 'cash', prices: pricesOf(sent, 160) }), 409, 'already_purchased');

  await refuses(mgr('manager', 'POST', `/${A}/receive`, { invoiceStatus: 'etims' }), 400, 'invoice_incomplete', /eTIMS invoice number/);
  const got = await mgr('manager', 'POST', `/${A}/receive`, { invoiceStatus: 'etims', invoiceNo: 'KRA-ETIMS-0009', commandId: uuid() });
  eq([got.status, got.actualTotal, got.invoiceNo, got.flags], ['received', '1600.00', 'KRA-ETIMS-0009', []], 'received; nothing for the owner to review');
  eq(await onHand(B1, flour), 10000, 'stock went up by 10 kg (10,000 g)');
  const mv = await one(`select reason, unit_cost::text as unit_cost, delta::text as delta, ref_type from public.stock_movements where item_id = $1 and location_id = $2`, [flour, B1]);
  eq([mv.reason, mv.unit_cost, mv.delta, mv.ref_type], ['emergency_receipt', '0.160000', '10000.0000', 'emergency'], 'ledger movement at the real cost per base unit (1,600 / 10,000 g)');
  eq((await one('select avg_cost::text as a from public.stock_items where id = $1', [flour])).a, '0.160000', 'average cost updated');
  eq(got.stock[0].onHand, '10000.0000', 'the answer shows the stock effect');
  eq((await q('select 1 from public.stock_movements where ref_id = $1', [A])).length, 1, 'one movement');
  eq((await ledger.reconcile(db, { businessId: biz })).length, 0, 'ledger reconciles');
  await refuses(mgr('manager', 'POST', `/${A}/receive`, { invoiceStatus: 'etims', invoiceNo: 'KRA-ETIMS-0009' }), 409, 'already_received');
  eq((await state(A)).status, 'received', 'unflagged purchases stay at received (017 allows closed only with a reviewer)');
}

await rule({ locationId: B1, perTransactionKes: 5000, perDayKes: 90000, perWeekKes: 400000 });   // roomy day and week so real-time approvals can't interfere below

/* ======================================================================================================== */
// 2. T-EMP-2: above the limit -> blocked until a different person approves
/* ======================================================================================================== */
let BIG;
{
  const big = await draft('manager', [L(rice, 100, 120, 'kg')]);
  BIG = big.id;
  eq(big.estimatedTotal, '12000.00', 'estimate');
  const sent = await mgr('manager', 'POST', `/${BIG}/submit`, {});
  eq([sent.status, sent.evaluation.needsApproval, sent.autoAuthorised], ['pending_approval', true, false], 'over the limit: waits for the owner');
  ok(sent.evaluation.reasons.some((x) => /Over your KES 5,000 limit per purchase/.test(x)), 'the reason is in plain words: ' + sent.evaluation.reasons[0]);
  eq([(await notes(people.owner, 'approval_needed')).length, (await notes(people.owner2, 'approval_needed')).length], [1, 1], 'both owners were told once');
  eq((await mgr('manager', 'POST', `/${BIG}/submit`, {})).replayed, true, 'sending twice does nothing new');
  eq((await q(`select 1 from public.approvals where subject_id = $1`, [BIG])).length, 1, 'one approval');

  await refuses(mgr('manager', 'POST', `/${BIG}/purchased`, { paymentMethod: 'cash', prices: pricesOf(sent, 100) }), 409, 'not_authorised', /still waiting for the owner’s approval/);
  await refuses(mgr('manager', 'POST', `/${BIG}/receive`, {}), 409, 'not_authorised');
  const approvalId = sent.approvalId;
  const base = `/api/owner/inventory/${biz}/approvals/${approvalId}/decide`;
  await refuses(run(approvalsApi, 'manager', 'POST', base, { decision: 'approve' }), 403, 'forbidden', null, 'a branch manager can never approve');
  await refuses(run(approvalsApi, 'ops', 'POST', base, { decision: 'approve' }), 403, 'forbidden', null, 'operations managers do not approve emergency buys');
  eq((await state(BIG)).status, 'pending_approval', 'still waiting');
  const done = await run(approvalsApi, 'owner', 'POST', base, { decision: 'approve', note: 'ok, we are short' });
  eq([done.status, done.selfApproved], ['approved', false], 'a different person approved');
  const after = await state(BIG);
  eq([after.status, after.auto_authorised, Number(after.approved_total)], ['authorised', false, 12000], 'approval authorises the purchase');
  ok(after.authorised_at !== null, 'and stamps when');
  eq((await notes(people.manager, 'approval_decided')).length, 1, 'the manager is told');
  const bought = await mgr('manager', 'POST', `/${BIG}/purchased`, { paymentMethod: 'mpesa', paymentReference: 'shk7q2x9lm', prices: pricesOf(sent, 119) });
  eq([bought.status, bought.paymentReference, bought.actualTotal], ['purchased', 'SHK7Q2X9LM', '11900.00'], 'the M-Pesa code is stored in capitals');

  // Rejection is final and the purchase stays out of the totals.
  const no = await draft('manager', [L(sugar, 5, 4000, 'kg')]);
  const noSent = await mgr('manager', 'POST', `/${no.id}/submit`, {});
  await refuses(run(approvalsApi, 'owner', 'POST', `/api/owner/inventory/${biz}/approvals/${noSent.approvalId}/decide`, { decision: 'reject' }), 400, 'reason_required');
  await run(approvalsApi, 'owner2', 'POST', `/api/owner/inventory/${biz}/approvals/${noSent.approvalId}/decide`, { decision: 'reject', note: 'Use the warehouse stock' });
  eq((await state(no.id)).status, 'rejected', 'rejected by the owner');
  await refuses(mgr('manager', 'POST', `/${no.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(noSent, 100) }), 409, 'not_authorised', /rejected/);
  await refuses(mgr('manager', 'POST', `/${no.id}/cancel`, {}), 409, 'cannot_cancel', /already rejected/);

  // The owner buying at a branch cannot approve their own request while another approver exists.
  const mine = await mgr('owner', 'POST', '', { reason: 'Owner bought on the way in', supplierId, lines: [L(sugar, 20, 400, 'kg')] });
  const mineSent = await mgr('owner', 'POST', `/${mine.id}/submit`, {});
  eq(mineSent.status, 'pending_approval', 'the owner is subject to the limit too');
  await refuses(run(approvalsApi, 'owner', 'POST', `/api/owner/inventory/${biz}/approvals/${mineSent.approvalId}/decide`, { decision: 'approve' }), 403, 'maker_checker', /can’t approve something you created/);
  await run(approvalsApi, 'owner2', 'POST', `/api/owner/inventory/${biz}/approvals/${mineSent.approvalId}/decide`, { decision: 'approve' });
  eq((await state(mine.id)).status, 'authorised', 'the second owner approved');
  await mgr('owner', 'POST', `/${mine.id}/cancel`, { reason: 'Got it elsewhere' });
  eq((await state(mine.id)).status, 'cancelled', 'an authorised purchase can be cancelled before buying');
}

/* ======================================================================================================== */
// 3. T-EMP-3: no invoice -> reason, reference and a photo of the goods; M-Pesa codes
/* ======================================================================================================== */
let N1;
{
  const d = await draft('manager', [L(sugar, 5, 200, 'kg')]);
  N1 = d.id;
  await mgr('manager', 'POST', `/${N1}/submit`, {});
  await mgr('manager', 'POST', `/${N1}/purchased`, { paymentMethod: 'cash', prices: pricesOf(d, 200) });
  await refuses(mgr('manager', 'POST', `/${N1}/receive`, {}), 400, 'invoice_incomplete', /Say whether you got an invoice/);
  await refuses(mgr('manager', 'POST', `/${N1}/receive`, { invoiceStatus: 'none' }), 400, 'invoice_incomplete', /say why/);
  await refuses(mgr('manager', 'POST', `/${N1}/receive`, { invoiceStatus: 'none', noInvoiceReason: 'Market trader gives no receipts' }), 400, 'invoice_incomplete', /payment reference/);
  await refuses(mgr('manager', 'POST', `/${N1}/receive`, { invoiceStatus: 'none', noInvoiceReason: 'Market trader gives no receipts', paymentReference: 'Cash slip 12' }), 400, 'invoice_incomplete', /photo of the goods/);
  eq([(await state(N1)).status, await onHand(B1, sugar)], ['purchased', 0], 'nothing changed: still purchased, no stock');
  // A PDF is not a photo of the goods.
  await mgr('manager', 'POST', `/${N1}/evidence`, { file: file(pdf('r'), 'application/pdf', 'slip.pdf') });
  await refuses(mgr('manager', 'POST', `/${N1}/receive`, { invoiceStatus: 'none', noInvoiceReason: 'Market trader gives no receipts', paymentReference: 'Cash slip 12' }), 400, 'invoice_incomplete', /photo of the goods/);
  // Another branch's manager cannot add the photo.
  await refuses(photo('manager2', N1, 'z'), 403, 'branch_forbidden');
  const up = await photo('manager', N1, 'g');
  eq([up.mime, up.locationId], ['image/jpeg', B1], 'the goods photo is stored against this branch');
  const got = await mgr('manager', 'POST', `/${N1}/receive`, { invoiceStatus: 'none', noInvoiceReason: 'Market trader gives no receipts', paymentReference: 'Cash slip 12' });
  eq([got.status, got.invoiceStatus, got.paymentReference], ['under_review', 'none', 'Cash slip 12'], 'no invoice: received, then flagged for the owner');
  ok(/^No invoice: Market trader/.test(got.reviewNote), 'with the reason on the note: ' + got.reviewNote);
  eq(await onHand(B1, sugar), 5000, 'the stock is in');
  eq((await notes(people.owner, 'emergency_review')).length, 1, 'the owner was asked to review');

  // The database refuses too (the safety net), whatever the API does.
  const d2 = await draft('manager', [L(sugar, 1, 100, 'kg')]);
  await mgr('manager', 'POST', `/${d2.id}/submit`, {});
  await mgr('manager', 'POST', `/${d2.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(d2, 100) });
  const sql = (text) => db.query(text, [d2.id]);
  await refuses(dbError(sql(`update public.emergency_purchases set invoice_status = 'none' where id = $1`)), 400, 'db', /emergency_no_invoice/, 'a no-invoice purchase needs a reason and a reference in the database');
  await sql(`update public.emergency_purchases set invoice_status = 'none', no_invoice_reason = 'x', payment_reference = 'y' where id = $1`);
  await refuses(dbError(sql(`update public.emergency_purchases set status = 'received', received_at = now() where id = $1`)), 400, 'db', /needs a photo of the goods/, 'and a photo before it can be received');

  // M-Pesa codes.
  const m = await draft('manager', [L(sugar, 1, 100, 'kg')]);
  await mgr('manager', 'POST', `/${m.id}/submit`, {});
  const pay = (ref, extra = {}) => mgr('manager', 'POST', `/${m.id}/purchased`, { paymentMethod: 'mpesa', paymentReference: ref, prices: pricesOf(m, 100), ...extra });
  await refuses(pay(undefined), 400, 'reference_required', /M-Pesa code/);
  await refuses(pay('abc'), 400, 'bad_mpesa_code', /10 capital letters and numbers/);
  await refuses(pay('SHK7Q2X9L'), 400, 'bad_mpesa_code', null, 'nine characters');
  await refuses(pay('SHK7Q2X9LM!'), 400, 'bad_mpesa_code', null, 'eleven characters');
  await refuses(pay('SHK7Q2X9LM'), 409, 'duplicate_payment_reference', /already used for EP-2026-0002/);
  eq((await state(m.id)).status, 'authorised', 'the bad attempts changed nothing');
  const okPay = await pay(' qa1 b2c 3d4e ');
  eq([okPay.status, okPay.paymentReference], ['purchased', 'QA1B2C3D4E'], 'spaces and lower case are tidied');
  await refuses(mgr('manager', 'POST', `/${m.id}/cancel`, {}), 409, 'cannot_cancel', /already recorded/);
}

/* ======================================================================================================== */
// 4. T-EMP-4: the owner changes the limits and the next purchase behaves differently, with no deploy
/* ======================================================================================================== */
{
  const twelve = (who) => draft(who, [L(rice, 100, 120, 'kg')]);
  eq((await mgr('manager', 'POST', `/${(await twelve('manager')).id}/submit`, {})).status, 'pending_approval', 'before: 12,000 needs approval');
  await rule({ locationId: B1, perTransactionKes: 20000, perDayKes: 200000, perWeekKes: 400000 });
  eq((await mgr('manager', 'POST', `/${(await twelve('manager')).id}/submit`, {})).status, 'authorised', 'after raising the limit: authorised at once');
  await rule({ locationId: B1, perTransactionKes: 100, perDayKes: 200, perWeekKes: 300 });
  const tiny = await draft('manager', [L(sugar, 1, 250, 'kg')]);
  eq((await mgr('manager', 'POST', `/${tiny.id}/submit`, {})).status, 'pending_approval', 'after lowering it: 250 needs approval');
  const rules = await q(`select id from public.approval_rules where location_id = $1`, [B1]);
  await asTx('owner', (t, s) => deleteRule(t, s, rules[0].id));
  const safe = await draft('manager', [L(sugar, 1, 10, 'kg')]);
  const s = await mgr('manager', 'POST', `/${safe.id}/submit`, {});
  eq([s.status, s.evaluation.safeDefault], ['pending_approval', true], 'with no limit at all every buy needs approval, even KES 10');
  ok(/owner approves every emergency purchase/.test(s.evaluation.reasons[0]), 'in plain words');
  const lim = await mgr('manager', 'GET', '/limits');
  eq(lim.hasLimit, false, 'the form says no limit is set');
  ok(/No limit set for Main branch/.test(lim.message), lim.message);
  await asTx('owner', (t, sc) => setRule(t, sc, { subject: 'emergency_purchase', perTransactionKes: 4000 }));
  const dflt = await draft('manager', [L(sugar, 1, 3900, 'kg')]);
  eq((await mgr('manager', 'POST', `/${dflt.id}/submit`, {})).status, 'authorised', 'a business-wide default rule covers a branch with no rule of its own');
  await rule({ locationId: B1, perTransactionKes: 5000, perDayKes: 90000, perWeekKes: 400000 });
}

/* ======================================================================================================== */
// 5. Day and week windows on a fake Nairobi clock, with services (the clock moves)
/* ======================================================================================================== */
{
  const sc = await scopeOf('manager2');
  await db.query('delete from public.approval_rules where subject = \'emergency_purchase\' and location_id is null');
  await rule({ locationId: B2, perTransactionKes: 3000, perDayKes: 5000, perWeekKes: 8000 });
  const buy = async (amount, name = 'A buy') => asTx('manager2', async (t, s) => {
    const d = await emergency.create(t, s, { locationId: B2, reason: name, supplierId, lines: [L(flour, 1, amount, 'kg')] }, { now: clock.now() });
    return emergency.submit(t, s, d.id, { now: clock.now() });
  });
  void sc;
  eq((await buy(2500)).status, 'authorised', 'Wed: 2,500 within every limit');
  eq((await buy(2400)).status, 'authorised', 'Wed: 4,900 so far today');
  const third = await buy(200);
  eq(third.status, 'pending_approval', 'Wed: 4,900 + 200 = 5,100 is over the daily limit although 200 is small');
  ok(third.evaluation.reasons.some((x) => /Today’s total would be KES 5,100 \(limit 5,000\) at Second branch/.test(x)), 'cumulative reason: ' + third.evaluation.reasons[0]);
  const lim = await asTx('manager2', (t, s) => emergency.limitsFor(t, s, B2, { now: clock.now() }));
  eq([lim.leftTodayKes, lim.leftWeekKes, lim.usedTodayKes], ['100.00', '3100.00', '4900.00'], 'the pending one is not counted: KES 100 left today');
  eq((await buy(3500)).status, 'pending_approval', 'over the per-purchase limit');
  clock.advanceDays(1);   // Thursday: a new day, the same week
  eq((await buy(2800)).status, 'authorised', 'Thu: the daily total started again (week now 7,700)');
  const week = await buy(500);
  eq(week.status, 'pending_approval', 'Thu: 7,700 + 500 is over the weekly limit');
  ok(week.evaluation.reasons.some((x) => /Weekly total would be KES 8,200 \(limit 8,000\)/.test(x)), 'weekly reason: ' + week.evaluation.reasons[0]);
  // The owner approving a waiting purchase counts it from the moment of approval.
  const pend = await state(third.id);
  await asTx('owner', (t, s) => decide(t, s, pend.approval_id, { decision: 'approve', at: clock.now() }));
  eq(Number((await asTx('manager2', (t, s) => emergency.limitsFor(t, s, B2, { now: clock.now() }))).usedWeekKes), 7900, 'approved purchases count toward the week (7,700 + 200)');
  clock.advanceDays(4);   // Monday 23 Nov
  eq((await buy(2900)).status, 'authorised', 'Mon: a new week');
  eq((await asTx('manager2', (t, s) => emergency.limitsFor(t, s, B2, { now: clock.now() }))).usedWeekKes, '2900.00', 'week totals reset on Monday (Nairobi)');
  clock.set('2026-11-18T09:00:00+03:00');
}

/* ======================================================================================================== */
// 6. Category rule
/* ======================================================================================================== */
{
  await rule({ locationId: B3, perTransactionKes: 50000 });
  await rule({ locationId: B3, categoryId: meat, perTransactionKes: 1000 });
  const sub = (who, lines) => draft(who, lines).then((d) => mgr(who, 'POST', `/${d.id}/submit`, {}));
  eq((await sub('manager3', [L(sugar, 10, 300, 'kg')])).status, 'authorised', 'a 3,000 sugar buy is under the general limit');
  const c = await sub('manager3', [L(chicken, 2, 700, 'kg')]);
  eq(c.status, 'pending_approval', 'chicken (Meat and poultry) over its own KES 1,000 limit');
  ok(c.evaluation.reasons.some((x) => /for Meat and poultry/.test(x)), 'names the category: ' + c.evaluation.reasons[0]);
  eq((await sub('manager3', [L(chicken, 1, 900, 'kg'), L(sugar, 10, 300, 'kg')])).status, 'authorised', 'only the chicken lines count against the chicken limit');
  await rule({ locationId: B3, perTransactionKes: 500000, perDayKes: 900000, perWeekKes: 900000 });
  await db.query(`delete from public.approval_rules where category_id is not null`);
}

/* ======================================================================================================== */
// 7. Receiving more or less than was authorised, cost, over-estimate
/* ======================================================================================================== */
{
  const mk = async (who, line, price) => {
    const d = await draft(who, [line]);
    const s = await mgr(who, 'POST', `/${d.id}/submit`, {});
    ok(s.status === 'authorised', 'authorised for the receiving tests');
    return { id: d.id, d, price };
  };
  // 4 % more than authorised is accepted; 6 % is not (the 5 % delivery allowance).
  const a = await mk('manager3', L(flour, 10, 100, 'kg'));
  await mgr('manager3', 'POST', `/${a.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(a.d, 100) });
  await refuses(mgr('manager3', 'POST', `/${a.id}/receive`, { lines: [{ lineId: a.d.lines[0].id, qty: 10.6 }], invoiceStatus: 'other', invoiceNo: 'R-1' }), 400, 'over_received', /at most 10\.5 kg.*5% allowance.*new emergency purchase/);
  const over = await mgr('manager3', 'POST', `/${a.id}/receive`, { lines: [{ lineId: a.d.lines[0].id, qty: 10.4 }], invoiceStatus: 'other', invoiceNo: 'R-1' });
  eq([over.status, over.actualTotal, await onHand(B3, flour)], ['received', '1040.00', 10400], 'received 10.4 kg and paid for what came: 1,040');
  eq((await one(`select unit_cost::text as c from public.stock_movements where ref_id = $1`, [a.id])).c, '0.100000', 'cost per gram = 1,040 / 10,400');
  eq(over.lines[0].received, { qtyBase: '10400', qty: '10.4', unit: 'kg' }, 'the line shows what arrived');

  // Short by half, in another unit (grams typed), and a real price 20 % over the estimate.
  const b = await mk('manager3', L(rice, 10, 100, 'kg'));
  await mgr('manager3', 'POST', `/${b.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(b.d, 120) });
  await refuses(mgr('manager3', 'POST', `/${b.id}/receive`, { lines: [{ lineId: b.d.lines[0].id, qty: 5000, unit: 'parsec' }], invoiceStatus: 'other', invoiceNo: 'R-2' }), 400, 'bad_unit');
  const short = await mgr('manager3', 'POST', `/${b.id}/receive`, { lines: [{ lineId: b.d.lines[0].id, qty: 5000, unit: 'g' }], invoiceStatus: 'other', invoiceNo: 'R-2' });
  eq([short.status, short.actualTotal, await onHand(B3, rice)], ['under_review', '600.00', 5000], 'half arrived: 5 kg at 120 = 600');
  ok(/Came in short: Rice 5 of 10 kg/.test(short.reviewNote), 'flagged: ' + short.reviewNote);

  // Over the estimate by more than 10 %.
  const c = await mk('manager3', L(sugar, 10, 100, 'kg'));
  const bought = await mgr('manager3', 'POST', `/${c.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(c.d, 125) });
  ok(/25% more than the KES 1,000 that was authorised/.test(bought.warnings[0]), 'a warning when recording: ' + bought.warnings[0]);
  const dear = await mgr('manager3', 'POST', `/${c.id}/receive`, { invoiceStatus: 'etims', invoiceNo: 'E-77' });
  eq([dear.status, dear.actualTotal], ['under_review', '1250.00'], 'over the estimate: flagged');
  ok(/25% more than the KES 1,000 authorised/.test(dear.reviewNote), dear.reviewNote);
  // 8 % over is fine at the default 10 %, and the owner can tighten the alert.
  const e = await mk('manager3', L(oil, 10, 100, 'kg'));
  await mgr('manager3', 'POST', `/${e.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(e.d, 108) });
  eq((await mgr('manager3', 'POST', `/${e.id}/receive`, { invoiceStatus: 'etims', invoiceNo: 'E-78' })).status, 'received', '8% over is within the 10% allowance');
  await setSetting(db, { businessId: biz, key: 'emergency_over_estimate_alert_pct', value: 5, actorId: people.owner, actorRole: 'owner' });
  const f = await mk('manager3', L(oil, 10, 100, 'kg'));
  await mgr('manager3', 'POST', `/${f.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(f.d, 108) });
  eq((await mgr('manager3', 'POST', `/${f.id}/receive`, { invoiceStatus: 'etims', invoiceNo: 'E-79' })).status, 'under_review', 'with the alert at 5% the same 8% is flagged');
  await setSetting(db, { businessId: biz, key: 'emergency_over_estimate_alert_pct', value: 10, actorId: people.owner, actorRole: 'owner' });

  // Idempotent commands: the same receive twice posts once.
  const g = await mk('manager3', L(sugar, 4, 100, 'kg'));
  await mgr('manager3', 'POST', `/${g.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(g.d, 100) });
  const cmd = uuid();
  const before = await onHand(B3, sugar);
  const r1 = await mgr('manager3', 'POST', `/${g.id}/receive`, { invoiceStatus: 'etims', invoiceNo: 'E-80', commandId: cmd });
  const r2 = await mgr('manager3', 'POST', `/${g.id}/receive`, { invoiceStatus: 'etims', invoiceNo: 'E-80', commandId: cmd });
  eq([r2.status, r2.number, await onHand(B3, sugar)], [r1.status, r1.number, before + 4000], 'a replayed command returns the first answer and does not double-post');
  eq((await q('select 1 from public.stock_movements where ref_id = $1', [g.id])).length, 1, 'one movement');
}

/* ======================================================================================================== */
// 8. EMP-7: the same item again and again
/* ======================================================================================================== */
{
  clock.set('2026-12-07T10:00:00+03:00');   // Monday, well after the section 7 oil receipts
  await db.query('delete from public.notifications');
  const buyOil = async () => {
    const d = await draft('manager3', [L(oil, 2, 300, 'kg')]);
    await mgr('manager3', 'POST', `/${d.id}/submit`, {});
    await mgr('manager3', 'POST', `/${d.id}/purchased`, { paymentMethod: 'cash', prices: pricesOf(d, 300) });
    return mgr('manager3', 'POST', `/${d.id}/receive`, { invoiceStatus: 'etims', invoiceNo: `OIL-${Math.random().toString(36).slice(2, 8)}` });
  };
  const repeats = () => notes(people.owner, 'emergency_repeat');
  await buyOil(); clock.advanceDays(1);
  const second = await buyOil(); clock.advanceDays(1);
  eq([(await repeats()).length, second.repeatAlerts], [0, []], 'twice is not yet a pattern');
  const third = await buyOil();
  const n = await repeats();
  eq(n.length, 1, 'the third emergency buy of Cooking oil in the week alerts the owners');
  eq(third.repeatAlerts.map((x) => x.count), [3], 'the answer says so');
  eq(n[0].body, 'Third branch bought Cooking oil in an emergency 3 times this week — consider raising its par level.', 'plain words');
  eq((await notes(people.owner2, 'emergency_repeat')).length, 1, 'both owners');
  clock.advanceDays(1);
  await buyOil();
  eq([(await repeats()).length, (await notes(people.manager3, 'emergency_repeat')).length], [1, 0], 'a fourth buy the same week does not repeat the alert (weekly dedupe), and branch managers are not spammed');
  clock.advanceDays(11);   // Monday 21 Dec: the 7-day window holds none of the earlier buys
  await buyOil();
  eq((await repeats()).length, 1, 'a new week with only one buy in the window: no alert');
  await setSetting(db, { businessId: biz, key: 'emergency_repeat_alert_count', value: 2, actorId: people.owner, actorRole: 'owner' });
  clock.advanceDays(1);
  await buyOil();
  eq((await repeats()).length, 2, 'the owner can change the threshold: two buys now alert, once for the new week');
  await setSetting(db, { businessId: biz, key: 'emergency_repeat_alert_count', value: 3, actorId: people.owner, actorRole: 'owner' });
  clock.set('2026-11-18T09:00:00+03:00');
}

/* ======================================================================================================== */
// 9. Owner side: list, filters, detail with evidence links, review, clawback
/* ======================================================================================================== */
{
  const all1 = await own('owner', 'GET', '');
  ok(all1.purchases.length >= 10, 'the owner sees every branch');
  eq(new Set(all1.purchases.map((p) => p.locationName)).size >= 3, true, 'across branches');
  eq((await own('owner', 'GET', '', undefined, `?locationId=${B2}`)).purchases.every((p) => p.locationId === B2), true, 'filter by branch');
  eq((await own('owner', 'GET', '', undefined, '?status=under_review')).purchases.every((p) => p.status === 'under_review'), true, 'filter by status');
  eq((await own('owner', 'GET', '', undefined, '?status=pending_approval,rejected')).purchases.every((p) => ['pending_approval', 'rejected'].includes(p.status)), true, 'a comma list');
  const none = (await own('owner', 'GET', '', undefined, '?invoiceStatus=none')).purchases;
  ok(none.length >= 1 && none.every((p) => p.invoiceStatus === 'none') && none.some((p) => p.id === N1), 'filter by invoice status');
  eq((await own('owner', 'GET', '', undefined, '?invoiceStatus=missing')).purchases.every((p) => p.invoiceStatus === null), true, 'purchases with no invoice information yet');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const today = (await own('owner', 'GET', '', undefined, `?from=${day}&to=${day}`)).purchases.length;
  ok(today > 0, 'date filter: from and to are Nairobi days, inclusive');
  eq((await own('owner', 'GET', '', undefined, '?from=2026-01-01&to=2026-01-02')).purchases, [], 'and an empty window is empty');
  eq((await own('owner', 'GET', '', undefined, '?search=EP-2026-0001')).purchases.map((p) => p.id), [A], 'search by number');
  ok((await own('owner', 'GET', '')).counts.under_review >= 1, 'counts per status for the chips');
  await refuses(own('owner', 'GET', '', undefined, '?status=banana'), 400, 'bad_status');
  await refuses(own('owner', 'GET', '', undefined, '?from=yesterday'), 400, 'bad_date');

  const detail = await own('owner', 'GET', `/${N1}`);
  eq(detail.evidence.length, 2, 'the owner sees both files (the PDF slip and the goods photo)');
  ok(detail.evidence.every((e) => storage.verify(e.url)), 'each with a live signed link');
  eq([detail.lines[0].itemName, detail.requestedByName !== undefined], ['Sugar', true], 'lines and requester');
  const bigDetail = await own('owner', 'GET', `/${BIG}`);
  eq([bigDetail.approvals.length, bigDetail.approvals[0].status, bigDetail.approvals[0].selfApproved], [1, 'approved', false], 'the approval history is on the detail');
  const branchView = await mgr('manager', 'GET', `/${N1}`);
  eq(branchView.evidence.length, 2, 'the branch manager sees the evidence of their own purchase');

  // Who may review.
  await refuses(own('manager', 'POST', `/${N1}/review`, { outcome: 'close' }), 403, 'forbidden', null, 'a branch manager is not an owner');
  await refuses(own('ops', 'POST', `/${N1}/review`, { outcome: 'close' }), 403, 'forbidden', null, 'operations managers only look');
  await refuses(own('stranger', 'GET', ''), 403, 'forbidden');
  await refuses(own('otherOwner', 'GET', ''), 403, 'forbidden', null, 'another business’s owner');
  await refuses(own('otherOwner', 'GET', `/${N1}`), 403, 'forbidden');
  eq((await own('ops', 'GET', '')).purchases.every((p) => p.locationId === B1), true, 'an operations manager reads only their branches');
  await refuses(own('waiter', 'GET', ''), 403, 'forbidden');

  // Flag a clean purchase, then close.
  await refuses(own('owner', 'POST', `/${A}/review`, { outcome: 'flag' }), 400, 'note_required');
  const flagged = await own('owner', 'POST', `/${A}/review`, { outcome: 'flag', note: 'Price looks high for flour' });
  eq(flagged.status, 'under_review', 'the owner can flag a received purchase');
  const closed = await own('owner', 'POST', `/${N1}/review`, { outcome: 'close', note: 'Spoke to the trader', clawbackNote: 'Recover KES 200 from the till float', commandId: uuid() });
  eq([closed.status, closed.reviewedBy, closed.clawbackNote, closed.reviewNote], ['closed', people.owner, 'Recover KES 200 from the till float', 'Spoke to the trader'], 'closed with the owner’s notes');
  ok(closed.closedAt !== null && closed.reviewedAt !== null, 'when and by whom');
  eq((await notes(people.manager, 'emergency_clawback')).length, 1, 'the manager is told about the clawback note');
  eq((await own('owner', 'POST', `/${N1}/review`, { outcome: 'close' })).replayed, true, 'closing twice is harmless');
  await refuses(own('owner', 'POST', `/${BIG}/review`, { outcome: 'close' }), 409, 'not_reviewable', /Only goods that were received/, 'cannot review what was not received');
  await refuses(own('owner', 'POST', `/${N1}/review`, { outcome: 'bogus' }), 400, 'bad_outcome');
  await refuses(mgr('manager', 'POST', `/${N1}/receive`, { invoiceStatus: 'etims', invoiceNo: 'again' }), 409, 'already_received');
  await refuses(photo('manager', N1, 'late'), 409, 'purchase_finished');
}

/* ======================================================================================================== */
// 10. Drafts, validation, cancel, branch isolation
/* ======================================================================================================== */
{
  const bad = (body, status, code, re) => refuses(mgr('manager', 'POST', '', { reason: 'Ran out', supplierId, lines: [L(flour, 1, 100, 'kg')], ...body }), status, code, re);
  await bad({ reason: '' }, 400, 'text_required', /why this couldn’t wait/);
  await bad({ supplierId: undefined }, 400, 'supplier_required', /who you are buying from/);
  await bad({ lines: [] }, 400, 'lines_required');
  await bad({ lines: [L(flour, 1, 0, 'kg')] }, 400, 'price_required', /more than zero/);
  await bad({ lines: [{ itemId: flour, qty: 1, unit: 'kg' }] }, 400, 'price_required', /best estimate of the price/);
  await bad({ lines: [L(flour, 0, 100, 'kg')] }, 400, 'qty_not_positive');
  await bad({ lines: [L(flour, 1, 100, 'litre')] }, 400, 'unit_mismatch');
  await bad({ lines: [L(flour, 1, 100, 'kg'), L(flour, 2, 100, 'kg')] }, 400, 'duplicate_item');
  await bad({ lines: [L(uuid(), 1, 100, 'kg')] }, 404, 'item_not_found');
  await bad({ supplierId: uuid() }, 404, 'supplier_not_found');
  await bad({ supplierId: undefined, newSupplier: { name: 'No Phone Ltd' } }, 400, 'phone_required');
  await bad({ supplierId: undefined, newSupplier: { name: 'Kamau Wholesalers', phone: '0700000001' } }, 409, 'name_taken');
  const packs = await draft('manager', [L(flour, 2, 3000, 'sack')]);
  eq([packs.lines[0].qtyBase, packs.estimatedTotal], ['50000', '6000.00'], 'sacks convert to base units, the price is per sack');

  // Edit a draft, then it freezes.
  const upd = await mgr('manager', 'PUT', `/${packs.id}`, { reason: 'Changed my mind', lines: [L(flour, 1, 3000, 'sack')] });
  eq([upd.estimatedTotal, upd.reason, upd.lines.length], ['3000.00', 'Changed my mind', 1], 'a draft can be edited');
  await mgr('manager', 'POST', `/${packs.id}/submit`, {});
  await refuses(mgr('manager', 'PUT', `/${packs.id}`, { reason: 'Too late' }), 409, 'not_draft');
  await refuses(dbError(db.query(`update public.emergency_purchase_lines set qty_base = 1 where emergency_id = $1`, [packs.id])), 400, 'db', /be edited|can only change while it is a draft/, 'lines are frozen in the database too');

  // Cancel: draft, and a waiting one withdraws its approval.
  const dr = await draft('manager', [L(flour, 1, 100, 'kg')]);
  eq((await mgr('manager', 'POST', `/${dr.id}/cancel`, { reason: 'Not needed' })).status, 'cancelled', 'a draft can be cancelled');
  eq((await mgr('manager', 'POST', `/${dr.id}/cancel`, {})).replayed, true, 'cancelling twice is harmless');
  const wait = await draft('manager', [L(flour, 100, 100, 'kg')]);
  const waitSent = await mgr('manager', 'POST', `/${wait.id}/submit`, {});
  await mgr('manager', 'POST', `/${wait.id}/cancel`, { reason: 'Found stock' });
  eq((await one('select status from public.approvals where id = $1', [waitSent.approvalId])).status, 'cancelled', 'cancelling a waiting purchase withdraws the approval request');

  // Branch isolation (T-SEC-1): branch 2's purchases belong to branch 2.
  const theirs = (await own('owner', 'GET', '', undefined, `?locationId=${B2}`)).purchases[0];
  const deniedBefore = await denied(people.manager);
  await refuses(mgr('manager', 'GET', `/${theirs.id}`), 403, 'branch_forbidden');
  await refuses(mgr('manager', 'POST', `/${theirs.id}/submit`, {}), 403, 'branch_forbidden');
  await refuses(mgr('manager', 'POST', `/${theirs.id}/receive`, {}), 403, 'branch_forbidden');
  await refuses(mgr('manager', 'POST', `/${theirs.id}/cancel`, {}), 403, 'branch_forbidden');
  await refuses(photo('manager', theirs.id, 'cross'), 403, 'branch_forbidden');
  eq(await denied(people.manager) >= deniedBefore + 5, true, 'each attempt is audited as denied');
  await refuses(call('manager', 'GET', '/api/inventory/emergency', undefined, '', BR.manager2), 403, 'branch_forbidden', null, 'asking for branch 2 through the header');
  await refuses(call('manager', 'GET', `/api/inventory/emergency/${theirs.id}`, undefined, '', BR.manager2), 403, 'branch_forbidden');
  await refuses(call('waiter', 'GET', '/api/inventory/emergency', undefined, '', ids.branchId), 403, 'forbidden', null, 'a waiter has no part in this');
  await refuses(call('stranger', 'GET', '/api/inventory/emergency', undefined, '', ids.branchId), 403, 'branch_forbidden');
  await refuses(call('manager', 'GET', `/api/inventory/emergency/${uuid()}`, undefined, '', ids.branchId), 404, 'emergency_not_found');
  const ownList = await mgr('manager', 'GET', '');
  eq(ownList.purchases.every((p) => p.locationId === B1), true, 'a manager lists only their branch');
  const forced = await mgr('manager', 'POST', '', { reason: 'Tried another branch', supplierId, locationId: B2, lines: [L(flour, 1, 100, 'kg')] });
  eq(forced.locationId, B1, 'the branch comes from the header, never from the body');
  const supp = await mgr('manager', 'GET', '/suppliers');
  ok(supp.suppliers.some((s) => s.name === 'Kamau Wholesalers') && supp.suppliers.every((s) => !('phone' in s) && !('kraPin' in s)), 'the picker lists names only');
  const spot = await mgr('manager', 'POST', '/suppliers', { name: 'Roadside Butchery', phone: '+254722000111' });
  eq([spot.supplier.incomplete, spot.supplier.name], [true, 'Roadside Butchery'], 'an on-the-spot supplier can also be added before the purchase');
}

/* ======================================================================================================== */
// 11. A sole owner approves their own emergency buy: allowed, flagged (D2-5)
/* ======================================================================================================== */
{
  await db.query('delete from public.business_members where user_id = $1', [people.owner2]);
  await db.query('delete from public.restaurant_members where user_id = $1', [people.owner2]);
  const d = await mgr('owner', 'POST', '', { reason: 'Owner on site', supplierId, lines: [L(rice, 100, 120, 'kg')] });
  const sent = await mgr('owner', 'POST', `/${d.id}/submit`, {});
  eq(sent.status, 'pending_approval', 'over the limit even for the owner');
  const inbox = await run(approvalsApi, 'owner', 'GET', `/api/owner/inventory/${biz}/approvals`);
  const item = inbox.approvals.find((x) => x.id === sent.approvalId);
  eq([item.canDecide, item.selfApproval], [true, true], 'the inbox shows it as a self-approval');
  const done = await run(approvalsApi, 'owner', 'POST', `/api/owner/inventory/${biz}/approvals/${sent.approvalId}/decide`, { decision: 'approve' });
  eq([done.status, done.selfApproved], ['approved', true], 'allowed and flagged self_approved');
  eq((await state(d.id)).status, 'authorised', 'the purchase moves on');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'emergency_purchase' and entity_id = $1 and action = 'authorise_self'`, [d.id])).n, 1, 'and the purchase carries an authorise_self audit event');
}

/* ======================================================================================================== */
// 12. Audit trail, ledger, module off
/* ======================================================================================================== */
{
  const actions = (await q(`select distinct action from public.inventory_events where entity = 'emergency_purchase' and entity_id = $1`, [A])).map((x) => x.action).sort();
  eq(actions, ['auto_authorise', 'create', 'purchase', 'receive', 'review_flag'].sort(), 'every step of purchase A is audited');
  eq((await ledger.reconcile(db, { businessId: biz })).length, 0, 'the ledger still reconciles after everything');
  await db.query('update public.businesses set inventory_enabled = false where id = $1', [biz]);
  await refuses(mgr('manager', 'GET', ''), 403, 'inventory_disabled');
  await db.query('update public.businesses set inventory_enabled = true where id = $1', [biz]);
}

console.log(`emergency.test.js: ${count()} checks passed`);
