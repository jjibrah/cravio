// CSV import of stock items (P1-11, PRD CAT-1): items, one pack unit, a low-stock level and an opening balance per row.
//   dryRun(db, scope, csv)               -> report, writes NOTHING (safe on the read pool)
//   commit(db, scope, csv, { commandId }) -> same checks again, refuses everything if any row has an error, else applies
//                                           the rows IN THE CALLER'S TRANSACTION through the catalogue + opening services.
// No dependency: the parser below handles quotes, escaped quotes, commas and line breaks inside quotes, CRLF, a BOM and
// the comma / semicolon / tab separators spreadsheets export. Limits: 2,000 rows and 1 MB.
//
// Matching: an existing item is found by CODE first, then by NAME (any case). Found -> the row updates it: blank cells change nothing,
// filled cells are applied (a row that would change nothing is "skip"). Not found -> create.
// Quantities in the file are typed the way people say them: low_level and opening_qty are in the unit named next to them
// (low_level: the display unit, else the base unit; opening_unit: the display unit, else the base unit); opening_cost_per_unit is KES per
// opening_unit ("650" with opening_unit kg means KES 650 per kg).
import { HttpError } from '../lib/http.js';
import { dec, cmp, isNeg } from './decimal.js';
import { baseUnitFor, dimensionOf, normaliseUnit, toBase } from './units.js';
import { KINDS, STORAGES, createCategory, createItem, listCategories, loadUnits, setItemUnits, updateItem, DEFAULT_CATEGORIES } from './catalogue.js';
import { can, requireCan } from './permissions.js';
import { record } from './audit.js';
import { lineKey, openingBlocker, openingOf, prepareLine, setOpening } from './opening.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const LIMITS = Object.freeze({ rows: 2000, bytes: 1_000_000 });
export const TEMPLATE_FILENAME = 'cravio-items-import-template.csv';
export const TEMPLATE_COLUMNS = Object.freeze(['name', 'code', 'category', 'measured_by', 'display_unit', 'pack_name', 'pack_size', 'pack_unit', 'kind',
  'storage', 'low_level', 'yield_pct', 'opening_qty', 'opening_unit', 'opening_cost_per_unit', 'location']);
// Same text as docs/inventory-kb/templates/items-import.csv (a test keeps them identical).
export const TEMPLATE_CSV = `${TEMPLATE_COLUMNS.join(',')}
Chicken,CHK-001,Meat and poultry,weight,kg,crate,10,kg,raw,frozen,20,85,40,kg,650,warehouse
Eggs,EGG-001,Dairy,count,piece,tray,30,piece,raw,chilled,60,100,20,tray,420,warehouse
Cooking oil,OIL-001,Cooking ingredients and spices,volume,L,jerrican,20,L,raw,ambient,40,100,5,jerrican,4200,warehouse
`;

// Other names people use for the columns (matched after lower-casing and dropping spaces, dashes and underscores).
const ALIASES = {
  name: ['name', 'item', 'itemname', 'product', 'productname', 'description'],
  code: ['code', 'sku', 'itemcode', 'productcode'],
  category: ['category', 'group', 'department'],
  measured_by: ['measuredby', 'measure', 'measuredin', 'measurement', 'measuretype'],
  display_unit: ['displayunit', 'unit', 'usualunit', 'uom', 'showin'],
  pack_name: ['packname', 'pack', 'packaging', 'packagename', 'packunitname'],
  pack_size: ['packsize', 'packquantity', 'packqty', 'contains', 'packcontains'],
  pack_unit: ['packunit', 'packsizeunit', 'packmeasure'],
  kind: ['kind', 'itemtype', 'type'],
  storage: ['storage', 'storagetype', 'store'],
  low_level: ['lowlevel', 'lowstock', 'lowstocklevel', 'reorderlevel', 'lowlevelkg'],
  yield_pct: ['yieldpct', 'yield', 'yieldpercent', 'yieldpercentage', 'usableyield'],
  opening_qty: ['openingqty', 'openingquantity', 'openingstock', 'opening', 'openingbalance'],
  opening_unit: ['openingunit', 'openingqtyunit'],
  opening_cost_per_unit: ['openingcostperunit', 'openingcost', 'costperunit', 'unitcost', 'cost'],
  location: ['location', 'branch', 'site', 'store', 'openinglocation'],
};
// "store" is ambiguous: storage wins when both are listed first, so keep it out of location's list.
ALIASES.location = ALIASES.location.filter((a) => a !== 'store');
const KEY_OF = new Map(Object.entries(ALIASES).flatMap(([key, list]) => list.map((a) => [a, key])));
const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* ---------- CSV parsing ---------- */

/**
 * Plain CSV text -> { delimiter, records: [{ line, cells: string[] }] }. `line` is the line the record starts on (1 = first line).
 * Blank lines are dropped. Throws 400 for a quote that is never closed.
 */
export function parseCsv(input) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Separator: whichever of , ; tab appears most in the first line outside quotes.
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const delimiter = counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';

  const records = [];
  let cells = [];
  let cell = '';
  let inQuotes = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;
  let quoteLine = 1;
  const endCell = () => { cells.push(wasQuoted ? cell : cell.trim()); cell = ''; wasQuoted = false; };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) records.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '' && !wasQuoted) {
      inQuotes = true; wasQuoted = true; cell = ''; quoteLine = line;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      startLine = line;
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw fail(400, `A quoted value that starts on line ${quoteLine} is never closed. Check for a missing closing quote (").`, 'csv_bad_quote');
  if (cell !== '' || cells.length || wasQuoted) endRecord();
  // Cells that were quoted keep their spaces; everything is trimmed once more for the plain-words rules.
  return { delimiter, records: records.map((r) => ({ line: r.line, cells: r.cells.map((c) => c.trim()) })) };
}

/** Header + rows: { columns: { name: index, ... }, ignored: [header text], rows: [{ line, cells }] }. */
export function readTable(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail(400, 'Choose a CSV file to import.', 'csv_empty');
  if (Buffer.byteLength(input, 'utf8') > LIMITS.bytes) throw fail(413, 'That file is too large (over 1 MB). Split it into smaller files and import them one at a time.', 'csv_too_large');
  const { records } = parseCsv(input);
  if (!records.length) throw fail(400, 'Choose a CSV file to import.', 'csv_empty');
  const [head, ...rows] = records;
  const columns = {};
  const ignored = [];
  head.cells.forEach((text, index) => {
    if (!text) return;
    const key = KEY_OF.get(squash(text));
    if (!key) { ignored.push(text); return; }
    if (key in columns) throw fail(400, `The file has two columns for “${key.replace(/_/g, ' ')}” (“${head.cells[columns[key]]}” and “${text}”). Keep one of them.`, 'csv_duplicate_column');
    columns[key] = index;
  });
  if (!('name' in columns)) throw fail(400, 'The file needs a “name” column with each item’s name. Download the template to see all the columns.', 'csv_no_name_column');
  if (!rows.length) throw fail(400, 'The file has a header but no items under it.', 'csv_no_rows');
  if (rows.length > LIMITS.rows) throw fail(400, `The file has ${rows.length.toLocaleString('en-US')} rows. Import at most ${LIMITS.rows.toLocaleString('en-US')} at a time: split it into smaller files.`, 'too_many_rows');
  return { columns, ignored, rows, width: head.cells.length };
}

/* ---------- checking the rows ---------- */

const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const MEASURED = { weight: 'weight', volume: 'volume', count: 'count', servings: 'serving', serving: 'serving' };
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]);

async function loadContext(db, scope) {
  const units = await loadUnits(db);
  const rows = (await db.query(`select id, name, sku, unit, display_unit, kind, storage, category_id, low_level::text as low_level, yield_pct::text as yield_pct, archived_at
    from public.stock_items where business_id = $1`, [scope.businessId])).rows;
  const own = rows.length ? (await db.query(`select item_id, name, factor::text as factor, for_purchase, for_recipe, for_count from public.stock_item_units
    where item_id = any($1::uuid[])`, [rows.map((r) => r.id)])).rows : [];
  const items = rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku, baseUnit: r.unit, displayUnit: r.display_unit || undefined, kind: r.kind, storage: r.storage,
    categoryId: r.category_id, lowLevel: r.low_level, yieldPct: Number(r.yield_pct), archived: r.archived_at !== null,
    units: own.filter((u) => u.item_id === r.id).map((u) => ({ name: u.name, factor: u.factor, forPurchase: u.for_purchase, forRecipe: u.for_recipe, forCount: u.for_count })) }));
  const cats = (await db.query('select id, name from public.stock_categories where business_id = $1 order by (parent_id is not null), position', [scope.businessId])).rows;
  // A business with no categories yet gets the default list the first time categories are read (and again at commit), so match against it.
  const categories = cats.length ? cats.map((c) => ({ id: c.id, name: c.name })) : DEFAULT_CATEGORIES.map((name) => ({ id: null, name }));
  const locs = (await db.query(`select l.id, l.kind, coalesce(r.name, l.name) as name from public.stock_locations l
    left join public.restaurants r on r.id = l.restaurant_id where l.business_id = $1`, [scope.businessId])).rows;
  return { units, items, categories, locs };
}

function findLocation(ctx, text) {
  const t = tidy(text).toLowerCase();
  if (!t) return { error: 'Say where the opening stock is: “warehouse” or the name of a branch.' };
  const warehouses = ctx.locs.filter((l) => l.kind === 'center' || l.kind === 'warehouse');
  const hits = ctx.locs.filter((l) => l.name.toLowerCase() === t || ((l.kind === 'center' || l.kind === 'warehouse') && t === 'warehouse'));
  const unique = [...new Map(hits.map((l) => [l.id, l])).values()];
  if (unique.length === 1) return { location: unique[0] };
  if (unique.length > 1) return { error: `More than one location is called “${tidy(text)}”. Rename one of them first.` };
  const names = [...(warehouses.length ? ['warehouse'] : []), ...ctx.locs.filter((l) => l.kind === 'branch').map((l) => l.name)];
  return { error: `“${tidy(text)}” isn’t one of your locations. Use ${list(names.map((n) => `“${n}”`))}.` };
}

/** "20" | "20 kg" | "1,200" -> { quantity, unit|null } or null. */
function typed(text) {
  const m = /^(-?\d[\d,]*(?:\.\d+)?|-?\.\d+)\s*([^\d\s].*)?$/.exec(String(text).trim());
  return m ? { quantity: m[1].replace(/,/g, ''), unit: m[2] ? m[2].trim() : null } : null;
}

/** Runs one check; an HttpError becomes a plain message in `errors` and null is returned. */
function attempt(errors, fn) {
  try { return fn(); } catch (e) { if (e instanceof HttpError) { errors.push(e.message); return null; } throw e; }
}

async function checkRows(db, scope, table, { commandId = null } = {}) {
  const ctx = await loadContext(db, scope);
  const { units } = ctx;
  const byName = new Map(ctx.items.map((i) => [i.name.toLowerCase(), i]));
  const byCode = new Map(ctx.items.filter((i) => i.sku).map((i) => [i.sku.toLowerCase(), i]));
  const catByName = new Map(ctx.categories.map((c) => [c.name.toLowerCase(), c]));
  const seenName = new Map();
  const seenCode = new Map();
  const newCategories = new Map(); // lower name -> display name (created at commit, once)
  const out = [];

  for (const rec of table.rows) {
    const cell = (key) => (key in table.columns ? tidy(rec.cells[table.columns[key]]) : '');
    const raw = (key) => (key in table.columns ? String(rec.cells[table.columns[key]] ?? '').trim() : '');
    const errors = [];
    const warnings = [];
    const changes = [];
    const row = { line: rec.line, name: cell('name') || '(no name)', action: 'error', messages: errors, warnings, changes };
    const extras = rec.cells.slice(table.width).filter((c) => c !== '');
    if (extras.length) errors.push(`This row has ${rec.cells.length} values but the header has ${table.width}. A comma inside a name or note needs the value in double quotes.`);

    const name = cell('name');
    if (!name) errors.push('The item has no name.');
    else if (name.length > 80) errors.push('Keep the name under 80 characters.');
    const code = cell('code');
    if (code.length > 40) errors.push('Keep the code under 40 characters.');

    // Duplicates inside the file.
    if (name) {
      const first = seenName.get(name.toLowerCase());
      if (first) errors.push(`“${name}” is already on line ${first}. Each item should appear once in the file.`);
      else seenName.set(name.toLowerCase(), rec.line);
    }
    if (code) {
      const first = seenCode.get(code.toLowerCase());
      if (first) errors.push(`The code “${code}” is already used on line ${first}. Each item needs its own code.`);
      else seenCode.set(code.toLowerCase(), rec.line);
    }

    // Which item is this?
    const hitCode = code ? byCode.get(code.toLowerCase()) : null;
    const hitName = name ? byName.get(name.toLowerCase()) : null;
    let existing = hitCode || hitName || null;
    if (hitCode && hitName && hitCode.id !== hitName.id) {
      errors.push(`The code “${code}” belongs to “${hitCode.name}”, but the name “${name}” belongs to “${hitName.name}”. Fix one of them so the row points at one item.`);
      existing = null;
    }
    if (existing?.archived) errors.push(`“${existing.name}” is archived. Restore it in Items before importing changes to it.`);
    if (existing) {
      if (name && name.toLowerCase() !== existing.name.toLowerCase()) changes.push(`Rename “${existing.name}” to “${name}”`);
      if (code && (existing.sku || '').toLowerCase() !== code.toLowerCase()) changes.push(existing.sku ? `Change the code from ${existing.sku} to ${code}` : `Set the code to ${code}`);
    }

    // Measured by.
    let baseUnit = existing?.baseUnit || null;
    const measuredText = cell('measured_by');
    if (measuredText) {
      const t = measuredText.toLowerCase();
      let dimension = MEASURED[t];
      if (!dimension) { const code1 = normaliseUnit(t, null, units); dimension = code1 ? dimensionOf(code1, units) : null; }
      if (!dimension) errors.push(`“${measuredText}” isn’t how an item can be measured. Use weight, volume, count or servings.`);
      else {
        const wanted = baseUnitFor(dimension, units);
        if (existing && existing.baseUnit !== wanted) {
          errors.push(`“${existing.name}” is already measured by ${dimensionOf(existing.baseUnit, units)}, which can’t be changed from an import. Leave measured_by blank to keep it.`);
        } else baseUnit = wanted;
      }
    } else if (!existing) errors.push('Say how this item is measured: weight, volume, count or servings.');

    // Pack unit (one per row) and display unit.
    const packName = cell('pack_name');
    const packSize = raw('pack_size');
    const packUnitText = cell('pack_unit');
    const displayText = cell('display_unit');
    const probe = { name: name || existing?.name || 'This item', baseUnit, displayUnit: undefined, units: (existing?.units || []).map((u) => ({ name: u.name, factor: u.factor })) };
    let pack = null;
    if (packName || packSize || packUnitText) {
      if (!packName || !packSize) errors.push('A pack needs both a pack_name (like crate) and a pack_size (like 10). Fill both, or clear the pack columns.');
      else if (baseUnit) {
        if (packName.length > 30) errors.push(`Keep the pack name “${packName.slice(0, 30)}…” under 30 characters.`);
        else if (normaliseUnit(packName, null, units)) errors.push(`“${packName}” is already a standard unit. Give the pack its own name, like crate or carton.`);
        else {
          const sizeIn = typed(packSize);
          if (!sizeIn) errors.push(`The pack size “${packSize}” must be a number, like 10.`);
          else {
            const factor = attempt(errors, () => toBase(sizeIn.quantity, packUnitText || sizeIn.unit || displayText || baseUnit, { ...probe, units: [] }, units, { positive: true, label: `The size of ${packName}` }));
            if (factor) {
              pack = { name: packName, factor };
              const old = (existing?.units || []).find((u) => u.name.toLowerCase() === packName.toLowerCase());
              const shown = `${sizeIn.quantity} ${packUnitText || sizeIn.unit || displayText || baseUnit}`;
              if (!old) changes.push(`Add the pack ${packName} = ${shown}`);
              else if (cmp(old.factor, factor) !== 0) changes.push(`Change the pack ${old.name} to ${shown}`);
              else pack = { ...pack, same: true };
              probe.units = [...probe.units.filter((u) => u.name.toLowerCase() !== packName.toLowerCase()), { name: old?.name || packName, factor }];
              if (old) pack.name = old.name;
            }
          }
        }
      }
    }
    let displayUnit = existing?.displayUnit;
    if (displayText && baseUnit) {
      const found = normaliseUnit(displayText, probe, units);
      if (!found) errors.push(`“${displayText}” isn’t a unit Cravio knows. Use a standard unit for how this item is measured (like kg or L) or the pack name.`);
      else if (!probe.units.some((u) => u.name === found) && dimensionOf(found, units) !== dimensionOf(baseUnit, units)) {
        errors.push(`“${displayText}” can’t be used to show ${name || 'this item'}: it is measured by ${dimensionOf(baseUnit, units)}, and ${displayText} is a different kind of unit.`);
      } else {
        if ((existing?.displayUnit || null) !== found) changes.push(`Show it in ${found}`);
        displayUnit = found;
      }
    }
    probe.displayUnit = displayUnit;

    // Type, storage, yield, low level, category.
    const kindText = cell('kind').toLowerCase();
    let kind = null;
    if (kindText) { if (!KINDS.includes(kindText)) errors.push(`“${cell('kind')}” isn’t a type. Use ${list(KINDS)}.`); else { kind = kindText; if (existing && existing.kind !== kind) changes.push(`Set the type to ${kind}`); } }
    const storageText = cell('storage').toLowerCase();
    let storage = null;
    if (storageText) { if (!STORAGES.includes(storageText)) errors.push(`“${cell('storage')}” isn’t a storage type. Use ${list(STORAGES)}.`); else { storage = storageText; if (existing && existing.storage !== storage) changes.push(`Set storage to ${storage}`); } }
    let yieldPct = null;
    if (cell('yield_pct')) {
      const n = Number(cell('yield_pct').replace(/%$/, '').trim());
      if (!Number.isFinite(n) || n <= 0 || n > 100 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) errors.push('Usable yield must be more than 0 and at most 100 (for example 85 when 15% is trimmed away), with at most 2 decimals.');
      else { yieldPct = Math.round(n * 100) / 100; if (existing && existing.yieldPct !== yieldPct) changes.push(`Set the usable yield to ${yieldPct}%`); }
    }
    let lowLevel = null;
    if (cell('low_level') && baseUnit) {
      const t = typed(cell('low_level'));
      if (!t) errors.push(`The low-stock level “${cell('low_level')}” must be a number, like 20.`);
      else {
        const base = attempt(errors, () => toBase(t.quantity, t.unit || displayUnit || baseUnit, probe, units, { label: 'The low-stock level' }));
        if (base && isNeg(dec(base))) errors.push('The low-stock level can’t be negative.');
        else if (base) { lowLevel = base; if (!existing || existing.lowLevel === null || cmp(existing.lowLevel, base) !== 0) changes.push(`Set the low-stock level to ${t.quantity} ${t.unit || displayUnit || baseUnit}`); }
      }
    }
    let category = null; // { id|null, name }
    if (cell('category')) {
      const wanted = cell('category');
      if (wanted.length > 60) errors.push('Keep the category name under 60 characters.');
      else {
        const hit = catByName.get(wanted.toLowerCase());
        if (hit) { category = hit; if (!existing || existing.categoryId !== hit.id || hit.id === null) changes.push(`Put it in ${hit.name}`); }
        else {
          category = { id: null, name: newCategories.get(wanted.toLowerCase()) || wanted, create: true };
          if (!newCategories.has(wanted.toLowerCase())) { newCategories.set(wanted.toLowerCase(), wanted); warnings.push(`The category “${wanted}” doesn’t exist yet, so it will be created.`); }
          changes.push(`Put it in ${wanted}`);
        }
      }
    }

    // Opening balance.
    let opening = null;
    const openingQty = raw('opening_qty');
    if (openingQty) {
      const where = findLocation(ctx, raw('location') || 'warehouse');
      if (where.error) errors.push(where.error);
      else if (!can(scope, 'inv.stock.record', { locationId: where.location.id })) errors.push(`You can’t record stock at ${where.location.name}.`);
      else if (baseUnit) {
        const prepared = attempt(errors, () => prepareLine({ id: existing?.id || null, name: name || 'this item', baseUnit, displayUnit, units: probe.units }, {
          quantity: openingQty, unit: cell('opening_unit') || undefined, unitCost: raw('opening_cost_per_unit') }, units, name || 'this item'));
        if (prepared === null && !errors.length) warnings.push('The opening amount is zero, so no opening stock will be recorded.');
        else if (prepared) {
          opening = { locationId: where.location.id, locationName: where.location.name, quantity: prepared.entered.quantity, unit: prepared.entered.unit, unitCost: raw('opening_cost_per_unit') || null, shown: prepared.shown };
          if (existing) {
            const key = commandId ? lineKey(commandId, where.location.id, existing.id) : null;
            const message = await openingBlocker(db, { businessId: scope.businessId, locationId: where.location.id, item: existing, locationLabel: where.location.name, replayKey: key, units });
            if (message) { errors.push(message); opening = null; }
            else if (key && (await openingOf(db, where.location.id, existing.id))) opening.alreadyRecorded = true;
          }
          if (opening && !opening.alreadyRecorded) changes.push(`Record opening stock: ${prepared.entered.quantity} ${prepared.entered.unit} at ${where.location.name}${prepared.unitCost ? ` (KES ${raw('opening_cost_per_unit').replace(/^\s*(kes|ksh|kshs)\.?\s*/i, '')} per ${prepared.entered.unit})` : ''}`);
        }
      }
    } else if (raw('opening_unit') || raw('opening_cost_per_unit')) {
      warnings.push('There is an opening unit or cost but no opening_qty, so no opening stock will be recorded.');
    }

    if (errors.length) row.action = 'error';
    else if (!existing) { row.action = 'create'; changes.unshift('Create the item'); } else row.action = changes.length ? 'update' : 'skip';
    if (row.action === 'skip') changes.push('Already up to date');
    row.itemId = existing?.id || null;
    row.apply = { existing, name, code, baseUnit, kind, storage, yieldPct, lowLevel, category, pack, displayUnit, displayText: Boolean(displayText), opening, line: rec.line };
    out.push(row);
  }
  return { rows: out, ignored: table.ignored, newCategories: [...newCategories.values()], units };
}

const summarise = (rows) => ({
  create: rows.filter((r) => r.action === 'create').length,
  update: rows.filter((r) => r.action === 'update').length,
  skip: rows.filter((r) => r.action === 'skip').length,
  errors: rows.filter((r) => r.action === 'error').length,
  warnings: rows.reduce((n, r) => n + r.warnings.length, 0),
  openings: rows.filter((r) => r.action !== 'error' && r.apply.opening && !r.apply.opening.alreadyRecorded).length,
});

const publicRow = ({ apply, ...row }) => ({ ...row, opening: apply.opening ? { locationName: apply.opening.locationName, quantity: apply.opening.quantity, unit: apply.opening.unit, display: apply.opening.shown } : null });

function report(checked) {
  const fileWarnings = checked.ignored.map((h) => `The column “${h}” isn’t used and was ignored.`);
  const rows = checked.rows.map(publicRow);
  const summary = summarise(checked.rows);
  return { ok: summary.errors === 0, summary, rows, fileWarnings, columns: [...TEMPLATE_COLUMNS] };
}

/** Checks the file and reports row by row what would happen. Writes nothing (safe on a read-only handle). Needs inv.item.edit. */
export async function dryRun(db, scope, csvText) {
  requireCan(scope, 'inv.item.edit');
  const checked = await checkRows(db, scope, readTable(csvText));
  return { ...report(checked), dryRun: true };
}

const rethrow = (row, e) => {
  if (!(e instanceof HttpError)) throw e;
  throw new HttpError(e.status, `Line ${row.line} (${row.name}): ${e.message}`, e.details);
};

/**
 * Applies the file in the caller's transaction. Re-checks everything first and refuses (409 import_has_errors, details.report) when any row
 * has an error: all or nothing. `commandId` makes the opening balances replay-safe (the route also wraps the whole call in once()).
 */
export async function commit(db, scope, csvText, { commandId = null } = {}) {
  requireCan(scope, 'inv.item.edit');
  const table = readTable(csvText);
  const checked = await checkRows(db, scope, table, { commandId });
  const summary = summarise(checked.rows);
  if (summary.errors) {
    const n = summary.errors;
    throw fail(409, `${n} ${n === 1 ? 'row has a problem' : 'rows have problems'}, so nothing was imported. Fix the rows marked in the report and upload the file again.`, 'import_has_errors', { report: report(checked) });
  }

  // Categories: seed the defaults the first time (so the dry-run's view matches), then create the unknown ones once each.
  const categories = new Map((await listCategories(db, scope)).map((c) => [c.name.toLowerCase(), c.id]));
  for (const wanted of checked.newCategories) {
    if (!categories.has(wanted.toLowerCase())) categories.set(wanted.toLowerCase(), (await createCategory(db, scope, { name: wanted })).id);
  }
  const categoryId = (c) => (c ? categories.get(c.name.toLowerCase()) : undefined);

  const done = [];
  for (const row of checked.rows) {
    const a = row.apply;
    let itemId = a.existing?.id || null;
    let openingMovementId = null;
    try {
      if (row.action === 'create') {
        const item = await createItem(db, scope, {
          name: a.name, baseUnit: a.baseUnit, sku: a.code || undefined, kind: a.kind || undefined, storage: a.storage || undefined, categoryId: categoryId(a.category),
          displayUnit: a.displayUnit || undefined, units: a.pack ? [{ name: a.pack.name, factor: a.pack.factor }] : undefined,
          yieldPct: a.yieldPct ?? undefined, lowLevel: a.lowLevel ? { quantity: a.lowLevel, unit: a.baseUnit } : undefined,
        });
        itemId = item.id;
      } else if (row.action === 'update') {
        const patch = {};
        const ex = a.existing;
        if (a.name && a.name.toLowerCase() !== ex.name.toLowerCase()) patch.name = a.name;
        if (a.code && (ex.sku || '').toLowerCase() !== a.code.toLowerCase()) patch.sku = a.code;
        if (a.kind && a.kind !== ex.kind) patch.kind = a.kind;
        if (a.storage && a.storage !== ex.storage) patch.storage = a.storage;
        if (a.yieldPct !== null && a.yieldPct !== ex.yieldPct) patch.yieldPct = a.yieldPct;
        if (a.category && categoryId(a.category) !== ex.categoryId) patch.categoryId = categoryId(a.category);
        if (a.lowLevel && (ex.lowLevel === null || cmp(ex.lowLevel, a.lowLevel) !== 0)) patch.lowLevel = { quantity: a.lowLevel, unit: ex.baseUnit };
        const displayChanged = a.displayText && a.displayUnit && (ex.displayUnit || null) !== a.displayUnit;
        if (a.pack && !a.pack.same) {
          const kept = ex.units.filter((u) => u.name.toLowerCase() !== a.pack.name.toLowerCase());
          const old = ex.units.find((u) => u.name.toLowerCase() === a.pack.name.toLowerCase());
          await setItemUnits(db, scope, ex.id, [...kept, { name: a.pack.name, factor: a.pack.factor, forPurchase: old?.forPurchase ?? true, forRecipe: old?.forRecipe ?? false, forCount: old?.forCount ?? true }],
            displayChanged ? { displayUnit: a.displayUnit } : {});
        } else if (displayChanged) patch.displayUnit = a.displayUnit;
        if (Object.keys(patch).length) await updateItem(db, scope, ex.id, patch);
      }
      if (a.opening && !a.opening.alreadyRecorded) {
        const result = await setOpening(db, scope, { locationId: a.opening.locationId, commandId,
          lines: [{ itemId, quantity: a.opening.quantity, unit: a.opening.unit, unitCost: a.opening.unitCost }] });
        openingMovementId = result.results[0]?.movementId || null;
      }
    } catch (e) { rethrow({ line: row.line, name: row.name }, e); }
    done.push({ ...publicRow(row), itemId, openingMovementId });
  }

  await record(db, { businessId: scope.businessId, actorId: scope.userId, actorRole: scope.role, entity: 'import', entityId: commandId, action: 'commit',
    after: { rows: done.length, ...summary } });
  return { ok: true, committed: true, summary, rows: done, fileWarnings: checked.ignored.map((h) => `The column “${h}” isn’t used and was ignored.`), columns: [...TEMPLATE_COLUMNS] };
}
