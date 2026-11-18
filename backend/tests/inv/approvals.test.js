// Approvals engine + owner/branch API (P2-10 core, migration 017). Runs the REAL service and route handlers against an in-memory database with
// every proposed migration applied. Covers: safe defaults when the owner has set nothing (D2-16), rule precedence (branch over business default,
// category extras), running day/week totals in Africa/Nairobi across midnight, T-EMP-4 (change a rule, behaviour changes at once), maker-checker
// (T-SEC-2) and the sole-owner self-approval flag (D2-5), notifications sent once, onDecided callbacks, validation messages, permissions.
// Usage: node backend/tests/inv/approvals.test.js
import { rig } from './fixture.js';
import { fakeClock, makeAsserts, makeItem } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-approvals.js';
import { setSetting } from '../../src/inventory/policies.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import {
  approverAvailable, approverIds, cancel, clearDecisionHandlers, decide, deleteRule, evaluate, history, inbox, limits, listRules, mine, onDecided, request, setRule, windowsFor,
} from '../../src/inventory/approvals.js';
import { createUser } from '../support/pg.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, contexts, helpers } = r;
const biz = ids.businessId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const tx = (fn) => db.transaction(fn);
const scopeOf = (who) => inventoryScope(db, contexts[who], biz);
/** Builds the caller's scope BEFORE the transaction opens (a single-connection test database can't be queried from outside while a transaction is open). */
const asTx = async (who, fn) => { const scope = await scopeOf(who); return tx((t) => fn(t, scope)); };
const uuid = () => crypto.randomUUID();
const B1 = branches.branch1.locationId;
const B2 = branches.branch2.locationId;
const W = ids.centerLocationId;

/* ---------- helpers ---------- */
let epn = 0;
/** Inserts an emergency purchase directly with the status and time the test wants. status: authorised | pending | rejected | cancelled | draft. */
async function ep(locationId, amount, at, { status = 'authorised', lines = [] } = {}) {
  const id = (await one(`insert into public.emergency_purchases (business_id, number, location_id, requested_by, reason, estimated_total) values ($1, $2, $3, $4, 'Ran out', $5) returning id`,
    [biz, `EP-2026-${String(++epn).padStart(4, '0')}`, locationId, people.manager, amount])).id;
  for (const [position, l] of lines.entries()) {
    await db.query(`insert into public.emergency_purchase_lines (business_id, emergency_id, position, item_id, entered_qty, entered_unit, unit_factor, qty_base, est_unit_price, est_total)
      values ($1, $2, $3, $4, 1, 'kg', 1000, 1000, $5, $5)`, [biz, id, position, l.itemId, l.amount]);
  }
  if (status === 'authorised') await db.query(`update public.emergency_purchases set status = 'authorised', authorised_at = $2, approved_total = $3 where id = $1`, [id, at, amount]);
  if (status === 'pending') await db.query(`update public.emergency_purchases set status = 'pending_approval', submitted_at = $2 where id = $1`, [id, at]);
  if (status === 'rejected') { await db.query(`update public.emergency_purchases set status = 'pending_approval' where id = $1`, [id]); await db.query(`update public.emergency_purchases set status = 'rejected' where id = $1`, [id]); }
  if (status === 'cancelled') await db.query(`update public.emergency_purchases set status = 'cancelled', cancelled_at = now() where id = $1`, [id]);
  return id;
}
/** Test housekeeping: removes every emergency purchase (guards bypassed, as a DBA would). */
async function clearEps() {
  await db.exec('set session_replication_role = replica');
  await db.query('delete from public.emergency_purchase_lines');
  await db.query('delete from public.emergency_purchases');
  await db.exec('set session_replication_role = origin');
}
const ownerScope = await scopeOf('owner');
const owner2Scope = await scopeOf('owner2');
const rule = (fields) => tx((t) => setRule(t, ownerScope, fields));
const emergency = (locationId, amount, extra = {}) => evaluate(db, { businessId: biz, subject: 'emergency_purchase', locationId, amountKes: amount, ...extra });

/* ======================================================================================================== */
// 0. Time windows (Africa/Nairobi, week = Monday-Sunday)
/* ======================================================================================================== */
{
  const w = windowsFor(new Date('2026-11-18T09:00:00+03:00'));   // a Wednesday
  eq(w.dayStart.toISOString(), '2026-11-17T21:00:00.000Z', 'day starts at Nairobi midnight (21:00 UTC the day before)');
  eq(w.weekStart.toISOString(), '2026-11-15T21:00:00.000Z', 'week starts Monday 00:00 Nairobi');
  eq(w.weekEnd.toISOString(), '2026-11-22T21:00:00.000Z', 'week ends the next Monday 00:00 Nairobi');
  eq(windowsFor(new Date('2026-11-22T20:59:59Z')).weekStart.toISOString(), '2026-11-15T21:00:00.000Z', 'Sunday 23:59:59 Nairobi is still the same week');
  eq(windowsFor(new Date('2026-11-22T21:00:00Z')).weekStart.toISOString(), '2026-11-22T21:00:00.000Z', 'Monday 00:00 Nairobi starts a new week');
}

/* ======================================================================================================== */
// 1. Safe defaults: the owner has set nothing (D2-16, D2-6)
/* ======================================================================================================== */
{
  eq((await q('select count(*)::int as n from public.approval_rules')).at(0).n, 0, 'no rules exist: nothing is seeded');
  const e = await emergency(B1, '100');
  eq([e.needsApproval, e.safeDefault, e.approverCapability], [true, true, 'inv.emergency.approve'], 'no limit set: every emergency buy needs approval, even KES 100');
  ok(/No limit is set for Main branch/.test(e.reasons[0]) && /owner approves every emergency purchase/.test(e.reasons[0]), 'in plain words');
  eq((await emergency(B2, '0')).needsApproval, true, 'even a zero amount');
  const w = await evaluate(db, { businessId: biz, subject: 'wastage', locationId: B1, amountKes: '50000' });
  eq([w.needsApproval, w.safeDefault, w.reasons], [false, true, []], 'wastage: recorded straight away with no rule');
  const a = await evaluate(db, { businessId: biz, subject: 'adjustment', locationId: B1, amountKes: '1' });
  eq([a.needsApproval, a.safeDefault, a.approverCapability], [true, true, 'inv.adjust.approve'], 'a manual adjustment always needs approval');
  ok(/until you set a limit/.test(a.reasons[0]), 'adjustment reason');
  const c1 = await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, hasVariance: true });
  eq([c1.needsApproval, c1.safeDefault, c1.approverCapability], [true, true, 'inv.count.approve'], 'a count with variance needs one approval');
  eq((await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, hasVariance: false })).needsApproval, false, 'a clean count needs none');
  eq((await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, varianceKes: '0', variancePct: 0 })).needsApproval, false, 'zero variance is clean');
  eq((await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, varianceKes: '12.50' })).needsApproval, true, 'any money variance needs approval');
  const po = await evaluate(db, { businessId: biz, subject: 'purchase_order', locationId: W, amountKes: '2000' });
  eq([po.needsApproval, po.safeDefault], [true, true], 'a purchase order: the owner approves (D2-7)');
  ok(/No approval band is set/.test(po.reasons[0]), 'PO reason');
  await refuses(evaluate(db, { businessId: biz, subject: 'emergency_purchase', amountKes: '5' }), 400, 'location_required', /which branch/);
  await refuses(evaluate(db, { businessId: biz, subject: 'invoice', locationId: B1, amountKes: '5' }), 400, 'unknown_subject');
  await refuses(emergency(B1, undefined), 400, 'amount_required', /Enter the amount/);
  await refuses(emergency(B1, 'abc'), 400, 'bad_number');
  await refuses(emergency(B1, '-5'), 400, 'invalid_amount');
}

/* ======================================================================================================== */
// 2. Rules: validation and permissions
/* ======================================================================================================== */
{
  const bad = (fields, code, re) => refuses(tx((t) => setRule(t, ownerScope, fields)), 400, code, re);
  await bad({ subject: 'banana', perTransactionKes: 5 }, 'unknown_subject', /Choose what the limit is for/);
  await bad({ subject: 'emergency_purchase' }, 'limit_required', /Set at least one limit/);
  await bad({ subject: 'emergency_purchase', perTransactionKes: -1 }, 'invalid_limit', /limit per purchase must be an amount in KES/);
  await bad({ subject: 'emergency_purchase', perTransactionKes: 'lots' }, 'invalid_limit', /must be an amount in KES/);
  await bad({ subject: 'emergency_purchase', perTransactionKes: '10.123' }, 'invalid_limit', /up to 2 decimals/);
  await bad({ subject: 'emergency_purchase', perTransactionKes: 2e9 }, 'invalid_limit');
  await bad({ subject: 'emergency_purchase', perTransactionKes: 5000, perDayKes: 4000 }, 'limits_out_of_order', /daily limit \(KES 4,000\) can’t be lower than the limit per purchase \(KES 5,000\)/);
  await bad({ subject: 'emergency_purchase', perDayKes: 9000, perWeekKes: 8000 }, 'limits_out_of_order', /weekly limit \(KES 8,000\) can’t be lower than the daily limit \(KES 9,000\)/);
  await bad({ subject: 'emergency_purchase', perTransactionKes: 9000, perWeekKes: 8000 }, 'limits_out_of_order', /weekly limit/);
  await bad({ subject: 'wastage', perTransactionKes: 100, perDayKes: 500 }, 'limit_not_allowed', /Daily and weekly limits only apply to emergency purchases/);
  await bad({ subject: 'emergency_purchase', perTransactionKes: 100, variancePct: 5 }, 'limit_not_allowed', /Variance limits only apply to stock counts/);
  await bad({ subject: 'count', perTransactionKes: 100 }, 'limit_not_allowed', /variance percentage and\/or a variance value/);
  await bad({ subject: 'count' }, 'limit_required', /variance percentage, a variance value, or both/);
  await bad({ subject: 'count', variancePct: 150 }, 'invalid_limit', /between 0 and 100/);
  await bad({ subject: 'emergency_purchase', locationId: uuid(), perTransactionKes: 5 }, 'bad_location', /isn’t part of this business/);
  await bad({ subject: 'emergency_purchase', locationId: W, perTransactionKes: 5 }, 'bad_location', /per branch, not for the warehouse/);
  await bad({ subject: 'emergency_purchase', categoryId: uuid(), perTransactionKes: 5 }, 'bad_category', /doesn’t exist/);
  await bad({ subject: 'emergency_purchase', locationId: 'nope', perTransactionKes: 5 }, 'bad_id');
  await bad({ subject: 'emergency_purchase', perTransactionKes: 5, active: 'yes' }, 'invalid_limit', /on or off/);
  // Someone else's location or category
  const stranger = await createUser(db, 'rules-stranger@example.test', { role: 'owner' });
  const other = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning id, business_id`, [stranger]);
  const otherLoc = (await one(`insert into public.stock_locations (business_id, kind, restaurant_id, name) values ($1, 'branch', $2, 'Elsewhere') returning id`, [other.business_id, other.id])).id;
  await bad({ subject: 'emergency_purchase', locationId: otherLoc, perTransactionKes: 5 }, 'bad_location');
  const otherCat = (await one(`insert into public.stock_categories (business_id, name) values ($1, 'Theirs') returning id`, [other.business_id])).id;
  await bad({ subject: 'wastage', categoryId: otherCat, perTransactionKes: 5 }, 'bad_category');
  await bad({ subject: 'count', categoryId: otherCat, variancePct: 5 }, 'category_not_allowed', /per category/);
  eq((await q('select count(*)::int as n from public.approval_rules')).at(0).n, 0, 'nothing invalid was stored');

  // Permissions: only people who may change settings.
  for (const who of ['manager', 'ops', 'waiter']) {
    await refuses(asTx(who, (t, s) => setRule(t, s, { subject: 'emergency_purchase', perTransactionKes: 5 })), 403, 'forbidden', undefined, `${who} cannot set a rule`);
    await refuses(listRules(db, await scopeOf(who)), 403, 'forbidden', undefined, `${who} cannot list rules`);
    await refuses(asTx(who, (t, s) => deleteRule(t, s, uuid())), 403, 'forbidden', undefined, `${who} cannot delete a rule`);
  }
  eq((await listRules(db, ownerScope)).rules, [], 'the owner lists no rules yet');
}

/* ======================================================================================================== */
// 3. Precedence: branch override > business default; category rules add to them; limits are inclusive
/* ======================================================================================================== */
const meat = (await one(`insert into public.stock_categories (business_id, name) values ($1, 'Meat') returning id`, [biz])).id;
const beefCat = (await one(`insert into public.stock_categories (business_id, name, parent_id) values ($1, 'Beef', $2) returning id`, [biz, meat])).id;
const veg = (await one(`insert into public.stock_categories (business_id, name) values ($1, 'Vegetables') returning id`, [biz])).id;
{
  const created = await rule({ subject: 'emergency_purchase', perTransactionKes: 5000, perDayKes: 8000, perWeekKes: 20000 });   // business default
  eq([created.created, created.rule.perTransactionKes, created.rule.locationId, created.rule.approverCapability], [true, '5000.00', null, 'inv.emergency.approve'], 'business default created');
  eq((await emergency(B2, 4000)).needsApproval, false, 'branch 2 uses the business default: KES 4,000 is within KES 5,000');
  eq((await emergency(B2, 5000)).needsApproval, false, 'the limit itself is allowed (inclusive)');
  const over = await emergency(B2, 6000);
  eq(over.needsApproval, true, 'over the default');
  eq(over.reasons, ['Over your KES 5,000 limit per purchase at Second branch (this one is KES 6,000).'], 'plain reason names the limit, the branch and the amount');
  eq([over.safeDefault, over.rule.perTransactionKes, over.approverCapability], [false, '5000.00', 'inv.emergency.approve'], 'not a safe-default decision: a rule applied');

  await rule({ subject: 'emergency_purchase', locationId: B1, perTransactionKes: 2000 });   // branch 1 override: ONLY a per-purchase limit
  const b1 = await emergency(B1, 3000);
  eq([b1.needsApproval, b1.rule.locationId], [true, B1], 'the branch override wins over the business default');
  ok(/KES 2,000 limit per purchase at Main branch/.test(b1.reasons[0]), 'and says so');
  eq((await emergency(B1, 1500)).needsApproval, false, 'within the override');
  eq((await emergency(B1, 4000)).needsApproval, true, 'the default KES 5,000 does not rescue a branch with its own KES 2,000');
  eq((await emergency(B2, 4000)).needsApproval, false, 'other branches still use the default');
  // Row-level override: the branch row has no weekly limit, so the business weekly limit does not apply there.
  await ep(B1, 19000, '2026-11-17T10:00:00+03:00');
  eq((await emergency(B1, 1500, { at: new Date('2026-11-18T10:00:00+03:00') })).needsApproval, false, 'a branch override replaces the whole default row (no weekly limit there)');

  // A branch whose override is deactivated falls back to the default.
  await clearEps();
  await rule({ subject: 'emergency_purchase', locationId: B1, perTransactionKes: 2000, active: false });
  eq((await emergency(B1, 4000)).needsApproval, false, 'an inactive rule is ignored (default applies)');
  await rule({ subject: 'emergency_purchase', locationId: B1, perTransactionKes: 2000, active: true });
  await clearEps();

  // Category rules add to the general rule.
  await rule({ subject: 'emergency_purchase', categoryId: meat, perTransactionKes: 1000 });   // business default for Meat
  const lines = (...pairs) => pairs.map(([categoryId, amountKes]) => ({ categoryId, amountKes }));
  let e = await emergency(B2, 3000, { lines: lines([meat, 1500], [null, 1500]) });
  eq(e.needsApproval, true, 'meat over its own limit even though the whole purchase is within the general limit');
  eq(e.reasons, ['Over your KES 1,000 limit per purchase for Meat at Second branch (this one is KES 1,500).'], 'the reason names the category');
  eq((await emergency(B2, 3000, { lines: lines([meat, 800], [null, 2200]) })).needsApproval, false, 'meat within its limit, rest within the general one');
  e = await emergency(B2, 1500, { lines: lines([beefCat, 1500]) });
  eq([e.needsApproval, e.rules.map((x) => x.categoryId).filter(Boolean)], [true, [meat]], 'a sub-category (Beef) is covered by its parent’s (Meat) rule');
  eq((await emergency(B2, 6000, { lines: lines([veg, 6000]) })).needsApproval, true, 'a category with no rule falls to the general rule (over 5,000)');
  eq((await emergency(B2, 4000, { lines: lines([veg, 4000]) })).needsApproval, false, 'and passes within it');
  eq((await emergency(B2, 1500, { categoryIds: [meat] })).needsApproval, true, 'categoryIds without amounts: the whole amount counts against each category');
  // A branch rule for Meat replaces the business Meat rule at that branch.
  await rule({ subject: 'emergency_purchase', categoryId: meat, locationId: B2, perTransactionKes: 4000 });
  eq((await emergency(B2, 3000, { lines: lines([meat, 3000]) })).needsApproval, false, 'branch Meat rule (4,000) beats the business Meat rule (1,000)');
  eq((await emergency(B2, 4500, { lines: lines([meat, 4500]) })).needsApproval, true, '…and is enforced');
  await tx((t) => deleteRule(t, ownerScope, (created.rule.id)));   // drop the general business default
  // Category-only rules with no general rule: uncovered money falls to the safe default.
  e = await emergency(B2, 1000, { lines: lines([veg, 1000]) });
  eq([e.needsApproval, e.safeDefault], [true, true], 'no general rule and a line no category rule covers: the owner is asked (safe default)');
  ok(/isn’t covered by a limit/.test(e.reasons.at(-1)), 'says why');
  eq((await emergency(B2, 3000, { lines: lines([meat, 3000]) })).needsApproval, false, 'fully covered by a category rule within its limit: auto');
  // wastage with only a category rule: the rest is wastage's safe default (no approval)
  await rule({ subject: 'wastage', categoryId: meat, perTransactionKes: 500 });
  eq((await evaluate(db, { businessId: biz, subject: 'wastage', locationId: B1, amountKes: 900, lines: lines([meat, 900]) })).needsApproval, true, 'wastage of meat over its limit needs approval');
  eq((await evaluate(db, { businessId: biz, subject: 'wastage', locationId: B1, amountKes: 9000, lines: lines([veg, 9000]) })).needsApproval, false, 'wastage of vegetables: no rule, no approval');
  await q('select 1');
  for (const x of (await listRules(db, ownerScope)).rules) await tx((t) => deleteRule(t, ownerScope, x.id));
  eq((await listRules(db, ownerScope)).rules, [], 'cleared all rules');
}

/* ======================================================================================================== */
// 4. Wastage, adjustment, count and PO thresholds once the owner sets them
/* ======================================================================================================== */
{
  await rule({ subject: 'wastage', perTransactionKes: 1000 });
  eq((await evaluate(db, { businessId: biz, subject: 'wastage', locationId: B1, amountKes: 1000 })).needsApproval, false, 'wastage at the limit: recorded');
  const w = await evaluate(db, { businessId: biz, subject: 'wastage', locationId: B1, amountKes: 1001 });
  eq([w.needsApproval, w.approverCapability], [true, 'inv.adjust.approve'], 'wastage over the owner’s limit needs approval');
  ok(/KES 1,000 limit per wastage record/.test(w.reasons[0]), 'wastage reason');
  await rule({ subject: 'adjustment', perTransactionKes: 300 });
  eq((await evaluate(db, { businessId: biz, subject: 'adjustment', locationId: B1, amountKes: 250 })).needsApproval, false, 'once a threshold is set, small adjustments need no approval');
  eq((await evaluate(db, { businessId: biz, subject: 'adjustment', locationId: B1, amountKes: 301 })).needsApproval, true, 'bigger ones do');
  await rule({ subject: 'count', variancePct: 2, varianceKes: 1500 });
  const within = await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, variancePct: 1.5, varianceKes: 900 });
  eq([within.needsApproval, within.safeDefault], [false, false], 'a count within both limits posts');
  const pct = await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, variancePct: 3, varianceKes: 100 });
  eq([pct.needsApproval, pct.reasons], [true, ['The count is off by 3% (limit 2%) at Main branch.']], 'over the percentage');
  eq((await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, variancePct: 1, varianceKes: 1600 })).reasons, ['The count is off by KES 1,600 (limit 1,500) at Main branch.'], 'over the value');
  eq((await evaluate(db, { businessId: biz, subject: 'count', locationId: B1, hasVariance: true })).needsApproval, false, 'with limits set, a bare "has variance" is judged by the numbers');
  await rule({ subject: 'purchase_order', perTransactionKes: 50000 });
  const po = await evaluate(db, { businessId: biz, subject: 'purchase_order', locationId: W, amountKes: 80000 });
  eq([po.needsApproval, po.safeDefault, po.approverCapability], [true, false, 'inv.purchase.approve'], 'a PO over the band: approval');
  ok(/Over your KES 50,000 limit per purchase order/.test(po.reasons[0]), 'PO reason');
  const small = await evaluate(db, { businessId: biz, subject: 'purchase_order', locationId: W, amountKes: 1000 });
  eq([small.needsApproval, small.safeDefault], [true, false], 'a PO under the band still goes to the owner (D2-7) but is not a safe-default case');
  for (const x of (await listRules(db, ownerScope)).rules) await tx((t) => deleteRule(t, ownerScope, x.id));
}

/* ======================================================================================================== */
// 5. Running day / week totals in Africa/Nairobi
/* ======================================================================================================== */
{
  await rule({ subject: 'emergency_purchase', locationId: B2, perTransactionKes: 5000, perDayKes: 8000 });
  // Wednesday 18 Nov 2026. A KES 6,000 purchase authorised at 23:30 Nairobi (20:30 UTC).
  await ep(B2, 6000, '2026-11-18T23:30:00+03:00');
  const before = await emergency(B2, 3000, { at: new Date('2026-11-18T23:59:00+03:00') });
  eq(before.needsApproval, true, 'same Nairobi day: 6,000 + 3,000 = 9,000 is over the daily 8,000');
  eq(before.reasons, ['Today’s total would be KES 9,000 (limit 8,000) at Second branch.'], 'reason in plain words');
  eq(before.usage.day, { used: '6000.00', limit: '8000.00', after: '9000.00' }, 'usage is reported');
  const after = await emergency(B2, 3000, { at: new Date('2026-11-19T00:01:00+03:00') });
  eq(after.needsApproval, false, 'two minutes later it is a new Nairobi day: the total starts again');
  eq(after.usage.day.used, '0.00', 'nothing used in the new day');
  // The UTC date is still the 18th at 00:30 Nairobi on the 19th (21:30 UTC): the day boundary is Nairobi's, not UTC's.
  eq((await emergency(B2, 3000, { at: new Date('2026-11-18T21:30:00Z') })).needsApproval, false, '21:30 UTC on the 18th is already 00:30 on the 19th in Nairobi');
  eq((await emergency(B2, 3000, { at: new Date('2026-11-18T20:59:00Z') })).needsApproval, true, '20:59 UTC on the 18th is still 23:59 Nairobi on the 18th');
  eq((await emergency(B2, 2000, { at: new Date('2026-11-18T20:59:00Z') })).needsApproval, false, 'exactly 8,000 is within the limit');
  eq((await emergency(B2, 3000, { at: new Date('2026-11-18T08:00:00+03:00') })).needsApproval, true, 'a purchase authorised later in the same day counts for an earlier "now" too (window, not "up to now")');
  await clearEps();

  // Weekly: branch with ONLY a weekly limit. Week = Monday 16 to Sunday 22 Nov 2026.
  const third = await helpers.addBranch('Third branch');
  const T = third.locationId;
  await rule({ subject: 'emergency_purchase', locationId: T, perWeekKes: 20000 });
  await ep(T, 5000, '2026-11-15T23:59:00+03:00');   // Sunday of the PREVIOUS week: not counted
  await ep(T, 5000, '2026-11-16T00:00:00+03:00');   // Monday 00:00: counted
  await ep(T, 5000, '2026-11-17T12:00:00+03:00');
  await ep(T, 4000, '2026-11-18T09:00:00+03:00');
  const thu = new Date('2026-11-19T10:00:00+03:00');
  eq((await emergency(T, 5000, { at: thu })).needsApproval, false, '14,000 so far + 5,000 = 19,000 within 20,000 (last Sunday not counted)');
  eq((await emergency(T, 6000, { at: thu })).needsApproval, false, '20,000 exactly is allowed');
  const wk = await emergency(T, 7000, { at: thu });
  eq([wk.needsApproval, wk.reasons], [true, ['Weekly total would be KES 21,000 (limit 20,000) at Third branch.']], 'small buys add up: the next one routes to approval');
  eq(wk.usage.week, { used: '14000.00', limit: '20000.00', after: '21000.00' }, 'weekly usage');
  eq((await emergency(T, 7000, { at: new Date('2026-11-22T23:59:00+03:00') })).needsApproval, true, 'Sunday night still the same week');
  eq((await emergency(T, 7000, { at: new Date('2026-11-23T00:00:00+03:00') })).needsApproval, false, 'Monday 00:00 Nairobi: a fresh week');
  // What counts: only authorised-and-later purchases at this branch.
  await ep(T, 9000, '2026-11-18T10:00:00+03:00', { status: 'pending' });
  await ep(T, 9000, '2026-11-18T10:00:00+03:00', { status: 'rejected' });
  await ep(T, 9000, '2026-11-18T10:00:00+03:00', { status: 'cancelled' });
  await ep(T, 9000, '2026-11-18T10:00:00+03:00', { status: 'draft' });
  await ep(B1, 9000, '2026-11-18T10:00:00+03:00');
  eq((await emergency(T, 6000, { at: thu })).needsApproval, false, 'pending, rejected, cancelled and draft purchases and other branches do not count');
  const own = await ep(T, 3000, '2026-11-18T11:00:00+03:00');
  eq((await emergency(T, 6000, { at: thu })).needsApproval, true, 'an authorised one does (17,000 + 6,000)');
  eq((await emergency(T, 6000, { at: thu, excludeSubjectId: own })).needsApproval, false, 'excludeSubjectId leaves the purchase being re-checked out');
  // Actual spend replaces the estimate once known.
  await db.query(`update public.emergency_purchases set status = 'purchased', payment_method = 'cash', actual_total = 8000, purchased_at = now() where id = $1`, [own]);
  eq((await emergency(T, 1000, { at: thu })).usage.week.used, '22000.00', 'the real amount paid is what counts once it is known (5+5+4+8 thousand)');
  // The lock is taken (and released with the transaction) without error.
  await tx(async (t) => { await evaluate(t, { businessId: biz, subject: 'emergency_purchase', locationId: T, amountKes: 100, at: thu }); await evaluate(t, { businessId: biz, subject: 'emergency_purchase', locationId: T, amountKes: 100, at: thu }); });
  await clearEps();

  // Category totals count the lines of that category (and its sub-categories).
  const beef = await makeItem(db, biz, 'Beef');
  await db.query('update public.stock_items set category_id = $2 where id = $1', [beef, beefCat]);
  const cabbage = await makeItem(db, biz, 'Cabbage');
  await db.query('update public.stock_items set category_id = $2 where id = $1', [cabbage, veg]);
  await rule({ subject: 'emergency_purchase', categoryId: meat, locationId: T, perDayKes: 3000 });
  await ep(T, 2800, '2026-11-18T09:00:00+03:00', { lines: [{ itemId: beef, amount: 2500 }, { itemId: cabbage, amount: 300 }] });
  const nov18 = new Date('2026-11-18T12:00:00+03:00');
  const cat = await emergency(T, 1000, { at: nov18, lines: [{ categoryId: meat, amountKes: 1000 }] });
  eq([cat.needsApproval, cat.reasons[0]], [true, 'Today’s total for Meat would be KES 3,500 (limit 3,000) at Third branch.'], 'meat bought today (2,500, in Beef) plus this 1,000 is over the Meat daily limit');
  eq((await emergency(T, 400, { at: nov18, lines: [{ categoryId: meat, amountKes: 400 }] })).needsApproval, false, '2,500 + 400 is within 3,000');
  eq((await emergency(T, 1000, { at: nov18, lines: [{ categoryId: veg, amountKes: 1000 }] })).needsApproval, false, 'vegetables have no category rule: only the branch’s general weekly limit applies, and 2,800 + 1,000 is within 20,000');
  await clearEps();
  for (const x of (await listRules(db, ownerScope)).rules) await tx((t) => deleteRule(t, ownerScope, x.id));
}

/* ======================================================================================================== */
// 6. T-EMP-4: the owner changes a limit and the next evaluation follows at once; every change is audited
/* ======================================================================================================== */
{
  const baseline = (await one('select coalesce(max(id), 0) as id from public.inventory_events')).id;
  eq((await emergency(B1, 2500)).needsApproval, true, 'before any limit: needs approval (safe default)');
  await rule({ subject: 'emergency_purchase', locationId: B1, perWeekKes: 10000, perTransactionKes: 3000 });
  eq((await emergency(B1, 2500)).needsApproval, false, 'limit set: KES 2,500 is now auto');
  const upd = await rule({ subject: 'emergency_purchase', locationId: B1, perTransactionKes: 2000, perWeekKes: 10000 });
  eq([upd.created, upd.rule.perTransactionKes], [false, '2000.00'], 'the same scope is updated in place');
  eq((await emergency(B1, 2500)).needsApproval, true, 'limit lowered: the very next evaluation routes KES 2,500 to approval');
  await rule({ subject: 'emergency_purchase', locationId: B1, perTransactionKes: 5000, perWeekKes: 10000 });
  eq((await emergency(B1, 2500)).needsApproval, false, 'raised again: auto again');
  eq((await q(`select count(*)::int as n from public.approval_rules where subject = 'emergency_purchase'`))[0].n, 1, 'still one rule for the branch');
  const ruleId = (await listRules(db, ownerScope, { subject: 'emergency_purchase' })).rules[0].id;
  await tx((t) => deleteRule(t, ownerScope, ruleId));
  eq((await emergency(B1, 2500)).needsApproval, true, 'rule removed: back to the safe default');
  await refuses(tx((t) => deleteRule(t, ownerScope, ruleId)), 404, 'rule_not_found');
  await refuses(tx((t) => deleteRule(t, ownerScope, 'nope')), 400, 'bad_id');
  const events = await q(`select action, before, after, actor_id from public.inventory_events where entity = 'approval_rule' and id > $1 order by id`, [baseline]);
  const actions = events.map((e) => e.action);
  ok(actions.includes('create') && actions.filter((a) => a === 'update').length === 2 && actions.at(-1) === 'delete', 'create, update, update, delete are all audited');
  const lowered = events.find((e) => e.action === 'update');
  eq([lowered.before.perTransactionKes, lowered.after.perTransactionKes, lowered.actor_id], ['3000.00', '2000.00', people.owner], 'the audit event keeps before and after and who changed it');
  const lim = await limits(db, { businessId: biz, locationId: B1 });
  eq([lim.hasLimit, lim.message], [false, 'No limit set for Main branch. The owner will be asked.'], 'limits(): the branch form says "No limit set"');
  await rule({ subject: 'emergency_purchase', locationId: B1, perTransactionKes: 3000, perDayKes: 6000, perWeekKes: 10000 });
  await ep(B1, 2500, '2026-11-18T09:00:00+03:00');
  const lim2 = await limits(db, { businessId: biz, locationId: B1, at: new Date('2026-11-18T12:00:00+03:00') });
  eq([lim2.hasLimit, lim2.leftTodayKes, lim2.leftWeekKes, lim2.message], [true, '3500.00', '7500.00', 'Within your limit: KES 3,000 per purchase, KES 3,500 left today, KES 7,500 left this week.'], 'limits(): what is left today and this week');
  await clearEps();
  for (const x of (await listRules(db, ownerScope)).rules) await tx((t) => deleteRule(t, ownerScope, x.id));
}

/* ======================================================================================================== */
// 7. Approvals: request, notify once, decide, maker-checker, self-approval, callbacks
/* ======================================================================================================== */
const notes = (userId, kind) => q(`select id, title, body, dedupe_key from public.notifications where recipient_id = $1 and kind = $2 order by created_at`, [userId, kind]);
const ask = (subject, subjectId, extra = {}) => tx((t) => request(t, { businessId: biz, subject, subjectId, locationId: B1, requestedBy: people.manager, amountKes: 4000,
  evaluation: { rule: null, rules: [], reasons: ['Over your KES 3,000 limit per purchase at Main branch (this one is KES 4,000).'], safeDefault: false, approverCapability: 'inv.emergency.approve' }, ...extra }));
{
  const subjectId = uuid();
  const first = await ask('emergency_purchase', subjectId);
  eq([first.created, first.status, first.amountKes, first.locationName, first.requestedByName === null || typeof first.requestedByName === 'string'], [true, 'pending', '4000.00', 'Main branch', true], 'request creates a pending approval');
  eq(first.reasons.length, 1, 'the reasons are kept with the request');
  eq((await notes(people.owner, 'approval_needed')).length, 1, 'the owner is notified');
  eq((await notes(people.owner2, 'approval_needed')).length, 1, 'every owner is notified');
  eq((await notes(people.manager, 'approval_needed')).length, 0, 'the requester is not');
  eq((await notes(people.ops, 'approval_needed')).length, 0, 'an operations manager is not (emergency approvals are the owner’s)');
  const again = await ask('emergency_purchase', subjectId);
  eq([again.created, again.id], [false, first.id], 'asking again for the same subject returns the pending request');
  eq((await notes(people.owner, 'approval_needed')).length, 1, 'and nobody is notified a second time');
  eq((await q(`select count(*)::int as n from public.approvals where subject_id = $1`, [subjectId]))[0].n, 1, 'one row');

  // Permissions to decide
  const mgr = await scopeOf('manager');
  await refuses(tx((t) => decide(t, mgr, first.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'a branch manager cannot decide (even their own request)');
  const opsScope = await scopeOf('ops');
  await refuses(tx((t) => decide(t, opsScope, first.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'operations manager: no approving capability at all for emergency purchases');
  await refuses(tx((t) => decide(t, ownerScope, first.id, { decision: 'maybe' })), 400, 'bad_decision');
  await refuses(tx((t) => decide(t, ownerScope, first.id, { decision: 'reject' })), 400, 'reason_required', /Say why/);
  await refuses(tx((t) => decide(t, ownerScope, first.id, { decision: 'approve', note: 'x'.repeat(501) })), 400, 'note_too_long');
  await refuses(tx((t) => decide(t, ownerScope, uuid(), { decision: 'approve' })), 404, 'approval_not_found');
  await refuses(tx((t) => decide(t, ownerScope, 'junk', { decision: 'approve' })), 400, 'bad_id');
  eq((await one('select status from public.approvals where id = $1', [first.id])).status, 'pending', 'none of those changed it');

  // Callbacks
  const seen = [];
  const off = onDecided('emergency_purchase', async (t, approval, { scope }) => { seen.push([approval.status, approval.subjectId, scope.userId]); });
  const everything = [];
  onDecided('*', async (_t, approval) => { everything.push(approval.id); });
  const decided = await tx((t) => decide(t, owner2Scope, first.id, { decision: 'approve', note: 'Go ahead' }));
  eq([decided.status, decided.selfApproved, decided.replayed, decided.decisionNote, decided.decidedBy], ['approved', false, false, 'Go ahead', people.owner2], 'another owner approves');
  eq(seen, [['approved', subjectId, people.owner2]], 'onDecided fired once with the approval and the scope');
  eq(everything, [first.id], 'the wildcard callback fired too');
  const replay = await tx((t) => decide(t, owner2Scope, first.id, { decision: 'approve' }));
  eq([replay.replayed, replay.status, replay.decidedBy], [true, 'approved', people.owner2], 'deciding again returns the stored result');
  const replayByOther = await tx((t) => decide(t, ownerScope, first.id, { decision: 'approve' }));
  eq(replayByOther.replayed, true, 'also for another approver (nothing changes)');
  eq(seen.length, 1, 'the callback did not fire again (idempotent)');
  await refuses(tx((t) => decide(t, ownerScope, first.id, { decision: 'reject', note: 'changed my mind' })), 409, 'already_decided', /already approved by/);
  eq((await notes(people.manager, 'approval_decided')).length, 1, 'the requester is told once');
  eq((await notes(people.manager, 'approval_decided'))[0].title, 'Emergency purchase approved', 'in plain words');
  off();
  const ev = await q(`select action, actor_id, after from public.inventory_events where entity = 'approval' and entity_id = $1 order by id`, [first.id]);
  eq(ev.map((e) => e.action), ['request', 'approve'], 'request and decision are audited');

  // A throwing callback rolls the decision back.
  const s2 = uuid();
  const a2 = await ask('emergency_purchase', s2);
  onDecided('emergency_purchase', async () => { throw new HttpError(409, 'The purchase was already cancelled.', { code: 'subject_changed' }); });
  await refuses(tx((t) => decide(t, owner2Scope, a2.id, { decision: 'approve' })), 409, 'subject_changed');
  eq((await one('select status from public.approvals where id = $1', [a2.id])).status, 'pending', 'a failing callback leaves the approval pending');
  clearDecisionHandlers();
  const rej = await tx((t) => decide(t, owner2Scope, a2.id, { decision: 'reject', note: 'Use the warehouse stock first' }));
  eq([rej.status, rej.decisionNote, rej.selfApproved], ['rejected', 'Use the warehouse stock first', false], 'reject with a reason');
  eq((await notes(people.manager, 'approval_decided')).length, 2, 'the manager hears about the rejection too');
  eq((await notes(people.manager, 'approval_decided'))[1].title, 'Emergency purchase rejected', 'rejection title');
  const retry = await ask('emergency_purchase', s2);
  eq(retry.created, true, 'after a rejection the subject can be asked again');
}

{
  // ---- Maker-checker (T-SEC-2): the requester can't approve their own request while another approver exists ----
  const cnt = async (who, kind) => (await notes(people[who], kind)).length;
  const [ownerBefore, owner2Before] = [await cnt('owner', 'approval_needed'), await cnt('owner2', 'approval_needed')];
  const poId = uuid();
  const ownReq = await tx(async (t) => request(t, { businessId: biz, subject: 'purchase_order', subjectId: poId, locationId: W, requestedBy: people.owner, amountKes: 90000,
    evaluation: await evaluate(t, { businessId: biz, subject: 'purchase_order', locationId: W, amountKes: 90000 }) }));
  eq(await cnt('owner', 'approval_needed'), ownerBefore, 'the owner who asked is not notified of their own request');
  eq(await cnt('owner2', 'approval_needed'), owner2Before + 1, 'the other owner is');
  eq(await approverAvailable(db, biz, people.owner, 'inv.purchase.approve', W), true, 'another approver exists');
  await refuses(tx((t) => decide(t, ownerScope, ownReq.id, { decision: 'approve' })), 403, 'maker_checker', /You can’t approve something you created/);
  eq(await one('select status, self_approved from public.approvals where id = $1', [ownReq.id]), { status: 'pending', self_approved: false }, 'still pending');
  await refuses(tx((t) => decide(t, ownerScope, ownReq.id, { decision: 'reject', note: 'nope' })), 403, 'use_cancel', /Withdraw the request/);
  const mineRow = (await inbox(db, ownerScope)).approvals.find((a) => a.id === ownReq.id);
  eq([mineRow.canDecide, mineRow.selfApproval, mineRow.blocked], [false, false, 'You asked for this, so another approver has to decide it.'], 'in the requester’s inbox it is shown as not theirs to decide');
  eq((await inbox(db, owner2Scope)).approvals.find((a) => a.id === ownReq.id).canDecide, true, 'the other owner can decide it');
  const ok2 = await tx((t) => decide(t, owner2Scope, ownReq.id, { decision: 'approve' }));
  eq([ok2.status, ok2.selfApproved], ['approved', false], 'the other owner approves: not flagged');
  eq(await cnt('owner', 'approval_decided'), 1, 'the requester hears the result');

  // ---- Sole owner (D2-5): nobody else can approve -> allowed, flagged, audited ----
  await db.query(`update public.business_members set role = 'operations' where user_id = $1`, [people.owner2]);   // owner2 steps down (operations, no branches, no approving rights)
  eq(await approverAvailable(db, biz, people.owner, 'inv.purchase.approve', W), false, 'no other approver once owner2 is no longer an owner');
  const soloBefore = await cnt('owner', 'approval_needed');
  const solo = await tx(async (t) => request(t, { businessId: biz, subject: 'purchase_order', subjectId: uuid(), locationId: W, requestedBy: people.owner, amountKes: 12000,
    evaluation: await evaluate(t, { businessId: biz, subject: 'purchase_order', locationId: W, amountKes: 12000 }) }));
  eq(await cnt('owner', 'approval_needed'), soloBefore, 'nobody else to notify (and not the requester): no new notification');
  const soloView = (await inbox(db, ownerScope)).approvals.find((a) => a.id === solo.id);
  eq([soloView.canDecide, soloView.selfApproval], [true, true], 'the inbox marks the sole-approver case');
  const own = await tx((t) => decide(t, ownerScope, solo.id, { decision: 'approve', note: 'Only owner' }));
  eq([own.status, own.selfApproved, own.decidedBy], ['approved', true, people.owner], 'a sole owner may approve their own purchase order: flagged self_approved');
  eq(await one('select status, self_approved, decided_by = requested_by as same from public.approvals where id = $1', [solo.id]), { status: 'approved', self_approved: true, same: true }, 'stored flagged');
  const evs = await q(`select action from public.inventory_events where entity = 'approval' and entity_id = $1 order by id`, [solo.id]);
  eq(evs.map((e) => e.action), ['request', 'self_approved'], 'a self_approved audit event is written');
  eq((await inbox(db, ownerScope, { status: 'decided' })).approvals.find((a) => a.id === solo.id).selfApproved, true, 'history shows the self-approved chip');
  eq(await cnt('owner', 'approval_decided'), 1, 'no "decided" notification to yourself');
  // …and an operations manager with operations_can_approve counts as a second approver for adjustments at their branch.
  const adj = await tx(async (t) => request(t, { businessId: biz, subject: 'adjustment', subjectId: uuid(), locationId: B1, requestedBy: people.owner, amountKes: 800,
    evaluation: await evaluate(t, { businessId: biz, subject: 'adjustment', locationId: B1, amountKes: 800 }) }));
  eq(await approverAvailable(db, biz, people.owner, 'inv.adjust.approve', B1), false, 'ops without the setting is no approver');
  await setSetting(db, { businessId: biz, key: 'operations_can_approve', value: true, actorId: people.owner });
  eq(await approverAvailable(db, biz, people.owner, 'inv.adjust.approve', B1), true, 'ops with operations_can_approve is');
  eq(await approverAvailable(db, biz, people.owner, 'inv.adjust.approve', B2), false, 'but only at their own branch');
  await refuses(tx((t) => decide(t, ownerScope, adj.id, { decision: 'approve' })), 403, 'maker_checker', undefined, 'with an approving operations manager around, the sole owner can not self-approve any more');
  const opsScope = await scopeOf('ops');
  const byOps = await tx((t) => decide(t, opsScope, adj.id, { decision: 'approve' }));
  eq([byOps.status, byOps.selfApproved, byOps.decidedBy], ['approved', false, people.ops], 'the operations manager approves an adjustment');
  const adjB2 = await tx(async (t) => request(t, { businessId: biz, subject: 'adjustment', subjectId: uuid(), locationId: B2, requestedBy: people.owner, amountKes: 800 }));
  await refuses(tx((t) => decide(t, opsScope, adjB2.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'operations manager cannot decide at a branch they do not oversee');
  const poOps = await tx(async (t) => request(t, { businessId: biz, subject: 'purchase_order', subjectId: uuid(), locationId: W, requestedBy: people.owner, amountKes: 800 }));
  await refuses(tx((t) => decide(t, opsScope, poOps.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'and cannot approve purchase orders (operations managers hold no inv.purchase.approve)');
  await setSetting(db, { businessId: biz, key: 'operations_can_approve', value: false, actorId: people.owner });
  const adj2 = await tx(async (t) => request(t, { businessId: biz, subject: 'adjustment', subjectId: uuid(), locationId: B1, requestedBy: people.owner, amountKes: 5 }));
  await refuses(asTx('ops', (t, s) => decide(t, s, adj2.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'switch the setting off and the operations manager can no longer decide');
  const selfAgain = await tx((t) => decide(t, ownerScope, adj2.id, { decision: 'approve' }));
  eq(selfAgain.selfApproved, true, 'and the sole owner is back to self-approving');
  // restore owner2
  await db.query(`update public.business_members set role = 'owner' where user_id = $1`, [people.owner2]);
  eq(await approverAvailable(db, biz, people.owner, 'inv.purchase.approve', W), true, 'adding a second owner switches the rule back');
  const adj3 = await tx(async (t) => request(t, { businessId: biz, subject: 'adjustment', subjectId: uuid(), locationId: B1, requestedBy: people.owner, amountKes: 5 }));
  await refuses(tx((t) => decide(t, ownerScope, adj3.id, { decision: 'approve' })), 403, 'maker_checker');
  eq(new Set(await approverIds(db, biz, 'inv.purchase.approve', W)), new Set([people.owner, people.owner2]), 'approverIds lists the owners');

  // ---- A branch manager can never self-approve, even when they are the only person around ----
  const mgrReq = await ask('emergency_purchase', uuid());
  await refuses(asTx('manager', (t, s) => decide(t, s, mgrReq.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'a branch manager cannot approve their own emergency purchase');
  const mgr2Req = await tx((t) => request(t, { businessId: biz, subject: 'emergency_purchase', subjectId: uuid(), locationId: B2, requestedBy: people.manager2, amountKes: 100 }));
  await refuses(asTx('manager2', (t, s) => decide(t, s, mgr2Req.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'nor can the other branch’s manager');
  await refuses(asTx('manager', (t, s) => decide(t, s, mgr2Req.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'a manager cannot approve another branch’s purchase either');
  await refuses(asTx('waiter', (t, s) => decide(t, s, mgr2Req.id, { decision: 'approve' })), 403, 'forbidden', undefined, 'a waiter cannot');
}

/* ======================================================================================================== */
// 8. Inbox, my requests, history, cancel
/* ======================================================================================================== */
{
  const inb = await inbox(db, ownerScope);
  ok(inb.approvals.length >= 3 && inb.approvals.every((a) => a.status === 'pending'), 'the owner inbox lists pending approvals');
  eq(inb.pending, inb.approvals.length, 'with a count');
  const times = inb.approvals.map((a) => new Date(a.requestedAt).getTime());
  eq(times, [...times].sort((a, b) => b - a), 'newest first');
  eq((await inbox(db, await scopeOf('manager'))).approvals, [], 'a branch manager’s inbox is empty: they decide nothing');
  eq((await inbox(db, await scopeOf('waiter'))).approvals, [], 'and a waiter’s');
  eq((await inbox(db, await scopeOf('ops'))).approvals, [], 'ops without the setting has nothing to decide');
  eq((await inbox(db, ownerScope, { subject: 'adjustment' })).approvals.every((a) => a.subject === 'adjustment'), true, 'filter by subject');
  const decided = await inbox(db, ownerScope, { status: 'decided' });
  ok(decided.approvals.length >= 4 && decided.approvals.every((a) => ['approved', 'rejected'].includes(a.status)), 'history of decided approvals');
  eq(decided.approvals.some((a) => a.selfApproved), true, 'including the self-approved ones');
  await refuses(inbox(db, ownerScope, { status: 'weird' }), 400, 'bad_status');
  await refuses(inbox(db, ownerScope, { subject: 'weird' }), 400, 'unknown_subject');
  await setSetting(db, { businessId: biz, key: 'operations_can_approve', value: true, actorId: people.owner });
  const opsInbox = (await inbox(db, await scopeOf('ops'))).approvals;
  ok(opsInbox.length > 0 && opsInbox.every((a) => a.approverCapability === 'inv.adjust.approve' && a.locationId === B1), 'an approving operations manager sees only adjustment approvals at their branch');
  await setSetting(db, { businessId: biz, key: 'operations_can_approve', value: false, actorId: people.owner });

  const mineList = (await mine(db, await scopeOf('manager'))).approvals;
  ok(mineList.length >= 3 && mineList.every((a) => a.requestedBy === people.manager), 'a branch manager sees their own requests');
  eq(mineList.some((a) => a.status === 'rejected' && a.decisionNote === 'Use the warehouse stock first'), true, 'with the answer and the reason');
  eq((await mine(db, await scopeOf('manager'), { status: 'pending', subject: 'emergency_purchase', locationId: B2 })).approvals, [], 'filters, including the branch');
  eq((await mine(db, await scopeOf('manager2'))).approvals.length, 1, 'the other manager sees only theirs');

  // history of one subject
  const subjectId = uuid();
  const h1 = await ask('emergency_purchase', subjectId);
  await tx((t) => decide(t, ownerScope, h1.id, { decision: 'reject', note: 'Too much' }));
  const h2 = await ask('emergency_purchase', subjectId);
  await tx((t) => decide(t, ownerScope, h2.id, { decision: 'approve' }));
  eq((await history(db, ownerScope, { subject: 'emergency_purchase', subjectId })).approvals.map((a) => a.status), ['rejected', 'approved'], 'history: asked, rejected, asked again, approved');
  eq((await history(db, await scopeOf('manager'), { subject: 'emergency_purchase', subjectId })).approvals.length, 2, 'the requester sees the history of their own request');
  eq((await history(db, await scopeOf('manager2'), { subject: 'emergency_purchase', subjectId })).approvals, [], 'another branch’s manager does not');
  await refuses(history(db, ownerScope, { subject: 'emergency_purchase' }), 400, 'bad_request');

  // cancel: the subject was withdrawn
  const cId = uuid();
  const c1 = await ask('emergency_purchase', cId);
  const cancelled = await asTx('manager', (t, s) => cancel(t, s, { subject: 'emergency_purchase', subjectId: cId }, { note: 'Bought it elsewhere' }));
  eq([cancelled.status, cancelled.id, cancelled.decidedBy], ['cancelled', c1.id, null], 'cancel by subject withdraws the pending request');
  eq(await tx((t) => cancel(t, ownerScope, { subject: 'emergency_purchase', subjectId: cId })), null, 'nothing pending: null');
  await refuses(tx((t) => decide(t, ownerScope, c1.id, { decision: 'approve' })), 409, 'already_decided', /withdrawn/);
  await refuses(tx((t) => cancel(t, ownerScope, c1.id)), 409, 'not_pending');
  eq((await inbox(db, ownerScope)).approvals.some((a) => a.id === c1.id), false, 'a withdrawn request leaves the inbox');
  eq((await ask('emergency_purchase', cId)).created, true, 'and can be asked again');
  const byId = await ask('emergency_purchase', uuid());
  eq((await tx((t) => cancel(t, ownerScope, byId.id))).status, 'cancelled', 'cancel by approval id');
  await refuses(tx((t) => request(t, { businessId: biz, subject: 'banana', subjectId: uuid(), requestedBy: people.manager })), 400, 'unknown_subject');
}

/* ======================================================================================================== */
// 9. The API (real route handlers)
/* ======================================================================================================== */
{
  const stranger = await createUser(db, 'approvals-stranger@example.test', { role: 'owner' });
  const otherOwner = await createUser(db, 'approvals-other-owner@example.test', { role: 'owner' });
  const otherRestaurant = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning id, business_id`, [otherOwner]);
  await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.business_id, otherOwner]);
  await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.id, otherOwner]);
  await db.query('update public.businesses set inventory_enabled = true where id = $1', [otherRestaurant.business_id]);
  const all = { ...contexts, stranger: helpers.ctx(stranger),
    otherOwner: helpers.ctx(otherOwner, { memberships: [[otherRestaurant.id, 'owner']], grants: [{ businessId: otherRestaurant.business_id, role: 'owner', branchIds: null }] }) };
  const routes = createRoutes({
    authenticate: async (request) => {
      const who = request.headers.authorization?.replace(/^Bearer /, '');
      if (!all[who]) throw new HttpError(401, 'Please sign in to continue.');
      return all[who];
    },
    pool: () => db, transact: (fn) => db.transaction(fn),
  });
  const call = async (as, method, pathname, body, query = '', branch = null) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.path.exec(pathname);
      if (!m) continue;
      const headers = { authorization: `Bearer ${as}` };
      if (branch) headers['x-cravio-branch'] = branch;
      return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
    }
    throw new Error(`No route for ${method} ${pathname}`);
  };
  const base = `/api/owner/inventory/${biz}`;
  const denied = async (who) => (await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and actor_id = $1`, [who])).n;

  // Rules over HTTP
  await refuses(call('manager', 'PUT', `${base}/approval-rules`, { subject: 'emergency_purchase', perTransactionKes: 5 }), 403, 'forbidden');
  await refuses(call('ops', 'GET', `${base}/approval-rules`), 403, 'forbidden');
  await refuses(call('stranger', 'GET', `${base}/approval-rules`), 403, 'forbidden');
  await refuses(call('otherOwner', 'GET', `${base}/approval-rules`), 403, 'forbidden', undefined, 'another business’s owner gets nothing');
  eq(await denied(people.manager) >= 1, true, 'a refused attempt is audited as denied');
  const put = await call('owner', 'PUT', `${base}/approval-rules`, { subject: 'emergency_purchase', locationId: B1, perTransactionKes: 4000, perDayKes: 9000, commandId: uuid() });
  eq([put.created, put.rule.perDayKes, put.rule.locationName], [true, '9000.00', 'Main branch'], 'the owner sets a limit over the API');
  await refuses(call('owner', 'PUT', `${base}/approval-rules`, { subject: 'emergency_purchase', locationId: B1, perTransactionKes: 4000, perDayKes: 100 }), 400, 'limits_out_of_order', /daily limit/);
  const list = await call('owner', 'GET', `${base}/approval-rules`);
  eq(list.rules.map((x) => [x.subject, x.locationName]), [['emergency_purchase', 'Main branch']], 'listed');
  eq((await call('owner', 'GET', `${base}/approval-rules`, undefined, '?subject=wastage')).rules, [], 'filter by subject');
  eq((await emergency(B1, 4500)).needsApproval, true, 'the API-set limit is what evaluate uses');

  // Inbox + decide
  const subjectId = uuid();
  const pending = await ask('emergency_purchase', subjectId);
  const apiInbox = await call('owner', 'GET', `${base}/approvals`);
  ok(apiInbox.approvals.some((a) => a.id === pending.id), 'the inbox over HTTP');
  await refuses(call('manager', 'GET', `${base}/approvals`), 403, 'forbidden', undefined, 'a branch manager can not open the owner inbox');
  await refuses(call('waiter', 'GET', `${base}/approvals`), 403, 'forbidden');
  await refuses(call('stranger', 'GET', `${base}/approvals`), 403, 'forbidden');
  const detail = await call('owner', 'GET', `${base}/approvals/${pending.id}`);
  eq([detail.approval.id, detail.history.length], [pending.id, 1], 'one approval with its history');
  const before = await denied(people.manager);
  await refuses(call('manager', 'POST', `${base}/approvals/${pending.id}/decide`, { decision: 'approve' }), 403, 'forbidden');
  await refuses(call('ops', 'POST', `${base}/approvals/${pending.id}/decide`, { decision: 'approve' }), 403, 'forbidden', undefined, 'ops without the setting');
  eq(await denied(people.manager), before + 1, 'the refused decision is audited outside the rolled-back transaction');
  await refuses(call('owner', 'POST', `${base}/approvals/${pending.id}/decide`, { decision: 'reject' }), 400, 'reason_required');
  const cmd = uuid();
  const done = await call('owner', 'POST', `${base}/approvals/${pending.id}/decide`, { decision: 'approve', note: 'ok', commandId: cmd });
  eq([done.status, done.decidedBy], ['approved', people.owner], 'decided over HTTP');
  const done2 = await call('owner', 'POST', `${base}/approvals/${pending.id}/decide`, { decision: 'approve', note: 'ok', commandId: cmd });
  eq(done2.id, done.id, 'the same commandId replays the first answer');
  eq((await notes(people.manager, 'approval_decided')).filter((n) => n.dedupe_key === `approval_decided:${pending.id}`).length, 1, 'one notification');
  await refuses(call('owner2', 'POST', `${base}/approvals/${pending.id}/decide`, { decision: 'reject', note: 'late' }), 409, 'already_decided');
  await refuses(call('otherOwner', 'POST', `${base}/approvals/${pending.id}/decide`, { decision: 'approve' }), 403, 'forbidden', undefined, 'another business’s owner is refused');
  await refuses(call('owner', 'POST', `${base}/approvals/${uuid()}/decide`, { decision: 'approve' }), 404, 'approval_not_found');
  // own request over HTTP
  const own = await tx((t) => request(t, { businessId: biz, subject: 'purchase_order', subjectId: uuid(), locationId: W, requestedBy: people.owner, amountKes: 10 }));
  await refuses(call('owner', 'POST', `${base}/approvals/${own.id}/decide`, { decision: 'approve' }), 403, 'maker_checker');

  // Branch: my requests
  const mineApi = await call('manager', 'GET', '/api/inventory/approvals', undefined, '', ids.branchId);
  ok(mineApi.approvals.length >= 3 && mineApi.approvals.every((a) => a.requestedBy === people.manager && a.locationId === B1), 'the branch manager lists their own requests at this branch');
  await refuses(call('waiter', 'GET', '/api/inventory/approvals', undefined, '', ids.branchId), 403, 'forbidden');
  await refuses(call('manager2', 'GET', '/api/inventory/approvals', undefined, '', ids.branchId), 403, 'forbidden', undefined, 'another branch’s manager');
  await refuses(call('stranger', 'GET', '/api/inventory/approvals', undefined, '', ids.branchId), 403, 'forbidden');
  const del = await call('owner', 'DELETE', `${base}/approval-rules/${put.rule.id}`, {});
  eq(del.deleted, true, 'the owner removes the limit over the API');
  await refuses(call('manager', 'DELETE', `${base}/approval-rules/${put.rule.id}`, {}), 403, 'forbidden');
  eq((await emergency(B1, 100)).safeDefault, true, 'and the safe default is back');
}

console.log(`Approvals: ${count()} checks passed (disposable PGlite database).`);
await db.close();
