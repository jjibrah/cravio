// Migration 020 (proposed): stock counts, count lines and counter entries. Rehearsal on PGlite: apply over a seeded database (012-019 present),
// no seed rows, constraints, guards (frozen snapshot, status order, append-only entries, nothing after posted, one open full count per location),
// RLS, the WATERMARK formula proven on the migrated schema (snapshot 100, 20 sold, counted 70, 5 sold after -> variance -10, system ends 65), down migration.
// Usage: node backend/tests/inv/migration-020.test.js
import assert from 'node:assert/strict';
import { asUser, readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';
import { inventoryBefore } from './migrations.js';
import { makeItem, receive } from './helpers.js';
import { post } from '../../src/inventory/ledger.js';
import { enter, lineOf, settleAndPost, startCount, varianceOf } from './count-watermark.js';

const UP = 'migrations/020_counts.sql';
const DOWN = 'proposed/020_counts.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(`${e.message} ${e.constraint || ''} ${e.hint || ''}`, re, m); return true; }, m);
  checks++;
};

const f = await inventoryFixture({ extra: inventoryBefore(20) });
const { db, ids, users } = f;
const biz = ids.businessId;
const loc = ids.branchLocationId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const tx = (fn) => db.transaction(fn);
const flour = await makeItem(db, biz, 'Flour');
await receive(db, { businessId: biz, locationId: loc, itemId: flour, qty: '1000', unitCost: '0.1' });
const census = async () => one(`select (select count(*) from public.stock_items)::int as items, (select count(*) from public.stock_movements)::int as movements,
  (select count(*) from public.approvals)::int as approvals, (select count(*) from public.stock_balances)::int as balances, (select count(*) from public.inventory_settings)::int as settings`);
const before = await census();
eq(await one(`select to_regclass('public.stock_counts') is null as absent`), { absent: true }, '020 is not applied yet');
await db.exec(readSql(UP));
eq(await census(), before, 'applying 020 changed no existing row');
eq((await one(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('stock_counts', 'stock_count_lines', 'stock_count_entries')`)).n, 3, 'three new tables');
eq(await one(`select (select count(*) from public.stock_counts)::int as c, (select count(*) from public.stock_count_lines)::int as l, (select count(*) from public.stock_count_entries)::int as e`), { c: 0, l: 0, e: 0 }, 'no seed rows');
await db.exec(readSql(UP)); checks++;
eq(await census(), before, 're-running 020 is harmless');

const insert = async (table, row) => {
  const keys = Object.keys(row);
  return (await db.query(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k]))).rows[0].id;
};
let n = 0;
const count = (extra = {}) => insert('stock_counts', { business_id: biz, location_id: loc, number: `CNT-2026-${String(++n).padStart(4, '0')}`, created_by: users.manager, ...extra });
const setStatus = (id, status, more = '') => db.query(`update public.stock_counts set status = $2${more} where id = $1`, [id, status]);

// ---- stock_counts ----
const c1 = await count();
eq(await one(`select type, blind, status, category_ids, item_ids, snapshot_at, review_lines from public.stock_counts where id = $1`, [c1]),
  { type: 'full', blind: false, status: 'open', category_ids: [], item_ids: [], snapshot_at: null, review_lines: null }, 'defaults');
await fails(count({ number: 'CNT-2026-0001' }), /stock_counts_business_id_number_key/, 'number unique per business');
await fails(count({ type: 'quick' }), /type_check/, 'known types');
await fails(count({ status: 'done' }), /status_check|stock_counts_started/, 'known statuses');
await fails(count({ location_id: crypto.randomUUID() }), /foreign key|violates/, 'location must exist');
await fails(count({ status: 'counting' }), /stock_counts_started/, 'a started count has its snapshot');
await fails(count({ snapshot_at: new Date().toISOString() }), /stock_counts_snapshot_pair/, 'snapshot time and watermark go together');
await fails(count({ type: 'full' }), /stock_counts_one_open_full/, 'second open FULL count at one location refused');
const cycle = await count({ type: 'cycle', number: 'CNT-2026-0900' });
const spot = await count({ type: 'spot', number: 'CNT-2026-0901' });
ok(cycle && spot, 'cycle and spot counts may overlap (the service checks the items)');
const other = await count({ location_id: ids.centerLocationId, number: 'CNT-2026-0902' });
ok(other, 'a full count at another location is fine');
await setStatus(other, 'cancelled', ', cancelled_at = now()');
await setStatus(c1, 'cancelled', ', cancelled_at = now()');
const c1b = await count();
ok(c1b, 'after the first is cancelled, a new full count is allowed');
await db.query(`update public.stock_counts set type = 'cycle' where id = $1`, [c1b]);   // still open: changing type is allowed until the snapshot
const cmd = crypto.randomUUID();
await count({ type: 'spot', command_id: cmd, number: 'CNT-2026-0903' });
await fails(count({ type: 'spot', command_id: cmd, number: 'CNT-2026-0904' }), /stock_counts_command/, 'a retried request id is unique per business');
await fails(db.query(`update public.stock_counts set status = 'posted', posted_at = now() where id = $1`, [cycle]), /can't become posted/, 'open can not jump to posted');
await fails(db.query(`update public.stock_counts set status = 'cancelled' where id = $1`, [cycle]), /stock_counts_cancelled/, 'cancelled needs its time');
await fails(db.query(`update public.stock_counts set status = 'open' where id = $1`, [c1]), /cancelled count can't be changed/, 'a cancelled count never changes');
await fails(db.query(`update public.stock_counts set note = 'x' where id = $1`, [c1]), /cancelled count can't be changed/, 'not even its note');
eq(await one(`select count(*)::int as n from public.stock_counts where status = 'cancelled'`), { n: 2 }, 'two cancelled so far');
await db.query(`delete from public.stock_counts where id = $1`, [spot]); checks++;   // an open, unstarted session can be removed

// ---- the real flow: status order, frozen snapshot, entries append-only, nothing after posted ----
const full = await startCount(db, { businessId: biz, locationId: ids.centerLocationId, number: 'CNT-2026-1000', itemIds: [flour], actorId: users.manager });
const fl = await lineOf(db, full, flour);
eq(await one(`select status, snapshot_at is not null as snap, snapshot_movement_id is not null as wm from public.stock_counts where id = $1`, [full]), { status: 'counting', snap: true, wm: true }, 'started: snapshot taken');
await fails(db.query(`update public.stock_count_lines set expected_base = 999 where id = $1`, [fl]), /frozen once the count has started/, 'expected_base cannot change after start');
await fails(db.query(`update public.stock_count_lines set snapshot_movement_id = 1 where id = $1`, [fl]), /frozen once the count has started/, 'nor the line watermark');
await fails(db.query(`update public.stock_counts set snapshot_at = now() - interval '1 day' where id = $1`, [full]), /fixed once it has started|written once/, 'nor the count snapshot');
await fails(db.query(`update public.stock_counts set type = 'spot' where id = $1`, [full]), /fixed once it has started/, 'nor its type');
await fails(db.query(`insert into public.stock_count_lines (count_id, business_id, item_id, expected_base) values ($1, $2, $3, 5)`, [full, biz, await makeItem(db, biz, 'Late item')]), /only be added while the count is still open/, 'no line added after the snapshot');
const e1 = await enter(db, fl, 7, { counterId: users.manager });
await fails(db.query(`update public.stock_count_entries set qty_base = 8 where id = $1`, [e1]), /count_entry_append_only|cannot be changed/, 'an entry cannot be edited');
await fails(db.query(`delete from public.stock_count_entries where id = $1`, [e1]), /count_entry_append_only|cannot be changed/, 'nor deleted');
await fails(db.query(`insert into public.stock_count_entries (line_id, qty_base, ledger_watermark) values ($1, -1, 0)`, [fl]), /qty_base_check/, 'a counted quantity is not negative');
await fails(db.query(`delete from public.stock_count_lines where id = $1`, [fl]), /can't be deleted/, 'a line cannot be deleted');
await fails(db.query(`delete from public.stock_counts where id = $1`, [full]), /can't be deleted/, 'a started count cannot be deleted');
await fails(db.query(`update public.stock_counts set status = 'approved' where id = $1`, [full]), /can't become approved/, 'counting cannot skip review');
await setStatus(full, 'under_review');
await enter(db, fl, 7, { counterId: users.waiter, isRecount: true }); checks++;                       // a recount arrives during review
await setStatus(full, 'counting'); await setStatus(full, 'under_review');                            // back for a recount and forward again
await db.query(`update public.stock_count_lines set status = 'settled', decision = 'accepted', chosen_entry_id = $2, final_counted_base = 7, movements_since_base = 0, variance_base = 7, variance_value = 0.7 where id = $1`, [fl, e1]); checks++;
await fails(db.query(`update public.stock_count_lines set decision = 'skipped' where id = $1`, [fl]), /stock_count_lines_skip/, 'skipping needs a reason');
await db.query(`update public.stock_counts set reviewed_by = $2, reviewed_at = now(), review_lines = 1, review_expected_value = 0, review_variance_value = 0.7, review_variance_pct = 100, review_unpriced_lines = 0 where id = $1`, [full, users.owner]); checks++;
await setStatus(full, 'approved', `, approved_by = '${users.owner}', approved_at = now()`);
await fails(db.query(`update public.stock_count_lines set variance_base = 0 where id = $1`, [fl]), /frozen: what was approved is what posts/, 'approved: the line numbers are frozen');
await fails(db.query(`update public.stock_counts set review_variance_value = 0 where id = $1`, [full]), /frozen: what was approved is what posts/, 'approved: the totals are frozen');
await fails(enter(db, fl, 9), /not taking numbers any more/, 'approved: no more entries');
await db.query(`update public.stock_count_lines set movement_id = null where id = $1`, [fl]); checks++;   // only the movement id may be written (null -> value is the real use)
await setStatus(full, 'posted', ', posted_at = now()');
await fails(db.query(`update public.stock_count_lines set variance_base = 1 where id = $1`, [fl]), /posted count can't be changed/, 'posted: lines never change');
await fails(db.query(`update public.stock_counts set note = 'late' where id = $1`, [full]), /posted count can't be changed/, 'posted: the count never changes');
await fails(enter(db, fl, 9), /not taking numbers any more/, 'posted: no entries');
await fails(db.query(`delete from public.stock_counts where id = $1`, [full]), /can't be deleted/, 'posted: not deletable');
await fails(db.query(`delete from public.stock_count_entries where line_id = $1`, [fl]), /cannot be changed/, 'posted: entries not deletable');
const unpriced = await count({ number: 'CNT-2026-1100', location_id: ids.centerLocationId });
ok(unpriced, 'once the full count is posted the location can start another');

// ---- the watermark formula on the migrated schema (spike C1/C2/C6/C4) ----
const sell = (item, qty, location = loc) => tx((t) => post(t, { businessId: biz, locationId: location, itemId: item, qty: String(-qty), reason: 'pos_consumption', idempotencyKey: crypto.randomUUID() }));
const buy = (item, qty, extra = {}) => tx((t) => post(t, { businessId: biz, locationId: loc, itemId: item, qty: String(qty), reason: 'purchase_receipt', unitCost: '0.1', idempotencyKey: crypto.randomUUID(), ...extra }));
const onHand = async (item) => Number((await one(`select coalesce(sum(on_hand), 0)::text as n from public.stock_balances where location_id = $1 and item_id = $2`, [loc, item])).n);
await setStatus(unpriced, 'cancelled', ', cancelled_at = now()');
await setStatus(c1b, 'cancelled', ', cancelled_at = now()');
const sugar = await makeItem(db, biz, 'Sugar');
await receive(db, { businessId: biz, locationId: loc, itemId: sugar, qty: '100', unitCost: '1' });
const wm = await startCount(db, { businessId: biz, locationId: loc, number: 'CNT-2026-2000', itemIds: [sugar], actorId: users.manager });
const wl = await lineOf(db, wm, sugar);
await sell(sugar, 20);                                   // 20 sold while counting
const we = await enter(db, wl, 70, { counterId: users.manager });   // the shelf holds 70
await sell(sugar, 5);                                    // 5 more sold after the count, before posting
const v = await varianceOf(db, we);
eq(v, { expectedAtSnapshot: 100, movementsSince: -20, expectedAtCount: 80, counted: 70, variance: -10 }, 'snapshot 100, 20 sold, counted 70: variance -10 (the 5 sold after the entry are not found stock)');
eq(await onHand(sugar), 75, 'the system said 75 while the shelf held 65');
eq(await settleAndPost(db, { businessId: biz, locationId: loc, countId: wm, lineId: wl, entryId: we, actorId: users.owner }), -10, 'the correction is -10');
eq(await onHand(sugar), 65, 'after posting: 65 = what the shelf holds (70 counted, then 5 sold)');
eq(await one(`select delta::text as d, reason, ref_type, idempotency_key from public.stock_movements where item_id = $1 and reason = 'count_correction'`, [sugar]),
  { d: '-10.0000', reason: 'count_correction', ref_type: 'count', idempotency_key: `count:${wm}:${wl}` }, 'one count_correction of exactly the stored variance, keyed count:<id>:<line>');
eq(await one(`select movements_since_base::text as m, variance_base::text as v, (movement_id is not null) as linked, status from public.stock_count_lines where id = $1`, [wl]),
  { m: '-20.0000', v: '-10.0000', linked: true, status: 'settled' }, 'the numbers are stored on the line at review');
// the literal "since the snapshot at posting time" wording would have said -5 and left 70
eq(Number((await one(`select coalesce(sum(delta), 0)::text as s from public.stock_movements where item_id = $1 and id > $2 and reason = 'pos_consumption'`, [sugar, (await one('select snapshot_movement_id::text as s from public.stock_count_lines where id = $1', [wl])).s])).s), -25, 'posting-time movements since the snapshot = -25 (the plan\'s literal wording would give variance -5 and end at 70)');

// a delivery back-dated 3 days, entered during the count, is "since the snapshot" by id (a timestamp comparison would miss it); two counters keep both numbers
const rice = await makeItem(db, biz, 'Rice');
await receive(db, { businessId: biz, locationId: loc, itemId: rice, qty: '100', unitCost: '1' });
const wm2 = await startCount(db, { businessId: biz, locationId: loc, number: 'CNT-2026-2001', itemIds: [rice], actorId: users.manager });
const rl = await lineOf(db, wm2, rice);
await buy(rice, 30, { occurredAt: new Date(Date.now() - 3 * 86_400_000) });
const r1 = await enter(db, rl, 130, { counterId: users.manager });
await sell(rice, 3);
const r2 = await enter(db, rl, 126, { counterId: users.waiter });
eq([(await varianceOf(db, r1)).movementsSince, (await varianceOf(db, r1)).variance], [30, 0], 'back-dated receipt counts as a movement since the snapshot (variance 0)');
eq([(await varianceOf(db, r2)).movementsSince, (await varianceOf(db, r2)).variance], [27, -1], 'the second counter is judged against the ledger at ITS moment (-1)');
eq((await one(`select count(*)::int as n from public.stock_count_entries where line_id = $1`, [rl])).n, 2, 'both entries are kept');
await setStatus(wm2, 'cancelled', ', cancelled_at = now()');
eq(await onHand(rice), 127, 'cancel posts nothing');

// ---- RLS ----
for (const t of ['stock_counts', 'stock_count_lines', 'stock_count_entries']) {
  eq((await one(`select relrowsecurity as on from pg_class where oid = 'public.${t}'::regclass`)).on, true, `${t}: RLS enabled`);
  await fails(asUser(db, users.owner, (t2) => t2.query(`select * from public.${t}`)), /permission denied/, `${t}: owner cannot read through the browser role`);
  await fails(asUser(db, users.manager, (t2) => t2.query(`select * from public.${t}`)), /permission denied/, `${t}: manager cannot either`);
}

// ---- down ----
await fails(db.exec(readSql(DOWN)), /Refusing rollback of 020: .*stock counts/, 'down refuses while counts exist');
eq((await one(`select to_regclass('public.stock_counts') is not null as there`)).there, true, 'the refusal changed nothing');
await db.exec(`set session_replication_role = replica`);
for (const t of ['stock_count_entries', 'stock_count_lines', 'stock_counts']) await db.query(`delete from public.${t}`);
await db.exec(`set session_replication_role = origin`);
await db.exec(readSql(DOWN));
eq((await one(`select to_regclass('public.stock_counts') is null and to_regclass('public.stock_count_lines') is null and to_regclass('public.stock_count_entries') is null as gone`)).gone, true, 'down drops the three tables');
eq((await one(`select count(*)::int as n from pg_proc where proname in ('count_guard', 'count_line_guard', 'count_entries_guard')`)).n, 0, 'and the guard functions');
eq((await one(`select to_regclass('public.approvals') is not null and to_regclass('public.stock_movements') is not null as kept`)).kept, true, '012-019 objects untouched');
await db.exec(readSql(DOWN)); checks++;
await db.exec(readSql(UP));
eq((await one(`select to_regclass('public.stock_counts') is not null as back`)).back, true, '020 re-applies after a rollback');

console.log(`Migration 020: ${checks} checks passed (disposable PGlite database).`);
await db.close();
