// Receiving (P2-08, migration 016): goods receipts (GRN) against a purchase order or unplanned, supplier invoices, price-variance alerts,
// reversal of a receipt, and returns to the supplier. Purchase orders themselves live in purchasing.js.
// Every function takes (db, scope, ...): `db` is a transaction for writes (nothing here opens one), `scope` comes from permissions.inventoryScope().
// Stock only moves through ledger.post: purchase_receipt in (entered quantity and unit kept, unit cost per BASE unit so the weighted average
// updates) and supplier_return out (stop-at-zero applies). A refused call leaves nothing behind because the caller rolls the transaction back.
// Who may receive: the owner at the Warehouse (inv.purchase.create), a branch manager at their own branch (inv.stock.record there).
import { HttpError } from '../lib/http.js';
import { QTY, COST, MONEY, dec, add, sub, mul, div, cmp, isZero, isNeg } from './decimal.js';
import { display, normaliseUnit, toBase } from './units.js';
import { loadUnits } from './catalogue.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { getSetting } from './policies.js';
import { diff, record } from './audit.js';
import { notify } from './notifications.js';
import { nextNumber } from './numbers.js';
import * as ledger from './ledger.js';
import { list as listAttachments } from './attachments.js';
import { normalisePin, oversees, priceFor, todayNairobi } from './suppliers.js';
import { RECEIVABLE, empty, fail, has, kes, loadOrderItem, loadPo, loadPoLines, lineOutstanding, needId, poView, readDate, readText, placeName, receiveCapability, requireReceive, trimZeros } from './purchasing.js';

const MAX_LINES = 100;

/** Database guard messages (a closed order, a posted receipt ...) are already plain English: pass them on as 409. */
async function guarded(fn) {
  try { return await fn(); } catch (e) {
    if (e?.code === '23514' && !(e instanceof HttpError) && /can.t|Only a draft|starts as a draft/.test(e.message || '')) throw fail(409, e.message, 'state_refused');
    if (e?.code === '23505' && /supplier_invoices_number/.test(`${e.constraint || ''} ${e.message}`)) throw fail(409, 'That invoice number from this supplier is already recorded.', 'duplicate_invoice');
    throw e;
  }
}

const itemForUnits = (item) => ({ name: item.name, baseUnit: item.baseUnit, displayUnit: item.displayUnit, units: item.units });
/** For sentences: "35 kg" without the "about 1.4 sacks" hint. */
const plainItem = (item) => ({ name: item.name, baseUnit: item.baseUnit, displayUnit: item.displayUnit, units: [] });

/* ---------- reading ---------- */

const GRN_COLUMNS = `g.id, g.business_id, g.number, g.location_id, g.supplier_id, g.po_id, g.unplanned_reason, g.received_at, g.received_by, g.delivery_note_no, g.status, g.invoice_id,
  g.notes, g.posted_at, g.created_at`;
const GRN_LINE_COLUMNS = `l.id, l.position, l.po_line_id, l.item_id, l.entered_qty::text as entered_qty, l.entered_unit, l.unit_factor::text as unit_factor,
  l.qty_ordered_base::text as qty_ordered_base, l.qty_received_base::text as qty_received_base, l.qty_rejected_base::text as qty_rejected_base, l.reject_reason,
  l.unit_cost::text as unit_cost, l.batch_no, l.expiry_date::text as expiry_date, l.movement_id::text as movement_id`;

export async function loadGrn(db, scope, id, { lock = false } = {}) {
  const row = (await db.query(`select ${GRN_COLUMNS} from public.goods_receipts g where g.id = $1 and g.business_id = $2 ${lock ? 'for update' : ''}`, [needId(id, 'The goods receipt'), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That goods receipt isn’t in this business.', 'grn_not_found');
  return row;
}
const loadGrnLines = async (db, grnId) => (await db.query(`select ${GRN_LINE_COLUMNS} from public.grn_lines l where l.grn_id = $1 order by l.position`, [grnId])).rows;

/** How much of each receipt line has been sent back already (posted returns only). Map grn_line_id -> base quantity string. */
async function returnedMap(db, grnId) {
  const { rows } = await db.query(`select rl.grn_line_id, sum(rl.qty_base)::text as qty from public.supplier_return_lines rl join public.supplier_returns r on r.id = rl.return_id
    where r.grn_id = $1 and r.status = 'posted' group by rl.grn_line_id`, [grnId]);
  return new Map(rows.map((r) => [r.grn_line_id, r.qty]));
}

async function grnView(db, scope, row, { lines = null, units = null } = {}) {
  units ||= await loadUnits(db);
  const rows = lines || await loadGrnLines(db, row.id);
  const showCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const returned = await returnedMap(db, row.id);
  const supplier = (await db.query('select id, name from public.suppliers where id = $1', [row.supplier_id])).rows[0];
  const po = row.po_id ? (await db.query('select number from public.purchase_orders where id = $1', [row.po_id])).rows[0] : null;
  const loc = scope.locations.find((l) => l.id === row.location_id);
  const items = new Map();
  let value = dec('0', { scale: MONEY });
  const outLines = [];
  for (const l of rows) {
    if (!items.has(l.item_id)) items.set(l.item_id, await loadOrderItem(db, scope.businessId, l.item_id));
    const item = items.get(l.item_id);
    const out = { id: l.id, position: l.position, poLineId: l.po_line_id, itemId: l.item_id, itemName: item.name, qty: trimZeros(l.entered_qty), unit: l.entered_unit,
      orderedBase: l.qty_ordered_base, receivedBase: l.qty_received_base, received: display(l.qty_received_base, itemForUnits(item), units),
      rejectedBase: l.qty_rejected_base, rejected: display(l.qty_rejected_base, itemForUnits(item), units), rejectReason: l.reject_reason,
      batchNo: l.batch_no, expiryDate: l.expiry_date, posted: l.movement_id !== null, returnedBase: returned.get(l.id) || '0.0000' };
    if (showCost) {
      const lineValue = mul(l.qty_received_base, l.unit_cost, MONEY);
      value = add(value, lineValue, MONEY);
      Object.assign(out, { unitCostPerBase: l.unit_cost, costPerUnit: mul(l.unit_cost, l.unit_factor, MONEY).toString(MONEY), value: lineValue.toString(MONEY) });
    }
    outLines.push(out);
  }
  const view = { id: row.id, number: row.number, status: row.status, location: loc ? { id: loc.id, name: placeName(loc), kind: loc.kind === 'branch' ? 'branch' : 'warehouse' } : { id: row.location_id },
    supplier: supplier ? { id: supplier.id, name: supplier.name } : { id: row.supplier_id }, poId: row.po_id, poNumber: po?.number || null, unplanned: !row.po_id,
    unplannedReason: row.unplanned_reason, receivedAt: row.received_at, receivedBy: row.received_by, deliveryNoteNo: row.delivery_note_no, invoiceId: row.invoice_id,
    notes: row.notes, postedAt: row.posted_at, createdAt: row.created_at, lines: outLines };
  if (showCost) view.value = value.toString(MONEY);
  return view;
}

export async function getReceipt(db, scope, id) {
  const row = await loadGrn(db, scope, id);
  requireCan(scope, 'inv.view', { locationId: row.location_id });
  return { receipt: await grnView(db, scope, row) };
}

/** { status, supplierId, locationId, poId, limit, before }: only locations the caller may view (a branch manager sees their own branch). */
export async function listReceipts(db, scope, { status, supplierId, locationId, poId, limit = 50, before } = {}) {
  requireCan(scope, 'inv.view');
  if (!empty(status) && !['draft', 'posted', 'reversed'].includes(status)) throw fail(400, 'The status must be draft, posted or reversed.', 'bad_status');
  const where = locationsWith(scope, 'inv.view');
  if (!empty(locationId) && !where.includes(needId(locationId, 'The location'))) throw fail(403, 'You don’t have access to this.', 'forbidden');
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const cursor = before ? new Date(before) : null;
  if (cursor && Number.isNaN(cursor.getTime())) throw fail(400, 'The page marker is invalid. Start from the top.', 'bad_cursor');
  const { rows } = await db.query(`select ${GRN_COLUMNS}, s.name as supplier_name, po.number as po_number,
      (select count(*)::int from public.grn_lines l where l.grn_id = g.id) as line_count
    from public.goods_receipts g join public.suppliers s on s.id = g.supplier_id left join public.purchase_orders po on po.id = g.po_id
    where g.business_id = $1 and g.location_id = any($2::uuid[]) and ($3::text is null or g.status = $3) and ($4::uuid is null or g.supplier_id = $4::uuid)
      and ($5::uuid is null or g.location_id = $5::uuid) and ($6::uuid is null or g.po_id = $6::uuid) and ($7::timestamptz is null or g.created_at < $7::timestamptz)
    order by g.created_at desc, g.id desc limit $8`,
  [scope.businessId, where, empty(status) ? null : status, empty(supplierId) ? null : needId(supplierId, 'The supplier'), empty(locationId) ? null : locationId,
    empty(poId) ? null : needId(poId, 'The purchase order'), cursor ? cursor.toISOString() : null, size + 1]);
  const page = rows.slice(0, size);
  return { receipts: page.map((r) => ({ id: r.id, number: r.number, status: r.status, locationId: r.location_id, supplierId: r.supplier_id, supplierName: r.supplier_name,
    poId: r.po_id, poNumber: r.po_number, unplanned: !r.po_id, lineCount: r.line_count, receivedAt: r.received_at, invoiceId: r.invoice_id, createdAt: r.created_at })),
  nextBefore: rows.length > size ? new Date(page.at(-1).created_at).toISOString() : null };
}

/** Orders on their way to `locationId` (approved, sent or partly received) with what is still due: the branch manager's "expected deliveries". */
export async function expectedDeliveries(db, scope, locationId) {
  const loc = needId(locationId, 'The location');
  requireReceive(scope, loc);
  const ids = (await db.query(`select id from public.purchase_orders where business_id = $1 and deliver_to_location_id = $2 and status in ('approved', 'sent', 'partially_received')
    order by expected_date nulls last, created_at`, [scope.businessId, loc])).rows;
  const orders = [];
  for (const { id } of ids) orders.push(await poView(db, scope, await loadPo(db, scope, id)));
  return { orders };
}

/* ---------- building receipt lines ---------- */

/** Entered quantity -> base string (zero allowed). */
function readAmount(item, units, code, value, label) {
  if (empty(value)) return { entered: '0.0000', base: '0.0000' };
  const q = dec(value, { label });
  if (isNeg(q)) throw fail(400, `${label} can’t be negative.`, 'qty_negative');
  if (isZero(q)) return { entered: '0.0000', base: '0.0000' };
  return { entered: q.toString(QTY), base: toBase(q.toString(), code, item, units, { positive: true, label }) };
}

async function buildReceiptLines(db, scope, { po, poLines, supplierId, locationId, input, today }) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'Add at least one line to the receipt.', 'lines_required');
  if (input.length > MAX_LINES) throw fail(400, `A receipt can have at most ${MAX_LINES} lines.`, 'too_many_lines');
  const units = await loadUnits(db);
  const mayPrice = can(scope, 'inv.purchase.create', { locationId });
  const seen = new Set();
  const out = [];
  for (const [index, entry] of input.entries()) {
    if (!entry || typeof entry !== 'object') throw fail(400, `Line ${index + 1} is not valid.`, 'bad_line');
    let poLine = null;
    if (po) {
      if (!empty(entry.poLineId)) poLine = poLines.find((l) => l.id === String(entry.poLineId).toLowerCase());
      else if (!empty(entry.itemId)) poLine = poLines.find((l) => l.item_id === String(entry.itemId).toLowerCase());
      if (!poLine) throw fail(400, `Line ${index + 1} isn’t on ${po.number}. Receive only what was ordered, or record the delivery as unplanned.`, 'not_on_order');
      if (seen.has(poLine.id)) throw fail(400, 'An order line is listed twice. Combine the amounts into one line.', 'duplicate_line');
      seen.add(poLine.id);
    }
    const itemId = poLine ? poLine.item_id : needId(entry.itemId, `The item on line ${index + 1}`);
    if (!poLine) {
      if (seen.has(itemId)) throw fail(400, 'An item is listed twice. Combine the amounts into one line.', 'duplicate_line');
      seen.add(itemId);
    }
    const item = await loadOrderItem(db, scope.businessId, itemId);
    // A missing unit is an error, never a guess: defaulting to the order's pack ("3 crates") would turn "5" into 5 crates.
    if (empty(entry.unit)) throw fail(400, `${item.name}: say which unit the amount is in (for example kg, or crate).`, 'unit_required');
    const unitText = String(entry.unit);
    const code = normaliseUnit(unitText, item, units);
    if (!code) toBase('1', unitText, item, units);
    const factor = toBase('1', code, item, units);
    const rec = readAmount(item, units, code, entry.receivedQty ?? entry.qty, `Received ${item.name}`);
    const rej = readAmount(item, units, code, entry.rejectedQty, `Rejected ${item.name}`);
    if (isZero(rec.base) && isZero(rej.base)) throw fail(400, `${item.name}: enter how much arrived or how much you rejected.`, 'qty_required');
    const reason = readText(entry.rejectReason, 300, 'the reject reason');
    if (!isZero(rej.base) && !reason) throw fail(400, `${item.name}: say why you rejected some (for example: damaged, wrong item, past expiry).`, 'reject_reason_required');
    let costPerBase;
    if (!empty(entry.unitCost)) {
      if (poLine && !mayPrice) throw fail(403, 'Only the owner can change the price on an order. Receive it at the order price and tell the owner.', 'cost_owner_only');
      const c = dec(entry.unitCost, { label: `The cost of ${item.name}` });
      if (isNeg(c)) throw fail(400, `The cost of ${item.name} can’t be negative.`, 'bad_cost');
      costPerBase = div(c, dec(factor), COST);
    } else if (poLine) costPerBase = dec(poLine.price_per_base);
    else {
      const listed = await priceFor(db, { businessId: scope.businessId, supplierId, itemId, date: today });
      costPerBase = listed ? dec(listed.price_per_base) : dec('0', { scale: COST });
    }
    const batchNo = readText(entry.batchNo, 60, 'the batch number');
    const expiryDate = readDate(entry.expiryDate, 'The expiry date');
    out.push({ position: index, poLine, itemId, itemName: item.name, enteredQty: rec.entered, enteredUnit: code, unitFactor: factor, orderedBase: poLine ? poLine.qty_base : null,
      receivedBase: rec.base, rejectedBase: rej.base, rejectReason: isZero(rej.base) ? null : reason, unitCost: costPerBase.toString(COST), batchNo, expiryDate });
  }
  return out;
}

/**
 * The prefilled lines for a receipt against an order: everything still outstanding. Each line always carries its unit and round-trips
 * exactly: in the order's own unit when the outstanding amount is an exact decimal of it (0.5 crate), otherwise in the item's base unit.
 */
export async function prefill(db, scope, poLines) {
  const out = [];
  for (const l of poLines.filter((x) => !isZero(lineOutstanding(x)))) {
    const open = lineOutstanding(l);
    const inUnit = div(open, l.unit_factor, QTY);
    if (cmp(mul(inUnit, l.unit_factor, QTY), open) === 0) out.push({ poLineId: l.id, receivedQty: inUnit.toString(QTY), unit: l.entered_unit });
    else out.push({ poLineId: l.id, receivedQty: open.toString(QTY), unit: (await loadOrderItem(db, scope.businessId, l.item_id)).baseUnit });
  }
  return out;
}

async function insertReceiptLines(db, scope, grnId, lines) {
  for (const l of lines) {
    await db.query(`insert into public.grn_lines (business_id, grn_id, position, po_line_id, item_id, entered_qty, entered_unit, unit_factor, qty_ordered_base, qty_received_base,
      qty_rejected_base, reject_reason, unit_cost, batch_no, expiry_date) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [scope.businessId, grnId, l.position, l.poLine?.id || null, l.itemId, l.enteredQty, l.enteredUnit, l.unitFactor, l.orderedBase, l.receivedBase, l.rejectedBase, l.rejectReason, l.unitCost, l.batchNo, l.expiryDate]);
  }
}
const lineAudit = (lines) => lines.map((l) => ({ itemId: l.itemId, received: l.receivedBase, rejected: l.rejectedBase, costPerBase: l.unitCost }));

/* ---------- create, edit ---------- */

/**
 * New DRAFT receipt. body: { poId } (lines default to everything outstanding) or { unplannedReason, supplierId, locationId? } (reason required),
 * plus { deliveryNoteNo?, receivedAt?, notes?, invoiceId?, lines: [{ poLineId | itemId, receivedQty, unit?, rejectedQty?, rejectReason?, unitCost? (per entered unit),
 * batchNo?, expiryDate? }] }.
 */
export async function createReceipt(db, scope, body = {}, { today = todayNairobi() } = {}) {
  let po = null; let poLines = [];
  let locationId; let supplierId; let reason = null;
  if (!empty(body.poId)) {
    po = await loadPo(db, scope, body.poId);
    if (!RECEIVABLE.includes(po.status)) {
      throw fail(409, po.status === 'draft' || po.status === 'pending_approval' ? 'This order hasn’t been approved yet, so nothing can be received against it.' : `This order is ${po.status}, so nothing more can be received against it.`, 'po_not_receivable');
    }
    locationId = po.deliver_to_location_id; supplierId = po.supplier_id;
    requireReceive(scope, locationId);
    if (!empty(body.locationId) && String(body.locationId).toLowerCase() !== locationId) throw fail(409, 'This order is for a different place. Receive it where it was ordered to be delivered.', 'wrong_location');
    poLines = await loadPoLines(db, po.id);
  } else {
    reason = readText(body.unplannedReason, 300, 'the reason');
    if (!reason) throw fail(400, 'This delivery has no purchase order. Say why (for example: the supplier brought extra, or a one-off buy).', 'unplanned_reason_required');
    locationId = empty(body.locationId) ? scope.centerLocationId : needId(body.locationId, 'The location');
    supplierId = needId(body.supplierId, 'The supplier');
    const supplier = (await db.query('select status from public.suppliers where id = $1 and business_id = $2', [supplierId, scope.businessId])).rows[0];
    if (!supplier) throw fail(404, 'That supplier isn’t in this business. Pick one from the suppliers list.', 'supplier_not_found');
    if (supplier.status === 'archived') throw fail(409, 'That supplier is archived. Restore it first.', 'supplier_inactive');
  }
  if (!scope.locations.some((l) => l.id === locationId)) throw fail(404, 'That location isn’t part of this business. Pick it from the locations list.', 'location_not_found');
  requireReceive(scope, locationId);
  const input = has(body, 'lines') && body.lines !== undefined && body.lines !== null ? body.lines : (po ? await prefill(db, scope, poLines) : null);
  const lines = await buildReceiptLines(db, scope, { po, poLines, supplierId, locationId, input, today });
  const deliveryNoteNo = readText(body.deliveryNoteNo, 60, 'the delivery note number');
  const notes = readText(body.notes, 500, 'the notes');
  let receivedAt = null;
  if (!empty(body.receivedAt)) {
    const t = new Date(body.receivedAt);
    if (Number.isNaN(t.getTime())) throw fail(400, 'The received time isn’t a valid date and time.', 'bad_date');
    receivedAt = t.toISOString();
  }
  let invoiceId = null;
  if (!empty(body.invoiceId)) invoiceId = (await loadInvoiceRow(db, scope, body.invoiceId, { supplierId })).id;
  const number = await nextNumber(db, { businessId: scope.businessId, kind: 'GRN' });
  const row = (await guarded(() => db.query(`insert into public.goods_receipts (business_id, number, location_id, supplier_id, po_id, unplanned_reason, received_at, delivery_note_no, invoice_id, notes, received_by)
    values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), $8, $9, $10, $11) returning id`,
  [scope.businessId, number, locationId, supplierId, po?.id || null, reason, receivedAt, deliveryNoteNo, invoiceId, notes, scope.userId]))).rows[0];
  await insertReceiptLines(db, scope, row.id, lines);
  await record(db, { businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity: 'goods_receipt', entityId: row.id, action: 'create',
    before: null, after: { number, poId: po?.id || null, unplannedReason: reason, supplierId, lines: lineAudit(lines) } });
  return getReceipt(db, scope, row.id);
}

/** Edits a DRAFT receipt (delivery note, notes, received time, invoice link, and replacing all lines). A posted receipt can't be edited: reverse it. */
export async function updateReceipt(db, scope, id, patch = {}, { today = todayNairobi() } = {}) {
  const row = await loadGrn(db, scope, id, { lock: true });
  requireReceive(scope, row.location_id);
  if (row.status !== 'draft') throw fail(409, 'A posted receipt can’t be edited. Reverse it and enter it again.', 'grn_not_draft');
  const before = { deliveryNoteNo: row.delivery_note_no, notes: row.notes, invoiceId: row.invoice_id, unplannedReason: row.unplanned_reason };
  const next = { ...before };
  if (has(patch, 'deliveryNoteNo')) next.deliveryNoteNo = readText(patch.deliveryNoteNo, 60, 'the delivery note number');
  if (has(patch, 'notes')) next.notes = readText(patch.notes, 500, 'the notes');
  if (has(patch, 'unplannedReason') && !row.po_id) {
    next.unplannedReason = readText(patch.unplannedReason, 300, 'the reason');
    if (!next.unplannedReason) throw fail(400, 'An unplanned delivery needs a reason.', 'unplanned_reason_required');
  }
  if (has(patch, 'invoiceId')) next.invoiceId = empty(patch.invoiceId) ? null : (await loadInvoiceRow(db, scope, patch.invoiceId, { supplierId: row.supplier_id })).id;
  let lines = null;
  if (has(patch, 'lines')) {
    const po = row.po_id ? await loadPo(db, scope, row.po_id) : null;
    const poLines = po ? await loadPoLines(db, po.id) : [];
    lines = await buildReceiptLines(db, scope, { po, poLines, supplierId: row.supplier_id, locationId: row.location_id, input: patch.lines, today });
  }
  let receivedAt = null;
  if (has(patch, 'receivedAt') && !empty(patch.receivedAt)) {
    const t = new Date(patch.receivedAt);
    if (Number.isNaN(t.getTime())) throw fail(400, 'The received time isn’t a valid date and time.', 'bad_date');
    receivedAt = t.toISOString();
  }
  await guarded(() => db.query(`update public.goods_receipts set delivery_note_no = $2, notes = $3, invoice_id = $4, unplanned_reason = $5, received_at = coalesce($6::timestamptz, received_at) where id = $1`,
    [row.id, next.deliveryNoteNo, next.notes, next.invoiceId, next.unplannedReason, receivedAt]));
  if (lines) {
    await db.query('delete from public.grn_lines where grn_id = $1', [row.id]);
    await insertReceiptLines(db, scope, row.id, lines);
  }
  const change = diff(before, next);
  if (change.changed.length || lines || receivedAt) {
    await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'goods_receipt', entityId: row.id, action: 'update',
      before: change.before, after: { ...change.after, ...(lines ? { lines: lineAudit(lines) } : {}) } });
  }
  return getReceipt(db, scope, row.id);
}

/* ---------- post ---------- */

/** The price-increase check (GRN-6): cost per base above the order price or the previous cost by more than the owner's percentage. Null when fine or switched off. */
/** The strongest price warning for one line, or null: { label, against, pct }. `pct` null/undefined (alert switched off) never warns. */
function priceAlert({ unitCost, poPricePerBase, lastCost }, pct) {
  if (pct === null || pct === undefined) return null;
  const hits = [['the order price', poPricePerBase ?? null], ['the last price paid', lastCost ?? null]]
    .map(([label, against]) => [label, against, variance(unitCost, against, pct)]).filter((x) => x[2] !== null);
  if (!hits.length) return null;
  const worst = hits.sort((a, b) => cmp(b[2], a[2]))[0];
  return { label: worst[0], against: worst[1], pct: worst[2] };
}

function variance(costPerBase, against, pct) {
  if (against === null || against === undefined || isZero(against) || isZero(costPerBase)) return null;
  const diffPct = div(mul(sub(costPerBase, against, 8), '100', 8), against, 2);
  return cmp(diffPct, String(pct)) > 0 ? diffPct.toString(2) : null;
}

/**
 * Posts a draft receipt: one purchase_receipt movement per accepted line (rejected goods are recorded, never added to stock), updates the
 * order's received quantities and status, checks price variance. Posting again returns the same receipt (replayed). `confirmOverDelivery`
 * accepts a line beyond the owner's allowance (never beyond 150 % of the order).
 * Returns { receipt, warnings: [{ code, message, ... }], replayed }.
 */
export async function postReceipt(db, scope, id, { confirmOverDelivery = false, today = todayNairobi() } = {}) {
  void today;
  const g = await loadGrn(db, scope, id, { lock: true });
  requireReceive(scope, g.location_id);
  if (g.status === 'posted') return { receipt: await grnView(db, scope, g), warnings: [], replayed: true };
  if (g.status === 'reversed') throw fail(409, 'This receipt was reversed. Enter the delivery again as a new receipt.', 'grn_reversed');
  const lines = await loadGrnLines(db, g.id);
  if (!lines.length) throw fail(400, 'This receipt has no lines.', 'lines_required');
  const units = await loadUnits(db);
  const warnings = [];
  const items = new Map();
  for (const l of lines) if (!items.has(l.item_id)) items.set(l.item_id, await loadOrderItem(db, scope.businessId, l.item_id));

  // The order: lock it and its lines, check it can still receive, check over-delivery.
  let po = null; let poLines = [];
  if (g.po_id) {
    po = await loadPo(db, scope, g.po_id, { lock: true });
    if (!RECEIVABLE.includes(po.status)) throw fail(409, `${po.number} is ${po.status.replace(/_/g, ' ')}, so nothing can be received against it.`, 'po_not_receivable');
    poLines = await loadPoLines(db, po.id, { lock: true });
    const tolerance = await getSetting(db, scope.businessId, 'over_delivery_tolerance_pct', g.location_id);
    const tol = typeof tolerance === 'number' ? tolerance : 5;
    const over = []; const tooMuch = [];
    const add4 = new Map();
    for (const l of lines) if (l.po_line_id) add4.set(l.po_line_id, add(add4.get(l.po_line_id) ?? '0', l.qty_received_base, QTY));
    for (const [poLineId, accepted] of add4) {
      const pl = poLines.find((x) => x.id === poLineId);
      if (!pl) throw fail(409, 'A line on this receipt isn’t on the order any more.', 'not_on_order');
      const total = add(pl.received_base, accepted, QTY);
      const item = items.get(pl.item_id) || await loadOrderItem(db, scope.businessId, pl.item_id);
      const shown = (v) => display(v, plainItem(item), units);
      const allowed = div(mul(pl.qty_base, add('100', String(tol), 6), 8), '100', QTY);
      if (cmp(total, mul(pl.qty_base, '1.5', QTY)) > 0) {
        tooMuch.push(`${item.name}: ${shown(total)} would be more than 150% of the ${shown(pl.qty_base)} ordered.`);
      } else if (cmp(total, allowed) > 0) {
        const pct = div(mul(sub(total, pl.qty_base, QTY), '100', QTY), pl.qty_base, 1).toString(1);
        over.push({ itemId: pl.item_id, message: `${item.name}: you are receiving ${shown(accepted)} but only ${shown(lineOutstanding(pl))} is still due on ${po.number}. That puts the total ${trimZeros(pct)}% over the order (the allowance is ${trimZeros(String(tol))}%).` });
      }
    }
    if (tooMuch.length) throw fail(409, `That is far more than was ordered. ${tooMuch.join(' ')} Check the delivery, or record the extra as a separate unplanned receipt.`, 'over_delivery_limit');
    if (over.length && !confirmOverDelivery) {
      throw fail(409, `${over.map((o) => o.message).join(' ')} Check the count, or confirm that you accept the extra.`, 'over_delivery', { needsConfirmation: true, items: over });
    }
    for (const o of over) warnings.push({ code: 'over_delivery', itemId: o.itemId, message: `${o.message} (accepted)` });
  }

  // Price variance (read the previous cost before the ledger overwrites it).
  const pctSetting = await getSetting(db, scope.businessId, 'price_variance_alert_pct', g.location_id);
  const alerts = [];
  for (const l of lines) {
    if (isZero(l.qty_received_base)) continue;
    const item = items.get(l.item_id);
    const pl = l.po_line_id ? poLines.find((x) => x.id === l.po_line_id) : null;
    const hit = priceAlert({ unitCost: l.unit_cost, poPricePerBase: pl?.price_per_base, lastCost: item.lastCost }, pctSetting);
    if (hit) alerts.push({ line: l, item, ...hit });
  }

  // Stock in, one movement per accepted line (stable order inside postMany so concurrent receipts can't deadlock).
  const accepted = lines.filter((l) => !isZero(l.qty_received_base));
  const results = await ledger.postMany(db, accepted.map((l) => ({ businessId: scope.businessId, locationId: g.location_id, itemId: l.item_id, qty: l.qty_received_base,
    reason: 'purchase_receipt', ref: { type: 'grn', id: g.id }, actorId: scope.userId, idempotencyKey: `grn:${g.id}:${l.id}`,
    entered: { quantity: l.entered_qty, unit: l.entered_unit }, unitCost: isZero(l.unit_cost) ? null : l.unit_cost, occurredAt: g.received_at,
    note: `${g.number}${po ? ` / ${po.number}` : ' (unplanned)'}` })));
  for (const [i, l] of accepted.entries()) await db.query('update public.grn_lines set movement_id = $2 where id = $1', [l.id, results[i].movement.id]);

  // The order's running totals and status.
  let poStatus = po?.status || null;
  if (po) {
    for (const l of accepted.filter((x) => x.po_line_id)) await guarded(() => db.query('update public.po_lines set received_base = received_base + $2 where id = $1', [l.po_line_id, l.qty_received_base]));
    const fresh = await loadPoLines(db, po.id);
    const all = fresh.every((l) => cmp(l.received_base, l.qty_base) >= 0);
    const target = all ? 'received' : 'partially_received';
    // 'received' never goes back to 'partially_received' (the database refuses it); only forward steps are taken.
    if (target !== po.status && !(po.status === 'received')) {
      await guarded(() => db.query('update public.purchase_orders set status = $2 where id = $1', [po.id, target]));
      poStatus = target;
    }
  }
  await guarded(() => db.query(`update public.goods_receipts set status = 'posted', posted_at = now(), received_by = coalesce(received_by, $2) where id = $1`, [g.id, scope.userId]));
  await record(db, { businessId: scope.businessId, locationId: g.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'goods_receipt', entityId: g.id, action: 'post',
    before: { status: 'draft' }, after: { status: 'posted', number: g.number, poId: g.po_id, poStatus, movements: results.map((r) => r.movement.id), overDeliveryConfirmed: warnings.some((w) => w.code === 'over_delivery'),
      rejected: lines.filter((l) => !isZero(l.qty_rejected_base)).map((l) => ({ itemId: l.item_id, base: l.qty_rejected_base, reason: l.reject_reason })) } });

  for (const a of alerts) {
    const name = a.item.name;
    const message = `${name} cost ${trimZeros(a.pct)}% more than ${a.label} on ${g.number}.`;
    warnings.push({ code: 'price_variance', itemId: a.line.item_id, pct: a.pct, against: a.label, message });
    await notify(db, { businessId: scope.businessId, recipients: 'owners', kind: 'price_variance', title: `${name} cost more than expected`,
      body: `${message} Paid ${kes(mul(a.line.unit_cost, a.line.unit_factor, MONEY))} per ${a.line.entered_unit}.`, link: `/owner/inventory/receipts/${g.id}`,
      entity: { type: 'grn', id: g.id }, locationId: g.location_id, dedupeKey: `price_variance:${a.line.id}` });
  }
  if (!g.po_id) {
    const place = scope.locations.find((l) => l.id === g.location_id);
    await notify(db, { businessId: scope.businessId, recipients: 'owners', kind: 'unplanned_receipt', title: `Delivery without an order at ${placeName(place) || 'a location'}`,
      body: `${g.number}: ${g.unplanned_reason}`, link: `/owner/inventory/receipts/${g.id}`, entity: { type: 'grn', id: g.id }, locationId: g.location_id, dedupeKey: `unplanned:${g.id}`, exclude: [scope.userId] });
  }
  return { receipt: await grnView(db, scope, await loadGrn(db, scope, g.id)), warnings, replayed: false };
}

/**
 * Dry run for the screen: the same price rule as posting, per line, with NO writes. Same inputs as createReceipt (poId, or supplierId for an
 * unplanned delivery; no reason needed yet). Returns { lines: [{ itemId, itemName, costPerUnit, unit, orderPricePerUnit, lastPricePerUnit, warning }], warnings }.
 */
export async function checkReceipt(db, scope, body = {}, { today = todayNairobi() } = {}) {
  let po = null; let poLines = []; let locationId; let supplierId;
  if (!empty(body.poId)) {
    po = await loadPo(db, scope, body.poId);
    locationId = po.deliver_to_location_id; supplierId = po.supplier_id; poLines = await loadPoLines(db, po.id);
  } else {
    locationId = empty(body.locationId) ? scope.centerLocationId : needId(body.locationId, 'The location');
    supplierId = needId(body.supplierId, 'The supplier');
  }
  requireReceive(scope, locationId);
  const input = Array.isArray(body.lines) ? body.lines : (po ? await prefill(db, scope, poLines) : null);
  const lines = await buildReceiptLines(db, scope, { po, poLines, supplierId, locationId, input, today });
  const pct = await getSetting(db, scope.businessId, 'price_variance_alert_pct', locationId);
  const out = []; const warnings = [];
  for (const l of lines) {
    const item = await loadOrderItem(db, scope.businessId, l.itemId);
    const hit = isZero(l.receivedBase) ? null : priceAlert({ unitCost: l.unitCost, poPricePerBase: l.poLine?.price_per_base, lastCost: item.lastCost }, pct);
    const perUnit = (v) => (v === null || v === undefined ? null : mul(v, l.unitFactor, MONEY).toString(MONEY));
    let warning = null;
    if (hit) {
      warning = { code: 'price_variance', itemId: l.itemId, pct: hit.pct, against: hit.label, message: `${item.name} would cost ${trimZeros(hit.pct)}% more than ${hit.label}.` };
      warnings.push(warning);
    }
    out.push({ itemId: l.itemId, itemName: item.name, unit: l.enteredUnit, costPerUnit: perUnit(l.unitCost), orderPricePerUnit: perUnit(l.poLine?.price_per_base), lastPricePerUnit: perUnit(item.lastCost), warning });
  }
  return { lines: out, warnings };
}

/** Create and post in one go (the usual "I'm standing at the door" flow). Same inputs as createReceipt plus confirmOverDelivery. */
export async function receive(db, scope, body = {}, options = {}) {
  const made = await createReceipt(db, scope, body, options);
  return postReceipt(db, scope, made.receipt.id, { confirmOverDelivery: body.confirmOverDelivery === true, today: options.today });
}

/* ---------- reverse ---------- */

/** Undoes a posted receipt: reverses each stock movement (refused when some of the stock has been used) and takes the quantities off the order. Refused after a return. */
export async function reverseReceipt(db, scope, id, { reason } = {}) {
  const g = await loadGrn(db, scope, id, { lock: true });
  requireReceive(scope, g.location_id);
  const text = readText(reason, 300, 'the reason');
  if (!text) throw fail(400, 'Say why you are reversing this receipt.', 'reason_required');
  if (g.status === 'reversed') return { receipt: await grnView(db, scope, g), replayed: true };
  if (g.status !== 'posted') throw fail(409, 'Only a posted receipt can be reversed. Delete or edit the draft instead.', 'grn_not_posted');
  const lines = await loadGrnLines(db, g.id);
  if ((await db.query(`select 1 from public.supplier_returns where grn_id = $1 and status = 'posted' limit 1`, [g.id])).rows.length) {
    throw fail(409, 'Some of this delivery has already been sent back to the supplier, so the receipt can’t be reversed.', 'grn_has_returns');
  }
  const units = await loadUnits(db);
  const problems = [];
  for (const l of lines.filter((x) => x.movement_id)) {
    const item = await loadOrderItem(db, scope.businessId, l.item_id);
    const bal = await ledger.balance(db, g.location_id, l.item_id);
    if (cmp(bal.available, l.qty_received_base) < 0) {
      problems.push(`${item.name}: ${display(l.qty_received_base, plainItem(item), units)} came in, only ${display(bal.available, plainItem(item), units)} is still here`);
    }
  }
  if (problems.length) throw fail(409, `Some of this delivery has already been used, so it can’t be reversed. ${problems.join('; ')}. Record what is left as a return to the supplier, or use a wastage or stock adjustment for the rest.`, 'cannot_reverse', { problems });
  for (const l of lines.filter((x) => x.movement_id)) {
    await ledger.reverse(db, { movementId: l.movement_id, actorId: scope.userId, note: `Reversal of ${g.number}: ${text}`, idempotencyKey: `grn-rev:${g.id}:${l.id}` });
  }
  if (g.po_id) {
    await loadPo(db, scope, g.po_id, { lock: true });
    for (const l of lines.filter((x) => x.po_line_id && !isZero(x.qty_received_base))) await guarded(() => db.query('update public.po_lines set received_base = received_base - $2 where id = $1', [l.po_line_id, l.qty_received_base]));
  }
  const notes = `${g.notes ? `${g.notes}\n` : ''}Reversed: ${text}`.slice(0, 500);
  await guarded(() => db.query(`update public.goods_receipts set status = 'reversed', notes = $2 where id = $1`, [g.id, notes]));
  await record(db, { businessId: scope.businessId, locationId: g.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'goods_receipt', entityId: g.id, action: 'reverse',
    before: { status: 'posted' }, after: { status: 'reversed', reason: text } });
  await notify(db, { businessId: scope.businessId, recipients: 'owners', kind: 'receipt_reversed', title: `Receipt ${g.number} was reversed`, body: text, link: `/owner/inventory/receipts/${g.id}`,
    entity: { type: 'grn', id: g.id }, locationId: g.location_id, dedupeKey: `grn-reversed:${g.id}`, exclude: [scope.userId] });
  const warnings = [];
  if (g.po_id) warnings.push({ code: 'po_status', message: 'The order’s quantities went back, but its status is not changed. If it shows “Received”, check what is still due before you close it.' });
  return { receipt: await grnView(db, scope, await loadGrn(db, scope, g.id)), warnings, replayed: false };
}

/* ---------- supplier invoices (GRN-2) ---------- */

const INVOICE_COLUMNS = `i.id, i.supplier_id, i.po_id, i.invoice_no, i.invoice_date::text as invoice_date, i.supplier_pin, i.etims_invoice_no, i.invoice_status, i.no_invoice_reason,
  i.amount::text as amount, i.vat::text as vat, i.payment_status, i.paid_amount::text as paid_amount, i.due_date::text as due_date, i.notes, i.created_by, i.created_at, i.updated_at`;

function requireInvoiceAccess(scope) {
  requireCan(scope, 'inv.view');
  if (!oversees(scope)) throw fail(403, 'You don’t have access to this.', 'forbidden');
}
function requireInvoiceEdit(scope) {
  requireCan(scope, 'inv.purchase.create');
  if (!scope.roles.includes('owner')) throw fail(403, 'You don’t have access to this.', 'forbidden');
}

async function loadInvoiceRow(db, scope, id, { supplierId = null } = {}) {
  const row = (await db.query(`select ${INVOICE_COLUMNS} from public.supplier_invoices i where i.id = $1 and i.business_id = $2`, [needId(id, 'The invoice'), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That invoice isn’t in this business.', 'invoice_not_found');
  if (supplierId && row.supplier_id !== supplierId) throw fail(409, 'That invoice is from a different supplier.', 'wrong_supplier');
  return row;
}

async function invoiceView(db, scope, row) {
  const receipts = (await db.query(`select g.id, g.number, g.status, g.location_id,
      coalesce((select sum(l.qty_received_base * l.unit_cost) from public.grn_lines l where l.grn_id = g.id), 0)::numeric(14, 2)::text as value
    from public.goods_receipts g where g.invoice_id = $1 order by g.created_at`, [row.id])).rows;
  const supplier = (await db.query('select name from public.suppliers where id = $1', [row.supplier_id])).rows[0];
  const received = receipts.filter((r) => r.status === 'posted').reduce((sum, r) => add(sum, r.value, MONEY), dec('0', { scale: MONEY }));
  const files = await listAttachments(db, scope, { entityType: 'invoice', entityId: row.id });
  return { id: row.id, supplierId: row.supplier_id, supplierName: supplier?.name || null, poId: row.po_id, invoiceNo: row.invoice_no, invoiceDate: row.invoice_date,
    supplierPin: row.supplier_pin, etimsInvoiceNo: row.etims_invoice_no, invoiceStatus: row.invoice_status, noInvoiceReason: row.no_invoice_reason, amount: row.amount, vat: row.vat,
    paymentStatus: row.payment_status, paidAmount: row.paid_amount, dueDate: row.due_date, notes: row.notes, createdAt: row.created_at,
    receipts: receipts.map((r) => ({ id: r.id, number: r.number, status: r.status })), receivedValue: received.toString(MONEY),
    difference: sub(row.amount, received, MONEY).toString(MONEY), attachments: files };
}

async function linkReceipts(db, scope, invoice, grnIds) {
  for (const raw of grnIds) {
    const g = await loadGrn(db, scope, raw, { lock: true });
    if (g.supplier_id !== invoice.supplier_id) throw fail(409, `${g.number} is from a different supplier than this invoice.`, 'wrong_supplier');
    if (g.invoice_id && g.invoice_id !== invoice.id) throw fail(409, `${g.number} already has an invoice. Unlink it there first.`, 'grn_has_invoice');
    if (g.status === 'reversed') throw fail(409, `${g.number} was reversed, so it can’t be linked to an invoice.`, 'grn_reversed');
    await guarded(() => db.query('update public.goods_receipts set invoice_id = $2 where id = $1', [g.id, invoice.id]));
  }
}

function readInvoiceFields(body, base = {}) {
  const out = { ...base };
  if (has(body, 'invoiceStatus')) {
    if (!['etims', 'other', 'none'].includes(body.invoiceStatus)) throw fail(400, 'The invoice type must be etims, other or none.', 'bad_invoice_status');
    out.invoiceStatus = body.invoiceStatus;
  }
  if (has(body, 'invoiceNo')) out.invoiceNo = readText(body.invoiceNo, 60, 'the invoice number');
  if (has(body, 'invoiceDate')) out.invoiceDate = readDate(body.invoiceDate, 'The invoice date');
  if (has(body, 'supplierPin')) out.supplierPin = empty(body.supplierPin) ? null : normalisePin(body.supplierPin);
  if (has(body, 'etimsInvoiceNo')) out.etimsInvoiceNo = readText(body.etimsInvoiceNo, 60, 'the eTIMS number');
  if (has(body, 'noInvoiceReason')) out.noInvoiceReason = readText(body.noInvoiceReason, 300, 'the reason');
  if (has(body, 'amount')) {
    const a = dec(body.amount, { scale: MONEY, round: 'exact', label: 'The invoice amount' });
    if (isNeg(a)) throw fail(400, 'The invoice amount can’t be negative.', 'bad_amount');
    out.amount = a.toString(MONEY);
  }
  if (has(body, 'vat')) {
    const v = dec(empty(body.vat) ? '0' : body.vat, { scale: MONEY, round: 'exact', label: 'The VAT amount' });
    if (isNeg(v)) throw fail(400, 'The VAT amount can’t be negative.', 'bad_amount');
    out.vat = v.toString(MONEY);
  }
  if (has(body, 'dueDate')) out.dueDate = readDate(body.dueDate, 'The due date');
  if (has(body, 'notes')) out.notes = readText(body.notes, 500, 'the notes');
  return out;
}

function checkInvoice(f) {
  if (f.invoiceStatus === 'none') {
    if (!f.noInvoiceReason) throw fail(400, 'You said there is no invoice. Say why (for example: market stall, only an M-Pesa message).', 'no_invoice_reason_required');
  } else {
    if (!f.invoiceNo) throw fail(400, 'Enter the invoice number.', 'invoice_no_required');
    if (!f.invoiceDate) throw fail(400, 'Enter the invoice date.', 'invoice_date_required');
  }
  if (f.invoiceStatus === 'etims' && !f.etimsInvoiceNo) throw fail(400, 'An eTIMS invoice has an eTIMS number. Enter it, or choose “other invoice”.', 'etims_no_required');
  if (cmp(f.vat, f.amount) > 0) throw fail(400, 'The VAT can’t be more than the invoice total.', 'bad_vat');
}

async function ensureNotDuplicate(db, scope, supplierId, invoiceNo, exceptId = null) {
  if (!invoiceNo) return;
  const dup = (await db.query(`select id from public.supplier_invoices where supplier_id = $1 and lower(btrim(invoice_no)) = lower(btrim($2)) and ($3::uuid is null or id <> $3::uuid)`, [supplierId, invoiceNo, exceptId])).rows[0];
  if (dup) {
    const name = (await db.query('select name from public.suppliers where id = $1', [supplierId])).rows[0]?.name || 'this supplier';
    throw fail(409, `Invoice ${invoiceNo} from ${name} is already recorded. Check you aren’t entering it twice.`, 'duplicate_invoice', { invoiceId: dup.id });
  }
}

/**
 * Records a supplier's invoice. body: { supplierId, poId?, grnIds?, invoiceStatus ('etims'|'other'|'none'), invoiceNo, invoiceDate, supplierPin?, etimsInvoiceNo?,
 * noInvoiceReason (when none), amount, vat?, dueDate?, notes? }. The same number from the same supplier is refused. Photos attach afterwards with the
 * attachments API (entityType 'invoice').
 */
export async function createInvoice(db, scope, body = {}) {
  requireInvoiceEdit(scope);
  const supplierId = needId(body.supplierId, 'The supplier');
  const supplier = (await db.query('select id, kra_pin, payment_terms_days from public.suppliers where id = $1 and business_id = $2', [supplierId, scope.businessId])).rows[0];
  if (!supplier) throw fail(404, 'That supplier isn’t in this business. Pick one from the suppliers list.', 'supplier_not_found');
  const f = readInvoiceFields({ invoiceStatus: 'other', vat: '0', ...body }, { amount: '0.00', vat: '0.00', supplierPin: supplier.kra_pin });
  if (!has(body, 'amount') || empty(body.amount)) throw fail(400, 'Enter the invoice total.', 'amount_required');
  checkInvoice(f);
  let poId = null;
  if (!empty(body.poId)) {
    const po = await loadPo(db, scope, body.poId);
    if (po.supplier_id !== supplierId) throw fail(409, 'That order is with a different supplier.', 'wrong_supplier');
    poId = po.id;
  }
  const grnIds = Array.isArray(body.grnIds) ? body.grnIds : [];
  if (!poId && grnIds.length) {
    const pos = new Set((await db.query('select po_id from public.goods_receipts where id = any($1::uuid[]) and business_id = $2', [grnIds.map((x) => needId(x, 'The goods receipt')), scope.businessId])).rows.map((r) => r.po_id));
    if (pos.size === 1 && [...pos][0]) poId = [...pos][0];
  }
  await ensureNotDuplicate(db, scope, supplierId, f.invoiceStatus === 'none' ? null : f.invoiceNo);
  const row = (await guarded(() => db.query(`insert into public.supplier_invoices (business_id, supplier_id, po_id, invoice_no, invoice_date, supplier_pin, etims_invoice_no, invoice_status,
    no_invoice_reason, amount, vat, due_date, notes, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
  [scope.businessId, supplierId, poId, f.invoiceStatus === 'none' ? null : f.invoiceNo, f.invoiceStatus === 'none' ? null : f.invoiceDate, f.supplierPin ?? null, f.etimsInvoiceNo ?? null, f.invoiceStatus,
    f.invoiceStatus === 'none' ? f.noInvoiceReason : (f.noInvoiceReason ?? null), f.amount, f.vat, f.dueDate ?? null, f.notes ?? null, scope.userId]))).rows[0];
  const invoice = await loadInvoiceRow(db, scope, row.id);
  await linkReceipts(db, scope, invoice, grnIds);
  await record(db, { businessId: scope.businessId, actorId: scope.userId, actorRole: scope.role, entity: 'supplier_invoice', entityId: row.id, action: 'create',
    before: null, after: { supplierId, poId, invoiceNo: invoice.invoice_no, invoiceStatus: f.invoiceStatus, amount: f.amount, vat: f.vat, grnIds } });
  return getInvoice(db, scope, row.id);
}

/** Changes an invoice's details or links more receipts (grnIds). The supplier can't change; payment fields arrive with the payments feature. */
export async function updateInvoice(db, scope, id, patch = {}) {
  requireInvoiceEdit(scope);
  const row = await loadInvoiceRow(db, scope, id);
  const base = { invoiceStatus: row.invoice_status, invoiceNo: row.invoice_no, invoiceDate: row.invoice_date, supplierPin: row.supplier_pin, etimsInvoiceNo: row.etims_invoice_no,
    noInvoiceReason: row.no_invoice_reason, amount: row.amount, vat: row.vat, dueDate: row.due_date, notes: row.notes };
  const f = readInvoiceFields(patch, base);
  if (f.invoiceStatus === 'none') { f.invoiceNo = null; f.invoiceDate = null; }
  checkInvoice(f);
  if (row.payment_status !== 'unpaid' && (cmp(f.amount, row.amount) !== 0)) throw fail(409, 'Part of this invoice is already paid, so the total can’t change.', 'invoice_paid');
  await ensureNotDuplicate(db, scope, row.supplier_id, f.invoiceStatus === 'none' ? null : f.invoiceNo, row.id);
  await guarded(() => db.query(`update public.supplier_invoices set invoice_no = $2, invoice_date = $3, supplier_pin = $4, etims_invoice_no = $5, invoice_status = $6, no_invoice_reason = $7,
    amount = $8, vat = $9, due_date = $10, notes = $11, updated_at = now() where id = $1`,
  [row.id, f.invoiceNo, f.invoiceDate, f.supplierPin, f.etimsInvoiceNo, f.invoiceStatus, f.noInvoiceReason, f.amount, f.vat, f.dueDate, f.notes]));
  if (Array.isArray(patch.grnIds) && patch.grnIds.length) await linkReceipts(db, scope, row, patch.grnIds.map((x) => needId(x, 'The goods receipt')));
  const change = diff(base, f);
  await record(db, { businessId: scope.businessId, actorId: scope.userId, actorRole: scope.role, entity: 'supplier_invoice', entityId: row.id, action: 'update',
    before: change.before, after: { ...change.after, ...(patch.grnIds?.length ? { linked: patch.grnIds } : {}) } });
  return getInvoice(db, scope, row.id);
}

export async function getInvoice(db, scope, id) {
  requireInvoiceAccess(scope);
  return { invoice: await invoiceView(db, scope, await loadInvoiceRow(db, scope, id)) };
}

/** { supplierId, status ('unpaid'|'part_paid'|'paid'), search (invoice number), limit, before } */
export async function listInvoices(db, scope, { supplierId, status, search, limit = 50, before } = {}) {
  requireInvoiceAccess(scope);
  if (!empty(status) && !['unpaid', 'part_paid', 'paid'].includes(status)) throw fail(400, 'The payment status must be unpaid, part_paid or paid.', 'bad_status');
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const cursor = before ? new Date(before) : null;
  if (cursor && Number.isNaN(cursor.getTime())) throw fail(400, 'The page marker is invalid. Start from the top.', 'bad_cursor');
  const { rows } = await db.query(`select ${INVOICE_COLUMNS}, s.name as supplier_name from public.supplier_invoices i join public.suppliers s on s.id = i.supplier_id
    where i.business_id = $1 and ($2::uuid is null or i.supplier_id = $2::uuid) and ($3::text is null or i.payment_status = $3)
      and ($4::text is null or position(lower($4) in lower(coalesce(i.invoice_no, ''))) > 0) and ($5::timestamptz is null or i.created_at < $5::timestamptz)
    order by i.created_at desc, i.id desc limit $6`,
  [scope.businessId, empty(supplierId) ? null : needId(supplierId, 'The supplier'), empty(status) ? null : status, empty(search) ? null : String(search).trim().slice(0, 60), cursor ? cursor.toISOString() : null, size + 1]);
  const page = rows.slice(0, size);
  return { invoices: page.map((r) => ({ id: r.id, supplierId: r.supplier_id, supplierName: r.supplier_name, invoiceNo: r.invoice_no, invoiceDate: r.invoice_date, invoiceStatus: r.invoice_status,
    amount: r.amount, vat: r.vat, paymentStatus: r.payment_status, dueDate: r.due_date, poId: r.po_id, createdAt: r.created_at })),
  nextBefore: rows.length > size ? new Date(page.at(-1).created_at).toISOString() : null };
}

/* ---------- returns to the supplier (PRC-6) ---------- */

async function returnView(db, scope, row) {
  const units = await loadUnits(db);
  const lines = (await db.query(`select rl.id, rl.grn_line_id, rl.item_id, rl.qty_base::text as qty_base, rl.reason, rl.credit_amount::text as credit_amount, rl.movement_id::text as movement_id
    from public.supplier_return_lines rl where rl.return_id = $1 order by rl.created_at, rl.id`, [row.id])).rows;
  const supplier = (await db.query('select name from public.suppliers where id = $1', [row.supplier_id])).rows[0];
  const grn = (await db.query('select number from public.goods_receipts where id = $1', [row.grn_id])).rows[0];
  const showCost = can(scope, 'inv.cost.view', { locationId: row.location_id });
  const out = [];
  for (const l of lines) {
    const item = await loadOrderItem(db, scope.businessId, l.item_id);
    const view = { id: l.id, grnLineId: l.grn_line_id, itemId: l.item_id, itemName: item.name, qtyBase: l.qty_base, quantity: display(l.qty_base, itemForUnits(item), units), reason: l.reason, movementId: l.movement_id };
    if (showCost) view.creditAmount = l.credit_amount;
    out.push(view);
  }
  const view = { id: row.id, number: row.number, status: row.status, supplierId: row.supplier_id, supplierName: supplier?.name || null, locationId: row.location_id, grnId: row.grn_id,
    grnNumber: grn?.number || null, reason: row.reason, notes: row.notes, postedAt: row.posted_at, createdAt: row.created_at, lines: out };
  if (showCost) view.creditTotal = row.credit_total;
  return view;
}
const RETURN_COLUMNS = `r.id, r.number, r.supplier_id, r.location_id, r.grn_id, r.status, r.reason, r.credit_total::text as credit_total, r.notes, r.posted_at, r.created_at`;

export async function getReturn(db, scope, id) {
  const row = (await db.query(`select ${RETURN_COLUMNS} from public.supplier_returns r where r.id = $1 and r.business_id = $2`, [needId(id, 'The return'), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That return isn’t in this business.', 'return_not_found');
  requireCan(scope, 'inv.view', { locationId: row.location_id });
  return { return: await returnView(db, scope, row) };
}

/** { grnId, supplierId, locationId, limit, before } */
export async function listReturns(db, scope, { grnId, supplierId, locationId, limit = 50, before } = {}) {
  requireCan(scope, 'inv.view');
  const where = locationsWith(scope, 'inv.view');
  if (!empty(locationId) && !where.includes(needId(locationId, 'The location'))) throw fail(403, 'You don’t have access to this.', 'forbidden');
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const cursor = before ? new Date(before) : null;
  if (cursor && Number.isNaN(cursor.getTime())) throw fail(400, 'The page marker is invalid. Start from the top.', 'bad_cursor');
  const { rows } = await db.query(`select ${RETURN_COLUMNS}, s.name as supplier_name, g.number as grn_number from public.supplier_returns r join public.suppliers s on s.id = r.supplier_id
    join public.goods_receipts g on g.id = r.grn_id where r.business_id = $1 and r.location_id = any($2::uuid[]) and ($3::uuid is null or r.grn_id = $3::uuid)
      and ($4::uuid is null or r.supplier_id = $4::uuid) and ($5::uuid is null or r.location_id = $5::uuid) and ($6::timestamptz is null or r.created_at < $6::timestamptz)
    order by r.created_at desc, r.id desc limit $7`,
  [scope.businessId, where, empty(grnId) ? null : needId(grnId, 'The goods receipt'), empty(supplierId) ? null : needId(supplierId, 'The supplier'), empty(locationId) ? null : locationId, cursor ? cursor.toISOString() : null, size + 1]);
  const page = rows.slice(0, size);
  return { returns: page.map((r) => {
    const out = { id: r.id, number: r.number, status: r.status, supplierId: r.supplier_id, supplierName: r.supplier_name, grnId: r.grn_id, grnNumber: r.grn_number, locationId: r.location_id,
      reason: r.reason, postedAt: r.posted_at, createdAt: r.created_at };
    if (can(scope, 'inv.cost.view', { locationId: r.location_id })) out.creditTotal = r.credit_total;
    return out;
  }), nextBefore: rows.length > size ? new Date(page.at(-1).created_at).toISOString() : null };
}

/**
 * Sends goods from a posted receipt back to the supplier and takes them out of stock (supplier_return, at the receipt's cost). body:
 * { grnId, reason, lines: [{ grnLineId, qty, unit?, reason?, creditAmount? }], creditAmount? (the credit the supplier agreed; default quantity x cost), notes? }.
 * Refused beyond what that delivery added minus what was already returned, and when the stock has been used (stock stops at zero).
 */
export async function returnToSupplier(db, scope, body = {}) {
  const g = await loadGrn(db, scope, body.grnId, { lock: true });
  requireReceive(scope, g.location_id);
  if (g.status !== 'posted') throw fail(409, g.status === 'reversed' ? 'This receipt was reversed, so there is nothing to return.' : 'Post the receipt first. A return is made against goods that arrived.', 'grn_not_posted');
  const reason = readText(body.reason, 300, 'the reason');
  if (!Array.isArray(body.lines) || !body.lines.length) throw fail(400, 'Choose what you are sending back.', 'lines_required');
  const units = await loadUnits(db);
  const grnLines = await loadGrnLines(db, g.id);
  const returned = await returnedMap(db, g.id);
  const prepared = []; const seen = new Set();
  for (const [index, entry] of body.lines.entries()) {
    const line = grnLines.find((l) => l.id === String(entry?.grnLineId ?? '').toLowerCase());
    if (!line) throw fail(400, `Line ${index + 1} isn’t on ${g.number}.`, 'not_on_receipt');
    if (seen.has(line.id)) throw fail(400, 'A receipt line is listed twice. Combine the amounts into one line.', 'duplicate_line');
    seen.add(line.id);
    const item = await loadOrderItem(db, scope.businessId, line.item_id);
    const view = plainItem(item);
    const unitText = empty(entry.unit) ? line.entered_unit : String(entry.unit);
    const q = dec(entry.qty ?? entry.quantity, { label: `The amount of ${item.name}` });
    if (isZero(q) || isNeg(q)) throw fail(400, `${item.name}: enter how much you are sending back (more than zero).`, 'qty_required');
    const qtyBase = toBase(q.toString(), unitText, itemForUnits(item), units, { positive: true, label: `The amount of ${item.name}` });
    const already = returned.get(line.id) || '0';
    const left = sub(line.qty_received_base, already, QTY);
    if (cmp(qtyBase, left) > 0) {
      throw fail(409, `Only ${display(left.toString(QTY), view, units)} of ${item.name} from ${g.number} can still be sent back (${display(line.qty_received_base, view, units)} arrived${isZero(already) ? '' : `, ${display(already, view, units)} already returned`}).`, 'return_too_much', { itemId: item.id, remainingBase: left.toString(QTY) });
    }
    const here = await ledger.balance(db, g.location_id, line.item_id);
    if (cmp(qtyBase, here.available) > 0) {
      throw fail(409, `Only ${display(here.available, view, units)} of ${item.name} from this delivery is still here, so you can’t send back ${display(qtyBase, view, units)}. The rest has been used.`, 'return_stock_used', { itemId: item.id, availableBase: here.available });
    }
    const lineReason = readText(entry.reason, 300, 'the reason') || reason;
    if (!lineReason) throw fail(400, 'Say why you are sending these goods back (for example: spoiled, wrong item, short shelf life).', 'reason_required');
    let credit;
    if (!empty(entry.creditAmount)) credit = dec(entry.creditAmount, { scale: MONEY, round: 'exact', label: 'The credit amount' });
    else credit = mul(qtyBase, line.unit_cost, MONEY);
    if (isNeg(credit)) throw fail(400, 'The credit amount can’t be negative.', 'bad_amount');
    prepared.push({ line, item, view, q, unit: unitText, qtyBase, reason: lineReason, credit });
  }
  let creditTotal = prepared.reduce((s, p) => add(s, p.credit, MONEY), dec('0', { scale: MONEY }));
  if (!empty(body.creditAmount)) {
    creditTotal = dec(body.creditAmount, { scale: MONEY, round: 'exact', label: 'The credit amount' });
    if (isNeg(creditTotal)) throw fail(400, 'The credit amount can’t be negative.', 'bad_amount');
    if (prepared.length === 1 && empty(body.lines[0].creditAmount)) prepared[0].credit = creditTotal;
  }
  const number = await nextNumber(db, { businessId: scope.businessId, kind: 'RET' });
  const header = (await guarded(() => db.query(`insert into public.supplier_returns (business_id, number, supplier_id, location_id, grn_id, reason, notes, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [scope.businessId, number, g.supplier_id, g.location_id, g.id, reason, readText(body.notes, 500, 'the notes'), scope.userId]))).rows[0];
  const movements = [];
  for (const p of prepared) {
    const result = await ledger.post(db, { businessId: scope.businessId, locationId: g.location_id, itemId: p.item.id, qty: `-${p.qtyBase}`, reason: 'supplier_return',
      ref: { type: 'return', id: header.id }, actorId: scope.userId, idempotencyKey: `ret:${header.id}:${p.line.id}`,
      entered: { quantity: p.q.toString(QTY), unit: p.unit }, unitCost: isZero(p.line.unit_cost) ? null : p.line.unit_cost, note: `${number} to supplier (${g.number}): ${p.reason}` });
    movements.push(result.movement.id);
    await guarded(() => db.query(`insert into public.supplier_return_lines (business_id, return_id, grn_line_id, item_id, qty_base, reason, credit_amount, movement_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8)`, [scope.businessId, header.id, p.line.id, p.item.id, p.qtyBase, p.reason, p.credit.toString(MONEY), result.movement.id]));
  }
  await guarded(() => db.query(`update public.supplier_returns set status = 'posted', posted_at = now(), posted_by = $2, credit_total = $3 where id = $1`, [header.id, scope.userId, creditTotal.toString(MONEY)]));
  await record(db, { businessId: scope.businessId, locationId: g.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'supplier_return', entityId: header.id, action: 'post',
    before: null, after: { number, grnId: g.id, reason, creditTotal: creditTotal.toString(MONEY), lines: prepared.map((p) => ({ itemId: p.item.id, qtyBase: p.qtyBase, credit: p.credit.toString(MONEY) })), movements } });
  const row = (await db.query(`select ${RETURN_COLUMNS} from public.supplier_returns r where r.id = $1`, [header.id])).rows[0];
  return { return: await returnView(db, scope, row) };
}

export { receiveCapability };
