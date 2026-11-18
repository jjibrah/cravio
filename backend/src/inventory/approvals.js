// Approvals engine (P2-10 core, migration 017): the owner's rules decide WHEN something needs approval, `approvals` rows record the request and
// the decision, and maker-checker decides WHO may decide. The engine is generic: purchase orders, emergency purchases and the Phase 3
// subjects (wastage, adjustment, count) all use the same four calls. It never imports purchasing or emergency code; those modules call it and
// register a callback with onDecided(subject, fn) to react when an approval is decided.
//
//   evaluate(db, { businessId, subject, locationId, ... })      -> { needsApproval, rule, rules, reasons, safeDefault, usage, approverCapability }
//   request(db, { businessId, subject, subjectId, locationId, requestedBy, amountKes, evaluation })  -> approval (+ approvers notified once)
//   decide(db, scope, approvalId, { decision: 'approve'|'reject', note })                             -> approval (maker-checker, D2-5)
//   cancel(db, scope, approvalId | { subject, subjectId })                                            -> approval | null (the subject was withdrawn)
//   inbox(db, scope, { status, subject })  /  mine(db, scope, ...)  /  history(db, scope, { subject, subjectId })
//   listRules / setRule / deleteRule (owner only, audited)         limits(db, ...) for a branch form ("KES 3,200 left today")
//
// Rules (D2-6, D2-16): there are NO built-in amounts. Precedence, most specific first:
//   * a branch rule REPLACES the business default for that branch (whole row: a branch row with only a weekly limit means "no daily limit" there);
//   * a category rule is an EXTRA limit for the lines of that category (and its sub-categories); the general rule (no category) still applies to the whole;
//   * with nothing set the safe default of the subject applies:
//       emergency_purchase   every purchase needs approval        purchase_order   every PO needs approval (D2-7: the owner approves in one click)
//       adjustment           every manual adjustment needs it     wastage          recorded straight away, no approval
//       count                any non-zero variance needs one approval for the session (a clean count needs none)
// Money is exact (decimal.js); money in results is a string with 2 decimals ('5000.00'). Day and week are Africa/Nairobi calendar day and
// Monday-to-Sunday week; the running totals count emergency purchases at that branch authorised in the window (authorised_at), whether the
// system authorised them or the owner approved them, and exclude `excludeSubjectId` (the purchase being re-checked).
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { add, cmp, dec, isZero, MONEY, sub } from './decimal.js';
import { assertDifferentPeople, can, requireCan, ROLE_DEFAULTS } from './permissions.js';
import { getSettings } from './policies.js';
import { notify } from './notifications.js';
import { diff, record } from './audit.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const SUBJECTS = Object.freeze(['purchase_order', 'emergency_purchase', 'wastage', 'adjustment', 'count']);
/** Subjects an approval row may carry (rules exist for SUBJECTS; 'transfer' is for branch-to-branch transfers, P2-17). */
export const APPROVAL_SUBJECTS = Object.freeze([...SUBJECTS, 'transfer']);
export const DECISIONS = Object.freeze(['approve', 'reject']);
export const STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);

/** Who may decide each subject by default (stored on every rule and approval). */
export const APPROVER_CAPABILITY = Object.freeze({
  purchase_order: 'inv.purchase.approve', emergency_purchase: 'inv.emergency.approve', wastage: 'inv.adjust.approve',
  adjustment: 'inv.adjust.approve', count: 'inv.count.approve', transfer: 'inv.request.approve',
});
const LABEL = Object.freeze({ purchase_order: 'Purchase order', emergency_purchase: 'Emergency purchase', wastage: 'Wastage', adjustment: 'Stock adjustment', count: 'Stock count', transfer: 'Transfer' });
const NOUN = Object.freeze({ purchase_order: 'purchase order', emergency_purchase: 'purchase', wastage: 'wastage record', adjustment: 'adjustment' });
/** What happens for an amount when the owner has set nothing: 'approve' or 'auto'. */
const SAFE_DEFAULT = Object.freeze({ purchase_order: 'approve', emergency_purchase: 'approve', adjustment: 'approve', wastage: 'auto', count: 'approve' });
const COUNTED = ['authorised', 'purchased', 'received', 'under_review', 'closed'];
const MAX_AMOUNT = 1e9;

/* ---------- time: Africa/Nairobi is UTC+3 all year ---------- */

const OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** [start, end) of the Nairobi day and the Monday-to-Sunday week containing `at`. */
export function windowsFor(at = new Date()) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) throw fail(400, 'That date isn’t valid.', 'bad_date');
  const local = new Date(when.getTime() + OFFSET_MS);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET_MS;
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const weekStart = dayStart - sinceMonday * DAY_MS;
  return { dayStart: new Date(dayStart), dayEnd: new Date(dayStart + DAY_MS), weekStart: new Date(weekStart), weekEnd: new Date(weekStart + 7 * DAY_MS) };
}

/* ---------- small helpers ---------- */

const money = (value, label = 'The amount') => {
  const d = dec(value, { scale: MONEY, label });
  if (cmp(d, 0) < 0) throw fail(400, `${label} can’t be negative.`, 'invalid_amount');
  if (cmp(d, MAX_AMOUNT) > 0) throw fail(400, `${label} is too large.`, 'invalid_amount');
  return d;
};
const str = (d) => (d === null || d === undefined ? null : dec(d).toString(MONEY));
const kes = (d) => `KES ${Number(dec(d).toString(MONEY)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const plain = (d) => Number(dec(d).toString(MONEY)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const lc = (id) => (id ? String(id).toLowerCase() : null);
const zeroUuid = '00000000-0000-0000-0000-000000000000';

const ruleShape = (r) => r && ({
  id: r.id, subject: r.subject, locationId: r.location_id, categoryId: r.category_id,
  locationName: r.location_name ?? undefined, categoryName: r.category_name ?? undefined,
  perTransactionKes: str(r.per_transaction_kes), perDayKes: str(r.per_day_kes), perWeekKes: str(r.per_week_kes),
  variancePct: r.variance_pct === null || r.variance_pct === undefined ? null : Number(r.variance_pct), varianceKes: str(r.variance_kes),
  approverCapability: r.approver_capability, active: r.active, updatedBy: r.updated_by, updatedAt: r.updated_at,
});
const ruleLimits = (r) => ({ perTransactionKes: r.perTransactionKes, perDayKes: r.perDayKes, perWeekKes: r.perWeekKes, variancePct: r.variancePct, varianceKes: r.varianceKes });

async function placeName(db, businessId, locationId) {
  if (!locationId) return null;
  const row = (await db.query(`select coalesce(r.name, l.name) as name from public.stock_locations l left join public.restaurants r on r.id = l.restaurant_id
    where l.id = $1 and l.business_id = $2`, [locationId, businessId])).rows[0];
  return row?.name || null;
}

/** Category id -> { parent, name } for the business. */
async function categoryTree(db, businessId) {
  const { rows } = await db.query('select id, parent_id, name from public.stock_categories where business_id = $1', [businessId]);
  return new Map(rows.map((r) => [r.id, { parent: r.parent_id, name: r.name }]));
}
function chainOf(tree, categoryId) {
  const out = [];
  for (let id = categoryId, guard = 0; id && guard < 20; id = tree.get(id)?.parent, guard += 1) out.push(id);
  return out;
}

/* ---------- who can approve ---------- */

/**
 * User ids who hold `capability` at `locationId` in this business: the owners (everything, everywhere) and, when the business turned on
 * operations_can_approve and the capability is one operations managers get, the operations managers assigned to that branch.
 * Branch managers and waiters never hold an approving capability.
 */
export async function approverIds(db, businessId, capability, locationId = null) {
  const ids = new Set((await db.query(`select user_id from public.business_members where business_id = $1 and role = 'owner'`, [businessId])).rows.map((r) => r.user_id));
  if (locationId && ROLE_DEFAULTS.operations_approver.includes(capability) && (await getSettings(db, businessId)).operations_can_approve) {
    const { rows } = await db.query(`select m.user_id from public.business_members m
      join public.business_member_branches b on b.business_id = m.business_id and b.user_id = m.user_id
      join public.stock_locations l on l.restaurant_id = b.restaurant_id and l.business_id = m.business_id
      where m.business_id = $1 and m.role = 'operations' and l.id = $2`, [businessId, locationId]);
    for (const r of rows) ids.add(r.user_id);
  }
  return [...ids];
}

/** True when someone other than the requester holds the approving capability: then the requester can't approve their own request (D2-5). */
export async function approverAvailable(db, businessId, requesterId, capability, locationId = null) {
  const req = lc(requesterId);
  return (await approverIds(db, businessId, capability, locationId)).some((id) => lc(id) !== req);
}

/* ---------- rules: lookup ---------- */

async function activeRules(db, businessId, subject, locationId) {
  const { rows } = await db.query(`select * from public.approval_rules where business_id = $1 and subject = $2 and active
    and (location_id is null or location_id = $3::uuid)`, [businessId, subject, locationId || null]);
  return rows.map(ruleShape);
}
/** The rule for a category scope: the branch's own row, else the business default. */
const pickRule = (rules, categoryId, locationId) =>
  rules.find((r) => r.categoryId === categoryId && locationId && r.locationId === locationId) || rules.find((r) => r.categoryId === categoryId && r.locationId === null) || null;

/* ---------- evaluate ---------- */

/**
 * Does this need approval? Pure read (plus, for emergency purchases, a per-branch advisory lock that lasts until the caller's transaction ends so two
 * simultaneous small buys can't both slip under the weekly limit: call it in the same transaction that authorises or requests).
 *
 *   { businessId, subject, locationId,
 *     amountKes                       the value of this purchase / wastage record / adjustment (a string or number)
 *     lines: [{ categoryId, amountKes }]   optional split by category, for category rules; or categoryIds: [..] (then every category sees the whole amount)
 *     variancePct, varianceKes, hasVariance    counts only
 *     at: Date (default now), excludeSubjectId (leave this emergency purchase out of the running totals), lock: false to skip the lock }
 *
 * Returns { subject, locationId, amountKes, needsApproval, safeDefault, reasons: [plain words], rule (the main rule that applied or null),
 *   rules (all that applied), approverCapability, usage: { day: { used, limit, after }, week: {...} } | null }.
 */
export async function evaluate(db, input = {}) {
  const { businessId, subject, locationId: rawLocation = null, categoryIds = [], lines = null, at = new Date(), excludeSubjectId = null, lock = true } = input;
  if (!businessId) throw new TypeError('evaluate needs a businessId.');
  if (!SUBJECTS.includes(subject)) throw fail(400, `There is no approval rule for “${String(subject).slice(0, 30)}”.`, 'unknown_subject');
  const locationId = lc(rawLocation);
  if (subject === 'emergency_purchase' && !locationId) throw fail(400, 'Say which branch the emergency purchase is for.', 'location_required');
  const out = { subject, locationId, amountKes: null, needsApproval: false, safeDefault: false, reasons: [], rule: null, rules: [], approverCapability: APPROVER_CAPABILITY[subject], usage: null };
  const rules = await activeRules(db, businessId, subject, locationId);
  const place = await placeName(db, businessId, locationId);
  const at$ = place ? ` at ${place}` : '';

  if (subject === 'count') return evaluateCount(out, rules, locationId, input, at$);

  if (input.amountKes === undefined || input.amountKes === null || input.amountKes === '') throw fail(400, 'Enter the amount (in KES) to check.', 'amount_required');
  const amount = money(input.amountKes);
  out.amountKes = str(amount);

  // Split into category groups.
  const wantsTree = rules.some((r) => r.categoryId) || (Array.isArray(lines) && lines.some((l) => l.categoryId)) || categoryIds.length > 0;
  const tree = wantsTree ? await categoryTree(db, businessId) : new Map();
  const groups = new Map();   // category id | null -> Dec
  if (Array.isArray(lines) && lines.length) {
    for (const l of lines) {
      const key = lc(l.categoryId);
      groups.set(key, add(groups.get(key) ?? 0, money(l.amountKes ?? 0, 'A line amount')));
    }
  } else if (categoryIds.length) {
    for (const id of categoryIds) groups.set(lc(id), amount);
  } else groups.set(null, amount);

  // Which category rule covers each group (nearest ancestor-or-self that has one); the rest are covered by the general rule or by the safe default.
  const general = pickRule(rules, null, locationId);
  const scoped = new Map();   // rule id -> { rule, amount }
  let uncovered = false;
  for (const [categoryId, groupAmount] of groups) {
    const rule = categoryId ? chainOf(tree, categoryId).map((c) => pickRule(rules, c, locationId)).find(Boolean) : null;
    if (!rule) { uncovered = true; continue; }
    const entry = scoped.get(rule.id) || { rule, amount: dec(0) };
    entry.amount = add(entry.amount, groupAmount);
    scoped.set(rule.id, entry);
  }

  // Running totals (emergency purchases only).
  const needsTotals = subject === 'emergency_purchase' && (rules.some((r) => r.perDayKes || r.perWeekKes));
  let totals = null;
  if (subject === 'emergency_purchase' && lock) await db.query('select pg_advisory_xact_lock(hashtext($1))', [`approvals:${businessId}:${locationId}`]);
  if (needsTotals) totals = await usedTotals(db, { businessId, locationId, at, excludeSubjectId, byLine: [...scoped.values()].some((s) => (s.rule.perDayKes || s.rule.perWeekKes)) });

  const check = (rule, scopeAmount, { categoryName = null, isGeneral }) => {
    const hits = [];
    const cat$ = categoryName ? ` for ${categoryName}` : '';
    const used = isGeneral ? totals?.general : totals?.forCategory(rule.categoryId, tree);
    const usage = {};
    if (rule.perTransactionKes !== null && cmp(scopeAmount, rule.perTransactionKes) > 0) {
      hits.push(`Over your ${kes(rule.perTransactionKes)} limit per ${NOUN[subject]}${cat$}${at$} (this one is ${kes(scopeAmount)}).`);
    }
    for (const [key, limit, windowName, label] of [['day', rule.perDayKes, 'day', 'Today’s'], ['week', rule.perWeekKes, 'week', 'Weekly']]) {
      if (limit === null) continue;
      const usedNow = used ? used[windowName] : dec(0);
      const after = add(usedNow, scopeAmount);
      usage[key] = { used: str(usedNow), limit: str(limit), after: str(after) };
      if (cmp(after, limit) > 0) hits.push(`${label} total${cat$} would be ${kes(after)} (limit ${plain(limit)})${at$}.`);
    }
    return { hits, usage };
  };

  const applied = [];
  if (general) {
    const { hits, usage } = check(general, amount, { isGeneral: true });
    applied.push(general);
    out.reasons.push(...hits);
    if (usage.day || usage.week) out.usage = usage;
  }
  for (const { rule, amount: scopeAmount } of scoped.values()) {
    const name = tree.get(rule.categoryId)?.name || null;
    const { hits, usage } = check(rule, scopeAmount, { categoryName: name, isGeneral: false });
    applied.push({ ...rule, categoryName: name });
    out.reasons.push(...hits);
    if (!out.usage && (usage.day || usage.week)) out.usage = usage;
  }
  out.rules = applied;
  out.rule = general || applied[0] || null;
  if (out.rule) out.approverCapability = out.rule.approverCapability;
  out.needsApproval = out.reasons.length > 0;

  if (uncovered && !general) {
    // Some of the money has no rule covering it: the subject's safe default decides.
    if (SAFE_DEFAULT[subject] === 'approve') {
      out.needsApproval = true;
      out.safeDefault = true;
      out.reasons.push(safeDefaultReason(subject, place, rules.length > 0));
    } else if (!applied.length) out.safeDefault = true;
  }
  if (subject === 'purchase_order' && !out.needsApproval && !out.reasons.length) {
    // D2-7: with a band set the owner still approves; the band only marks the large ones. No band at all is the safe default (handled above).
    out.needsApproval = true;
    out.reasons.push('Purchase orders are approved by the owner before they are sent.');
  }
  return out;
}

function safeDefaultReason(subject, place, someRules) {
  const where = place ? ` for ${place}` : '';
  if (subject === 'emergency_purchase') return someRules ? `Part of this purchase isn’t covered by a limit${where}, so the owner is asked.` : `No limit is set${where}. The owner approves every emergency purchase until one is set.`;
  if (subject === 'purchase_order') return 'No approval band is set, so the owner approves every purchase order.';
  if (subject === 'adjustment') return 'Manual stock adjustments need the owner’s approval until you set a limit.';
  return 'This needs approval until a limit is set.';
}

function evaluateCount(out, rules, locationId, input, at$) {
  const rule = pickRule(rules, null, locationId);
  const pct = input.variancePct === undefined || input.variancePct === null ? null : Number(input.variancePct);
  if (pct !== null && (!Number.isFinite(pct) || pct < 0)) throw fail(400, 'The variance percentage must be a number, zero or more.', 'invalid_amount');
  const value = input.varianceKes === undefined || input.varianceKes === null ? null : money(input.varianceKes, 'The variance value');
  const any = input.hasVariance === true || (pct !== null && pct > 0) || (value !== null && !isZero(value));
  out.amountKes = str(value);
  out.rules = rule ? [rule] : [];
  out.rule = rule;
  if (!rule) {
    out.safeDefault = true;
    out.needsApproval = any;
    if (any) out.reasons.push(`This count has a variance and no limit is set${at$}, so it needs approval.`);
    return out;
  }
  out.approverCapability = rule.approverCapability;
  if (rule.variancePct !== null && pct !== null && pct > rule.variancePct) out.reasons.push(`The count is off by ${pct}% (limit ${rule.variancePct}%)${at$}.`);
  if (rule.varianceKes !== null && value !== null && cmp(value, rule.varianceKes) > 0) out.reasons.push(`The count is off by ${kes(value)} (limit ${plain(rule.varianceKes)})${at$}.`);
  out.needsApproval = out.reasons.length > 0;
  return out;
}

/** Running totals of emergency purchases authorised at the branch in the day and week containing `at`. */
async function usedTotals(db, { businessId, locationId, at, excludeSubjectId, byLine }) {
  const w = windowsFor(at);
  const params = [businessId, locationId, w.weekStart, w.weekEnd, excludeSubjectId || null, COUNTED];
  const { rows } = await db.query(`select authorised_at, coalesce(actual_total, approved_total, estimated_total) as amount from public.emergency_purchases
    where business_id = $1 and location_id = $2 and authorised_at >= $3 and authorised_at < $4 and ($5::uuid is null or id <> $5) and status = any($6::text[])`, params);
  const sum = (list, since) => list.filter((r) => new Date(r.authorised_at) >= since).reduce((a, r) => add(a, r.amount ?? 0), dec(0));
  const general = { day: sum(rows, w.dayStart), week: sum(rows, w.weekStart) };
  let lineRows = [];
  if (byLine) {
    lineRows = (await db.query(`select i.category_id, e.authorised_at, coalesce(l.actual_total, l.est_total) as amount
      from public.emergency_purchase_lines l join public.emergency_purchases e on e.id = l.emergency_id and e.business_id = l.business_id
      join public.stock_items i on i.id = l.item_id and i.business_id = l.business_id
      where e.business_id = $1 and e.location_id = $2 and e.authorised_at >= $3 and e.authorised_at < $4 and ($5::uuid is null or e.id <> $5) and e.status = any($6::text[])`, params)).rows;
  }
  return {
    general,
    forCategory: (categoryId, tree) => {
      const mine = lineRows.filter((r) => chainOf(tree, r.category_id).includes(categoryId));
      return { day: sum(mine, w.dayStart), week: sum(mine, w.weekStart) };
    },
  };
}

/**
 * What a branch form shows before the purchase is typed: { hasLimit, perTransactionKes, perDayKes, perWeekKes, usedTodayKes, usedWeekKes,
 * leftTodayKes, leftWeekKes, message }. Uses the branch's own rule, else the business default (general rule only).
 */
export async function limits(db, { businessId, locationId, subject = 'emergency_purchase', at = new Date(), excludeSubjectId = null } = {}) {
  const rule = pickRule(await activeRules(db, businessId, subject, lc(locationId)), null, lc(locationId));
  const place = await placeName(db, businessId, lc(locationId));
  if (!rule) return { hasLimit: false, rule: null, message: `No limit set${place ? ` for ${place}` : ''}. The owner will be asked.` };
  const totals = subject === 'emergency_purchase' && (rule.perDayKes || rule.perWeekKes)
    ? await usedTotals(db, { businessId, locationId: lc(locationId), at, excludeSubjectId, byLine: false }) : null;
  const left = (limit, used) => (limit === null ? null : str(cmp(limit, used) > 0 ? sub(limit, used) : dec(0)));
  const usedDay = totals?.general.day ?? dec(0);
  const usedWeek = totals?.general.week ?? dec(0);
  const result = { hasLimit: true, rule, perTransactionKes: rule.perTransactionKes, perDayKes: rule.perDayKes, perWeekKes: rule.perWeekKes,
    usedTodayKes: str(usedDay), usedWeekKes: str(usedWeek), leftTodayKes: left(rule.perDayKes, usedDay), leftWeekKes: left(rule.perWeekKes, usedWeek) };
  const bits = [];
  if (rule.perTransactionKes !== null) bits.push(`${kes(rule.perTransactionKes)} per purchase`);
  if (rule.perDayKes !== null) bits.push(`${kes(result.leftTodayKes)} left today`);
  if (rule.perWeekKes !== null) bits.push(`${kes(result.leftWeekKes)} left this week`);
  result.message = `Within your limit: ${bits.join(', ')}.`;
  return result;
}

/* ---------- approvals ---------- */

const APPROVAL_SELECT = `select a.*, pr.name as requested_by_name, pd.name as decided_by_name, coalesce(r.name, l.name) as location_name
  from public.approvals a left join public.profiles pr on pr.id = a.requested_by left join public.profiles pd on pd.id = a.decided_by
  left join public.stock_locations l on l.id = a.location_id left join public.restaurants r on r.id = l.restaurant_id`;

const shape = (r) => r && ({
  id: r.id, businessId: r.business_id, subject: r.subject_type, subjectId: r.subject_id, locationId: r.location_id, locationName: r.location_name || null,
  approverCapability: r.approver_capability, requestedBy: r.requested_by, requestedByName: r.requested_by_name || null, requestedAt: r.requested_at,
  amountKes: str(r.amount_kes), ruleSnapshot: r.rule_snapshot || {}, reasons: r.rule_snapshot?.reasons || [], safeDefault: Boolean(r.rule_snapshot?.safeDefault),
  status: r.status, decidedBy: r.decided_by, decidedByName: r.decided_by_name || null, decidedAt: r.decided_at, decisionNote: r.decision_note,
  selfApproved: r.self_approved, cancelledAt: r.cancelled_at,
});

async function load(db, businessId, id, { lock = false } = {}) {
  if (!isId(id)) throw fail(400, 'That approval id is invalid.', 'bad_id');
  const row = (await db.query(`${APPROVAL_SELECT} where a.id = $1 and a.business_id = $2 ${lock ? 'for update of a' : ''}`, [id.toLowerCase(), businessId])).rows[0];
  if (!row) throw fail(404, 'That approval doesn’t exist.', 'approval_not_found');
  return row;
}

/** One approval (business-scoped), or 404. For routes that need its location before authorising. */
export async function getApproval(db, businessId, id) {
  return shape(await load(db, businessId, id));
}

/** Everyone who may be asked: approvers at the location, minus the requester. */
const bodyOf = (a) => [a.amount_kes !== null && a.amount_kes !== undefined ? kes(a.amount_kes) : null, ...(a.rule_snapshot?.reasons || [])].filter(Boolean).join(' ');

/**
 * Opens an approval request and tells the approvers once. Idempotent per subject: when the subject already has a pending approval that one
 * is returned (created = false). Pass the evaluate() result as `evaluation` so the reasons are kept with the request.
 * Call it in the same transaction that moves the subject to pending_approval.
 */
export async function request(db, { businessId, subject, subjectId, locationId = null, requestedBy, requestedByRole = null, amountKes = null, evaluation = null, at = new Date() } = {}) {
  if (!businessId || !isId(subjectId)) throw new TypeError('request needs a businessId and a subjectId.');
  if (!APPROVAL_SUBJECTS.includes(subject)) throw fail(400, `“${String(subject).slice(0, 30)}” can’t be sent for approval.`, 'unknown_subject');
  const capability = evaluation?.approverCapability || APPROVER_CAPABILITY[subject];
  const amount = amountKes === null || amountKes === undefined ? null : str(money(amountKes));
  const snapshot = { ruleId: evaluation?.rule?.id || null, rule: evaluation?.rule ? ruleLimits(evaluation.rule) : null,
    rules: (evaluation?.rules || []).map((r) => ({ id: r.id, categoryId: r.categoryId, ...ruleLimits(r) })),
    reasons: evaluation?.reasons || [], safeDefault: Boolean(evaluation?.safeDefault), usage: evaluation?.usage || null };
  const { rows } = await db.query(`insert into public.approvals (business_id, subject_type, subject_id, location_id, approver_capability, requested_by, requested_at, amount_kes, rule_snapshot)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) on conflict (business_id, subject_type, subject_id) where status = 'pending' do nothing returning id`,
  [businessId, subject, subjectId.toLowerCase(), lc(locationId), capability, requestedBy || null, at, amount, JSON.stringify(snapshot)]);
  if (!rows.length) {
    const existing = (await db.query(`${APPROVAL_SELECT} where a.business_id = $1 and a.subject_type = $2 and a.subject_id = $3 and a.status = 'pending'`, [businessId, subject, subjectId.toLowerCase()])).rows[0];
    return { ...shape(existing), created: false };
  }
  const row = await load(db, businessId, rows[0].id);
  await record(db, { businessId, locationId, actorId: requestedBy, actorRole: requestedByRole, entity: 'approval', entityId: row.id, action: 'request',
    after: { subject, subjectId, amountKes: amount, reasons: snapshot.reasons, safeDefault: snapshot.safeDefault } });
  const approvers = await approverIds(db, businessId, capability, lc(locationId));
  await notify(db, { businessId, recipients: approvers, exclude: [requestedBy], kind: 'approval_needed', title: `${LABEL[subject]} needs your approval`,
    body: bodyOf(row), link: '/owner/inventory/approvals', entity: { type: 'approval', id: row.id }, locationId: lc(locationId), dedupeKey: `approval_needed:${row.id}` });
  return { ...shape(row), created: true };
}

/* callbacks: purchasing and emergency register what to do when an approval is decided */

const handlers = new Map();
/**
 * onDecided('purchase_order' | 'emergency_purchase' | ... | '*', async (db, approval, { scope }) => {}): runs inside decide()'s transaction right
 * after the approval row is updated, once per decision (a repeated decide never calls it again). A throw rolls the decision back.
 * Returns a function that unregisters it.
 */
export function onDecided(subject, fn) {
  if (subject !== '*' && !APPROVAL_SUBJECTS.includes(subject)) throw new TypeError(`onDecided: unknown subject ${subject}`);
  if (typeof fn !== 'function') throw new TypeError('onDecided needs a function.');
  if (!handlers.has(subject)) handlers.set(subject, new Set());
  handlers.get(subject).add(fn);
  return () => handlers.get(subject)?.delete(fn);
}
/** For tests: forget every registered callback. */
export const clearDecisionHandlers = () => handlers.clear();

/**
 * Approve or reject. `db` must be a transaction. `scope` is the caller's inventoryScope.
 *   * the caller must hold the approving capability at the approval's location (403 otherwise; a branch manager never does);
 *   * maker-checker (T-SEC-2): the requester can't approve their own request while another person in the business holds that capability;
 *     when the requester is the ONLY holder, they may, and the row is flagged self_approved, audited ('self_approved') and shown as such (D2-5);
 *   * a rejection needs a reason; you can't reject your own request (withdraw it instead);
 *   * deciding twice the same way returns the stored result (replayed: true) and fires nothing; the opposite decision is a 409.
 */
export async function decide(db, scope, approvalId, { decision, note = null, at = new Date() } = {}) {
  if (!DECISIONS.includes(decision)) throw fail(400, 'Choose approve or reject.', 'bad_decision');
  const text = note === null || note === undefined ? null : String(note).trim().replace(/\s+/g, ' ');
  if (text && text.length > 500) throw fail(400, 'Keep the note under 500 characters.', 'note_too_long');
  if (decision === 'reject' && !text) throw fail(400, 'Say why you are rejecting this, so the person who asked knows what to change.', 'reason_required');
  const row = await load(db, scope.businessId, approvalId, { lock: true });
  const wanted = decision === 'approve' ? 'approved' : 'rejected';
  if (row.status !== 'pending') {
    if (row.status === wanted) return { ...shape(row), replayed: true };
    throw fail(409, row.status === 'cancelled' ? 'This request was withdrawn, so there is nothing to decide.' : `This was already ${row.status}${row.decided_by_name ? ` by ${row.decided_by_name}` : ''}.`, 'already_decided');
  }
  const locationId = row.location_id;
  if (!locationId && !scope.roles.includes('owner')) throw fail(403, 'Only the owner can decide this.', 'forbidden');
  requireCan(scope, row.approver_capability, { locationId });
  const mine = lc(row.requested_by) === lc(scope.userId);
  let selfApproved = false;
  if (mine) {
    if (decision === 'reject') throw fail(403, 'You asked for this, so you can’t reject it. Withdraw the request instead.', 'use_cancel');
    if (await approverAvailable(db, scope.businessId, row.requested_by, row.approver_capability, locationId)) assertDifferentPeople(row.requested_by, scope.userId);
    selfApproved = true;
  } else assertDifferentPeople(row.requested_by, scope.userId);

  await db.query(`update public.approvals set status = $2, decided_by = $3, decided_at = $4, decision_note = $5, self_approved = $6 where id = $1`,
    [row.id, wanted, scope.userId, at, text, selfApproved]);
  const done = shape(await load(db, scope.businessId, row.id));
  await record(db, { businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity: 'approval', entityId: row.id,
    action: selfApproved ? 'self_approved' : decision, before: { status: 'pending' },
    after: { status: wanted, subject: row.subject_type, subjectId: row.subject_id, amountKes: str(row.amount_kes), note: text, selfApproved } });
  if (!selfApproved && row.requested_by) {
    await notify(db, { businessId: scope.businessId, recipients: [row.requested_by], kind: 'approval_decided',
      title: `${LABEL[row.subject_type]} ${wanted}`, body: text ? `${kes(row.amount_kes ?? 0)}: ${text}` : kes(row.amount_kes ?? 0), link: '/inventory/approvals',
      entity: { type: 'approval', id: row.id }, locationId, dedupeKey: `approval_decided:${row.id}` });
  }
  for (const key of [row.subject_type, '*']) for (const fn of handlers.get(key) || []) await fn(db, done, { scope });
  return { ...done, replayed: false };
}

/**
 * Withdraws a pending approval because its subject was cancelled or withdrawn. `target` is an approval id or { subject, subjectId }.
 * The caller (purchasing / emergency) has already checked that the person may withdraw the subject. By subject: returns null when nothing is pending.
 */
export async function cancel(db, scope, target, { note = null, at = new Date() } = {}) {
  let row;
  if (typeof target === 'string') {
    row = await load(db, scope.businessId, target, { lock: true });
    if (row.status !== 'pending') throw fail(409, `This request is already ${row.status}.`, 'not_pending');
  } else {
    if (!APPROVAL_SUBJECTS.includes(target?.subject) || !isId(target?.subjectId)) throw new TypeError('cancel needs an approval id or { subject, subjectId }.');
    const found = (await db.query(`select id from public.approvals where business_id = $1 and subject_type = $2 and subject_id = $3 and status = 'pending' for update`,
      [scope.businessId, target.subject, target.subjectId.toLowerCase()])).rows[0];
    if (!found) return null;
    row = await load(db, scope.businessId, found.id);
  }
  await db.query(`update public.approvals set status = 'cancelled', cancelled_by = $2, cancelled_at = $3, decision_note = coalesce($4, decision_note) where id = $1`,
    [row.id, scope.userId || null, at, note ? String(note).slice(0, 500) : null]);
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'approval', entityId: row.id,
    action: 'cancel', before: { status: 'pending' }, after: { status: 'cancelled', subject: row.subject_type, subjectId: row.subject_id } });
  return shape(await load(db, scope.businessId, row.id));
}

const STATUS_FILTER = { pending: ['pending'], approved: ['approved'], rejected: ['rejected'], cancelled: ['cancelled'], decided: ['approved', 'rejected'], all: STATUSES };
function listArgs({ status = 'pending', subject, limit = 50 } = {}) {
  const statuses = STATUS_FILTER[status];
  if (!statuses) throw fail(400, 'Status must be pending, approved, rejected, cancelled, decided or all.', 'bad_status');
  if (subject && !APPROVAL_SUBJECTS.includes(subject)) throw fail(400, 'That kind of approval doesn’t exist.', 'unknown_subject');
  return { statuses, subject: subject || null, size: Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200) };
}

/**
 * The approvals the caller may decide (they hold the capability at that place), newest first. status: pending (default) | approved | rejected |
 * cancelled | decided (history) | all. Each pending row says whether the caller can decide it now: canDecide, and when not, `blocked` in plain words;
 * `selfApproval: true` marks the sole-approver case (they asked and nobody else can approve). Self-approved rows carry selfApproved = true (the chip).
 */
export async function inbox(db, scope, options = {}) {
  const { statuses, subject, size } = listArgs(options);
  const { rows } = await db.query(`${APPROVAL_SELECT} where a.business_id = $1 and a.status = any($2::text[]) and ($3::text is null or a.subject_type = $3)
    order by a.requested_at desc, a.id desc limit 1000`, [scope.businessId, statuses, subject]);
  const mayDecide = (r) => (r.location_id ? can(scope, r.approver_capability, { locationId: r.location_id }) : scope.roles.includes('owner') && can(scope, r.approver_capability));
  const visible = rows.filter(mayDecide).slice(0, size);
  const cache = new Map();
  const others = async (r) => {
    const key = `${r.approver_capability}:${r.location_id}:${r.requested_by}`;
    if (!cache.has(key)) cache.set(key, await approverAvailable(db, scope.businessId, r.requested_by, r.approver_capability, r.location_id));
    return cache.get(key);
  };
  const approvals = [];
  for (const r of visible) {
    const item = shape(r);
    if (r.status === 'pending') {
      const mine = lc(r.requested_by) === lc(scope.userId);
      const another = mine ? await others(r) : false;
      item.canDecide = !mine || !another;
      item.selfApproval = mine && !another;
      if (!item.canDecide) item.blocked = 'You asked for this, so another approver has to decide it.';
    }
    approvals.push(item);
  }
  return { approvals, pending: statuses.includes('pending') ? visible.filter((r) => r.status === 'pending').length : undefined };
}

/** The caller's own requests (a branch manager's "what happened to my request"), newest first. Same filters as inbox, plus locationId. */
export async function mine(db, scope, options = {}) {
  const { statuses, subject, size } = listArgs({ status: 'all', ...options });
  const { rows } = await db.query(`${APPROVAL_SELECT} where a.business_id = $1 and a.requested_by = $2 and a.status = any($3::text[]) and ($4::text is null or a.subject_type = $4)
    and ($6::uuid is null or a.location_id = $6) order by a.requested_at desc, a.id desc limit $5`, [scope.businessId, scope.userId, statuses, subject, size, lc(options.locationId)]);
  return { approvals: rows.map(shape) };
}

/** Every request ever made for one subject, oldest first (requests, rejections, the final approval). Visible to whoever asked or may decide it. */
export async function history(db, scope, { subject, subjectId } = {}) {
  if (!APPROVAL_SUBJECTS.includes(subject) || !isId(subjectId)) throw fail(400, 'Say which record to show the approval history of.', 'bad_request');
  const { rows } = await db.query(`${APPROVAL_SELECT} where a.business_id = $1 and a.subject_type = $2 and a.subject_id = $3 order by a.requested_at, a.id`, [scope.businessId, subject, subjectId.toLowerCase()]);
  const allowed = rows.filter((r) => lc(r.requested_by) === lc(scope.userId) || (r.location_id ? can(scope, r.approver_capability, { locationId: r.location_id }) : scope.roles.includes('owner')));
  return { approvals: allowed.map(shape) };
}

/* ---------- rules (owner only) ---------- */

const LIMIT_FIELDS = Object.freeze({
  purchase_order: ['perTransactionKes'], wastage: ['perTransactionKes'], adjustment: ['perTransactionKes'],
  emergency_purchase: ['perTransactionKes', 'perDayKes', 'perWeekKes'], count: ['variancePct', 'varianceKes'],
});
const FIELD_LABEL = Object.freeze({ perTransactionKes: 'The limit per purchase', perDayKes: 'The daily limit', perWeekKes: 'The weekly limit', varianceKes: 'The variance value', variancePct: 'The variance percentage' });
const COLUMN = Object.freeze({ perTransactionKes: 'per_transaction_kes', perDayKes: 'per_day_kes', perWeekKes: 'per_week_kes', variancePct: 'variance_pct', varianceKes: 'variance_kes' });
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const RULE_SELECT = `select r.*, coalesce(rs.name, l.name) as location_name, c.name as category_name from public.approval_rules r
  left join public.stock_locations l on l.id = r.location_id left join public.restaurants rs on rs.id = l.restaurant_id left join public.stock_categories c on c.id = r.category_id`;

/** All rules of the business with branch and category names, branch rules after the business default. Needs inv.settings.edit. */
export async function listRules(db, scope, { subject } = {}) {
  requireCan(scope, 'inv.settings.edit');
  if (subject && !SUBJECTS.includes(subject)) throw fail(400, 'That kind of rule doesn’t exist.', 'unknown_subject');
  const { rows } = await db.query(`${RULE_SELECT} where r.business_id = $1 and ($2::text is null or r.subject = $2) order by r.subject, (r.location_id is not null), lower(coalesce(rs.name, l.name, '')), lower(coalesce(c.name, ''))`,
    [scope.businessId, subject || null]);
  return { rules: rows.map(ruleShape) };
}

/**
 * Creates or replaces the rule for (subject, branch or business default, category). Needs inv.settings.edit. Takes effect on the next evaluate.
 *   { subject, locationId (null = every branch), categoryId (null = whole), perTransactionKes, perDayKes, perWeekKes, variancePct, varianceKes, active }
 * Returns { rule, created }. Audited with before and after.
 */
export async function setRule(db, scope, input = {}) {
  requireCan(scope, 'inv.settings.edit');
  const subject = input.subject;
  if (!SUBJECTS.includes(subject)) throw fail(400, 'Choose what the limit is for: emergency purchases, purchase orders, wastage, adjustments or counts.', 'unknown_subject');
  const locationId = blank(input.locationId) ? null : lc(input.locationId);
  const categoryId = blank(input.categoryId) ? null : lc(input.categoryId);
  if ((locationId && !isId(locationId)) || (categoryId && !isId(categoryId))) throw fail(400, 'The branch or category is invalid.', 'bad_id');
  if (locationId) {
    const loc = (await db.query('select kind from public.stock_locations where id = $1 and business_id = $2', [locationId, scope.businessId])).rows[0];
    if (!loc) throw fail(400, 'That branch isn’t part of this business.', 'bad_location');
    if (subject === 'emergency_purchase' && loc.kind !== 'branch') throw fail(400, 'Emergency limits are set per branch, not for the warehouse.', 'bad_location');
  }
  if (categoryId) {
    if (subject === 'count') throw fail(400, 'Count limits can’t be set per category.', 'category_not_allowed');
    if (!(await db.query('select 1 from public.stock_categories where id = $1 and business_id = $2', [categoryId, scope.businessId])).rows.length) throw fail(400, 'That category doesn’t exist.', 'bad_category');
  }
  const allowed = LIMIT_FIELDS[subject];
  const values = {};
  for (const field of Object.keys(COLUMN)) {
    const given = input[field];
    if (blank(given)) { values[field] = null; continue; }
    if (!allowed.includes(field)) {
      throw fail(400, field === 'perDayKes' || field === 'perWeekKes' ? 'Daily and weekly limits only apply to emergency purchases.'
        : subject === 'count' ? 'Count limits are a variance percentage and/or a variance value, not an amount per record.' : 'Variance limits only apply to stock counts.', 'limit_not_allowed');
    }
    if (field === 'variancePct') {
      const n = typeof given === 'number' ? given : Number(String(given).trim());
      if (!Number.isFinite(n) || n < 0 || n > 100) throw fail(400, `${FIELD_LABEL[field]} must be between 0 and 100.`, 'invalid_limit');
      values[field] = Math.round(n * 100) / 100;
    } else {
      try { values[field] = money(given, FIELD_LABEL[field]); } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        throw fail(400, `${FIELD_LABEL[field]} must be an amount in KES like 5000 (zero or more, up to 2 decimals).`, 'invalid_limit');
      }
    }
  }
  if (allowed.every((f) => values[f] === null)) {
    throw fail(400, subject === 'count' ? 'Set a variance percentage, a variance value, or both.' : 'Set at least one limit.', 'limit_required');
  }
  const { perTransactionKes: txn, perDayKes: day, perWeekKes: week } = values;
  if (day !== null && txn !== null && cmp(day, txn) < 0) throw fail(400, `The daily limit (${kes(day)}) can’t be lower than the limit per purchase (${kes(txn)}).`, 'limits_out_of_order');
  if (week !== null && day !== null && cmp(week, day) < 0) throw fail(400, `The weekly limit (${kes(week)}) can’t be lower than the daily limit (${kes(day)}).`, 'limits_out_of_order');
  if (week !== null && txn !== null && cmp(week, txn) < 0) throw fail(400, `The weekly limit (${kes(week)}) can’t be lower than the limit per purchase (${kes(txn)}).`, 'limits_out_of_order');
  const active = input.active === undefined ? true : input.active;
  if (typeof active !== 'boolean') throw fail(400, 'Active must be on or off.', 'invalid_limit');

  const old = (await db.query(`select * from public.approval_rules where business_id = $1 and subject = $2 and coalesce(location_id, $3::uuid) = coalesce($4::uuid, $3::uuid)
    and coalesce(category_id, $3::uuid) = coalesce($5::uuid, $3::uuid) for update`, [scope.businessId, subject, zeroUuid, locationId, categoryId])).rows[0];
  const { rows } = await db.query(`insert into public.approval_rules (business_id, subject, location_id, category_id, per_transaction_kes, per_day_kes, per_week_kes, variance_pct, variance_kes,
      approver_capability, active, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
    on conflict (business_id, subject, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set per_transaction_kes = excluded.per_transaction_kes, per_day_kes = excluded.per_day_kes, per_week_kes = excluded.per_week_kes, variance_pct = excluded.variance_pct,
      variance_kes = excluded.variance_kes, approver_capability = excluded.approver_capability, active = excluded.active, updated_by = excluded.updated_by, updated_at = now() returning id`,
  [scope.businessId, subject, locationId, categoryId, str(txn), str(day), str(week), values.variancePct, str(values.varianceKes), APPROVER_CAPABILITY[subject], active, scope.userId]);
  const rule = ruleShape((await db.query(`${RULE_SELECT} where r.id = $1`, [rows[0].id])).rows[0]);
  const before = old ? ruleLimitsAudit(ruleShape(old)) : null;
  const after = ruleLimitsAudit(rule);
  const changes = diff(before, after);
  await record(db, { businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity: 'approval_rule', entityId: rule.id,
    action: old ? 'update' : 'create', before: old ? { subject, ...changes.before } : null, after: { subject, locationId, categoryId, ...(old ? changes.after : after) } });
  return { rule, created: !old };
}
const ruleLimitsAudit = (r) => ({ ...ruleLimits(r), active: r.active });

/** Removes a rule (the next evaluate falls back to the business default or the safe default). Needs inv.settings.edit. Audited. */
export async function deleteRule(db, scope, ruleId) {
  requireCan(scope, 'inv.settings.edit');
  if (!isId(ruleId)) throw fail(400, 'That rule id is invalid.', 'bad_id');
  const row = (await db.query('delete from public.approval_rules where id = $1 and business_id = $2 returning *', [ruleId.toLowerCase(), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That rule doesn’t exist.', 'rule_not_found');
  const rule = ruleShape(row);
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'approval_rule', entityId: row.id,
    action: 'delete', before: { subject: row.subject, locationId: row.location_id, categoryId: row.category_id, ...ruleLimitsAudit(rule) } });
  return { deleted: true, rule };
}
