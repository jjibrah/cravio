// Migration 019 (proposed): reason codes, wastage records and lines, stock adjustments, allowance usage, widened attachments check.
// Rehearsal on PGlite: apply over a seeded database (012-017 present), no seed rows, exactly-one-subject check, guards, RLS, down migration.
// Usage: node backend/tests/inv/migration-019.test.js
import assert from 'node:assert/strict';
import { asUser, readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';
import { proposedBefore } from './migrations.js';
import { makeItem } from './helpers.js';

const UP = 'proposed/019_wastage_adjustments.sql';
const DOWN = 'proposed/019_wastage_adjustments.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(`${e.message} ${e.constraint || ''}`, re, m); return true; }, m);
  checks++;
};

const f = await inventoryFixture({ extra: proposedBefore(19) });
const { db, ids, users } = f;
const biz = ids.businessId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const flour = await makeItem(db, biz, 'Flour');
const census = async () => one(`select (select count(*) from public.stock_items)::int as items, (select count(*) from public.stock_movements)::int as movements,
  (select count(*) from public.approvals)::int as approvals, (select count(*) from public.attachments)::int as attachments, (select count(*) from public.inventory_settings)::int as settings`);
const before = await census();
eq(await one(`select to_regclass('public.wastage_records') is null as absent`), { absent: true }, '019 is not applied yet');
await db.exec(readSql(UP));
eq(await census(), before, 'applying 019 changed no existing row');
eq((await one(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('stock_reason_codes', 'wastage_records', 'wastage_record_lines', 'stock_adjustments', 'allowance_usage')`)).n, 5, 'five new tables');
eq(await one(`select (select count(*) from public.stock_reason_codes)::int as codes, (select count(*) from public.wastage_records)::int as w, (select count(*) from public.stock_adjustments)::int as a, (select count(*) from public.allowance_usage)::int as u`),
  { codes: 0, w: 0, a: 0, u: 0 }, 'no seed rows: the service seeds reason codes on first use');
await db.exec(readSql(UP)); checks++;
eq(await census(), before, 're-running 019 is harmless');

const insert = async (table, row) => {
  const keys = Object.keys(row);
  return (await db.query(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k]))).rows[0].id;
};
const uuid = () => crypto.randomUUID();

// ---- reason codes ----
const code = (extra = {}) => insert('stock_reason_codes', { business_id: biz, kind: 'wastage', code: 'spoiled', label: 'Spoiled', ...extra });
const spoiled = await code();
eq(await one(`select active, needs_photo, needs_note, position from public.stock_reason_codes where id = $1`, [spoiled]), { active: true, needs_photo: false, needs_note: false, position: 0 }, 'defaults');
await fails(code(), /stock_reason_codes_business_id_kind_code_key/, 'a code is unique per business and kind');
await code({ kind: 'adjustment' }); checks++;                       // the same code under another kind is fine
await fails(code({ code: 'Not Snake' }), /code_check/, 'codes are snake_case');
await fails(code({ code: 'x', label: '   ' }), /label_check/, 'a label is required');
await fails(code({ code: 'y', kind: 'tip' }), /kind_check/, 'known kinds');
await code({ code: 'staff', kind: 'staff_meal', label: 'Staff meal' }); checks++;
await fails(db.query(`update public.stock_reason_codes set code = 'other' where id = $1`, [spoiled]), /can't change/, 'the code never changes');
await fails(db.query(`update public.stock_reason_codes set kind = 'adjustment' where id = $1`, [spoiled]), /can't change/, 'nor the kind');
await db.query(`update public.stock_reason_codes set label = 'Gone off', active = false where id = $1`, [spoiled]); checks++;   // renaming and switching off are fine

// ---- wastage ----
let n = 0;
const rec = (extra = {}) => insert('wastage_records', { business_id: biz, location_id: ids.branchLocationId, number: `WST-2026-${String(++n).padStart(4, '0')}`, item_id: flour,
  entered_quantity: '500', entered_unit: 'g', qty_base: '500', reason_code_id: spoiled, reason_text: 'Spoiled', value_kes: '25', status: 'recorded', recorded_by: users.manager, ...extra });
const w1 = await rec();
eq(await one(`select status, cost_unknown, movement_ids, photo_attachment_ids from public.wastage_records where id = $1`, [w1]), { status: 'recorded', cost_unknown: false, movement_ids: [], photo_attachment_ids: [] }, 'defaults');
await fails(rec({ number: 'WST-2026-0001' }), /wastage_records_business_id_number_key/, 'number unique per business');
await fails(rec({ item_id: null }), /wastage_records_one_subject/, 'exactly one of item / dish: neither is refused');
await fails(rec({ menu_item_id: ids.burgerId, menu_item_name: 'Chicken burger' }), /wastage_records_one_subject/, 'exactly one of item / dish: both is refused');
const dish = await rec({ item_id: null, menu_item_id: ids.burgerId, menu_item_name: 'Chicken burger', entered_unit: 'portion', entered_quantity: '2', qty_base: '2', value_kes: null, cost_unknown: true }); checks++;
await fails(rec({ item_id: null, menu_item_id: ids.burgerId }), /wastage_records_dish_has_name/, 'a dish keeps its name');
await fails(rec({ qty_base: '0' }), /qty_base_check/, 'quantity above zero');
await fails(rec({ value_kes: '-1' }), /value_kes_check/, 'cost is not negative');
await fails(rec({ value_kes: null }), /wastage_records_cost_unknown/, 'no value means cost_unknown');
await fails(rec({ reason_code_id: null, reason_text: null }), /wastage_records_has_reason/, 'a reason is required (a code, or the old free text)');
await rec({ reason_code_id: null, reason_text: 'dropped it' }); checks++;
await fails(rec({ status: 'done' }), /status_check/, 'known statuses');
await fails(rec({ location_id: uuid() }), /foreign key|violates/, 'location must exist');
await fails(rec({ item_id: uuid() }), /foreign key|violates/, 'item must exist');
await fails(rec({ reason_code_id: uuid() }), /foreign key|violates/, 'reason must exist');
await fails(rec({ status: 'pending_approval', movement_ids: '{1}' }), /wastage_records_unposted/, 'a record waiting for approval has posted nothing');
const cmd = uuid();
await rec({ command_id: cmd }); await fails(rec({ command_id: cmd }), /wastage_records_command/, 'a retried request id is unique per business');

// Lines, immutability and the decision path.
const lineOf = (record, extra = {}) => insert('wastage_record_lines', { record_id: record, business_id: biz, item_id: flour, position: 0, qty_base: '500', unit_cost: '0.05', value_kes: '25', ...extra });
const l1 = await lineOf(w1);
await fails(lineOf(w1, { position: 1 }), /wastage_record_lines_record_id_item_id_key/, 'one line per item');
await fails(db.query(`update public.wastage_record_lines set qty_base = 1 where id = $1`, [l1]), /can't be edited/, 'lines never change');
await fails(db.query(`delete from public.wastage_record_lines where id = $1`, [l1]), /can't be deleted/, 'lines are not deleted');
await fails(db.query(`update public.wastage_records set value_kes = 1 where id = $1`, [w1]), /can't be edited/, 'what was recorded never changes');
await fails(db.query(`update public.wastage_records set status = 'approved' where id = $1`, [w1]), /can't become/, 'a recorded record can not be "approved" afterwards');
await db.query(`update public.wastage_records set movement_ids = '{7}', posted_at = now() where id = $1`, [w1]); checks++;
await fails(db.query(`update public.wastage_records set movement_ids = '{8}' where id = $1`, [w1]), /written once/, 'the movement ids are written once');
const pend = await rec({ status: 'pending_approval' });
await lineOf(pend); checks++;
const a = await insert('approvals', { business_id: biz, subject_type: 'wastage', subject_id: pend, location_id: ids.branchLocationId, approver_capability: 'inv.adjust.approve', requested_by: users.manager, amount_kes: '25' });
await db.query(`update public.wastage_records set approval_id = $2 where id = $1`, [pend, a]); checks++;
await fails(db.query(`update public.wastage_records set approval_id = null where id = $1`, [pend]), /keeps the approval/, 'the approval stays');
await fails(db.query(`update public.wastage_records set status = 'recorded' where id = $1`, [pend]), /can't become/, 'pending can only be approved or rejected');
await db.query(`update public.wastage_records set status = 'rejected' where id = $1`, [pend]); checks++;
await fails(db.query(`update public.wastage_records set status = 'approved' where id = $1`, [pend]), /can't become/, 'rejected is final');
await fails(db.query(`delete from public.wastage_records where id = $1`, [w1]), /can't be deleted/, 'records are never deleted');
const pend2 = await rec({ status: 'pending_approval' });
await db.query(`update public.wastage_records set status = 'approved' where id = $1`, [pend2]); checks++;
await db.query(`update public.wastage_records set movement_ids = '{9,10}', posted_at = now() where id = $1`, [pend2]); checks++;
await fails(lineOf(pend2), /only be added while/, 'no lines once posted');

// A used reason code can't be deleted.
await fails(db.query(`delete from public.stock_reason_codes where id = $1`, [spoiled]), /can't be deleted/, 'a used reason is deactivated, never deleted');
const unused = await code({ code: 'unused', label: 'Unused' });
await db.query(`delete from public.stock_reason_codes where id = $1`, [unused]); checks++;

// ---- adjustments ----
const adj = (extra = {}) => insert('stock_adjustments', { business_id: biz, location_id: ids.branchLocationId, number: `ADJ-2026-${String(++n).padStart(4, '0')}`, direction: 'gain', item_id: flour,
  entered_quantity: '1', entered_unit: 'kg', qty_base: '1000', reason_code_id: spoiled, status: 'pending_approval', created_by: users.manager, ...extra });
const s1 = await adj();
await fails(adj({ direction: 'sideways' }), /direction_check/, 'gain or loss');
await fails(adj({ reason_code_id: null }), /null value|reason_code_id/, 'a reason is required');
await fails(adj({ status: 'posted' }), /stock_adjustments_posted/, 'posted needs posted_at');
await fails(db.query(`update public.stock_adjustments set qty_base = 1 where id = $1`, [s1]), /can't be edited/, 'what was asked never changes');
await fails(db.query(`update public.stock_adjustments set status = 'posted', posted_at = now() where id = $1`, [s1]), /can't become/, 'pending can not skip approval');
await db.query(`update public.stock_adjustments set status = 'approved' where id = $1`, [s1]); checks++;
await db.query(`update public.stock_adjustments set status = 'posted', posted_at = now() where id = $1`, [s1]); checks++;
await fails(db.query(`update public.stock_adjustments set status = 'rejected' where id = $1`, [s1]), /can't become/, 'posted is final');
await fails(db.query(`delete from public.stock_adjustments where id = $1`, [s1]), /can't be deleted/, 'adjustments are never deleted');

// ---- allowance usage ----
const day = '2026-11-18';
const use = (extra = {}) => insert('allowance_usage', { business_id: biz, location_id: ids.branchLocationId, day, kind: 'staff_meal', portions: '2', value_kes: '300', ...extra });
await use();
await fails(use(), /allowance_usage_business_id_location_id_day_kind_key/, 'one row per branch, day and kind');
await use({ kind: 'complimentary' }); checks++;
await fails(use({ kind: 'snack', day: '2026-11-19' }), /kind_check/, 'known kinds');
await fails(use({ day: '2026-11-19', portions: '-1' }), /portions_check/, 'not negative');

// ---- attachments: widened check ----
const att = (type, extra = {}) => insert('attachments', { business_id: biz, entity_type: type, entity_id: uuid(), location_id: ids.branchLocationId, storage_path: `${biz}/${type}/${uuid()}.jpg`,
  mime: 'image/jpeg', size_bytes: 1000, sha256: 'b'.repeat(64), uploaded_by: users.manager, ...extra });
await att('wastage'); await att('adjustment'); await att('emergency'); checks += 3;
await fails(att('selfie'), /attachments_entity_type_check/, 'other types are still refused');

// ---- RLS ----
for (const t of ['stock_reason_codes', 'wastage_records', 'wastage_record_lines', 'stock_adjustments', 'allowance_usage']) {
  eq((await one(`select relrowsecurity as on from pg_class where oid = 'public.${t}'::regclass`)).on, true, `${t}: RLS enabled`);
  await fails(asUser(db, users.owner, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: owner cannot read through the browser role`);
  await fails(asUser(db, users.manager, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: manager cannot either`);
}

// ---- down ----
await fails(db.exec(readSql(DOWN)), /Refusing rollback of 019: .*wastage records/, 'down refuses while records exist');
eq((await one(`select to_regclass('public.wastage_records') is not null as there`)).there, true, 'the refusal changed nothing');
await db.exec(`set session_replication_role = replica`);
for (const t of ['allowance_usage', 'stock_adjustments', 'wastage_record_lines', 'wastage_records', 'stock_reason_codes']) await db.query(`delete from public.${t}`);
await db.exec(`set session_replication_role = origin`);
await fails(db.exec(readSql(DOWN)), /Refusing rollback of 019: .*wastage\/adjustment attachments/, 'down refuses while wastage photos exist');
await db.exec(`set session_replication_role = replica`);
await db.query(`delete from public.attachments where entity_type in ('wastage', 'adjustment')`);
await db.exec(`set session_replication_role = origin`);
await db.exec(readSql(DOWN));
eq((await one(`select to_regclass('public.stock_reason_codes') is null and to_regclass('public.wastage_records') is null and to_regclass('public.wastage_record_lines') is null
  and to_regclass('public.stock_adjustments') is null and to_regclass('public.allowance_usage') is null as gone`)).gone, true, 'down drops the five tables');
eq((await one(`select count(*)::int as n from pg_proc where proname in ('reason_code_guard', 'wastage_guard', 'wastage_line_guard', 'adjustment_guard')`)).n, 0, 'and the guard functions');
eq((await one(`select to_regclass('public.approvals') is not null and to_regclass('public.attachments') is not null as kept`)).kept, true, '012-017 objects untouched');
await fails(att('wastage'), /attachments_entity_type_check/, 'the attachments check is back to the 016 list');
await att('emergency'); checks++;
await db.exec(readSql(DOWN)); checks++;
await db.exec(readSql(UP));
eq((await one(`select to_regclass('public.wastage_records') is not null as back`)).back, true, '019 re-applies after a rollback');

console.log(`Migration 019: ${checks} checks passed (disposable PGlite database).`);
await db.close();
