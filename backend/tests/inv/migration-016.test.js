// Migration 016 (proposed): purchase orders, goods receipts, supplier invoices, supplier returns, attachments.
// Rehearsal on PGlite: apply over a seeded database (012-015 present), constraints, status guards, uniques, soft delete, RLS, down migration.
// Usage: node backend/tests/inv/migration-016.test.js
import assert from 'node:assert/strict';
import { asUser, readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';
import { inventoryBefore } from './migrations.js';
import { makeItem, makeSupplier } from './helpers.js';

const UP = 'migrations/016_purchasing.sql';
const DOWN = 'proposed/016_purchasing.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(`${e.message} ${e.constraint || ''}`, re, m); return true; }, m);
  checks++;
};

const f = await inventoryFixture({ extra: inventoryBefore(16) });
const { db, ids, users } = f;
const biz = ids.businessId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const flour = await makeItem(db, biz, 'Flour', { packs: [{ name: 'sack', factor: 25000 }] });
const mama = await makeSupplier(db, biz, 'Mama Njeri');
await db.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 40000)`, [ids.centerLocationId, flour]);
const census = async () => one(`select (select count(*) from public.stock_items)::int as items, (select count(*) from public.stock_balances)::int as balances,
  (select count(*) from public.stock_movements)::int as movements, (select count(*) from public.suppliers)::int as suppliers, (select count(*) from public.inventory_settings)::int as settings`);
const before = await census();
eq(await one(`select to_regclass('public.purchase_orders') is null as absent`), { absent: true }, '016 is not applied yet');
await db.exec(readSql(UP));
eq(await census(), before, 'applying 016 changed no existing row');
eq((await one(`select count(*)::int as n from information_schema.tables where table_schema = 'public'
  and table_name in ('purchase_orders', 'po_lines', 'supplier_invoices', 'goods_receipts', 'grn_lines', 'supplier_returns', 'supplier_return_lines', 'attachments')`)).n, 8, 'eight new tables');
await db.exec(readSql(UP)); checks++;
eq(await census(), before, 're-running 016 is harmless');

const insert = async (table, row) => {
  const keys = Object.keys(row);
  return (await db.query(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k]))).rows[0].id;
};
let n = 0;
const po = (extra = {}) => insert('purchase_orders', { business_id: biz, number: `PO-2026-${String(++n).padStart(4, '0')}`, supplier_id: mama, deliver_to_location_id: ids.centerLocationId, ...extra });
const poLine = (poId, extra = {}) => insert('po_lines', { business_id: biz, po_id: poId, position: 0, item_id: flour, entered_qty: '2', entered_unit: 'sack', unit_factor: '25000', qty_base: '50000',
  unit_price: '3250.00', price_per_base: '0.130000', line_total: '6500.00', ...extra });
const setStatus = (id, status, extra = '') => db.query(`update public.purchase_orders set status = $2 ${extra} where id = $1`, [id, status]);

// ---------------------------------------------------------------------------------------------------------------
// purchase_orders: shape, numbers, composite foreign keys
// ---------------------------------------------------------------------------------------------------------------
const p1 = await po({ notes: 'first' });
eq(await one(`select status, subtotal::text as s, self_approved from public.purchase_orders where id = $1`, [p1]), { status: 'draft', s: '0.00', self_approved: false }, 'defaults: draft, zero totals, not self-approved');
await fails(insert('purchase_orders', { business_id: biz, number: 'PO-2026-0001', supplier_id: mama, deliver_to_location_id: ids.centerLocationId }), /purchase_orders_business_id_number_key/, 'PO number unique per business');
await fails(po({ number: 'PO-26-1' }), /number_check/, 'number format');
await fails(po({ status: 'approved', approved_at: new Date().toISOString() }), /starts as a draft/, 'a PO is created as a draft');
await fails(po({ deliver_to_location_id: ids.branchLocationId, supplier_id: '00000000-0000-4000-8000-000000000000' }), /foreign key|violates/, 'supplier must exist');
await po({ deliver_to_location_id: ids.branchLocationId }); checks++;   // direct delivery to a branch
const otherOwner = (await one(`insert into auth.users (email) values ('o2@example.test') returning id`)).id;
const otherBiz = (await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning business_id`, [otherOwner])).business_id;
const foreignSupplier = await makeSupplier(db, otherBiz, 'Mama Njeri');
await fails(po({ supplier_id: foreignSupplier }), /foreign key|violates/, 'a supplier of another business cannot be used');
await insert('purchase_orders', { business_id: otherBiz, number: 'PO-2026-0001', supplier_id: foreignSupplier, deliver_to_location_id: (await one(`insert into public.stock_locations (business_id, kind, name) values ($1, 'center', 'W') returning id`, [otherBiz])).id });
checks++;  // the same number is fine in another business
await fails(po({ cancel_reason: 'x'.repeat(301) }), /cancel_reason_check/, 'reason length');

// ---------------------------------------------------------------------------------------------------------------
// po_lines
// ---------------------------------------------------------------------------------------------------------------
const l1 = await poLine(p1);
await fails(poLine(p1), /po_lines_po_id_position_key/, 'one line per position');
await fails(poLine(p1, { position: 1, qty_base: '0' }), /qty_base_check/, 'quantity above zero');
await fails(poLine(p1, { position: 1, unit_price: '-1' }), /unit_price_check/, 'price not negative');
await fails(poLine(p1, { position: 1, received_base: '75001' }), /po_lines_check|check/, 'hard cap: at most 150 % received');
await poLine(p1, { position: 1, received_base: '0' }); checks++;
const foreignItem = await makeItem(db, otherBiz, 'Foreign flour');
await fails(poLine(p1, { position: 2, item_id: foreignItem }), /foreign key|violates/, 'an item of another business cannot be ordered');
await fails(db.query(`delete from public.stock_items where id = $1`, [flour]), /foreign key|violates|still referenced/, 'an ordered item cannot be deleted');

// Status guard
await fails(setStatus(p1, 'sent'), /can't go from draft to sent/, 'draft -> sent skips approval');
await fails(setStatus(p1, 'received'), /can't go from draft to received/, 'draft -> received');
await fails(setStatus(p1, 'approved'), /approved_at|check/, 'approved needs approved_at');
await setStatus(p1, 'pending_approval'); checks++;
await fails(db.query(`update public.purchase_orders set notes = 'edit' , total = 1 where id = $1`, [p1]), /can't be edited once it is submitted/, 'no edits after submit');
await db.query(`update public.purchase_orders set notes = 'a note' where id = $1`, [p1]); checks++;   // notes may change
await setStatus(p1, 'draft'); checks++;                                                              // sent back for changes
await db.query(`update public.purchase_orders set subtotal = 6500, total = 6500 where id = $1`, [p1]); checks++;
await setStatus(p1, 'pending_approval'); await setStatus(p1, 'approved', `, approved_by = '${users.owner}', approved_at = now(), self_approved = true`); checks++;
await fails(db.query(`insert into public.po_lines (business_id, po_id, position, item_id, entered_qty, entered_unit, unit_factor, qty_base, unit_price, line_total)
  values ($1, $2, 5, $3, 1, 'sack', 25000, 25000, 1, 1)`, [biz, p1, flour]), /only be added while the order is a draft/, 'no new lines after approval');
await fails(db.query(`update public.po_lines set qty_base = 1 where id = $1`, [l1]), /only be changed while the order is a draft/, 'lines frozen after approval');
await fails(db.query(`delete from public.po_lines where id = $1`, [l1]), /only be removed while the order is a draft/, 'lines cannot be removed after approval');
await fails(db.query(`delete from public.purchase_orders where id = $1`, [p1]), /Only a draft/, 'only drafts can be deleted');
await setStatus(p1, 'sent', ', sent_at = now(), sent_via = \'whatsapp\''); checks++;
await db.query(`update public.po_lines set received_base = 20000 where id = $1`, [l1]); checks++;     // receiving moves the running total
await fails(setStatus(p1, 'cancelled', `, cancelled_at = now(), cancel_reason = 'changed mind'`), /received stock/, 'cancel refused once stock was received');
await setStatus(p1, 'partially_received'); await setStatus(p1, 'received'); await setStatus(p1, 'closed'); checks++;
await fails(setStatus(p1, 'sent'), /can't (go|be)/, 'closed is final');
await fails(db.query(`update public.purchase_orders set notes = 'late' where id = $1`, [p1]), /closed purchase order can't be changed/, 'closed PO cannot be edited');
await fails(db.query(`update public.po_lines set received_base = 30000 where id = $1`, [l1]), /Stock can't be received against a closed order/, 'no receiving against a closed order');

// cancel path and the reason requirement
const p2 = await po(); await poLine(p2);
await fails(setStatus(p2, 'cancelled', ', cancelled_at = now()'), /cancel_reason|check/, 'cancel needs a reason');
await setStatus(p2, 'cancelled', `, cancelled_by = '${users.owner}', cancelled_at = now(), cancel_reason = 'supplier closed'`); checks++;
await fails(setStatus(p2, 'draft'), /can't go from cancelled to draft/, 'cancelled is final');
// A draft can be deleted together with its lines.
const p3 = await po(); await poLine(p3);
await db.query(`delete from public.purchase_orders where id = $1`, [p3]);
eq((await one(`select count(*)::int as n from public.po_lines where po_id = $1`, [p3])).n, 0, 'deleting a draft removes its lines');
// A supplier with POs cannot be deleted.
await fails(db.query(`delete from public.suppliers where id = $1`, [mama]), /foreign key|violates|still referenced/, 'deleting a supplier with POs is blocked');

// ---------------------------------------------------------------------------------------------------------------
// supplier_invoices
// ---------------------------------------------------------------------------------------------------------------
const inv = (extra = {}) => insert('supplier_invoices', { business_id: biz, supplier_id: mama, invoice_no: `INV-${++n}`, invoice_date: '2026-11-18', amount: '6500.00', vat: '896.55', ...extra });
const i1 = await inv({ invoice_status: 'etims', etims_invoice_no: 'KRAMW0100123456', supplier_pin: 'P051234567Z', po_id: p1, due_date: '2026-12-18' });
eq(await one(`select payment_status, paid_amount::text as paid from public.supplier_invoices where id = $1`, [i1]), { payment_status: 'unpaid', paid: '0.00' }, 'invoice starts unpaid');
await fails(inv({ invoice_no: ' inv-9 ' }).then(() => inv({ invoice_no: 'INV-9' })), /supplier_invoices_number/, 'same invoice number from the same supplier (any case) twice');
await fails(inv({ invoice_status: 'etims' }), /check/, 'an eTIMS invoice needs its eTIMS number');
await fails(inv({ supplier_pin: 'bad' }), /supplier_pin_check/, 'PIN format');
await fails(inv({ vat: '7000' }), /check/, 'VAT cannot exceed the amount');
await fails(inv({ payment_status: 'paid', paid_amount: '10' }), /check/, 'paid means paid in full');
await fails(inv({ payment_status: 'part_paid', paid_amount: '0' }), /check/, 'part paid means some was paid');
await fails(inv({ payment_status: 'unpaid', paid_amount: '10' }), /check/, 'unpaid means nothing paid');
await inv({ payment_status: 'part_paid', paid_amount: '1000' }); await inv({ payment_status: 'paid', paid_amount: '6500' }); checks++;
await fails(insert('supplier_invoices', { business_id: biz, supplier_id: mama, invoice_status: 'none' }), /check/, 'no invoice needs a reason');
await insert('supplier_invoices', { business_id: biz, supplier_id: mama, invoice_status: 'none', no_invoice_reason: 'Market trader, no receipt book', amount: '800' }); checks++;
await insert('supplier_invoices', { business_id: biz, supplier_id: mama, invoice_status: 'none', no_invoice_reason: 'Another market buy', amount: '300' }); checks++;   // several invoice-less rows are fine
await fails(inv({ supplier_id: foreignSupplier }), /foreign key|violates/, 'another business\'s supplier');

// ---------------------------------------------------------------------------------------------------------------
// goods_receipts and grn_lines
// ---------------------------------------------------------------------------------------------------------------
const grn = (extra = {}) => insert('goods_receipts', { business_id: biz, number: `GRN-2026-${String(++n).padStart(4, '0')}`, location_id: ids.centerLocationId, supplier_id: mama, po_id: p1, ...extra });
const g1 = await grn({ delivery_note_no: 'DN-77' });
eq((await one(`select status from public.goods_receipts where id = $1`, [g1])).status, 'draft', 'a receipt starts as a draft');
await fails(grn({ po_id: null }), /goods_receipts_check|check/, 'an unplanned receipt needs a reason');
await grn({ po_id: null, unplanned_reason: 'Delivery turned up without an order' }); checks++;
await fails(grn({ number: 'GRN-2026-9001', po_id: null, unplanned_reason: 'x' }).then(async () => grn({ number: 'GRN-2026-9001', po_id: null, unplanned_reason: 'x' })), /goods_receipts_business_id_number_key/, 'GRN number unique per business');
await fails(grn({ status: 'posted', posted_at: new Date().toISOString() }), /starts as a draft/, 'a receipt starts as a draft');
await fails(grn({ invoice_id: '00000000-0000-4000-8000-000000000000' }), /foreign key|violates/, 'invoice must exist');
const gl = (grnId, extra = {}) => insert('grn_lines', { business_id: biz, grn_id: grnId, position: 0, po_line_id: l1, item_id: flour, entered_qty: '1', entered_unit: 'sack', unit_factor: '25000',
  qty_ordered_base: '50000', qty_received_base: '25000', unit_cost: '0.130000', ...extra });
const gl1 = await gl(g1, { batch_no: 'B-9', expiry_date: '2027-05-01' });
eq(await one(`select qty_rejected_base::text as r, unit_cost::text as c, batch_no, expiry_date::text as e, movement_id from public.grn_lines where id = $1`, [gl1]),
  { r: '0.0000', c: '0.130000', batch_no: 'B-9', e: '2027-05-01', movement_id: null }, 'cost per base unit has six decimals; batch and expiry stored');
await fails(gl(g1, { position: 1, qty_rejected_base: '500' }), /reject_reason|check/, 'a rejection needs a reason');
await gl(g1, { position: 1, qty_received_base: '0', qty_rejected_base: '500', reject_reason: 'Torn bags' }); checks++;
await fails(gl(g1, { position: 2, qty_received_base: '0' }), /check/, 'a line receives or rejects something');
await fails(gl(g1, { position: 2, item_id: foreignItem }), /foreign key|violates/, 'another business\'s item');
await db.query(`update public.goods_receipts set invoice_id = $2 where id = $1`, [g1, i1]); checks++;
// posting: lines get their movement, then the receipt is posted
const movementId = (await one(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason) values ($1, $2, $3, 25000, 65000, 'added') returning id`, [biz, ids.centerLocationId, flour])).id;
await db.query(`update public.grn_lines set movement_id = $2 where id = $1`, [gl1, movementId]); checks++;
await fails(db.query(`update public.goods_receipts set status = 'posted' where id = $1`, [g1]), /posted_at|check/, 'posted needs posted_at');
await db.query(`update public.goods_receipts set status = 'posted', posted_at = now() where id = $1`, [g1]); checks++;
await fails(db.query(`update public.grn_lines set qty_received_base = 1 where id = $1`, [gl1]), /posted goods receipt can't be changed/, 'posted lines are frozen');
await fails(gl(g1, { position: 5 }), /posted goods receipt can't be changed/, 'no new lines on a posted receipt');
await fails(db.query(`delete from public.grn_lines where id = $1`, [gl1]), /posted goods receipt can't be changed/, 'no line deletion on a posted receipt');
await fails(db.query(`update public.goods_receipts set delivery_note_no = 'other' where id = $1`, [g1]), /can't be edited/, 'a posted receipt is not editable');
await db.query(`update public.goods_receipts set notes = 'checked by owner' where id = $1`, [g1]); checks++;
await fails(db.query(`delete from public.goods_receipts where id = $1`, [g1]), /can't be deleted/, 'a posted receipt cannot be deleted');
await fails(db.query(`update public.goods_receipts set status = 'draft' where id = $1`, [g1]), /can't go from posted to draft/, 'posted does not go back to draft');
await fails(db.query(`delete from public.stock_movements where id = $1`, [movementId]), /append-only|can't|cannot|foreign|stock/i, 'the ledger movement of a receipt line stays');

// ---------------------------------------------------------------------------------------------------------------
// supplier_returns
// ---------------------------------------------------------------------------------------------------------------
const ret = (extra = {}) => insert('supplier_returns', { business_id: biz, number: `RET-2026-${String(++n).padStart(4, '0')}`, supplier_id: mama, location_id: ids.centerLocationId, grn_id: g1, ...extra });
const r1 = await ret({ reason: 'Wrong flour' });
await fails(ret({ number: 'RET-26' }), /number_check/, 'RET number format');
await fails(ret({ grn_id: '00000000-0000-4000-8000-000000000000' }), /foreign key|violates/, 'the receipt must exist');
const rl = (retId, extra = {}) => insert('supplier_return_lines', { business_id: biz, return_id: retId, grn_line_id: gl1, item_id: flour, qty_base: '5000', reason: 'Damaged', credit_amount: '650.00', ...extra });
const rl1 = await rl(r1);
await fails(rl(r1), /supplier_return_lines_return_id_grn_line_id_key/, 'a receipt line is returned once per return');
await fails(rl(await ret(), { qty_base: '0' }), /qty_base_check/, 'quantity above zero');
await fails(rl(await ret(), { reason: ' ' }), /reason_check/, 'a return line needs a reason');
await db.query(`update public.supplier_returns set status = 'posted', posted_at = now(), credit_total = 650 where id = $1`, [r1]); checks++;
await fails(db.query(`update public.supplier_return_lines set qty_base = 1 where id = $1`, [rl1]), /posted supplier return can't be changed/, 'posted return lines are frozen');
await fails(db.query(`update public.supplier_returns set reason = 'later' where id = $1`, [r1]), /posted supplier return can't be changed/, 'a posted return is final');
await fails(db.query(`delete from public.supplier_returns where id = $1`, [r1]), /can't be deleted/, 'a posted return cannot be deleted');

// ---------------------------------------------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------------------------------------------
const sha = 'a'.repeat(64);
const att = (extra = {}) => insert('attachments', { business_id: biz, entity_type: 'grn', entity_id: g1, location_id: ids.centerLocationId, storage_path: `${biz}/grn/${crypto.randomUUID()}.jpg`,
  mime: 'image/jpeg', size_bytes: 120000, sha256: sha, uploaded_by: users.owner, ...extra });
const a1 = await att();
eq((await one(`select storage_bucket, deleted_at from public.attachments where id = $1`, [a1])), { storage_bucket: 'inventory-evidence', deleted_at: null }, 'private bucket by default, not deleted');
await fails(att({ mime: 'image/gif' }), /mime_check/, 'mime allow-list');
await fails(att({ mime: 'text/html' }), /mime_check/, 'no html');
await fails(att({ size_bytes: 10485761 }), /size_bytes_check/, 'at most 10 MB');
await fails(att({ size_bytes: 0 }), /size_bytes_check/, 'not empty');
await fails(att({ sha256: 'xyz' }), /sha256_check/, 'sha256 shape');
await fails(att({ entity_type: 'menu' }), /entity_type_check/, 'entity types');
await fails(att({ storage_path: `${otherBiz}/grn/x.jpg` }), /attachments_path_in_business/, 'path must start with the business id');
await fails(att({ storage_bucket: 'restaurant-media' }), /storage_bucket_check/, 'only the private bucket');
const dup = `${biz}/po/fixed.pdf`;
await att({ storage_path: dup, mime: 'application/pdf', entity_type: 'po', entity_id: p1 }); checks++;
await fails(att({ storage_path: dup }), /attachments_storage_bucket_storage_path_key/, 'storage path is unique');
await att({ location_id: null, entity_type: 'invoice', entity_id: i1 }); checks++;   // owner-only evidence
await att({ location_id: null, entity_type: 'emergency', entity_id: crypto.randomUUID() }); checks++;  // entity may be in a later migration
await fails(att({ location_id: '00000000-0000-4000-8000-000000000000' }), /foreign key|violates/, 'location must exist');
await fails(db.query(`update public.attachments set size_bytes = 5 where id = $1`, [a1]), /can't be changed/, 'attachment fields cannot be edited');
await fails(db.query(`delete from public.attachments where id = $1`, [a1]), /can't be deleted/, 'attachments cannot be deleted');
await db.query(`update public.attachments set deleted_at = now(), deleted_by = $2 where id = $1`, [a1, users.owner]); checks++;
await fails(db.query(`update public.attachments set deleted_at = null, deleted_by = null where id = $1`, [a1]), /can't be changed/, 'a soft delete is one-way');
eq((await one(`select count(*)::int as n from public.attachments where deleted_at is null and entity_id = $1`, [g1])).n, 0, 'soft-deleted rows drop out of the live index');

// ---------------------------------------------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------------------------------------------
for (const t of ['purchase_orders', 'po_lines', 'supplier_invoices', 'goods_receipts', 'grn_lines', 'supplier_returns', 'supplier_return_lines', 'attachments']) {
  eq((await one(`select relrowsecurity as on from pg_class where oid = 'public.${t}'::regclass`)).on, true, `${t}: RLS enabled`);
  await fails(asUser(db, users.owner, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: owner cannot read through the browser role`);
  await fails(asUser(db, users.manager, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: manager cannot either`);
}

// ---------------------------------------------------------------------------------------------------------------
// Down migration
// ---------------------------------------------------------------------------------------------------------------
await fails(db.exec(readSql(DOWN)), /Refusing rollback of 016: .*purchase orders/, 'down refuses while purchase orders exist');
eq((await one(`select to_regclass('public.purchase_orders') is not null as there`)).there, true, 'the refusal changed nothing');
// The guards block deleting posted documents, but a whole business going away still cascades (the other business holds a draft PO, a draft
// receipt and evidence).
const foreignPo = (await one(`select id from public.purchase_orders where business_id = $1`, [otherBiz])).id;
await insert('attachments', { business_id: otherBiz, entity_type: 'po', entity_id: foreignPo, storage_path: `${otherBiz}/po/x.pdf`, mime: 'application/pdf', size_bytes: 10, sha256: sha });
await db.query(`delete from public.restaurants where business_id = $1`, [otherBiz]);
await db.query(`delete from public.businesses where id = $1`, [otherBiz]);
eq((await one(`select (select count(*) from public.purchase_orders where business_id = $1)::int + (select count(*) from public.attachments where business_id = $1)::int as n`, [otherBiz])).n, 0, 'deleting a business cascades through its purchasing rows and evidence');
// Clearing the first business's finished documents by hand (guards bypassed, as a DBA export-and-clear would).
await db.exec(`set session_replication_role = replica`);
for (const t of ['supplier_return_lines', 'supplier_returns', 'grn_lines', 'goods_receipts', 'supplier_invoices', 'po_lines', 'purchase_orders', 'attachments']) await db.query(`delete from public.${t}`);
await db.exec(`set session_replication_role = origin`);
await db.exec(readSql(DOWN));
eq((await one(`select to_regclass('public.purchase_orders') is null and to_regclass('public.po_lines') is null and to_regclass('public.goods_receipts') is null
  and to_regclass('public.grn_lines') is null and to_regclass('public.supplier_invoices') is null and to_regclass('public.supplier_returns') is null
  and to_regclass('public.supplier_return_lines') is null and to_regclass('public.attachments') is null as gone`)).gone, true, 'down drops the eight tables');
eq((await one(`select count(*)::int as n from pg_proc where proname in ('po_guard', 'po_line_guard', 'grn_guard', 'grn_line_guard', 'return_guard', 'return_line_guard', 'attachment_guard')`)).n, 0, 'and the guard functions');
eq((await one(`select to_regclass('public.suppliers') is not null and to_regclass('public.inventory_number_sequences') is not null and to_regclass('public.stock_items') is not null as kept`)).kept, true, '012-015 objects untouched');
await db.exec(readSql(DOWN)); checks++;
await db.exec(readSql(UP));
eq((await one(`select to_regclass('public.purchase_orders') is not null as back`)).back, true, '016 re-applies after a rollback');

console.log(`Migration 016: ${checks} checks passed (disposable PGlite database).`);
await db.close();
