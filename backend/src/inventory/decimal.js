// Exact fixed-point decimals for the inventory ledger. A Dec is a BigInt count of 10^-scale units ("scaled integer"),
// so there is no floating point anywhere: 0.1 + 0.2 is exactly 0.3 and 1000 round trips never drift.
//
// Scales used by the database columns: QTY 4 (numeric(18,4)), COST 6 (numeric(18,6), KES per base unit),
// MONEY 2 (numeric(14,2)).
//
// Rounding: every operation that can lose digits (mul, div, rescale, toString) takes an explicit scale and a
// rounding mode. The default is 'half-up' = round half away from zero (2.5 -> 3, -2.5 -> -3), the way people
// round money by hand. Modes: 'half-up', 'half-even', 'down' (toward zero), 'exact' (throw if any digit would be lost).
import { HttpError } from '../lib/http.js';

export const QTY = 4;
export const COST = 6;
export const MONEY = 2;
export const ROUNDING = ['half-up', 'half-even', 'down', 'exact'];
const MAX_DIGITS = 40;

const POW = new Map();
const pow10 = (n) => {
  if (!POW.has(n)) POW.set(n, 10n ** BigInt(n));
  return POW.get(n);
};
const abs = (n) => (n < 0n ? -n : n);

export class Dec {
  /** @param {bigint} n scaled integer  @param {number} s scale (digits after the point) */
  constructor(n, s) {
    this.n = n;
    this.s = s;
    Object.freeze(this);
  }

  /** Fixed-point string for SQL numeric params. Default: own scale. Throws if digits would be lost in 'exact' mode. */
  toString(scale = this.s, round = 'exact') {
    const d = rescale(this, scale, round);
    const neg = d.n < 0n;
    const digits = abs(d.n).toString().padStart(scale + 1, '0');
    const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    return neg ? `-${body}` : body;
  }

  /** For display only. Never feed the result back into ledger maths. */
  toNumber() {
    return Number(this.toString());
  }

  toJSON() {
    return this.toString();
  }
}

const bad = (msg) => new HttpError(400, msg, { code: 'bad_number' });

/**
 * Parses a decimal from a string, bigint, or finite number into a Dec with the precision it was written with.
 * Rejects NaN, Infinity, exponent notation ("1e400"), thousands separators and anything non-numeric.
 * `{ scale }` rescales: more precision than `scale` is refused unless `round` is given.
 */
export function dec(value, { scale, round = 'exact', label = 'Number' } = {}) {
  let d;
  if (value instanceof Dec) d = value;
  else if (typeof value === 'bigint') d = new Dec(value, 0);
  else {
    let text;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw bad(`${label} must be a real number.`);
      text = String(value);
    } else if (typeof value === 'string') text = value.trim();
    else throw bad(`${label} must be a number.`);
    const m = /^([+-])?(\d+\.?\d*|\.\d+)$/.exec(text);
    if (!m) {
      throw bad(typeof value === 'number'
        ? `${label} is too large or too small to handle. Pass it as text like "0.0000001".`
        : `“${String(value).slice(0, 30)}” isn’t a number. Type it like 12 or 0.5.`);
    }
    const [int, frac = ''] = m[2].split('.');
    const digits = `${int || '0'}${frac}`;
    if (digits.replace(/^0+/, '').length > MAX_DIGITS) throw bad(`${label} has too many digits.`);
    const n = BigInt(digits);
    d = new Dec(m[1] === '-' ? -n : n, frac.length);
  }
  return scale === undefined ? d : rescale(d, scale, round, label);
}
const D = (x) => (x instanceof Dec ? x : dec(x));

function divRound(num, den, round) {
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  const sign = (num < 0n) !== (den < 0n) ? -1n : 1n;
  if (round === 'down') return q;
  if (round === 'half-up') return 2n * abs(r) >= abs(den) ? q + sign : q;
  if (round === 'half-even') {
    const twice = 2n * abs(r);
    if (twice > abs(den) || (twice === abs(den) && q % 2n !== 0n)) return q + sign;
    return q;
  }
  throw new HttpError(400, 'That number has more decimal places than can be recorded.', { code: 'precision' });
}
const checkMode = (round) => {
  if (!ROUNDING.includes(round)) throw new TypeError(`Unknown rounding mode ${round}`);
};

/** Same value at another scale. Dropping digits follows `round` (default half-up; 'exact' throws if lossy). */
export function rescale(a, scale, round = 'half-up', label = 'Number') {
  checkMode(round);
  const d = D(a);
  if (!Number.isInteger(scale) || scale < 0) throw new TypeError('scale must be a non-negative integer');
  if (scale === d.s) return d;
  if (scale > d.s) return new Dec(d.n * pow10(scale - d.s), scale);
  try {
    return new Dec(divRound(d.n, pow10(d.s - scale), round), scale);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(400, `${label} has more than ${scale} decimal places.`, { code: 'precision' });
    throw e;
  }
}

/** a + b. Exact (scale = the finer of the two) unless `scale` is given. */
export function add(a, b, scale, round = 'half-up') {
  const x = D(a); const y = D(b);
  const s = Math.max(x.s, y.s);
  const sum = new Dec(x.n * pow10(s - x.s) + y.n * pow10(s - y.s), s);
  return scale === undefined ? sum : rescale(sum, scale, round);
}
export const sub = (a, b, scale, round = 'half-up') => add(a, neg(b), scale, round);

/** a × b at `scale` (required: you must say how many places the result keeps). */
export function mul(a, b, scale, round = 'half-up') {
  if (scale === undefined) throw new TypeError('mul needs an explicit result scale');
  const x = D(a); const y = D(b);
  return rescale(new Dec(x.n * y.n, x.s + y.s), scale, round);
}

/** a ÷ b at `scale` (required), e.g. div('200', '0.70', QTY) = 285.7143. Dividing by zero throws. */
export function div(a, b, scale, round = 'half-up') {
  if (scale === undefined) throw new TypeError('div needs an explicit result scale');
  checkMode(round);
  const x = D(a); const y = D(b);
  if (y.n === 0n) throw new RangeError('Division by zero');
  const num = x.n * pow10(y.s + scale);
  const den = y.n * pow10(x.s);
  return new Dec(divRound(num, den, round), scale);
}

export function cmp(a, b) {
  const x = D(a); const y = D(b);
  const s = Math.max(x.s, y.s);
  const l = x.n * pow10(s - x.s); const r = y.n * pow10(s - y.s);
  return l < r ? -1 : l > r ? 1 : 0;
}
export const eq = (a, b) => cmp(a, b) === 0;
export const isZero = (a) => D(a).n === 0n;
export const isNeg = (a) => D(a).n < 0n;
export const neg = (a) => { const d = D(a); return new Dec(-d.n, d.s); };
export const absolute = (a) => { const d = D(a); return new Dec(abs(d.n), d.s); };
