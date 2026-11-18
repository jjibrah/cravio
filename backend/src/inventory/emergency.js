// Emergency purchases (P2-11, migration 017): a branch runs out of something mid-service and buys it on the spot. The owner sets the limits
// (approval rules, D2-6); until a limit is set EVERY emergency buy waits for the owner (D2-16). The whole life of one purchase:
//
//   create (draft) -> submit -> authorised  (below every limit: at once, nobody is asked)
//                            -> pending_approval -> authorised | rejected   (the owner decides in the Approvals inbox; approvals.decide ->
//                                                                           onDecided('emergency_purchase') -> applyDecision below)
//   authorised -> markPurchased (what was really paid, how, the M-Pesa code)  -> purchased
//   purchased  -> receive (what arrived; stock goes up at the branch at the real cost, 'emergency_receipt') -> received -> under_review?
//   received | under_review -> review (the owner marks it reviewed, optional clawback note) -> closed
//   draft | pending_approval | authorised -> cancel
//
// Every function takes (db, scope, ...). `db` is a transaction for writes (routes open it); `scope` is permissions.inventoryScope(); `now` is injectable
// for tests (Nairobi day and week windows, document numbers). Services re-check capabilities synchronously; the routes authorize first so a refusal
// is audited outside the transaction. Money is exact (decimal.js), 2 dp strings; quantities are kept as typed AND in base units, like purchase orders.
//
// Rules decided here (also listed in the P2-11 report):
//  * Estimates must be above zero on every line, so a "free" estimate can't slip under a limit.
//  * Receiving more than was authorised is allowed up to the over_delivery_tolerance_pct setting (5 %), never beyond (the extra needs its own
//    purchase). Receiving less is fine. You pay for what you take: the line cost is the real price x what arrived, and the stock cost per base unit
//    is that total / what arrived.
//  * Goes to the owner for review (status under_review + a notification) when: no invoice (always), the real total is more than
//    emergency_over_estimate_alert_pct (10 %) above what was authorised, or a line came in short by more than the delivery tolerance.
//    Everything else stays at 'received' (migration 017 does not allow 'closed' without a reviewer; the owner may still close it).
//  * No invoice: reason + payment reference + at least one photo of the goods (D2-9). The photo rule is checked here with a plain message first;
//    the database trigger is the safety net.
//  * An M-Pesa code is 10 capital letters and digits, and one code can pay for only one purchase.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { QTY, COST, MONEY, dec, add, sub, mul, div, cmp, isZero, isNeg } from './decimal.js';
import { normaliseUnit, toBase } from './units.js';
import { loadUnits } from './catalogue.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { getSettings } from './policies.js';
import { diff, record } from './audit.js';
import { notify } from './notifications.js';
import * as approvals from './approvals.js';
import * as ledger from './ledger.js';
import * as attachments from './attachments.js';
import { nextNumber } from './numbers.js';
import { createOnTheSpot } from './suppliers.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const STATUSES = Object.freeze(['draft', 'pending_approval', 'authorised', 'purchased', 'received', 'under_review', 'closed', 'rejected', 'cancelled']);
export const INVOICE_STATUSES = Object.freeze(['etims', 'other', 'none']);
export const PAYMENT_METHODS = Object.freeze(['cash', 'mpesa', 'supplier_credit']);
const MPESA_CODE = /^[A-Z][A-Z0-9]{9}$/;
const MAX_LINES = 50;
const GROUPS = Object.freeze({
  open: ['draft', 'pending_approval', 'authorised', 'purchased'],
  needs_review: ['under_review'],
  done: ['received', 'closed'],
  finished: ['received', 'under_review', 'closed', 'rejected', 'cancelled'],
});
const DAY_MS = 86_400_000;

/* ---------- small helpers ---------- */

const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const has = (obj, key) => obj && typeof obj === 'object' && Object.hasOwn(obj, key);
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const lc = (id) => (id ? String(id).toLowerCase() : null);
const trimZeros = (text) => (String(text).includes('.') ? String(text).replace(/0+$/, '').replace(/\.$/, '') : String(text));
const money = (v) => (v === null || v === undefined ? null : dec(v).toString(MONEY));
const group = (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const kes = (v) => { const [int, frac] = dec(v, { scale: MONEY, round: 'half-up' }).toString(MONEY).split('.'); return `KES ${group(int)}${frac === '00' ? '' : `.${frac}`}`; };
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};
function readText(value, max, label, { required = false, requiredMessage = null } = {}) {
  if (empty(value)) {
    if (required) throw fail(400, requiredMessage || `Enter ${label}.`, 'text_required');
    return null;
  }
  const text = tidy(value);
  if (text.length > max) throw fail(400, `Keep ${label} under ${max} characters.`, 'text_too_long');
  return text;
}
const pctOver = (actual, authorised) => (isZero(authorised) ? null : Number(div(mul(sub(actual, authorised), 100, 6), authorised, 1).toString(1)));

/* ---------- loading ---------- */

const ROW_SQL = `select e.*, coalesce(r.name, l.name) as location_name, pr.name as requested_by_name, s.incomplete as supplier_incomplete
  from public.emergency_purchases e
  left join public.stock_locations l on l.id = e.location_id left join public.restaurants r on r.id = l.restaurant_id
  left join public.profiles pr on pr.id = e.requested_by left join public.suppliers s on s.id = e.supplier_id`;

async function loadRow(db, scope, id, { lock = false } = {}) {
  const rid = needId(id, 'The purchase');
  const row = (await db.query(`${ROW_SQL} where e.id = $1 and e.business_id = $2 ${lock ? 'for update of e' : ''}`, [rid, scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That emergency purchase doesn’t exist.', 'emergency_not_found');
  return row;
}

/** The branch an emergency purchase belongs to (404 when it isn't in this business). Routes use it to authorize before opening a transaction. */
export async function locationOf(db, businessId, id) {
  const row = (await db.query('select location_id, status from public.emergency_purchases where id = $1 and business_id = $2', [needId(id, 'The purchase'), businessId])).rows[0];
  if (!row) throw fail(404, 'That emergency purchase doesn’t exist.', 'emergency_not_found');
  return { locationId: row.location_id, status: row.status };
}

const LINE_SQL = `select l.id, l.position, l.item_id, i.name as item_name, i.category_id, l.entered_qty::text as entered_qty, l.entered_unit, l.unit_factor::text as unit_factor,
  l.qty_base::text as qty_base, l.est_unit_price::text as est_unit_price, l.est_total::text as est_total, l.actual_unit_price::text as actual_unit_price,
  l.actual_total::text as actual_total, l.received_base::text as received_base, l.movement_id::text as movement_id
  from public.emergency_purchase_lines l join public.stock_items i on i.id = l.item_id and i.business_id = l.business_id`;

const loadLines = async (db, id, { lock = false } = {}) => (await db.query(`${LINE_SQL} where l.emergency_id = $1 order by l.position ${lock ? 'for update of l' : ''}`, [id])).rows;

const lineView = (l) => ({
  id: l.id, position: l.position, itemId: l.item_id, itemName: l.item_name, qty: trimZeros(l.entered_qty), unit: l.entered_unit, qtyBase: trimZeros(l.qty_base),
  estimatedUnitPrice: money(l.est_unit_price), estimatedTotal: money(l.est_total), actualUnitPrice: money(l.actual_unit_price), actualTotal: money(l.actual_total),
  received: l.received_base === null ? null : { qtyBase: trimZeros(l.received_base), qty: trimZeros(div(l.received_base, l.unit_factor, 4).toString(4)), unit: l.entered_unit },
  movementId: l.movement_id,
});

const view = (e) => ({
  id: e.id, number: e.number, status: e.status, locationId: e.location_id, locationName: e.location_name || null,
  requestedBy: e.requested_by, requestedByName: e.requested_by_name || null,
  supplierId: e.supplier_id, supplierName: e.supplier_name, supplierIncomplete: Boolean(e.supplier_incomplete),
  reason: e.reason, estimatedTotal: money(e.estimated_total), approvedTotal: money(e.approved_total), actualTotal: money(e.actual_total),
  paymentMethod: e.payment_method, paymentReference: e.payment_reference, invoiceStatus: e.invoice_status, invoiceNo: e.invoice_no, noInvoiceReason: e.no_invoice_reason,
  approvalId: e.approval_id, autoAuthorised: e.auto_authorised, reviewedBy: e.reviewed_by, reviewedAt: e.reviewed_at, reviewNote: e.review_note, clawbackNote: e.clawback_note,
  submittedAt: e.submitted_at, authorisedAt: e.authorised_at, purchasedAt: e.purchased_at, receivedAt: e.received_at, closedAt: e.closed_at, cancelledAt: e.cancelled_at, createdAt: e.created_at,
});

const canSee = (scope, locationId) => can(scope, 'inv.view', { locationId });
function requireSee(scope, row) {
  if (!canSee(scope, row.location_id)) throw fail(403, 'You don’t have access to this.', 'forbidden');
}
const requireOwnerOfPurchase = (scope, row) => requireCan(scope, 'inv.emergency.create', { locationId: row.location_id });

async function itemInfo(db, businessId, itemId) {
  const row = (await db.query('select id, name, unit, display_unit, category_id, archived_at from public.stock_items where id = $1 and business_id = $2', [itemId, businessId])).rows[0];
  if (!row) throw fail(404, 'That stock item isn’t in this business. Pick it from the items list.', 'item_not_found');
  const own = (await db.query('select name, factor::text as factor from public.stock_item_units where item_id = $1 order by position, name', [itemId])).rows;
  return { id: row.id, name: row.name, baseUnit: row.unit, displayUnit: row.display_unit || undefined, categoryId: row.category_id, archived: row.archived_at !== null,
    units: own.map((u) => ({ name: u.name, factor: u.factor })) };
}

/* ---------- lines ---------- */

/** Input [{ itemId, qty, unit?, price }] -> priced, converted lines. The estimate must be above zero (see the header). */
async function buildLines(db, scope, input) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'Add at least one item to buy.', 'lines_required');
  if (input.length > MAX_LINES) throw fail(400, `An emergency purchase can have at most ${MAX_LINES} items. Split it in two.`, 'too_many_lines');
  const units = await loadUnits(db);
  const seen = new Set();
  const out = [];
  for (const [index, entry] of input.entries()) {
    if (!entry || typeof entry !== 'object') throw fail(400, `Line ${index + 1} is not valid.`, 'bad_line');
    const itemId = needId(entry.itemId, `The item on line ${index + 1}`);
    if (seen.has(itemId)) throw fail(400, 'An item is listed twice. Combine the amounts into one line.', 'duplicate_item');
    seen.add(itemId);
    const item = await itemInfo(db, scope.businessId, itemId);
    if (item.archived) throw fail(409, `${item.name} is archived, so it can’t be bought. Ask the owner to restore it.`, 'item_archived');
    const code = normaliseUnit(String(empty(entry.unit) ? (item.displayUnit || item.baseUnit) : entry.unit), item, units);
    if (!code) toBase('1', String(entry.unit), item, units);   // throws the plain "isn't a unit Cravio knows" message
    const factor = toBase('1', code, item, units);
    if (empty(entry.qty ?? entry.quantity)) throw fail(400, `${item.name}: enter how much to buy.`, 'qty_required');
    const qty = dec(entry.qty ?? entry.quantity, { label: `Quantity of ${item.name}` });
    if (isZero(qty) || isNeg(qty)) throw fail(400, `${item.name}: the amount must be more than zero.`, 'qty_not_positive');
    const qtyBase = toBase(qty.toString(), code, item, units, { positive: true, label: `Quantity of ${item.name}` });
    if (empty(entry.price ?? entry.estimatedPrice)) throw fail(400, `${item.name}: enter your best estimate of the price per ${code}. The owner needs an amount to check against the limits.`, 'price_required');
    const price = dec(entry.price ?? entry.estimatedPrice, { scale: MONEY, round: 'exact', label: `The price of ${item.name}` });
    if (isNeg(price) || isZero(price)) throw fail(400, `${item.name}: the estimated price must be more than zero.`, 'price_required');
    out.push({ position: index, item, itemId, enteredQty: qty.toString(QTY), enteredUnit: code, unitFactor: factor, qtyBase, estUnitPrice: price.toString(MONEY),
      estTotal: mul(qty, price, MONEY).toString(MONEY) });
  }
  return out;
}

const sumTotals = (lines, key) => lines.reduce((a, l) => add(a, l[key] ?? 0), dec(0));

async function insertLines(db, scope, emergencyId, lines) {
  for (const l of lines) {
    await db.query(`insert into public.emergency_purchase_lines (business_id, emergency_id, position, item_id, entered_qty, entered_unit, unit_factor, qty_base, est_unit_price, est_total)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [scope.businessId, emergencyId, l.position, l.itemId, l.enteredQty, l.enteredUnit, l.unitFactor, l.qtyBase, l.estUnitPrice, l.estTotal]);
  }
}
const lineAudit = (lines) => lines.map((l) => ({ itemId: l.itemId, qty: trimZeros(l.enteredQty), unit: l.enteredUnit, estimatedPrice: l.estUnitPrice }));

/** Matches [{ lineId | itemId, ... }] to the purchase's lines. Returns Map(line id -> entry). */
function matchLines(lines, input, what) {
  const found = new Map();
  for (const entry of Array.isArray(input) ? input : []) {
    const line = lines.find((l) => (entry?.lineId && lc(entry.lineId) === l.id) || (!entry?.lineId && entry?.itemId && lc(entry.itemId) === l.item_id));
    if (!line) throw fail(400, `One of the ${what} isn’t on this purchase. Use the items from the list.`, 'bad_line');
    if (found.has(line.id)) throw fail(400, `${line.item_name} appears twice. Send it once.`, 'duplicate_item');
    found.set(line.id, entry);
  }
  return found;
}

/* ---------- supplier, payment, invoice ---------- */

async function resolveSupplier(db, scope, locationId, body) {
  if (!empty(body.supplierId)) {
    const id = needId(body.supplierId, 'The supplier');
    const s = (await db.query('select id, name, status from public.suppliers where id = $1 and business_id = $2', [id, scope.businessId])).rows[0];
    if (!s) throw fail(404, 'That supplier isn’t in this business. Pick one from the list, or add the shop or trader you used.', 'supplier_not_found');
    if (s.status !== 'active') throw fail(409, `${s.name} isn’t an active supplier. Pick another, or add the trader you used.`, 'supplier_inactive');
    return { id: s.id, name: s.name };
  }
  if (body.newSupplier && typeof body.newSupplier === 'object') {
    const { supplier } = await createOnTheSpot(db, scope, locationId, body.newSupplier);
    return { id: supplier.id, name: supplier.name };
  }
  throw fail(400, 'Say who you are buying from: pick a supplier, or add the shop or trader with their name and phone number.', 'supplier_required');
}

function readReference(method, value, { required = false } = {}) {
  if (empty(value)) {
    if (required) throw fail(400, method === 'mpesa' ? 'Enter the M-Pesa code from the confirmation message (10 letters and numbers).' : 'Enter the payment reference.', 'reference_required');
    return null;
  }
  let ref = tidy(value);
  if (method === 'mpesa') {
    ref = ref.replace(/\s+/g, '').toUpperCase();
    if (!MPESA_CODE.test(ref)) throw fail(400, 'That doesn’t look like an M-Pesa code. A code has 10 capital letters and numbers, like SHK7Q2X9LM. Check it against the M-Pesa message.', 'bad_mpesa_code');
  }
  if (ref.length > 60) throw fail(400, 'Keep the payment reference under 60 characters.', 'text_too_long');
  return ref;
}

/** One M-Pesa code pays for one purchase. */
async function assertCodeUnused(db, scope, row, code) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`emergency-code:${scope.businessId}:${code}`]);
  const other = (await db.query(`select number from public.emergency_purchases where business_id = $1 and payment_method = 'mpesa' and payment_reference = $2 and id <> $3 limit 1`,
    [scope.businessId, code, row.id])).rows[0];
  if (other) throw fail(409, `That M-Pesa code was already used for ${other.number}. Each code can pay for one purchase only. Check the code.`, 'duplicate_payment_reference');
}

/** The invoice fields after applying the body to what is stored. */
function readInvoice(body, current) {
  const out = { status: current.invoice_status, no: current.invoice_no, reason: current.no_invoice_reason };
  if (has(body, 'invoiceStatus')) {
    if (empty(body.invoiceStatus)) out.status = null;
    else if (!INVOICE_STATUSES.includes(body.invoiceStatus)) throw fail(400, 'Say what kind of invoice you got: an eTIMS invoice, another receipt, or none.', 'bad_invoice_status');
    else out.status = body.invoiceStatus;
  }
  if (has(body, 'invoiceNo')) out.no = readText(body.invoiceNo, 60, 'the invoice number');
  if (has(body, 'noInvoiceReason')) out.reason = readText(body.noInvoiceReason, 300, 'the reason');
  if (out.status === 'none') out.no = null;
  if (out.status === 'etims' || out.status === 'other') out.reason = null;
  return out;
}

const hasPhoto = async (db, scope, id) => Boolean((await db.query(`select 1 from public.attachments where business_id = $1 and entity_type = 'emergency' and entity_id = $2
  and deleted_at is null and mime like 'image/%' limit 1`, [scope.businessId, id])).rows[0]);

/** A plain sentence about what is missing for the chosen invoice status, or null. */
async function invoiceProblem(db, scope, row, inv, reference, { final }) {
  if (inv.status === 'none') {
    if (!inv.reason) return 'With no invoice you must say why (for example “market trader, no receipts”).';
    if (!reference) return 'With no invoice you must enter the payment reference: the M-Pesa code, or the number on the cash receipt.';
    if (final && !(await hasPhoto(db, scope, row.id))) return 'With no invoice you must take a photo of the goods (or the shop’s slip) first. Attach it to this purchase, then receive the goods.';
  }
  if (final) {
    if (!inv.status) return 'Say whether you got an invoice: an eTIMS invoice, another receipt, or none.';
    if ((inv.status === 'etims' || inv.status === 'other') && !inv.no) return inv.status === 'etims' ? 'Enter the eTIMS invoice number printed on the receipt.' : 'Enter the number on the invoice or receipt.';
  }
  return null;
}

/* ---------- create, edit ---------- */

/**
 * New draft. body: { locationId (a branch), reason, supplierId | newSupplier: { name, phone, kraPin? }, lines: [{ itemId, qty, unit?, price }] }.
 * The price is the estimate per ONE entered unit. A new supplier is saved as incomplete for the owner to finish (EMP-4).
 */
export async function create(db, scope, body = {}, { now = new Date() } = {}) {
  const locationId = lc(body.locationId);
  const branch = scope.locations.find((l) => l.id === locationId && l.kind === 'branch');
  if (!branch) throw fail(400, 'Say which branch is buying. Emergency purchases are made for a branch, not the warehouse.', 'location_required');
  requireCan(scope, 'inv.emergency.create', { locationId });
  const reason = readText(body.reason, 300, 'the reason', { required: true, requiredMessage: 'Say why this couldn’t wait for a normal order (for example “chicken ran out, 30 covers booked”).' });
  const supplier = await resolveSupplier(db, scope, locationId, body);
  const lines = await buildLines(db, scope, body.lines);
  const number = await nextNumber(db, { businessId: scope.businessId, kind: 'EP', now });
  const total = sumTotals(lines, 'estTotal').toString(MONEY);
  const row = (await db.query(`insert into public.emergency_purchases (business_id, number, location_id, requested_by, supplier_id, supplier_name, reason, estimated_total)
    values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [scope.businessId, number, locationId, scope.userId, supplier.id, supplier.name, reason, total])).rows[0];
  await insertLines(db, scope, row.id, lines);
  await record(db, { businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id, action: 'create',
    before: null, after: { number, supplierId: supplier.id, reason, estimatedTotal: total, lines: lineAudit(lines) } });
  return get(db, scope, row.id);
}

/** Edits a DRAFT (reason, supplier, lines). Once it is submitted it can't change: cancel it and start again. */
export async function update(db, scope, id, body = {}) {
  const row = await loadRow(db, scope, id, { lock: true });
  requireOwnerOfPurchase(scope, row);
  if (row.status !== 'draft') throw fail(409, 'This purchase was already sent. Cancel it and start a new one if something is wrong.', 'not_draft');
  const before = { reason: row.reason, supplierId: row.supplier_id, estimatedTotal: money(row.estimated_total) };
  const patch = {};
  if (has(body, 'reason')) patch.reason = readText(body.reason, 300, 'the reason', { required: true, requiredMessage: 'Say why this couldn’t wait for a normal order.' });
  if (has(body, 'supplierId') || has(body, 'newSupplier')) {
    const s = await resolveSupplier(db, scope, row.location_id, body);
    patch.supplier_id = s.id;
    patch.supplier_name = s.name;
  }
  let lines = null;
  if (has(body, 'lines')) {
    lines = await buildLines(db, scope, body.lines);
    await db.query('delete from public.emergency_purchase_lines where emergency_id = $1', [row.id]);
    await insertLines(db, scope, row.id, lines);
    patch.estimated_total = sumTotals(lines, 'estTotal').toString(MONEY);
  }
  const keys = Object.keys(patch);
  if (keys.length) {
    await db.query(`update public.emergency_purchases set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where id = $1 and business_id = $2`, [row.id, scope.businessId, ...keys.map((k) => patch[k])]);
  }
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id, action: 'update',
    before, after: { reason: patch.reason ?? row.reason, supplierId: patch.supplier_id ?? row.supplier_id, estimatedTotal: patch.estimated_total ?? before.estimatedTotal, ...(lines ? { lines: lineAudit(lines) } : {}) } });
  return get(db, scope, row.id);
}

/* ---------- submit: the rules decide ---------- */

/**
 * Sends the purchase on. The approval rules for this branch are checked for the estimated total (and its categories) inside this transaction, under the
 * engine's per-branch lock, so two quick buys can't both slip under the daily or weekly limit:
 *   below every limit  -> authorised straight away (auto_authorised), the answer says how much is left ("KES 3,500 left today");
 *   otherwise, or no limit set at all (D2-16) -> pending_approval and the approvers are told once.
 * Sending an already-sent purchase just returns it (replayed: true).
 */
export async function submit(db, scope, id, { now = new Date() } = {}) {
  const row = await loadRow(db, scope, id, { lock: true });
  requireOwnerOfPurchase(scope, row);
  if (row.status === 'pending_approval' || row.status === 'authorised') return { ...(await get(db, scope, row.id)), replayed: true };
  if (row.status !== 'draft') throw fail(409, `This purchase is ${row.status.replace(/_/g, ' ')}, so it can’t be sent.`, 'not_draft');
  const lines = await loadLines(db, row.id);
  if (!lines.length) throw fail(400, 'Add at least one item before sending it.', 'lines_required');
  const evaluation = await approvals.evaluate(db, { businessId: scope.businessId, subject: 'emergency_purchase', locationId: row.location_id, amountKes: money(row.estimated_total),
    lines: lines.map((l) => ({ categoryId: l.category_id, amountKes: l.est_total })), at: now, excludeSubjectId: row.id });
  let result = { needsApproval: evaluation.needsApproval, reasons: evaluation.reasons, safeDefault: evaluation.safeDefault };
  if (!evaluation.needsApproval) {
    await db.query(`update public.emergency_purchases set status = 'authorised', submitted_at = $2, authorised_at = $2, approved_total = estimated_total, auto_authorised = true where id = $1`, [row.id, now]);
    await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id, action: 'auto_authorise',
      before: { status: 'draft' }, after: { status: 'authorised', amount: money(row.estimated_total), usage: evaluation.usage } });
    const left = await approvals.limits(db, { businessId: scope.businessId, locationId: row.location_id, at: now });
    result = { ...result, limits: { message: left.message, leftTodayKes: left.leftTodayKes ?? null, leftWeekKes: left.leftWeekKes ?? null } };
  } else {
    await db.query(`update public.emergency_purchases set status = 'pending_approval', submitted_at = $2 where id = $1`, [row.id, now]);
    const approval = await approvals.request(db, { businessId: scope.businessId, subject: 'emergency_purchase', subjectId: row.id, locationId: row.location_id,
      requestedBy: scope.userId, requestedByRole: scope.role, amountKes: money(row.estimated_total), evaluation, at: now });
    await db.query('update public.emergency_purchases set approval_id = $2 where id = $1', [row.id, approval.id]);
    await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id, action: 'submit',
      before: { status: 'draft' }, after: { status: 'pending_approval', approvalId: approval.id, reasons: evaluation.reasons, safeDefault: evaluation.safeDefault } });
  }
  return { ...(await get(db, scope, row.id)), evaluation: result, replayed: false };
}

/**
 * The approvals engine calls this inside decide()'s transaction. Approved -> authorised (the estimate becomes the authorised amount and counts toward
 * the day and week totals from now); rejected -> rejected (final: the branch makes a new request). Anything else (withdrawn meanwhile) is left alone.
 */
export async function applyDecision(db, approval, { scope }) {
  const row = (await db.query('select * from public.emergency_purchases where id = $1 and business_id = $2 for update', [approval.subjectId, approval.businessId])).rows[0];
  if (!row || row.status !== 'pending_approval') return null;
  const at = approval.decidedAt ? new Date(approval.decidedAt) : new Date();
  if (approval.status === 'approved') {
    await db.query(`update public.emergency_purchases set status = 'authorised', authorised_at = $2, approved_total = estimated_total, auto_authorised = false where id = $1`, [row.id, at]);
    await record(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id,
      action: approval.selfApproved ? 'authorise_self' : 'authorise', before: { status: 'pending_approval' }, after: { status: 'authorised', approvalId: approval.id, amount: money(row.estimated_total), selfApproved: approval.selfApproved } });
  } else if (approval.status === 'rejected') {
    await db.query(`update public.emergency_purchases set status = 'rejected' where id = $1`, [row.id]);
    await record(db, { businessId: row.business_id, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id,
      action: 'reject', before: { status: 'pending_approval' }, after: { status: 'rejected', note: approval.decisionNote } });
  }
  return row.id;
}
let unregister = null;
/** Registers the callback once per process (tests that clear the engine's handlers can call it again after unregistering). */
export function ensureEmergencyApprovals() {
  if (!unregister) unregister = approvals.onDecided('emergency_purchase', applyDecision);
  return unregister;
}
/** For tests: forget the registration so ensureEmergencyApprovals() adds it back. */
export function resetEmergencyApprovals() { unregister = null; }
ensureEmergencyApprovals();

/* ---------- purchased ---------- */

/**
 * The shopping is done: what was paid, how. body: { paymentMethod: cash | mpesa | supplier_credit, paymentReference, prices: [{ lineId | itemId, price }]
 * (the real price per ONE entered unit; every line), invoiceStatus?, invoiceNo?, noInvoiceReason? }.
 * An M-Pesa payment needs its code (10 letters and numbers). The invoice can be given now or when the goods are received.
 */
export async function markPurchased(db, scope, id, body = {}, { now = new Date() } = {}) {
  const row = await loadRow(db, scope, id, { lock: true });
  requireOwnerOfPurchase(scope, row);
  if (row.status === 'pending_approval') throw fail(409, 'This purchase is still waiting for the owner’s approval. You can record the shopping once it is approved.', 'not_authorised');
  if (row.status === 'draft') throw fail(409, 'Send this purchase for approval first. Nothing can be recorded on a draft.', 'not_authorised');
  if (row.status === 'rejected' || row.status === 'cancelled') throw fail(409, `This purchase was ${row.status}, so nothing can be recorded on it.`, 'not_authorised');
  if (row.status !== 'authorised') throw fail(409, 'The shopping on this purchase was already recorded.', 'already_purchased');
  const method = body.paymentMethod;
  if (!PAYMENT_METHODS.includes(method)) throw fail(400, 'Say how you paid: cash, M-Pesa or on credit with the supplier.', 'bad_payment_method');
  const reference = readReference(method, body.paymentReference, { required: method === 'mpesa' });
  if (method === 'mpesa') await assertCodeUnused(db, scope, row, reference);
  const inv = readInvoice(body, row);
  const problem = await invoiceProblem(db, scope, row, inv, reference, { final: false });
  if (problem) throw fail(400, problem, 'invoice_incomplete');

  const lines = await loadLines(db, row.id, { lock: true });
  const given = matchLines(lines, body.prices, 'prices');
  const priced = [];
  for (const l of lines) {
    const entry = given.get(l.id);
    if (!entry || empty(entry.price ?? entry.actualUnitPrice)) throw fail(400, `Enter the price you paid for ${l.item_name} (per ${l.entered_unit}).`, 'price_required');
    const price = dec(entry.price ?? entry.actualUnitPrice, { scale: MONEY, round: 'exact', label: `The price of ${l.item_name}` });
    if (isNeg(price) || isZero(price)) throw fail(400, `The price of ${l.item_name} must be more than zero.`, 'price_required');
    priced.push({ line: l, price: price.toString(MONEY), total: mul(l.entered_qty, price, MONEY).toString(MONEY) });
  }
  for (const p of priced) {
    await db.query('update public.emergency_purchase_lines set actual_unit_price = $2, actual_total = $3 where id = $1', [p.line.id, p.price, p.total]);
  }
  const total = priced.reduce((a, p) => add(a, p.total), dec(0)).toString(MONEY);
  await db.query(`update public.emergency_purchases set status = 'purchased', purchased_at = $2, payment_method = $3, payment_reference = $4, actual_total = $5,
    invoice_status = $6, invoice_no = $7, no_invoice_reason = $8 where id = $1`, [row.id, now, method, reference, total, inv.status, inv.no, inv.reason]);
  const over = row.approved_total === null ? null : pctOver(total, row.approved_total);
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id, action: 'purchase',
    before: { status: 'authorised' }, after: { status: 'purchased', actualTotal: total, paymentMethod: method, paymentReference: reference, invoiceStatus: inv.status, overAuthorisedPct: over } });
  const warnings = [];
  const alertPct = (await getSettings(db, scope.businessId, row.location_id)).emergency_over_estimate_alert_pct;
  if (over !== null && over > alertPct) warnings.push(`You spent ${kes(total)}, which is ${over}% more than the ${kes(row.approved_total)} that was authorised. The owner will be able to see that.`);
  return { ...(await get(db, scope, row.id)), warnings };
}

/* ---------- receive ---------- */

/**
 * The goods are here. body: { lines?: [{ lineId | itemId, qty, unit? }] (what really arrived; leave out to receive everything as authorised),
 * invoiceStatus, invoiceNo?, noInvoiceReason?, paymentReference? }. Stock goes up at the branch (ledger reason emergency_receipt) at the real cost.
 * See the header for the over-delivery, cost and review rules. Returns the purchase plus { stock: what changed, flags: why it needs the owner }.
 */
export async function receive(db, scope, id, body = {}, { now = new Date() } = {}) {
  const row = await loadRow(db, scope, id, { lock: true });
  requireOwnerOfPurchase(scope, row);
  if (row.status === 'pending_approval' || row.status === 'draft') throw fail(409, 'This purchase isn’t approved yet, so there is nothing to receive.', 'not_authorised');
  if (row.status === 'authorised') throw fail(409, 'Record what you paid first (the shopping step), then receive the goods.', 'not_purchased');
  if (['received', 'under_review', 'closed'].includes(row.status)) throw fail(409, 'These goods were already received.', 'already_received');
  if (row.status !== 'purchased') throw fail(409, `This purchase was ${row.status}, so it can’t be received.`, 'not_authorised');

  const settings = await getSettings(db, scope.businessId, row.location_id);
  const tolerance = settings.over_delivery_tolerance_pct;
  const lines = await loadLines(db, row.id, { lock: true });
  const typed = matchLines(lines, body.lines, 'lines');
  const units = await loadUnits(db);

  // 1. What arrived, line by line.
  const plan = [];
  for (const l of lines) {
    const item = await itemInfo(db, scope.businessId, l.item_id);
    const entry = typed.get(l.id);
    let qtyBase = l.qty_base; let enteredQty = l.entered_qty; let enteredUnit = l.entered_unit;
    if (entry) {
      if (empty(entry.qty ?? entry.quantity)) throw fail(400, `${l.item_name}: enter how much arrived (0 if none).`, 'qty_required');
      const q = dec(entry.qty ?? entry.quantity, { label: `Quantity of ${l.item_name}` });
      if (isNeg(q)) throw fail(400, `${l.item_name}: the amount can’t be negative.`, 'qty_not_positive');
      const code = empty(entry.unit) ? l.entered_unit : normaliseUnit(String(entry.unit), item, units);
      if (!code) toBase('1', String(entry.unit), item, units);
      qtyBase = toBase(q.toString(), code, item, units, { label: `Quantity of ${l.item_name}` });
      enteredQty = q.toString(); enteredUnit = code;
    }
    const cap = mul(l.qty_base, add(1, div(String(tolerance), 100, 6)), 4);
    if (cmp(qtyBase, cap) > 0) {
      throw fail(400, `${l.item_name}: you can receive at most ${trimZeros(div(cap, l.unit_factor, 4).toString(4))} ${l.entered_unit}, which is what was authorised plus a ${tolerance}% allowance. For the extra, make a new emergency purchase.`, 'over_received');
    }
    const lineTotal = cmp(qtyBase, l.qty_base) === 0 ? dec(l.actual_total) : mul(div(qtyBase, l.unit_factor, 12), l.actual_unit_price, MONEY);
    plan.push({ line: l, item, qtyBase, enteredQty, enteredUnit, lineTotal: lineTotal.toString(MONEY) });
  }

  // 2. The invoice and payment rules.
  const method = row.payment_method;
  const reference = has(body, 'paymentReference') && !empty(body.paymentReference) ? readReference(method, body.paymentReference) : row.payment_reference;
  if (reference && reference !== row.payment_reference && method === 'mpesa') await assertCodeUnused(db, scope, row, reference);
  const inv = readInvoice(body, row);
  const problem = await invoiceProblem(db, scope, row, inv, reference, { final: true });
  if (problem) throw fail(400, problem, 'invoice_incomplete');

  // 3. Stock in, at the real cost.
  const entries = [];
  for (const p of plan.filter((x) => !isZero(x.qtyBase))) {
    entries.push({ plan: p, input: { businessId: scope.businessId, locationId: row.location_id, itemId: p.line.item_id, qty: p.qtyBase, reason: 'emergency_receipt',
      unitCost: div(p.lineTotal, p.qtyBase, COST).toString(COST), ref: { type: 'emergency', id: row.id }, actorId: scope.userId, occurredAt: now,
      note: `Emergency purchase ${row.number}`, idempotencyKey: `emergency:${row.id}:${p.line.id}`, entered: { quantity: p.enteredQty, unit: p.enteredUnit } } });
  }
  const posted = await ledger.postMany(db, entries.map((e) => e.input));
  const stock = [];
  for (const [i, e] of entries.entries()) {
    e.plan.movementId = posted[i].movement.id;
    stock.push({ itemId: e.plan.line.item_id, itemName: e.plan.line.item_name, added: `${trimZeros(e.plan.enteredQty)} ${e.plan.enteredUnit}`, unitCost: e.input.unitCost,
      onHand: posted[i].balance.onHand });
  }
  for (const p of plan) {
    await db.query('update public.emergency_purchase_lines set received_base = $2, actual_total = $3, movement_id = $4 where id = $1', [p.line.id, p.qtyBase, p.lineTotal, p.movementId ?? null]);
  }
  const total = plan.reduce((a, p) => add(a, p.lineTotal), dec(0)).toString(MONEY);
  await db.query(`update public.emergency_purchases set status = 'received', received_at = $2, actual_total = $3, payment_reference = $4, invoice_status = $5, invoice_no = $6, no_invoice_reason = $7
    where id = $1`, [row.id, now, total, reference, inv.status, inv.no, inv.reason]);

  // 4. Does the owner need to look at it?
  const flags = [];
  if (inv.status === 'none') flags.push(`No invoice: ${inv.reason}`);
  const over = row.approved_total === null ? null : pctOver(total, row.approved_total);
  if (over !== null && over > settings.emergency_over_estimate_alert_pct) flags.push(`Cost ${kes(total)}, which is ${over}% more than the ${kes(row.approved_total)} authorised.`);
  const short = plan.filter((p) => cmp(p.qtyBase, mul(p.line.qty_base, sub(1, div(String(tolerance), 100, 6)), 4)) < 0);
  if (plan.every((p) => isZero(p.qtyBase))) flags.push('Nothing arrived.');
  else if (short.length) flags.push(`Came in short: ${short.map((p) => `${p.line.item_name} ${trimZeros(div(p.qtyBase, p.line.unit_factor, 4).toString(4))} of ${trimZeros(p.line.entered_qty)} ${p.line.entered_unit}`).join(', ')}.`);
  let status = 'received';
  if (flags.length) {
    status = 'under_review';
    await db.query('update public.emergency_purchases set status = $2, review_note = $3 where id = $1', [row.id, status, flags.join(' ').slice(0, 500)]);
    await notify(db, { businessId: scope.businessId, recipients: 'owners', exclude: [scope.userId], kind: 'emergency_review', title: `Emergency purchase ${row.number} needs your review`,
      body: `${row.location_name}: ${flags.join(' ')}`.slice(0, 1000), link: `/owner/inventory/emergency/${row.id}`, entity: { type: 'emergency_purchase', id: row.id }, locationId: row.location_id, dedupeKey: `emergency_review:${row.id}` });
  }
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id, action: 'receive',
    before: { status: 'purchased' }, after: { status, actualTotal: total, invoiceStatus: inv.status, invoiceNo: inv.no, flags,
      lines: plan.map((p) => ({ itemId: p.line.item_id, receivedBase: p.qtyBase, authorisedBase: p.line.qty_base, total: p.lineTotal })) } });

  // 5. EMP-7: the same item again and again means the par level is too low.
  const repeats = [];
  for (const p of entries) repeats.push(...(await repeatAlert(db, scope, row, p.plan.item, settings, now)));
  return { ...(await get(db, scope, row.id)), stock, flags, repeatAlerts: repeats };
}

/** EMP-7: a notification to the owners when this branch has bought the item in an emergency N times within the window. Once per item per week. */
async function repeatAlert(db, scope, row, item, settings, now) {
  const need = settings.emergency_repeat_alert_count;
  const days = settings.emergency_repeat_alert_days;
  const since = new Date(now.getTime() - days * DAY_MS);
  const n = (await db.query(`select count(distinct e.id)::int as n from public.emergency_purchase_lines l
    join public.emergency_purchases e on e.id = l.emergency_id and e.business_id = l.business_id
    where e.business_id = $1 and e.location_id = $2 and l.item_id = $3 and l.received_base > 0 and e.received_at >= $4 and e.received_at <= $5
      and e.status in ('received', 'under_review', 'closed')`, [scope.businessId, row.location_id, item.id, since, now])).rows[0].n;
  if (n < need) return [];
  const week = approvals.windowsFor(now).weekStart.toISOString().slice(0, 10);
  const when = days === 7 ? 'this week' : `in the last ${days} days`;
  const message = `${row.location_name} bought ${item.name} in an emergency ${n} times ${when} — consider raising its par level.`;
  const sent = await notify(db, { businessId: scope.businessId, recipients: 'owners', kind: 'emergency_repeat', title: `${item.name} keeps running out at ${row.location_name}`, body: message,
    link: `/owner/inventory/items/${item.id}`, entity: { type: 'stock_item', id: item.id }, locationId: row.location_id, dedupeKey: `emergency_repeat:${row.location_id}:${item.id}:${week}` });
  return sent.delivered > 0 ? [{ itemId: item.id, count: n, message }] : [];
}

/* ---------- cancel ---------- */

/** Withdraws a purchase that has not been bought yet (draft, waiting for approval, or authorised). Withdraws its approval request too. */
export async function cancel(db, scope, id, { reason = null, now = new Date() } = {}) {
  const row = await loadRow(db, scope, id, { lock: true });
  requireOwnerOfPurchase(scope, row);
  if (row.status === 'cancelled') return { ...(await get(db, scope, row.id)), replayed: true };
  if (!['draft', 'pending_approval', 'authorised'].includes(row.status)) {
    throw fail(409, row.status === 'rejected' ? 'The owner already rejected this purchase.'
      : 'The shopping on this purchase is already recorded, so it can’t be cancelled. Receive the goods, or ask the owner.', 'cannot_cancel');
  }
  const text = readText(reason, 300, 'the reason');
  if (row.status === 'pending_approval') await approvals.cancel(db, scope, { subject: 'emergency_purchase', subjectId: row.id }, { note: text, at: now });
  await db.query(`update public.emergency_purchases set status = 'cancelled', cancelled_at = $2 where id = $1`, [row.id, now]);
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id, action: 'cancel',
    before: { status: row.status }, after: { status: 'cancelled', reason: text } });
  return { ...(await get(db, scope, row.id)), replayed: false };
}

/* ---------- owner review ---------- */

/**
 * The owner looks at a received purchase. body: { outcome: 'close' | 'flag', note, clawbackNote }.
 *   close: marks it reviewed and closes it (optional note; a clawback note says money to recover from whoever should repay it);
 *   flag:  moves a received purchase to under_review with a note (needed).
 * Needs inv.emergency.approve at the branch (the owner). Closing twice returns the closed purchase.
 */
export async function review(db, scope, id, body = {}, { now = new Date() } = {}) {
  const row = await loadRow(db, scope, id, { lock: true });
  requireCan(scope, 'inv.emergency.approve', { locationId: row.location_id });
  const outcome = body.outcome || 'close';
  if (!['close', 'flag'].includes(outcome)) throw fail(400, 'Choose close or flag.', 'bad_outcome');
  const note = readText(body.note, 500, 'the note');
  const clawback = readText(body.clawbackNote, 500, 'the clawback note');
  if (outcome === 'close') {
    if (row.status === 'closed') return { ...(await get(db, scope, row.id)), replayed: true };
    if (!['received', 'under_review'].includes(row.status)) throw fail(409, 'Only goods that were received can be reviewed. This purchase is ' + row.status.replace(/_/g, ' ') + '.', 'not_reviewable');
    await db.query(`update public.emergency_purchases set status = 'closed', reviewed_by = $2, reviewed_at = $3, closed_at = $3, review_note = coalesce($4, review_note), clawback_note = $5 where id = $1`,
      [row.id, scope.userId, now, note, clawback]);
    if (clawback && row.requested_by) {
      await notify(db, { businessId: scope.businessId, recipients: [row.requested_by], exclude: [scope.userId], kind: 'emergency_clawback', title: `The owner reviewed ${row.number}`,
        body: clawback, link: '/inventory/purchases', entity: { type: 'emergency_purchase', id: row.id }, locationId: row.location_id, dedupeKey: `emergency_clawback:${row.id}` });
    }
  } else {
    if (row.status === 'under_review') return { ...(await get(db, scope, row.id)), replayed: true };
    if (row.status !== 'received') throw fail(409, 'Only a purchase whose goods were received can be flagged for review.', 'not_reviewable');
    if (!note) throw fail(400, 'Say what looks wrong, so the review has something to follow up.', 'note_required');
    await db.query(`update public.emergency_purchases set status = 'under_review', review_note = $2 where id = $1`, [row.id, note]);
  }
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'emergency_purchase', entityId: row.id,
    action: outcome === 'close' ? 'review_close' : 'review_flag', before: { status: row.status, reviewNote: row.review_note },
    after: { status: outcome === 'close' ? 'closed' : 'under_review', note, clawbackNote: clawback } });
  return { ...(await get(db, scope, row.id)), replayed: false };
}

/* ---------- reading ---------- */

/** One purchase with its lines, approval history and evidence (signed 5-minute links when a `storage` is passed). */
export async function get(db, scope, id, { storage = null, restrictToLocationId = null } = {}) {
  const row = await loadRow(db, scope, id);
  requireSee(scope, row);
  if (restrictToLocationId && row.location_id !== restrictToLocationId) throw fail(403, 'You don’t have access to this branch.', 'branch_forbidden');
  const lines = (await loadLines(db, row.id)).map(lineView);
  const history = (await approvals.history(db, scope, { subject: 'emergency_purchase', subjectId: row.id })).approvals;
  const files = await attachments.list(db, scope, { entityType: 'emergency', entityId: row.id, restrictToLocationId });
  const evidence = [];
  for (const f of files) {
    if (storage) {
      const signed = await attachments.signedUrl(db, scope, f.id, { storage, restrictToLocationId });
      evidence.push({ ...f, url: signed.url, expiresAt: signed.expiresAt });
    } else evidence.push(f);
  }
  return { ...view(row), lines, approvals: history, evidence };
}

function parseDate(value, label) {
  if (empty(value)) return null;
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const d = m && new Date(`${text}T00:00:00+03:00`);
  if (!m || Number.isNaN(d.getTime())) throw fail(400, `${label} must be a date like 2026-11-18.`, 'bad_date');
  return d;
}

/**
 * Purchases the caller may see, newest first. Filters: locationId (a branch), status (one, a comma list, or open | needs_review | done | finished),
 * invoiceStatus (etims | other | none | missing), from / to (Nairobi dates, inclusive, on the day it was created), search (number, supplier, reason), limit (200 max).
 * Also returns `counts` per status for the same filters except status.
 */
export async function list(db, scope, { locationId = null, status = null, invoiceStatus = null, from = null, to = null, search = null, limit = 100, mineOnly = false } = {}) {
  const visible = locationsWith(scope, 'inv.view').filter((id) => scope.locations.some((l) => l.id === id && l.kind === 'branch'));
  let places = visible;
  if (!empty(locationId)) {
    const wanted = needId(locationId, 'The branch');
    if (!visible.includes(wanted)) throw fail(403, 'You don’t have access to this branch.', 'branch_forbidden');
    places = [wanted];
  }
  let statuses = null;
  if (!empty(status)) {
    statuses = String(status).split(',').flatMap((s) => GROUPS[s.trim()] || [s.trim()]);
    if (!statuses.every((s) => STATUSES.includes(s))) throw fail(400, 'That status isn’t one of: ' + STATUSES.join(', ') + '.', 'bad_status');
  }
  if (!empty(invoiceStatus) && ![...INVOICE_STATUSES, 'missing'].includes(invoiceStatus)) throw fail(400, 'Invoice must be eTIMS, other, none or missing.', 'bad_invoice_status');
  const start = parseDate(from, 'The start date');
  const endDay = parseDate(to, 'The end date');
  const end = endDay ? new Date(endDay.getTime() + DAY_MS) : null;
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  const term = empty(search) ? null : tidy(search).toLowerCase();
  const params = [scope.businessId, places, invoiceStatus || null, start, end, term, mineOnly ? scope.userId : null];
  const where = `e.business_id = $1 and e.location_id = any($2::uuid[]) and ($3::text is null or ($3 = 'missing' and e.invoice_status is null) or e.invoice_status = $3)
    and ($4::timestamptz is null or e.created_at >= $4) and ($5::timestamptz is null or e.created_at < $5)
    and ($6::text is null or position($6 in lower(e.number || ' ' || coalesce(e.supplier_name, '') || ' ' || e.reason)) > 0) and ($7::uuid is null or e.requested_by = $7)`;
  const rows = (await db.query(`${ROW_SQL} where ${where} and ($8::text[] is null or e.status = any($8::text[])) order by e.created_at desc, e.id desc limit $9`, [...params, statuses, size])).rows;
  const counts = {};
  for (const r of (await db.query(`select e.status, count(*)::int as n from public.emergency_purchases e where ${where} group by e.status`, params)).rows) counts[r.status] = r.n;
  return { purchases: rows.map(view), counts };
}

/**
 * What the branch form shows before anything is typed: the branch's limits and what is left today and this week, in plain words. With
 * amountKes it also says whether that amount would be authorised at once: preview { needsApproval, reasons }.
 */
export async function limitsFor(db, scope, locationId, { amountKes = null, now = new Date() } = {}) {
  const place = lc(locationId);
  requireCan(scope, 'inv.emergency.create', { locationId: place });
  const lim = await approvals.limits(db, { businessId: scope.businessId, locationId: place, at: now });
  const { rule, ...rest } = lim;
  void rule;
  let preview = null;
  if (!empty(amountKes)) {
    const e = await approvals.evaluate(db, { businessId: scope.businessId, subject: 'emergency_purchase', locationId: place, amountKes, at: now, lock: false });
    preview = { needsApproval: e.needsApproval, reasons: e.reasons, safeDefault: e.safeDefault };
  }
  return { ...rest, preview };
}

/** Files a photo or PDF against a purchase. The route checks the branch; this checks the purchase is still open for evidence. */
export async function evidenceTarget(db, scope, id) {
  const row = await loadRow(db, scope, id);
  requireOwnerOfPurchase(scope, row);
  if (['closed', 'cancelled', 'rejected'].includes(row.status)) throw fail(409, `This purchase is ${row.status}, so no more photos can be added.`, 'purchase_finished');
  return { locationId: row.location_id };
}
