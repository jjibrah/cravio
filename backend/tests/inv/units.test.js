// Units and exact decimals (P1-04). Pure maths, no database.
// Usage: node backend/tests/inv/units.test.js
import assert from 'node:assert/strict';
import { dec, add, sub, mul, div, cmp, isZero, isNeg, neg, QTY, COST, MONEY } from '../../src/inventory/decimal.js';
import { DEFAULT_UNITS, baseUnitFor, normaliseUnit, toBase, fromBase, compatibleUnits, display, explain } from '../../src/inventory/units.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const throws = (fn, status, re, m) => {
  assert.throws(fn, (e) => { assert.equal(e.status, status, m); if (re) assert.match(e.message, re, m); return true; }, m);
  checks++;
};

// --- decimal ---
eq([QTY, COST, MONEY], [4, 6, 2], 'scale constants');
eq(add('0.1', '0.2').toString(), '0.3', '0.1 + 0.2 is exactly 0.3');
eq(sub('1', '0.9').toString(), '0.1', '1 - 0.9');
eq(dec('  12.50 ').toString(), '12.50', 'parse keeps written precision');
eq(dec('-0.5').toString(), '-0.5', 'negative');
eq(dec(5n).toString(), '5', 'bigint');
eq(dec(0.25).toString(), '0.25', 'number');
eq(dec('.5').toString(), '0.5', 'leading point');
eq(dec('1.23456', { scale: 2, round: 'half-up' }).toString(), '1.23', 'explicit rounding allowed');
eq(dec('1.235', { scale: 2, round: 'half-up' }).toString(), '1.24', 'half-up');
eq(dec('-1.235', { scale: 2, round: 'half-up' }).toString(), '-1.24', 'half-up away from zero');
eq(dec('1.235', { scale: 2, round: 'half-even' }).toString(), '1.24', 'half-even to even');
eq(dec('1.225', { scale: 2, round: 'half-even' }).toString(), '1.22', 'half-even to even (down)');
eq(dec('1.239', { scale: 2, round: 'down' }).toString(), '1.23', 'down truncates');
throws(() => dec('1.2345', { scale: 2 }), 400, /more than 2 decimal/, 'extra precision refused by default');
for (const badValue of ['abc', '', 'NaN', 'Infinity', '-Infinity', '1e400', '1e3', '1,000', '1.2.3', NaN, Infinity, 1e21, null, undefined, {}, '12kg']) {
  throws(() => dec(badValue), 400, null, `rejects ${String(badValue)}`);
}
throws(() => dec('1'.repeat(60)), 400, /too many digits/, 'absurdly long number');
eq(dec('1.5').toString(4), '1.5000', 'pad to scale');
eq(dec('1.5').toString(0, 'half-up'), '2', 'toString rounding');
throws(() => dec('1.5').toString(0), 400, null, 'toString refuses lossy by default');
eq(dec('-0.05').toString(1, 'half-up'), '-0.1', 'neg small');
eq(dec('0.004').toString(2, 'half-up'), '0.00', 'rounds to zero');
eq(dec('285.7143').toNumber(), 285.7143, 'toNumber for display');
eq(JSON.stringify({ q: dec('1.50') }), '{"q":"1.50"}', 'JSON as string');
eq([cmp('1.0', '1'), cmp('2', '10'), cmp('-1', '-2'), cmp('0.10', '0.1')], [0, -1, 1, 0], 'cmp across scales');
eq([isZero('0.000'), isZero('0.001'), isNeg('-0.1'), isNeg('0'), isNeg('-0')], [true, false, true, false, false], 'zero / neg');
eq(neg('3').toString(), '-3', 'neg');
eq(div('200', '0.70', QTY).toString(), '285.7143', 'yield: 200 g at 70% -> 285.7143 g');
eq(div('1000', '3', QTY).toString(), '333.3333', '1 kg / 3 portions stated at QTY scale');
eq(div('1000', '3', QTY, 'down').toString(), '333.3333', 'down');
eq(div('2000', '3', QTY).toString(), '666.6667', 'half-up on the way up');
eq(div('-2000', '3', QTY).toString(), '-666.6667', 'negative division');
eq(div('1', '8', 2).toString(), '0.13', '0.125 half-up');
eq(div('1', '8', 2, 'half-even').toString(), '0.12', '0.125 half-even');
assert.throws(() => div('1', '0', QTY), RangeError); checks++;
eq(mul('0.65', '285.7143', MONEY).toString(), '185.71', 'cost 0.65 KES/g x 285.7143 g at MONEY scale (185.714295)');
eq(mul('0.65', '285.7143', COST).toString(), '185.714295', 'same, exact at COST scale');
eq(mul('0.001', '1.5', MONEY).toString(), '0.00', 'tiny money rounds');
eq(mul('2.5', '2', 0).toString(), '5', 'mul scale 0');
throws(() => mul('1.25', '1', 1, 'exact'), 400, null, 'mul exact refuses lossy');
// unit cost per base unit: KES 130 for 5 kg = 5000 g -> 0.026 KES/g
eq(div('130', '5000', COST).toString(), '0.026000', 'unit cost per g');
eq(mul(div('130', '5000', COST), '300', MONEY).toString(), '7.80', '300 g of it costs KES 7.80');

// --- units: basics ---
eq(['g', 'ml', 'piece', 'serving'], ['weight', 'volume', 'count', 'serving'].map((d) => baseUnitFor(d)), 'base units');
throws(() => baseUnitFor('mass'), 400, null, 'unknown dimension');
const gram = { name: 'Flour', baseUnit: 'g', displayUnit: 'kg', units: [{ name: 'sack', factor: '50000' }] };
const mlItem = { name: 'Cooking oil', baseUnit: 'ml', displayUnit: 'l', units: [{ name: 'jerrycan', factor: '20000' }] };
const sodaA = { name: 'Soda A', baseUnit: 'piece', units: [{ name: 'carton', factor: '24' }] };
const sodaB = { name: 'Soda B', baseUnit: 'piece', units: [{ name: 'carton', factor: '12' }] };
const eggs = { name: 'Eggs', baseUnit: 'piece', displayUnit: 'piece', units: [{ name: 'tray', factor: '30' }] };
const chicken = { name: 'Chicken', baseUnit: 'g', displayUnit: 'kg', units: [{ name: 'crate', factor: '10000' }] };
const burger = { name: 'Chicken burger', baseUnit: 'serving', units: [] };

// T-INV-3
eq(toBase('1.5', 'l', mlItem), '1500.0000', 'T-INV-3: 1.5 L -> 1500 ml');
eq(toBase('1.5', 'L', mlItem), '1500.0000', 'unit code case');
eq(toBase('1', 'carton', sodaA), '24.0000', 'T-INV-3: carton of soda A = 24');
eq(toBase('1', 'carton', sodaB), '12.0000', 'T-INV-3: carton of soda B = 12');
eq(toBase('3', 'cartons', sodaA), '72.0000', 'plural per-item unit, case-insensitive');
eq(toBase('3', 'CARTON', sodaB), '36.0000', 'upper case per-item unit');
eq(toBase('40', 'crate', chicken), '400000.0000', '40 crates = 400 kg = 400,000 g');
eq(toBase('2', 'tray', eggs), '60.0000', 'tray of 30');
eq(toBase('7', 'piece', eggs), '7.0000', 'item base in its own unit');
eq(toBase('7', undefined, eggs), '7.0000', 'default unit is the base unit');
// the standard units
eq(toBase('1', 'tsp', mlItem), '5.0000', 'tsp = 5 ml');
eq(toBase('1', 'tbsp', mlItem), '15.0000', 'tbsp = 15 ml');
eq(toBase('1', 'cup', mlItem), '240.0000', 'cup = 240 ml');
eq(toBase('0.5', 'cup', mlItem), '120.0000', 'half a cup');
eq(toBase('250', 'mg', gram), '0.2500', '250 mg = 0.25 g');
eq(toBase('1', 'kg', gram), '1000.0000', 'kg');
eq(fromBase('240', 'cup', mlItem), '1.0000', 'ml -> cup');
eq(fromBase('1500', 'l', mlItem), '1.5000', 'ml -> l');
eq(fromBase('72', 'carton', sodaA), '3.0000', 'pieces -> carton');
eq(fromBase('72', 'carton', sodaB), '6.0000', 'same pieces are 6 of the 12-pack cartons');
eq(fromBase('1000', 'g', gram, DEFAULT_UNITS, { scale: 0 }), '1000', 'fromBase scale option');
// T-INV-4: refusals
throws(() => toBase('1', 'l', gram), 400, /Can’t use L for Flour: Flour is counted by weight \(g\).*Use kg, mg, g or sack/, 'T-INV-4: litres for a weight item');
throws(() => toBase('1', 'kg', mlItem), 400, /counted by volume.*Use L, ml, tsp, tbsp, cup or jerrycan/, 'T-INV-4: kg for a volume item');
throws(() => toBase('1', 'g', eggs), 400, /counted by the piece.*Use piece or tray/, 'T-INV-4: g for a count item');
throws(() => toBase('1', 'piece', burger), 400, /counted in servings.*Use serving/, 'T-INV-4: piece for a serving item');
throws(() => toBase('1', 'serving', eggs), 400, null, 'T-INV-4: serving for a piece item');
throws(() => toBase('1', 'crate', mlItem), 400, /isn’t a unit.*Cooking oil/, 'another item’s pack is not available');
throws(() => toBase('1', 'bucket', gram), 400, /isn’t a unit Cravio knows for Flour/, 'unknown unit');
throws(() => fromBase('1', 'l', gram), 400, null, 'fromBase cross dimension');
eq((() => { try { toBase('1', 'l', gram); } catch (e) { return e.details.code; } })(), 'unit_mismatch', 'mismatch error code');
eq(toBase('1', 'serving', burger), '1.0000', 'serving to serving');
throws(() => toBase('1', 'g', { name: 'X', baseUnit: 'stone', units: [] }), 400, null, 'unknown base unit');
throws(() => toBase('1', 'bad', { baseUnit: 'g', units: [{ name: 'bad', factor: '0' }] }), 400, /bigger than zero/, 'zero-size item unit');

// T-INV-5: no drift
{
  let g = dec('1234.5678');
  for (let i = 0; i < 1000; i++) {
    const kg = fromBase(g.toString(4), 'kg', gram, DEFAULT_UNITS, { scale: 7 });
    g = dec(toBase(kg, 'kg', gram));
  }
  eq(g.toString(4), '1234.5678', 'T-INV-5: g -> kg -> g x1000, no drift');
  let q = '0.0001';
  for (let i = 0; i < 1000; i++) q = toBase(fromBase(toBase(q, 'g', gram), 'mg', gram, DEFAULT_UNITS, { scale: 1 }), 'mg', gram);
  eq(q, '0.0001', '1000 round trips through mg at the smallest quantity');
  let sum = dec('0');
  for (let i = 0; i < 10000; i++) sum = add(sum, '0.1');
  eq(sum.toString(), '1000.0', '10,000 x 0.1 = 1000 exactly');
}
// 1/3 style
{
  const per = div('1000', '3', QTY);
  eq(per.toString(), '333.3333', '1 kg / 3 portions, stated scale');
  const back = mul(per, '3', QTY);
  eq(sub('1000', back).toString(), '0.0001', 'the 0.0001 g remainder is visible, not hidden');
  eq(toBase(fromBase('1000', 'kg', gram, DEFAULT_UNITS, { scale: 4 }), 'kg', gram), '1000.0000', 'whole kg survives');
}
// worked example: receive 5 kg, serve 3 x 100 g
{
  const received = toBase('5', 'kg', gram);
  eq(received, '5000.0000', 'receive 5 kg = +5000 g');
  const used = mul('3', toBase('100', 'g', gram), QTY).toString(QTY);
  eq(used, '300.0000', '3 x 100 g');
  const left = sub(received, used).toString(QTY);
  eq(left, '4700.0000', '4,700 g left');
  eq(display(left, gram), '4.7 kg', 'a tiny fraction of a sack is not shown as a hint');
  eq(display(left, { ...gram, units: [] }), '4.7 kg', 'display 4.7 kg');
  eq(display(left, { ...gram, displayUnit: 'g', units: [] }), '4,700 g', 'display 4,700 g');
}
// precision
eq(toBase('0.00001', 'kg', gram), '0.0100', '0.00001 kg = 0.01 g is fine');
eq(toBase('0.0001', 'g', gram), '0.0001', 'smallest quantity');
throws(() => toBase('0.00001', 'g', gram), 400, /too small to record in g.*4 decimal places/, '0.00001 g refused');
throws(() => toBase('0.00000001', 'kg', gram), 400, /smaller unit/, 'fraction of a gram refused');
eq(toBase('0.5', 'piece', eggs), '0.5000', 'half a piece is within 4 dp');
// positive-only
throws(() => toBase('0', 'g', gram, DEFAULT_UNITS, { positive: true }), 400, /more than zero/, 'zero refused when positive required');
throws(() => toBase('-1', 'kg', gram, DEFAULT_UNITS, { positive: true }), 400, /more than zero/, 'negative refused when positive required');
eq(toBase('-1', 'kg', gram), '-1000.0000', 'negative allowed by default (adjustments)');
eq(toBase('0', 'kg', gram), '0.0000', 'zero allowed by default');
throws(() => toBase('abc', 'kg', gram), 400, /isn’t a number/, 'abc');
throws(() => toBase(NaN, 'kg', gram), 400, null, 'NaN');
throws(() => toBase('1e400', 'kg', gram), 400, null, '1e400');
throws(() => toBase(Infinity, 'kg', gram), 400, null, 'Infinity');

// alias normalisation
eq(['grams', 'Gram', 'GMS', 'litres', 'Liters', 'ltr', 'pcs', 'PC', 'each', 'kilos', 'Kgs.', 'portions', 'teaspoon', 'tablespoons', 'cups', 'milligrams'].map((t) => normaliseUnit(t)),
  ['g', 'g', 'g', 'l', 'l', 'l', 'piece', 'piece', 'piece', 'kg', 'kg', 'serving', 'tsp', 'tbsp', 'cup', 'mg'], 'alias table');
eq(normaliseUnit('crates', chicken), 'crate', 'plural per-item unit');
eq(normaliseUnit('Crate', chicken), 'crate', 'case-insensitive per-item unit');
eq(normaliseUnit('crates'), null, 'per-item unit unknown without item');
eq([normaliseUnit(''), normaliseUnit(null), normaliseUnit('furlong')], [null, null, null], 'unknown / empty');
eq(normaliseUnit('trays', { baseUnit: 'piece', units: [{ name: 'Tray', factor: '30' }] }), 'Tray', 'returns the item’s own spelling');
eq(normaliseUnit('boxes', { baseUnit: 'piece', units: [{ name: 'box', factor: '6' }] }), 'box', '-es plural');
eq(toBase('2', 'Pcs', eggs), '2.0000', 'toBase accepts aliases');
eq(toBase('2', 'Litres', mlItem), '2000.0000', 'toBase accepts litres');

// dropdown
{
  const list = compatibleUnits(chicken).map((u) => u.code);
  eq(list, ['kg', 'mg', 'g', 'crate'], 'weight units + crate, display unit (kg) first');
  eq(compatibleUnits(mlItem).map((u) => u.code), ['l', 'ml', 'tsp', 'tbsp', 'cup', 'jerrycan'], 'volume units');
  eq(compatibleUnits(sodaA).map((u) => u.code), ['piece', 'carton'], 'count units: piece then carton');
  eq(compatibleUnits(burger).map((u) => u.code), ['serving'], 'serving only');
  eq(compatibleUnits(eggs).map((u) => u.code), ['piece', 'tray'], 'display unit piece first');
  eq(compatibleUnits({ ...chicken, displayUnit: 'crate' })[0].code, 'crate', 'a pack can be the display unit');
  eq(compatibleUnits(chicken).find((u) => u.code === 'crate').factor, '10000', 'item unit factor as string');
}

// display
eq(display('4700', { ...chicken, units: [{ name: 'crate', factor: '10000' }] }), '4.7 kg', 'under half a crate: no hint');
eq(display('5000', chicken), '5 kg · 0.5 crates', 'half a crate is shown');
eq(display('38400', chicken), '38.4 kg · about 3.8 crates', 'PRD sample');
eq(display('40000', chicken), '40 kg · 4 crates', 'exact pack count has no "about"');
eq(display('10000', chicken), '10 kg · 1 crate', 'one crate singular');
eq(display('0', chicken), '0 kg', 'zero');
eq(display('0.0001', { ...chicken, units: [] }), '0.0000001 kg', 'tiny amounts keep their digits');
eq(display('1', eggs), '1 piece', 'one piece');
eq(display('2', eggs), '2 pieces', 'two pieces');
eq(display('45', eggs), '45 pieces · 1.5 trays', 'trays');
eq(display('44', eggs), '44 pieces · about 1.5 trays', 'inexact pack count says about');
eq(display('24', sodaA), '24 pieces · 1 carton', 'carton of soda A');
eq(display('24', sodaB), '24 pieces · 2 cartons', 'same pieces on soda B');
eq(display('3', burger), '3 servings', 'servings');
eq(display('1', burger), '1 serving', 'one serving');
eq(display('4700', { ...gram, displayUnit: undefined, units: [] }), '4,700 g', 'default display unit is the base unit');
eq(display('1234567.5', { baseUnit: 'g', displayUnit: 'g', units: [] }), '1,234,567.5 g', 'thousand separators');
eq(display('-500', { baseUnit: 'g', displayUnit: 'g', units: [] }), '-500 g', 'negative');
eq(display('1500', mlItem), '1.5 L', 'litres');

// explain
eq(explain('40', 'crate', chicken), '40 crates = 400 kg', 'explain crates');
eq(explain('1', 'crate', chicken), '1 crate = 10 kg', 'explain one');
eq(explain('4', 'kg', chicken), '4 kg = 4,000 g', 'display unit entered -> shows base');
eq(explain('500', 'g', chicken), '500 g = 0.5 kg', 'grams to kg');
eq(explain('2', 'carton', sodaA), '2 cartons = 48 pieces', 'carton');
eq(explain('2', 'carton', sodaB), '2 cartons = 24 pieces', 'carton B');
eq(explain('3', 'piece', eggs), '3 pieces', 'same unit has nothing to explain');
eq(explain('1.5', 'l', mlItem), '1.5 L = 1,500 ml', 'litres explained');
eq(explain('2', 'tbsp', mlItem), '2 tbsp = 0.03 L', 'tbsp');
throws(() => explain('1', 'l', chicken), 400, /Use/, 'explain refuses mismatches');

console.log(`Units & decimals: ${checks} checks passed.`);
