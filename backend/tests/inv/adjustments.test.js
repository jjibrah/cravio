// Adjustments with maker-checker, staff meals and complimentaries (P3-05, migration 019). Runs the REAL services and route handlers (inventory-adjustments.js,
// inventory-approvals.js) against an in-memory database with every proposed migration applied, a fake clock and a fake evidence bucket. No network.
// Covers the safe default (no rule = every adjustment needs approval, gain or loss, nothing posts while it waits), T-SEC-2 (maker is not the checker; a branch manager
// does not approve; a sole approver may and is flagged), a gain carries the AVERAGE cost (the golden-dataset finding), stop at zero, rejection posts nothing, the owner's
// limit changing behaviour (losses within it post at once, every gain still waits), evidence photos and notes, replay, branch isolation, and allowances: a dish expanded
// through its recipe, exactly reaching the allowance, over it (note required, flagged, owners told), Nairobi-midnight reset, complimentaries in KES.
// Usage: node backend/tests/inv/adjustments.test.js
import { rig } from './fixture.js';
import { fakeClock, fakeStorage, makeAsserts, makeItem, receive } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-adjustments.js';
import { createRoutes as approvalRoutes } from '../../src/routes/inventory-approvals.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { setSetting } from '../../src/inventory/policies.js';
import { setRule } from '../../src/inventory/approvals.js';
import { nairobiDay } from '../../src/inventory/allowances.js';
import * as recipes from '../../src/inventory/recipes.js';
import * as reasons from '../../src/inventory/reasons.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, contexts } = r;
const biz = ids.businessId;
const B1 = branches.branch1.locationId;
const clock = fakeClock('2026-11-18T09:00:00+03:00');   // a Wednesday, Nairobi
const storage = fakeStorage({ clock });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const scopeOf = (who) => inventoryScope(db, contexts[who], biz);
const asTx = async (who, fn) => { const scope = await scopeOf(who); return db.transaction((t) => fn(t, scope)); };
const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
  return contexts[who];
};
const common = { authenticate, pool: () => db, transact: (fn) => db.transaction(fn) };
const api = createRoutes({ ...common, storage, now: clock.now });
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
const BR = { manager: ids.branchId, manager2: branches.branch2.restaurantId, owner: ids.branchId, waiter: ids.branchId, ops: ids.branchId };
const mgr = (who, method, suffix, body, query) => run(api, who, method, `/api/inventory${suffix}`, body, query, BR[who]);
const own = (who, method, suffix, body, query) => run(api, who, method, `/api/owner/inventory/${biz}${suffix}`, body, query);
const decideApi = (who, approvalId, body) => run(approvalsApi, who, 'POST', `/api/owner/inventory/${biz}/approvals/${approvalId}/decide`, body);
const jpeg = (tag = 'a') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]);
const file = (bytes, type = 'image/jpeg', name = 'proof.jpg') => ({ name, type, base64: bytes.toString('base64') });
const onHand = async (item, location = B1) => Number((await one(`select coalesce(sum(on_hand), 0)::text as n from public.stock_balances where location_id = $1 and item_id = $2`, [location, item])).n);
const avg = async (item) => (await one('select avg_cost::text as c from public.stock_items where id = $1', [item])).c;
const moves = (item, reason) => q(`select id, delta::text as delta, value::text as value, unit_cost::text as cost, reason, ref_type, ref_id, note, actor_id, idempotency_key from public.stock_movements
  where location_id = $1 and item_id = $2 and reason = $3 order by id`, [B1, item, reason]);
const notes = (user, kind) => q(`select * from public.notifications where recipient_id = $1 and kind = $2 order by created_at`, [user, kind]);
const adjCount = async () => (await one('select count(*)::int as n from public.stock_adjustments')).n;
const rule = (fields) => asTx('owner', (t, s) => setRule(t, s, { subject: 'adjustment', ...fields }));
const approvalOf = (adjustmentId) => one(`select id, status, amount_kes::text as a, self_approved, subject_type from public.approvals where subject_id = $1`, [adjustmentId]);
const adj = (who, body) => mgr(who, 'POST', '/adjustments', body);

// ---- stock ----
const chicken = await makeItem(db, biz, 'Chicken', { yieldPct: 70 });
const bun = await makeItem(db, biz, 'Bun');
const salt = await makeItem(db, biz, 'Salt');
const oil = await makeItem(db, biz, 'Oil');
await receive(db, { businessId: biz, locationId: B1, itemId: chicken, qty: '30000', unitCost: '0.5' });
await receive(db, { businessId: biz, locationId: B1, itemId: bun, qty: '2000', unitCost: '0.1' });
await receive(db, { businessId: biz, locationId: B1, itemId: salt, qty: '5000' });                 // no cost
await receive(db, { businessId: biz, locationId: B1, itemId: oil, qty: '1000', unitCost: '2' });
await receive(db, { businessId: biz, locationId: B1, itemId: oil, qty: '1000', unitCost: '4' });   // average 3.00 on 2000
await asTx('owner', (t, s) => recipes.saveRecipe(t, s, ids.burgerId, { lines: [{ itemId: chicken, quantity: 200, unit: 'g' }, { itemId: bun, quantity: 80, unit: 'g' }] }));
const reasonOf = async (kind, code) => (await asTx('owner', (t, s) => reasons.list(t, s, { kind, includeInactive: true }))).reasons.find((x) => x.code === code);
const found = await reasonOf('adjustment', 'found');
const damaged = await reasonOf('adjustment', 'damaged');
const theft = await reasonOf('adjustment', 'theft_suspected');

// ============================================================================================================
// Safe default + T-SEC-2: no rule = every adjustment needs another person's approval; nothing posts while it waits
// ============================================================================================================
let lossA;
{
  const stock = await onHand(chicken);
  const out = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 500, unit: 'g', reasonCodeId: damaged.id, note: 'Dropped tray' });
  lossA = out.adjustment;
  eq([out.posted, out.pendingApproval, out.adjustment.status, out.adjustment.number, out.adjustment.direction], [false, true, 'pending_approval', 'ADJ-2026-0001', 'loss'], 'no rule: a loss waits for approval, numbered');
  eq(out.evaluation.safeDefault, true, 'the evaluation says this is the safe default');
  ok(/need the owner’s approval until you set a limit/.test(out.evaluation.reasons.join(' ')), 'with the reason in plain words');
  eq(await onHand(chicken), stock, 'NOTHING posted while it waits');
  eq((await moves(chicken, 'adjustment_loss')).length, 0, 'no movement exists for it');
  eq(out.adjustment.valueKes, '250.00', 'the estimated cost is shown (500 g x 0.50)');
  const approval = await approvalOf(lossA.id);
  eq([approval.status, approval.a, approval.subject_type], ['pending', '250.00', 'adjustment'], 'an approval request exists');
  eq((await notes(people.owner, 'approval_needed')).length, 1, 'the owner was asked');

  // The branch manager can not approve; a person who asked can not approve their own while another approver exists.
  await refuses(decideApi('manager', approval.id, { decision: 'approve' }), 403, 'forbidden', null, 'a branch manager does not approve');
  const ownersOwn = await own('owner', 'POST', '/adjustments', { locationId: B1, direction: 'loss', itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: damaged.id });
  eq(ownersOwn.pendingApproval, true, 'the owner is held to the safe default too');
  const ownApproval = (await approvalOf(ownersOwn.adjustment.id)).id;
  await refuses(decideApi('owner', ownApproval, { decision: 'approve' }), 403, 'maker_checker', /can’t approve something you created/, 'maker is not the checker (T-SEC-2)');
  eq(await onHand(chicken), stock, 'and still nothing posted');

  // Another owner approves -> posted at the average cost, credited to who asked.
  const decided = await decideApi('owner2', approval.id, { decision: 'approve', note: 'Saw the tray' });
  eq([decided.status, decided.selfApproved], ['approved', false], 'approved by another owner');
  eq(await onHand(chicken), stock - 500, 'now it posted: 500 g left stock');
  const m = (await moves(chicken, 'adjustment_loss'))[0];
  eq([m.delta, m.reason, m.ref_type, m.ref_id, m.value, m.cost, m.actor_id, m.idempotency_key], ['-500.0000', 'adjustment_loss', 'adjustment', lossA.id, '-250.00', '0.500000', people.manager, `adjustment:${lossA.id}`],
    'an adjustment_loss movement at the average cost, referencing the adjustment, credited to the manager, key adjustment:<id>');
  eq(m.note, 'Damaged: Dropped tray', 'the note carries reason and note');
  const row = await one(`select status, movement_id, posted_at from public.stock_adjustments where id = $1`, [lossA.id]);
  eq([row.status, row.movement_id !== null, row.posted_at !== null], ['posted', true, true], 'the adjustment is posted and carries its movement');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'adjustment' and entity_id = $1 and action = 'approve'`, [lossA.id])).n, 1, 'approval audited');
  eq((await notes(people.manager, 'approval_decided')).length, 1, 'the manager was told');
  const again = await decideApi('owner2', approval.id, { decision: 'approve' });
  eq(again.replayed, true, 'deciding again is a replay');
  eq([(await moves(chicken, 'adjustment_loss')).length, await onHand(chicken)], [1, stock - 500], 'and nothing posted twice');
  const detail = await mgr('manager', 'GET', `/adjustments/${lossA.id}`);
  eq([detail.adjustment.status, detail.adjustment.approval.status, detail.adjustment.postedValueKes], ['posted', 'approved', '250.00'], 'the detail shows the approval and the posted value');
}

// ============================================================================================================
// Rejection: the record is kept, nothing posts
// ============================================================================================================
{
  const stock = await onHand(chicken);
  const out = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 1, unit: 'kg', reasonCodeId: theft.id, note: 'Missing from the freezer' });
  const id = out.adjustment.id;
  await refuses(decideApi('owner', (await approvalOf(id)).id, { decision: 'reject' }), 400, 'reason_required', null, 'a rejection needs a reason');
  await decideApi('owner', (await approvalOf(id)).id, { decision: 'reject', note: 'Count the freezer first' });
  eq((await one('select status, movement_id, posted_at from public.stock_adjustments where id = $1', [id])), { status: 'rejected', movement_id: null, posted_at: null }, 'rejected: the record is kept');
  eq([await onHand(chicken), (await moves(chicken, 'adjustment_loss')).length], [stock, 1], 'nothing posted for a rejected adjustment');
  eq((await mgr('manager', 'GET', '/adjustments', undefined, '?status=rejected')).adjustments.map((a) => a.id), [id], 'the log shows it');
  eq((await notes(people.manager, 'approval_decided')).length, 2, 'the manager was told');
}

// ============================================================================================================
// A gain carries the AVERAGE cost (golden-dataset finding): average unchanged, movement valued
// ============================================================================================================
{
  eq([await onHand(oil), await avg(oil)], [2000, '3.000000'], 'sanity: 2000 g at an average of 3.00');
  await requireNoteForGain();
  const out = await adj('manager', { direction: 'gain', itemId: oil, quantity: 500, unit: 'g', reasonCodeId: found.id, note: 'Found a sealed tin behind the fryer' });
  eq([out.pendingApproval, out.adjustment.valueKes], [true, '1500.00'], 'a gain waits for approval; the estimate is 500 x 3.00');
  eq(out.evaluation.safeDefault, true, 'safe default');
  eq(await onHand(oil), 2000, 'a gain adds nothing until approved');
  await receive(db, { businessId: biz, locationId: B1, itemId: oil, qty: '2000', unitCost: '6' });   // the average moves to (2000*3 + 2000*6) / 4000 = 4.50 while it waits
  eq(await avg(oil), '4.500000', 'the average moved to 4.50 while the gain waited');
  await decideApi('owner', (await approvalOf(out.adjustment.id)).id, { decision: 'approve' });
  const m = (await moves(oil, 'adjustment_gain'))[0];
  eq([m.delta, m.cost, m.value, m.reason], ['500.0000', '4.500000', '2250.00', 'adjustment_gain'], 'the gain is valued at the average cost when it posted (500 x 4.50 = 2250.00), not left without a cost');
  eq(await avg(oil), '4.500000', 'and the average cost is exactly unchanged by the gain');
  eq(await onHand(oil), 4500, 'on hand 4500');
  eq((await mgr('manager', 'GET', `/adjustments/${out.adjustment.id}`)).adjustment.postedValueKes, '2250.00', 'the detail shows what actually posted (2250.00), next to the estimate 1500.00');
  // An item that never had a cost: the gain posts without one (flagged as unknown, never 0).
  const nocost = await adj('manager', { direction: 'gain', itemId: salt, quantity: 100, unit: 'g', reasonCodeId: found.id, note: 'Found a bag' });
  eq([nocost.adjustment.valueKes, nocost.adjustment.costUnknown], [null, true], 'no cost known: value null, flagged cost unknown');
  await decideApi('owner', (await approvalOf(nocost.adjustment.id)).id, { decision: 'approve' });
  eq((await moves(salt, 'adjustment_gain'))[0].value, null, 'posted without a value rather than at 0');
}
async function requireNoteForGain() {
  await refuses(adj('manager', { direction: 'gain', itemId: oil, quantity: 500, unit: 'g', reasonCodeId: found.id }), 400, 'note_required', /always needs a note/, 'a gain without a note');
}

// ============================================================================================================
// Stop at zero, validation
// ============================================================================================================
{
  const stock = await onHand(bun);
  const before = { n: await adjCount(), seq: (await one(`select last_number as n from public.inventory_number_sequences where kind = 'ADJ'`)).n };
  await refuses(adj('manager', { direction: 'loss', itemId: bun, quantity: stock + 100, unit: 'g', reasonCodeId: damaged.id }), 409, 'insufficient_stock', /Only .* of Bun is free here; you tried to take .*Take less/, 'more than is there');
  eq([await adjCount(), (await one(`select last_number as n from public.inventory_number_sequences where kind = 'ADJ'`)).n], [before.n, before.seq], 'no record and no document number was used up');
  await refuses(adj('manager', { direction: 'loss', itemId: bun, quantity: 0, unit: 'g', reasonCodeId: damaged.id }), 400, 'zero_quantity');
  await refuses(adj('manager', { direction: 'loss', itemId: bun, quantity: 1, unit: 'cup', reasonCodeId: damaged.id }), 400, 'unit_mismatch', null, 'a unit the item does not have');
  await refuses(adj('manager', { direction: 'loss', itemId: bun, quantity: 1, unit: 'g' }), 400, 'reason_required', /Pick a reason/, 'a reason is required');
  await refuses(adj('manager', { direction: 'loss', itemId: bun, quantity: 1, unit: 'g', reasonCode: 'made up' }), 404, 'reason_not_found');
  await refuses(adj('manager', { itemId: bun, quantity: 1, unit: 'g', reasonCodeId: damaged.id }), 400, 'direction_required');
  await refuses(adj('manager', { direction: 'loss', quantity: 1, unit: 'g', reasonCodeId: damaged.id }), 400, 'subject_required');
  await refuses(adj('manager', { direction: 'loss', itemId: bun, quantity: 1, unit: 'g', reasonCodeId: theft.id }), 400, 'note_required', /needs a note/, 'theft suspected needs a note');
  await refuses(adj('waiter', { direction: 'loss', itemId: bun, quantity: 1, unit: 'g', reasonCodeId: damaged.id }), 403, 'forbidden', null, 'a waiter can not adjust stock');

  // The stock is gone between asking and approving: the approval fails with the ledger's message and stays pending.
  const asked = await adj('manager', { direction: 'loss', itemId: bun, quantity: 1500, unit: 'g', reasonCodeId: damaged.id });
  await asTx('owner', (t) => import('../../src/inventory/ledger.js').then((l) => l.post(t, { businessId: biz, locationId: B1, itemId: bun, qty: '-1900', reason: 'served', idempotencyKey: 'drain-1' })));
  const approvalId = (await approvalOf(asked.adjustment.id)).id;
  await refuses(decideApi('owner', approvalId, { decision: 'approve' }), 409, 'insufficient_stock', /can’t be approved yet\. Only .* of Bun left here/, 'stock gone before the approval');
  eq([(await approvalOf(asked.adjustment.id)).status, (await one('select status from public.stock_adjustments where id = $1', [asked.adjustment.id])).status], ['pending', 'pending_approval'], 'the decision was rolled back');
  await decideApi('owner', approvalId, { decision: 'reject', note: 'The stock is gone' });
  await receive(db, { businessId: biz, locationId: B1, itemId: bun, qty: '1900', unitCost: '0.1' });
}

// ============================================================================================================
// The owner's limit changes the behaviour: losses within it post at once, every gain still waits
// ============================================================================================================
{
  await rule({ perTransactionKes: 1000 });
  const stock = await onHand(chicken);
  const small = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 400, unit: 'g', reasonCodeId: damaged.id, note: 'Spilt' });          // KES 200
  eq([small.posted, small.adjustment.status, small.evaluation.safeDefault], [true, 'posted', false], 'with a limit: a small loss posts at once (no approval)');
  eq(await onHand(chicken), stock - 400, 'the stock went down');
  eq(await approvalOf(small.adjustment.id), undefined, 'no approval request was made');
  eq((await moves(chicken, 'adjustment_loss')).at(-1).value, '-200.00', 'valued at the average');
  const edge = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 2000, unit: 'g', reasonCodeId: damaged.id });                           // KES 1000 = the limit
  eq([edge.posted, edge.adjustment.status], [true, 'posted'], 'exactly at the limit: posted (only MORE than the limit waits)');
  const big = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 2002, unit: 'g', reasonCodeId: damaged.id });                            // KES 1001
  eq([big.pendingApproval, big.adjustment.valueKes], [true, '1001.00'], 'over the limit: waits');
  ok(big.evaluation.reasons.length === 1 && /Over your KES 1,000 limit per adjustment/.test(big.evaluation.reasons[0]), 'with the reason in plain words');
  const stock2 = await onHand(chicken);
  const gain = await adj('manager', { direction: 'gain', itemId: chicken, quantity: 20, unit: 'g', reasonCodeId: found.id, note: 'Found 20 g' });          // KES 10
  eq([gain.pendingApproval, gain.adjustment.status, gain.evaluation.safeDefault], [true, 'pending_approval', false], 'a tiny gain STILL waits: every gain needs approval');
  ok(/Stock gains always need approval/.test(gain.evaluation.reasons.join(' ')), 'and says why');
  eq(await onHand(chicken), stock2, 'nothing posted');
  const unknown = await adj('manager', { direction: 'loss', itemId: salt, quantity: 10, unit: 'g', reasonCodeId: damaged.id });
  eq([unknown.pendingApproval, unknown.adjustment.costUnknown], [true, true], 'no cost known and a limit exists: it can not be proven under the limit, so it waits');
  ok(/no cost yet/.test(unknown.evaluation.reasons.join(' ')), 'with the reason spelt out');
  // Owner raises the limit: the same loss now posts.
  await rule({ perTransactionKes: 5000 });
  const bigger = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 2002, unit: 'g', reasonCodeId: damaged.id });
  eq(bigger.posted, true, 'raise the limit and the same loss posts at once');
  // A branch rule overrides: the owner can set a stricter limit for one branch only.
  await rule({ perTransactionKes: 50, locationId: B1 });
  const strict = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 200, unit: 'g', reasonCodeId: damaged.id });                           // KES 100
  eq(strict.pendingApproval, true, 'a branch limit of KES 50 holds a KES 100 loss');
  await asTx('owner', async (t, s) => { const { deleteRule } = await import('../../src/inventory/approvals.js'); for (const x of (await t.query(`select id from public.approval_rules where subject = 'adjustment'`)).rows) await deleteRule(t, s, x.id); });
  const none = await adj('manager', { direction: 'loss', itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: damaged.id });
  eq([none.pendingApproval, none.evaluation.safeDefault], [true, true], 'delete the limits and the safe default is back');
  for (const a of [big, gain, unknown, strict, none]) await decideApi('owner', (await approvalOf(a.adjustment.id)).id, { decision: 'reject', note: 'tidy up' });
}

// ============================================================================================================
// Evidence photos, replay, isolation
// ============================================================================================================
{
  const needsPhoto = await asTx('owner', (t, s) => reasons.create(t, s, { kind: 'adjustment', label: 'Broken seal', needsPhoto: true }));
  await refuses(adj('manager', { direction: 'loss', itemId: salt, quantity: 10, unit: 'g', reasonCodeId: needsPhoto.id }), 400, 'photo_required', /needs a photo/, 'this reason needs a photo');
  const id = crypto.randomUUID();
  const up = await mgr('manager', 'POST', '/adjustments/photo', { id, file: file(jpeg('e')) });
  eq([up.entityType, up.entityId, up.locationId], ['adjustment', id, B1], 'evidence is uploaded for the adjustment to come');
  const other = await mgr('manager', 'POST', '/adjustments/photo', { id: crypto.randomUUID(), file: file(jpeg('f')) });
  await refuses(adj('manager', { id, direction: 'loss', itemId: salt, quantity: 10, unit: 'g', reasonCodeId: needsPhoto.id, photoIds: [other.id] }), 400, 'bad_photo', /wasn’t uploaded for this adjustment/, 'a photo of another record');
  const cmd = crypto.randomUUID();
  const withPhoto = await adj('manager', { id, direction: 'loss', itemId: salt, quantity: 10, unit: 'g', reasonCodeId: needsPhoto.id, photoIds: [up.id], commandId: cmd });
  eq([withPhoto.adjustment.id, withPhoto.adjustment.photoIds, withPhoto.adjustment.photos.map((p) => p.id)], [id, [up.id], [up.id]], 'the adjustment carries the evidence');
  const n = await adjCount();
  const replay = await adj('manager', { id, direction: 'loss', itemId: salt, quantity: 10, unit: 'g', reasonCodeId: needsPhoto.id, photoIds: [up.id], commandId: cmd });
  eq([replay.adjustment.id, await adjCount()], [id, n], 'a retry with the same request id returns the same adjustment');
  await refuses(adj('manager', { id, direction: 'loss', itemId: salt, quantity: 10, unit: 'g', reasonCodeId: needsPhoto.id, photoIds: [up.id] }), 409, 'id_taken');
  await refuses(mgr('manager2', 'GET', `/adjustments/${id}`), 403, 'branch_forbidden', null, 'branch 2 can not read branch 1 adjustments');
  eq((await mgr('manager2', 'GET', '/adjustments')).adjustments.length, 0, 'and its own log is empty');
  await refuses(run(api, 'manager', 'POST', `/api/inventory/adjustments`, { locationId: branches.branch2.locationId, direction: 'loss', itemId: salt, quantity: 1, unit: 'g', reasonCodeId: damaged.id }, '', BR.manager2), 403, 'branch_forbidden', null, 'a manager of branch 1 can not post at branch 2');
  const ownerList = await own('owner', 'GET', '/adjustments', undefined, '?direction=loss');
  ok(ownerList.adjustments.length > 5 && ownerList.adjustments.every((a) => a.direction === 'loss'), 'the owner sees every branch, filtered by direction');
  ok(Number(ownerList.totals.losses.valueKes) > 0 && ownerList.totals.gains.count === 0, 'totals: posted losses are summed; the direction filter leaves no gains');
  const allDirections = await own('owner', 'GET', '/adjustments');
  ok(allDirections.totals.gains.count >= 2 && Number(allDirections.totals.gains.valueKes) >= 1500, 'unfiltered, the posted gains are counted too (the oil gain alone is 1500.00 estimated)');
}

// ============================================================================================================
// Sole approver: allowed and flagged self_approved
// ============================================================================================================
{
  await db.query(`update public.business_members set role = 'operations' where user_id = $1`, [people.owner2]);   // owner2 steps down
  const out = await own('owner', 'POST', '/adjustments', { locationId: B1, direction: 'gain', itemId: salt, quantity: 5, unit: 'g', reasonCodeId: found.id, note: 'Only owner' });
  const approval = await approvalOf(out.adjustment.id);
  const decided = await decideApi('owner', approval.id, { decision: 'approve', note: 'Sole owner' });
  eq([decided.status, decided.selfApproved], ['approved', true], 'a sole approver may approve their own adjustment, flagged self_approved');
  eq((await one(`select status from public.stock_adjustments where id = $1`, [out.adjustment.id])).status, 'posted', 'and it posted');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'adjustment' and entity_id = $1 and action = 'approve_self'`, [out.adjustment.id])).n, 1, 'audited as approve_self');
  await db.query(`update public.business_members set role = 'owner' where user_id = $1`, [people.owner2]);
}

// ============================================================================================================
// Staff meals and complimentaries
// ============================================================================================================
{
  const day = nairobiDay(clock.now());
  eq(day, '2026-11-18', 'the Nairobi day');
  eq(nairobiDay(new Date('2026-11-18T21:30:00Z')), '2026-11-19', 'after 21:00 UTC it is already the next day in Nairobi');
  eq((await mgr('manager', 'GET', '/allowance')).staffMeal, { limitPortions: null, usedPortions: '0', remainingPortions: null }, 'no allowance set: nothing is checked');

  // A dish: expanded through the recipe at the version in force (chicken yield 70 %). 2 burgers = 2 x 200 g / 0.70 = 571.4286 g chicken + 160 g buns.
  const chickenBefore = await onHand(chicken); const bunBefore = await onHand(bun);
  clock.advance(60_000);
  const meal = await mgr('manager', 'POST', '/staff-meals', { menuItemId: ids.burgerId, quantity: 2, forWhom: 'Kitchen team', commandId: crypto.randomUUID() });
  eq([meal.posted, meal.overAllowance, meal.record.kind, meal.record.lines, meal.record.forWhom], [true, false, 'staff_meal', 2, 'Kitchen team'], 'a staff meal by dish posts at once');
  eq([await onHand(chicken), await onHand(bun)], [chickenBefore - 571.4286, bunBefore - 160], 'the recipe was expanded with the yield: 571.4286 g chicken, 160 g buns');
  const mm = (await moves(chicken, 'staff_meal'))[0];
  eq([mm.delta, mm.value, mm.cost, mm.ref_type, mm.ref_id, mm.actor_id, mm.idempotency_key], ['-571.4286', '-285.71', '0.500000', 'staff_meal', meal.record.id, people.manager, `staff_meal:${meal.record.id}:0`],
    'a SEPARATE ledger type (staff_meal), at cost, one movement per ingredient');
  eq((await moves(bun, 'staff_meal'))[0].value, '-16.00', 'the bun movement at 0.10');
  eq(meal.record.valueKes, '301.71', 'the record value is 285.71 + 16.00');
  eq((await moves(chicken, 'wastage')).length, 0, 'and it is not wastage');
  eq(await one(`select portions::text as p, value_kes::text as v from public.allowance_usage where kind = 'staff_meal' and day = $1`, [day]), { p: '2.00', v: '301.71' }, 'allowance_usage counted 2 portions');
  ok(/Staff meal: Chicken burger x 2: for Kitchen team/.test(mm.note), 'the movement note says what, and for whom');

  // Allowance: 5 portions a day. Used 2.
  await setSetting(db, { businessId: biz, key: 'staff_meal_allowance_portions', value: 5, actorId: people.owner });
  eq((await mgr('manager', 'GET', '/allowance')).staffMeal, { limitPortions: 5, usedPortions: '2.00', remainingPortions: '3.00' }, '2 of 5 used, 3 left');
  clock.advance(60_000);
  const item1 = await mgr('manager', 'POST', '/staff-meals', { itemId: bun, quantity: 80, unit: 'g' });
  eq([item1.overAllowance, item1.allowance.staffMeal.remainingPortions], [false, '2.00'], 'a single stock item counts as one portion');
  clock.advance(60_000);
  const exact = await mgr('manager', 'POST', '/staff-meals', { menuItemId: ids.burgerId, quantity: 2 });
  eq([exact.overAllowance, exact.allowance.staffMeal.usedPortions, exact.allowance.staffMeal.remainingPortions], [false, '5.00', '0.00'], 'exactly reaching the allowance is allowed');
  const owners = [(await notes(people.owner, 'allowance_exceeded')).length, (await notes(people.owner2, 'allowance_exceeded')).length];
  eq(owners, [0, 0], 'nobody was bothered yet');
  const chickenMid = await onHand(chicken);
  await refuses(mgr('manager', 'POST', '/staff-meals', { menuItemId: ids.burgerId, quantity: 1 }), 400, 'allowance_note_required', /That makes 6 staff meals today; the allowance is 5\. Say why in a note/, 'one more portion is over the allowance: a note is required');
  eq(await onHand(chicken), chickenMid, 'and nothing was posted');
  clock.advance(60_000);
  const over = await mgr('manager', 'POST', '/staff-meals', { menuItemId: ids.burgerId, quantity: 1, note: 'Double shift, kitchen worked through lunch' });
  eq([over.posted, over.overAllowance, over.record.overAllowance, over.allowance.staffMeal.usedPortions], [true, true, true, '6.00'], 'with a note it posts, flagged over the allowance');
  eq(over.evaluation.reasons.length, 1, 'with the reason');
  ok(/OVER ALLOWANCE/.test((await moves(chicken, 'staff_meal')).at(-1).note), 'the movement note carries the flag');
  eq([(await notes(people.owner, 'allowance_exceeded')).length, (await notes(people.owner2, 'allowance_exceeded')).length, (await notes(people.manager, 'allowance_exceeded')).length], [1, 1, 0], 'both owners were told, not the manager who did it');
  eq((await one(`select (after->>'overAllowance')::boolean as o from public.inventory_events where entity = 'allowance' and entity_id = $1`, [over.record.id])).o, true, 'audited with the flag');
  const hist = await mgr('manager', 'GET', '/allowance-records');
  eq([hist.records.length, hist.records[0].id, hist.records[0].overAllowance, hist.records.filter((x) => x.overAllowance).length], [4, over.record.id, true, 1], 'the history is newest first and flags the over-allowance one');
  eq((await mgr('manager', 'GET', '/allowance-records', undefined, '?overOnly=1')).records.map((x) => x.id), [over.record.id], 'filter: only over the allowance');
  eq((await mgr('manager', 'GET', '/allowance-records', undefined, '?kind=complimentary')).records.length, 0, 'filter: kind');
  eq((await mgr('manager', 'GET', `/allowance-records/${over.record.id}`)).record.items.map((x) => x.name), ['Chicken', 'Bun'], 'one record lists what it used');
  await refuses(mgr('manager2', 'GET', `/allowance-records/${over.record.id}`), 403, 'branch_forbidden', null, 'branch 2 can not read it');

  // Replay: the same record id never posts twice.
  const recId = crypto.randomUUID();
  await mgr('manager', 'POST', '/complimentaries', { id: recId, itemId: bun, quantity: 10, unit: 'g' });
  const bunNow = await onHand(bun);
  const replay = await mgr('manager', 'POST', '/complimentaries', { id: recId, itemId: bun, quantity: 10, unit: 'g' });
  eq([replay.replayed, await onHand(bun)], [true, bunNow], 'a replayed record does not post again');

  // The day resets at Nairobi midnight.
  clock.set('2026-11-18T23:59:00+03:00');
  await refuses(mgr('manager', 'POST', '/staff-meals', { itemId: bun, quantity: 10, unit: 'g' }), 400, 'allowance_note_required', null, 'at 23:59 it is still the same day');
  clock.set('2026-11-19T00:01:00+03:00');
  eq((await mgr('manager', 'GET', '/allowance')).staffMeal.usedPortions, '0', 'two minutes later the day has reset');
  const next = await mgr('manager', 'POST', '/staff-meals', { itemId: bun, quantity: 10, unit: 'g' });
  eq([next.overAllowance, next.allowance.day, next.allowance.staffMeal.usedPortions], [false, '2026-11-19', '1.00'], 'the next day starts fresh: no note needed');
  clock.set('2026-11-18T09:00:00+03:00');
}
{
  // Complimentaries are measured in KES at cost. One burger = 142.86 chicken + 8.00 bun = 150.86. Today already holds a 10 g bun (1.00): 1.00 + 3 x 150.86 = 453.58.
  await setSetting(db, { businessId: biz, key: 'complimentary_allowance_kes', value: 453.58, actorId: people.owner });
  const a = await mgr('manager', 'POST', '/complimentaries', { menuItemId: ids.burgerId, quantity: 1, forWhom: 'Table 4', reasonCode: 'service_recovery' });
  eq([a.record.valueKes, a.record.kind, a.overAllowance, a.allowance.complimentary.usedKes], ['150.86', 'complimentary', false, '151.86'], 'a complimentary dish at cost; the 10 g bun given earlier is in today\'s total');
  eq((await moves(chicken, 'complimentary')).at(-1).delta, '-285.7143', 'recipe expanded: 200 g / 0.70 = 285.7143 g');
  ok(/Complimentary \(Service recovery\): Chicken burger x 1: for Table 4/.test((await moves(chicken, 'complimentary')).at(-1).note), 'the reason and who it was for are on the movement');
  await refuses(mgr('manager', 'POST', '/complimentaries', { menuItemId: ids.burgerId, quantity: 1, reasonCode: 'nonsense' }), 404, 'reason_not_found');
  await mgr('manager', 'POST', '/complimentaries', { menuItemId: ids.burgerId, quantity: 1 });
  clock.advance(60_000);
  const exact = await mgr('manager', 'POST', '/complimentaries', { menuItemId: ids.burgerId, quantity: 1 });
  eq([exact.overAllowance, exact.allowance.complimentary.usedKes, exact.allowance.complimentary.remainingKes], [false, '453.58', '0.00'], 'exactly reaching the KES allowance is allowed');
  await refuses(mgr('manager', 'POST', '/complimentaries', { menuItemId: ids.burgerId, quantity: 1 }), 400, 'allowance_note_required', /KES 604\.44 of complimentaries today; the allowance is KES 453\.58/, 'one more is over: a note is required');
  clock.advance(60_000);
  const over = await mgr('manager', 'POST', '/complimentaries', { menuItemId: ids.burgerId, quantity: 1, note: 'Owner’s friend, approved by phone', reasonCode: 'owner_guest' });
  eq([over.overAllowance, over.record.overAllowance, over.allowance.complimentary.usedKes], [true, true, '604.44'], 'with a note it posts, flagged');
  eq((await notes(people.owner, 'allowance_exceeded')).length, 2, 'the owner is told again (one notification per over-allowance record; the first was the staff meal)');
  // Cost unknown while an allowance is set: can't be proven within it.
  await refuses(mgr('manager', 'POST', '/complimentaries', { itemId: salt, quantity: 10, unit: 'g' }), 400, 'allowance_note_required', /no cost yet/, 'an item with no cost');
  const unknown = await mgr('manager', 'POST', '/complimentaries', { itemId: salt, quantity: 10, unit: 'g', note: 'Sample for the supplier' });
  eq([unknown.overAllowance, unknown.record.costUnknown, unknown.record.valueKes], [true, true, null], 'with a note it posts; the value is unknown, never 0');
  // A waiter can not give food away; the owner can, anywhere.
  await refuses(mgr('waiter', 'POST', '/staff-meals', { itemId: bun, quantity: 10, unit: 'g' }), 403, 'forbidden', null, 'a waiter');
  const byOwner = await own('owner', 'POST', '/staff-meals', { locationId: B1, itemId: bun, quantity: 10, unit: 'g', note: 'Owner lunch' });
  eq(byOwner.record.kind, 'staff_meal', 'the owner records at any branch');
  eq((await own('owner', 'GET', '/allowance-records', undefined, `?locationId=${B1}&kind=complimentary`)).records.filter((x) => x.overAllowance).length, 2, 'the owner history filters by branch and kind');
  eq((await own('owner', 'GET', '/allowance', undefined, `?locationId=${B1}`)).complimentary.limitKes, 453.58, 'the owner sees the allowance of a branch');
}

const seen = (await q(`select count(*)::int as n from public.stock_adjustments`))[0].n;
console.log(`Adjustments, staff meals and complimentaries: ${count()} checks passed (${seen} adjustments, disposable PGlite database).`);
await db.close();
