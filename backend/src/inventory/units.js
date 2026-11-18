// Inventory units. Quantities are STORED in one base unit per item ('g', 'ml', 'piece' or 'serving', 4 decimal places)
// but people type and read them in units they choose: standard units (kg, l, tsp...) and the item's own units
// ("crate" = 10 kg, "carton" = 24 pieces). All maths is exact (see decimal.js); nothing here uses floating point.
//
// Unit definitions are data: pass rows shaped like DEFAULT_UNITS (later read from the `units` table). Nothing below
// hardcodes g/kg/ml; the aliases only help turn free text ("grams") into a code.
//
// An `item` is { name?, baseUnit, displayUnit?, packUnit?, units: [{ name, factor, plural? }] } where `factor`
// is how many BASE units one of the item's own units holds (crate = '10000' for a gram item).
// Conversions across dimensions (weight / volume / count / serving) are refused: there is no density yet, and a
// serving never converts to a piece.
import { HttpError } from '../lib/http.js';
import { QTY, dec, rescale, mul, div, cmp, isZero, isNeg } from './decimal.js';

export const DIMENSIONS = ['weight', 'volume', 'count', 'serving'];

/** Seed rows for the `units` table (migration 012 uses the same array). toBase = how many of the dimension's base unit. */
export const DEFAULT_UNITS = Object.freeze([
  { code: 'mg', dimension: 'weight', toBase: '0.001', label: 'mg', plural: 'mg' },
  { code: 'g', dimension: 'weight', toBase: '1', label: 'g', plural: 'g' },
  { code: 'kg', dimension: 'weight', toBase: '1000', label: 'kg', plural: 'kg' },
  { code: 'ml', dimension: 'volume', toBase: '1', label: 'ml', plural: 'ml' },
  { code: 'l', dimension: 'volume', toBase: '1000', label: 'L', plural: 'L' },
  { code: 'tsp', dimension: 'volume', toBase: '5', label: 'tsp', plural: 'tsp' },
  { code: 'tbsp', dimension: 'volume', toBase: '15', label: 'tbsp', plural: 'tbsp' },
  { code: 'cup', dimension: 'volume', toBase: '240', label: 'cup', plural: 'cups' },
  { code: 'piece', dimension: 'count', toBase: '1', label: 'piece', plural: 'pieces' },
  { code: 'serving', dimension: 'serving', toBase: '1', label: 'serving', plural: 'servings' },
].map(Object.freeze));

const ALIASES = {
  mg: 'mg', mgs: 'mg', milligram: 'mg', milligrams: 'mg',
  g: 'g', gm: 'g', gms: 'g', gr: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', mls: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', each: 'piece', unit: 'piece', units: 'piece', item: 'piece', items: 'piece',
  serving: 'serving', servings: 'serving', portion: 'serving', portions: 'serving',
};

const bad = (msg, code = 'bad_unit') => new HttpError(400, msg, { code });
const clean = (text) => String(text ?? '').trim().toLowerCase().replace(/\.$/, '');

export const plural = (name) => (/(s|x|ch|sh)$/i.test(name) ? `${name}es` : /[^aeiou]y$/i.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`);

const rowOf = (code, units) => units.find((u) => u.code === code) || null;

/** The unit all quantities of this dimension are stored in (the row whose toBase is 1), e.g. 'weight' -> 'g'. */
export function baseUnitFor(dimension, units = DEFAULT_UNITS) {
  const row = units.find((u) => u.dimension === dimension && cmp(u.toBase, 1) === 0);
  if (!row) throw bad(`There is no base unit for “${dimension}”.`);
  return row.code;
}

/** 'weight' | 'volume' | 'count' | 'serving' for a unit code (null if unknown). */
export const dimensionOf = (code, units = DEFAULT_UNITS) => rowOf(code, units)?.dimension || null;

/**
 * Free text → unit code ("grams" → "g", "pcs" → "piece"). With `item`, the item's own unit names win:
 * "crates" or "Crate" → the item's "crate" (returned with the item's spelling). Null when unknown.
 */
export function normaliseUnit(text, item, units = DEFAULT_UNITS) {
  const t = clean(text);
  if (!t) return null;
  for (const u of item?.units || []) {
    const n = clean(u.name);
    if (t === n || t === clean(u.plural) || t === `${n}s` || t === plural(n).toLowerCase()) return u.name;
  }
  const code = ALIASES[t] || (rowOf(t, units) && t) || units.find((u) => clean(u.label) === t || clean(u.plural) === t)?.code;
  return code && rowOf(code, units) ? code : null;
}

function itemBase(item, units) {
  const row = item && rowOf(item.baseUnit, units);
  if (!row) throw bad(`This item isn’t counted in a unit Cravio knows (“${item?.baseUnit}”).`);
  return row;
}

/** Everything about one unit as used by one item: { code, label, plural, kind, dimension, factor (Dec, base units per 1) }. */
function resolve(unitText, item, units) {
  const base = itemBase(item, units);
  const code = normaliseUnit(unitText, item, units);
  if (!code) throw bad(`“${unitText}” isn’t a unit Cravio knows${forItem(item)}. Use ${usable(item, units)}.`);
  const own = (item.units || []).find((u) => u.name === code);
  if (own) {
    const factor = dec(own.factor, { label: `The size of ${own.name}` });
    if (isNeg(factor) || isZero(factor)) throw bad(`${own.name} needs a size bigger than zero.`);
    return { code: own.name, label: own.name, plural: own.plural || plural(own.name), kind: 'item', dimension: base.dimension, factor };
  }
  const row = rowOf(code, units);
  if (row.dimension !== base.dimension) {
    throw bad(`Can’t use ${row.plural} for ${item.name || 'this item'}: ${item.name || 'it'} is counted ${HOW[base.dimension]} (${base.label}), and ${row.label} is ${HOW_IS[row.dimension]}. Use ${usable(item, units)}.`, 'unit_mismatch');
  }
  return { code: row.code, label: row.label, plural: row.plural, kind: 'standard', dimension: row.dimension, factor: dec(row.toBase) };
}
const HOW = { weight: 'by weight', volume: 'by volume', count: 'by the piece', serving: 'in servings' };
const HOW_IS = { weight: 'a weight', volume: 'a volume', count: 'a count of pieces', serving: 'a serving' };
const forItem = (item) => (item?.name ? ` for ${item.name}` : '');
const usable = (item, units) => {
  const names = compatibleUnits(item, units).map((u) => u.label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] || 'a different unit';
};

/**
 * Amount typed in `unitCode` → base-unit decimal string at 4 dp (ready for a numeric(18,4) param).
 * Refuses: cross-dimension units, unknown units, amounts that would lose precision below 4 dp in the base unit,
 * and (with { positive: true }) zero or negative amounts.
 */
export function toBase(qty, unitCode, item, units = DEFAULT_UNITS, { positive = false, label = 'Quantity' } = {}) {
  const q = dec(qty, { label });
  if (positive && (isZero(q) || isNeg(q))) throw bad(`${label} must be more than zero.`, 'not_positive');
  const r = resolve(unitCode ?? item.baseUnit, item, units);
  const exact = mul(q, r.factor, q.s + r.factor.s, 'exact');
  try {
    return rescale(exact, QTY, 'exact', label).toString(QTY);
  } catch (e) {
    if (e.details?.code !== 'precision') throw e;
    const baseRow = rowOf(item.baseUnit, units);
    throw bad(`${label} is too small to record in ${baseRow.plural} (at most ${QTY} decimal places). Enter it in a smaller unit.`, 'precision');
  }
}

/** Base-unit amount → decimal string in `unitCode` (default scale 4, half-up). e.g. fromBase('5000', 'kg', gramItem) = '5.0000'. */
export function fromBase(qtyBase, unitCode, item, units = DEFAULT_UNITS, { scale = QTY, round = 'half-up' } = {}) {
  const r = resolve(unitCode ?? item.baseUnit, item, units);
  return div(dec(qtyBase), r.factor, scale, round).toString(scale);
}

/**
 * Units for a quantity dropdown: the standard units of the item's dimension (smallest first) then the item's own
 * units, with the item's display unit first. Each: { code, label, plural, kind: 'standard'|'item', factor (string, base units per 1) }.
 */
export function compatibleUnits(item, units = DEFAULT_UNITS) {
  const base = itemBase(item, units);
  const standard = units.filter((u) => u.dimension === base.dimension)
    .sort((a, b) => cmp(a.toBase, b.toBase))
    .map((u) => ({ code: u.code, label: u.label, plural: u.plural, kind: 'standard', factor: dec(u.toBase).toString() }));
  const own = (item.units || []).map((u) => ({ code: u.name, label: u.name, plural: u.plural || plural(u.name), kind: 'item', factor: dec(u.factor).toString() }));
  const all = [...standard, ...own];
  const first = all.findIndex((u) => u.code === item.displayUnit);
  return first > 0 ? [all[first], ...all.slice(0, first), ...all.slice(first + 1)] : all;
}

const group = (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** "4700" → "4,700"; "38.4000" → "38.4"; rounds half-up to `maxDp`. */
function fmt(value, maxDp) {
  const text = rescale(value, maxDp, 'half-up').toString(maxDp);
  const [int, frac = ''] = text.replace('-', '').split('.');
  const trimmed = frac.replace(/0+$/, '');
  const neg = text.startsWith('-') && (int !== '0' || trimmed);
  return `${neg ? '-' : ''}${group(int)}${trimmed ? `.${trimmed}` : ''}`;
}
const word = (r, text) => (text === '1' ? r.label : r.plural);

function displayUnitOf(item, units) {
  if (item.displayUnit) {
    try { return resolve(item.displayUnit, item, units); } catch { /* falls back to the base unit */ }
  }
  return resolve(item.baseUnit, item, units);
}

/**
 * Friendly amount in the item's display unit, plus one pack hint when the item has its own units:
 * "38.4 kg · about 3.8 crates", "4.7 kg", "4,700 g", "1 piece", "2 pieces". The pack is item.packUnit or the
 * item's first own unit. "about" is left out when the pack count is exact.
 */
export function display(qtyBase, item, units = DEFAULT_UNITS) {
  const b = dec(qtyBase);
  const shown = displayUnitOf(item, units);
  const v = div(b, shown.factor, 9);
  let text = fmt(v, 3);
  if (text === '0' && !isZero(b)) text = fmt(v, 9);
  let out = `${text} ${word(shown, text)}`;
  const packName = item.packUnit || item.units?.[0]?.name;
  if (packName && !isZero(b)) {
    const pack = resolve(packName, item, units);
    if (pack.code !== shown.code) {
      const p = div(b, pack.factor, 6);
      const rounded = fmt(p, 1);
      if (cmp(p, '0.5') >= 0) { // a hint like "about 0.1 sacks" is noise
        const exact = cmp(rescale(p, 1, 'half-up'), p) === 0;
        out += ` · ${exact ? '' : 'about '}${rounded} ${word(pack, rounded)}`;
      }
    }
  }
  return out;
}

/**
 * The live line under a quantity box: "40 crates = 400 kg". Converts into the display unit, or into the base unit
 * when the amount is already in the display unit ("4 kg = 4,000 g"). Throws the same plain errors as toBase.
 */
export function explain(qty, unitCode, item, units = DEFAULT_UNITS) {
  const entered = resolve(unitCode ?? item.baseUnit, item, units);
  const base = toBase(qty, entered.code, item, units);
  let target = displayUnitOf(item, units);
  if (target.code === entered.code) target = resolve(item.baseUnit, item, units);
  const q = fmt(dec(qty), 4);
  const left = `${q} ${word(entered, q)}`;
  if (target.code === entered.code) return left;
  const v = div(base, target.factor, 9);
  let text = fmt(v, 4);
  if (text === '0' && !isZero(dec(base))) text = fmt(v, 9);
  return `${left} = ${text} ${word(target, text)}`;
}
