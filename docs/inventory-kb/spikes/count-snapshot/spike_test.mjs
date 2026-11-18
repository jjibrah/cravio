// Spike 2 (P3-01): count snapshot maths. Run: node docs/inventory-kb/spikes/count-snapshot/spike_test.mjs  (PGlite, 009 + 012..017 + spike_020.sql)
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url)) + '/';
const REPO = process.env.REPO || resolve(HERE, '../../../..');
const { inventoryFixture } = await import(`${REPO}/backend/tests/inv/fixture.js`);
const { PROPOSED_MIGRATIONS } = await import(`${REPO}/backend/tests/inv/migrations.js`);
const { makeItem, receive, keyGen } = await import(`${REPO}/backend/tests/inv/helpers.js`);
const { post, reconcile } = await import(`${REPO}/backend/src/inventory/ledger.js`);
const { makeCounts } = await import(HERE + 'counts_spike.js');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const say = (s) => console.log(s);
const section = (s) => say(`\n== ${s}`);

const f = await inventoryFixture({ extra: [...PROPOSED_MIGRATIONS, HERE + 'spike_020.sql'] });
const { db, ids, users } = f;
const { businessId: biz, branchLocationId: loc } = ids;
const key = keyGen('sp');
const counts = makeCounts({ post });
const naive = makeCounts({ post, naive: true });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const tx = (fn) => db.transaction(fn);
let n = 0;
const newItem = async (name, qty, cost = 100) => {
  const id = await makeItem(db, biz, name);
  if (qty > 0) await receive(db, { businessId: biz, locationId: loc, itemId: id, qty: String(qty), unitCost: String(cost), key: key() });
  return id;
};
const sell = (item, qty) => tx((t) => post(t, { businessId: biz, locationId: loc, itemId: item, qty: String(-qty), reason: 'pos_consumption', idempotencyKey: key() }));
const buy = (item, qty, extra = {}) => tx((t) => post(t, { businessId: biz, locationId: loc, itemId: item, qty: String(qty), reason: 'purchase_receipt', unitCost: '100', idempotencyKey: key(), ...extra }));
const onHand = async (i) => Number((await q(`select on_hand from public.stock_balances where location_id = $1 and item_id = $2`, [loc, i]))[0]?.on_hand ?? 0);
const session = async (svc, { blind = false } = {}) => { const id = await tx((t) => svc.create(t, { businessId: biz, locationId: loc, number: `C-${++n}`, blind, actorId: users.manager })); await tx((t) => svc.start(t, id)); return id; };
const line = async (countId, item) => (await q(`select id from public.stock_count_lines where count_id = $1 and item_id = $2`, [countId, item]))[0].id;
const enter = (lineId, qty, counterId = users.manager, o = {}) => tx((t) => counts.enterCount(t, lineId, { counterId, qtyBase: String(qty), ...o }));

section('C1 the plan example: snapshot 100, 20 sold during the count, counter counts 70 -> variance -10 (not -30)');
const i1 = await newItem('Flour', 100);
const c1 = await session(counts);
const l1 = await line(c1, i1);
await sell(i1, 20);                         // 20 sold while counting; system now 80
await enter(l1, 70);                        // the counter counted 70 on the shelf
const r1 = await tx((t) => counts.review(t, l1));
say(JSON.stringify(r1));
eq(r1.expectedAtSnapshot, 100, 'expected at snapshot 100');
eq(r1.entries[0].movementsSince, -20, 'movements since snapshot -20');
eq(r1.entries[0].expectedAtCount, 80, 'expected at the moment of counting 80');
eq(r1.entries[0].variance, -10, 'variance -10');
await tx((t) => counts.settleAndPost(t, c1, { actorId: users.owner }));
eq(await onHand(i1), 70, 'system now agrees with the shelf (70)');
const mv1 = await q(`select delta::text, reason from public.stock_movements where item_id = $1 and reason = 'count_correction'`, [i1]);
eq(mv1, [{ delta: '-10.0000', reason: 'count_correction' }], 'one count_correction of -10');

section('C2 sales AFTER the counter counted but before posting: plan wording (posting-time) vs watermark per entry');
const mk2 = async (svc) => {
  const item = await newItem('Rice ' + (++n), 100);
  const c = await session(svc);
  const l = await line(c, item);
  await sell(item, 20); await enter(l, 70);       // counted 70 after 20 sold: physical 70
  await sell(item, 5);                             // 5 more sold after the count, before the manager posts: physical 65, system 75
  await tx((t) => svc.settleAndPost(t, c, { actorId: users.owner }));
  return onHand(item);
};
const withWatermark = await mk2(counts), literal = await mk2(naive);
say(`system after posting: watermark method ${withWatermark}, "movements since snapshot at posting time" ${literal}; the shelf holds 65`);
eq(withWatermark, 65, 'watermark per entry: system = 65 = the shelf');
eq(literal, 70, 'literal plan wording ends at 70: 5 g of phantom stock (the sales after the count were counted as found stock)');

section('C3 a delivery and sales during the count');
const i3 = await newItem('Oil', 100);
const c3 = await session(counts); const l3 = await line(c3, i3);
await buy(i3, 50); await sell(i3, 8);                // expected at count 142
await enter(l3, 140);
const r3 = await tx((t) => counts.review(t, l3));
eq([r3.entries[0].movementsSince, r3.entries[0].expectedAtCount, r3.entries[0].variance], [42, 142, -2], 'since +42, expected 142, variance -2');
await tx((t) => counts.settleAndPost(t, c3));
eq(await onHand(i3), 140, 'system 140');

section('C4 a back-dated receipt posted during the count is still "since the snapshot" (ids, not timestamps)');
const i4 = await newItem('Sugar', 100);
const c4 = await session(counts); const l4 = await line(c4, i4);
await buy(i4, 30, { occurredAt: new Date(Date.now() - 3 * 86_400_000) });    // arrived 3 days ago, entered now
await enter(l4, 130);
const r4 = await tx((t) => counts.review(t, l4));
eq([r4.entries[0].movementsSince, r4.entries[0].variance], [30, 0], 'back-dated +30 counts as a movement since the snapshot; variance 0');
const byTime = (await q(`select coalesce(sum(delta), 0)::text as s from public.stock_movements where item_id = $1 and occurred_at > (select snapshot_at from public.stock_counts where id = $2)`, [i4, c4]))[0].s;
eq(Number(byTime), 0, 'a timestamp comparison (occurred_at > snapshot_at) would have seen 0 and reported variance +30');
await tx((t) => counts.settleAndPost(t, c4));

section('C5 blind sheet never carries expected; non-blind does');
const i5 = await newItem('Salt', 100);
const c5 = await session(counts, { blind: true }); const sheet5 = await tx((t) => counts.sheetFor(t, c5));
const text5 = JSON.stringify(sheet5);
ok(!/expected|variance|since|100\.0000/.test(text5), 'no expected / variance / quantity anywhere in the blind payload');
say(text5.slice(0, 200));
await q(`update public.stock_counts set status = 'cancelled' where id = $1`, [c5]);
const c5b = await session(counts, { blind: false });
ok(/expected/.test(JSON.stringify(await tx((t) => counts.sheetFor(t, c5b)))), 'a non-blind sheet shows expected');
await q(`update public.stock_counts set status = 'cancelled' where id = $1`, [c5b]);

section('C6 two counters disagree (70 vs 69): both stored; the reviewer picks, variance follows the picked entry');
const i6 = await newItem('Beans', 100);
const c6 = await session(counts); const l6 = await line(c6, i6);
await sell(i6, 20);
const e1 = await enter(l6, 70, users.manager);
await sell(i6, 3);                               // a sale between the two counters' counts
const e2 = await enter(l6, 69, users.waiter);    // second counter, after 3 more were sold: 77 expected, counted 69 (they disagree with a real -8)
const r6 = await tx((t) => counts.review(t, l6));
say(JSON.stringify(r6.entries.map((e) => [e.counted, e.expectedAtCount, e.variance])));
eq(r6.entries.map((e) => [e.counted, e.expectedAtCount, e.variance]), [[70, 80, -10], [69, 77, -8]], 'each entry judged against the ledger as it stood when it was entered');
await tx((t) => counts.settleAndPost(t, c6, { choose: { [l6]: e1 } }));
eq(await onHand(i6), 67, 'picked entry 1 (70 counted, then 3 sold): system 67');
eq((await q(`select count(*)::int as n from public.stock_count_entries where line_id = $1`, [l6]))[0].n, 2, 'both entries kept');

section('C7 replay, and numbers frozen between review and posting');
const mv = (await q(`select count(*)::int as n from public.stock_movements where reason = 'count_correction' and ref_id = $1`, [c6]))[0].n;
const again = await tx((t) => counts.post(t, c6));                         // post called a second time
eq(again, { replayed: true }, 'status gate: a posted count is not posted again');
eq((await q(`select count(*)::int as n from public.stock_movements where reason = 'count_correction' and ref_id = $1`, [c6]))[0].n, mv, 'still one correction');
// settle, then a sale happens before the owner approves/posts: the stored variance is what posts
const i7 = await newItem('Cocoa', 100);
const c7 = await session(counts); const l7 = await line(c7, i7);
await enter(l7, 90); await tx((t) => counts.settle(t, c7));                // variance -10 stored
await sell(i7, 40);                                                         // 40 sold while the approver was deciding
await tx((t) => counts.post(t, c7));
eq(await onHand(i7), 50, '100 - 40 sold - 10 correction = 50 (the approved -10 posted unchanged)');
// the same ledger key with a different quantity is refused by the real ledger (belt and braces)
let conflict = null; try { await tx((t) => post(t, { businessId: biz, locationId: loc, itemId: i7, qty: '-3', reason: 'count_correction', idempotencyKey: `count:${c7}:${l7}` })); } catch (e) { conflict = e; }
eq(conflict?.details?.code, 'idempotency_conflict', 'ledger refuses the same key with another quantity');

section('C8 frozen snapshot + append-only entries (DB triggers)');
const i8 = await newItem('Pepper', 10);
const c8 = await session(counts); const l8 = await line(c8, i8);
let err = null; try { await db.query(`update public.stock_count_lines set expected_base = 999 where id = $1`, [l8]); } catch (e) { err = e; }
ok(err && err.hint === 'count_snapshot_frozen', 'expected_base cannot change after start');
const e8 = await enter(l8, 10);
err = null; try { await db.query(`update public.stock_count_entries set qty_base = 11 where id = $1`, [e8]); } catch (e) { err = e; }
ok(err && err.hint === 'count_entry_append_only', 'an entry cannot be edited');
err = null; try { await db.query(`delete from public.stock_count_entries where id = $1`, [e8]); } catch (e) { err = e; }
ok(err && err.hint === 'count_entry_append_only', 'an entry cannot be deleted');
err = null; try { await tx((t) => counts.create(t, { businessId: biz, locationId: loc, number: 'C-dup', type: 'full' })); } catch (e) { err = e; }
ok(err && /stock_counts_one_open_full/.test(err.message), 'second open full count at the same location refused (partial unique index)');
await q(`update public.stock_counts set status = 'cancelled' where id = $1`, [c8]);

section('C9 zero-stock item and an item counted at zero');
const i9 = await newItem('Cloves', 5);
const c9 = await session(counts); const l9 = await line(c9, i9);
await enter(l9, 0);
const r9 = await tx((t) => counts.review(t, l9));
eq(r9.entries[0].variance, -5, 'counted zero, system 5 -> -5');
await tx((t) => counts.settleAndPost(t, c9));
eq(await onHand(i9), 0, 'on hand 0');

section('C10 property test: 150 random sessions (sales, deliveries, an unrecorded loss, one count, more movements) vs a physical-stock model');
let seed = 20261118; const rnd = (m) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % m; };
let maxAbs = 0;
for (let s = 0; s < 150; s++) {
  const start = 50 + rnd(200);
  const item = await newItem(`P${s}`, start);
  const c = await session(counts); const l = await line(c, item);
  let physical = start, system = start, lossBefore = 0, afterMoves = 0, counted = null, entered = false, lossAfter = 0;
  const steps = 3 + rnd(8); const countAt = rnd(steps + 1);
  for (let k = 0; k <= steps; k++) {
    if (k === countAt) { counted = physical; await enter(l, counted); entered = true; }
    const kind = rnd(4);
    if (k === steps) break;
    if (kind === 0 && system > 5) { const x = 1 + rnd(Math.min(30, system - 1)); await sell(item, x); physical -= x; system -= x; if (entered) afterMoves -= x; }
    else if (kind === 1) { const x = 1 + rnd(40); await buy(item, x); physical += x; system += x; if (entered) afterMoves += x; }
    else if (kind === 2 && physical > 5) { const x = 1 + rnd(Math.min(5, physical - 1)); physical -= x; if (entered) lossAfter += x; else lossBefore += x; } // unrecorded shrinkage
  }
  if (!entered) { counted = physical; await enter(l, counted); }
  const res = await tx((t) => counts.settleAndPost(t, c));
  const v = res.lines[0]?.variance ?? 0;
  // The counter saw the shelf at count time: variance must equal minus the unrecorded loss that happened BEFORE the count.
  eq(v, 0 - lossBefore, `session ${s}: variance = -(unrecorded loss before the count)`);
  // After posting the system equals what the shelf held at count time plus the recorded movements after it.
  eq(await onHand(item), counted + afterMoves, `session ${s}: system = counted + movements after the count`);
  maxAbs = Math.max(maxAbs, Math.abs(v));
}
say(`150 sessions: all variances matched the model (largest |variance| ${maxAbs})`);
eq((await reconcile(db, { businessId: biz })), [], 'ledger reconciliation clean after everything');

say(`\n${checks} checks passed`);
