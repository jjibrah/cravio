// Suppliers, what they supply and their price lists (P2-04, migration 015).
// Every function takes (db, scope, ...): `db` is a query-able handle (a transaction for writes), `scope` comes from
// permissions.inventoryScope(). Services re-check capabilities (synchronous, no audit); routes authorize (and audit denials)
// BEFORE opening the write transaction. Each change appends an audit event (audit.record) in the same transaction.
//
// Who may do what (09 P2-04, D2-14):
//   owner               everything, including bank and M-Pesa details (only the owner ever sees or edits those)
//   operations manager  read-only: suppliers, items, and prices when they hold inv.cost.view; no bank/M-Pesa details
//   branch manager      the emergency picker only (names, no bank data) and adding an on-the-spot supplier (incomplete = true)
//   waiter / others     nothing
// Money is exact: KES prices are numeric(14,2) per ONE unit of the item (a crate, a kg); price_per_base is KES per base unit
// (g, ml, piece) at 6 decimals, so KES 6,500 per crate of 10 kg is 0.65 per g and prices in different units compare.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { MONEY, COST, dec, div, mul, sub, cmp, isNeg, isZero } from './decimal.js';
import { compatibleUnits, normaliseUnit, toBase } from './units.js';
import { loadUnits } from './catalogue.js';
import { can, requireCan } from './permissions.js';
import { getSetting } from './policies.js';
import { diff, record } from './audit.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const SUPPLIER_TYPES = Object.freeze(['formal', 'informal', 'one_off']);
export const PAYMENT_METHODS = Object.freeze(['cash', 'mpesa', 'bank', 'credit']);
export const SUPPLIER_STATUSES = Object.freeze(['active', 'inactive', 'archived']);
const MAX_ITEMS_PER_SUPPLIER = 500;
const MAX_ON_THE_SPOT_PER_DAY = 10;
const PRICE_WINDOW_DAYS = 366;
const OPEN_PO_EXCLUDED = ['received', 'closed', 'cancelled'];

/* ---------- small helpers ---------- */

const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const has = (obj, key) => obj && typeof obj === 'object' && Object.hasOwn(obj, key);
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is invalid.`, 'bad_id');
  return value.toLowerCase();
};
const trimZeros = (text) => (String(text).includes('.') ? String(text).replace(/0+$/, '').replace(/\.$/, '') : String(text));
const mask = (v) => (v ? `…${String(v).slice(-4)}` : null);

/** Today's date in Nairobi as YYYY-MM-DD (`now` is injectable for tests). */
export function todayNairobi(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
function readDate(value, label, fallback) {
  if (empty(value)) return fallback;
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const d = m && new Date(`${text}T00:00:00Z`);
  if (!m || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) throw fail(400, `${label} must be a date like 2026-11-18.`, 'bad_date');
  return text;
}

/** True for the people who may look at the supplier list: the owner and operations managers. */
export const oversees = (scope) => scope.roles.includes('owner') || scope.roles.includes('operations');
const isOwner = (scope) => scope.roles.includes('owner');

function requireOversight(scope) {
  requireCan(scope, 'inv.view');
  if (!oversees(scope)) throw fail(403, 'You don’t have access to this.', 'forbidden');
}
const requireEdit = (scope) => requireCan(scope, 'inv.purchase.create');

/* ---------- field readers (plain messages) ---------- */

function readName(value) {
  const name = tidy(value);
  if (!name) throw fail(400, 'Enter the supplier’s name.', 'name_required');
  if (name.length > 80) throw fail(400, 'Keep the name under 80 characters.', 'name_too_long');
  return name;
}
function readChoice(value, options, label) {
  if (!options.includes(value)) throw fail(400, `${label} must be one of: ${options.join(', ')}.`, 'bad_choice');
  return value;
}
/** 0712 345 678, 0112345678, +254 712 345 678, 254712345678, 712345678 -> '254712345678'. */
export function normalisePhone(value) {
  const digits = String(value).trim().replace(/[\s\-().]/g, '');
  const m = /^(?:\+?254|0)?([17][0-9]{8})$/.exec(digits);
  if (!m) throw fail(400, 'Enter a Kenyan mobile number like 0712 345 678 (it is saved as 254712345678).', 'bad_phone');
  return `254${m[1]}`;
}
const readPhone = (v) => (empty(v) ? null : normalisePhone(v));
function readEmail(value) {
  if (empty(value)) return null;
  const email = String(value).trim().toLowerCase();
  if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Enter an email address like orders@supplier.co.ke.', 'bad_email');
  return email;
}
/** KRA PIN: a letter (A for a person, P for a company), nine digits, a letter: A123456789B. */
export function normalisePin(value) {
  const pin = String(value).trim().replace(/[\s-]/g, '').toUpperCase();
  if (!/^[AP][0-9]{9}[A-Z]$/.test(pin)) throw fail(400, 'A KRA PIN looks like A123456789B (a letter, nine digits, a letter). Leave it empty if you don’t have it.', 'bad_pin');
  return pin;
}
const readPin = (v) => (empty(v) ? null : normalisePin(v));
function readText(max, label) {
  return (value) => {
    if (empty(value)) return null;
    const text = String(value).trim();
    if (text.length > max) throw fail(400, `Keep ${label} under ${max} characters.`, 'text_too_long');
    return text;
  };
}
function readTerms(value) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0 || n > 180) throw fail(400, 'Payment terms are a whole number of days from 0 to 180 (0 = pay on delivery).', 'bad_terms');
  return n;
}
function readTill(label) {
  return (value) => {
    if (empty(value)) return null;
    const text = String(value).trim().replace(/\s/g, '');
    if (!/^[0-9]{5,7}$/.test(text)) throw fail(400, `The ${label} is 5 to 7 digits.`, 'bad_mpesa');
    return text;
  };
}

/** Request field -> { column, read, ownerOnly }. */
const FIELDS = {
  name: { column: 'name', read: readName },
  type: { column: 'type', read: (v) => readChoice(v, SUPPLIER_TYPES, 'The supplier type') },
  contactName: { column: 'contact_name', read: readText(80, 'the contact name') },
  phone: { column: 'phone', read: readPhone },
  email: { column: 'email', read: readEmail },
  address: { column: 'address', read: readText(200, 'the address') },
  kraPin: { column: 'kra_pin', read: readPin },
  paymentTermsDays: { column: 'payment_terms_days', read: readTerms },
  paymentMethod: { column: 'payment_method', read: (v) => readChoice(v, PAYMENT_METHODS, 'The payment method') },
  mpesaTill: { column: 'mpesa_till', read: readTill('M-Pesa till number'), ownerOnly: true },
  mpesaPaybill: { column: 'mpesa_paybill', read: readTill('M-Pesa paybill number'), ownerOnly: true },
  mpesaAccount: { column: 'mpesa_account', read: readText(40, 'the paybill account'), ownerOnly: true },
  bankDetails: { column: 'bank_details', read: readText(300, 'the bank details'), ownerOnly: true },
  notes: { column: 'notes', read: readText(500, 'the notes') },
};
const REQUIRED_ON_EMPTY = new Set(['name', 'type', 'paymentTermsDays', 'paymentMethod']);

/* ---------- shapes ---------- */

const COLUMNS = `id, name, type, contact_name, phone, email, address, kra_pin, payment_terms_days, payment_method, mpesa_till, mpesa_paybill,
  mpesa_account, bank_details, status, incomplete, notes, created_by, created_at, updated_at`;

/** What the caller may see: bank and M-Pesa details only for the owner. */
function supplierView(row, scope) {
  const out = { id: row.id, name: row.name, type: row.type, contactName: row.contact_name, phone: row.phone, email: row.email, address: row.address,
    kraPin: row.kra_pin, paymentTermsDays: row.payment_terms_days, paymentMethod: row.payment_method, status: row.status, incomplete: row.incomplete,
    notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at };
  if (isOwner(scope)) Object.assign(out, { mpesaTill: row.mpesa_till, mpesaPaybill: row.mpesa_paybill, mpesaAccount: row.mpesa_account, bankDetails: row.bank_details });
  return out;
}
/** The audit view: no timestamps; bank and M-Pesa values masked to their last four characters. */
const auditView = (row) => ({ name: row.name, type: row.type, contactName: row.contact_name, phone: row.phone, email: row.email, address: row.address, kraPin: row.kra_pin,
  paymentTermsDays: row.payment_terms_days, paymentMethod: row.payment_method, mpesaTill: mask(row.mpesa_till), mpesaPaybill: mask(row.mpesa_paybill),
  mpesaAccount: mask(row.mpesa_account), bankDetails: mask(row.bank_details), status: row.status, incomplete: row.incomplete, notes: row.notes });

const audit = (db, scope, entity, entityId, action, before, after, locationId = null) => record(db, {
  businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity, entityId, action, before, after });

async function loadSupplier(db, scope, id, { lock = false } = {}) {
  const { rows } = await db.query(`select ${COLUMNS} from public.suppliers where id = $1 and business_id = $2 ${lock ? 'for update' : ''}`, [needId(id, 'The supplier'), scope.businessId]);
  if (!rows[0]) throw fail(404, 'That supplier isn’t in this business. Pick it from the supplier list.', 'supplier_not_found');
  return rows[0];
}

function mapDbError(e) {
  if (e instanceof HttpError) return e;
  if (e?.code === '23505' && /suppliers_name/.test(`${e.constraint || ''} ${e.message || ''}`)) {
    return fail(409, 'Another supplier already has that name. Use that one, or choose a different name.', 'name_taken');
  }
  return e;
}
async function guarded(fn) {
  try { return await fn(); } catch (e) { throw mapDbError(e); }
}

async function checkNameFree(db, scope, name, exceptId = null) {
  const { rows } = await db.query(`select id, name from public.suppliers where business_id = $1 and lower(btrim(name)) = lower($2) and ($3::uuid is null or id <> $3::uuid)`,
    [scope.businessId, name, exceptId]);
  if (rows[0]) throw fail(409, `“${rows[0].name}” is already in your supplier list. Use that one, or choose a different name.`, 'name_taken', { supplierId: rows[0].id });
}
/** Other suppliers with the same phone number: a warning for the screen, never a refusal. */
async function phoneWarnings(db, scope, phone, exceptId = null) {
  if (!phone) return [];
  const { rows } = await db.query(`select id, name from public.suppliers where business_id = $1 and phone = $2 and ($3::uuid is null or id <> $3::uuid) order by lower(name) limit 5`,
    [scope.businessId, phone, exceptId]);
  return rows.map((r) => ({ code: 'phone_used', message: `${r.name} already uses this phone number. Check it isn’t the same supplier.`, supplierId: r.id }));
}

/** Purchase orders with this supplier that are not finished. Counts nothing until migration 016 exists. */
export async function openOrderCount(db, supplierId) {
  const there = (await db.query(`select to_regclass('public.purchase_orders') is not null as there`)).rows[0].there;
  if (!there) return 0;
  const { rows } = await db.query('select count(*)::int as n from public.purchase_orders where supplier_id = $1 and not (status = any($2::text[]))', [supplierId, OPEN_PO_EXCLUDED]);
  return rows[0].n;
}

/* ---------- list and profile ---------- */

/** { search, type, status ('active'|'inactive'|'archived'|'all'; default: everything except archived), incomplete: true } */
export async function listSuppliers(db, scope, { search, type, status, incomplete } = {}) {
  requireOversight(scope);
  if (!empty(type)) readChoice(type, SUPPLIER_TYPES, 'The supplier type');
  if (!empty(status) && status !== 'all') readChoice(status, SUPPLIER_STATUSES, 'The status');
  const term = empty(search) ? null : tidy(search);
  const { rows } = await db.query(`select ${COLUMNS}, (select count(*)::int from public.supplier_items si where si.supplier_id = s.id) as item_count
    from public.suppliers s
    where s.business_id = $1 and ($2::text is null or s.type = $2)
      and (($3::text is null and s.status <> 'archived') or $3 = 'all' or s.status = $3)
      and ($4::boolean is not true or s.incomplete)
      and ($5::text is null or position(lower($5) in lower(s.name)) > 0 or position(lower($5) in lower(coalesce(s.contact_name, ''))) > 0
           or position($5 in coalesce(s.phone, '')) > 0 or position(upper($5) in coalesce(s.kra_pin, '')) > 0)
    order by lower(s.name), s.id`, [scope.businessId, empty(type) ? null : type, empty(status) ? null : status, incomplete === true, term]);
  return { suppliers: rows.map((r) => ({ ...supplierView(r, scope), itemCount: r.item_count })) };
}

async function loadItemInfo(db, businessId, itemId, units) {
  const row = (await db.query(`select id, name, unit, display_unit, archived_at from public.stock_items where id = $1 and business_id = $2`, [itemId, businessId])).rows[0];
  if (!row) throw fail(404, 'That stock item isn’t in this business. Pick it from the items list.', 'item_not_found');
  const own = (await db.query(`select name, factor::text as factor from public.stock_item_units where item_id = $1 order by position, lower(name)`, [itemId])).rows;
  const item = { id: row.id, name: row.name, baseUnit: row.unit, displayUnit: row.display_unit || undefined, units: own.map((u) => ({ name: u.name, factor: u.factor })) };
  return { item, archived: row.archived_at !== null, units };
}

/** Base units in ONE `unitText` of the item, as an exact decimal string; refuses a unit the item can't be measured in. */
function unitFactor(item, unitText, units) {
  const code = normaliseUnit(unitText, item, units);
  if (!code) toBase('1', unitText, item, units); // throws the plain "isn't a unit Cravio knows / use ..." message
  const found = compatibleUnits(item, units).find((u) => u.code === code);
  if (!found) toBase('1', unitText, item, units);
  return { code: found.code, factor: found.factor, label: found.label };
}

/** Price row -> response. `ctx` ({ item, units }) adds the comparison figure per the item's display unit (KES per kg). */
function priceView(row, ctx = null) {
  const out = { id: row.id, supplierId: row.supplier_id, itemId: row.item_id, unit: row.unit, unitFactor: trimZeros(row.unit_factor), price: row.price,
    pricePerBase: row.price_per_base, effectiveFrom: row.effective_from, note: row.note, createdBy: row.created_by, createdAt: row.created_at };
  if (ctx) {
    const du = ctx.item.displayUnit && compatibleUnits(ctx.item, ctx.units).find((u) => u.code === ctx.item.displayUnit);
    if (du) out.perDisplayUnit = { unit: du.code, price: mul(row.price_per_base, du.factor, MONEY).toString(MONEY) };
  }
  return out;
}
const PRICE_COLUMNS = `p.id, p.supplier_id, p.item_id, p.unit, p.unit_factor::text as unit_factor, p.price::text as price, p.price_per_base::text as price_per_base,
  p.effective_from::text as effective_from, p.note, p.created_by, p.created_at`;

/**
 * The price in force on `date` (default today, Nairobi): the row with the greatest effective_from <= date. With `unit`,
 * only that unit's rows. Returns the raw row (strings) or null. No permission check: callers decide who may see prices.
 */
export async function priceFor(db, { businessId, supplierId, itemId, date, unit = null }) {
  const { rows } = await db.query(`select ${PRICE_COLUMNS} from public.supplier_prices p
    where p.business_id = $1 and p.supplier_id = $2 and p.item_id = $3 and p.effective_from <= $4::date and ($5::text is null or lower(p.unit) = lower($5))
    order by p.effective_from desc, p.created_at desc, p.id desc limit 1`, [businessId, supplierId, itemId, date || todayNairobi(), unit]);
  return rows[0] || null;
}

/** Everything for the supplier page: the record, the items it supplies, current prices and price history (prices need inv.cost.view). */
export async function getSupplier(db, scope, id, { today = todayNairobi() } = {}) {
  requireOversight(scope);
  const row = await loadSupplier(db, scope, id);
  const units = await loadUnits(db);
  const items = (await db.query(`select si.item_id, si.supplier_code, si.purchase_unit, si.rank, si.preferred, si.lead_time_days, si.min_order_base::text as min_order_base,
      i.name, i.unit, i.display_unit, i.archived_at
    from public.supplier_items si join public.stock_items i on i.id = si.item_id where si.supplier_id = $1 order by lower(i.name)`, [row.id])).rows
    .map((r) => ({ itemId: r.item_id, name: r.name, archived: r.archived_at !== null, baseUnit: r.unit, displayUnit: r.display_unit, supplierCode: r.supplier_code,
      purchaseUnit: r.purchase_unit, rank: r.rank, preferred: r.preferred, leadTimeDays: r.lead_time_days, minOrderBase: r.min_order_base }));
  const out = { supplier: supplierView(row, scope), items, openOrders: await openOrderCount(db, row.id) };
  if (can(scope, 'inv.cost.view')) {
    const history = await priceHistory(db, scope, row.id, { today, limit: 200 });
    out.prices = history.prices.filter((p) => p.current);
    out.priceHistory = history.prices;
  }
  return out;
}

/** Price rows newest first. { itemId, unit, limit }. `current` marks the row in force today for each item and unit. */
export async function priceHistory(db, scope, supplierId, { itemId, unit, limit = 200, today = todayNairobi() } = {}) {
  requireOversight(scope);
  requireCan(scope, 'inv.cost.view');
  const row = await loadSupplier(db, scope, supplierId);
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 500);
  const { rows } = await db.query(`select ${PRICE_COLUMNS}, i.name as item_name from public.supplier_prices p join public.stock_items i on i.id = p.item_id
    where p.supplier_id = $1 and ($2::uuid is null or p.item_id = $2::uuid) and ($3::text is null or lower(p.unit) = lower($3))
    order by i.name, p.item_id, p.unit, p.effective_from desc, p.created_at desc limit $4`, [row.id, empty(itemId) ? null : needId(itemId, 'The stock item'), empty(unit) ? null : String(unit), size]);
  // Mark the row in force today per (item, unit): the first row with effective_from <= today in this ordering.
  const seen = new Set();
  const prices = rows.map((r) => {
    const key = `${r.item_id}|${r.unit.toLowerCase()}`;
    const current = !seen.has(key) && r.effective_from <= today;
    if (current) seen.add(key);
    return { ...priceView(r), itemName: r.item_name, current, scheduled: r.effective_from > today };
  });
  prices.sort((a, b) => (a.itemName.localeCompare(b.itemName)) || (b.effectiveFrom.localeCompare(a.effectiveFrom)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return { supplierId: row.id, prices };
}

/**
 * Where to buy an item, cheapest first, as at `date` (default today): each active supplier's latest price in force, compared per base
 * unit (so a crate price and a kg price line up). { itemId, date, candidates: [...], cheapest, preferred }.
 * Needs inv.cost.view. Ties go to the lower rank, then the name.
 */
export async function bestPrices(db, scope, itemId, { date, today = todayNairobi() } = {}) {
  requireOversight(scope);
  requireCan(scope, 'inv.cost.view');
  const id = needId(itemId, 'The stock item');
  const on = readDate(date, 'The date', today);
  const units = await loadUnits(db);
  const ctx = await loadItemInfo(db, scope.businessId, id, units);
  const { rows } = await db.query(`select ${PRICE_COLUMNS}, s.name as supplier_name, s.type as supplier_type, coalesce(si.rank, 99) as rank, coalesce(si.preferred, false) as preferred
    from (select distinct on (supplier_id) * from public.supplier_prices
          where business_id = $1 and item_id = $2 and effective_from <= $3::date order by supplier_id, effective_from desc, created_at desc, id desc) p
    join public.suppliers s on s.id = p.supplier_id and s.status = 'active'
    left join public.supplier_items si on si.supplier_id = p.supplier_id and si.item_id = p.item_id`, [scope.businessId, id, on]);
  const candidates = rows.map((r) => ({ supplierId: r.supplier_id, supplierName: r.supplier_name, supplierType: r.supplier_type, rank: r.rank, preferred: r.preferred, ...priceView(r, ctx) }))
    .sort((a, b) => cmp(a.pricePerBase, b.pricePerBase) || a.rank - b.rank || a.supplierName.localeCompare(b.supplierName));
  return { itemId: id, itemName: ctx.item.name, date: on, candidates, cheapest: candidates[0] || null, preferred: candidates.find((c) => c.preferred) || null };
}

/* ---------- create and edit ---------- */

function readFields(scope, body, { partial }) {
  const out = {};
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (!has(body, key)) continue;
    if (spec.ownerOnly && !isOwner(scope)) throw fail(403, 'Only the business owner can change bank and M-Pesa details.', 'owner_only');
    const value = body[key];
    if (partial && empty(value) && REQUIRED_ON_EMPTY.has(key) && key !== 'name') continue; // a blank type/terms/method in a patch means "leave it"
    out[key] = spec.read(value);
  }
  return out;
}

/**
 * Creates a supplier. body: { name, type?, contactName?, phone?, email?, address?, kraPin?, paymentTermsDays?, paymentMethod?,
 * mpesaTill?, mpesaPaybill?, mpesaAccount?, bankDetails? (owner only), notes? }. A duplicate name (ignoring case) is refused (409);
 * a phone already used by another supplier comes back as a warning. Returns { supplier, warnings }.
 */
export async function createSupplier(db, scope, body = {}) {
  requireEdit(scope);
  const fields = readFields(scope, body, { partial: false });
  if (!has(fields, 'name')) throw fail(400, 'Enter the supplier’s name.', 'name_required');
  await checkNameFree(db, scope, fields.name);
  const cols = ['business_id', 'created_by', 'updated_by'];
  const vals = [scope.businessId, scope.userId, scope.userId];
  for (const [key, value] of Object.entries(fields)) { cols.push(FIELDS[key].column); vals.push(value); }
  const row = await guarded(async () => (await db.query(`insert into public.suppliers (${cols.join(', ')}) values (${cols.map((_c, i) => `$${i + 1}`).join(', ')}) returning ${COLUMNS}`, vals)).rows[0]);
  await audit(db, scope, 'supplier', row.id, 'create', null, auditView(row));
  return { supplier: supplierView(row, scope), warnings: await phoneWarnings(db, scope, row.phone, row.id) };
}

/** Edits the fields named in `patch` (see createSupplier). Records only what changed. Returns { supplier, changed, warnings }. */
export async function updateSupplier(db, scope, id, patch = {}) {
  requireEdit(scope);
  const before = await loadSupplier(db, scope, id, { lock: true });
  const fields = readFields(scope, patch, { partial: true });
  if (has(fields, 'name') && fields.name.toLowerCase() !== before.name.toLowerCase()) await checkNameFree(db, scope, fields.name, before.id);
  const keys = Object.keys(fields);
  if (!keys.length) return { supplier: supplierView(before, scope), changed: [], warnings: [] };
  const sets = keys.map((k, i) => `${FIELDS[k].column} = $${i + 3}`);
  const row = await guarded(async () => (await db.query(`update public.suppliers set ${sets.join(', ')}, updated_by = $2, updated_at = now() where id = $1 returning ${COLUMNS}`,
    [before.id, scope.userId, ...keys.map((k) => fields[k])])).rows[0]);
  const change = diff(auditView(before), auditView(row));
  if (change.changed.length) await audit(db, scope, 'supplier', row.id, 'update', change.before, change.after);
  return { supplier: supplierView(row, scope), changed: change.changed, warnings: has(fields, 'phone') ? await phoneWarnings(db, scope, row.phone, row.id) : [] };
}

/** 'inactive' hides the supplier from pickers (refused while purchase orders with it are open); 'active' brings it back. */
export async function setSupplierStatus(db, scope, id, status) {
  requireEdit(scope);
  readChoice(status, ['active', 'inactive'], 'The status');
  const before = await loadSupplier(db, scope, id, { lock: true });
  if (before.status === status) return { supplier: supplierView(before, scope), changed: false };
  if (status === 'inactive') {
    const open = await openOrderCount(db, before.id);
    if (open > 0) throw fail(409, `${open} purchase order${open === 1 ? '' : 's'} with ${before.name} ${open === 1 ? 'is' : 'are'} still open. Receive or cancel ${open === 1 ? 'it' : 'them'} first.`, 'open_orders', { openOrders: open });
  }
  const row = (await db.query(`update public.suppliers set status = $2, updated_by = $3, updated_at = now() where id = $1 returning ${COLUMNS}`, [before.id, status, scope.userId])).rows[0];
  await audit(db, scope, 'supplier', row.id, status === 'inactive' ? 'deactivate' : 'activate', { status: before.status }, { status });
  return { supplier: supplierView(row, scope), changed: true };
}

/** Clears the "complete this supplier" flag on an on-the-spot supplier once there is a phone number to reach them on. */
export async function completeSupplier(db, scope, id) {
  requireEdit(scope);
  const before = await loadSupplier(db, scope, id, { lock: true });
  if (!before.incomplete) return { supplier: supplierView(before, scope), changed: false };
  if (!before.phone) throw fail(409, 'Add a phone number for this supplier first, then mark it complete.', 'phone_required');
  const row = (await db.query(`update public.suppliers set incomplete = false, updated_by = $2, updated_at = now() where id = $1 returning ${COLUMNS}`, [before.id, scope.userId])).rows[0];
  await audit(db, scope, 'supplier', row.id, 'complete', { incomplete: true }, { incomplete: false });
  return { supplier: supplierView(row, scope), changed: true };
}

/* ---------- what a supplier sells ---------- */

/**
 * Replaces the supplier's item list. list: [{ itemId, supplierCode?, unit?, rank? (1 = first choice), preferred?, leadTimeDays?, minOrder?: { quantity, unit } }].
 * At most one preferred supplier per item: marking this one preferred un-marks the previous one. Prices already entered are kept.
 */
export async function setSupplierItems(db, scope, supplierId, list) {
  requireEdit(scope);
  const supplier = await loadSupplier(db, scope, supplierId, { lock: true });
  if (!Array.isArray(list)) throw fail(400, 'Send the items this supplier sells as a list.', 'items_required');
  if (list.length > MAX_ITEMS_PER_SUPPLIER) throw fail(400, `A supplier can have up to ${MAX_ITEMS_PER_SUPPLIER} items.`, 'too_many_items');
  const units = await loadUnits(db);
  const seen = new Set();
  const lines = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') throw fail(400, 'Each item needs an itemId.', 'bad_item');
    const itemId = needId(entry.itemId, 'The stock item');
    if (seen.has(itemId)) throw fail(400, 'Each item can appear once for a supplier.', 'duplicate_item');
    seen.add(itemId);
    const info = await loadItemInfo(db, scope.businessId, itemId, units);
    const prior = (await db.query('select 1 from public.supplier_items where supplier_id = $1 and item_id = $2', [supplier.id, itemId])).rows[0];
    if (info.archived && !prior) throw fail(409, `${info.item.name} is archived. Bring it back before adding it to a supplier.`, 'item_archived');
    let purchaseUnit = null;
    if (!empty(entry.unit)) purchaseUnit = unitFactor(info.item, entry.unit, units).code;
    let minOrderBase = null;
    if (!empty(entry.minOrder)) minOrderBase = toBase(entry.minOrder.quantity, entry.minOrder.unit ?? purchaseUnit ?? info.item.baseUnit, info.item, units, { positive: true, label: 'The minimum order' });
    let rank = 1;
    if (!empty(entry.rank)) {
      rank = Number(entry.rank);
      if (!Number.isInteger(rank) || rank < 1 || rank > 99) throw fail(400, 'Rank is a whole number from 1 (first choice) to 99.', 'bad_rank');
    }
    let lead = null;
    if (!empty(entry.leadTimeDays)) {
      lead = Number(entry.leadTimeDays);
      if (!Number.isInteger(lead) || lead < 0 || lead > 365) throw fail(400, 'Lead time is a whole number of days from 0 to 365.', 'bad_lead_time');
    }
    const code = empty(entry.supplierCode) ? null : String(entry.supplierCode).trim();
    if (code && code.length > 40) throw fail(400, 'Keep the supplier’s item code under 40 characters.', 'code_too_long');
    lines.push({ itemId, itemName: info.item.name, purchaseUnit, minOrderBase, rank, lead, code, preferred: entry.preferred === true });
  }
  const old = (await db.query('select item_id, supplier_code, purchase_unit, rank, preferred from public.supplier_items where supplier_id = $1', [supplier.id])).rows;
  const view = (r) => ({ itemId: r.item_id, code: r.supplier_code, unit: r.purchase_unit, rank: r.rank, preferred: r.preferred });
  await db.query('delete from public.supplier_items where supplier_id = $1 and not (item_id = any($2::uuid[]))', [supplier.id, lines.map((l) => l.itemId)]);
  const clearedFrom = [];
  for (const l of lines) {
    if (l.preferred) {
      const cleared = (await db.query(`update public.supplier_items set preferred = false, updated_at = now() where business_id = $1 and item_id = $2 and preferred and supplier_id <> $3 returning supplier_id`,
        [scope.businessId, l.itemId, supplier.id])).rows;
      for (const c of cleared) clearedFrom.push({ itemId: l.itemId, supplierId: c.supplier_id });
    }
    await db.query(`insert into public.supplier_items (business_id, supplier_id, item_id, supplier_code, purchase_unit, rank, preferred, lead_time_days, min_order_base)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (supplier_id, item_id) do update set supplier_code = excluded.supplier_code, purchase_unit = excluded.purchase_unit, rank = excluded.rank,
        preferred = excluded.preferred, lead_time_days = excluded.lead_time_days, min_order_base = excluded.min_order_base, updated_at = now()`,
    [scope.businessId, supplier.id, l.itemId, l.code, l.purchaseUnit, l.rank, l.preferred, l.lead, l.minOrderBase]);
  }
  const after = (await db.query('select item_id, supplier_code, purchase_unit, rank, preferred from public.supplier_items where supplier_id = $1 order by item_id', [supplier.id])).rows;
  const sortById = (rows) => rows.map(view).sort((a, b) => a.itemId.localeCompare(b.itemId));
  await audit(db, scope, 'supplier', supplier.id, 'items', { items: sortById(old) }, { items: sortById(after), ...(clearedFrom.length ? { preferredClearedFrom: clearedFrom } : {}) });
  return { supplierId: supplier.id, items: lines.map((l) => ({ itemId: l.itemId, name: l.itemName, purchaseUnit: l.purchaseUnit, rank: l.rank, preferred: l.preferred })) };
}

/* ---------- prices ---------- */

/**
 * Adds a price: { itemId, unit (a unit the item is measured in: kg, crate ...), price (KES per ONE unit), effectiveFrom? (default today), note? }.
 * Prices are history: nothing is edited or removed, a new row with a later date replaces the old one from that date on.
 * A date up to a year in the past is allowed (price lists arrive late; the lookup by date stays correct); older or more than a year ahead is refused;
 * the same supplier + item + unit + date twice is refused. A price ten times (or a tenth of) the one before is accepted with a warning.
 * Also adds the item to the supplier's list when it wasn't there. Returns { price, previous, changePct, warnings, backdated }.
 */
export async function addPrice(db, scope, supplierId, body = {}, { today = todayNairobi() } = {}) {
  requireEdit(scope);
  const supplier = await loadSupplier(db, scope, supplierId, { lock: true });
  if (supplier.status !== 'active') throw fail(409, `${supplier.name} is switched off. Switch it back on before adding prices.`, 'supplier_inactive');
  const itemId = needId(body.itemId, 'The stock item');
  const units = await loadUnits(db);
  const ctx = await loadItemInfo(db, scope.businessId, itemId, units);
  const link = (await db.query('select purchase_unit from public.supplier_items where supplier_id = $1 and item_id = $2', [supplier.id, itemId])).rows[0];
  const unitText = !empty(body.unit) ? body.unit : link?.purchase_unit || ctx.item.displayUnit || ctx.item.baseUnit;
  const u = unitFactor(ctx.item, unitText, units);
  let price;
  try { price = dec(typeof body.price === 'number' ? String(body.price) : body.price, { scale: MONEY, round: 'exact', label: 'The price' }); } catch (e) {
    if (e.details?.code === 'precision') throw fail(400, 'A price has at most 2 decimal places (cents). Type it like 6500 or 6500.50.', 'bad_price');
    throw e;
  }
  if (isNeg(price) || isZero(price)) throw fail(400, 'The price must be more than zero.', 'bad_price');
  if (cmp(price, '100000000') > 0) throw fail(400, 'That price is too large. Check the amount.', 'bad_price');
  const effectiveFrom = readDate(body.effectiveFrom, 'The effective date', today);
  if (effectiveFrom < addDays(today, -PRICE_WINDOW_DAYS)) throw fail(400, 'That date is more than a year ago. Use a more recent effective date.', 'date_too_old');
  if (effectiveFrom > addDays(today, PRICE_WINDOW_DAYS)) throw fail(400, 'That date is more than a year away. Use a nearer effective date.', 'date_too_far');
  const note = empty(body.note) ? null : String(body.note).trim();
  if (note && note.length > 200) throw fail(400, 'Keep the note under 200 characters.', 'note_too_long');
  const perBase = div(price, u.factor, COST, 'half-up').toString(COST);

  const dup = (await db.query(`select 1 from public.supplier_prices where supplier_id = $1 and item_id = $2 and lower(unit) = lower($3) and effective_from = $4::date`, [supplier.id, itemId, u.code, effectiveFrom])).rows[0];
  if (dup) throw fail(409, `${supplier.name} already has a ${ctx.item.name} price per ${u.label} from ${effectiveFrom}. Prices are history and can’t be edited: add the corrected price with a later date.`, 'price_exists');

  const previousRow = await priceFor(db, { businessId: scope.businessId, supplierId: supplier.id, itemId, date: effectiveFrom });
  const latestRow = await priceFor(db, { businessId: scope.businessId, supplierId: supplier.id, itemId, date: '9999-12-31' });
  const row = await guarded(async () => (await db.query(`insert into public.supplier_prices (business_id, supplier_id, item_id, unit, unit_factor, price, price_per_base, effective_from, note, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
    returning ${PRICE_COLUMNS.replaceAll('p.', '')}`, [scope.businessId, supplier.id, itemId, u.code, u.factor, price.toString(MONEY), perBase, effectiveFrom, note, scope.userId])).rows[0]);
  if (!link) {
    await db.query(`insert into public.supplier_items (business_id, supplier_id, item_id, purchase_unit) values ($1, $2, $3, $4) on conflict (supplier_id, item_id) do nothing`,
      [scope.businessId, supplier.id, itemId, u.code]);
  }

  const warnings = [];
  let changePct = null;
  if (previousRow && !isZero(previousRow.price_per_base)) {
    const ratio = div(perBase, previousRow.price_per_base, 6, 'half-up');
    changePct = mul(div(sub(perBase, previousRow.price_per_base, COST), previousRow.price_per_base, 6), 100, 2).toString(2);
    const factor = Number(await getSetting(db, scope.businessId, 'large_amount_warning_factor'));
    if (cmp(ratio, factor) >= 0 || cmp(mul(ratio, factor, 6), 1) <= 0) {
      warnings.push({ code: 'unusual_price', message: `This is ${cmp(ratio, 1) > 0 ? 'much higher' : 'much lower'} than the previous price (KES ${previousRow.price} per ${previousRow.unit}). Check you typed it right.` });
    }
  }
  const backdated = latestRow !== null && effectiveFrom < latestRow.effective_from;
  await audit(db, scope, 'supplier_price', row.id, 'create', previousRow ? { price: previousRow.price, unit: previousRow.unit, effectiveFrom: previousRow.effective_from } : null,
    { supplierId: supplier.id, itemId, unit: u.code, price: row.price, pricePerBase: row.price_per_base, effectiveFrom, ...(backdated ? { backdated: true } : {}) });
  return { price: priceView(row, ctx), previous: previousRow ? priceView(previousRow, ctx) : null, changePct, warnings, backdated };
}

/* ---------- branch: the emergency picker and on-the-spot suppliers (EMP-4) ---------- */

/**
 * Names only, for the branch manager's emergency-buy picker: active suppliers { id, name, type, incomplete }. No contact, bank or M-Pesa data.
 * With { itemId } and inv.cost.view at this branch each supplier also carries its latest price for that item.
 */
export async function listForBranch(db, scope, locationId, { search, itemId, today = todayNairobi() } = {}) {
  requireCan(scope, 'inv.emergency.create', { locationId });
  const term = empty(search) ? null : tidy(search);
  const { rows } = await db.query(`select id, name, type, incomplete from public.suppliers
    where business_id = $1 and status = 'active' and ($2::text is null or position(lower($2) in lower(name)) > 0) order by lower(name), id limit 200`, [scope.businessId, term]);
  const suppliers = rows.map((r) => ({ id: r.id, name: r.name, type: r.type, incomplete: r.incomplete }));
  if (!empty(itemId) && can(scope, 'inv.cost.view', { locationId })) {
    const units = await loadUnits(db);
    const ctx = await loadItemInfo(db, scope.businessId, needId(itemId, 'The stock item'), units);
    for (const s of suppliers) {
      const p = await priceFor(db, { businessId: scope.businessId, supplierId: s.id, itemId: ctx.item.id, date: today });
      s.lastPrice = p ? priceView(p, ctx) : null;
    }
  }
  return { suppliers };
}

/**
 * A branch manager adds a supplier on the spot during an emergency buy: name and phone (a KRA PIN if they have it). The supplier
 * is incomplete = true (type one_off, cash) until the owner completes it. A name that exists already is refused with that supplier's id.
 */
export async function createOnTheSpot(db, scope, locationId, body = {}) {
  requireCan(scope, 'inv.emergency.create', { locationId });
  const name = readName(body.name);
  if (empty(body.phone)) throw fail(400, 'Enter the supplier’s phone number so the owner can follow up.', 'phone_required');
  const phone = normalisePhone(body.phone);
  const kraPin = readPin(body.kraPin);
  await checkNameFree(db, scope, name);
  const recent = (await db.query(`select count(*)::int as n from public.suppliers where business_id = $1 and created_by = $2 and created_at > now() - interval '1 day'`, [scope.businessId, scope.userId])).rows[0].n;
  if (recent >= MAX_ON_THE_SPOT_PER_DAY) throw fail(429, 'You’ve added a lot of new suppliers today. Ask the owner to add the rest.', 'too_many_on_the_spot');
  const row = await guarded(async () => (await db.query(`insert into public.suppliers (business_id, name, type, phone, kra_pin, incomplete, created_by, updated_by)
    values ($1, $2, 'one_off', $3, $4, true, $5, $5) returning ${COLUMNS}`, [scope.businessId, name, phone, kraPin, scope.userId])).rows[0]);
  await audit(db, scope, 'supplier', row.id, 'create_on_the_spot', null, auditView(row), locationId);
  return { supplier: { id: row.id, name: row.name, type: row.type, incomplete: true } };
}
