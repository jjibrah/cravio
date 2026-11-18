// Discrepancy review (P2-23). A delivery that arrives short, damaged or with extra leaves a row in public.transfer_discrepancies (opened by
// distribution.receive). Here the owner reads them and decides who bears the loss.
//
// ACCOUNTING (checked against how distribution.js posts):
//   dispatch posts  transfer_dispatch  -dispatched   at the sender      (the full amount leaves the sender's book at once)
//   receive posts   transfer_receipt   +good         at the receiver     (damaged is NOT added; short is not added; "over" is added as transfer_discrepancy)
//   So for dispatched 15, good 14, short 1: sender -15, receiver +14. The missing 1 kg is already out of EVERY on-hand figure. Therefore:
//
//   kind        resolution            stock movement                              meaning
//   short       write_off             none                                        the 1 kg is really gone. Loss = qty x carried unit cost, recorded against the bearer. No stock change.
//   short       arrived_later         transfer_receipt  + at the receiver          the goods turned up (full amount, or part: the rest stays open)
//   short       returned_to_source    transfer_discrepancy + at the sender        the goods never really left the sender (over-picked / sent back); the sender's book was short
//   damaged     write_off             none                                        destroyed goods are already out of both books. Loss against the bearer.
//   over        write_off             none                                        the receiver keeps the extra as a gain; neither book is corrected (recorded, no value lost)
//   over        source_deducts        transfer_discrepancy - at the sender        the extra really did come out of the sender's stock: take it off their book (refused below zero / into held stock)
//   over        returned_to_source    transfer_discrepancy - at the receiver      the extra went back / was a miscount: remove it from the receiver. The sender never lost it, so nothing is added there.
//
// Every resolution posts AT MOST ONE movement (ref { type: 'discrepancy', id }), so on-hand never changes twice for the same units, and ledger.reconcile stays clean.
// The loss figure (value_kes, at the carried unit cost, set when the delivery was received) stays on the row with the bearer (carrier | source | destination);
// "lossKes" counts only write_off of short/damaged goods. After a resolution distribution.settleRequest() completes a request that has no open discrepancy left.
// Permission: inv.adjust.approve (owners; operations managers only when operations_can_approve is on), at the sending or the receiving place.
// Evidence photos: attach to entity 'discrepancy' (inventory-attachments) with the discrepancy id before or after resolving.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { MONEY, QTY, cmp, dec, isZero, mul, sub } from './decimal.js';
import { loadUnits } from './catalogue.js';
import * as ledger from './ledger.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { record as audit } from './audit.js';
import { notify } from './notifications.js';
import { OWNER_PROBLEMS_LINK, branchRequestsLink, loadItems, settleRequest, show, transferRef } from './distribution.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
export const BEARERS = Object.freeze(['carrier', 'source', 'destination']);
export const RESOLUTIONS = Object.freeze(['write_off', 'returned_to_source', 'arrived_later', 'source_deducts']);
/** Which resolutions make sense for which kind of difference. */
export const ALLOWED = Object.freeze({
  short: ['write_off', 'arrived_later', 'returned_to_source'],
  damaged: ['write_off'],
  over: ['write_off', 'source_deducts', 'returned_to_source'],
});
const MAX_NOTE = 280;
const tidy = (t) => String(t ?? '').trim().replace(/\s+/g, ' ');
const BEARER_WORDS = { carrier: 'the carrier', source: 'the sender', destination: 'the receiving branch' };
const RESOLUTION_WORDS = {
  write_off: { short: 'written off as lost', damaged: 'written off as damaged', over: 'accepted as extra stock' },
  arrived_later: { short: 'found: the goods arrived' },
  returned_to_source: { short: 'never left the sender: put back on their stock', over: 'sent back: taken off the receiver' },
  source_deducts: { over: 'taken off the sender’s stock' },
};

const SELECT = `select d.*, d.qty_base::text as qty_text, d.value_kes::text as value_text, t.number as t_number, t.dispatched_at, t.request_id, t.from_location, t.to_location, t.direction,
    lf.restaurant_id as from_restaurant, lt.restaurant_id as to_restaurant,
    case when lf.kind = 'branch' then coalesce(rf.name, lf.name) else 'Warehouse' end as from_name, case when lt.kind = 'branch' then coalesce(rt.name, lt.name) else 'Warehouse' end as to_name,
    pr.name as resolved_by_name
  from public.transfer_discrepancies d join public.stock_transfers t on t.id = d.transfer_id
  join public.stock_locations lf on lf.id = t.from_location left join public.restaurants rf on rf.id = lf.restaurant_id
  join public.stock_locations lt on lt.id = t.to_location left join public.restaurants rt on rt.id = lt.restaurant_id
  left join public.profiles pr on pr.id = d.resolved_by`;

async function views(db, scope, rows) {
  if (!rows.length) return [];
  const items = await loadItems(db, scope.businessId, rows.map((r) => r.item_id));
  const units = await loadUnits(db);
  return rows.map((d) => {
    const it = items.get(d.item_id);
    const cost = can(scope, 'inv.cost.view', { locationId: d.from_location }) || can(scope, 'inv.cost.view', { locationId: d.to_location });
    const loss = d.status === 'resolved' && d.resolution === 'write_off' && d.kind !== 'over' ? d.value_text : null;
    return {
      id: d.id, transferId: d.transfer_id, transferRef: transferRef(d.t_number, d.dispatched_at), requestId: d.request_id,
      fromLocationId: d.from_location, fromName: d.from_name, fromBranchId: d.from_restaurant, toLocationId: d.to_location, toName: d.to_name, toBranchId: d.to_restaurant,
      itemId: d.item_id, name: it?.name, unit: it?.baseUnit, kind: d.kind, quantity: d.qty_text, display: it ? show(it, d.qty_text, units) : null,
      valueKes: cost ? d.value_text : null, lossKes: cost ? loss : null, status: d.status, note: d.note, createdAt: d.created_at,
      bearer: d.bearer, resolution: d.resolution, resolutionNote: d.resolution_note, resolvedAt: d.resolved_at, resolvedBy: d.resolved_by, resolvedByName: d.resolved_by_name || null,
      movementId: d.resolution_movement_id,
      choices: d.status === 'open' ? ALLOWED[d.kind] : [],
    };
  });
}

const dayStart = (text, label) => {
  if (text === undefined || text === null || text === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text)) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) throw fail(400, `${label} must be a date like 2026-11-25.`, 'bad_date');
  return String(text);
};

/**
 * Discrepancies the caller may see (a delivery's sender or receiver side). { status: 'open' (default) | 'resolved' | 'all', branchId (restaurant id), from, to ('YYYY-MM-DD',
 * on the day it was opened), kind, limit (max 200) }. Also returns a summary: how many are open and worth how much, and the loss written off per bearer.
 */
export async function list(db, scope, { status = 'open', branchId = null, from = null, to = null, kind = null, limit = 100 } = {}) {
  const visible = locationsWith(scope, 'inv.view');
  if (!visible.length) throw fail(403, 'You don’t have access to this.', 'forbidden');
  if (!['open', 'resolved', 'all'].includes(status)) throw fail(400, 'The status must be open, resolved or all.', 'bad_status');
  if (kind && !Object.hasOwn(ALLOWED, kind)) throw fail(400, 'The kind must be short, damaged or over.', 'bad_kind');
  const args = [scope.businessId, visible];
  const arg = (v) => { args.push(v); return `$${args.length}`; };
  const where = ['d.business_id = $1', '(t.from_location = any($2::uuid[]) or t.to_location = any($2::uuid[]))'];
  if (kind) where.push(`d.kind = ${arg(kind)}`);
  if (branchId) {
    if (!isId(branchId)) throw fail(400, 'That branch id is invalid.', 'bad_id');
    const p = arg(branchId.toLowerCase());
    where.push(`(lf.restaurant_id = ${p} or lt.restaurant_id = ${p})`);
  }
  const f = dayStart(from, 'From');
  const e = dayStart(to, 'To');
  if (f) where.push(`d.created_at >= ${arg(`${f}T00:00:00+03:00`)}::timestamptz`);
  if (e) where.push(`d.created_at < (${arg(`${e}T00:00:00+03:00`)}::timestamptz + interval '1 day')`);
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  const rowWhere = status === 'all' ? where : [...where, `d.status = ${arg(status)}`];
  const rows = (await db.query(`${SELECT} where ${rowWhere.join(' and ')} order by d.status, d.created_at desc, d.id limit ${size}`, args)).rows;
  const loss = (bearer) => `coalesce(sum(d.value_kes) filter (where d.status = 'resolved' and d.resolution = 'write_off' and d.kind <> 'over' and d.bearer = '${bearer}'), 0)::numeric(14, 2)::text`;
  const sum = (await db.query(`select count(*) filter (where d.status = 'open')::int as open_n, coalesce(sum(d.value_kes) filter (where d.status = 'open'), 0)::numeric(14, 2)::text as open_value,
      ${loss('carrier')} as carrier, ${loss('source')} as source, ${loss('destination')} as destination
    from public.transfer_discrepancies d join public.stock_transfers t on t.id = d.transfer_id
    join public.stock_locations lf on lf.id = t.from_location join public.stock_locations lt on lt.id = t.to_location where ${where.join(' and ')}`, args.slice(0, args.length - (status === 'all' ? 0 : 1)))).rows[0];
  const showCost = locationsWith(scope, 'inv.cost.view').length > 0;
  return {
    discrepancies: await views(db, scope, rows),
    summary: { open: sum.open_n, openValueKes: showCost ? sum.open_value : null, lossKesByBearer: showCost ? { carrier: sum.carrier, source: sum.source, destination: sum.destination } : null },
  };
}

/** One discrepancy (visible to the sender and the receiver side). */
export async function get(db, scope, id) {
  const d = (await db.query(`${SELECT} where d.id = $1 and d.business_id = $2`, [needId(id), scope.businessId])).rows[0];
  if (!d) throw fail(404, 'That discrepancy isn’t in this business.', 'discrepancy_not_found');
  if (!can(scope, 'inv.view', { locationId: d.from_location }) && !can(scope, 'inv.view', { locationId: d.to_location })) requireCan(scope, 'inv.view', { locationId: d.to_location });
  return { discrepancy: (await views(db, scope, [d]))[0] };
}

/** { fromLocationId, toLocationId } for routes that authorise before the transaction. */
export async function locationsOf(db, businessId, id) {
  const row = (await db.query(`select t.from_location, t.to_location from public.transfer_discrepancies d join public.stock_transfers t on t.id = d.transfer_id where d.id = $1 and d.business_id = $2`, [needId(id), businessId])).rows[0];
  if (!row) throw fail(404, 'That discrepancy isn’t in this business.', 'discrepancy_not_found');
  return { fromLocationId: row.from_location, toLocationId: row.to_location };
}

const needId = (value) => {
  if (!isId(value)) throw fail(400, 'That discrepancy id is invalid.', 'bad_id');
  return value.toLowerCase();
};

/**
 * Resolves one open discrepancy. input: { bearer: 'carrier'|'source'|'destination', resolution, note (required), quantity? (base units; only for arrived_later and
 * returned_to_source on a short: part of it turned up, the rest stays open) }. See the table at the top for the stock effect of each combination.
 */
export async function resolve(db, scope, id, input = {}, { now = new Date() } = {}) {
  const d = (await db.query(`${SELECT} where d.id = $1 and d.business_id = $2 for update of d`, [needId(id), scope.businessId])).rows[0];
  if (!d) throw fail(404, 'That discrepancy isn’t in this business.', 'discrepancy_not_found');
  if (!can(scope, 'inv.adjust.approve', { locationId: d.from_location })) requireCan(scope, 'inv.adjust.approve', { locationId: d.to_location });
  if (d.status !== 'open') throw fail(409, 'This discrepancy was already resolved.', 'already_resolved');
  const bearer = input.bearer;
  if (!BEARERS.includes(bearer)) throw fail(400, 'Say who bears the loss: the carrier, the sender or the receiving branch.', 'bearer_required');
  const resolution = input.resolution;
  if (!RESOLUTIONS.includes(resolution)) throw fail(400, 'Choose how to resolve it.', 'resolution_required');
  if (!ALLOWED[d.kind].includes(resolution)) throw fail(400, `A ${d.kind} difference can be resolved as: ${ALLOWED[d.kind].map((r) => r.replace(/_/g, ' ')).join(', ')}.`, 'resolution_not_allowed');
  const note = tidy(input.note);
  if (!note) throw fail(400, 'Add a note saying what happened.', 'note_required');
  if (note.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');

  let qty = d.qty_text;
  if (input.quantity !== undefined && input.quantity !== null && String(input.quantity).trim() !== '') {
    if (!['arrived_later', 'returned_to_source'].includes(resolution)) throw fail(400, 'Only goods that turned up or went back can be resolved in part.', 'partial_not_allowed');
    qty = dec(String(input.quantity), { scale: QTY, round: 'exact', label: 'The quantity' }).toString(QTY);
    if (isZero(qty) || cmp(qty, 0) < 0) throw fail(400, 'The quantity must be more than zero.', 'zero_quantity');
    if (cmp(qty, d.qty_text) > 0) throw fail(400, 'That is more than is missing. Enter the amount that turned up.', 'quantity_too_large');
  }
  const partial = cmp(qty, d.qty_text) < 0;
  const line = (await db.query('select unit_cost::text as unit_cost from public.stock_transfer_lines where transfer_id = $1 and item_id = $2', [d.transfer_id, d.item_id])).rows[0];
  const unitCost = line?.unit_cost ?? null;
  const total = d.value_text;
  const part = partial ? (unitCost === null ? null : mul(qty, unitCost, MONEY, 'half-up').toString(MONEY)) : total;
  const rest = partial && total !== null && part !== null ? sub(total, part, MONEY).toString(MONEY) : null;

  // The row that ends up 'resolved': the original, or (partial) a new one for the found part while the original keeps the rest.
  let rid = d.id;
  if (partial) {
    rid = (await db.query(`insert into public.transfer_discrepancies (business_id, transfer_id, item_id, kind, qty_base, value_kes, status, bearer, resolution, resolution_note, resolved_by, resolved_at, note, created_by, created_at)
      values ($1, $2, $3, $4, $5, $6, 'resolved', $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [d.business_id, d.transfer_id, d.item_id, d.kind, qty, part, bearer, resolution, note, scope.userId, now, d.note, d.created_by, d.created_at])).rows[0].id;
    await db.query('update public.transfer_discrepancies set qty_base = $2, value_kes = $3 where id = $1', [d.id, sub(d.qty_text, qty, QTY).toString(QTY), rest]);
  }

  // At most one movement.
  const ref = transferRef(d.t_number, d.dispatched_at);
  let movement = null;
  const post = async (locationId, signed, reason, counterparty, text) => {
    const r = await ledger.post(db, { businessId: scope.businessId, locationId, itemId: d.item_id, qty: signed, reason, unitCost: signed.startsWith('-') ? undefined : unitCost ?? undefined,
      ref: { type: 'discrepancy', id: rid }, counterpartyLocationId: counterparty, note: `${ref}: ${text}`.slice(0, 280), actorId: scope.userId,
      idempotencyKey: `disc:${rid}:resolve`, occurredAt: now });
    return r.movement;
  };
  if (d.kind === 'short' && resolution === 'arrived_later') movement = await post(d.to_location, qty, 'transfer_receipt', d.from_location, `found later. ${note}`);
  else if (d.kind === 'short' && resolution === 'returned_to_source') movement = await post(d.from_location, qty, 'transfer_discrepancy', d.to_location, `never left the sender. ${note}`);
  else if (d.kind === 'over' && resolution === 'source_deducts') movement = await post(d.from_location, `-${qty}`, 'transfer_discrepancy', d.to_location, `extra taken off the sender. ${note}`);
  else if (d.kind === 'over' && resolution === 'returned_to_source') movement = await post(d.to_location, `-${qty}`, 'transfer_discrepancy', d.from_location, `extra sent back. ${note}`);

  await db.query(`update public.transfer_discrepancies set status = 'resolved', bearer = $2, resolution = $3, resolution_movement_id = $4, resolution_note = $5, resolved_by = $6, resolved_at = $7 where id = $1`,
    [rid, bearer, resolution, movement?.id ?? null, note, scope.userId, now]);
  await audit(db, { businessId: scope.businessId, locationId: d.to_location, actorId: scope.userId, actorRole: scope.role, entity: 'discrepancy', entityId: rid, action: 'resolve',
    before: { status: 'open', kind: d.kind, quantity: d.qty_text }, after: { status: 'resolved', bearer, resolution, quantity: qty, valueKes: part, note, movementId: movement?.id ?? null, splitFrom: partial ? d.id : null } });
  const requestSettled = d.request_id ? await settleRequest(db, d.request_id, now) : false;

  // Tell both sides.
  const items = await loadItems(db, scope.businessId, [d.item_id]);
  const it = items.get(d.item_id);
  const what = `${show(it, qty, await loadUnits(db))} of ${it.name}`;
  const words = RESOLUTION_WORDS[resolution][d.kind];
  const title = `${ref}: ${what} ${words}`;
  // One dedupe key for everyone: an owner who is also a member of a branch is told once (owners are notified first, so they get the owner link).
  const body = `Borne by ${BEARER_WORDS[bearer]}. ${note}`.slice(0, 900);
  const entity = { type: 'discrepancy', id: rid };
  await notify(db, { businessId: scope.businessId, recipients: 'owners', exclude: [scope.userId], kind: 'discrepancy_resolved', title, body, link: OWNER_PROBLEMS_LINK, entity, dedupeKey: `discrepancy_resolved:${rid}` });
  for (const branch of new Set([d.from_restaurant, d.to_restaurant].filter(Boolean))) {
    await notify(db, { businessId: scope.businessId, recipients: [`branch_managers:${branch}`], exclude: [scope.userId], kind: 'discrepancy_resolved', title, body, link: branchRequestsLink(branch), entity, dedupeKey: `discrepancy_resolved:${rid}` });
  }
  return { ...(await get(db, scope, rid)), movement: movement ? { id: movement.id, reason: movement.reason, delta: movement.delta, locationId: movement.locationId } : null,
    remaining: partial ? (await get(db, scope, d.id)).discrepancy : null, requestSettled };
}
