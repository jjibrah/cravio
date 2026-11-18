// Migration 018 (proposed): distribution upgrade + reservations + 009 backfill. THE riskiest schema step: it touches tables `main` uses live.
// Rehearsal on PGlite: 009 data is created through main's OWN backend/src/stock/service.js (requests, review, dispatch, receive, cancel) on a database that
// has 012-017 (what the shared database looks like after Release A), then 018 is applied: counts identical, statuses unchanged, backfill idempotent,
// main's service still works for new requests afterwards, the direction guard and partial unique index behave, the backstop refuses, the down file
// refuses when new-world rows exist and restores the 009 shape otherwise.
// Usage: node backend/tests/inv/migration-018.test.js
import assert from 'node:assert/strict';
import { readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';
import { proposedBefore } from './migrations.js';
import * as stock from '../../src/stock/service.js';
import * as ledger from '../../src/inventory/ledger.js';

const UP = 'proposed/018_distribution.sql';
const DOWN = 'proposed/018_distribution.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(`${e.message} ${e.constraint || ''}`, re, m); return true; }, m);
  checks++;
};

const f = await inventoryFixture({ extra: proposedBefore(18) });
const { db, ids, users, helpers } = f;
const { tx } = helpers;
const biz = ids.businessId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const branchA = { restaurantId: ids.branchId, locationId: ids.branchLocationId };
const branchB = await helpers.addBranch('Second branch', { manager: false });
const ctx = (restaurantId) => ({ businessId: biz, restaurantId, actorId: users.owner });
const owner = { businessId: biz, actorId: users.owner };
const WH = ids.centerLocationId;

// ---------------------------------------------------------------------------------------------------------------
// 1. A 009 world, created by main's own code
// ---------------------------------------------------------------------------------------------------------------
const item = async (name) => (await tx((t) => stock.createItem(t, owner, { name }))).id;   // servings
const rice = await item('Rice'); const beans = await item('Beans'); const oil = await item('Oil');
for (const i of [rice, beans, oil]) await tx((t) => stock.adjust(t, { ...owner, locationId: WH }, { kind: 'added', itemId: i, quantity: 100 }));
await db.query(`update public.stock_items set avg_cost = 2.5 where id = $1`, [rice]);       // a cost for one item only

const submit = (c, lines) => tx((t) => stock.submitRequest(t, c, { lines: lines.map(([itemId, quantity]) => ({ itemId, quantity })), note: 'please' }));
const review = (requestId, body) => tx((t) => stock.reviewRequest(t, owner, requestId, body));
const R = {};
R.submitted = await submit(ctx(branchA.restaurantId), [[rice, 10], [beans, 5]]);                // stays submitted
R.cancelled = await submit(ctx(branchA.restaurantId), [[rice, 3]]);
await tx((t) => stock.cancelRequest(t, ctx(branchA.restaurantId), R.cancelled.id));
R.rejected = await submit(ctx(branchB.restaurantId), [[oil, 4]]);
await review(R.rejected.id, { decision: 'reject', note: 'not now' });
R.approved = await submit(ctx(branchB.restaurantId), [[rice, 20], [oil, 8]]);                    // approved, never dispatched
await review(R.approved.id, { decision: 'approve', lines: [{ itemId: rice, approved: 15 }, { itemId: oil, approved: 8 }] });
R.inTransit = await submit(ctx(branchA.restaurantId), [[rice, 12], [beans, 6]]);                // dispatched, on its way
await review(R.inTransit.id, { decision: 'approve' });
R.inTransit.transfer = await tx((t) => stock.dispatch(t, owner, { requestId: R.inTransit.id, note: 'van 1' }));
R.received = await submit(ctx(branchB.restaurantId), [[beans, 10]]);                             // dispatched and received (2 short)
await review(R.received.id, { decision: 'approve' });
R.received.transfer = await tx((t) => stock.dispatch(t, owner, { requestId: R.received.id }));
await tx((t) => stock.receive(t, ctx(branchB.restaurantId), R.received.transfer.id, { lines: [{ itemId: beans, received: 8 }], note: '2 spoiled' }));
R.recalled = await submit(ctx(branchA.restaurantId), [[oil, 5]]);                                // dispatched, dispatch cancelled -> approved again
await review(R.recalled.id, { decision: 'approve' });
const recalledTransfer = await tx((t) => stock.dispatch(t, owner, { requestId: R.recalled.id }));
await tx((t) => stock.cancelDispatch(t, owner, recalledTransfer.id));
const loose = await tx((t) => stock.dispatch(t, owner, { restaurantId: branchA.restaurantId, lines: [{ itemId: oil, quantity: 2 }] }));   // no request

const census = async () => one(`select
  (select count(*) from public.stock_requests)::int as requests, (select count(*) from public.stock_request_lines)::int as request_lines,
  (select count(*) from public.stock_transfers)::int as transfers, (select count(*) from public.stock_transfer_lines)::int as transfer_lines,
  (select count(*) from public.stock_movements)::int as movements, (select count(*) from public.stock_balances)::int as balances,
  (select coalesce(sum(on_hand), 0) from public.stock_balances)::text as on_hand, (select count(*) from public.stock_items)::int as items`);
const statuses = async () => ({
  requests: (await q(`select number, status, note, review_note, requested_by, reviewed_by, reviewed_at from public.stock_requests order by number`)),
  lines: (await q(`select request_id, item_id, requested::text, approved::text from public.stock_request_lines order by request_id, item_id`)),
  transfers: (await q(`select number, code, status, request_id, from_location, to_location, received_at from public.stock_transfers order by number`)),
  tlines: (await q(`select transfer_id, item_id, quantity::text, received::text from public.stock_transfer_lines order by transfer_id, item_id`)),
});
const before = await census();
const beforeRows = await statuses();
eq((await q(`select status, count(*)::int n from public.stock_requests group by status order by status`)),
  [{ status: 'approved', n: 2 }, { status: 'cancelled', n: 1 }, { status: 'dispatched', n: 1 }, { status: 'received', n: 1 }, { status: 'rejected', n: 1 }, { status: 'submitted', n: 1 }], 'the 009 world has every status');
eq((await q(`select status, count(*)::int n from public.stock_transfers group by status order by status`)), [{ status: 'cancelled', n: 1 }, { status: 'in_transit', n: 2 }, { status: 'received', n: 1 }], 'transfers: in transit, received, cancelled');
eq(await one(`select to_regclass('public.stock_reservations') is null as absent`), { absent: true }, '018 is not applied yet');
eq(await one(`select count(*)::int n from information_schema.columns where table_name = 'stock_requests' and column_name in ('kind', 'from_location', 'needs_attention')`), { n: 0 }, 'no new request columns yet');

// ---------------------------------------------------------------------------------------------------------------
// 2. Apply 018: nothing 009 had changes
// ---------------------------------------------------------------------------------------------------------------
await db.exec(readSql(UP));
eq(await census(), before, 'T-MIG-018 counts identical after applying 018');
const after = await statuses();
// from/to location are new columns on stock_requests only; transfer rows keep theirs. Everything 009 had is unchanged.
const same = (rows) => rows.map(({ from_location, to_location, ...rest }) => rest);
eq(same(after.requests), same(beforeRows.requests), 'every request keeps its status, notes and people');
eq(after.lines, beforeRows.lines, 'request lines unchanged');
eq(after.transfers, beforeRows.transfers, 'transfers unchanged (status, code, locations, receipt time)');
eq(after.tlines, beforeRows.tlines, 'transfer lines unchanged');
eq(await one(`select count(*)::int n from public.stock_balances where reserved <> 0`), { n: 0 }, 'NOTHING is reserved by the migration (main\'s dispatch cannot consume a reservation)');
eq(await one(`select (select count(*) from public.stock_reservations)::int r, (select count(*) from public.stock_reservation_events)::int e, (select count(*) from public.transfer_discrepancies)::int d`),
  { r: 0, e: 0, d: 0 }, 'new tables are empty');
eq((await ledger.reconcile(db, { businessId: biz })), [], 'ledger reconciles on hand and reserved');

// 2a. The backfill filled the new metadata
const req = async (n) => one(`select * from public.stock_requests where id = $1`, [n.id]);
for (const [name, r] of Object.entries(R)) {
  const row = await req(r);
  eq([row.kind, row.from_location, row.priority, row.needs_attention], ['stock', WH, 'normal', false], `${name}: kind stock, from the Warehouse, defaults`);
}
eq((await req(R.submitted)).to_location, branchA.locationId, 'to_location = the branch\'s stock location (A)');
eq((await req(R.approved)).to_location, branchB.locationId, 'to_location = the branch\'s stock location (B)');
eq([(await req(R.approved)).approved_by, (await req(R.submitted)).approved_by], [users.owner, null], 'approval metadata copied from the review (only for approved requests)');
eq([(await req(R.received)).completed_at !== null, (await req(R.inTransit)).completed_at, (await req(R.approved)).completed_at], [true, null, null], 'completed_at only for the received one');
const lineOf = (r, i) => one(`select dispatched::text d, received::text r from public.stock_request_lines where request_id = $1 and item_id = $2`, [r.id, i]);
eq([await lineOf(R.inTransit, rice), await lineOf(R.inTransit, beans)], [{ d: '12.0000', r: '0.0000' }, { d: '6.0000', r: '0.0000' }], 'in-transit request: lines dispatched = what left the Warehouse, nothing received');
eq(await lineOf(R.received, beans), { d: '10.0000', r: '8.0000' }, 'received request: dispatched 10, received 8');
eq([await lineOf(R.approved, rice), await lineOf(R.recalled, oil), await lineOf(R.submitted, rice)], Array(3).fill({ d: '0.0000', r: '0.0000' }), 'approved / recalled (dispatch cancelled) / submitted: nothing dispatched');
eq(await one(`select unit_cost::text c from public.stock_transfer_lines where transfer_id = $1 and item_id = $2`, [R.inTransit.transfer.id, rice]), { c: '2.500000' }, 'in-transit line carries the item\'s average cost (no cost on a 009 movement)');
eq(await one(`select unit_cost c from public.stock_transfer_lines where transfer_id = $1`, [R.received.transfer.id]), { c: null }, 'received legacy line: no cost invented');
eq((await q(`select direction, count(*)::int n from public.stock_transfers group by direction`)), [{ direction: 'out', n: 4 }], 'existing transfers are direction out');

// 2b. Re-running is harmless (the migration and the backfill)
const snapshot = async () => ({ requests: await q(`select * from public.stock_requests order by number`), lines: await q(`select * from public.stock_request_lines order by request_id, item_id`), tlines: await q(`select * from public.stock_transfer_lines order by transfer_id, item_id`) });
const snap = await snapshot();
await db.exec(readSql(UP)); checks++;
await db.query(`select private.backfill_distribution_018()`); checks++;
eq(await snapshot(), snap, 'applying 018 again and re-running the backfill changes nothing');
eq(await census(), before, 'counts still identical');

// ---------------------------------------------------------------------------------------------------------------
// 3. main's own code keeps working on the upgraded schema (the whole 009 flow, for NEW requests)
// ---------------------------------------------------------------------------------------------------------------
{
  const r = await submit(ctx(branchA.restaurantId), [[rice, 4], [oil, 2]]);
  await review(r.id, { decision: 'approve', lines: [{ itemId: rice, approved: 3 }, { itemId: oil, approved: 2 }] });
  const t = await tx((t2) => stock.dispatch(t2, owner, { requestId: r.id }));
  eq((await one(`select status, direction, over_qty::text as over_qty from public.stock_transfers where id = $1`, [t.id])), { status: 'in_transit', direction: 'out', over_qty: '0.0000' }, 'main dispatch: in transit, direction out by default');
  eq((await stock.findByCode(db, t.code, [branchA.restaurantId])).id, t.id, 'main: QR code lookup');
  await tx((t2) => stock.receive(t2, ctx(branchA.restaurantId), t.id, { lines: [{ itemId: rice, received: 3 }, { itemId: oil, received: 2 }] }));
  eq((await one(`select status from public.stock_requests where id = $1`, [r.id])).status, 'received', 'main receive: request received');
  eq(await one(`select kind, from_location, needs_attention from public.stock_requests where id = $1`, [r.id]), { kind: 'stock', from_location: null, needs_attention: false },
    'a request main creates after 018 has kind stock; from/to stay empty until the backfill is re-run');
  await db.query(`select private.backfill_distribution_018()`);
  eq([(await one(`select from_location, to_location from public.stock_requests where id = $1`, [r.id]))], [{ from_location: WH, to_location: branchA.locationId }], 're-running the backfill picks up requests main created later');
  eq(await lineOf(r, rice), { d: '3.0000', r: '3.0000' }, '... and their lines');
  // cancel, review, re-dispatch after cancelDispatch: the relaxed unique index lets the same request be dispatched again
  const r2 = await submit(ctx(branchB.restaurantId), [[beans, 2]]);
  await tx((t2) => stock.cancelRequest(t2, ctx(branchB.restaurantId), r2.id));
  await review(R.submitted.id, { decision: 'approve' });
  const redo = await tx((t2) => stock.dispatch(t2, owner, { requestId: R.submitted.id }));
  await tx((t2) => stock.cancelDispatch(t2, owner, redo.id));
  const redo2 = await tx((t2) => stock.dispatch(t2, owner, { requestId: R.submitted.id }));
  ok(redo2.id !== redo.id, 'main: dispatch, cancel the dispatch, dispatch again (one open transfer per request at a time)');
  await tx((t2) => stock.cancelDispatch(t2, owner, redo2.id));
  await tx((t2) => stock.cancelDispatch(t2, owner, loose.id));
  eq((await ledger.reconcile(db, { businessId: biz })), [], 'ledger still reconciles after main\'s flow on the new schema');
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Constraints, guards, indexes
// ---------------------------------------------------------------------------------------------------------------
const insertReq = (status, extra = '') => db.query(`insert into public.stock_requests (business_id, restaurant_id, number, status${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, (select coalesce(max(number), 0) + 1 from public.stock_requests where business_id = $1), $3${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [biz, branchA.restaurantId, status]);
for (const s of ['draft', 'submitted', 'pending_approval', 'approved', 'partially_approved', 'rejected', 'preparing', 'dispatched', 'partially_received', 'received', 'completed', 'cancelled']) {
  await insertReq(s); checks++;
}
await fails(insertReq('lost'), /stock_requests_status_check/, 'unknown request status refused');
await fails(insertReq('draft', `kind='swap'`), /stock_requests_kind_check|violates check/, 'unknown kind refused');
await fails(insertReq('draft', `priority='asap'`), /priority_check/, 'unknown priority refused');
await db.query(`delete from public.stock_requests where status in ('draft', 'pending_approval', 'partially_approved', 'preparing', 'partially_received', 'completed')`);

// Transfer direction guard
let tnum = 1000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => `ABCDEFGH${ALPHA[Math.floor(n / 32) % 32]}${ALPHA[n % 32]}`;
const insertTransfer = (direction, from, to, status = 'in_transit', request = null) => db.query(`insert into public.stock_transfers (business_id, number, code, from_location, to_location, direction, status, request_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [biz, ++tnum, code(tnum), from, to, direction, status, request]);
await insertTransfer('out', WH, branchA.locationId); checks++;
await insertTransfer('return', branchA.locationId, WH); checks++;
await insertTransfer('branch_to_branch', branchA.locationId, branchB.locationId); checks++;
await fails(insertTransfer('out', branchA.locationId, WH), /direction_matches_locations/, 'a transfer out must go Warehouse -> branch');
await fails(insertTransfer('return', WH, branchA.locationId), /direction_matches_locations/, 'a return must go branch -> Warehouse');
await fails(insertTransfer('branch_to_branch', WH, branchA.locationId), /direction_matches_locations/, 'branch to branch needs two branches');
await fails(insertTransfer('sideways', branchA.locationId, branchB.locationId), /direction_matches_locations|direction_check/, 'unknown direction refused');
await fails(db.query(`update public.stock_transfers set direction = 'return' where id = $1`, [R.inTransit.transfer.id]), /direction_matches_locations/, 'changing direction re-checks the locations');
eq((await one(`select count(*)::int n from public.stock_transfers where status = 'pending_approval'`)).n, 0, 'no pending transfers yet');
await insertTransfer('branch_to_branch', branchA.locationId, branchB.locationId, 'pending_approval'); checks++;

// One OPEN transfer per request (partial index): received/cancelled transfers no longer block the remainder.
const rq = (await insertReq('approved')).rows[0].id;
await db.query(`insert into public.stock_request_lines (request_id, item_id, requested, approved) values ($1, $2, 10, 10)`, [rq, rice]);
const t1 = (await insertTransfer('out', WH, branchA.locationId, 'in_transit', rq)).rows[0].id;
await fails(insertTransfer('out', WH, branchA.locationId, 'in_transit', rq), /stock_transfers_one_per_request/, 'two open transfers for one request refused');
await fails(insertTransfer('out', WH, branchA.locationId, 'pending_approval', rq), /stock_transfers_one_per_request/, 'pending_approval counts as open');
await db.query(`update public.stock_transfers set status = 'partially_received' where id = $1`, [t1]);
await fails(insertTransfer('out', WH, branchA.locationId, 'in_transit', rq), /stock_transfers_one_per_request/, 'partially_received counts as open');
await db.query(`update public.stock_transfers set status = 'received', received_at = now() where id = $1`, [t1]);
await insertTransfer('out', WH, branchA.locationId, 'in_transit', rq); checks++;     // the remainder can go once the first is received

// Transfer line columns and checks
await db.query(`insert into public.stock_transfer_lines (transfer_id, item_id, quantity, received, damaged, over, entered_unit, unit_cost) values ($1, $2, 10, 7, 2, 1, 'sack', 1.5)`, [t1, rice]); checks++;
await fails(db.query(`insert into public.stock_transfer_lines (transfer_id, item_id, quantity, damaged) values ($1, $2, 10, -1)`, [t1, beans]), /damaged_check/, 'damaged is not negative');
await fails(db.query(`insert into public.stock_transfer_lines (transfer_id, item_id, quantity, over) values ($1, $2, 10, -1)`, [t1, beans]), /over_check/, 'over is not negative');
await fails(db.query(`update public.stock_request_lines set dispatched = -1 where request_id = $1`, [rq]), /dispatched_check/, 'dispatched is not negative');

// Discrepancies
const disc = (extra = {}) => {
  const row = { business_id: biz, transfer_id: t1, item_id: rice, kind: 'short', qty_base: '1', ...extra };
  const keys = Object.keys(row);
  return db.query(`insert into public.transfer_discrepancies (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k]));
};
const d1 = (await disc({ value_kes: '2.50' })).rows[0].id;
eq(await one(`select status, bearer, resolution from public.transfer_discrepancies where id = $1`, [d1]), { status: 'open', bearer: null, resolution: null }, 'a discrepancy starts open with no bearer');
await fails(disc(), /transfer_discrepancies_one_open/, 'one open discrepancy per transfer line and kind');
await disc({ kind: 'damaged' }); await disc({ kind: 'over' }); checks += 2;
await fails(disc({ kind: 'lost' }), /kind_check/, 'kind is short, damaged or over');
await fails(disc({ qty_base: '0' }), /qty_base_check/, 'quantity above zero');
await fails(disc({ item_id: beans, kind: 'over' }), /foreign key|violates/, 'the transfer line must exist');
await fails(db.query(`update public.transfer_discrepancies set status = 'resolved' where id = $1`, [d1]), /transfer_discrepancies_resolved/, 'resolving needs a resolution, a bearer and a time');
await fails(db.query(`update public.transfer_discrepancies set status = 'resolved', resolution = 'write_off', resolved_at = now() where id = $1`, [d1]), /transfer_discrepancies_resolved/, 'resolving needs a bearer');
await fails(db.query(`update public.transfer_discrepancies set bearer = 'courier' where id = $1`, [d1]), /bearer_check/, 'bearer is carrier, source or destination');
await db.query(`update public.transfer_discrepancies set status = 'resolved', resolution = 'write_off', bearer = 'carrier', resolved_at = now(), resolved_by = $2, resolution_note = 'carrier pays' where id = $1`, [d1, users.owner]); checks++;
await disc(); checks++;                                          // a resolved one no longer blocks a new open one

// Reservations on legacy rows + the backstop
const approvedLegacy = R.approved.id;
const before1 = await one(`select on_hand::text o from public.stock_balances where location_id = $1 and item_id = $2`, [WH, oil]);
const res = await tx((t) => ledger.reserve(t, { businessId: biz, locationId: WH, itemId: oil, qty: '8', requestId: approvedLegacy, actorId: users.owner, idempotencyKey: 'legacy-adopt-1' }));
eq(res.balance.reserved, '8.0000', 'the new engine can reserve for a LEGACY approved request line (no request_line_id needed)');
eq((await ledger.reconcile(db, { businessId: biz })), [], 'reconciles with a reservation on a legacy request');
await fails(db.query(`update public.stock_balances set on_hand = reserved - 1 where location_id = $1 and item_id = $2`, [WH, oil]), /stock_balances_reserved_within_on_hand/, 'BACKSTOP: a writer that bypasses ledger.js cannot pull on_hand below the held stock');
// Why 018 does not reserve at apply time: main's dispatch cannot consume a reservation, so it would hit the check when free stock is short.
const free = Number(before1.o) - 8;
const big = await submit(ctx(branchA.restaurantId), [[oil, Math.min(free + 1, 100)]]);
await review(big.id, { decision: 'approve' });
await fails(tx((t) => stock.dispatch(t, owner, { requestId: big.id })), /stock_balances_reserved_within_on_hand/, 'main\'s dispatch of more than the FREE stock is refused by the DB once something is reserved (so 018 never reserves)');
const stillMain = await tx((t) => stock.dispatch(t, owner, { restaurantId: branchA.restaurantId, lines: [{ itemId: oil, quantity: 1 }] }));
ok(stillMain.id, 'main\'s dispatch within the free stock still works');
await tx((t) => stock.cancelDispatch(t, owner, stillMain.id));
await tx((t) => stock.cancelRequest(t, ctx(branchA.restaurantId), big.id)).catch(() => {});   // approved: main cannot cancel it (only submitted); fine either way

// ---------------------------------------------------------------------------------------------------------------
// 5. Down: refuses while new-world data exists, restores the 009 shape otherwise
// ---------------------------------------------------------------------------------------------------------------
const stillThere = async () => (await one(`select count(*)::int n from information_schema.columns where table_name = 'stock_requests' and column_name = 'kind'`)).n;
const refusal = async (re, m) => { await fails(db.exec(readSql(DOWN)), re, m); eq(await stillThere(), 1, `${m}: nothing was changed`); };
await refusal(/Refusing rollback of 018: .*reservations/s, 'down refuses while reservations exist');
await tx((t) => ledger.release(t, res.reservation.id, { idempotencyKey: 'down-release', reason: 'test' }));
await refusal(/reservation events/, 'down refuses while reservation events exist (the log is kept)');
await db.query(`delete from public.stock_reservations`);                                          // test clean-up of the append-only log (cascade)
await refusal(/transfer discrepancies/, 'down refuses while discrepancies exist');
await db.query(`delete from public.transfer_discrepancies`);
await insertReq('draft');
await refusal(/requests using the new statuses or fields/, 'down refuses while requests use new statuses / kinds');
await db.query(`delete from public.stock_requests where status not in ('submitted', 'approved', 'rejected', 'cancelled', 'dispatched', 'received')`);
await refusal(/transfers using the new statuses or fields/, 'down refuses while transfers use new statuses / directions');
await db.query(`delete from public.stock_transfers where direction <> 'out' or status in ('pending_approval', 'partially_received')`);
await refusal(/transfer lines with damaged/, 'down refuses while transfer lines carry damaged/over');
await db.query(`delete from public.stock_transfer_lines where damaged <> 0 or over <> 0`);
await refusal(/more than one non-cancelled transfer/, 'down refuses when the old unique index could not be restored');
await db.query(`update public.stock_transfers set status = 'cancelled' where request_id = $1 and status = 'in_transit'`, [rq]);
await db.query(`update public.stock_requests set needs_attention = true where id = $1`, [R.submitted.id]);
await refusal(/requests using the new statuses or fields/, 'down refuses while a request is flagged needs_attention');
await db.query(`update public.stock_requests set needs_attention = false where id = $1`, [R.submitted.id]);
await db.query(`update public.stock_request_lines set entered_unit = 'sack' where request_id = $1`, [R.submitted.id]);
await refusal(/request lines with a typed unit/, 'down refuses while request lines carry a typed unit');
await db.query(`update public.stock_request_lines set entered_unit = null where request_id = $1`, [R.submitted.id]);

// Remove what the later sections added so the 009 census can be compared again, then roll back.
await db.query(`delete from public.stock_transfer_lines where transfer_id in (select id from public.stock_transfers where code like 'ABCDEFGH%')`);
await db.query(`delete from public.stock_transfers where code like 'ABCDEFGH%'`);
await db.query(`delete from public.stock_requests where id = $1`, [rq]);
const downDb = await ledger.reconcile(db, { businessId: biz });
eq(downDb, [], 'ledger reconciles before the rollback');
await db.exec(readSql(DOWN));
eq(await one(`select to_regclass('public.stock_reservations') is null as gone, to_regclass('public.transfer_discrepancies') is null as gone2`), { gone: true, gone2: true }, 'down drops the new tables');
eq(await one(`select count(*)::int n from information_schema.columns where (table_name = 'stock_requests' and column_name in ('kind', 'from_location', 'to_location', 'priority', 'needed_by', 'approved_by', 'approved_at', 'needs_attention', 'completed_at'))
  or (table_name = 'stock_request_lines' and column_name in ('dispatched', 'received', 'entered_unit', 'entered_quantity'))
  or (table_name = 'stock_transfers' and column_name in ('direction', 'approved_by', 'approved_at', 'over_qty'))
  or (table_name = 'stock_transfer_lines' and column_name in ('damaged', 'over', 'entered_unit', 'unit_cost'))`), { n: 0 }, 'down drops every column 018 added');
await fails(db.query(`insert into public.stock_requests (business_id, restaurant_id, number, status) values ($1, $2, 9999, 'draft')`, [biz, branchA.restaurantId]), /stock_requests_status_check/, 'the 009 request statuses are back');
eq(await one(`select indexdef like '%status <> ''cancelled''%' as old from pg_indexes where indexname = 'stock_transfers_one_per_request'`), { old: true }, 'the 009 unique index is back');
eq(await one(`select count(*)::int n from pg_constraint where conname = 'stock_balances_reserved_within_on_hand'`), { n: 0 }, 'the backstop is gone');
eq(await one(`select to_regproc('private.transfer_direction_guard') is null as gone, to_regproc('private.backfill_distribution_018') is null as gone2`), { gone: true, gone2: true }, 'helper functions are gone');
// main's flow on the restored 009/012 shape
{
  const r = await submit(ctx(branchB.restaurantId), [[beans, 1]]);
  await review(r.id, { decision: 'approve' });
  const t = await tx((t2) => stock.dispatch(t2, owner, { requestId: r.id }));
  await tx((t2) => stock.receive(t2, ctx(branchB.restaurantId), t.id, { lines: [{ itemId: beans, received: 1 }] }));
  eq((await one(`select status from public.stock_requests where id = $1`, [r.id])).status, 'received', 'main\'s flow works on the restored schema');
}

// Down on a database where 018 was never applied is a no-op, and up -> down -> up gives the same backfill again.
await db.exec(readSql(DOWN)); checks++;
await db.exec(readSql(UP));
eq((await req(R.approved)).to_location, branchB.locationId, 'applying 018 again re-derives the backfill');
eq((await ledger.reconcile(db, { businessId: biz })), [], 'reconciles after the second apply');

console.log(`Migration 018 rehearsal: ${checks} checks passed.`);
await db.close();
