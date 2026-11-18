// Manual stock adjustments (ADJ-1..3, P3-05, migration 019). A person corrects stock that has no document behind it: a GAIN (stock found, a
// recount) or a LOSS (damaged, theft suspected), for one item in any of its units, with a reason from the owner's list, a note and optional evidence photos.
//
//   createAdjustment(db, scope, { locationId, direction: 'gain' | 'loss', itemId, quantity, unit?, reasonCodeId | reasonCode, note?, photoIds?, id?, commandId? }, { now })
//   get / list / locationOf                       history (filters: branch, direction, reason, item, status, dates)
//   ensureAdjustmentApprovals()                   registers the decision callback (approvals.onDecided('adjustment'))
//
// Approval (D2-16, D3-4, T-SEC-2): there is NO built-in amount. approvals.evaluate('adjustment', value): until the owner sets an adjustment rule EVERY
// adjustment, gain or loss, needs approval (safe default); once a rule exists a loss within the limit posts at once, a loss above it waits, and EVERY GAIN
// still waits (a gain is how stock can be conjured), as does any adjustment whose cost is unknown while a rule exists (can't be proven under the limit).
// While it waits NOTHING posts. Approving posts 'adjustment_gain' / 'adjustment_loss' with key adjustment:<id>; rejecting keeps the record and posts
// nothing. The maker can't be the checker (the engine, D2-5); a sole approver may approve their own and it is flagged self_approved.
// Cost: the value shown to the approver is an ESTIMATE at the weighted-average cost when it was asked for (frozen on the record). The movement itself is
// posted at the average cost AT POSTING TIME, and a gain carries that average as its unit cost, so a surplus never drags the average cost down (the golden
// dataset finding): the average is unchanged by a gain. The posted value is on the ledger movement.
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { COST, MONEY, QTY, cmp, dec, rescale, sub } from './decimal.js';
import { display, normaliseUnit, toBase } from './units.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { loadUnits } from './catalogue.js';
import { balance, post } from './ledger.js';
import * as approvals from './approvals.js';
import { resolve as resolveReason } from './reasons.js';
import { list as listAttachments } from './attachments.js';
import { nextNumber } from './numbers.js';
import { record as audit } from './audit.js';
import { itemLines, loadItemRow } from './wastage.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};
const money = (d) => (d === null || d === undefined ? null : dec(d).toString(MONEY));
export const STATUSES = Object.freeze(['pending_approval', 'approved', 'rejected', 'posted']);
export const DIRECTIONS = Object.freeze(['gain', 'loss']);
export const NUMBER_KIND = 'ADJ';
const MAX_PHOTOS = 5;
const MAX_NOTE = 500;

const locationOfScope = (scope, locationId) => {
  const loc = scope.locations.find((l) => l.id === (locationId ? String(locationId).toLowerCase() : null));
  if (!loc) throw fail(404, 'That branch or warehouse isn’t part of this business.', 'location_not_found');
  return loc;
};

async function checkPhotos(db, businessId, locationId, adjustmentId, photoIds) {
  if (photoIds === undefined || photoIds === null) return [];
  if (!Array.isArray(photoIds)) throw fail(400, 'photoIds must be a list of uploaded photo ids.', 'bad_photo');
  const ids = [...new Set(photoIds.map((id) => needId(id, 'A photo')))];
  if (ids.length > MAX_PHOTOS) throw fail(400, `Attach at most ${MAX_PHOTOS} photos.`, 'too_many_photos');
  if (!ids.length) return [];
  const found = (await db.query(`select id from public.attachments where business_id = $1 and entity_type = 'adjustment' and entity_id = $2 and location_id = $3
    and deleted_at is null and id = any($4::uuid[])`, [businessId, adjustmentId, locationId, ids])).rows.map((r) => r.id);
  if (found.length !== ids.length) throw fail(400, 'One of the photos wasn’t uploaded for this adjustment. Upload it again, then save the adjustment.', 'bad_photo');
  return ids;
}

const SELECT = `select a.*, a.value_kes::text as value_text, a.entered_quantity::text as entered_text, a.qty_base::text as qty_text, l.name as location_name, r.name as branch_name,
    i.name as item_name, i.unit as item_unit, rc.code as reason_code, rc.label as reason_label, p.name as created_by_name, ap.status as approval_status
  from public.stock_adjustments a join public.stock_locations l on l.id = a.location_id left join public.restaurants r on r.id = l.restaurant_id
  join public.stock_items i on i.id = a.item_id left join public.stock_reason_codes rc on rc.id = a.reason_code_id left join public.profiles p on p.id = a.created_by
  left join public.approvals ap on ap.id = a.approval_id`;

const shapeRow = (r, showCost) => ({
  id: r.id, number: r.number, locationId: r.location_id, locationName: r.branch_name || r.location_name, direction: r.direction,
  itemId: r.item_id, name: r.item_name, quantity: r.entered_text, unit: r.entered_unit, quantityBase: r.qty_text, baseUnit: r.item_unit,
  reason: { id: r.reason_code_id, code: r.reason_code, label: r.reason_label }, note: r.note,
  valueKes: showCost ? r.value_text : null, costUnknown: showCost ? r.value_kes === null || r.value_kes === undefined : undefined,
  status: r.status, approvalId: r.approval_id, movementId: r.movement_id, photoIds: r.evidence_attachment_ids,
  createdBy: r.created_by, createdByName: r.created_by_name || null, createdAt: r.created_at, postedAt: r.posted_at,
});

/** Where an adjustment is (for routes that authorise before the transaction). */
export async function locationOf(db, businessId, id) {
  if (!isId(id)) throw fail(400, 'That adjustment id is invalid.', 'bad_id');
  const row = (await db.query('select location_id from public.stock_adjustments where id = $1 and business_id = $2', [id.toLowerCase(), businessId])).rows[0];
  if (!row) throw fail(404, 'That adjustment doesn’t exist.', 'adjustment_not_found');
  return { locationId: row.location_id };
}

/* ---------- posting ---------- */

async function postAdjustment(db, rec, { actorId, at }) {
  const item = (await db.query('select avg_cost::text as avg_cost from public.stock_items where id = $1', [rec.item_id])).rows[0];
  const gain = rec.direction === 'gain';
  const reason = rec.reason_code_id ? (await db.query('select label from public.stock_reason_codes where id = $1', [rec.reason_code_id])).rows[0]?.label : null;
  const result = await post(db, {
    businessId: rec.business_id, locationId: rec.location_id, itemId: rec.item_id, qty: `${gain ? '' : '-'}${dec(rec.qty_base).toString(QTY)}`,
    reason: gain ? 'adjustment_gain' : 'adjustment_loss', ref: { type: 'adjustment', id: rec.id }, actorId, occurredAt: at, idempotencyKey: `adjustment:${rec.id}`,
    unitCost: gain && item.avg_cost !== null ? dec(item.avg_cost).toString(COST) : null,       // a surplus carries the average cost, so the average does not move
    note: [reason, rec.note].filter(Boolean).join(': ').slice(0, 280) || null,
    entered: { quantity: dec(rec.entered_quantity).toString(QTY), unit: rec.entered_unit },
  });
  await db.query('update public.stock_adjustments set movement_id = $2 where id = $1', [rec.id, result.movement.id]);
  return result;
}

/* ---------- create ---------- */

/**
 * Returns { adjustment, posted, pendingApproval, evaluation: { needsApproval, reasons, safeDefault }, movement, balance, replayed }.
 * The caller needs inv.adjust.create at the location (managers their own branch, owners anywhere).
 */
export async function createAdjustment(db, scope, input = {}, { now = new Date() } = {}) {
  const loc = locationOfScope(scope, input.locationId);
  requireCan(scope, 'inv.adjust.create', { locationId: loc.id });
  const direction = String(input.direction ?? '').toLowerCase();
  if (!DIRECTIONS.includes(direction)) throw fail(400, 'Say whether stock was found (a gain) or lost (a loss).', 'direction_required');

  let commandId = null;
  if (input.commandId !== undefined && input.commandId !== null) {
    commandId = needId(input.commandId, 'The request id');
    const prior = (await db.query('select id from public.stock_adjustments where business_id = $1 and command_id = $2', [scope.businessId, commandId])).rows[0];
    if (prior) return { ...(await view(db, scope, prior.id)), replayed: true };
  }
  const adjustmentId = input.id ? needId(input.id, 'The adjustment id') : randomUUID();
  if (input.id && (await db.query('select 1 from public.stock_adjustments where id = $1', [adjustmentId])).rows[0]) throw fail(409, 'That adjustment id is already used.', 'id_taken');

  if (input.quantity === undefined || input.quantity === null || String(input.quantity).trim() === '') throw fail(400, 'Enter how much.', 'quantity_required');
  const typed = dec(typeof input.quantity === 'string' ? input.quantity.trim() : input.quantity, { label: 'The amount' });
  if (cmp(typed, 0) <= 0) throw fail(400, 'The amount must be more than zero.', 'zero_quantity');
  if (!input.itemId) throw fail(400, 'Choose the stock item.', 'subject_required');
  const itemId = needId(input.itemId, 'The stock item');
  const { row, item } = await loadItemRow(db, scope.businessId, itemId);
  if (row.archived_at) throw fail(409, `${row.name} is archived, so its stock can’t change. Restore it first.`, 'item_archived');
  const units = await loadUnits(db);
  const unit = input.unit === undefined || input.unit === null || String(input.unit).trim() === '' ? (item.displayUnit ?? item.baseUnit) : String(input.unit).trim();
  const qtyBase = toBase(typed.toString(), unit, item, units, { positive: true, label: 'The amount' });
  const enteredUnit = normaliseUnit(unit, item, units) || item.baseUnit;
  const enteredQty = rescale(typed, QTY, 'half-up').toString(QTY);
  const value = itemLines(row, qtyBase)[0].value;      // estimate at today's average cost; null = this item has no cost yet

  // A loss can't take more than is free here: say so now rather than leave an approval nobody can grant.
  if (direction === 'loss') {
    const bal = await balance(db, loc.id, itemId);
    if (cmp(qtyBase, bal.available) > 0) {
      throw fail(409, `Only ${display(bal.available, item, units)} of ${row.name} is free here; you tried to take ${display(qtyBase, item, units)}. Take less, or receive more stock first.`, 'insufficient_stock');
    }
  }

  const reason = await resolveReason(db, scope.businessId, 'adjustment', { id: input.reasonCodeId, code: input.reasonCode });
  if (!reason) {
    const askedByText = tidy(input.reasonCode);
    if (askedByText && !input.reasonCodeId) throw fail(404, 'That reason isn’t in your list. Pick one from the list.', 'reason_not_found');
    throw fail(400, 'Pick a reason for the adjustment.', 'reason_required');
  }
  const note = tidy(input.note);
  if (note.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');
  if (reason.needsNote && !note) throw fail(400, `“${reason.label}” needs a note. Say what happened.`, 'note_required');
  if (direction === 'gain' && !note) throw fail(400, 'Say where the extra stock came from: a gain always needs a note.', 'note_required');
  const photoIds = await checkPhotos(db, scope.businessId, loc.id, adjustmentId, input.photoIds);
  if (reason.needsPhoto && !photoIds.length) throw fail(400, `“${reason.label}” needs a photo. Take one, then save the adjustment.`, 'photo_required');

  // Does it need approval? Nothing is built in: no rule = every adjustment; a rule = losses over it and every gain.
  const evaluation = await approvals.evaluate(db, { businessId: scope.businessId, subject: 'adjustment', locationId: loc.id, amountKes: value ?? '0', at: now, lock: false });
  let needsApproval = evaluation.needsApproval;
  if (direction === 'gain' && !needsApproval) {
    needsApproval = true;
    evaluation.reasons.push('Stock gains always need approval: more stock appearing is checked by another person.');
  }
  if (value === null && !needsApproval && evaluation.rules.length) {
    needsApproval = true;
    evaluation.reasons.push('This item has no cost yet, so Cravio can’t check the adjustment against your limit.');
  }
  evaluation.needsApproval = needsApproval;

  const number = await nextNumber(db, { businessId: scope.businessId, kind: NUMBER_KIND, now });
  const status = needsApproval ? 'pending_approval' : 'posted';
  try {
    await db.query(`insert into public.stock_adjustments (id, business_id, location_id, number, direction, item_id, entered_quantity, entered_unit, qty_base, reason_code_id, note,
        evidence_attachment_ids, value_kes, status, created_by, command_id, created_at, posted_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid[], $13, $14, $15, $16, $17, $18)`,
    [adjustmentId, scope.businessId, loc.id, number, direction, itemId, enteredQty, enteredUnit, qtyBase, reason.id, note || null, `{${photoIds.join(',')}}`, value, status, scope.userId,
      commandId, now, needsApproval ? null : now]);
  } catch (error) {
    if (error?.code === '23505' && commandId && /command/.test(`${error.constraint || ''} ${error.message}`)) {
      const prior = (await db.query('select id from public.stock_adjustments where business_id = $1 and command_id = $2', [scope.businessId, commandId])).rows[0];
      if (prior) return { ...(await view(db, scope, prior.id)), replayed: true };
    }
    throw error;
  }

  const out = { posted: false, pendingApproval: needsApproval, evaluation: { needsApproval, reasons: evaluation.reasons, safeDefault: evaluation.safeDefault }, movement: null, balance: null, replayed: false };
  const base = { number, direction, name: row.name, quantity: enteredQty, unit: enteredUnit, reason: reason.code, valueKes: value };
  if (needsApproval) {
    const approval = await approvals.request(db, { businessId: scope.businessId, subject: 'adjustment', subjectId: adjustmentId, locationId: loc.id, requestedBy: scope.userId,
      requestedByRole: scope.role, amountKes: value ?? '0', evaluation, at: now });
    await db.query('update public.stock_adjustments set approval_id = $2 where id = $1', [adjustmentId, approval.id]);
    await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'adjustment', entityId: adjustmentId, action: 'request',
      after: { ...base, status, approvalId: approval.id, reasons: evaluation.reasons } });
  } else {
    const rec = (await db.query('select * from public.stock_adjustments where id = $1', [adjustmentId])).rows[0];
    const result = await postAdjustment(db, rec, { actorId: scope.userId, at: now });
    out.posted = true;
    out.movement = result.movement;
    out.balance = result.balance;
    await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'adjustment', entityId: adjustmentId, action: 'record',
      after: { ...base, status, movementId: result.movement.id } });
  }
  return { ...out, adjustment: (await view(db, scope, adjustmentId)).adjustment };
}

/* ---------- the approvals engine calls this ---------- */

/**
 * Approved -> posts the movement (key adjustment:<id>) and marks the adjustment posted; rejected -> marks it rejected and posts nothing. A decided
 * adjustment is left alone. If the stock is no longer there the approval fails with the ledger's plain message and the decision is rolled back.
 */
export async function applyDecision(db, approval, { scope }) {
  const rec = (await db.query('select * from public.stock_adjustments where id = $1 and business_id = $2 for update', [approval.subjectId, approval.businessId])).rows[0];
  if (!rec || rec.status !== 'pending_approval') return null;
  const at = approval.decidedAt ? new Date(approval.decidedAt) : new Date();
  if (approval.status === 'approved') {
    await db.query(`update public.stock_adjustments set status = 'approved' where id = $1`, [rec.id]);
    let result;
    try {
      result = await postAdjustment(db, rec, { actorId: rec.created_by, at });
    } catch (error) {
      if (error instanceof HttpError && ['insufficient_stock', 'stock_reserved'].includes(error.details?.code)) throw fail(409, `This can’t be approved yet. ${error.message}`, error.details.code);
      throw error;
    }
    await db.query(`update public.stock_adjustments set status = 'posted', posted_at = $2 where id = $1`, [rec.id, at]);
    await audit(db, { businessId: rec.business_id, locationId: rec.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'adjustment', entityId: rec.id,
      action: approval.selfApproved ? 'approve_self' : 'approve', before: { status: 'pending_approval' },
      after: { status: 'posted', approvalId: approval.id, direction: rec.direction, valueKes: money(rec.value_kes), movementId: result.movement.id, selfApproved: approval.selfApproved } });
  } else if (approval.status === 'rejected') {
    await db.query(`update public.stock_adjustments set status = 'rejected' where id = $1`, [rec.id]);
    await audit(db, { businessId: rec.business_id, locationId: rec.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'adjustment', entityId: rec.id, action: 'reject',
      before: { status: 'pending_approval' }, after: { status: 'rejected', note: approval.decisionNote } });
  }
  return rec.id;
}
let unregister = null;
export function ensureAdjustmentApprovals() {
  if (!unregister) unregister = approvals.onDecided('adjustment', applyDecision);
  return unregister;
}
/** For tests: forget the registration so ensureAdjustmentApprovals() adds it back after approvals.clearDecisionHandlers(). */
export function resetAdjustmentApprovals() { unregister = null; }
ensureAdjustmentApprovals();

/* ---------- reading ---------- */

/** One adjustment with its photos and approval. Needs inv.view at its location. */
export async function view(db, scope, id) {
  if (!isId(id)) throw fail(400, 'That adjustment id is invalid.', 'bad_id');
  const row = (await db.query(`${SELECT} where a.id = $1 and a.business_id = $2`, [id.toLowerCase(), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That adjustment doesn’t exist.', 'adjustment_not_found');
  requireCan(scope, 'inv.view', { locationId: row.location_id });
  const showCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const photos = await listAttachments(db, scope, { entityType: 'adjustment', entityId: row.id });
  const approval = row.approval_id ? await approvals.getApproval(db, scope.businessId, row.approval_id) : null;
  const movement = row.movement_id ? (await db.query('select unit_cost::text as unit_cost, value::text as value from public.stock_movements where id = $1', [row.movement_id])).rows[0] : null;
  return {
    adjustment: {
      ...shapeRow(row, showCost),
      postedValueKes: showCost && movement?.value ? movement.value.replace('-', '') : null,
      photos: photos.map((p) => ({ id: p.id, name: p.name, mime: p.mime })),
      approval: approval && { id: approval.id, status: approval.status, decidedByName: approval.decidedByName, decidedAt: approval.decidedAt, decisionNote: approval.decisionNote,
        selfApproved: approval.selfApproved, reasons: approval.reasons },
    },
  };
}
export const get = view;

const parseDate = (value, label) => {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw fail(400, `${label} isn’t a valid date.`, 'bad_date');
  return t;
};

/**
 * The adjustment log (newest first) for the places the caller can view, with totals of what POSTED (gains and losses at the estimate frozen on each record).
 * Filters: locationId, direction, reason (code or id), itemId, status (comma list), employee, from, to, limit (max 200), before (the nextBefore marker).
 */
export async function list(db, scope, { locationId = null, direction = null, reason = null, itemId = null, status = null, employee = null, from = null, to = null, limit = 60, before = null } = {}) {
  const visible = locationsWith(scope, 'inv.view');
  if (!visible.length) throw fail(403, 'You don’t have access to this.', 'forbidden');
  const costPlaces = locationsWith(scope, 'inv.cost.view');
  let places = visible;
  if (locationId) {
    const id = needId(locationId, 'The branch');
    if (!visible.includes(id)) throw fail(403, 'You don’t have access to this branch.', 'branch_forbidden');
    places = [id];
  }
  const args = [scope.businessId, places];
  const where = ['a.business_id = $1', 'a.location_id = any($2::uuid[])'];
  const arg = (value) => { args.push(value); return `$${args.length}`; };
  if (direction) {
    if (!DIRECTIONS.includes(direction)) throw fail(400, 'The direction must be gain or loss.', 'bad_direction');
    where.push(`a.direction = ${arg(direction)}`);
  }
  if (reason) {
    if (isId(reason)) where.push(`a.reason_code_id = ${arg(reason.toLowerCase())}`);
    else where.push(`a.reason_code_id in (select id from public.stock_reason_codes where business_id = $1 and kind = 'adjustment' and code = ${arg(String(reason).toLowerCase())})`);
  }
  if (itemId) where.push(`a.item_id = ${arg(needId(itemId, 'The item'))}`);
  if (employee) where.push(`a.created_by = ${arg(needId(employee, 'The employee'))}`);
  if (status) {
    const wanted = String(status).split(',').map((s) => s.trim());
    if (!wanted.every((s) => STATUSES.includes(s))) throw fail(400, `The status must be one of: ${STATUSES.join(', ')}.`, 'bad_status');
    where.push(`a.status = any(${arg(wanted)}::text[])`);
  }
  if (from) where.push(`a.created_at >= ${arg(parseDate(from, 'The start date'))}`);
  if (to) where.push(`a.created_at < ${arg(parseDate(to, 'The end date'))}`);
  const filtered = where.join(' and ');
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 60, 1), 200);
  let cursor = '';
  const totalArgs = [...args];
  if (before) {
    const [at, lastId] = String(before).split('|');
    cursor = ` and (a.created_at, a.id) < (${arg(parseDate(at, 'The page marker'))}::timestamptz, ${arg(needId(lastId, 'The page marker'))}::uuid)`;
  }
  const rows = (await db.query(`${SELECT} where ${filtered}${cursor} order by a.created_at desc, a.id desc limit ${size + 1}`, args)).rows;
  const page = rows.slice(0, size);
  totalArgs.push(costPlaces);
  const t = (await db.query(`select a.direction, count(*)::int as n, coalesce(sum(case when a.location_id = any($${totalArgs.length}::uuid[]) then a.value_kes end), 0)::text as value
    from public.stock_adjustments a where ${filtered} and a.status = 'posted' group by a.direction`, totalArgs)).rows;
  const pending = (await db.query(`select count(*)::int as n from public.stock_adjustments a where ${filtered} and a.status = 'pending_approval'`, totalArgs.slice(0, -1))).rows[0].n;
  const of = (d) => t.find((x) => x.direction === d) || { n: 0, value: '0' };
  return {
    adjustments: page.map((r) => shapeRow(r, costPlaces.includes(r.location_id))),
    totals: { pending, gains: { count: of('gain').n, valueKes: dec(of('gain').value).toString(MONEY) }, losses: { count: of('loss').n, valueKes: dec(of('loss').value).toString(MONEY) },
      netKes: sub(of('gain').value, of('loss').value).toString(MONEY) },
    nextBefore: rows.length > size ? `${new Date(page.at(-1).created_at).toISOString()}|${page.at(-1).id}` : null,
  };
}
