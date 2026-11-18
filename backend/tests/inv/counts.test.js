// Stock counts (P3-08, migration 020): the REAL service and route handlers (inventory-counts.js, inventory-approvals.js) against an in-memory database with every
// proposed migration applied and a fake clock. No network. Every expected number below is worked out by hand from the stated stock, not from the code.
// Covers T-CTL-2 (a variance goes to review and needs ANOTHER person's approval before anything posts), sales during a count and after it (snapshot 100, 20 sold,
// counted 70, 5 more sold -> variance -10, system ends 65), a back-dated receipt during the count, a blind sheet that never carries an expected number, two counters
// who disagree (flagged, recount, choose), the no-variance session that posts without approval, the owner's limits changing behaviour, a surplus at the average cost,
// cycle (category) and spot counts, the one-open-full-count guard, cancel, maker-checker and the self-approved sole owner, idempotent posting, reconciliation, and
// that the Phase 1 single-item count still works.
// Usage: node backend/tests/inv/counts.test.js
import { rig } from './fixture.js';
import { addStaff, fakeClock, makeAsserts, makeItem, receive } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-counts.js';
import { createRoutes as approvalRoutes } from '../../src/routes/inventory-approvals.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { setSetting } from '../../src/inventory/policies.js';
import { deleteRule, setRule } from '../../src/inventory/approvals.js';
import { post, reconcile } from '../../src/inventory/ledger.js';
import { createCategory } from '../../src/inventory/catalogue.js';
import * as branch from '../../src/inventory/branch.js';
import * as counts from '../../src/inventory/counts.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, contexts } = r;
const biz = ids.businessId;
const B1 = branches.branch1.locationId;
const clock = fakeClock('2026-11-18T09:00:00+03:00');
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const scopeOf = (who) => inventoryScope(db, contexts[who], biz);
const asTx = async (who, fn) => { const scope = await scopeOf(who); return db.transaction((t) => fn(t, scope)); };

// Two more counters at branch 1 (managers), so there are several counters for the same lines.
const [c2, c3] = await addStaff(db, r, { restaurantId: ids.branchId, role: 'manager', n: 2, prefix: 'counter' });
contexts.counter2 = c2.ctx;
contexts.counter3 = c3.ctx;
people.counter2 = c2.userId;
people.counter3 = c3.userId;

const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
  return contexts[who];
};
const common = { authenticate, pool: () => db, transact: (fn) => db.transaction(fn) };
const api = createRoutes({ ...common, now: clock.now });
const approvalsApi = approvalRoutes(common);
const run = async (table, as, method, pathname, body, query = '', branchHeader = null) => {
  for (const route of table) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    const headers = { authorization: `Bearer ${as}` };
    if (branchHeader) headers['x-cravio-branch'] = branchHeader;
    return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const BR = { manager: ids.branchId, counter2: ids.branchId, counter3: ids.branchId, owner: ids.branchId, waiter: ids.branchId, ops: ids.branchId, manager2: branches.branch2.restaurantId };
const mgr = (who, method, suffix, body, query) => run(api, who, method, `/api/inventory${suffix}`, body, query, BR[who]);
const own = (who, method, suffix, body, query) => run(api, who, method, `/api/owner/inventory/${biz}${suffix}`, body, query);
const decideApi = (who, approvalId, body) => run(approvalsApi, who, 'POST', `/api/owner/inventory/${biz}/approvals/${approvalId}/decide`, body);
const tick = () => clock.advance(1000);
const onHand = async (item, location = B1) => Number((await one(`select coalesce(sum(on_hand), 0)::text as n from public.stock_balances where location_id = $1 and item_id = $2`, [location, item])).n);
const avg = async (item) => (await one('select avg_cost::text as c from public.stock_items where id = $1', [item])).c;
const corrections = (item) => q(`select id, delta::text as delta, value::text as value, unit_cost::text as cost, ref_type, ref_id, idempotency_key, actor_id from public.stock_movements
  where location_id = $1 and item_id = $2 and reason = 'count_correction' order by id`, [B1, item]);
const notes = (user, kind) => q(`select * from public.notifications where recipient_id = $1 and kind = $2 order by created_at`, [user, kind]);
const approvalOf = (countId) => one(`select id, status, amount_kes::text as a, self_approved, subject_type, requested_by from public.approvals where subject_id = $1 order by requested_at desc, id limit 1`, [countId]);
const sell = (item, grams, key) => db.transaction((t) => post(t, { businessId: biz, locationId: B1, itemId: item, qty: `-${grams}`, reason: 'pos_consumption', idempotencyKey: key }));
const countRow = (id) => one('select * from public.stock_counts where id = $1', [id]);
const lineOf = (countId, item) => one('select * from public.stock_count_lines where count_id = $1 and item_id = $2', [countId, item]);
const create = (who, body) => mgr(who, 'POST', '/counts', body);
const enter = (who, countId, itemId, quantity, unit = 'kg', extra = {}) => { tick(); return mgr(who, 'POST', `/counts/${countId}/entries`, { itemId, quantity, unit, ...extra }); };
const finish = (who, countId, body = {}) => mgr(who, 'POST', `/counts/${countId}/finish`, body);
const submit = (who, countId) => mgr(who, 'POST', `/counts/${countId}/submit`, {});
const reviewOf = (who, countId) => mgr(who, 'GET', `/counts/${countId}/review`);
const lineOfReview = (rev, itemId) => rev.lines.find((l) => l.itemId === itemId);
const decide = (who, countId, decision, note) => approvalOf(countId).then((a) => decideApi(who, a.id, { decision, note }));
const reasons = async (id) => (await approvalOf(id)) && (await one('select rule_snapshot from public.approvals where subject_id = $1 order by requested_at desc limit 1', [id])).rule_snapshot.reasons;
const ruleOf = (fields) => asTx('owner', (t, s) => setRule(t, s, { subject: 'count', ...fields }));

// ---- stock (grams in the ledger; people type kilograms) ----
const chicken = await makeItem(db, biz, 'Chicken');
await receive(db, { businessId: biz, locationId: B1, itemId: chicken, qty: '100000', unitCost: '0.5' });          // 100 kg at KES 0.50 a gram = KES 500 a kg

// ===========================================================================================================================================================
// Who may do what, and what a session needs
// ===========================================================================================================================================================
await refuses(create('waiter', { type: 'cycle', itemIds: [chicken] }), 403, 'forbidden', null, 'a waiter cannot start a count');
await refuses(create('ops', { type: 'cycle', itemIds: [chicken] }), 403, 'forbidden', null, 'an operations manager only looks');
await refuses(run(api, 'manager2', 'POST', '/api/inventory/counts', { type: 'cycle', itemIds: [chicken] }, '', ids.branchId), 403, 'branch_forbidden', null, 'a manager of branch 2 can not count branch 1');
await refuses(create('manager', { type: 'cycle' }), 400, 'filter_required', /at least one category or item/, 'a cycle count needs a filter');
await refuses(create('manager', { type: 'full', itemIds: [chicken] }), 400, 'filter_not_allowed', null, 'a full count counts everything');
await refuses(create('manager', { type: 'spot', itemIds: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }), 400, 'too_many_items', /up to 10/, 'a spot count is a few items');
await refuses(create('manager', { type: 'weird' }), 400, 'bad_type', null, 'unknown type');

// ===========================================================================================================================================================
// T-CTL-2 + sales during the count + sales after the count but before posting (the named test of P3-08)
//   Chicken: 100 kg at the snapshot. 20 kg sold -> the counter counts 70 kg. 5 kg more sold after that, before anyone posts.
//   expected at the count = 100 - 20 = 80; variance = 70 - 80 = -10 kg = -10,000 g x KES 0.50 = KES -5,000.00. The system ends at 70 + 5 sold... = 100 - 20 - 5 - 10 = 65.
// ===========================================================================================================================================================
const s1 = await create('manager', { type: 'cycle', itemIds: [chicken], note: 'Chicken check' });
const id1 = s1.count.id;
eq([s1.count.status, s1.count.type, s1.count.blind, s1.count.progress.total, s1.count.number], ['counting', 'cycle', false, 1, 'CNT-2026-0001'], 'a cycle count starts with its snapshot');
let line1 = await lineOf(id1, chicken);
eq([line1.expected_base, line1.unit_cost], ['100000.0000', '0.500000'], 'snapshot: expected 100,000 g at KES 0.50');
ok(Number(line1.snapshot_movement_id) > 0, 'the line carries the highest movement id of the item at the snapshot');
await sell(chicken, 20000, 'cnt-sale-1');                                                           // 20 kg sold DURING the count
await refuses(mgr('manager', 'GET', `/counts/${id1}/review`), 409, 'review_not_ready', null, 'no review while counting');
const e1 = await enter('manager', id1, chicken, 70);                                                // counted 70 kg
eq([e1.replayed, e1.line.qtyBase, e1.line.unit, e1.progress], [false, '70000.0000', 'kg', { total: 1, counted: 1, recount: 0, left: 0 }], 'entry in kilograms: stored in grams, entered kept');
await sell(chicken, 5000, 'cnt-sale-2');                                                            // 5 kg sold AFTER the count, before posting
const again = await enter('manager', id1, chicken, 70);
eq(again.replayed, true, 'the same counter sending the same number again is a replay (no second entry)');
eq((await q('select 1 from public.stock_count_entries e join public.stock_count_lines l on l.id = e.line_id where l.count_id = $1', [id1])).length, 1, 'still one entry');
await finish('manager', id1);
const rev1 = await reviewOf('manager', id1);
const l1 = lineOfReview(rev1, chicken);
eq([l1.expected, l1.movementsSince, l1.expectedAtCount, l1.counted, l1.variance, l1.valueKes, l1.direction], ['100000.0000', '-20000.0000', '80000.0000', '70000.0000', '-10000.0000', '-5000.00', 'loss'],
  'review: 100 - 20 = 80 expected at the moment of counting; counted 70; difference -10 kg = KES -5,000 (the 5 kg sold afterwards is NOT in it)');
eq([rev1.totals.netValueKes, rev1.totals.grossValueKes, rev1.totals.expectedValueKes, rev1.totals.netPct, rev1.totals.linesWithDifference], ['-5000.00', '5000.00', '40000.00', '-12.50', 1],
  'totals: KES -5,000 of KES 40,000 (80,000 g x 0.50) = -12.5 %');
const subm = await submit('manager', id1);
eq([subm.posted, subm.pendingApproval, subm.evaluation.safeDefault, subm.count.status], [false, true, true, 'under_review'], 'a variance with no rule set waits for approval (safe default)');
ok(/no limit is set/.test(subm.evaluation.reasons.join(' ')), 'the reason says no limit is set');
eq((await corrections(chicken)).length, 0, 'NOTHING posts while it waits');
eq(await onHand(chicken), 75000, 'the system still says 100 - 20 - 5 = 75 kg');
const ap1 = await approvalOf(id1);
eq([ap1.subject_type, ap1.status, ap1.a, ap1.requested_by], ['count', 'pending', '5000.00', people.manager], 'one approval for the session, KES 5,000, asked by the manager');
eq((await notes(people.owner, 'approval_needed')).length, 1, 'the owner is told a count needs approval');
await refuses(decideApi('manager', ap1.id, { decision: 'approve' }), 403, 'forbidden', null, 'T-CTL-2: the manager who counted cannot approve');
await refuses(enter('counter2', id1, chicken, 71), 409, 'count_in_review', /waiting for approval/, 'a count waiting for approval takes no more numbers');
const frozen = await lineOf(id1, chicken);
eq([frozen.status, frozen.final_counted_base, frozen.movements_since_base, frozen.variance_base, frozen.variance_value], ['settled', '70000.0000', '-20000.0000', '-10000.0000', '-5000.00'], 'the numbers were frozen at review');
await sell(chicken, 5000, 'cnt-sale-3');                                                            // yet another sale between approval request and approval: must not change the approved -10
const decided = await decide('owner2', id1, 'approve');
eq([decided.status, decided.replayed], ['approved', false], 'owner2 approves');
const done1 = await countRow(id1);
eq([done1.status, done1.approved_by, done1.review_variance_value, done1.review_variance_pct], ['posted', people.owner2, '-5000.00', '-12.50'], 'approved and posted');
const m1 = await corrections(chicken);
eq(m1.map((m) => [m.delta, m.value, m.ref_type, m.ref_id, m.idempotency_key, m.cost]), [['-10000.0000', '-5000.00', 'count', id1, `count:${id1}:${frozen.id}`, '0.500000']], 'exactly one count_correction of the stored -10 kg');
eq(await onHand(chicken), 60000, '100 - 20 - 5 - 5 (a later sale) - 10 = 60: later sales are never erased');
eq((await lineOf(id1, chicken)).movement_id !== null, true, 'the line points at its movement');
eq((await decide('owner2', id1, 'approve')).replayed, true, 'deciding again is a replay');
eq((await submit('manager', id1)).replayed, true, 'sending a posted count on again is a replay');
eq((await corrections(chicken)).length, 1, 'idempotent: still one correction');
eq((await notes(people.manager, 'count_posted')).length, 1, 'the branch manager is told the count was posted');
const rep1 = await mgr('manager', 'GET', `/counts/${id1}/report`);
eq([rep1.final, rep1.totals.netValueKes, rep1.lines[0].posted.delta, rep1.lines[0].posted.valueKes], [true, '-5000.00', '-10000.0000', '-5000.00'], 'the report of a posted count shows what was written');
eq(await reconcile(db, { businessId: biz }), [], 'ledger reconciles');
const hdr = await mgr('manager', 'GET', `/counts/${id1}`);
ok(!JSON.stringify(hdr).includes('"expected"'), 'the header never carries a line expected number');

// ===========================================================================================================================================================
// Back-dated receipt during the count is "since the snapshot" (the spike's C4): variance 0 -> posts with no approval
// ===========================================================================================================================================================
const salt = await makeItem(db, biz, 'Salt');
await receive(db, { businessId: biz, locationId: B1, itemId: salt, qty: '10000', unitCost: '0.1' });
const s2 = await create('manager', { type: 'spot', itemIds: [salt] });
await db.transaction((t) => post(t, { businessId: biz, locationId: B1, itemId: salt, qty: '5000', reason: 'purchase_receipt', unitCost: '0.1', occurredAt: new Date(clock.now().getTime() - 3 * 86_400_000), idempotencyKey: 'cnt-backdated' }));
await enter('manager', s2.count.id, salt, 15);
await finish('manager', s2.count.id);
const subm2 = await submit('manager', s2.count.id);
eq([subm2.posted, subm2.pendingApproval, subm2.count.status, subm2.evaluation.needsApproval], [true, false, 'posted', false], 'no variance: posted without approval');
eq((await q(`select 1 from public.approvals where subject_id = $1`, [s2.count.id])).length, 0, 'no approval row was created');
eq([(await corrections(salt)).length, await onHand(salt)], [0, 15000], 'nothing corrected; the back-dated receipt counted as "since the snapshot"');

// ===========================================================================================================================================================
// Blind count + two counters who disagree + recount + rejection and a second try
//   Beans: 137.5 kg = 137,500 g at KES 0.20/g. Counter A says 130, counter B says 131 (tolerance not set: any difference is flagged).
// ===========================================================================================================================================================
const beans = await makeItem(db, biz, 'Beans');
await receive(db, { businessId: biz, locationId: B1, itemId: beans, qty: '137500', unitCost: '0.2' });
const s3 = await create('manager', { type: 'cycle', itemIds: [beans], blind: true });
const id3 = s3.count.id;
eq(s3.count.blind, true, 'blind');
const sheetA = await mgr('manager', 'GET', `/counts/${id3}/sheet`);
let text = JSON.stringify(sheetA);
ok(!/expected|variance|137500|137\.5|"valueKes"/i.test(text), 'a blind sheet has no expected number, variance or value anywhere');
eq([sheetA.lines[0].name, sheetA.lines[0].state, sheetA.lines[0].mine, sheetA.lines[0].units.some((u) => u.code === 'kg')], ['Beans', 'uncounted', null, true], 'the sheet lists the item, its units and my number (none yet)');
ok(!/expected|variance|137500/i.test(JSON.stringify(await mgr('manager', 'GET', `/counts/${id3}`))), 'the blind header hides numbers too');
ok(!/expected|variance|137500/i.test(JSON.stringify(await mgr('manager', 'GET', '/counts', undefined, '?status=counting'))), 'and so does the list');
await refuses(mgr('counter2', 'GET', `/counts/${id3}/review`), 409, 'review_not_ready', /hidden until counting is finished/, 'no review of a blind count while counting');
await enter('manager', id3, beans, 130);
const sheetB = await mgr('counter2', 'GET', `/counts/${id3}/sheet`);
ok(!/130000|130\b/.test(JSON.stringify(sheetB.lines[0].mine)) && sheetB.lines[0].mine === null, 'another counter does not see my number');
await enter('counter2', id3, beans, 131);
const sheetB2 = await mgr('counter2', 'GET', `/counts/${id3}/sheet`);
ok(!/expected|variance|137500/i.test(JSON.stringify(sheetB2)) && sheetB2.lines[0].mine.qtyBase === '131000.0000', 'the second counter sees only their own entry');
await finish('manager', id3);
const rev3 = await reviewOf('manager', id3);
const b3 = lineOfReview(rev3, beans);
eq([b3.expected, b3.conflict, b3.needsChoice, b3.message, b3.entries.map((e) => [e.counterId, e.qtyBase, e.variance])],
  ['137500.0000', true, true, 'Counters disagree — recount or choose.', [[people.manager, '130000.0000', '-7500.0000'], [people.counter2, '131000.0000', '-6500.0000']]],
  'two counters: both stored and judged at their own moment; disagreement flagged');
await refuses(submit('manager', id3), 409, 'counters_disagree', /Beans/, 'cannot go on while counters disagree');
await mgr('manager', 'POST', `/counts/${id3}/recount`, { itemId: beans });
eq(lineOfReview(await reviewOf('manager', id3), beans).status, 'recount', 'a recount resets the line');
await refuses(submit('manager', id3), 409, 'lines_recount', null, 'a recount blocks sending on');
eq((await finish('manager', id3)).replayed, true, 'finishing counting twice is a replay');
await enter('manager', id3, beans, 131);
await enter('counter2', id3, beans, 131);
const rev3b = await reviewOf('manager', id3);
const b3b = lineOfReview(rev3b, beans);
eq([b3b.conflict, b3b.counted, b3b.variance, b3b.entries.length, b3b.entries.filter((e) => e.inCurrentRound).length, b3b.entries.filter((e) => e.isRecount).length], [false, '131000.0000', '-6500.0000', 4, 2, 1],
  'after the recount the old numbers stop counting: both counters agree on 131; all four entries are kept');
const subm3 = await submit('manager', id3);
eq([subm3.pendingApproval, subm3.count.review.varianceValueKes, subm3.count.review.variancePct], [true, '-1300.00', '-4.73'], '-6.5 kg x KES 200 = KES -1,300 of KES 27,500 (137,500 x 0.20 - 0 sales... at count 137,500 g = 27,500.00) = -4.73 %');
await refuses(decide('owner', id3, 'reject'), 400, 'reason_required', null, 'a rejection needs a reason');
await decide('owner', id3, 'reject', 'Check the cold room again');
const afterReject = await countRow(id3);
eq([afterReject.status, afterReject.review_lines, afterReject.approval_id], ['under_review', null, null], 'rejected: back to review, numbers unfrozen');
eq((await lineOf(id3, beans)).status, 'counted', 'the line is open to choose or recount again');
await mgr('manager', 'POST', `/counts/${id3}/recount`, { itemId: beans, note: 'Cold room' });
await enter('counter3', id3, beans, 132, 'kg');
const subm3b = await submit('manager', id3);
eq([subm3b.pendingApproval, subm3b.count.review.varianceValueKes], [true, '-1100.00'], 'second try: counter 3 counted 132 -> -5.5 kg = KES -1,100');
eq((await q(`select status from public.approvals where subject_id = $1 order by requested_at, id`, [id3])).map((a) => a.status), ['rejected', 'pending'], 'a new approval, the rejected one kept');
await decide('owner', id3, 'approve');
eq([(await countRow(id3)).status, await onHand(beans), (await corrections(beans)).map((m) => m.delta)], ['posted', 132000, ['-5500.0000']], 'posted: 137.5 -> 132 kg');
ok((await notes(people.manager, 'approval_decided')).length >= 1, 'the requester is told of the decision');

// ===========================================================================================================================================================
// Disagreement tolerance, choosing an entry, cancel (with the approval withdrawn), unit packs, unpriced items
//   Rice (Flour here): 70 vs 72 of 100 kg. With count_tolerance_pct 5 -> 2 kg is inside 5 % of 100 kg, not flagged; without it, flagged.
// ===========================================================================================================================================================
const rice = await makeItem(db, biz, 'Basmati');
await receive(db, { businessId: biz, locationId: B1, itemId: rice, qty: '100000', unitCost: '0.1' });
const s4 = await create('manager', { type: 'cycle', itemIds: [rice] });
const id4 = s4.count.id;
await enter('manager', id4, rice, 70);
await enter('counter2', id4, rice, 72);
await finish('manager', id4);
eq(lineOfReview(await reviewOf('manager', id4), rice).conflict, true, '70 vs 72: flagged when no tolerance is set');
await setSetting(db, { businessId: biz, key: 'count_tolerance_pct', value: 5, actorId: people.owner });
const tolerant = lineOfReview(await reviewOf('manager', id4), rice);
eq([tolerant.conflict, tolerant.counted, tolerant.entries.length], [false, '72000.0000', 2], 'inside a 5 % tolerance: not flagged, the latest applies, both kept');
await setSetting(db, { businessId: biz, key: 'count_tolerance_pct', value: null, actorId: people.owner });
const firstEntry = lineOfReview(await reviewOf('manager', id4), rice).entries[0];
await refuses(mgr('manager', 'POST', `/counts/${id4}/choose`, { itemId: rice, entryId: ids.branchId }), 404, 'entry_not_found', null, 'an entry from nowhere');
const chosen = lineOfReview(await mgr('manager', 'POST', `/counts/${id4}/choose`, { itemId: rice, entryId: firstEntry.id }), rice);
eq([chosen.needsChoice, chosen.counted, chosen.variance, chosen.valueKes], [false, '70000.0000', '-30000.0000', '-3000.00'], 'the reviewer chose the 70 kg entry: -30 kg x KES 0.10 = KES -3,000');
await submit('manager', id4);
ok((await approvalOf(id4)).status === 'pending', 'waiting for approval');
const cancelled = await mgr('manager', 'POST', `/counts/${id4}/cancel`, { note: 'Wrong shelf' });
eq([cancelled.count.status, (await approvalOf(id4)).status, (await corrections(rice)).length, await onHand(rice)], ['cancelled', 'cancelled', 0, 100000], 'cancel: approval withdrawn, nothing posted');
eq((await mgr('manager', 'POST', `/counts/${id4}/cancel`, {})).replayed, true, 'cancelling twice is a replay');
await refuses(mgr('manager', 'POST', `/counts/${id1}/cancel`, {}), 409, 'count_posted', /already posted/, 'a posted count cannot be cancelled');
await refuses(enter('manager', id4, rice, 80), 409, 'count_not_counting', /cancelled/, 'a cancelled count takes no numbers');

// Large amounts need a confirmation (Phase 1 rule reused); packs and unpriced items.
const flour = r.items.flour;                                                                   // 'sack' = 25 kg
await receive(db, { businessId: biz, locationId: B1, itemId: flour, qty: '80000' });           // 80 kg, no cost
const s5 = await create('manager', { type: 'cycle', itemIds: [flour, rice] });
await refuses(enter('manager', s5.count.id, rice, 900000), 409, 'confirm_large_amount', /is a lot for Basmati/, 'a typo is caught');
await enter('manager', s5.count.id, rice, 900000, 'kg', { confirmLarge: true });
await enter('manager', s5.count.id, rice, 100);
const pack = await enter('manager', s5.count.id, flour, 3, 'sack');
eq([pack.line.quantity, pack.line.unit, pack.line.qtyBase], ['3.0000', 'sack', '75000.0000'], '3 sacks = 75 kg; the pack is kept as entered');
await finish('manager', s5.count.id);
const rev5 = await reviewOf('manager', s5.count.id);
const f5 = lineOfReview(rev5, flour);
eq([f5.variance, f5.valueKes, f5.unitCostKnown, rev5.totals.unpricedLines, rev5.totals.netValueKes, rev5.totals.linesWithDifference],
  ['-5000.0000', null, false, 1, '0.00', 1], 'an item with no cost: the difference is shown, its value is unknown (never zero)');
await mgr('manager', 'POST', `/counts/${s5.count.id}/cancel`, {});

// ===========================================================================================================================================================
// Skipping with a reason, and the owner's limits (the safe default, then % and KES rules)
//   Stew: 100 kg at KES 0.01/g -> stock value KES 1,000.
// ===========================================================================================================================================================
const stew = await makeItem(db, biz, 'Stew base');
const tea = await makeItem(db, biz, 'Tea');
await receive(db, { businessId: biz, locationId: B1, itemId: stew, qty: '100000', unitCost: '0.01' });
await receive(db, { businessId: biz, locationId: B1, itemId: tea, qty: '4000', unitCost: '0.05' });
const s6 = await create('manager', { type: 'cycle', itemIds: [stew, tea] });
await enter('manager', s6.count.id, stew, 100);
const fin = await refuses(finish('manager', s6.count.id), 409, 'lines_uncounted', /1 item hasn’t been counted yet \(Tea\)/, 'finish needs every line counted or skipped');
eq(fin.details.uncounted, 1, 'it says how many are left');
await refuses(finish('manager', s6.count.id, { skips: [{ itemId: tea, reason: ' ' }] }), 400, 'skip_reason_required', null, 'a skip needs a reason');
await finish('manager', s6.count.id, { skips: [{ itemId: tea, reason: 'Locked store' }] });
const rev6 = await reviewOf('manager', s6.count.id);
eq([lineOfReview(rev6, tea).decision, lineOfReview(rev6, tea).skipReason, rev6.totals.lines], ['skipped', 'Locked store', 1], 'a skipped line is shown with its reason and is not compared');
const subm6 = await submit('manager', s6.count.id);
eq([subm6.posted, subm6.pendingApproval, await onHand(tea)], [true, false, 4000], 'only the counted line counts: no difference, posted, the skipped item untouched');
eq(lineOfReview(await mgr('manager', 'GET', `/counts/${s6.count.id}/review`), tea).variance, null, 'no number for the skipped line');

// Limits: variance % 10 and KES 1,000. Stew counted 98 kg -> -2 kg x 10 = KES -20 = 2 % of KES 1,000: inside both limits.
const rule = (await ruleOf({ variancePct: 10, varianceKes: 1000 })).rule;
const s7 = await create('manager', { type: 'cycle', itemIds: [stew] });
await enter('manager', s7.count.id, stew, 98);
await finish('manager', s7.count.id);
const subm7 = await submit('manager', s7.count.id);
eq([subm7.posted, subm7.pendingApproval, subm7.evaluation.safeDefault, await onHand(stew), (await corrections(stew)).map((m) => m.delta)], [true, false, false, 98000, ['-2000.0000']],
  'inside the owner\'s limits (2 % of 10 %, KES 20 of 1,000): posts without approval');
// Now 98 kg is KES 980. Counted 85 -> -13 kg = KES -130 = 13.27 % > 10 %: needs approval.
const s8 = await create('manager', { type: 'cycle', itemIds: [stew] });
await enter('manager', s8.count.id, stew, 85);
await finish('manager', s8.count.id);
const subm8 = await submit('manager', s8.count.id);
eq([subm8.pendingApproval, subm8.evaluation.safeDefault, await onHand(stew)], [true, false, 98000], 'beyond the % limit: approval');
ok(/13\.27%.*limit 10%/.test(subm8.evaluation.reasons.join(' ')), `the reason names the % (${subm8.evaluation.reasons.join(' | ')})`);
await mgr('manager', 'POST', `/counts/${s8.count.id}/cancel`, {});
// KES-only rule of 200: KES -130 is inside it -> posts.
await ruleOf({ varianceKes: 200 });
const s9 = await create('manager', { type: 'cycle', itemIds: [stew] });
await enter('manager', s9.count.id, stew, 85);
await finish('manager', s9.count.id);
eq((await submit('manager', s9.count.id)).posted, true, 'a KES 200 limit: KES -130 posts without approval');
eq(await onHand(stew), 85000, 'stew is at 85 kg');
// KES limit of 100: KES -130 (85 -> 70 kg = -15 kg = KES -150) is beyond it.
await ruleOf({ varianceKes: 100 });
const s10 = await create('manager', { type: 'cycle', itemIds: [stew] });
await enter('manager', s10.count.id, stew, 70);
await finish('manager', s10.count.id);
const subm10 = await submit('manager', s10.count.id);
eq(subm10.pendingApproval, true, 'KES -150 is beyond a KES 100 limit');
ok(/KES 150 \(limit 100\)/.test(subm10.evaluation.reasons.join(' ')), `the reason names the KES (${subm10.evaluation.reasons.join(' | ')})`);
await mgr('manager', 'POST', `/counts/${s10.count.id}/cancel`, {});
await asTx('owner', (t, s) => deleteRule(t, s, rule.id));
const s11 = await create('manager', { type: 'cycle', itemIds: [stew] });
await enter('manager', s11.count.id, stew, 84);
await finish('manager', s11.count.id);
const subm11 = await submit('manager', s11.count.id);
eq([subm11.pendingApproval, subm11.evaluation.safeDefault], [true, true], 'rule removed: back to the safe default (a variance of 1 kg needs approval)');
await mgr('manager', 'POST', `/counts/${s11.count.id}/cancel`, {});
// The fallback settings stand in for a rule that was never made.
await setSetting(db, { businessId: biz, key: 'count_variance_value_kes', value: 500, actorId: people.owner });
const s12 = await create('manager', { type: 'cycle', itemIds: [stew] });
await enter('manager', s12.count.id, stew, 80);
await finish('manager', s12.count.id);
const subm12 = await submit('manager', s12.count.id);
eq([subm12.posted, subm12.evaluation.safeDefault, await onHand(stew)], [true, false, 80000], 'count_variance_value_kes = 500: stew -5 kg = KES -50 posts');
await setSetting(db, { businessId: biz, key: 'count_variance_value_kes', value: null, actorId: people.owner });
eq(await reconcile(db, { businessId: biz }), [], 'ledger reconciles');

// ===========================================================================================================================================================
// Clamp: a deficit never takes stock below zero. Thyme: 10 kg at KES 1/g. Counted 8 kg (variance -2 kg), then 9 kg are sold AFTER the count (more than the shelf
// held). Only 1 kg is left when the count posts, so the -2 kg correction is clamped to -1 kg and the stock ends at 0, never negative.
// ===========================================================================================================================================================
const thyme = await makeItem(db, biz, 'Thyme');
await receive(db, { businessId: biz, locationId: B1, itemId: thyme, qty: '10000', unitCost: '1' });
const rule2 = (await ruleOf({ varianceKes: 5000 })).rule;                                          // inside the limit: posts at once, so the result carries `clamped`
const sc = await create('manager', { type: 'cycle', itemIds: [thyme] });
await enter('manager', sc.count.id, thyme, 8);
await sell(thyme, 9000, 'cnt-clamp-sale');
await finish('manager', sc.count.id);
const subc = await submit('manager', sc.count.id);
eq([subc.posted, subc.clamped.length, subc.clamped[0].wanted, subc.clamped[0].posted], [true, 1, '-2000.0000', '-1000.0000'], 'the deficit was clamped to what was left: -2 kg wanted, -1 kg posted');
eq(subc.clamped[0].message, 'Thyme: the count found 2 kg less than expected, but sales after the count had already used the stock, so only 1 kg could be taken off (stock is now 0).', 'plain wording');
eq([await onHand(thyme), (await corrections(thyme)).map((m) => m.delta), (await countRow(sc.count.id)).status], [0, ['-1000.0000'], 'posted'], 'stock ends at exactly 0, one correction of -1 kg');
const clampAudit = await one(`select after from public.inventory_events where entity = 'count' and entity_id = $1 and action = 'post'`, [sc.count.id]);
eq(JSON.parse(typeof clampAudit.after === 'string' ? clampAudit.after : JSON.stringify(clampAudit.after)).clamped[0].posted, '-1000.0000', 'the clamp is recorded in the audit trail');
eq((await lineOf(sc.count.id, thyme)).variance_base, '-2000.0000', 'the approved/frozen difference is kept as counted (-2 kg); only the posting was limited');
eq((await submit('manager', sc.count.id)).replayed, true, 'replay posts nothing more');
eq([(await corrections(thyme)).length, await onHand(thyme)], [1, 0], 'idempotent');
eq(await reconcile(db, { businessId: biz }), [], 'ledger reconciles after a clamp');
await asTx('owner', (t, s) => deleteRule(t, s, rule2.id));

// Two entries in the same millisecond (same counted_at and watermark): the order is decided by id, so "the latest" is the same every time.
const dill = await makeItem(db, biz, 'Dill');
await receive(db, { businessId: biz, locationId: B1, itemId: dill, qty: '100000', unitCost: '0.1' });
await setSetting(db, { businessId: biz, key: 'count_tolerance_pct', value: 5, actorId: people.owner });
const st = await create('manager', { type: 'cycle', itemIds: [dill] });
tick();
await mgr('manager', 'POST', `/counts/${st.count.id}/entries`, { itemId: dill, quantity: 70, unit: 'kg' });
await mgr('counter2', 'POST', `/counts/${st.count.id}/entries`, { itemId: dill, quantity: 72, unit: 'kg' });       // same clock tick
await finish('manager', st.count.id);
const tied = (await q(`select e.id, e.counted_at, e.ledger_watermark::text as w from public.stock_count_entries e join public.stock_count_lines l on l.id = e.line_id where l.count_id = $1`, [st.count.id]));
eq([tied[0].counted_at.getTime?.() ?? String(tied[0].counted_at), tied[0].w], [tied[1].counted_at.getTime?.() ?? String(tied[1].counted_at), tied[1].w], 'both entries share the same time and watermark');
const expectedLast = tied.map((e) => e.id).sort().at(-1);
for (let i = 0; i < 3; i++) {
  const l = lineOfReview(await reviewOf('manager', st.count.id), dill);
  eq([l.entries.map((e) => e.id), l.chosenEntryId], [tied.map((e) => e.id).sort(), expectedLast], 'tied entries are ordered by id and the applied one is the last id, every time');
}
await setSetting(db, { businessId: biz, key: 'count_tolerance_pct', value: null, actorId: people.owner });
await mgr('manager', 'POST', `/counts/${st.count.id}/cancel`, {});

// ===========================================================================================================================================================
// A surplus is posted at the average cost: the average does not move
//   Oil: 1,000 g at KES 2 + 1,000 g at KES 4 -> average KES 3.00 on 2,000 g. Counted 2.5 kg -> +500 g at KES 3 = KES 1,500.00.
// ===========================================================================================================================================================
const oil = await makeItem(db, biz, 'Oil');
await receive(db, { businessId: biz, locationId: B1, itemId: oil, qty: '1000', unitCost: '2' });
await receive(db, { businessId: biz, locationId: B1, itemId: oil, qty: '1000', unitCost: '4' });
const s13 = await create('manager', { type: 'cycle', itemIds: [oil] });
await enter('manager', s13.count.id, oil, 2.5);
await finish('manager', s13.count.id);
const rev13 = await reviewOf('manager', s13.count.id);
eq([lineOfReview(rev13, oil).variance, lineOfReview(rev13, oil).valueKes, lineOfReview(rev13, oil).direction, rev13.totals.gainsKes], ['500.0000', '1500.00', 'gain', '1500.00'], 'a gain of 500 g at KES 3 = KES 1,500');
await submit('manager', s13.count.id);
// The counter (manager) asked; the OWNER counted nothing: approve by owner.
await decide('owner', s13.count.id, 'approve');
const sur = (await corrections(oil))[0];
eq([sur.delta, sur.cost, sur.value, await avg(oil), await onHand(oil)], ['500.0000', '3.000000', '1500.00', '3.000000', 2500], 'surplus carried the average cost: the average is unchanged');

// ===========================================================================================================================================================
// Maker-checker: a counter can't approve while another approver exists; a requester can't approve their own; a sole owner may and it is flagged
// ===========================================================================================================================================================
const cumin = await makeItem(db, biz, 'Cumin');
await receive(db, { businessId: biz, locationId: B1, itemId: cumin, qty: '10000', unitCost: '1' });
const s14 = await create('manager', { type: 'cycle', itemIds: [cumin] });
await enter('owner', s14.count.id, cumin, 9);                                                       // the OWNER counted
await finish('manager', s14.count.id);
await submit('manager', s14.count.id);                                                              // the manager sends it on
await refuses(decide('owner', s14.count.id, 'approve'), 403, 'counter_cannot_approve', /someone else has to approve/, 'the owner who counted can\'t approve while owner2 can');
eq((await approvalOf(s14.count.id)).status, 'pending', 'the decision was rolled back');
await decide('owner2', s14.count.id, 'approve');
eq([(await countRow(s14.count.id)).status, await onHand(cumin)], ['posted', 9000], 'owner2 approved: -1 kg posted');

const pepper = await makeItem(db, biz, 'Pepper');
await receive(db, { businessId: biz, locationId: B1, itemId: pepper, qty: '10000', unitCost: '1' });
const s15 = await create('owner', { type: 'cycle', itemIds: [pepper], locationId: B1 });             // (branch header: the owner works at branch 1)
await enter('owner', s15.count.id, pepper, 8);
await finish('owner', s15.count.id);
await submit('owner', s15.count.id);                                                                // the owner is the requester AND a counter
await refuses(decide('owner', s15.count.id, 'approve'), 403, 'maker_checker', null, 'the requester can\'t approve their own count while another owner exists');
await refuses(decide('owner', s15.count.id, 'reject', 'No'), 403, 'use_cancel', null, 'nor reject it');
await decide('owner2', s15.count.id, 'approve');                                                    // owner2 (not a counter) approves
eq((await countRow(s15.count.id)).status, 'posted', 'owner2 approved');

// Sole owner: remove owner2 and ops can't approve -> the owner is the only approver and may approve their own, flagged.
await db.query(`delete from public.business_members where user_id = $1`, [people.owner2]);
const clove = await makeItem(db, biz, 'Clove');
await receive(db, { businessId: biz, locationId: B1, itemId: clove, qty: '10000', unitCost: '1' });
const s16 = await create('owner', { type: 'cycle', itemIds: [clove] });
await enter('owner', s16.count.id, clove, 9);
await finish('owner', s16.count.id);
await submit('owner', s16.count.id);
await decide('owner', s16.count.id, 'approve');
const sole = await approvalOf(s16.count.id);
eq([sole.status, sole.self_approved, (await countRow(s16.count.id)).status, await onHand(clove)], ['approved', true, 'posted', 9000], 'a sole owner approves their own count; it is flagged self-approved');
ok((await q(`select 1 from public.inventory_events where entity = 'count' and entity_id = $1 and action = 'approve_self'`, [s16.count.id])).length === 1, 'and audited as approve_self');
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [biz, people.owner2]);

// ===========================================================================================================================================================
// Cycle by category, spot counts, the one open full count, branch isolation
// ===========================================================================================================================================================
const catId = (await asTx('owner', (t, s) => createCategory(t, s, { name: 'Spices' }))).id;
const subId = (await asTx('owner', (t, s) => createCategory(t, s, { name: 'Hot spices', parentId: catId }))).id;
await db.query('update public.stock_items set category_id = $2 where id = any($1::uuid[])', [[cumin, pepper], catId]);
await db.query('update public.stock_items set category_id = $2 where id = $1', [clove, subId]);
const ginger = await makeItem(db, biz, 'Ginger');                                                   // in the category but never stocked here: not on the sheet
await db.query('update public.stock_items set category_id = $2 where id = $1', [ginger, catId]);
const s17 = await create('manager', { type: 'cycle', categoryIds: [catId] });
const sheet17 = await mgr('manager', 'GET', `/counts/${s17.count.id}/sheet`);
eq(sheet17.lines.map((l) => l.name).sort(), ['Clove', 'Cumin', 'Pepper'], 'cycle by category: stocked items of the category and its sub-category, not other categories, not unstocked items');
eq(s17.count.categoryIds, [catId], 'the filter is kept');
await refuses(create('manager', { type: 'spot', itemIds: [cumin] }), 409, 'item_in_open_count', /Cumin is already being counted here/, 'the same item can\'t be in two open counts');
await mgr('manager', 'POST', `/counts/${s17.count.id}/cancel`, {});

// Spot count in one go: no difference posts nothing; a difference waits for approval.
const spotOk = await mgr('manager', 'POST', '/counts/spot', { items: [{ itemId: cumin, quantity: 9 }] });
eq([spotOk.posted, spotOk.count.type, spotOk.count.status, (await corrections(cumin)).length], [true, 'spot', 'posted', 1], 'a spot count with no difference posts nothing new');
const spotDiff = await mgr('manager', 'POST', '/counts/spot', { items: [{ itemId: cumin, quantity: 8.5 }] });
eq([spotDiff.pendingApproval, spotDiff.count.status, spotDiff.count.review.varianceValueKes], [true, 'under_review', '-500.00'], 'a spot count with a difference waits: -0.5 kg x KES 1/g = KES -500');
await mgr('manager', 'POST', `/counts/${spotDiff.count.id}/cancel`, {});

// One open full count per place.
const full = await create('manager', { type: 'full' });
const fullLines = (await q('select count(*)::int as n from public.stock_count_lines where count_id = $1', [full.count.id]))[0].n;
const stocked = (await q('select count(*)::int as n from public.stock_balances b join public.stock_items i on i.id = b.item_id where b.location_id = $1 and i.archived_at is null', [B1]))[0].n;
eq(fullLines, stocked, 'a full count has a line for every stocked item here');
await refuses(create('manager', { type: 'full' }), 409, 'full_count_open', /already open at .*Finish it or cancel it/, 'a second full count at the same place is refused with a plain message');
await refuses(create('manager', { type: 'spot', itemIds: [oil] }), 409, 'item_in_open_count', null, 'and so is counting one of its items on the side');
let dbRefused = null;
try { await db.query(`insert into public.stock_counts (business_id, location_id, number, type) values ($1, $2, 'CNT-X', 'full')`, [biz, B1]); } catch (e) { dbRefused = e; }
ok(dbRefused && /one_open_full/.test(`${dbRefused.constraint || ''} ${dbRefused.message}`), 'the database index refuses it as well');
eq((await mgr('manager', 'GET', '/counts', undefined, '?status=counting&type=full')).counts.map((c) => c.id), [full.count.id], 'the list filters by status and type');
await mgr('manager', 'POST', `/counts/${full.count.id}/cancel`, {});
const full2 = await create('manager', { type: 'full' });
ok(full2.count.status === 'counting', 'after cancelling, a new full count can start');
await mgr('manager', 'POST', `/counts/${full2.count.id}/cancel`, {});

// Branch isolation and the owner side.
const s18 = await create('manager', { type: 'cycle', itemIds: [cumin] });
await refuses(run(api, 'manager2', 'GET', `/api/inventory/counts/${s18.count.id}`, undefined, '', BR.manager2), 403, 'branch_forbidden', null, 'branch 2 manager can not read a branch 1 count');
await refuses(run(api, 'manager2', 'POST', `/api/inventory/counts/${s18.count.id}/entries`, { itemId: cumin, quantity: 1 }, '', BR.manager2), 403, 'branch_forbidden', null, 'nor enter numbers');
await refuses(run(api, 'manager', 'GET', `/api/owner/inventory/${biz}/counts`, undefined), 403, 'forbidden', null, 'a branch manager can not use the owner side');
await refuses(mgr('waiter', 'GET', `/counts/${s18.count.id}/sheet`), 403, 'forbidden', null, 'a waiter has no sheet');
eq((await own('owner', 'GET', '/counts', undefined, `?locationId=${B1}&status=counting`)).counts.map((c) => c.id), [s18.count.id], 'the owner lists counts of any place');
eq((await own('ops', 'GET', '/counts', undefined, `?locationId=${B1}&status=counting`)).counts.length, 1, 'operations managers can look');
await refuses(own('ops', 'POST', '/counts', { locationId: B1, type: 'cycle', itemIds: [pepper] }), 403, 'forbidden', null, 'but not start one');
const byOwner = await own('owner', 'POST', '/counts', { locationId: B1, type: 'cycle', itemIds: [pepper], blind: true });
eq([byOwner.count.status, byOwner.count.blind], ['counting', true], 'the owner starts a count at any place');
await own('owner', 'POST', `/counts/${byOwner.count.id}/cancel`, {});
await mgr('manager', 'POST', `/counts/${s18.count.id}/cancel`, {});
const sg = await own('owner', 'GET', '/counts/suggest', undefined, `?locationId=${B1}&n=3&by=oldest`);
eq(sg.items.length, 3, 'cycle suggestions come with a size');
const sv = await own('owner', 'GET', '/counts/suggest', undefined, `?locationId=${B1}&n=2&by=value`);
ok(Number(sv.items[0].valueKes) >= Number(sv.items[1].valueKes), 'by value: highest first');

// A command id replays a create (same session back, no second number).
const cmd = '11111111-1111-4111-8111-111111111111';
const k1 = await create('manager', { type: 'cycle', itemIds: [ginger], commandId: cmd });
const k2 = await create('manager', { type: 'cycle', itemIds: [ginger], commandId: cmd });
eq([k2.count.id === k1.count.id, (await q('select count(*)::int as n from public.stock_counts where command_id is not null'))[0].n], [true, 1], 'a repeated create with the same commandId returns the same session');
await mgr('manager', 'POST', `/counts/${k1.count.id}/cancel`, {});

// ===========================================================================================================================================================
// The Phase 1 single-item count still works
// ===========================================================================================================================================================
const oldCount = await asTx('manager', (t, s) => branch.record(t, s, { locationId: B1, kind: 'count', itemId: cumin, quantity: 8, unit: 'kg' }));
eq([oldCount.changed, oldCount.movement.reason, oldCount.onHand], [true, 'count_correction', '8000.0000'], 'branch.record kind=count: 9 -> 8 kg still posts a count_correction');
eq(await reconcile(db, { businessId: biz }), [], 'ledger reconciles at the end');

const sessions = (await q('select count(*)::int as n from public.stock_counts'))[0].n;
console.log(`Counts: ${count()} checks passed (${sessions} sessions, disposable PGlite database).`);
await db.close();
