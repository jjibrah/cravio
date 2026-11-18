// Catalogue service (P1-08): items, their own units (crate = 10 kg), barcodes, levels per location, categories.
// Every function takes (db, scope, ...): `db` is a query-able handle (a transaction for writes), `scope` comes from
// permissions.inventoryScope(). Services re-check capabilities with requireCan (synchronous, no audit); the routes
// authorize (and audit denials) BEFORE opening the write transaction. Quantities are exact decimal strings in the item's
// BASE unit (g, ml, piece, serving); people type and read them in the units they choose (units.js).
// Every change appends an audit event (audit.record) in the same transaction.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { QTY, MONEY, dec, add, sub, mul, cmp, isNeg, isZero } from './decimal.js';
import { DEFAULT_UNITS, baseUnitFor, compatibleUnits, dimensionOf, display, normaliseUnit, toBase } from './units.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { diff, record } from './audit.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const KINDS = Object.freeze(['raw', 'prepared', 'resale', 'packaging', 'consumable']);
export const STORAGES = Object.freeze(['ambient', 'chilled', 'frozen', 'dry']);
export const VAT_CLASSES = Object.freeze(['standard', 'zero', 'exempt']);
export const DEFAULT_CATEGORIES = Object.freeze(['Meat and poultry', 'Seafood', 'Vegetables', 'Fruits', 'Dairy', 'Dry goods',
  'Grains and cereals', 'Beverages', 'Cooking ingredients and spices', 'Bakery', 'Packaging', 'Cleaning supplies',
  'Restaurant consumables', 'Prepared items']);
const MAX_UNITS_PER_ITEM = 20;
const MAX_BARCODES_PER_ITEM = 20;
const MEASURED_BY = { weight: 'weight', volume: 'volume', count: 'count', serving: 'servings' };

/* ---------- small helpers ---------- */

const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is invalid.`, 'bad_id');
  return value.toLowerCase();
};
const has = (obj, key) => obj && typeof obj === 'object' && Object.hasOwn(obj, key);
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Unit rows from the `units` table (falls back to the built-in list when the table is empty). */
export async function loadUnits(db) {
  const { rows } = await db.query('select code, dimension, to_base::text as to_base, label, plural from public.units where active order by position');
  return rows.length ? rows.map((u) => ({ code: u.code, dimension: u.dimension, toBase: u.to_base, label: u.label, plural: u.plural })) : DEFAULT_UNITS;
}

/** What units.js needs to know about an item. */
const unitItem = (row, own) => ({ name: row.name, baseUnit: row.unit, displayUnit: row.display_unit || undefined,
  units: own.map((u) => ({ name: u.name, factor: u.factor })) });

/** Postgres errors from the 012 guards and unique indexes -> plain HttpErrors. Anything else is rethrown. */
function mapDbError(e) {
  if (e instanceof HttpError) return e;
  if (e?.hint === 'stock_unit_locked') return fail(409, e.message, 'unit_locked');
  if (e?.code === '23505') {
    const text = `${e.constraint || ''} ${e.message || ''}`;
    if (/stock_items_name/.test(text)) return fail(409, 'Another item already has that name. Use that one or choose a different name.', 'name_taken');
    if (/stock_items_sku/.test(text)) return fail(409, 'Another item already uses that SKU. Choose a different SKU.', 'sku_taken');
    if (/stock_item_barcodes/.test(text)) return fail(409, 'One of those barcodes already belongs to another item.', 'barcode_taken');
    if (/stock_categories_name/.test(text)) return fail(409, 'That category name is already used here. Choose a different name.', 'category_name_taken');
    if (/stock_item_units_name/.test(text)) return fail(409, 'Two of this item’s units have the same name. Give each its own name.', 'unit_name_taken');
  }
  return e;
}
async function guarded(fn) {
  try { return await fn(); } catch (e) { throw mapDbError(e); }
}

const ITEM_COLUMNS = `i.id, i.name, i.sku, i.category_id, i.kind, i.storage, i.unit, i.display_unit, i.low_level::text as low_level,
  i.yield_pct::text as yield_pct, i.vat_class, i.notes, i.archived_at, i.active, i.avg_cost::text as avg_cost, i.last_cost::text as last_cost,
  i.created_at, i.updated_at`;

async function loadRow(db, scope, itemId, { lock = false } = {}) {
  const id = needId(itemId, 'The stock item');
  const { rows } = await db.query(`select ${ITEM_COLUMNS} from public.stock_items i where i.id = $1 and i.business_id = $2${lock ? ' for update' : ''}`, [id, scope.businessId]);
  if (!rows[0]) throw fail(404, 'That stock item isn’t in this business. Pick it from the items list.', 'item_not_found');
  return rows[0];
}

async function loadOwnUnits(db, itemId) {
  return (await db.query(`select id, name, factor::text as factor, for_purchase, for_recipe, for_count, position
    from public.stock_item_units where item_id = $1 order by position, lower(name)`, [itemId])).rows;
}

/** The fields that matter for an audit diff (no costs, no timestamps). */
const auditView = (row) => ({ name: row.name, sku: row.sku || null, kind: row.kind, storage: row.storage || null, categoryId: row.category_id || null,
  baseUnit: row.unit, displayUnit: row.display_unit || null, yieldPct: Number(row.yield_pct), vatClass: row.vat_class, notes: row.notes || null,
  lowLevel: row.low_level === null || row.low_level === undefined ? null : dec(row.low_level).toString(QTY) });

const audit = (db, scope, entityId, action, before, after, locationId = null) => record(db, {
  businessId: scope.businessId, locationId, actorId: scope.userId, actorRole: scope.role, entity: 'item', entityId, action, before, after });

/* ---------- reading quantities and units from people ---------- */

/** "10 kg" -> { quantity: '10', unit: 'kg' }; "10" -> { quantity: '10', unit: null }. Null when it isn't that shape. */
function splitTyped(text) {
  const m = /^\s*(-?\d[\d,]*(?:\.\d+)?|-?\.\d+)\s*([^\d\s].*)?$/.exec(String(text));
  return m ? { quantity: m[1].replace(/,/g, ''), unit: m[2] ? m[2].trim() : null } : null;
}

/**
 * An amount someone typed -> { quantity, unit } (unit may be null). Accepts a number, "12", "12 kg", or { quantity|value, unit }.
 */
function typedAmount(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail(400, `${label} must be a number.`, 'bad_quantity');
    return { quantity: String(value), unit: null };
  }
  if (typeof value === 'string') {
    const parts = splitTyped(value);
    if (!parts) throw fail(400, `${label} must be a number, like 12 or 12 kg.`, 'bad_quantity');
    return parts;
  }
  if (value && typeof value === 'object') {
    const q = value.quantity ?? value.value;
    if (empty(q)) throw fail(400, `${label}: enter an amount.`, 'bad_quantity');
    const inner = typedAmount(typeof q === 'number' ? q : String(q), label);
    const unit = empty(value.unit) ? inner.unit : String(value.unit);
    return { quantity: inner.quantity, unit };
  }
  throw fail(400, `${label} must be a number, like 12 or 12 kg.`, 'bad_quantity');
}

/** Typed amount in any compatible unit -> base-unit string (4 dp), or null when left blank. A bare number uses the item's display unit. */
function readQuantity(value, item, units, label) {
  if (empty(value)) return null;
  const { quantity, unit } = typedAmount(value, label);
  if (isNeg(dec(quantity, { label }))) throw fail(400, `${label} can’t be negative.`, 'negative');
  return toBase(quantity, unit ?? item.displayUnit ?? item.baseUnit, item, units, { label });
}

/** 'weight' | 'volume' | 'count' | 'servings' (or a base code like 'g') -> base unit code. */
function readBaseUnit(text, units) {
  const t = String(text ?? '').trim().toLowerCase();
  const dimension = { weight: 'weight', volume: 'volume', count: 'count', servings: 'serving', serving: 'serving' }[t];
  if (dimension) return baseUnitFor(dimension, units);
  const code = t ? normaliseUnit(t, null, units) : null;
  const row = code && units.find((u) => u.code === code);
  if (row && cmp(row.toBase, 1) === 0) return row.code;
  throw fail(400, `Choose how this item is measured: weight, volume, count or servings.${row ? ` You can still show it in ${row.plural} later.` : ''}`, 'bad_base_unit');
}

const unitsList = (item, units) => {
  const names = compatibleUnits(item, units).map((u) => u.label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
};

/** The unit an item is shown in: a standard unit of the same dimension, or one of the item's own units. Null clears it. */
function readDisplayUnit(text, item, units) {
  if (empty(text)) return null;
  const t = tidy(text);
  const code = normaliseUnit(t, item, units);
  if (!code) throw fail(400, `“${t}” isn’t a unit Cravio knows for ${item.name}. Choose ${unitsList(item, units)}.`, 'bad_display_unit');
  if (item.units.some((u) => u.name === code)) return code;
  const dimension = dimensionOf(item.baseUnit, units);
  if (dimensionOf(code, units) !== dimension) {
    const row = units.find((u) => u.code === code);
    throw fail(400, `${row.plural} can’t be used to show ${item.name}: it is measured by ${MEASURED_BY[dimension]}. Choose ${unitsList(item, units)}.`, 'unit_mismatch');
  }
  return code;
}

/* ---------- the item's own units ---------- */

/** Validates [{ name, factor | size | { quantity, unit }, forPurchase, forRecipe, forCount }] -> rows with factor in base units. */
function readUnitDefs(list, baseUnit, itemName, units) {
  if (!Array.isArray(list)) throw fail(400, 'Send the item’s units as a list.', 'bad_units');
  if (list.length > MAX_UNITS_PER_ITEM) throw fail(400, `An item can have at most ${MAX_UNITS_PER_ITEM} of its own units.`, 'too_many_units');
  const plain = { name: itemName, baseUnit, units: [] };
  const seen = new Set();
  return list.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw fail(400, `Unit ${index + 1} is not valid.`, 'bad_units');
    const name = tidy(raw.name);
    if (!name) throw fail(400, `Unit ${index + 1} needs a name, like crate, sack or carton.`, 'unit_name_required');
    if (name.length > 30) throw fail(400, `Keep “${name.slice(0, 30)}…” under 30 characters.`, 'unit_name_too_long');
    if (normaliseUnit(name, null, units)) throw fail(400, `“${name}” is already a standard unit. Give this unit its own name, like crate or carton.`, 'unit_name_reserved');
    if (seen.has(name.toLowerCase())) throw fail(400, `You listed “${name}” twice. Each unit needs its own name.`, 'unit_name_duplicate');
    seen.add(name.toLowerCase());
    let sizeInput = raw.factor ?? raw.size;
    if (empty(sizeInput) && !empty(raw.quantity)) sizeInput = { quantity: raw.quantity, unit: raw.unit };
    if (empty(sizeInput)) throw fail(400, `Say how much one ${name} holds, like 10 kg.`, 'unit_size_required');
    const { quantity, unit } = typedAmount(sizeInput, `The size of ${name}`);
    const factor = toBase(quantity, unit ?? baseUnit, plain, units, { positive: true, label: `The size of ${name}` });
    if (factor.replace('.', '').replace(/^0+/, '').length > 18) throw fail(400, `One ${name} is too large. Check the amount and unit.`, 'unit_too_large');
    const flag = (key, fallback) => {
      if (raw[key] === undefined || raw[key] === null) return fallback;
      if (typeof raw[key] !== 'boolean') throw fail(400, `${key} for ${name} must be on or off.`, 'bad_units');
      return raw[key];
    };
    return { name, factor, forPurchase: flag('forPurchase', true), forRecipe: flag('forRecipe', false), forCount: flag('forCount', true), position: index };
  });
}

const unitView = (r) => ({ name: r.name, factor: dec(r.factor).toString(QTY), forPurchase: r.forPurchase ?? r.for_purchase, forRecipe: r.forRecipe ?? r.for_recipe, forCount: r.forCount ?? r.for_count });

/** Replace-all of the item's own units, keeping row ids for names that stay. */
async function replaceUnits(db, itemId, defs) {
  const old = await loadOwnUnits(db, itemId);
  const keep = new Set(defs.map((d) => d.name.toLowerCase()));
  for (const row of old) if (!keep.has(row.name.toLowerCase())) await db.query('delete from public.stock_item_units where id = $1', [row.id]);
  for (const d of defs) {
    const existing = old.find((o) => o.name.toLowerCase() === d.name.toLowerCase());
    if (existing) {
      await db.query(`update public.stock_item_units set name = $2, factor = $3, for_purchase = $4, for_recipe = $5, for_count = $6, position = $7 where id = $1`,
        [existing.id, d.name, d.factor, d.forPurchase, d.forRecipe, d.forCount, d.position]);
    } else {
      await db.query(`insert into public.stock_item_units (item_id, name, factor, for_purchase, for_recipe, for_count, position) values ($1, $2, $3, $4, $5, $6, $7)`,
        [itemId, d.name, d.factor, d.forPurchase, d.forRecipe, d.forCount, d.position]);
    }
  }
}

/* ---------- listing and reading ---------- */

async function locationNames(db, businessId) {
  const { rows } = await db.query(`select l.id, coalesce(r.name, l.name) as name from public.stock_locations l
    left join public.restaurants r on r.id = l.restaurant_id where l.business_id = $1`, [businessId]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

const zero = '0.0000';
const q4 = (v) => dec(v ?? '0').toString(QTY);

/**
 * Items with their balances at every location the scope can view. Options: { ids, search, categoryId, includeArchived, lowOnly }.
 * Costs and values only when the scope holds inv.cost.view (per location for values).
 */
async function loadItems(db, scope, { ids = null, search, categoryId, includeArchived = false, lowOnly = false } = {}) {
  const units = await loadUnits(db);
  const names = await locationNames(db, scope.businessId);
  const viewable = locationsWith(scope, 'inv.view');
  const costLocations = new Set(locationsWith(scope, 'inv.cost.view'));
  const seeCost = costLocations.size > 0;
  const term = empty(search) ? null : tidy(search);
  const { rows } = await db.query(`select ${ITEM_COLUMNS}, c.name as category_name
    from public.stock_items i left join public.stock_categories c on c.id = i.category_id
    where i.business_id = $1 and ($2::boolean or i.archived_at is null)
      and ($3::uuid is null or i.category_id = $3::uuid)
      and ($4::uuid[] is null or i.id = any($4::uuid[]))
      and ($5::text is null or position(lower($5::text) in lower(i.name)) > 0 or position(lower($5::text) in lower(coalesce(i.sku, ''))) > 0
        or exists (select 1 from public.stock_item_barcodes b where b.item_id = i.id and b.code = $5::text))
    order by lower(i.name)`, [scope.businessId, Boolean(includeArchived), categoryId ? needId(categoryId, 'The category') : null, ids, term]);
  if (!rows.length) return { items: [], units };
  const itemIds = rows.map((r) => r.id);
  const own = (await db.query(`select item_id, id, name, factor::text as factor, for_purchase, for_recipe, for_count, position
    from public.stock_item_units where item_id = any($1::uuid[]) order by position, lower(name)`, [itemIds])).rows;
  const barcodes = (await db.query(`select item_id, code from public.stock_item_barcodes where item_id = any($1::uuid[]) order by code`, [itemIds])).rows;
  const balances = viewable.length ? (await db.query(`select item_id, location_id, on_hand::text as on_hand, reserved::text as reserved
    from public.stock_balances where item_id = any($1::uuid[]) and location_id = any($2::uuid[])`, [itemIds, viewable])).rows : [];
  const levels = viewable.length ? (await db.query(`select item_id, location_id, min::text as min, reorder::text as reorder, par::text as par, max::text as max
    from public.stock_item_levels where item_id = any($1::uuid[]) and location_id = any($2::uuid[])`, [itemIds, viewable])).rows : [];

  const visibleLocations = scope.locations.filter((l) => viewable.includes(l.id));
  const items = rows.map((row) => {
    const ownRows = own.filter((o) => o.item_id === row.id);
    const item = unitItem(row, ownRows);
    const show = (v) => display(v, item, units);
    const perLocation = visibleLocations.map((loc) => {
      const bal = balances.find((b) => b.item_id === row.id && b.location_id === loc.id);
      const lvl = levels.find((l) => l.item_id === row.id && l.location_id === loc.id);
      const onHand = q4(bal?.on_hand);
      const reserved = q4(bal?.reserved);
      const available = sub(dec(onHand), dec(reserved), QTY).toString(QTY);
      const threshold = lvl?.reorder ?? row.low_level ?? null;
      const low = Boolean((bal || lvl) && threshold !== null && cmp(onHand, threshold) < 0);
      const out = { locationId: loc.id, locationName: names.get(loc.id) || loc.name, kind: loc.kind, onHand, reserved, available,
        display: { onHand: show(onHand), reserved: show(reserved), available: show(available) }, low,
        level: lvl ? { min: lvl.min, reorder: lvl.reorder, par: lvl.par, max: lvl.max } : null,
        levelDisplay: lvl ? Object.fromEntries(['min', 'reorder', 'par', 'max'].map((k) => [k, lvl[k] === null ? null : show(lvl[k])])) : null };
      if (costLocations.has(loc.id)) out.value = row.avg_cost === null ? null : mul(dec(onHand), dec(row.avg_cost), MONEY).toString(MONEY);
      return out;
    });
    const sum = (key) => perLocation.reduce((acc, l) => add(acc, dec(l[key]), QTY), dec(zero)).toString(QTY);
    const totals = { onHand: sum('onHand'), reserved: sum('reserved'), available: sum('available') };
    totals.display = { onHand: show(totals.onHand), reserved: show(totals.reserved), available: show(totals.available) };
    if (seeCost) {
      const costed = perLocation.filter((l) => costLocations.has(l.locationId));
      totals.value = row.avg_cost === null && costed.some((l) => !isZero(l.onHand)) ? null
        : costed.reduce((acc, l) => add(acc, dec(l.value ?? '0'), MONEY), dec('0')).toString(MONEY);
    }
    const view = {
      id: row.id, name: row.name, sku: row.sku, kind: row.kind, storage: row.storage, categoryId: row.category_id, categoryName: row.category_name || null,
      baseUnit: row.unit, measuredBy: MEASURED_BY[dimensionOf(row.unit, units)] || row.unit, displayUnit: row.display_unit,
      yieldPct: Number(row.yield_pct), vatClass: row.vat_class, notes: row.notes,
      lowLevel: row.low_level === null ? null : q4(row.low_level), lowLevelDisplay: row.low_level === null ? null : show(row.low_level),
      archived: row.archived_at !== null, archivedAt: row.archived_at,
      units: ownRows.map((u) => ({ id: u.id, ...unitView(u), size: display(u.factor, { ...item, units: [] }, units) })),
      barcodes: barcodes.filter((b) => b.item_id === row.id).map((b) => b.code),
      locations: perLocation, totals, low: perLocation.some((l) => l.low),
    };
    if (seeCost) { view.avgCost = row.avg_cost === null ? null : dec(row.avg_cost).toString(6); view.lastCost = row.last_cost === null ? null : dec(row.last_cost).toString(6); }
    return view;
  });
  return { items: lowOnly ? items.filter((i) => i.low) : items, units };
}

/** Items with balances per location the scope can view. See loadItems for the options. */
export async function listItems(db, scope, options = {}) {
  requireCan(scope, 'inv.view');
  return (await loadItems(db, scope, options)).items;
}

async function itemView(db, scope, itemId) {
  const { items } = await loadItems(db, scope, { ids: [needId(itemId, 'The stock item')], includeArchived: true });
  if (!items[0]) throw fail(404, 'That stock item isn’t in this business. Pick it from the items list.', 'item_not_found');
  return items[0];
}

/** One item with its units, barcodes, levels per location and the last 20 movements the scope may see. */
export async function getItem(db, scope, itemId) {
  requireCan(scope, 'inv.view');
  const { items, units } = await loadItems(db, scope, { ids: [needId(itemId, 'The stock item')], includeArchived: true });
  const item = items[0];
  if (!item) throw fail(404, 'That stock item isn’t in this business. Pick it from the items list.', 'item_not_found');
  const viewable = locationsWith(scope, 'inv.view');
  const costLocations = new Set(locationsWith(scope, 'inv.cost.view'));
  const names = await locationNames(db, scope.businessId);
  const own = await loadOwnUnits(db, item.id);
  const unitView1 = unitItem({ name: item.name, unit: item.baseUnit, display_unit: item.displayUnit }, own);
  const { rows } = viewable.length ? await db.query(`select id, location_id, delta::text as delta, balance_after::text as balance_after, reason, note, occurred_at, created_at,
      unit_cost::text as unit_cost, value::text as value, entered_quantity::text as entered_quantity, entered_unit, actor_id
    from public.stock_movements where item_id = $1 and business_id = $2 and location_id = any($3::uuid[])
    order by occurred_at desc, id desc limit 20`, [item.id, scope.businessId, viewable]) : { rows: [] };
  const movements = rows.map((m) => {
    const out = { id: String(m.id), locationId: m.location_id, locationName: names.get(m.location_id) || null, reason: m.reason, note: m.note,
      occurredAt: m.occurred_at, delta: m.delta, balanceAfter: m.balance_after,
      display: { delta: `${isNeg(dec(m.delta)) ? '-' : '+'}${display(dec(m.delta).toString(QTY).replace('-', ''), unitView1, units)}`, balanceAfter: display(m.balance_after, unitView1, units) },
      entered: m.entered_quantity === null ? null : { quantity: m.entered_quantity, unit: m.entered_unit }, actorId: m.actor_id };
    if (costLocations.has(m.location_id)) { out.unitCost = m.unit_cost; out.value = m.value; }
    return out;
  });
  return { ...item, compatibleUnits: compatibleUnits(unitView1, units), movements };
}

/* ---------- create and edit ---------- */

async function checkNameFree(db, scope, name, exceptId = null) {
  const { rows } = await db.query(`select id, name from public.stock_items where business_id = $1 and lower(btrim(name)) = lower($2) and ($3::uuid is null or id <> $3::uuid)`,
    [scope.businessId, name, exceptId]);
  if (rows[0]) throw fail(409, `“${rows[0].name}” is already a stock item. Use that one, or choose a different name.`, 'name_taken', { itemId: rows[0].id });
}

async function checkSkuFree(db, scope, sku, exceptId = null) {
  if (!sku) return;
  const { rows } = await db.query(`select id, name from public.stock_items where business_id = $1 and lower(btrim(sku)) = lower($2) and ($3::uuid is null or id <> $3::uuid)`,
    [scope.businessId, sku, exceptId]);
  if (rows[0]) throw fail(409, `The SKU “${sku}” already belongs to “${rows[0].name}”. Choose a different SKU.`, 'sku_taken', { itemId: rows[0].id });
}

function readName(value) {
  const name = tidy(value);
  if (!name) throw fail(400, 'Enter the item name.', 'name_required');
  if (name.length > 80) throw fail(400, 'Keep the name under 80 characters.', 'name_too_long');
  return name;
}
function readSku(value) {
  if (empty(value)) return null;
  const sku = tidy(value);
  if (sku.length > 40) throw fail(400, 'Keep the SKU under 40 characters.', 'sku_too_long');
  return sku;
}
const readChoice = (value, options, label) => {
  if (!options.includes(value)) throw fail(400, `${label} must be one of: ${options.join(', ')}.`, 'bad_choice');
  return value;
};
function readYield(value) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
    throw fail(400, 'Usable yield must be more than 0 and at most 100 (for example 70 when 30% is trimmed away). Use at most 2 decimals.', 'bad_yield');
  }
  return Math.round(n * 100) / 100;
}
function readNotes(value) {
  if (empty(value)) return null;
  const text = String(value).trim();
  if (text.length > 280) throw fail(400, 'Keep the notes under 280 characters.', 'notes_too_long');
  return text;
}
async function readCategory(db, scope, value, current = null) {
  if (empty(value)) return null;
  const id = needId(value, 'The category');
  const { rows } = await db.query('select id, active from public.stock_categories where id = $1 and business_id = $2', [id, scope.businessId]);
  if (!rows[0]) throw fail(404, 'That category isn’t in this business. Pick it from the list.', 'category_not_found');
  if (!rows[0].active && id !== current) throw fail(409, 'That category is switched off. Pick another one, or switch it back on first.', 'category_inactive');
  return id;
}

/**
 * Creates an item. body: { name, baseUnit ('weight'|'volume'|'count'|'servings' or g/ml/piece/serving), sku?, kind?, storage?, categoryId?,
 * displayUnit? (kg, l, ... or the name of one of `units`), units? [{ name, factor: {quantity, unit} | "10 kg" }], yieldPct?, vatClass?, notes?, lowLevel? }.
 * lowLevel is the organisation-wide low-stock level; a bare number is in the display unit.
 */
export async function createItem(db, scope, body = {}) {
  requireCan(scope, 'inv.item.edit');
  const units = await loadUnits(db);
  const name = readName(body.name);
  const baseUnit = readBaseUnit(body.baseUnit, units);
  const sku = readSku(body.sku);
  const defs = empty(body.units) ? [] : readUnitDefs(body.units, baseUnit, name, units);
  const probe = { name, baseUnit, units: defs.map((d) => ({ name: d.name, factor: d.factor })) };
  const displayUnit = readDisplayUnit(body.displayUnit, probe, units);
  const lowLevel = readQuantity(body.lowLevel, { ...probe, displayUnit: displayUnit ?? undefined }, units, 'The low-stock level');
  await checkNameFree(db, scope, name);
  await checkSkuFree(db, scope, sku);
  const categoryId = await readCategory(db, scope, body.categoryId);
  const kind = empty(body.kind) ? 'raw' : readChoice(body.kind, KINDS, 'Type');
  const storage = empty(body.storage) ? null : readChoice(body.storage, STORAGES, 'Storage');
  const vatClass = empty(body.vatClass) ? 'standard' : readChoice(body.vatClass, VAT_CLASSES, 'VAT class');
  const yieldPct = empty(body.yieldPct) ? 100 : readYield(body.yieldPct);
  const notes = readNotes(body.notes);
  const id = await guarded(async () => {
    const { rows } = await db.query(`insert into public.stock_items (business_id, name, sku, category_id, kind, storage, unit, display_unit, yield_pct, vat_class, notes, low_level, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [scope.businessId, name, sku, categoryId, kind, storage, baseUnit, displayUnit, yieldPct, vatClass, notes, lowLevel, scope.userId]);
    if (defs.length) await replaceUnits(db, rows[0].id, defs);
    return rows[0].id;
  });
  const created = await loadRow(db, scope, id);
  await audit(db, scope, id, 'create', null, { ...auditView(created), units: defs.map(unitView) });
  return itemView(db, scope, id);
}

/**
 * Edits an item. Only the fields present in `patch` change (null clears sku/storage/category/displayUnit/notes/lowLevel).
 * Changing baseUnit after any stock movement is refused (409 unit_locked).
 */
export async function updateItem(db, scope, itemId, patch = {}) {
  requireCan(scope, 'inv.item.edit');
  const units = await loadUnits(db);
  const row = await loadRow(db, scope, itemId, { lock: true });
  const own = await loadOwnUnits(db, row.id);
  const before = auditView(row);
  const next = { ...row };

  if (has(patch, 'name')) { next.name = readName(patch.name); await checkNameFree(db, scope, next.name, row.id); }
  if (has(patch, 'sku')) { next.sku = readSku(patch.sku); await checkSkuFree(db, scope, next.sku, row.id); }
  if (has(patch, 'kind')) next.kind = readChoice(patch.kind, KINDS, 'Type');
  if (has(patch, 'storage')) next.storage = empty(patch.storage) ? null : readChoice(patch.storage, STORAGES, 'Storage');
  if (has(patch, 'vatClass')) next.vat_class = readChoice(patch.vatClass, VAT_CLASSES, 'VAT class');
  if (has(patch, 'yieldPct')) next.yield_pct = String(readYield(patch.yieldPct));
  if (has(patch, 'notes')) next.notes = readNotes(patch.notes);
  if (has(patch, 'categoryId')) next.category_id = await readCategory(db, scope, patch.categoryId, row.category_id);

  if (has(patch, 'baseUnit')) {
    const base = readBaseUnit(patch.baseUnit, units);
    if (base !== row.unit) {
      const used = (await db.query('select 1 from public.stock_movements where item_id = $1 limit 1', [row.id])).rows.length > 0;
      if (used) {
        throw fail(409, `The unit of ${row.name} can’t change because it already has stock history. Add a new item instead, or keep ${row.name} as it is.`, 'unit_locked');
      }
      const levels = (await db.query('select 1 from public.stock_item_levels where item_id = $1 limit 1', [row.id])).rows.length > 0;
      if (own.length || levels || row.low_level !== null) {
        throw fail(409, `${row.name} has pack sizes or stock levels set in its current unit. Remove them first, then change how it is measured.`, 'unit_in_use');
      }
      next.unit = base;
      if (row.display_unit && !has(patch, 'displayUnit')) next.display_unit = null;
    }
  }
  const nextOwn = own;
  const probe = unitItem(next, nextOwn);
  if (has(patch, 'displayUnit')) next.display_unit = readDisplayUnit(patch.displayUnit, { ...probe, displayUnit: undefined }, units);
  if (has(patch, 'lowLevel')) {
    next.low_level = readQuantity(patch.lowLevel, { ...unitItem(next, nextOwn), displayUnit: next.display_unit || undefined }, units, 'The low-stock level');
  }

  const after = auditView(next);
  const change = diff(before, after);
  if (!change.changed.length) return itemView(db, scope, row.id);
  await guarded(() => db.query(`update public.stock_items set name = $2, sku = $3, category_id = $4, kind = $5, storage = $6, unit = $7, display_unit = $8,
      yield_pct = $9, vat_class = $10, notes = $11, low_level = $12 where id = $1`,
  [row.id, next.name, next.sku, next.category_id, next.kind, next.storage, next.unit, next.display_unit, next.yield_pct, next.vat_class, next.notes, next.low_level]));
  await audit(db, scope, row.id, 'update', change.before, change.after);
  return itemView(db, scope, row.id);
}

/**
 * Replaces the item's own units: list of { name, factor: { quantity, unit } | "10 kg" | base number, forPurchase?, forRecipe?, forCount? }.
 * The unit currently used as the display unit can only be removed when `displayUnit` changes in the same call.
 */
export async function setItemUnits(db, scope, itemId, list, { displayUnit } = {}) {
  requireCan(scope, 'inv.item.edit');
  const units = await loadUnits(db);
  const row = await loadRow(db, scope, itemId, { lock: true });
  const defs = readUnitDefs(list, row.unit, row.name, units);
  const old = await loadOwnUnits(db, row.id);
  let nextDisplay = row.display_unit;
  if (displayUnit !== undefined) nextDisplay = readDisplayUnit(displayUnit, { name: row.name, baseUnit: row.unit, units: defs.map((d) => ({ name: d.name, factor: d.factor })) }, units);
  else if (row.display_unit && old.some((o) => o.name === row.display_unit)) {
    const kept = defs.find((d) => d.name.toLowerCase() === row.display_unit.toLowerCase());
    if (!kept) {
      throw fail(409, `${row.display_unit} is how ${row.name} is shown. Choose another display unit (for example kg) in the same change, then remove ${row.display_unit}.`, 'display_unit_in_use');
    }
    nextDisplay = kept.name;
  }
  const beforeUnits = old.map(unitView);
  const afterUnits = defs.map(unitView);
  const change = diff({ units: beforeUnits, displayUnit: row.display_unit }, { units: afterUnits, displayUnit: nextDisplay });
  if (change.changed.length) {
    await guarded(async () => {
      await replaceUnits(db, row.id, defs);
      if (nextDisplay !== row.display_unit) await db.query('update public.stock_items set display_unit = $2 where id = $1', [row.id, nextDisplay]);
    });
    await audit(db, scope, row.id, 'units', change.before, change.after);
  }
  return itemView(db, scope, row.id);
}

/** Replaces the item's barcodes (each unique in the business). */
export async function setBarcodes(db, scope, itemId, codes) {
  requireCan(scope, 'inv.item.edit');
  const row = await loadRow(db, scope, itemId, { lock: true });
  if (!Array.isArray(codes)) throw fail(400, 'Send the barcodes as a list.', 'bad_barcodes');
  if (codes.length > MAX_BARCODES_PER_ITEM) throw fail(400, `An item can have at most ${MAX_BARCODES_PER_ITEM} barcodes.`, 'too_many_barcodes');
  const clean = [];
  for (const raw of codes) {
    const code = tidy(typeof raw === 'object' && raw ? raw.code : raw);
    if (!code) throw fail(400, 'A barcode can’t be empty.', 'bad_barcodes');
    if (code.length > 64) throw fail(400, 'Keep each barcode under 64 characters.', 'bad_barcodes');
    if (clean.includes(code)) throw fail(400, `The barcode ${code} is listed twice.`, 'barcode_duplicate');
    clean.push(code);
  }
  if (clean.length) {
    const clash = (await db.query(`select b.code, i.name from public.stock_item_barcodes b join public.stock_items i on i.id = b.item_id
      where b.business_id = $1 and b.code = any($2::text[]) and b.item_id <> $3 limit 1`, [scope.businessId, clean, row.id])).rows[0];
    if (clash) throw fail(409, `The barcode ${clash.code} already belongs to “${clash.name}”. A barcode can only be on one item.`, 'barcode_taken');
  }
  const old = (await db.query('select code from public.stock_item_barcodes where item_id = $1 order by code', [row.id])).rows.map((r) => r.code);
  const change = diff({ barcodes: old }, { barcodes: [...clean].sort() });
  if (change.changed.length) {
    await guarded(async () => {
      await db.query('delete from public.stock_item_barcodes where item_id = $1 and not (code = any($2::text[]))', [row.id, clean]);
      for (const code of clean) {
        await db.query('insert into public.stock_item_barcodes (item_id, business_id, code) values ($1, $2, $3) on conflict do nothing', [row.id, scope.businessId, code]);
      }
    });
    await audit(db, scope, row.id, 'barcodes', change.before, change.after);
  }
  return itemView(db, scope, row.id);
}

/**
 * Sets stock levels per location: [{ locationId, min, reorder, par, max }], each a number (in the display unit), "12 kg" or { quantity, unit };
 * blank = not set. Replace-all for the locations the scope may edit (inv.stock.record there): editable locations missing from the list lose
 * their levels; other locations are left alone, and naming one is refused. Needs min <= reorder <= par <= max where present.
 */
export async function setLevels(db, scope, itemId, list) {
  requireCan(scope, 'inv.item.edit');
  const units = await loadUnits(db);
  const row = await loadRow(db, scope, itemId, { lock: true });
  if (!Array.isArray(list)) throw fail(400, 'Send the levels as a list, one entry per location.', 'bad_levels');
  const own = await loadOwnUnits(db, row.id);
  const item = unitItem(row, own);
  const names = await locationNames(db, scope.businessId);
  const show = (v) => display(v, item, units);
  const editable = new Set(locationsWith(scope, 'inv.stock.record'));
  const seen = new Set();
  const rows = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') throw fail(400, 'Each level needs a location.', 'bad_levels');
    const locationId = needId(entry.locationId, 'The location');
    if (!names.has(locationId)) throw fail(404, 'That location isn’t part of this business. Pick it from the locations list.', 'location_not_found');
    if (seen.has(locationId)) throw fail(400, `${names.get(locationId)} is listed twice. Give each location one set of levels.`, 'bad_levels');
    seen.add(locationId);
    requireCan(scope, 'inv.stock.record', { locationId });
    const where = names.get(locationId);
    const v = {
      min: readQuantity(entry.min, item, units, `The minimum at ${where}`),
      reorder: readQuantity(entry.reorder, item, units, `The reorder level at ${where}`),
      par: readQuantity(entry.par, item, units, `The par level at ${where}`),
      max: readQuantity(entry.max, item, units, `The maximum at ${where}`),
    };
    const order = [['min', 'minimum'], ['reorder', 'reorder level'], ['par', 'par level'], ['max', 'maximum']].filter(([k]) => v[k] !== null);
    for (let i = 1; i < order.length; i += 1) {
      const [lowKey, lowName] = order[i - 1];
      const [highKey, highName] = order[i];
      if (cmp(v[lowKey], v[highKey]) > 0) {
        throw fail(400, `At ${where}, the ${lowName} (${show(v[lowKey])}) is higher than the ${highName} (${show(v[highKey])}). Keep them in order: minimum, reorder, par, maximum.`, 'levels_order');
      }
    }
    if (order.length) rows.push({ locationId, ...v });
  }
  const old = (await db.query(`select location_id, min::text as min, reorder::text as reorder, par::text as par, max::text as max
    from public.stock_item_levels where item_id = $1`, [row.id])).rows;
  const view = (r) => ({ min: r.min === null ? null : dec(r.min).toString(QTY), reorder: r.reorder === null ? null : dec(r.reorder).toString(QTY),
    par: r.par === null ? null : dec(r.par).toString(QTY), max: r.max === null ? null : dec(r.max).toString(QTY) });
  const mine = (r) => editable.has(r.location_id || r.locationId);
  const beforeMap = Object.fromEntries(old.filter(mine).map((r) => [r.location_id, view(r)]));
  const afterMap = Object.fromEntries(rows.map((r) => [r.locationId, view(r)]));
  const change = diff({ levels: beforeMap }, { levels: afterMap });
  if (change.changed.length) {
    const keep = rows.map((r) => r.locationId);
    await db.query('delete from public.stock_item_levels where item_id = $1 and location_id = any($2::uuid[]) and not (location_id = any($3::uuid[]))', [row.id, [...editable], keep]);
    for (const r of rows) {
      await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, min, reorder, par, max) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (location_id, item_id) do update set min = excluded.min, reorder = excluded.reorder, par = excluded.par, max = excluded.max, updated_at = now()`,
      [r.locationId, row.id, scope.businessId, r.min, r.reorder, r.par, r.max]);
    }
    await audit(db, scope, row.id, 'levels', change.before, change.after);
  }
  return itemView(db, scope, row.id);
}

/* ---------- archive and restore ---------- */

const listNames = (names, max = 5) => (names.length <= max ? names : [...names.slice(0, max), `${names.length - max} more`])
  .map((n, i, all) => (i === 0 ? n : i === all.length - 1 ? ` and ${n}` : `, ${n}`)).join('');

/** Archives an item: refused while stock is left at any location, or while a dish uses it. */
export async function archiveItem(db, scope, itemId) {
  requireCan(scope, 'inv.item.edit');
  const units = await loadUnits(db);
  const row = await loadRow(db, scope, itemId, { lock: true });
  if (row.archived_at) return itemView(db, scope, row.id);
  const names = await locationNames(db, scope.businessId);
  const viewable = new Set(locationsWith(scope, 'inv.view'));
  const left = (await db.query(`select location_id, on_hand::text as on_hand, reserved::text as reserved from public.stock_balances
    where item_id = $1 and (on_hand <> 0 or reserved <> 0) order by location_id`, [row.id])).rows;
  if (left.length) {
    const item = unitItem(row, await loadOwnUnits(db, row.id));
    const parts = left.map((b) => (viewable.has(b.location_id)
      ? `${display(isZero(dec(b.on_hand)) ? b.reserved : b.on_hand, item, units)} at ${names.get(b.location_id)}` : 'some at another location'));
    throw fail(409, `${row.name} still has stock: ${listNames(parts)}. Count it to zero first, or record waste.`, 'stock_left');
  }
  const dishes = (await db.query(`select distinct mi.name from public.menu_item_stock s join public.menu_items mi on mi.id = s.menu_item_id
    where s.item_id = $1 order by mi.name`, [row.id])).rows.map((r) => r.name);
  if (dishes.length) {
    throw fail(409, `${row.name} is used by ${listNames(dishes.map((d) => `“${d}”`))}. Remove it from ${dishes.length === 1 ? 'that dish' : 'those dishes'} first.`, 'used_by_dishes', { dishes });
  }
  await db.query('update public.stock_items set archived_at = now(), active = false where id = $1', [row.id]);
  await audit(db, scope, row.id, 'archive', { archived: false }, { archived: true });
  return itemView(db, scope, row.id);
}

export async function restoreItem(db, scope, itemId) {
  requireCan(scope, 'inv.item.edit');
  const row = await loadRow(db, scope, itemId, { lock: true });
  if (!row.archived_at) return itemView(db, scope, row.id);
  await db.query('update public.stock_items set archived_at = null, active = true where id = $1', [row.id]);
  await audit(db, scope, row.id, 'restore', { archived: true }, { archived: false });
  return itemView(db, scope, row.id);
}

/* ---------- categories ---------- */

const categoryAudit = (db, scope, id, action, before, after) => record(db, {
  businessId: scope.businessId, actorId: scope.userId, actorRole: scope.role, entity: 'category', entityId: id, action, before, after });

/** Categories (top level first, children after their parent). Seeds the default list the first time a business has none. */
export async function listCategories(db, scope, { includeInactive = true } = {}) {
  requireCan(scope, 'inv.view');
  const { rows: any } = await db.query('select 1 from public.stock_categories where business_id = $1 limit 1', [scope.businessId]);
  if (!any.length) {
    const seeded = await db.query(`insert into public.stock_categories (business_id, name, position)
      select $1, n, (o - 1) * 10 from unnest($2::text[]) with ordinality as t(n, o) on conflict do nothing returning id`, [scope.businessId, [...DEFAULT_CATEGORIES]]);
    if (seeded.rows.length) await categoryAudit(db, scope, null, 'seed', null, { count: seeded.rows.length });
  }
  const { rows } = await db.query(`select c.id, c.name, c.parent_id, c.position, c.active,
      (select count(*)::int from public.stock_items i where i.category_id = c.id and i.archived_at is null) as item_count
    from public.stock_categories c where c.business_id = $1 and ($2::boolean or c.active)
    order by coalesce((select p.position from public.stock_categories p where p.id = c.parent_id), c.position), (c.parent_id is not null), c.position, lower(c.name)`,
  [scope.businessId, Boolean(includeInactive)]);
  return rows.map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id, position: c.position, active: c.active, itemCount: c.item_count }));
}

function readCategoryName(value) {
  const name = tidy(value);
  if (!name) throw fail(400, 'Enter the category name.', 'name_required');
  if (name.length > 60) throw fail(400, 'Keep the category name under 60 characters.', 'name_too_long');
  return name;
}

async function checkParent(db, scope, parentId, selfId = null) {
  if (empty(parentId)) return null;
  const id = needId(parentId, 'The parent category');
  const parent = (await db.query('select id, parent_id from public.stock_categories where id = $1 and business_id = $2', [id, scope.businessId])).rows[0];
  if (!parent) throw fail(404, 'That parent category isn’t in this business.', 'category_not_found');
  if (parent.parent_id) throw fail(400, 'Categories can only go one level deep. Pick a top-level category as the parent.', 'category_too_deep');
  if (selfId) {
    if (id === selfId) throw fail(400, 'A category can’t be inside itself.', 'category_loop');
    const kids = (await db.query('select 1 from public.stock_categories where parent_id = $1 limit 1', [selfId])).rows.length;
    if (kids) throw fail(400, 'This category has sub-categories, so it can’t go inside another one. Move or remove them first.', 'category_too_deep');
  }
  return id;
}

async function checkCategoryNameFree(db, scope, name, parentId, exceptId = null) {
  const { rows } = await db.query(`select id from public.stock_categories where business_id = $1 and lower(btrim(name)) = lower($2)
    and parent_id is not distinct from $3::uuid and ($4::uuid is null or id <> $4::uuid)`, [scope.businessId, name, parentId, exceptId]);
  if (rows[0]) throw fail(409, `There is already a category called “${name}” here. Choose a different name.`, 'category_name_taken');
}

export async function createCategory(db, scope, body = {}) {
  requireCan(scope, 'inv.item.edit');
  await listCategories(db, scope); // seeds the defaults first, so a new category lands after them
  const name = readCategoryName(body.name);
  const parentId = await checkParent(db, scope, body.parentId);
  await checkCategoryNameFree(db, scope, name, parentId);
  const row = await guarded(async () => (await db.query(`insert into public.stock_categories (business_id, parent_id, name, position)
    values ($1, $2, $3, coalesce((select max(position) + 10 from public.stock_categories where business_id = $1), 0)) returning id, name, parent_id, position, active`,
  [scope.businessId, parentId, name])).rows[0]);
  await categoryAudit(db, scope, row.id, 'create', null, { name: row.name, parentId: row.parent_id });
  return { id: row.id, name: row.name, parentId: row.parent_id, position: row.position, active: row.active, itemCount: 0 };
}

/** Rename, reorder (position), switch off/on (active) or move under a top-level parent. */
export async function updateCategory(db, scope, categoryId, patch = {}) {
  requireCan(scope, 'inv.item.edit');
  const id = needId(categoryId, 'The category');
  const row = (await db.query('select id, name, parent_id, position, active from public.stock_categories where id = $1 and business_id = $2 for update', [id, scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That category isn’t in this business. Pick it from the list.', 'category_not_found');
  const next = { name: row.name, parentId: row.parent_id, position: row.position, active: row.active };
  if (has(patch, 'name')) next.name = readCategoryName(patch.name);
  if (has(patch, 'parentId')) next.parentId = await checkParent(db, scope, patch.parentId, id);
  if (has(patch, 'position')) {
    const n = Number(patch.position);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw fail(400, 'The position must be a whole number, 0 or more.', 'bad_position');
    next.position = n;
  }
  if (has(patch, 'active')) {
    if (typeof patch.active !== 'boolean') throw fail(400, 'Active must be on or off.', 'bad_choice');
    next.active = patch.active;
  }
  if (next.name !== row.name || next.parentId !== row.parent_id) await checkCategoryNameFree(db, scope, next.name, next.parentId, id);
  const before = { name: row.name, parentId: row.parent_id, position: row.position, active: row.active };
  const change = diff(before, next);
  if (change.changed.length) {
    await guarded(() => db.query('update public.stock_categories set name = $2, parent_id = $3, position = $4, active = $5 where id = $1', [id, next.name, next.parentId, next.position, next.active]));
    await categoryAudit(db, scope, id, 'update', change.before, change.after);
  }
  const count = (await db.query('select count(*)::int as n from public.stock_items where category_id = $1 and archived_at is null', [id])).rows[0].n;
  return { id, name: next.name, parentId: next.parentId, position: next.position, active: next.active, itemCount: count };
}

/** True when the scope may use the cost columns anywhere. */
export const canSeeCost = (scope) => can(scope, 'inv.cost.view');
