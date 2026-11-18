// Purchasing (P2-07, migration 016): reorder suggestions, purchase orders (draft -> submit -> approve -> send -> close/cancel) and the
// printable order document with a WhatsApp message. Receiving goods against an order lives in receiving.js.
// Every function takes (db, scope, ...): `db` is a query-able handle (a transaction for writes), `scope` comes from
// permissions.inventoryScope(). Services re-check capabilities (synchronous, no audit); routes authorize (and audit denials) BEFORE the
// write transaction. Each change appends an audit event in the same transaction. Money is exact (decimal.js): prices are KES per ONE
// entered unit (a crate, a kg); price_per_base is KES per base unit at 6 dp, so prices in different units compare.
//
// Approvals (P2-10): the real engine (approvals.js) is the only path. submit() evaluates the 'purchase_order' rules and opens an approval request in
// the same transaction that moves the order to pending_approval; a sole approver's own order is decided through the engine too (self_approved,
// audited), never bypassed. Decisions (the Approvals inbox, or the approve/reject endpoints here, which delegate to approvals.decide) reach the
// order through onDecided('purchase_order') -> applyPoDecision, inside the decision's transaction.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { QTY, COST, MONEY, dec, add, sub, mul, div, cmp, isZero, isNeg } from './decimal.js';
import { display, normaliseUnit, toBase } from './units.js';
import { loadUnits } from './catalogue.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { diff, record } from './audit.js';
import { notify } from './notifications.js';
import * as approvals from './approvals.js';
import { nextNumber } from './numbers.js';
import { oversees, priceFor, todayNairobi } from './suppliers.js';

export const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const PO_STATUSES = Object.freeze(['draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled']);
export const SEND_VIA = Object.freeze(['pdf', 'whatsapp', 'email', 'phone']);
/** Orders whose open quantity still counts as "on order". */
export const OPEN_FOR_STOCK = Object.freeze(['approved', 'sent', 'partially_received']);
const RECEIVABLE = Object.freeze(['approved', 'sent', 'partially_received', 'received']);
const MAX_LINES = 100;

/* ---------- small helpers ---------- */

export const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};
export const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
export const has = (obj, key) => obj && typeof obj === 'object' && Object.hasOwn(obj, key);
export const trimZeros = (text) => (String(text).includes('.') ? String(text).replace(/0+$/, '').replace(/\.$/, '') : String(text));
const group = (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** 19500 -> "KES 19,500.00" */
export const kes = (value) => {
  const [int, frac] = dec(value, { scale: MONEY, round: 'half-up' }).toString(MONEY).split('.');
  return `KES ${group(int)}.${frac}`;
};
export function readDate(value, label) {
  if (empty(value)) return null;
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const d = m && new Date(`${text}T00:00:00Z`);
  if (!m || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) throw fail(400, `${label} must be a date like 2026-11-18.`, 'bad_date');
  return text;
}
export function readText(value, max, label) {
  if (empty(value)) return null;
  const text = String(value).trim();
  if (text.length > max) throw fail(400, `Keep ${label} under ${max} characters.`, 'text_too_long');
  return text;
}
const niceDate = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso.length === 10 ? `${iso}T12:00:00+03:00` : iso));

/** What people call a place: the one central store is always "Warehouse"; a branch keeps its name. */
export const placeName = (loc) => (loc && loc.kind !== 'branch' ? 'Warehouse' : loc?.name || '');

/** The capability that lets someone receive stock at a location: the owner at the warehouse, a branch manager (inv.stock.record) at their own branch. */
export function receiveCapability(scope, locationId) {
  const loc = scope.locations.find((l) => l.id === locationId);
  if (loc?.kind === 'branch' && can(scope, 'inv.stock.record', { locationId })) return 'inv.stock.record';
  return 'inv.purchase.create';
}
export const requireReceive = (scope, locationId) => requireCan(scope, receiveCapability(scope, locationId), { locationId });

/* ---------- items, units, VAT ---------- */

/** What units.js needs, plus the VAT class. Refuses archived items when `forOrder`. */
export async function loadOrderItem(db, businessId, itemId, { forOrder = false } = {}) {
  const row = (await db.query(`select id, name, unit, display_unit, vat_class, archived_at, last_cost::text as last_cost from public.stock_items where id = $1 and business_id = $2`, [itemId, businessId])).rows[0];
  if (!row) throw fail(404, 'That stock item isn’t in this business. Pick it from the items list.', 'item_not_found');
  if (forOrder && row.archived_at) throw fail(409, `${row.name} is archived, so it can’t be ordered. Restore it first.`, 'item_archived');
  const own = (await db.query('select name, factor::text as factor from public.stock_item_units where item_id = $1 order by position, name', [itemId])).rows;
  return { id: row.id, name: row.name, baseUnit: row.unit, displayUnit: row.display_unit || undefined, vatClass: row.vat_class, lastCost: row.last_cost,
    units: own.map((u) => ({ name: u.name, factor: u.factor })) };
}

/** Standard VAT percentage for the business (inventory_settings key vat_standard_pct; 16 until set). */
export async function vatPct(db, businessId) {
  const row = (await db.query(`select value from public.inventory_settings where business_id = $1 and key = 'vat_standard_pct' and location_id is null`, [businessId])).rows[0];
  const n = row && typeof row.value === 'number' ? row.value : 16;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 16;
}

/** One line's money: { lineTotal, vat } as 2 dp strings. Net price x quantity, rounded half-up to 2 dp; VAT on that, rounded the same way. */
export function lineAmounts({ qty, unitPrice, vatClass = 'standard' }, pct = 16) {
  const lineTotal = mul(dec(qty), dec(unitPrice), MONEY);
  const vat = vatClass === 'standard' ? div(mul(lineTotal, dec(String(pct)), 8), '100', MONEY) : dec('0', { scale: MONEY });
  return { lineTotal: lineTotal.toString(MONEY), vat: vat.toString(MONEY) };
}
/** The ONE totals function (server and screen): round each line to 2 dp, then sum. { subtotal, vat, total } as 2 dp strings. */
export function totals(lines, pct = 16) {
  let subtotal = dec('0', { scale: MONEY }); let vat = dec('0', { scale: MONEY });
  for (const l of lines) {
    const a = lineAmounts(l, pct);
    subtotal = add(subtotal, a.lineTotal, MONEY); vat = add(vat, a.vat, MONEY);
  }
  return { subtotal: subtotal.toString(MONEY), vat: vat.toString(MONEY), total: add(subtotal, vat, MONEY).toString(MONEY) };
}

/* ---------- loading ---------- */

const PO_COLUMNS = `po.id, po.business_id, po.number, po.supplier_id, po.deliver_to_location_id, po.expected_date::text as expected_date, po.status,
  po.subtotal::text as subtotal, po.vat_total::text as vat_total, po.total::text as total, po.notes, po.self_approved, po.created_by, po.approved_by,
  po.approved_at, po.sent_at, po.sent_via, po.cancelled_by, po.cancelled_at, po.cancel_reason, po.created_at, po.updated_at`;
const LINE_COLUMNS = `l.id, l.po_id, l.position, l.item_id, l.entered_qty::text as entered_qty, l.entered_unit, l.unit_factor::text as unit_factor, l.qty_base::text as qty_base,
  l.unit_price::text as unit_price, l.price_per_base::text as price_per_base, l.vat_amount::text as vat_amount, l.line_total::text as line_total, l.received_base::text as received_base`;

/** The order row (this business only). Throws 404 otherwise. `lock` takes the row lock for a write. */
export async function loadPo(db, scope, id, { lock = false } = {}) {
  const row = (await db.query(`select ${PO_COLUMNS} from public.purchase_orders po where po.id = $1 and po.business_id = $2 ${lock ? 'for update' : ''}`, [needId(id, 'The purchase order'), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That purchase order isn’t in this business.', 'po_not_found');
  return row;
}
export async function loadPoLines(db, poId, { lock = false } = {}) {
  return (await db.query(`select ${LINE_COLUMNS} from public.po_lines l where l.po_id = $1 order by l.position ${lock ? 'for update' : ''}`, [poId])).rows;
}

const outstanding = (l) => { const v = sub(l.qty_base, l.received_base, QTY); return isNeg(v) ? dec('0', { scale: QTY }) : v; };
/** Whole packs needed to cover `need` base units (rounded up). */
const packsFor = (need, factor) => { const q = div(need, factor, 0, 'down'); return cmp(mul(q, factor, QTY), need) < 0 ? add(q, '1', 0) : q; };

async function poView(db, scope, row, { lines = null } = {}) {
  const units = await loadUnits(db);
  const rows = lines || await loadPoLines(db, row.id);
  const showCost = can(scope, 'inv.cost.view', { locationId: row.deliver_to_location_id });
  const supplier = (await db.query('select id, name, phone, contact_name, status from public.suppliers where id = $1', [row.supplier_id])).rows[0];
  const loc = scope.locations.find((l) => l.id === row.deliver_to_location_id);
  const items = new Map();
  const outLines = [];
  for (const l of rows) {
    if (!items.has(l.item_id)) items.set(l.item_id, await loadOrderItem(db, scope.businessId, l.item_id));
    const item = items.get(l.item_id);
    const open = outstanding(l);
    const factor = dec(l.unit_factor);
    const exact = !isZero(open) && !isZero(factor) ? div(open, factor, QTY) : dec('0', { scale: QTY });
    const inUnit = isZero(open) ? '0' : cmp(mul(exact, factor, QTY), open) === 0 ? exact.toString(QTY) : null;
    const out = { id: l.id, position: l.position, itemId: l.item_id, itemName: item.name, qty: trimZeros(l.entered_qty), unit: l.entered_unit, unitFactor: trimZeros(l.unit_factor),
      qtyBase: l.qty_base, quantity: display(l.qty_base, item, units), receivedBase: l.received_base, received: display(l.received_base, item, units),
      outstandingBase: open.toString(QTY), outstanding: display(open.toString(QTY), item, units), outstandingInUnit: inUnit === null ? null : trimZeros(inUnit) };
    if (showCost) Object.assign(out, { unitPrice: l.unit_price, pricePerBase: l.price_per_base, vatAmount: l.vat_amount, lineTotal: l.line_total });
    outLines.push(out);
  }
  const any = rows.some((l) => !isZero(l.received_base));
  const all = rows.length > 0 && rows.every((l) => cmp(l.received_base, l.qty_base) >= 0);
  const receipts = (await db.query(`select id, number, status, received_at from public.goods_receipts where po_id = $1 order by created_at, id`, [row.id])).rows;
  const view = {
    id: row.id, number: row.number, status: row.status, expectedDate: row.expected_date, notes: row.notes, selfApproved: row.self_approved,
    supplier: supplier ? { id: supplier.id, name: supplier.name, phone: supplier.phone, contactName: supplier.contact_name } : { id: row.supplier_id },
    deliverTo: loc ? { id: loc.id, name: placeName(loc), kind: loc.kind === 'branch' ? 'branch' : 'warehouse' } : { id: row.deliver_to_location_id },
    createdBy: row.created_by, approvedBy: row.approved_by, approvedAt: row.approved_at, sentAt: row.sent_at, sentVia: row.sent_via,
    cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    receiving: !any ? 'none' : all ? 'complete' : 'partial', lines: outLines,
    receipts: receipts.map((r) => ({ id: r.id, number: r.number, status: r.status, receivedAt: r.received_at })),
  };
  if (showCost) view.totals = { subtotal: row.subtotal, vat: row.vat_total, total: row.total };
  return view;
}

export async function getPo(db, scope, id) {
  const row = await loadPo(db, scope, id);
  requireCan(scope, 'inv.view', { locationId: row.deliver_to_location_id });
  return { order: await poView(db, scope, row) };
}

/** { status, supplierId, locationId, search, limit (default 50, max 200), before (ISO time) }. Only locations the caller may view. */
export async function listPos(db, scope, { status, supplierId, locationId, search, limit = 50, before } = {}) {
  requireCan(scope, 'inv.view');
  if (!empty(status) && !PO_STATUSES.includes(status) && status !== 'open') throw fail(400, `The status must be one of: ${PO_STATUSES.join(', ')}, open.`, 'bad_status');
  const where = locationsWith(scope, 'inv.view');
  if (!empty(locationId) && !where.includes(needId(locationId, 'The location'))) throw fail(403, 'You don’t have access to this.', 'forbidden');
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const cursor = before ? new Date(before) : null;
  if (cursor && Number.isNaN(cursor.getTime())) throw fail(400, 'The page marker is invalid. Start from the top.', 'bad_cursor');
  const { rows } = await db.query(`select ${PO_COLUMNS}, s.name as supplier_name,
      (select count(*)::int from public.po_lines l where l.po_id = po.id) as line_count
    from public.purchase_orders po join public.suppliers s on s.id = po.supplier_id
    where po.business_id = $1 and po.deliver_to_location_id = any($2::uuid[])
      and ($3::text is null or ($3 = 'open' and po.status in ('approved', 'sent', 'partially_received')) or po.status = $3)
      and ($4::uuid is null or po.supplier_id = $4::uuid) and ($5::uuid is null or po.deliver_to_location_id = $5::uuid)
      and ($6::text is null or position(upper($6) in upper(po.number)) > 0 or position(lower($6) in lower(s.name)) > 0)
      and ($7::timestamptz is null or po.created_at < $7::timestamptz)
    order by po.created_at desc, po.id desc limit $8`,
  [scope.businessId, where, empty(status) ? null : status, empty(supplierId) ? null : needId(supplierId, 'The supplier'), empty(locationId) ? null : locationId,
    empty(search) ? null : String(search).trim().slice(0, 60), cursor ? cursor.toISOString() : null, size + 1]);
  const page = rows.slice(0, size);
  return {
    orders: page.map((r) => {
      const out = { id: r.id, number: r.number, status: r.status, supplierId: r.supplier_id, supplierName: r.supplier_name, deliverToLocationId: r.deliver_to_location_id,
        expectedDate: r.expected_date, selfApproved: r.self_approved, lineCount: r.line_count, createdAt: r.created_at };
      if (can(scope, 'inv.cost.view', { locationId: r.deliver_to_location_id })) out.total = r.total;
      return out;
    }),
    nextBefore: rows.length > size ? new Date(page.at(-1).created_at).toISOString() : null,
  };
}

/* ---------- building lines ---------- */

async function loadActiveSupplier(db, businessId, supplierId) {
  const row = (await db.query('select id, name, phone, status from public.suppliers where id = $1 and business_id = $2', [needId(supplierId, 'The supplier'), businessId])).rows[0];
  if (!row) throw fail(404, 'That supplier isn’t in this business. Pick one from the suppliers list.', 'supplier_not_found');
  if (row.status !== 'active') throw fail(409, `${row.name} is ${row.status}, so you can’t order from them. Reactivate the supplier first.`, 'supplier_inactive');
  return row;
}

function readQty(value, label) {
  if (empty(value)) throw fail(400, `${label}: enter how much to order.`, 'qty_required');
  const q = dec(value, { label });
  if (isZero(q) || isNeg(q)) throw fail(400, `${label}: the amount must be more than zero.`, 'qty_not_positive');
  return q;
}

/** Input lines -> priced, converted lines ready to insert. [{ itemId, qty, unit?, price? }]; price defaults to the supplier's price in force. */
async function buildLines(db, scope, supplierId, input, { today }) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'Add at least one item to the order.', 'lines_required');
  if (input.length > MAX_LINES) throw fail(400, `An order can have at most ${MAX_LINES} lines. Split it into two orders.`, 'too_many_lines');
  const units = await loadUnits(db);
  const pct = await vatPct(db, scope.businessId);
  const seen = new Set();
  const out = [];
  for (const [index, entry] of input.entries()) {
    if (!entry || typeof entry !== 'object') throw fail(400, `Line ${index + 1} is not valid.`, 'bad_line');
    const itemId = needId(entry.itemId, `The item on line ${index + 1}`);
    if (seen.has(itemId)) throw fail(400, 'An item is listed twice. Combine the amounts into one line.', 'duplicate_item');
    seen.add(itemId);
    const item = await loadOrderItem(db, scope.businessId, itemId, { forOrder: true });
    const listed = await priceFor(db, { businessId: scope.businessId, supplierId, itemId, date: today });
    let unitText = entry.unit;
    if (empty(unitText)) {
      unitText = (await db.query('select purchase_unit from public.supplier_items where supplier_id = $1 and item_id = $2', [supplierId, itemId])).rows[0]?.purchase_unit || listed?.unit || item.displayUnit || item.baseUnit;
    }
    const code = normaliseUnit(String(unitText), item, units);
    if (!code) toBase('1', String(unitText), item, units); // throws the plain "isn't a unit Cravio knows" message
    const factor = toBase('1', code, item, units);
    const qty = readQty(entry.qty ?? entry.quantity, item.name);
    const qtyBase = toBase(qty.toString(), code, item, units, { positive: true, label: `Quantity of ${item.name}` });
    let unitPrice; let source;
    if (!empty(entry.price)) {
      unitPrice = dec(entry.price, { scale: MONEY, round: 'exact', label: `The price of ${item.name}` });
      if (isNeg(unitPrice)) throw fail(400, `The price of ${item.name} can’t be negative.`, 'bad_price');
      source = 'manual';
    } else if (listed) {
      unitPrice = String(listed.unit).toLowerCase() === code.toLowerCase() ? dec(listed.price) : mul(dec(listed.price_per_base), dec(factor), MONEY);
      source = 'list';
    } else {
      throw fail(400, `There is no price for ${item.name} on this supplier’s price list. Type the price, or add it to the supplier’s prices first.`, 'price_required');
    }
    const amounts = lineAmounts({ qty: qty.toString(), unitPrice: unitPrice.toString(MONEY), vatClass: item.vatClass }, pct);
    out.push({ position: index, itemId, itemName: item.name, enteredQty: qty.toString(QTY), enteredUnit: code, unitFactor: factor, qtyBase,
      unitPrice: unitPrice.toString(MONEY), pricePerBase: div(unitPrice, dec(factor), COST).toString(COST), vatAmount: amounts.vat, lineTotal: amounts.lineTotal,
      vatClass: item.vatClass, priceSource: source, listPrice: listed ? listed.price : null });
  }
  return out;
}

async function insertLines(db, scope, poId, lines) {
  for (const l of lines) {
    await db.query(`insert into public.po_lines (business_id, po_id, position, item_id, entered_qty, entered_unit, unit_factor, qty_base, unit_price, price_per_base, vat_amount, line_total)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [scope.businessId, poId, l.position, l.itemId, l.enteredQty, l.enteredUnit, l.unitFactor, l.qtyBase, l.unitPrice, l.pricePerBase, l.vatAmount, l.lineTotal]);
  }
}
const sumOf = (lines, pct) => totals(lines.map((l) => ({ qty: l.enteredQty, unitPrice: l.unitPrice, vatClass: l.vatClass })), pct);
const lineAudit = (lines) => lines.map((l) => ({ itemId: l.itemId, qty: trimZeros(l.enteredQty), unit: l.enteredUnit, price: l.unitPrice, source: l.priceSource, ...(l.priceSource === 'manual' && l.listPrice ? { listPrice: l.listPrice } : {}) }));

/* ---------- create, edit ---------- */

/**
 * New draft order. body: { supplierId, deliverToLocationId? (default Warehouse), expectedDate?, notes?, lines: [{ itemId, qty, unit?, price? }] }.
 * A price you type is kept as a manual override (the audit event notes the list price it replaced).
 */
export async function createPo(db, scope, body = {}, { today = todayNairobi() } = {}) {
  const locationId = empty(body.deliverToLocationId) ? scope.centerLocationId : needId(body.deliverToLocationId, 'The delivery location');
  if (!locationId || !scope.locations.some((l) => l.id === locationId)) throw fail(404, 'That location isn’t part of this business. Pick it from the locations list.', 'location_not_found');
  requireCan(scope, 'inv.purchase.create', { locationId });
  const supplier = await loadActiveSupplier(db, scope.businessId, body.supplierId);
  const lines = await buildLines(db, scope, supplier.id, body.lines, { today });
  const sums = sumOf(lines, await vatPct(db, scope.businessId));
  const expectedDate = readDate(body.expectedDate, 'The expected date');
  const notes = readText(body.notes, 500, 'the notes');
  const number = await nextNumber(db, { businessId: scope.businessId, kind: 'PO' });
  const row = (await db.query(`insert into public.purchase_orders (business_id, number, supplier_id, deliver_to_location_id, expected_date, subtotal, vat_total, total, notes, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`, [scope.businessId, number, supplier.id, locationId, expectedDate, sums.subtotal, sums.vat, sums.total, notes, scope.userId])).rows[0];
  await insertLines(db, scope, row.id, lines);
  await record(db, { businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'create',
    before: null, after: { number, supplierId: supplier.id, expectedDate, total: sums.total, lines: lineAudit(lines) } });
  return getPo(db, scope, row.id);
}

/** Edits a DRAFT: supplier, delivery location, expected date, notes, and (replacing all lines) lines. Refused once submitted. */
export async function updatePo(db, scope, id, patch = {}, { today = todayNairobi() } = {}) {
  const row = await loadPo(db, scope, id, { lock: true });
  requireCan(scope, 'inv.purchase.create', { locationId: row.deliver_to_location_id });
  if (row.status !== 'draft') throw fail(409, 'This order can’t be edited once it is submitted. Cancel it and start a new one.', 'po_not_draft');
  const before = { supplierId: row.supplier_id, deliverToLocationId: row.deliver_to_location_id, expectedDate: row.expected_date, notes: row.notes, total: row.total };
  const next = { ...before };
  if (has(patch, 'supplierId') && patch.supplierId !== row.supplier_id) {
    if (!has(patch, 'lines')) throw fail(400, 'You changed the supplier, so the prices need checking. Send the lines again.', 'lines_required');
    next.supplierId = (await loadActiveSupplier(db, scope.businessId, patch.supplierId)).id;
  }
  if (has(patch, 'deliverToLocationId')) {
    const loc = needId(patch.deliverToLocationId, 'The delivery location');
    if (!scope.locations.some((l) => l.id === loc)) throw fail(404, 'That location isn’t part of this business. Pick it from the locations list.', 'location_not_found');
    requireCan(scope, 'inv.purchase.create', { locationId: loc });
    next.deliverToLocationId = loc;
  }
  if (has(patch, 'expectedDate')) next.expectedDate = readDate(patch.expectedDate, 'The expected date');
  if (has(patch, 'notes')) next.notes = readText(patch.notes, 500, 'the notes');
  let lines = null;
  let sums = null;
  if (has(patch, 'lines')) {
    lines = await buildLines(db, scope, next.supplierId, patch.lines, { today });
    sums = sumOf(lines, await vatPct(db, scope.businessId));
    next.total = sums.total;
  }
  await db.query(`update public.purchase_orders set supplier_id = $2, deliver_to_location_id = $3, expected_date = $4, notes = $5 ${sums ? ', subtotal = $6, vat_total = $7, total = $8' : ''} where id = $1`,
    [row.id, next.supplierId, next.deliverToLocationId, next.expectedDate, next.notes, ...(sums ? [sums.subtotal, sums.vat, sums.total] : [])]);
  if (lines) {
    await db.query('delete from public.po_lines where po_id = $1', [row.id]);
    await insertLines(db, scope, row.id, lines);
  }
  const change = diff(before, next);
  if (change.changed.length || lines) {
    await record(db, { businessId: scope.businessId, locationId: next.deliverToLocationId, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'update',
      before: change.before, after: { ...change.after, ...(lines ? { lines: lineAudit(lines) } : {}) } });
  }
  return getPo(db, scope, row.id);
}

/* ---------- approval flow ---------- */

async function setStatus(db, row, status, sets = '', params = []) {
  const { rows } = await db.query(`update public.purchase_orders set status = $2 ${sets ? `, ${sets}` : ''} where id = $1 and status = $3 returning id`, [row.id, status, row.status, ...params]);
  if (!rows[0]) throw fail(409, 'This order just changed. Refresh and check it before trying again.', 'po_changed');
}

/**
 * Applies a decision: approved -> status approved (+ who, when, self_approved flag, audit, self-approval notice); rejected -> back to draft with
 * the reason. Called by the engine's onDecided('purchase_order') callback (below), once per decision, in the decision's transaction. Maker-checker
 * is the engine's job. The requester's "approved / sent back" notice is the engine's approval_decided, so none is sent here.
 * Replaying an approval on an already approved order is a no-op.
 */
export async function applyPoDecision(db, scope, id, { decision, selfApproved = false, note = null } = {}) {
  const row = await loadPo(db, scope, id, { lock: true });
  const loc = row.deliver_to_location_id;
  if (!['approved', 'rejected'].includes(decision)) throw new TypeError('applyPoDecision: decision must be approved or rejected.');
  if (decision === 'approved' && row.status === 'approved') return getPo(db, scope, row.id);
  if (!['pending_approval', 'draft'].includes(row.status) || (row.status === 'draft' && decision === 'rejected')) {
    throw fail(409, `This order is ${row.status.replace(/_/g, ' ')}, so it can’t be ${decision} now.`, 'po_not_pending');
  }
  if (decision === 'approved') {
    await setStatus(db, row, 'approved', 'approved_by = $4, approved_at = now(), self_approved = $5', [scope.userId, Boolean(selfApproved)]);
    await record(db, { businessId: scope.businessId, locationId: loc, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id,
      action: selfApproved ? 'approve_self' : 'approve', before: { status: row.status }, after: { status: 'approved', selfApproved: Boolean(selfApproved), note } });
    if (selfApproved) {
      await notify(db, { businessId: scope.businessId, recipients: 'owners', kind: 'po_self_approved', title: `Purchase order ${row.number} was self-approved`,
        body: 'The person who made this order was the only one who could approve it, so they approved it themselves. It is marked “Self-approved”.', link: `/owner/inventory/purchase-orders/${row.id}`,
        entity: { type: 'po', id: row.id }, locationId: loc, dedupeKey: `po-self:${row.id}` });
    }
  } else {
    await setStatus(db, row, 'draft');
    await record(db, { businessId: scope.businessId, locationId: loc, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'reject',
      before: { status: row.status }, after: { status: 'draft', note } });
  }
  return getPo(db, scope, row.id);
}

/** The engine calls this when a purchase-order approval is decided. Safe to call again (the engine itself fires once per decision). */
export function registerPurchasingApprovals() {
  return approvals.onDecided('purchase_order', (db, approval, { scope }) => applyPoDecision(db, scope, approval.subjectId,
    { decision: approval.status === 'approved' ? 'approved' : 'rejected', selfApproved: approval.selfApproved, note: approval.decisionNote }));
}
let unregister = null;
/** Registers the callback once per process (tests that clear the engine's handlers can call registerPurchasingApprovals() again). */
export function ensurePurchasingApprovals() { if (!unregister) unregister = registerPurchasingApprovals(); }
ensurePurchasingApprovals();

/** Opens (or returns) the approval for an order that is pending: evaluate the rules for its total and request, in the caller's transaction. */
async function openApproval(db, scope, row, requestedBy) {
  const lines = (await db.query(`select i.category_id, l.line_total::numeric + l.vat_amount::numeric as amount from public.po_lines l join public.stock_items i on i.id = l.item_id where l.po_id = $1`, [row.id])).rows;
  const evaluation = await approvals.evaluate(db, { businessId: scope.businessId, subject: 'purchase_order', locationId: row.deliver_to_location_id, amountKes: row.total,
    lines: lines.map((l) => ({ categoryId: l.category_id, amountKes: String(l.amount) })) });
  const approval = await approvals.request(db, { businessId: scope.businessId, subject: 'purchase_order', subjectId: row.id, locationId: row.deliver_to_location_id,
    requestedBy, requestedByRole: scope.role, amountKes: row.total, evaluation });
  return { approval, evaluation };
}

/**
 * Submits a draft: the order moves to pending_approval and an approval is requested (approvers are notified once) in the same transaction. When the
 * submitter is the only person who can approve, the engine decides it as self_approved right here (D2-5): the approvals table and audit keep the record.
 */
export async function submitPo(db, scope, id) {
  const row = await loadPo(db, scope, id, { lock: true });
  requireCan(scope, 'inv.purchase.create', { locationId: row.deliver_to_location_id });
  if (row.status !== 'draft') throw fail(409, `This order is ${row.status.replace(/_/g, ' ')}; only a draft can be submitted.`, 'po_not_draft');
  const lines = await loadPoLines(db, row.id);
  if (!lines.length) throw fail(400, 'Add at least one item before you submit the order.', 'lines_required');
  const loc = row.deliver_to_location_id;
  await setStatus(db, row, 'pending_approval');
  const { approval, evaluation } = await openApproval(db, scope, row, scope.userId);
  await record(db, { businessId: scope.businessId, locationId: loc, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'submit',
    before: { status: 'draft' }, after: { status: 'pending_approval', total: row.total, approvalId: approval.id } });
  const capability = evaluation.approverCapability;
  if (can(scope, capability, { locationId: loc }) && !(await approvals.approverAvailable(db, scope.businessId, scope.userId, capability, loc))) {
    await approvals.decide(db, scope, approval.id, { decision: 'approve' });
  }
  return getPo(db, scope, row.id);
}

const pendingApproval = async (db, scope, row) => {
  const found = (await db.query(`select id, requested_by from public.approvals where business_id = $1 and subject_type = 'purchase_order' and subject_id = $2 and status = 'pending'`, [scope.businessId, row.id])).rows[0];
  if (found) return found;
  return { id: (await openApproval(db, scope, row, row.created_by || scope.userId)).approval.id, requested_by: row.created_by };   // an order that went pending before approvals existed
};

/** Approve a pending order: delegates to approvals.decide, so maker-checker is the engine's (another approver, or the only approver's own, flagged self_approved). */
export async function approvePo(db, scope, id, { note } = {}) {
  const row = await loadPo(db, scope, id, { lock: true });
  requireCan(scope, 'inv.purchase.approve', { locationId: row.deliver_to_location_id });
  if (row.status !== 'pending_approval') throw fail(409, `This order is ${row.status.replace(/_/g, ' ')}; only an order waiting for approval can be approved.`, 'po_not_pending');
  const approval = await pendingApproval(db, scope, row);
  await approvals.decide(db, scope, approval.id, { decision: 'approve', note: readText(note, 300, 'the note') });
  return getPo(db, scope, row.id);
}

/**
 * Send a pending order back to draft with a reason. An approver rejects through approvals.decide; the person who made it can't reject their own
 * request in the engine, so for them it is a withdrawal (approvals.cancel) that returns the order to draft.
 */
export async function rejectPo(db, scope, id, { reason } = {}) {
  const row = await loadPo(db, scope, id, { lock: true });
  const canApprove = can(scope, 'inv.purchase.approve', { locationId: row.deliver_to_location_id });
  if (!canApprove) requireCan(scope, 'inv.purchase.create', { locationId: row.deliver_to_location_id });
  const text = readText(reason, 300, 'the reason');
  if (!text) throw fail(400, 'Say why you are sending it back, so the person can fix it.', 'reason_required');
  if (row.status !== 'pending_approval') throw fail(409, `This order is ${row.status.replace(/_/g, ' ')}; only an order waiting for approval can be sent back.`, 'po_not_pending');
  const approval = await pendingApproval(db, scope, row);
  if (canApprove && String(approval.requested_by).toLowerCase() !== String(scope.userId).toLowerCase()) {
    await approvals.decide(db, scope, approval.id, { decision: 'reject', note: text });
    return getPo(db, scope, row.id);
  }
  await approvals.cancel(db, scope, approval.id, { note: text });
  return withdrawToDraft(db, scope, row, text);
}

async function withdrawToDraft(db, scope, row, note) {
  await setStatus(db, row, 'draft');
  await record(db, { businessId: scope.businessId, locationId: row.deliver_to_location_id, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'withdraw',
    before: { status: row.status }, after: { status: 'draft', note } });
  return getPo(db, scope, row.id);
}

/* ---------- send, cancel, close ---------- */

/**
 * Marks an approved order as sent (via 'pdf' | 'whatsapp' | 'email' | 'phone') and returns the printable document plus the WhatsApp message.
 * Sending again later only records the new time and channel.
 */
export async function sendPo(db, scope, id, { via = 'pdf' } = {}) {
  const row = await loadPo(db, scope, id, { lock: true });
  requireCan(scope, 'inv.purchase.create', { locationId: row.deliver_to_location_id });
  if (!SEND_VIA.includes(via)) throw fail(400, `Send it by one of: ${SEND_VIA.join(', ')}.`, 'bad_channel');
  if (row.status === 'approved') await setStatus(db, row, 'sent', 'sent_at = now(), sent_via = $4', [via]);
  else if (['sent', 'partially_received', 'received'].includes(row.status)) await db.query('update public.purchase_orders set sent_at = now(), sent_via = $2 where id = $1', [row.id, via]);
  else if (row.status === 'pending_approval' || row.status === 'draft') throw fail(409, 'This order needs to be approved before it can be sent.', 'po_not_approved');
  else throw fail(409, `This order is ${row.status}, so it can’t be sent.`, 'po_not_sendable');
  await record(db, { businessId: scope.businessId, locationId: row.deliver_to_location_id, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'send',
    before: { status: row.status }, after: { via } });
  return { order: (await getPo(db, scope, row.id)).order, ...(await poDocument(db, scope, row.id)) };
}

/** Cancels an order that has received nothing. A reason is required; the supplier has to be told by the caller if it was already sent. */
export async function cancelPo(db, scope, id, { reason } = {}) {
  const row = await loadPo(db, scope, id, { lock: true });
  requireCan(scope, 'inv.purchase.create', { locationId: row.deliver_to_location_id });
  const text = readText(reason, 300, 'the reason');
  if (!text) throw fail(400, 'Say why you are cancelling this order.', 'reason_required');
  if (!['draft', 'pending_approval', 'approved', 'sent'].includes(row.status)) {
    throw fail(409, ['partially_received', 'received'].includes(row.status) ? 'Stock has already been received on this order, so it can’t be cancelled. Close it instead.' : `This order is ${row.status}, so it can’t be cancelled.`, 'po_not_cancellable');
  }
  if ((await loadPoLines(db, row.id)).some((l) => !isZero(l.received_base))) throw fail(409, 'Stock has already been received on this order, so it can’t be cancelled. Close it instead.', 'po_has_receipts');
  if (row.status === 'pending_approval') await approvals.cancel(db, scope, { subject: 'purchase_order', subjectId: row.id }, { note: text });
  await setStatus(db, row, 'cancelled', 'cancelled_by = $4, cancelled_at = now(), cancel_reason = $5', [scope.userId, text]);
  await record(db, { businessId: scope.businessId, locationId: row.deliver_to_location_id, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'cancel',
    before: { status: row.status }, after: { status: 'cancelled', reason: text } });
  const out = await getPo(db, scope, row.id);
  return row.status === 'sent' ? { ...out, warnings: [{ code: 'tell_supplier', message: 'This order had already been sent. Let the supplier know it is cancelled.' }] } : out;
}

/** Closes an order: whatever is still outstanding is dropped. A reason is required when something is still outstanding. */
export async function closePo(db, scope, id, { reason } = {}) {
  const row = await loadPo(db, scope, id, { lock: true });
  requireCan(scope, 'inv.purchase.create', { locationId: row.deliver_to_location_id });
  if (!['approved', 'sent', 'partially_received', 'received'].includes(row.status)) throw fail(409, `This order is ${row.status.replace(/_/g, ' ')}, so it can’t be closed.`, 'po_not_closable');
  const lines = await loadPoLines(db, row.id);
  const openLines = lines.filter((l) => !isZero(outstanding(l)));
  const text = readText(reason, 300, 'the reason');
  if (openLines.length && !text) throw fail(400, 'Some of this order has not arrived. Say why you are closing it (for example: supplier could not deliver the rest).', 'reason_required');
  const notes = text ? `${row.notes ? `${row.notes}\n` : ''}Closed: ${text}`.slice(0, 500) : row.notes;
  await setStatus(db, row, 'closed', 'notes = $4', [notes]);
  await record(db, { businessId: scope.businessId, locationId: row.deliver_to_location_id, actorId: scope.userId, actorRole: scope.role, entity: 'purchase_order', entityId: row.id, action: 'close',
    before: { status: row.status }, after: { status: 'closed', reason: text, dropped: openLines.map((l) => ({ itemId: l.item_id, outstandingBase: outstanding(l).toString(QTY) })) } });
  return getPo(db, scope, row.id);
}

/* ---------- the order document ---------- */

/**
 * Printable order as structured JSON, a plain-text message and a WhatsApp link (https://wa.me/<supplier phone>?text=...). The browser prints
 * the PDF from the structured data (no library). Needs inv.purchase.create (it carries prices).
 */
export async function poDocument(db, scope, id) {
  const row = await loadPo(db, scope, id);
  requireCan(scope, 'inv.purchase.create', { locationId: row.deliver_to_location_id });
  const view = await poView(db, scope, row);
  const business = (await db.query('select name from public.businesses where id = $1', [scope.businessId])).rows[0];
  const supplier = (await db.query('select name, phone, contact_name, address, kra_pin, payment_terms_days from public.suppliers where id = $1', [row.supplier_id])).rows[0];
  const document = {
    title: 'Purchase order', number: row.number, status: row.status, date: row.created_at, dateText: niceDate(new Date(row.created_at).toISOString()),
    from: { name: business?.name || '' }, to: { name: supplier.name, contactName: supplier.contact_name, phone: supplier.phone, address: supplier.address, kraPin: supplier.kra_pin },
    deliverTo: view.deliverTo.name, expectedDate: row.expected_date, expectedDateText: row.expected_date ? niceDate(row.expected_date) : null,
    paymentTermsDays: supplier.payment_terms_days, notes: row.notes,
    lines: view.lines.map((l, i) => ({ n: i + 1, item: l.itemName, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, vat: l.vatAmount, lineTotal: l.lineTotal })),
    totals: view.totals, currency: 'KES',
  };
  const text = [
    `Purchase order ${row.number}`,
    `From: ${document.from.name}`,
    `To: ${supplier.name}`,
    `Deliver to: ${document.deliverTo}${document.expectedDateText ? `, by ${document.expectedDateText}` : ''}`,
    '',
    ...document.lines.map((l) => `${l.n}. ${l.item}: ${l.qty} ${l.unit} at ${kes(l.unitPrice)} = ${kes(l.lineTotal)}`),
    '',
    `Subtotal ${kes(document.totals.subtotal)}, VAT ${kes(document.totals.vat)}`,
    `Total ${kes(document.totals.total)}`,
    ...(row.notes ? ['', row.notes] : []),
    '',
    'Please confirm you received this order. Thank you.',
  ].join('\n');
  const phone = supplier.phone;
  return { document, text, whatsapp: { phone, text, link: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null,
    note: phone ? null : 'This supplier has no phone number saved, so there is no WhatsApp link. Add their number on the supplier page.' } };
}

/* ---------- reorder suggestions (PRC-1) ---------- */

/**
 * Items at `locationId` (default Warehouse) where available + already on order is below the reorder level, with an amount to bring them up to
 * par (or max; twice the reorder level when neither is set), in whole packs of the supplier's unit, minus open orders (approved, sent,
 * partially received). The supplier is the preferred one, else the cheapest by price per base unit. Prices only with inv.cost.view.
 */
export async function reorderSuggestions(db, scope, { locationId, today = todayNairobi() } = {}) {
  const loc = empty(locationId) ? scope.centerLocationId : needId(locationId, 'The location');
  const place = scope.locations.find((l) => l.id === loc);
  if (!place) throw fail(404, 'That location isn’t part of this business. Pick it from the locations list.', 'location_not_found');
  requireCan(scope, 'inv.view', { locationId: loc });
  if (!oversees(scope) && !can(scope, 'inv.purchase.create', { locationId: loc })) throw fail(403, 'You don’t have access to this.', 'forbidden');
  const showCost = can(scope, 'inv.cost.view', { locationId: loc });
  const units = await loadUnits(db);
  const items = (await db.query(`select i.id, i.name, i.unit, i.display_unit, i.vat_class, i.last_cost::text as last_cost, i.low_level::text as low_level,
      lv.reorder::text as reorder, lv.par::text as par, lv.max::text as max,
      coalesce(b.on_hand, 0)::text as on_hand, coalesce(b.reserved, 0)::text as reserved
    from public.stock_items i
    left join public.stock_item_levels lv on lv.item_id = i.id and lv.location_id = $2
    left join public.stock_balances b on b.item_id = i.id and b.location_id = $2
    where i.business_id = $1 and i.archived_at is null and coalesce(lv.reorder, i.low_level) is not null order by lower(i.name)`, [scope.businessId, loc])).rows;
  if (!items.length) return { locationId: loc, locationName: placeName(place), suggestions: [], bySupplier: [], withoutSupplier: [] };
  const ids = items.map((i) => i.id);
  const onOrder = new Map((await db.query(`select l.item_id, sum(l.qty_base - l.received_base)::text as open from public.po_lines l join public.purchase_orders po on po.id = l.po_id
    where po.business_id = $1 and po.deliver_to_location_id = $2 and po.status = any($3::text[]) and l.item_id = any($4::uuid[]) and l.qty_base > l.received_base group by l.item_id`,
  [scope.businessId, loc, OPEN_FOR_STOCK, ids])).rows.map((r) => [r.item_id, r.open]));
  const own = new Map();
  for (const u of (await db.query('select item_id, name, factor::text as factor from public.stock_item_units where item_id = any($1::uuid[]) order by position, name', [ids])).rows) {
    if (!own.has(u.item_id)) own.set(u.item_id, []);
    own.get(u.item_id).push({ name: u.name, factor: u.factor });
  }
  const offers = (await db.query(`select coalesce(si.item_id, p.item_id) as item_id, s.id as supplier_id, s.name as supplier_name, coalesce(si.preferred, false) as preferred, coalesce(si.rank, 99) as rank,
      si.purchase_unit, si.min_order_base::text as min_order_base, p.unit, p.unit_factor::text as unit_factor, p.price::text as price, p.price_per_base::text as price_per_base
    from (select distinct on (supplier_id, item_id) * from public.supplier_prices where business_id = $1 and effective_from <= $2::date order by supplier_id, item_id, effective_from desc, created_at desc, id desc) p
    full join public.supplier_items si on si.supplier_id = p.supplier_id and si.item_id = p.item_id
    join public.suppliers s on s.id = coalesce(si.supplier_id, p.supplier_id) and s.status = 'active' and s.business_id = $1
    where coalesce(si.item_id, p.item_id) = any($3::uuid[])`, [scope.businessId, today, ids])).rows;
  const byItem = new Map();
  for (const o of offers) { if (!byItem.has(o.item_id)) byItem.set(o.item_id, []); byItem.get(o.item_id).push(o); }

  const suggestions = [];
  for (const i of items) {
    const item = { name: i.name, baseUnit: i.unit, displayUnit: i.display_unit || undefined, units: own.get(i.id) || [] };
    const reorder = dec(i.reorder ?? i.low_level);
    const available = sub(i.on_hand, i.reserved, QTY);
    const open = dec(onOrder.get(i.id) ?? '0');
    if (cmp(add(available, open, QTY), reorder) >= 0) continue;
    const target = i.par !== null ? dec(i.par) : i.max !== null ? dec(i.max) : mul(reorder, '2', QTY);
    const need = sub(target, add(available, open, QTY), QTY);
    if (isNeg(need) || isZero(need)) continue;
    const candidates = (byItem.get(i.id) || []).map((o) => ({ ...o, priced: o.price_per_base !== null })).sort((a, b) =>
      Number(b.preferred) - Number(a.preferred) || (a.priced === b.priced ? 0 : a.priced ? -1 : 1)
      || (a.priced && b.priced ? cmp(a.price_per_base, b.price_per_base) : 0) || a.rank - b.rank || a.supplier_name.localeCompare(b.supplier_name));
    const pick = candidates[0] || null;
    const entry = { itemId: i.id, name: i.name, onHand: i.on_hand, reserved: i.reserved, available: available.toString(QTY), onOrder: open.toString(QTY),
      reorder: reorder.toString(QTY), par: i.par, max: i.max, target: target.toString(QTY), neededBase: need.toString(QTY), supplier: null, unit: null, qty: null, qtyBase: null };
    let unitCode = item.displayUnit || item.baseUnit;
    let factor = null;
    if (pick) {
      const wanted = pick.unit || pick.purchase_unit || unitCode;
      const code = normaliseUnit(String(wanted), item, units);
      if (code) { unitCode = code; factor = dec(toBase('1', code, item, units)); }
      entry.supplier = { id: pick.supplier_id, name: pick.supplier_name, preferred: pick.preferred };
    }
    if (!factor) factor = dec(toBase('1', unitCode, item, units));
    let packs = packsFor(need, factor);
    let qtyBase = mul(packs, factor, QTY);
    if (pick?.min_order_base && cmp(qtyBase, pick.min_order_base) < 0) { packs = packsFor(dec(pick.min_order_base), factor); qtyBase = mul(packs, factor, QTY); }
    Object.assign(entry, { unit: unitCode, qty: packs.toString(), qtyBase: qtyBase.toString(QTY) });
    if (showCost) {
      entry.lastCost = i.last_cost;
      if (pick?.priced) {
        const price = String(pick.unit).toLowerCase() === unitCode.toLowerCase() ? dec(pick.price) : mul(dec(pick.price_per_base), factor, MONEY);
        entry.unitPrice = price.toString(MONEY);
        entry.estimatedTotal = mul(packs, price, MONEY).toString(MONEY);
      } else entry.unitPrice = null;
      entry.alternatives = candidates.slice(1, 4).map((c) => ({ supplierId: c.supplier_id, supplierName: c.supplier_name, preferred: c.preferred, pricePerBase: c.price_per_base }));
    }
    const plain = { ...item, units: [] };
    const shown = (v) => display(v.toString ? v.toString(QTY) : v, plain, units);
    entry.explain = `${i.name}: ${shown(available)} on hand, reorder at ${shown(reorder)}${isZero(open) ? '' : `, ${shown(open)} already on order`} → order ${shown(qtyBase)} = ${trimZeros(packs.toString())} ${unitCode}${cmp(packs, '1') === 0 ? '' : 's'}`;
    suggestions.push(entry);
  }
  const groups = new Map();
  const withoutSupplier = [];
  for (const s of suggestions) {
    if (!s.supplier) { withoutSupplier.push({ itemId: s.itemId, name: s.name }); continue; }
    if (!groups.has(s.supplier.id)) groups.set(s.supplier.id, { supplierId: s.supplier.id, supplierName: s.supplier.name, itemIds: [], estimatedTotal: dec('0', { scale: MONEY }) });
    const g = groups.get(s.supplier.id);
    g.itemIds.push(s.itemId);
    if (s.estimatedTotal) g.estimatedTotal = add(g.estimatedTotal, s.estimatedTotal, MONEY);
  }
  return { locationId: loc, locationName: placeName(place), suggestions,
    bySupplier: [...groups.values()].map((g) => ({ supplierId: g.supplierId, supplierName: g.supplierName, itemIds: g.itemIds, ...(showCost ? { estimatedTotal: g.estimatedTotal.toString(MONEY) } : {}) })),
    withoutSupplier };
}

/**
 * "Create PO" from the suggestions: one DRAFT order per supplier at that location (optionally only `itemIds` and/or one `supplierId`).
 * Items with no supplier are returned in `skipped` (they need a supplier and price first). Quantities are the suggested ones; edit the drafts afterwards.
 */
export async function createPosFromSuggestions(db, scope, { locationId, itemIds, supplierId, today = todayNairobi() } = {}) {
  const loc = empty(locationId) ? scope.centerLocationId : needId(locationId, 'The location');
  requireCan(scope, 'inv.purchase.create', { locationId: loc });
  const sug = await reorderSuggestions(db, scope, { locationId: loc, today });
  const only = Array.isArray(itemIds) && itemIds.length ? new Set(itemIds.map((x) => String(x).toLowerCase())) : null;
  const picked = sug.suggestions.filter((s) => (!only || only.has(s.itemId)) && (empty(supplierId) || s.supplier?.id === String(supplierId).toLowerCase()));
  const skipped = picked.filter((s) => !s.supplier || s.unitPrice === null || s.unitPrice === undefined).map((s) => ({ itemId: s.itemId, name: s.name,
    reason: s.supplier ? 'no_price' : 'no_supplier', message: s.supplier ? `${s.name} has no price on ${s.supplier.name}’s list yet.` : `${s.name} has no supplier yet.` }));
  const skipIds = new Set(skipped.map((s) => s.itemId));
  const bySupplier = new Map();
  for (const s of picked.filter((x) => !skipIds.has(x.itemId))) {
    if (!bySupplier.has(s.supplier.id)) bySupplier.set(s.supplier.id, []);
    bySupplier.get(s.supplier.id).push({ itemId: s.itemId, qty: s.qty, unit: s.unit });
  }
  if (!bySupplier.size) throw fail(409, skipped.length ? 'None of these items has a supplier with a price yet. Add prices to a supplier first.' : 'Nothing needs ordering right now.', 'nothing_to_order', { skipped });
  const orders = [];
  for (const [sid, lines] of bySupplier) orders.push((await createPo(db, scope, { supplierId: sid, deliverToLocationId: loc, lines }, { today })).order);
  return { orders, skipped };
}

export { RECEIVABLE, outstanding as lineOutstanding, poView };
