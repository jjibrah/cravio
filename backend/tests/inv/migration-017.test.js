// Migration 017 (proposed): approval rules, approvals, emergency purchases (+ lines).
// Rehearsal on PGlite: apply over a seeded database (012-016 present), no seed rows, constraints, maker-checker, status guards, no-invoice rules, RLS, down migration.
// Usage: node backend/tests/inv/migration-017.test.js
import assert from 'node:assert/strict';
import { asUser, readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';
import { inventoryBefore } from './migrations.js';
import { makeItem } from './helpers.js';

const UP = 'migrations/017_approvals_emergency.sql';
const DOWN = 'proposed/017_approvals_emergency.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(`${e.message} ${e.constraint || ''}`, re, m); return true; }, m);
  checks++;
};

const f = await inventoryFixture({ extra: inventoryBefore(17) });
const { db, ids, users } = f;
const biz = ids.businessId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const flour = await makeItem(db, biz, 'Flour', { packs: [{ name: 'sack', factor: 25000 }] });
const census = async () => one(`select (select count(*) from public.stock_items)::int as items, (select count(*) from public.stock_locations)::int as locations,
  (select count(*) from public.suppliers)::int as suppliers, (select count(*) from public.inventory_settings)::int as settings, (select count(*) from public.attachments)::int as attachments`);
const before = await census();
eq(await one(`select to_regclass('public.approvals') is null as absent`), { absent: true }, '017 is not applied yet');
await db.exec(readSql(UP));
eq(await census(), before, 'applying 017 changed no existing row');
eq((await one(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('approval_rules', 'approvals', 'emergency_purchases', 'emergency_purchase_lines')`)).n, 4, 'four new tables');
eq(await one(`select (select count(*) from public.approval_rules)::int as rules, (select count(*) from public.approvals)::int as approvals, (select count(*) from public.emergency_purchases)::int as eps`),
  { rules: 0, approvals: 0, eps: 0 }, 'no seed rows: the migration carries no amounts (D2-6, D2-16)');
await db.exec(readSql(UP)); checks++;
eq(await census(), before, 're-running 017 is harmless');

const insert = async (table, row) => {
  const keys = Object.keys(row);
  return (await db.query(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k]))).rows[0].id;
};
const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------------------------------------------
// approval_rules
// ---------------------------------------------------------------------------------------------------------------
const rule = (extra = {}) => insert('approval_rules', { business_id: biz, subject: 'emergency_purchase', approver_capability: 'inv.emergency.approve', per_transaction_kes: '5000', ...extra });
const r1 = await rule({ per_day_kes: '8000', per_week_kes: '20000' });
eq(await one(`select active, location_id, category_id from public.approval_rules where id = $1`, [r1]), { active: true, location_id: null, category_id: null }, 'a rule is the business default and active by default');
await fails(rule(), /approval_rules_scope/, 'one rule per (subject, place, category)');
await rule({ location_id: ids.branchLocationId }); checks++;                               // a branch override
const cat = await one(`insert into public.stock_categories (business_id, name) values ($1, 'Meat') returning id`, [biz]);
await rule({ category_id: cat.id }); checks++;                                              // a category rule
await rule({ location_id: ids.branchLocationId, category_id: cat.id }); checks++;
await fails(rule({ subject: 'emergency_purchase', per_transaction_kes: null }), /approval_rules_one_limit/, 'a rule must set at least one limit');
await fails(rule({ category_id: uuid(), per_transaction_kes: '1' }), /foreign key|violates/, 'category must exist in this business');
await fails(rule({ subject: 'wastage', per_transaction_kes: '-1', approver_capability: 'inv.adjust.approve' }), /per_transaction_kes_check/, 'amounts are not negative');
await fails(rule({ per_day_kes: '4999' }), /approval_rules_windows/, 'day limit can not be below the per-purchase limit');
await fails(rule({ location_id: ids.centerLocationId, per_day_kes: '9000', per_week_kes: '8000' }), /approval_rules_windows/, 'week limit can not be below the day limit');
await fails(rule({ subject: 'wastage', approver_capability: 'inv.adjust.approve', per_day_kes: '100', per_transaction_kes: '50' }), /windows_emergency_only/, 'daily and weekly limits are for emergency purchases');
await fails(rule({ subject: 'wastage', approver_capability: 'inv.adjust.approve', variance_pct: '5' }), /variance_counts_only/, 'variance limits are for counts');
await fails(rule({ subject: 'count', approver_capability: 'inv.count.approve', per_transaction_kes: '100' }), /counts_use_variance/, 'counts use variance limits');
await rule({ subject: 'count', approver_capability: 'inv.count.approve', per_transaction_kes: null, variance_pct: '2.5', variance_kes: '3000' }); checks++;
await fails(rule({ subject: 'count', approver_capability: 'inv.count.approve', per_transaction_kes: null, variance_pct: '101', location_id: ids.centerLocationId }), /variance_pct_check/, 'percentage at most 100');
await fails(rule({ subject: 'invoice' }), /subject_check/, 'known subjects only');
await fails(rule({ subject: 'wastage', approver_capability: 'inv.view' }), /approver_capability_check/, 'only approving capabilities');
await fails(rule({ business_id: biz, location_id: uuid(), per_transaction_kes: '9' }), /foreign key|violates/, 'location must exist');

// ---------------------------------------------------------------------------------------------------------------
// approvals: maker-checker, states, one pending per subject, immutability
// ---------------------------------------------------------------------------------------------------------------
const subject = uuid();
const approval = (extra = {}) => insert('approvals', { business_id: biz, subject_type: 'purchase_order', subject_id: subject, location_id: ids.centerLocationId,
  approver_capability: 'inv.purchase.approve', requested_by: users.manager, amount_kes: '12000', ...extra });
const a1 = await approval();
eq(await one(`select status, self_approved, rule_snapshot from public.approvals where id = $1`, [a1]), { status: 'pending', self_approved: false, rule_snapshot: {} }, 'defaults');
await fails(approval(), /approvals_one_pending/, 'one open request per subject');
await fails(db.query(`update public.approvals set status = 'approved', decided_by = requested_by, decided_at = now() where id = $1`, [a1]), /approvals_maker_checker/, 'the requester cannot approve their own request (T-SEC-2)');
await fails(db.query(`update public.approvals set status = 'approved', decided_at = now() where id = $1`, [a1]), /approvals_decided/, 'an approval needs who decided');
await fails(db.query(`update public.approvals set self_approved = true where id = $1`, [a1]), /approvals_self_approved_is_own/, 'self_approved only for the requester approving themself');
await fails(db.query(`update public.approvals set status = 'approved', decided_by = $2, decided_at = now(), self_approved = true where id = $1`, [a1, users.owner]), /approvals_self_approved_is_own/, 'self_approved can not be claimed by someone else');
await fails(db.query(`update public.approvals set status = 'rejected', decided_by = $2, decided_at = now() where id = $1`, [a1, users.owner]), /approvals_rejection_has_reason/, 'a rejection needs a reason');
await fails(db.query(`update public.approvals set amount_kes = 1 where id = $1`, [a1]), /can't be edited/, 'what was asked for can not change');
await db.query(`update public.approvals set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [a1, users.owner]); checks++;
await fails(db.query(`update public.approvals set decision_note = 'x' where id = $1`, [a1]), /already approved/, 'a decided approval is final');
await fails(db.query(`delete from public.approvals where id = $1`, [a1]), /can't be deleted/, 'approvals are never deleted');
await approval({ subject_id: subject }); checks++;   // a decided one doesn't block asking again

// Self-approval of a sole owner (D2-5): allowed when flagged and decided_by = requested_by.
const ownReq = uuid();
const a2 = await approval({ subject_id: ownReq, requested_by: users.owner });
await db.query(`update public.approvals set status = 'approved', decided_by = requested_by, decided_at = now(), self_approved = true where id = $1`, [a2]); checks++;
// Cancelling: its own columns, no decided_by.
const a3 = await approval({ subject_id: uuid() });
await fails(db.query(`update public.approvals set status = 'cancelled' where id = $1`, [a3]), /approvals_cancelled/, 'cancelled needs cancelled_at');
await db.query(`update public.approvals set status = 'cancelled', cancelled_at = now(), cancelled_by = requested_by where id = $1`, [a3]); checks++;
await fails(approval({ subject_type: 'invoice', subject_id: uuid() }), /subject_type_check/, 'known subjects');
await fails(approval({ amount_kes: '-1', subject_id: uuid() }), /amount_kes_check/, 'amount not negative');
await approval({ subject_type: 'emergency_purchase', approver_capability: 'inv.emergency.approve', subject_id: uuid(), location_id: null }); checks++;

// ---------------------------------------------------------------------------------------------------------------
// emergency_purchases
// ---------------------------------------------------------------------------------------------------------------
let n = 0;
const ep = (extra = {}) => insert('emergency_purchases', { business_id: biz, number: `EP-2026-${String(++n).padStart(4, '0')}`, location_id: ids.branchLocationId, requested_by: users.manager,
  reason: 'Ran out of flour mid-service', estimated_total: '3000', ...extra });
const e1 = await ep();
eq(await one(`select status, auto_authorised, estimated_total::text as e from public.emergency_purchases where id = $1`, [e1]), { status: 'draft', auto_authorised: false, e: '3000.00' }, 'defaults');
await fails(insert('emergency_purchases', { business_id: biz, number: 'EP-2026-0001', location_id: ids.branchLocationId, reason: 'dup' }), /emergency_purchases_business_id_number_key/, 'number unique per business');
await fails(ep({ number: 'EP-26-1' }), /number_check/, 'number format');
await fails(ep({ reason: '   ' }), /reason_check/, 'a reason is required');
await fails(ep({ status: 'authorised', authorised_at: new Date().toISOString() }), /starts as a draft/, 'starts as a draft');
await fails(ep({ location_id: uuid() }), /foreign key|violates/, 'branch must exist');
await fails(ep({ payment_method: 'card' }), /payment_method_check/, 'payment methods');
await fails(ep({ payment_method: 'mpesa', payment_reference: 'abc' }), /emergency_mpesa_code/, 'M-Pesa reference format');
await fails(ep({ payment_method: 'mpesa', payment_reference: 'SGH4X7K2L' }), /emergency_mpesa_code/, 'M-Pesa reference is 10 characters');
await ep({ payment_method: 'mpesa', payment_reference: 'SGH4X7K2LP' }); checks++;
await ep({ payment_method: 'cash', payment_reference: 'Receipt 4471' }); checks++;   // cash references are free text
await fails(ep({ invoice_status: 'none' }), /emergency_no_invoice/, 'no invoice: reason and reference are both required');
await fails(ep({ invoice_status: 'none', no_invoice_reason: 'Market trader had no till' }), /emergency_no_invoice/, 'no invoice: a reference is required');
await fails(ep({ invoice_status: 'none', payment_reference: 'SGH4X7K2LP', payment_method: 'mpesa' }), /emergency_no_invoice/, 'no invoice: a reason is required');
const noInvoice = await ep({ invoice_status: 'none', no_invoice_reason: 'Market trader had no till', payment_reference: 'SGH4X7K2LP', payment_method: 'mpesa' }); checks++;
await fails(ep({ invoice_status: 'receipt' }), /invoice_status_check/, 'invoice statuses');
// Supplier: optional, same business only.
await fails(ep({ supplier_id: uuid() }), /foreign key|violates/, 'supplier must exist');

// Lines: only while draft.
const line = (id, extra = {}) => insert('emergency_purchase_lines', { business_id: biz, emergency_id: id, position: 0, item_id: flour, entered_qty: '2', entered_unit: 'sack', unit_factor: '25000', qty_base: '50000',
  est_unit_price: '1500', est_total: '3000', ...extra });
const l1 = await line(e1);
await fails(line(e1), /emergency_purchase_lines_emergency_id_position_key/, 'one line per position');
await fails(line(e1, { position: 1, qty_base: '0' }), /qty_base_check/, 'quantity above zero');
await fails(line(e1, { position: 1, est_unit_price: '-1' }), /est_unit_price_check/, 'price not negative');
await fails(line(e1, { position: 1, item_id: uuid() }), /foreign key|violates/, 'item must exist');
await db.query(`update public.emergency_purchase_lines set est_total = 2900 where id = $1`, [l1]); checks++;

// Status path.
const go = (id, status, set = '') => db.query(`update public.emergency_purchases set status = $2 ${set} where id = $1`, [id, status]);
await fails(go(e1, 'purchased'), /can't go from draft to purchased/, 'draft cannot jump to purchased');
await fails(go(e1, 'authorised'), /emergency_authorised_at/, 'authorised needs authorised_at');
await go(e1, 'pending_approval', ', submitted_at = now()'); checks++;
await go(e1, 'authorised', ', authorised_at = now(), approved_total = 3000'); checks++;
await fails(db.query(`update public.emergency_purchase_lines set est_total = 1 where id = $1`, [l1]), /can't be edited/, 'estimates freeze once authorised');
await fails(line(e1, { position: 2 }), /can only change while it is a draft/, 'no new lines once authorised');
await fails(db.query(`delete from public.emergency_purchase_lines where id = $1`, [l1]), /can only change while it is a draft/, 'no deleted lines once authorised');
await fails(go(e1, 'purchased'), /emergency_purchased/, 'purchased needs method, actual total and time');
await go(e1, 'purchased', `, payment_method = 'cash', actual_total = 3100, purchased_at = now(), payment_reference = 'Receipt 8'`); checks++;
await db.query(`update public.emergency_purchase_lines set actual_unit_price = 1550, actual_total = 3100, received_base = 50000 where id = $1`, [l1]); checks++;   // real price and what arrived may be filled in
await fails(go(e1, 'received'), /emergency_received/, 'received needs an invoice status');
await fails(go(e1, 'received', `, invoice_status = 'other', received_at = now()`), /emergency_invoice_no/, 'an invoice needs its number');
await go(e1, 'received', `, invoice_status = 'other', invoice_no = 'INV-77', received_at = now()`); checks++;
await fails(db.query(`update public.emergency_purchases set actual_total = 1 where id = $1`, [e1]), /only the owner's review notes can change/, 'after receipt only the review notes change');
await fails(go(e1, 'under_review'), /emergency_review/, 'flagging for review needs a note');
await go(e1, 'under_review', `, review_note = 'Price looks high'`); checks++;
await fails(go(e1, 'closed'), /emergency_closed/, 'closing needs who reviewed and when');
await go(e1, 'closed', `, closed_at = now(), reviewed_by = '${users.owner}', reviewed_at = now()`); checks++;
await fails(go(e1, 'received'), /can't go from closed to received/, 'closed is final');
await fails(db.query(`delete from public.emergency_purchases where id = $1`, [e1]), /Only a draft/, 'only drafts can be deleted');

// T-EMP-3: no invoice -> goods photo before it can be received (trigger).
const toPurchased = async (id) => {
  await go(id, 'pending_approval'); await go(id, 'authorised', ', authorised_at = now()');
  await go(id, 'purchased', `, payment_method = 'mpesa', actual_total = 2800, purchased_at = now()`);
};
await toPurchased(noInvoice);
const att = (extra = {}) => insert('attachments', { business_id: biz, entity_type: 'emergency', entity_id: noInvoice, location_id: ids.branchLocationId, storage_path: `${biz}/emergency/${uuid()}.jpg`,
  mime: 'image/jpeg', size_bytes: 1000, sha256: 'a'.repeat(64), uploaded_by: users.manager, ...extra });
// The purchase was created with invoice_status 'none', so receiving it needs only the photo.
await fails(go(noInvoice, 'received', ', received_at = now()'), /photo of the goods/, 'no invoice and no photo: refused');
await att({ mime: 'application/pdf', storage_path: `${biz}/emergency/${uuid()}.pdf` });
await fails(go(noInvoice, 'received', ', received_at = now()'), /photo of the goods/, 'a PDF is not a photo of the goods');
const photo = await att();
await db.query(`update public.attachments set deleted_at = now(), deleted_by = $2 where id = $1`, [photo, users.owner]);
await fails(go(noInvoice, 'received', ', received_at = now()'), /photo of the goods/, 'a hidden (soft-deleted) photo does not count');
await att({ entity_id: uuid() });
await fails(go(noInvoice, 'received', ', received_at = now()'), /photo of the goods/, 'a photo of something else does not count');
await att();
await go(noInvoice, 'received', ', received_at = now()'); checks++;
eq((await one(`select status from public.emergency_purchases where id = $1`, [noInvoice])).status, 'received', 'photo + reason + reference: received');

// Cancel path and rejected.
const e3 = await ep();
await go(e3, 'cancelled', ', cancelled_at = now()'); checks++;
await fails(go(e3, 'draft'), /can't go from cancelled to draft/, 'cancelled is final');
const e4 = await ep(); await go(e4, 'pending_approval'); await go(e4, 'rejected'); checks++;
const e5 = await ep(); await go(e5, 'pending_approval'); await go(e5, 'draft'); checks++;   // sent back for changes
const e6 = await ep(); await go(e6, 'authorised', ', authorised_at = now()'); await go(e6, 'cancelled', ', cancelled_at = now()'); checks++;

// ---------------------------------------------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------------------------------------------
for (const t of ['approval_rules', 'approvals', 'emergency_purchases', 'emergency_purchase_lines']) {
  eq((await one(`select relrowsecurity as on from pg_class where oid = 'public.${t}'::regclass`)).on, true, `${t}: RLS enabled`);
  await fails(asUser(db, users.owner, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: owner cannot read through the browser role`);
  await fails(asUser(db, users.manager, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: manager cannot either`);
}

// ---------------------------------------------------------------------------------------------------------------
// Down migration
// ---------------------------------------------------------------------------------------------------------------
await fails(db.exec(readSql(DOWN)), /Refusing rollback of 017: .*approval rules/, 'down refuses while rules exist');
eq((await one(`select to_regclass('public.approvals') is not null as there`)).there, true, 'the refusal changed nothing');
await db.exec(`set session_replication_role = replica`);
for (const t of ['emergency_purchase_lines', 'emergency_purchases', 'approvals', 'approval_rules']) await db.query(`delete from public.${t}`);
await db.exec(`set session_replication_role = origin`);
await db.exec(readSql(DOWN));
eq((await one(`select to_regclass('public.approval_rules') is null and to_regclass('public.approvals') is null and to_regclass('public.emergency_purchases') is null
  and to_regclass('public.emergency_purchase_lines') is null as gone`)).gone, true, 'down drops the four tables');
eq((await one(`select count(*)::int as n from pg_proc where proname in ('approval_guard', 'emergency_guard', 'emergency_line_guard')`)).n, 0, 'and the guard functions');
eq((await one(`select to_regclass('public.attachments') is not null and to_regclass('public.purchase_orders') is not null and to_regclass('public.suppliers') is not null as kept`)).kept, true, '012-016 objects untouched');
await db.exec(readSql(DOWN)); checks++;
await db.exec(readSql(UP));
eq((await one(`select to_regclass('public.approvals') is not null as back`)).back, true, '017 re-applies after a rollback');

console.log(`Migration 017: ${checks} checks passed (disposable PGlite database).`);
await db.close();
