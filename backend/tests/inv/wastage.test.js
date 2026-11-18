// Wastage and reason codes (P3-04, migration 019). Runs the REAL services and route handlers (inventory-wastage.js, inventory-branch.js, inventory-approvals.js)
// against an in-memory database with every proposed migration applied, a fake clock and a fake evidence bucket. No network.
// Covers T-CTL-1 (above the owner's limit -> pending, nothing posted, approved by another person -> separate 'wastage' ledger type, cost kept), the safe default
// (no rule = posted at once), the old wastage_approval_value_kes setting becoming a rule, dishes expanded through the recipe with yield, stop at zero, reason codes
// (seeded once, owner adds / renames / switches off), photos and notes required per reason, the unusual-wastage alert (math, floor, dedupe), idempotent replay,
// branch isolation, and the old branch "waste" route keeping its response shape.
// Usage: node backend/tests/inv/wastage.test.js
import { rig } from './fixture.js';
import { DEFAULT_REASON_CODES, fakeClock, fakeStorage, makeAsserts, makeItem, postAt, receive } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-wastage.js';
import { createRoutes as branchRoutes } from '../../src/routes/inventory-branch.js';
import { createRoutes as approvalRoutes } from '../../src/routes/inventory-approvals.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import { setSetting } from '../../src/inventory/policies.js';
import { clearDecisionHandlers, setRule } from '../../src/inventory/approvals.js';
import * as recipes from '../../src/inventory/recipes.js';
import * as reasons from '../../src/inventory/reasons.js';
import * as wastage from '../../src/inventory/wastage.js';
import { DEFAULT_REASON_CODES as SEEDED } from '../../src/inventory/reasons.js';

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
const scopeOf = (who) => inventoryScope(db, contexts[who], biz);
const asTx = async (who, fn) => { const scope = await scopeOf(who); return db.transaction((t) => fn(t, scope)); };
const authenticate = async (request) => {
  const who = request.headers.authorization?.replace(/^Bearer /, '');
  if (!contexts[who]) throw new HttpError(401, 'Please sign in to continue.');
  return contexts[who];
};
const common = { authenticate, pool: () => db, transact: (fn) => db.transaction(fn) };
const wasteApi = createRoutes({ ...common, storage, now: clock.now });
const approvalsApi = approvalRoutes(common);
const branchApi = branchRoutes(common);
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
const mgr = (who, method, suffix, body, query) => run(wasteApi, who, method, `/api/inventory${suffix}`, body, query, BR[who]);
const own = (who, method, suffix, body, query) => run(wasteApi, who, method, `/api/owner/inventory/${biz}${suffix}`, body, query);
const decideApi = (who, approvalId, body) => run(approvalsApi, who, 'POST', `/api/owner/inventory/${biz}/approvals/${approvalId}/decide`, body);
const oldRecord = (who, body) => run(branchApi, who, 'POST', '/api/inventory/record', body, '', BR[who]);
const jpeg = (tag = 'a') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]);
const file = (bytes, type = 'image/jpeg', name = 'waste.jpg') => ({ name, type, base64: bytes.toString('base64') });
const onHand = async (item, location = B1) => Number((await one(`select coalesce(sum(on_hand), 0)::text as n from public.stock_balances where location_id = $1 and item_id = $2`, [location, item])).n);
const movements = (item, location = B1) => q(`select id, delta::text as delta, value::text as value, unit_cost::text as cost, reason, ref_type, ref_id, note, actor_id from public.stock_movements
  where location_id = $1 and item_id = $2 and reason = 'wastage' order by id`, [location, item]);
const notes = (user, kind) => q(`select * from public.notifications where recipient_id = $1 and kind = $2 order by created_at`, [user, kind]);
const wasteCount = async () => (await one('select count(*)::int as n from public.wastage_records')).n;
const rule = (fields) => asTx('owner', (t, s) => setRule(t, s, { subject: 'wastage', ...fields }));

// ---- stock: chicken (yield 70 %) and buns at branch 1, a little at branch 2 ----
const chicken = await makeItem(db, biz, 'Chicken', { yieldPct: 70 });
const bun = await makeItem(db, biz, 'Bun');
const salt = await makeItem(db, biz, 'Salt');
await receive(db, { businessId: biz, locationId: B1, itemId: chicken, qty: '30000', unitCost: '0.5' });
await receive(db, { businessId: biz, locationId: B1, itemId: bun, qty: '2000', unitCost: '0.1' });
await receive(db, { businessId: biz, locationId: B1, itemId: salt, qty: '5000' });                    // no cost
await receive(db, { businessId: biz, locationId: B2, itemId: chicken, qty: '5000', unitCost: '0.5' });
await asTx('owner', (t, s) => recipes.saveRecipe(t, s, ids.burgerId, { lines: [{ itemId: chicken, quantity: 200, unit: 'g' }, { itemId: bun, quantity: 80, unit: 'g' }] }));

// ============================================================================================================
// Reason codes: seeded once, owner manages
// ============================================================================================================
{
  eq((await one('select count(*)::int as n from public.stock_reason_codes')).n, 0, 'nothing is seeded by the migration');
  const first = await mgr('manager', 'GET', '/reason-codes');
  eq(first.reasons.map((x) => x.code), DEFAULT_REASON_CODES.wastage, 'the manager sees the default wastage reasons, in order (same list as the shared test helper)');
  eq(first.reasons.map((x) => x.code), SEEDED.wastage.map(([c]) => c), 'and the service seeds exactly DEFAULT_REASON_CODES');
  eq(first.reasons.find((x) => x.code === 'prep_error').label, 'Preparation error', 'a plain label');
  eq(first.reasons.find((x) => x.code === 'theft_suspected').needsNote, true, 'theft suspected needs a note by default');
  await mgr('manager', 'GET', '/reason-codes'); await own('owner', 'GET', '/reason-codes');
  eq((await one(`select count(*)::int as n from public.stock_reason_codes where kind = 'wastage'`)).n, 9, 'reading again does not seed again');
  eq((await mgr('manager', 'GET', '/reason-codes', undefined, '?kind=adjustment')).reasons.map((x) => x.code), DEFAULT_REASON_CODES.adjustment, 'adjustment reasons are seeded on their own first read');
  eq((await one(`select count(*)::int as n from public.stock_reason_codes`)).n, 13, 'nothing else was seeded');

  const dropped = await own('owner', 'POST', '/reason-codes', { kind: 'wastage', label: 'Dropped', needsPhoto: false });
  eq([dropped.code, dropped.label, dropped.position, dropped.active], ['dropped', 'Dropped', 9, true], 'the owner adds a reason; its code comes from the label; it goes last');
  await refuses(own('owner', 'POST', '/reason-codes', { kind: 'wastage', label: 'dropped' }), 409, 'reason_exists', /already have a reason called “Dropped”/, 'a duplicate name');
  await refuses(own('owner', 'POST', '/reason-codes', { kind: 'wastage', label: '  ' }), 400, 'label_required');
  await refuses(own('manager', 'POST', '/reason-codes', { kind: 'wastage', label: 'Mine' }), 403, 'forbidden', null, 'a branch manager can not add reasons (owner route is for owners/operations)');
  const renamed = await own('owner', 'PUT', `/reason-codes/${dropped.id}`, { label: 'Dropped on the floor', needsPhoto: true });
  eq([renamed.code, renamed.label, renamed.needsPhoto], ['dropped', 'Dropped on the floor', true], 'rename keeps the code');
  await own('owner', 'PUT', `/reason-codes/${dropped.id}`, { needsPhoto: false });
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'reason_code' and entity_id = $1`, [dropped.id])).n, 3, 'create, rename and flag change are audited');
  const spill = first.reasons.find((x) => x.code === 'spill');
  await own('owner', 'PUT', `/reason-codes/${spill.id}`, { active: false });
  ok(!(await mgr('manager', 'GET', '/reason-codes')).reasons.some((x) => x.code === 'spill'), 'a switched-off reason disappears from the branch chips');
  ok((await own('owner', 'GET', '/reason-codes', undefined, '?includeInactive=1')).reasons.some((x) => x.code === 'spill' && !x.active), 'but the owner still sees it');
  await refuses(mgr('manager', 'POST', '/wastage', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spill.id }), 409, 'reason_inactive', /switched off/, 'recording with a switched-off reason');
  await own('owner', 'PUT', `/reason-codes/${spill.id}`, { active: true });
  eq((await asTx('owner', (t, s) => reasons.list(t, s, { kind: 'wastage' }))).reasons.length, 10, 'switched back on: ten reasons');
  await refuses(asTx('manager', (t, s) => reasons.update(t, s, spill.id, { label: 'x' })), 403, 'forbidden', null, 'service: manager can not edit');
}
const reason = async (code) => (await asTx('owner', (t, s) => reasons.list(t, s, { kind: 'wastage', includeInactive: true }))).reasons.find((x) => x.code === code);
const spoiled = await reason('spoiled');
const burned = await reason('burned');
const theft = await reason('theft_suspected');
const rec = (who, body, branchHeader = true) => (branchHeader ? mgr(who, 'POST', '/wastage', body) : own(who, 'POST', '/wastage', body));

// ============================================================================================================
// No rule: wastage posts at once (safe default D3-4); the legacy setting becomes a rule
// ============================================================================================================
{
  const stockBefore = await onHand(chicken);
  const out = await rec('manager', { itemId: chicken, quantity: 500, unit: 'g', reasonCodeId: spoiled.id, note: 'Left out overnight' });
  eq([out.posted, out.pendingApproval, out.wastage.status, out.wastage.number], [true, false, 'recorded', 'WST-2026-0001'], 'no rule: posted at once, numbered');
  eq(await onHand(chicken), stockBefore - 500, 'stock went down by 500 g');
  const m = (await movements(chicken))[0];
  eq([m.delta, m.reason, m.ref_type, m.ref_id, m.value, m.cost, m.actor_id], ['-500.0000', 'wastage', 'wastage', out.wastage.id, '-250.00', '0.500000', people.manager], 'a ledger movement of the separate type wastage, referencing the record, at average cost');
  eq([out.wastage.valueKes, out.wastage.reason.code, out.wastage.reason.label, out.wastage.recordedBy], ['250.00', 'spoiled', 'Spoiled', people.manager], 'the record shows the cost and the reason');
  eq(m.note, 'Spoiled: Left out overnight', 'the movement note carries reason and note');
  eq(out.evaluation.safeDefault, true, 'the evaluation says this is the safe default');
  eq((await q(`select id from public.wastage_records where status = 'recorded' and movement_ids = $1::bigint[]`, [`{${m.id}}`])).length, 1, 'the record keeps its movement ids');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'wastage' and entity_id = $1 and action = 'record'`, [out.wastage.id])).n, 1, 'audited');

  // An item with no cost: value unknown, still posted when there is no rule.
  const nocost = await rec('manager', { itemId: salt, quantity: 100, unit: 'g', reasonCodeId: spoiled.id });
  eq([nocost.posted, nocost.wastage.valueKes, nocost.wastage.costUnknown], [true, null, true], 'no cost known: posted, value null, flagged cost unknown (never shown as 0)');

  // Units: kg.
  const kg = await rec('manager', { itemId: chicken, quantity: '0.25', unit: 'kg', reasonCodeId: spoiled.id });
  eq([kg.wastage.quantityBase, kg.wastage.quantity, kg.wastage.unit, kg.wastage.valueKes], ['250.0000', '0.2500', 'kg', '125.00'], 'quantity in any unit is converted and kept as entered');
  eq((await movements(chicken)).at(-1).delta, '-250.0000', 'and the movement is in the base unit');

  // The Phase 1 setting becomes a rule, once.
  await setSetting(db, { businessId: biz, key: 'wastage_approval_value_kes', value: 2000, actorId: people.owner });
  const withSetting = await rec('manager', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id });
  eq(withSetting.posted, true, 'below the migrated limit: posted');
  const migrated = await one(`select id, per_transaction_kes::text as p, approver_capability from public.approval_rules where subject = 'wastage' and location_id is null`);
  eq([migrated.p, migrated.approver_capability], ['2000.00', 'inv.adjust.approve'], 'the setting became a business-wide wastage rule');
  eq((await one(`select count(*)::int as n from public.inventory_settings where key = 'wastage_approval_value_kes'`)).n, 0, 'and the setting was cleared so it can not come back');
  eq((await one(`select count(*)::int as n from public.inventory_events where action = 'migrate_wastage_limit'`)).n, 1, 'audited');
  await rec('manager', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id });
  eq((await one(`select count(*)::int as n from public.approval_rules where subject = 'wastage'`)).n, 1, 'no second rule');
}

// ============================================================================================================
// T-CTL-1: above the owner's limit
// ============================================================================================================
const wid = (out) => out.wastage.id;
{
  await rule({ perTransactionKes: 1000 });
  const stock = await onHand(chicken);
  const under = await rec('manager', { itemId: chicken, quantity: 2000, unit: 'g', reasonCodeId: spoiled.id });   // KES 1000.00 = the limit
  eq([under.posted, under.wastage.status], [true, 'recorded'], 'exactly at the limit: posted (only MORE than the limit needs approval)');
  const stock1 = await onHand(chicken);
  const big = await rec('manager', { itemId: chicken, quantity: 5000, unit: 'g', reasonCodeId: spoiled.id, note: 'Freezer failed', commandId: crypto.randomUUID() });
  eq([big.posted, big.pendingApproval, big.wastage.status, big.wastage.valueKes], [false, true, 'pending_approval', '2500.00'], 'above the limit: waiting for the owner, cost shown');
  ok(big.evaluation.reasons.length === 1 && /Over your KES 1,000 limit per wastage record/.test(big.evaluation.reasons[0]), 'with the reason in plain words');
  eq(await onHand(chicken), stock1, 'NOTHING posted while it waits');
  eq((await movements(chicken)).filter((x) => x.ref_id === wid(big)).length, 0, 'no movement exists for it');
  const approval = await one(`select id, status, amount_kes::text as a, subject_type from public.approvals where subject_id = $1`, [wid(big)]);
  eq([approval.status, approval.a, approval.subject_type], ['pending', '2500.00', 'wastage'], 'an approval request exists');
  eq((await notes(people.owner, 'approval_needed')).length, 1, 'the owner was asked');

  // The branch manager can not approve; the person who asked can not either while another approver exists.
  await refuses(decideApi('manager', approval.id, { decision: 'approve' }), 403, 'forbidden', null, 'a branch manager does not approve');
  const ownersOwn = await rec('owner', { locationId: B1, itemId: chicken, quantity: 4000, unit: 'g', reasonCodeId: spoiled.id }, false);
  eq(ownersOwn.pendingApproval, true, 'the owner is held to the limit too');
  const ownApproval = (await one(`select id from public.approvals where subject_id = $1`, [wid(ownersOwn)])).id;
  await refuses(decideApi('owner', ownApproval, { decision: 'approve' }), 403, 'maker_checker', /can’t approve something you created/, 'maker is not the checker');
  await decideApi('owner2', ownApproval, { decision: 'reject', note: 'Count it again first' });
  eq((await one(`select status from public.wastage_records where id = $1`, [wid(ownersOwn)])).status, 'rejected', 'rejected: the record is kept');
  eq(await onHand(chicken), stock1, 'and nothing posted');
  eq((await movements(chicken)).filter((x) => x.ref_id === wid(ownersOwn)).length, 0, 'no movement for a rejected record');

  // Cost is frozen at record time: the average moves before the approval.
  await receive(db, { businessId: biz, locationId: B1, itemId: chicken, qty: '10000', unitCost: '0.9' });
  const avgNow = Number((await one('select avg_cost::text as c from public.stock_items where id = $1', [chicken])).c);
  ok(avgNow > 0.5, 'the average cost moved up after the record was made');
  const stock2 = await onHand(chicken);
  const decided = await decideApi('owner', approval.id, { decision: 'approve', note: 'Freezer was down, saw it' });
  eq(decided.status, 'approved', 'approved by the owner');
  eq(await onHand(chicken), stock2 - 5000, 'now it posted: 5000 g left stock');
  const posted = (await movements(chicken)).find((x) => x.ref_id === wid(big));
  eq([posted.reason, posted.delta, posted.value, posted.cost, posted.actor_id], ['wastage', '-5000.0000', '-2500.00', '0.500000', people.manager], 'a wastage movement at the cost frozen when it was recorded (not the new average), credited to who recorded it');
  const row = await one(`select status, movement_ids, posted_at from public.wastage_records where id = $1`, [wid(big)]);
  eq([row.status, row.movement_ids.length, row.posted_at !== null], ['approved', 1, true], 'the record is approved and carries its movement');
  eq((await one(`select idempotency_key as k from public.stock_movements where id = $1`, [row.movement_ids[0]])).k, `wastage:${wid(big)}:0`, 'posted with the key wastage:<id>:<line>');
  eq((await notes(people.manager, 'approval_decided')).length >= 1, true, 'the manager was told');
  // Replaying the decision never posts twice.
  const again = await decideApi('owner', approval.id, { decision: 'approve' });
  eq(again.replayed, true, 'deciding again is a replay');
  eq((await movements(chicken)).filter((x) => x.ref_id === wid(big)).length, 1, 'still one movement');
  eq(await onHand(chicken), stock2 - 5000, 'and the stock did not move again');

  // Approving needs the stock to still be there: the decision is rolled back with the ledger's message.
  const salty = await rec('manager', { itemId: bun, quantity: 1950, unit: 'g', reasonCodeId: spoiled.id });          // 195 -> posted (below the limit)
  eq(salty.posted, true, 'sanity: buns written off, a few left');
  await receive(db, { businessId: biz, locationId: B1, itemId: bun, qty: '12000', unitCost: '0.1' });
  const bigBuns = await rec('manager', { itemId: bun, quantity: 11000, unit: 'g', reasonCodeId: spoiled.id });       // 1100 -> approval
  eq(bigBuns.pendingApproval, true, 'a second big record waits');
  await asTx('owner', (t) => import('../../src/inventory/ledger.js').then((l) => l.post(t, { businessId: biz, locationId: B1, itemId: bun, qty: '-11500', reason: 'served', idempotencyKey: 'drain-1' })));
  const bunApproval = (await one(`select id from public.approvals where subject_id = $1`, [wid(bigBuns)])).id;
  await refuses(decideApi('owner', bunApproval, { decision: 'approve' }), 409, 'insufficient_stock', /can’t be approved yet\. Only .* of Bun left here/, 'stock gone before the approval');
  eq((await one(`select status from public.approvals where id = $1`, [bunApproval])).status, 'pending', 'the approval stays pending (the decision was rolled back)');
  eq((await one(`select status from public.wastage_records where id = $1`, [wid(bigBuns)])).status, 'pending_approval', 'and so does the record');
  await decideApi('owner', bunApproval, { decision: 'reject', note: 'Stock is gone, written off by the count' });

  // The cost-less item with a rule in force cannot be proven under the limit.
  const sold = await rec('manager', { itemId: salt, quantity: 50, unit: 'g', reasonCodeId: spoiled.id });
  eq([sold.pendingApproval, sold.wastage.costUnknown], [true, true], 'no cost known and a rule exists: goes to approval');
  ok(/no cost yet/.test(sold.evaluation.reasons.join(' ')), 'with the reason spelt out');
}

// ============================================================================================================
// Stop at zero
// ============================================================================================================
{
  const stock = await onHand(bun);
  const sequenceBefore = (await one(`select last_number as n from public.inventory_number_sequences where kind = 'WST'`)).n;
  const recordsBefore = await wasteCount();
  await refuses(rec('manager', { itemId: bun, quantity: stock + 100, unit: 'g', reasonCodeId: spoiled.id }), 409, 'insufficient_stock', /Only .* of Bun left here; you tried to take .*Take less/, 'more than is there');
  eq(await onHand(bun), stock, 'stock unchanged');
  eq([await wasteCount(), (await one(`select last_number as n from public.inventory_number_sequences where kind = 'WST'`)).n], [recordsBefore, sequenceBefore], 'no record and no document number was used up (one transaction)');
  await refuses(rec('manager', { itemId: chicken, quantity: 0, unit: 'g', reasonCodeId: spoiled.id }), 400, 'zero_quantity');
  await refuses(rec('manager', { itemId: chicken, quantity: 1, unit: 'cup', reasonCodeId: spoiled.id }), 400, 'unit_mismatch', null, 'a unit the item does not have');
  await refuses(rec('manager', { itemId: chicken, quantity: 1, unit: 'g' }), 400, 'reason_required', /Pick a reason/, 'a reason is required');
  await refuses(rec('manager', { itemId: chicken, quantity: 1, unit: 'g', reasonCode: 'made up' }), 404, 'reason_not_found');
  await refuses(rec('manager', { quantity: 1, unit: 'g', reasonCodeId: spoiled.id }), 400, 'subject_required');
  await refuses(rec('manager', { itemId: chicken, menuItemId: ids.burgerId, quantity: 1, reasonCodeId: spoiled.id }), 400, 'subject_required', /either a stock item or a dish/, 'both');
}

// ============================================================================================================
// A dish: expanded through the recipe, yield applied
// ============================================================================================================
{
  const c0 = await onHand(chicken); const b0 = await onHand(bun);
  await rule({ perTransactionKes: 100000 });   // out of the way
  const out = await rec('manager', { menuItemId: ids.burgerId, quantity: 2, reasonCodeId: spoiled.id, note: 'Dropped the tray' });
  eq([out.posted, out.wastage.kind, out.wastage.name, out.wastage.quantity, out.wastage.unit], [true, 'dish', 'Chicken burger', '2.0000', 'portion'], 'a dish record');
  const avg = (await one('select avg_cost::text as c from public.stock_items where id = $1', [chicken])).c;      // moved to 0.595125 by the delivery above
  const chickenValue = (Math.round(571.4286 * Number(avg) * 100) / 100).toFixed(2);
  eq(out.wastage.lines.map((l) => [l.name, l.quantityBase, l.unitCost, l.valueKes]).sort(), [['Bun', '160.0000', '0.100000', '16.00'], ['Chicken', '571.4286', avg, chickenValue]].sort(),
    '2 burgers = 200 g chicken at 70 % yield (285.7143 g each) = 571.4286 g, plus 160 g bun; each at its current average cost');
  eq(out.wastage.valueKes, (Number(chickenValue) + 16).toFixed(2), 'cost = sum of the ingredient costs');
  eq([await onHand(chicken), await onHand(bun)], [c0 - 571.4286, b0 - 160], 'each ingredient left stock');
  eq((await q(`select count(*)::int as n from public.stock_movements where ref_type = 'wastage' and ref_id = $1 and reason = 'wastage'`, [wid(out)]))[0].n, 2, 'two wastage movements, one per ingredient');
  const keys = (await q(`select idempotency_key as k from public.stock_movements where ref_id = $1 order by 1`, [wid(out)])).map((x) => x.k);
  eq(keys, [`wastage:${wid(out)}:0`, `wastage:${wid(out)}:1`], 'keys wastage:<id>:<line>');
  eq(out.wastage.movementIds.length, 2, 'both movement ids kept on the record');
  // One whole burger: 285.7143 g.
  const one1 = await rec('manager', { menuItemId: ids.burgerId, quantity: 1, reasonCodeId: spoiled.id });
  eq(one1.wastage.lines.find((l) => l.name === 'Chicken').quantityBase, '285.7143', '1 burger = 285.7143 g chicken');
  const half = await rec('manager', { menuItemId: ids.burgerId, quantity: '0.5', reasonCodeId: spoiled.id });
  eq(half.wastage.lines.find((l) => l.name === 'Chicken').quantityBase, '142.8571', 'half a portion is allowed');
  // Not tracked, other branch, short ingredient.
  await refuses(rec('manager', { menuItemId: ids.friesId, quantity: 1, reasonCodeId: spoiled.id }), 400, 'dish_not_tracked', /Fries has no recipe/, 'a dish with no recipe');
  await refuses(mgr('manager2', 'POST', '/wastage', { menuItemId: ids.burgerId, quantity: 1, reasonCodeId: spoiled.id }), 400, 'dish_other_branch', /another branch’s menu/, 'a dish of another branch');
  const stock = await onHand(bun);
  await asTx('owner', (t) => import('../../src/inventory/ledger.js').then((l) => l.post(t, { businessId: biz, locationId: B1, itemId: bun, qty: `-${stock - 100}`, reason: 'served', idempotencyKey: 'drain-2' })));
  const chicken1 = await onHand(chicken);
  await refuses(rec('manager', { menuItemId: ids.burgerId, quantity: 2, reasonCodeId: spoiled.id }), 409, 'insufficient_stock', /Only .* of Bun left here/, 'bun is short: the whole dish is refused');
  eq(await onHand(chicken), chicken1, 'and the chicken line was not posted either (all or nothing)');
  eq(await onHand(bun), 100, 'bun untouched');
  await receive(db, { businessId: biz, locationId: B1, itemId: bun, qty: '5000', unitCost: '0.1' });
  // The recipe in force: a new version changes what the next record uses, old records keep their lines.
  await asTx('owner', (t, s) => recipes.saveRecipe(t, s, ids.burgerId, { lines: [{ itemId: chicken, quantity: 100, unit: 'g' }, { itemId: bun, quantity: 80, unit: 'g' }] }));
  const v2 = await rec('manager', { menuItemId: ids.burgerId, quantity: 1, reasonCodeId: spoiled.id });
  eq(v2.wastage.lines.find((l) => l.name === 'Chicken').quantityBase, '142.8571', 'a new recipe version is used for new records');
  eq((await wastage.get(await db.transaction(async () => db), await scopeOf('owner'), wid(out))).wastage.lines.find((l) => l.name === 'Chicken').quantityBase, '571.4286', 'while the old record keeps what it wrote off');
}

// ============================================================================================================
// Photos and notes required per reason
// ============================================================================================================
{
  await own('owner', 'PUT', `/reason-codes/${burned.id}`, { needsPhoto: true });
  await refuses(rec('manager', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: burned.id }), 400, 'photo_required', /needs a photo/, 'burned needs a photo now');
  await refuses(rec('manager', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: theft.id }), 400, 'note_required', /needs a note/, 'theft suspected needs a note');
  const id = crypto.randomUUID();
  const up = await mgr('manager', 'POST', '/wastage/photo', { id, file: file(jpeg('w')) });
  eq([up.entityType, up.entityId, up.locationId, up.duplicate], ['wastage', id, B1, false], 'the photo is uploaded for the record to come');
  const other = await mgr('manager', 'POST', '/wastage/photo', { id: crypto.randomUUID(), file: file(jpeg('z')) });
  await refuses(rec('manager', { id, itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: burned.id, photoIds: [other.id] }), 400, 'bad_photo', /wasn’t uploaded for this wastage record/, 'a photo that belongs to another record');
  const stock = await onHand(chicken);
  const withPhoto = await rec('manager', { id, itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: burned.id, photoIds: [up.id] });
  eq([withPhoto.posted, withPhoto.wastage.id, withPhoto.wastage.photoIds, withPhoto.wastage.photos.map((p) => p.id)], [true, id, [up.id], [up.id]], 'the record carries the photo link (and the id it was uploaded for)');
  eq(await onHand(chicken), stock - 100, 'posted');
  const detail = await mgr('manager', 'GET', `/wastage/${id}`);
  eq(detail.wastage.photos.length, 1, 'the detail shows the photo');
  await refuses(rec('manager', { id, itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id }), 409, 'id_taken');
  await refuses(mgr('manager', 'POST', '/wastage/photo', { id: 'nope', file: file(jpeg('q')) }), 400, 'bad_id');
  // Photos on a pending record are kept too.
  await own('owner', 'PUT', `/reason-codes/${burned.id}`, { needsPhoto: false });
}

// ============================================================================================================
// Replay: the same request id returns the same record
// ============================================================================================================
{
  const commandId = crypto.randomUUID();
  const stock = await onHand(chicken);
  const a = await rec('manager', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id, commandId });
  const b = await rec('manager', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id, commandId });
  eq([a.wastage.id === b.wastage.id, await onHand(chicken)], [true, stock - 100], 'a retried request (route level) records once');
  const c = await asTx('manager', (t, s) => wastage.record(t, s, { locationId: B1, itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id, commandId: crypto.randomUUID() }, { now: clock.now() }));
  const d = await asTx('manager', (t, s) => wastage.record(t, s, { locationId: B1, itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id, commandId: crypto.randomUUID() }, { now: clock.now() }));
  ok(c.wastage.id !== d.wastage.id, 'different request ids are different records');
  const cmd = crypto.randomUUID();
  const e = await asTx('manager', (t, s) => wastage.record(t, s, { locationId: B1, itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id, commandId: cmd }, { now: clock.now() }));
  const f = await asTx('manager', (t, s) => wastage.record(t, s, { locationId: B1, itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id, commandId: cmd }, { now: clock.now() }));
  eq([e.replayed, f.replayed, e.wastage.id === f.wastage.id], [false, true, true], 'the service itself replays by command id');
  await refuses(rec('manager', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id, commandId: 'nope' }), 400, 'bad_command_id');
}

// ============================================================================================================
// Unusual wastage: last 7 days vs the average of the 28 days before
// ============================================================================================================
{
  await rule({ perTransactionKes: 100000 });
  const tomato = await makeItem(db, biz, 'Tomato');
  const onion = await makeItem(db, biz, 'Onion');
  const pepper = await makeItem(db, biz, 'Pepper');
  const T = clock.now();
  const day = 86_400_000;
  for (const item of [tomato, onion, pepper]) await postAt(db, new Date(T.getTime() - 60 * day), { businessId: biz, locationId: B1, itemId: item, qty: '100000', reason: 'purchase_receipt', unitCost: '1' });
  // History for tomato and onion: 100 g (KES 100) in each of the 4 weeks before this one => weekly average 100.00.
  for (const item of [tomato, onion]) for (const back of [10, 17, 24, 31]) {
    await postAt(db, new Date(T.getTime() - back * day), { businessId: biz, locationId: B1, itemId: item, qty: '-100', reason: 'wastage', actorId: people.manager });
  }
  await db.query('delete from public.notifications');
  const w = (item, grams) => asTx('manager', (t, s) => wastage.record(t, s, { locationId: B1, itemId: item, quantity: grams, unit: 'g', reasonCodeId: spoiled.id }, { now: clock.now() }));
  const r1 = await w(tomato, 150);
  eq(r1.unusual, null, '150 vs average 100: 1.5 times, below the 2 times factor: no alert');
  eq((await q('select id from public.notifications where kind = $1', ['wastage_unusual'])).length, 0, 'nothing sent');
  const r2 = await w(tomato, 50);
  eq(r2.unusual, null, 'exactly 200 = 2.0 times: not MORE than the factor: no alert');
  const check = await asTx('owner', (t, s) => wastage.checkUnusual(t, s, { locationId: B1, itemId: tomato, now: clock.now() }));
  eq([check.thisWeek, check.average, check.factor], ['200.00', '100.00', 2], 'the numbers: 200.00 this week, 100.00 average');
  const r3 = await w(tomato, 10);
  eq([r3.unusual?.length, r3.unusual?.[0].thisWeek, r3.unusual?.[0].average], [1, '210.00', '100.00'], '210 is more than 2 x 100: unusual');
  const who = async (user) => (await notes(user, 'wastage_unusual')).length;
  eq([await who(people.owner), await who(people.owner2), await who(people.manager)], [1, 1, 1], 'owners and the branch manager are told, once');
  eq([await who(people.manager2), await who(people.ops), await who(people.waiter)], [0, 0, 0], 'nobody else (other branch, operations, waiter)');
  const note = (await notes(people.owner, 'wastage_unusual'))[0];
  ok(/Tomato wastage at .* was KES 210 in the last 7 days, 2.1 times its usual KES 100 a week/.test(note.body), `plain wording: ${note.body}`);
  await w(tomato, 100);
  eq([await who(people.owner), await who(people.manager)], [1, 1], 'more wastage the same week: deduped, no second alert');
  // No history = nothing to compare with.
  const r4 = await w(pepper, 5000);
  eq(r4.unusual, null, 'an item with no wastage history never alerts');
  // The floor hides trivial amounts; the factor is the owner's.
  await setSetting(db, { businessId: biz, key: 'unusual_wastage_floor_kes', value: 500, actorId: people.owner });
  eq((await w(onion, 300)).unusual, null, 'above 2 x average (300 vs 100) but below the KES 500 floor: no alert');
  await setSetting(db, { businessId: biz, key: 'unusual_wastage_floor_kes', value: 250, actorId: people.owner });
  eq((await w(onion, 10)).unusual?.length, 1, 'past the floor (310 >= 250) and 2 x average: alert');
  await setSetting(db, { businessId: biz, key: 'unusual_wastage_floor_kes', value: null, actorId: people.owner });
  // Next week the dedupe key changes: a new alert is possible.
  eq(await who(people.owner), 2, 'so far the owner has the tomato alert and the onion alert');
  clock.advanceDays(6);   // Tuesday 24 Nov: new Nairobi week
  const next = await w(tomato, 10);
  eq(next.unusual?.length, 1, 'a new week: unusual again (last 7 days 320 against a 75 average)');
  eq(await who(people.owner), 3, 'and the owner gets one new alert for the new week');
  eq((await q(`select dedupe_key from public.notifications where recipient_id = $1 and kind = 'wastage_unusual' order by created_at`, [people.owner])).map((x) => x.dedupe_key.split(':').at(-1)).filter((x, i, a) => a.indexOf(x) === i).length >= 2, true, 'the week is part of the dedupe key');
  clock.advanceDays(-6);
}

// ============================================================================================================
// Who can see and do what; history filters
// ============================================================================================================
{
  const stock2 = await rec('manager2', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id });
  const b1Record = (await q(`select id from public.wastage_records where location_id = $1 order by created_at limit 1`, [B1]))[0].id;
  await refuses(mgr('manager2', 'GET', `/wastage/${b1Record}`), 403, 'branch_forbidden', null, 'branch 2 manager can not open a branch 1 record');
  eq((await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and actor_id = $1`, [people.manager2])).n >= 1, true, 'the attempt is audited');
  await refuses(run(wasteApi, 'manager2', 'POST', '/api/inventory/wastage', { itemId: chicken, quantity: 100, unit: 'g', reasonCodeId: spoiled.id }, '', ids.branchId), 403, 'branch_forbidden', null, 'recording through the other branch header');
  await refuses(own('manager', 'POST', '/wastage', { locationId: B1, itemId: chicken, quantity: 1, unit: 'g', reasonCodeId: spoiled.id }), 403, 'forbidden', null, 'a manager can not use the owner route');
  await refuses(asTx('manager', (t, s) => wastage.record(t, s, { locationId: B2, itemId: chicken, quantity: 1, unit: 'g', reasonCodeId: spoiled.id })), 403, 'forbidden', null, 'service: manager at another branch');
  await refuses(mgr('waiter', 'POST', '/wastage', { itemId: chicken, quantity: 1, unit: 'g', reasonCodeId: spoiled.id }), 403, 'forbidden', null, 'a waiter can not record');
  await refuses(mgr('waiter', 'GET', '/wastage'), 403, 'forbidden', null, 'a waiter can not read the log');
  await refuses(own('ops', 'POST', '/wastage', { locationId: B1, itemId: chicken, quantity: 1, unit: 'g', reasonCodeId: spoiled.id }), 403, 'forbidden', null, 'operations can look, not record');
  ok((await own('ops', 'GET', '/wastage')).wastage.length > 0, 'operations managers read the log of their branches');
  const warehouse = await own('owner', 'POST', '/wastage', { locationId: ids.centerLocationId, itemId: chicken, quantity: 1, unit: 'g', reasonCodeId: spoiled.id }).catch((e) => e);
  eq(warehouse instanceof HttpError ? warehouse.details.code : 'posted', 'insufficient_stock', 'the owner can record at the warehouse too (it has no stock here, so the ledger refuses)');

  const mine = await mgr('manager', 'GET', '/wastage');
  ok(mine.wastage.length > 10 && mine.wastage.every((x) => x.locationId === B1), 'a manager lists only their branch');
  const everything = await own('owner', 'GET', '/wastage', undefined, '?limit=200');
  ok(everything.wastage.some((x) => x.locationId === B2) && everything.wastage.some((x) => x.locationId === B1), 'the owner lists every branch');
  eq((await own('owner', 'GET', '/wastage', undefined, `?locationId=${B2}`)).wastage.map((x) => x.locationId), [B2], 'filtered by branch');
  const bySpoiled = await own('owner', 'GET', '/wastage', undefined, '?reason=burned&limit=200');
  ok(bySpoiled.wastage.length === 1 && bySpoiled.wastage[0].reason.code === 'burned', 'filtered by reason code');
  const byId = await own('owner', 'GET', '/wastage', undefined, `?reason=${spoiled.id}&limit=200`);
  ok(byId.wastage.length > 5, 'or by reason id');
  const byChicken = await own('owner', 'GET', '/wastage', undefined, `?itemId=${chicken}&limit=200`);
  ok(byChicken.wastage.some((x) => x.kind === 'dish') && byChicken.wastage.some((x) => x.kind === 'item'), 'filtering by an item also finds the dishes that used it');
  eq((await own('owner', 'GET', '/wastage', undefined, `?menuItemId=${ids.burgerId}&limit=200`)).wastage.every((x) => x.kind === 'dish'), true, 'filtered by dish');
  const byWho = await own('owner', 'GET', '/wastage', undefined, `?employee=${people.manager2}`);
  eq(byWho.wastage.map((x) => x.recordedBy), [people.manager2], 'filtered by employee');
  const today = await own('owner', 'GET', '/wastage', undefined, `?from=${new Date(clock.now().getTime() - 3600_000).toISOString()}&to=${new Date(clock.now().getTime() + 3600_000).toISOString()}&limit=200`);
  ok(today.wastage.length > 5, 'filtered by date');
  eq((await own('owner', 'GET', '/wastage', undefined, '?from=2020-01-01&to=2020-01-02')).wastage.length, 0, 'an empty window');
  const pending = await own('owner', 'GET', '/wastage', undefined, '?status=pending_approval');
  ok(pending.wastage.length >= 1 && pending.wastage.every((x) => x.status === 'pending_approval'), 'pending ones can be listed (for the approvals view)');
  await refuses(own('owner', 'GET', '/wastage', undefined, '?status=nope'), 400, 'bad_status');
  const sum = everything.totals.byReason.reduce((s, x) => s + Number(x.valueKes), 0);
  eq([everything.totals.valueKes, Math.round(sum * 100) / 100 === Number(everything.totals.valueKes)], [everything.totals.valueKes, true], 'totals by reason add up to the total');
  ok(everything.totals.byReason[0].label && everything.totals.pending >= 1, 'with labels and the number still pending');
  const posted = everything.wastage.filter((x) => ['recorded', 'approved'].includes(x.status)).reduce((s, x) => s + Number(x.valueKes ?? 0), 0);
  eq(Math.round(posted * 100) / 100, Number(everything.totals.valueKes), 'and the total counts posted records only (not pending or rejected)');
  const page = await own('owner', 'GET', '/wastage', undefined, '?limit=5');
  eq([page.wastage.length, typeof page.nextBefore], [5, 'string'], 'paging: a next marker');
  const next = await own('owner', 'GET', '/wastage', undefined, `?limit=5&before=${encodeURIComponent(page.nextBefore)}`);
  ok(next.wastage.length > 0 && !next.wastage.some((x) => page.wastage.some((p) => p.id === x.id)), 'the next page continues without repeating (even when many records share a moment)');
  eq(stock2.posted, true, 'sanity');
}

// ============================================================================================================
// The old branch route (kind waste) delegates and keeps its response shape
// ============================================================================================================
{
  await db.query(`delete from public.approval_rules where subject = 'wastage'`);
  const shape = (x) => Object.keys(x).filter((k) => !['wastage', 'pendingApproval'].includes(k)).sort();
  const stock = await onHand(chicken);
  const old = await oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 300, unit: 'g', note: 'Spoiled in the fridge', reasonCode: 'spoiled' });
  eq(shape(old), ['available', 'changed', 'display', 'itemId', 'itemName', 'kind', 'message', 'movement', 'onHand', 'replayed', 'warnings'], 'the same keys as before');
  eq([old.kind, old.changed, old.movement.reason, old.movement.delta, old.movement.reasonLabel, old.onHand], ['waste', true, 'wastage', '-300.0000', 'Waste', (stock - 300).toFixed(4)], 'and the same values');
  eq(old.movement.entered, { quantity: '300.0000', unit: 'g' }, 'entered quantity kept');
  ok(/^Wrote off 0\.3 kg of Chicken\. Now [\d.]+ kg\.$/.test(old.message), `the same message: ${old.message}`);
  eq(old.wastage.status, 'recorded', 'and it created a wastage record behind the scenes');
  const linked = await one(`select reason_code_id, reason_text from public.wastage_records where id = $1`, [old.wastage.id]);
  eq([linked.reason_code_id, linked.reason_text], [spoiled.id, 'Spoiled'], 'the code "spoiled" matched the owner\'s reason');
  const free = await oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 100, unit: 'g', note: 'Smashed jar', reasonCode: 'smashed jar' });
  const f2 = await one(`select reason_code_id, reason_text from public.wastage_records where id = $1`, [free.wastage.id]);
  eq([f2.reason_code_id, f2.reason_text], [null, 'smashed jar'], 'free text the owner has not listed is kept as text, like before');
  const none = await oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 100, unit: 'g', note: 'Just because' });
  eq((await one(`select reason_text from public.wastage_records where id = $1`, [none.wastage.id])).reason_text, 'Not stated', 'no reason given: kept as "Not stated"');
  await refuses(oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 100, unit: 'g' }), 400, 'note_required', /Say why Chicken was written off/, 'a note is still required on the old route');
  await refuses(oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 10000000, unit: 'g', note: 'oops', confirmLarge: true }), 409, 'insufficient_stock', /Only .* of Chicken left here/, 'stop at zero, same message');
  // Replay with a commandId.
  const commandId = crypto.randomUUID();
  const s0 = await onHand(chicken);
  await oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 100, unit: 'g', note: 'Twice sent', commandId });
  await oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 100, unit: 'g', note: 'Twice sent', commandId });
  eq(await onHand(chicken), s0 - 100, 'a retried request records once');
  // With a rule above the limit the old route reports the waiting state.
  await rule({ perTransactionKes: 10 });
  const wait = await oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 1000, unit: 'g', note: 'A lot', reasonCode: 'spoiled' });
  eq([wait.movement, wait.pendingApproval, wait.changed, wait.wastage.status], [null, true, true, 'pending_approval'], 'above the limit: no movement, waiting for approval');
  ok(/Sent for approval/.test(wait.message), 'with a plain message');
  eq(await onHand(chicken), s0 - 100, 'stock unchanged');
  // A reason that needs a photo can not be satisfied by the old route.
  await own('owner', 'PUT', `/reason-codes/${burned.id}`, { needsPhoto: true });
  await refuses(oldRecord('manager', { kind: 'waste', itemId: chicken, quantity: 1, unit: 'g', note: 'x', reasonCode: 'burned' }), 400, 'photo_required');
  await own('owner', 'PUT', `/reason-codes/${burned.id}`, { needsPhoto: false });
}

// ============================================================================================================
// Housekeeping
// ============================================================================================================
{
  // The shared helper's list and the seeded one are the same, and the migration seeded nothing.
  eq(Object.fromEntries(Object.entries(SEEDED).filter(([k]) => k in DEFAULT_REASON_CODES).map(([k, v]) => [k, v.map(([c]) => c)])), DEFAULT_REASON_CODES, 'helpers.DEFAULT_REASON_CODES matches the service defaults');
  // The ledger still reconciles after everything above.
  const { reconcile } = await import('../../src/inventory/ledger.js');
  const bad = await reconcile(db, { businessId: biz });
  eq(Array.isArray(bad) ? bad.length : (bad.mismatches ?? bad.problems ?? []).length, 0, 'the ledger reconciles with the balances after all of it');
  clearDecisionHandlers(); wastage.resetWastageApprovals(); wastage.ensureWastageApprovals();
  eq(typeof wastage.applyDecision, 'function', 'the decision callback can be re-registered');
}

console.log(`Wastage: ${count()} checks passed (disposable PGlite database, fake clock, fake storage).`);
await db.close();
