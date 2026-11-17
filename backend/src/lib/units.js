// Stock units (migration 012). A stock item is counted in one unit; amounts entered in another unit of the same
// dimension (g ↔ kg, ml ↔ l) or in the item's pack ("crate" = 10 kg) are converted to the item's unit before storing.
// Conversions across dimensions (g → ml, piece → kg, serving → anything else) are refused.
import { HttpError } from './http.js';

export const UNITS = ['serving', 'piece', 'g', 'kg', 'ml', 'l'];
const SCALE = { serving: ['serving', 1], piece: ['piece', 1], g: ['weight', 1], kg: ['weight', 1000], ml: ['volume', 1], l: ['volume', 1000] };
const ALIASES = {
  serving: 'serving', servings: 'serving', portion: 'serving', portions: 'serving',
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', each: 'piece', unit: 'piece', units: 'piece', item: 'piece', items: 'piece',
  g: 'g', gm: 'g', gms: 'g', gr: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', mls: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
};
const WORD = { serving: ['serving', 'servings'], piece: ['piece', 'pieces'], g: ['g', 'g'], kg: ['kg', 'kg'], ml: ['ml', 'ml'], l: ['l', 'l'] };

export const isUnit = (unit) => UNITS.includes(unit);
export const dimension = (unit) => SCALE[unit]?.[0] || null;
/** Units a quantity of an item counted in `unit` may be entered in. */
export const compatibleUnits = (unit) => UNITS.filter((u) => dimension(u) && dimension(u) === dimension(unit));
/** A unit name from free text (e.g. an AI answer): "grams" → "g". Null when unknown. */
export const normaliseUnit = (text) => (typeof text === 'string' ? ALIASES[text.trim().toLowerCase().replace(/\.$/, '')] || null : null);

/** Rounds to 3 decimals (the precision of stored quantities); refuses amounts that would lose real precision. */
export function to3(value, { unit, label = 'Quantity' } = {}) {
  const rounded = Math.round(value * 1000) / 1000;
  if (Math.abs(rounded - value) > 1e-9 * Math.max(1, Math.abs(value))) {
    throw new HttpError(400, `${label} is too small to record in ${unit || 'this unit'} (at most 3 decimal places). Count the item in a smaller unit.`);
  }
  if (value > 0 && rounded === 0) throw new HttpError(400, `${label} is too small to record in ${unit || 'this unit'}.`);
  return rounded;
}

/** Converts `value` from one unit to another of the same dimension. */
export function convert(value, from, to, { label } = {}) {
  if (!isUnit(from)) throw new HttpError(400, `“${from}” isn’t a unit Cravio knows. Use ${UNITS.join(', ')}.`);
  if (!isUnit(to)) throw new HttpError(400, `“${to}” isn’t a unit Cravio knows. Use ${UNITS.join(', ')}.`);
  if (from === to) return value;
  if (dimension(from) !== dimension(to)) {
    throw new HttpError(400, `Can’t convert ${WORD[from][1]} to ${WORD[to][1]}: one is ${describe(from)}, the other ${describe(to)}. Use ${compatibleUnits(to).join(' or ')}.`, { code: 'unit_mismatch' });
  }
  return to3((value * SCALE[from][1]) / SCALE[to][1], { unit: to, label });
}
const describe = (unit) => ({ weight: 'a weight', volume: 'a volume', piece: 'a count of pieces', serving: 'servings' }[dimension(unit)]);

/**
 * An amount entered for `item` ({ unit, pack_name|packName, pack_size|packSize }) in `unit` (default: the item's unit;
 * 'pack' = the item's pack) → the amount in the item's unit.
 */
export function toItemUnit(value, unit, item, { label } = {}) {
  const itemUnit = item.unit;
  const packSize = Number(item.pack_size ?? item.packSize ?? 0);
  const packName = item.pack_name ?? item.packName;
  if (unit === undefined || unit === null || unit === '' || unit === itemUnit) return value;
  if (unit === 'pack' || (packName && typeof unit === 'string' && unit.trim().toLowerCase() === packName.toLowerCase())) {
    if (!packSize) throw new HttpError(400, `${item.name || 'This item'} has no pack size. Enter the amount in ${itemUnit}, or set a pack on the item.`);
    return to3(value * packSize, { unit: itemUnit, label });
  }
  return convert(value, unit, itemUnit, { label });
}

const trim = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''));
/** "3 servings", "1 piece", "0.6 kg". */
export function formatAmount(value, unit = 'serving') {
  const n = Number(value) || 0;
  const [one, many] = WORD[unit] || [unit, unit];
  return `${trim(n)} ${Math.abs(n) === 1 ? one : many}`;
}
/** "38.4 kg · about 3.8 crates" when the item has a pack. */
export function friendlyAmount(value, item) {
  const base = formatAmount(value, item.unit);
  const size = Number(item.pack_size ?? item.packSize ?? 0);
  const name = item.pack_name ?? item.packName;
  if (!size || !name) return base;
  const packs = Math.round((Number(value) / size) * 10) / 10;
  return `${base} · about ${trim(packs)} ${packs === 1 ? name : plural(name)}`;
}
export const plural = (name) => (/(s|x|ch|sh)$/i.test(name) ? `${name}es` : /[^aeiou]y$/i.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`);
