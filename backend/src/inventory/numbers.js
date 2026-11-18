// Document numbers (D2-10): PO-2026-0001, GRN-2026-0001, EP-..., RET-..., TRF-..., REQ-... One counter per business, kind and
// year (public.inventory_number_sequences, migration 015). The counter is bumped with a single upsert INSIDE the caller's
// transaction: the row lock serialises concurrent callers, and if the document's transaction rolls back the number goes back
// with it, so numbers are gap-free and never repeat. Call it in the same transaction that inserts the document.
import { HttpError } from '../lib/http.js';

const KIND_RE = /^[A-Z]{2,6}$/;

/** The calendar year in Africa/Nairobi for `now` (numbers roll over at local midnight on 1 January). */
export function nairobiYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric' }).format(now));
}

export const formatNumber = (kind, year, seq) => `${kind}-${year}-${String(seq).padStart(4, '0')}`;

/**
 * Takes the next number: { kind, year, seq, number } with number = "PO-2026-0001" (at least 4 digits; grows past 9999).
 * `year` defaults to the current year in Nairobi; pass `now` (a Date) to control it in tests.
 */
export async function nextSequence(db, { businessId, kind, year, now } = {}) {
  if (!businessId) throw new TypeError('nextNumber needs a businessId.');
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) throw new TypeError('nextNumber: kind must be 2 to 6 capital letters, like PO or GRN.');
  const y = year === undefined || year === null ? nairobiYear(now || new Date()) : Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2999) throw new HttpError(400, 'The year for a document number must be between 2000 and 2999.', { code: 'bad_year' });
  const { rows } = await db.query(
    `insert into public.inventory_number_sequences (business_id, kind, year, last_number) values ($1, $2, $3, 1)
     on conflict (business_id, kind, year) do update set last_number = public.inventory_number_sequences.last_number + 1, updated_at = now()
     returning last_number`, [businessId, kind, y]);
  const seq = rows[0].last_number;
  return { kind, year: y, seq, number: formatNumber(kind, y, seq) };
}

/** The next document number as text, e.g. nextNumber(tx, { businessId, kind: 'PO' }) -> "PO-2026-0001". */
export async function nextNumber(db, options) {
  return (await nextSequence(db, options)).number;
}

/** What the next number would be, without taking it (for a "next number" hint on a form; not a reservation). */
export async function peekNumber(db, { businessId, kind, year, now } = {}) {
  const y = year === undefined || year === null ? nairobiYear(now || new Date()) : Number(year);
  const { rows } = await db.query('select last_number from public.inventory_number_sequences where business_id = $1 and kind = $2 and year = $3', [businessId, kind, y]);
  return formatNumber(kind, y, (rows[0]?.last_number ?? 0) + 1);
}
