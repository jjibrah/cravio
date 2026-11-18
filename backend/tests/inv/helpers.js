// Shared test helpers for the inventory suites (P2-02). Everything here works on a disposable PGlite database and
// never touches the shared one. Import what you need:
//   import { makeAsserts, keyGen, makeItem, receive, fakeClock, fakeStorage } from './helpers.js';
import assert from 'node:assert/strict';
import { post } from '../../src/inventory/ledger.js';

/** Assertion helpers that count checks: const { eq, ok, refuses, count } = makeAsserts(); ... console.log(`${count()} checks`). */
export function makeAsserts() {
  let checks = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
  const ok = (v, m) => { assert.ok(v, m); checks++; };
  /** Awaits `promise`, expects an HttpError with `status`, `details.code` and (optionally) a message matching `re`. Returns the error. */
  const refuses = async (promise, status, code, re, m = `${code}`) => {
    let caught = null;
    try { await promise; } catch (e) { caught = e; }
    assert.ok(caught, `${m}: expected a refusal (${status} ${code}) but the call succeeded`);
    eq(caught.status, status, `${m}: status`);
    eq(caught.details?.code, code, `${m}: code`);
    if (re) assert.match(caught.message, re, `${m}: message`);
    return caught;
  };
  return { eq, ok, refuses, count: () => checks };
}

/** Unique idempotency keys: const key = keyGen('t'); key() -> 't-1', 't-2' ... */
export function keyGen(prefix = 'k') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/**
 * Creates a stock item. `packs` = [{ name: 'crate', factor: 10000 }] adds item-specific units (base units per pack).
 * Defaults: unit 'g' shown as 'kg'. Returns the item id.
 */
export async function makeItem(db, businessId, name, { unit = 'g', displayUnit = 'kg', packs = [], lowLevel = null, yieldPct = null } = {}) {
  const id = (await db.query(`insert into public.stock_items (business_id, name, unit, display_unit, low_level) values ($1, $2, $3, $4, $5) returning id`,
    [businessId, name, unit, displayUnit, lowLevel])).rows[0].id;
  if (yieldPct !== null) await db.query('update public.stock_items set yield_pct = $2 where id = $1', [id, yieldPct]);
  for (const [position, p] of packs.entries()) {
    await db.query(`insert into public.stock_item_units (item_id, name, factor, position) values ($1, $2, $3, $4)`, [id, p.name, p.factor, position]);
  }
  return id;
}

/**
 * Creates a supplier row directly (needs migration 015). Defaults: formal, active, cash, no contact details.
 * Returns the supplier id. Pass any column in camelCase-free form: { phone: '254712345678', kraPin, type, status, incomplete }.
 */
export async function makeSupplier(db, businessId, name, { type = 'formal', phone = null, kraPin = null, status = 'active', incomplete = false } = {}) {
  return (await db.query(`insert into public.suppliers (business_id, name, type, phone, kra_pin, status, incomplete) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [businessId, name, type, phone, kraPin, status, incomplete])).rows[0].id;
}

let receiveSeq = 0;
/** Receives stock through the ledger (one transaction). qty is a base-unit string. Returns ledger.post's result. */
export function receive(db, { businessId, locationId, itemId, qty, unitCost = null, reason = 'purchase_receipt', actorId = null, key = null, ref = null }) {
  return db.transaction((t) => post(t, { businessId, locationId, itemId, qty, reason, unitCost, actorId, ref, idempotencyKey: key || `helper-rcv-${++receiveSeq}` }));
}

/** A clock a test can move: const clock = fakeClock('2026-11-18T09:00:00+03:00'); clock.now() -> Date; clock.advance(5 * 60_000). */
export function fakeClock(start = '2026-11-18T09:00:00+03:00') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    iso: () => new Date(t).toISOString(),
    set: (value) => { t = new Date(value).getTime(); },
    advance: (ms) => { t += ms; return new Date(t); },
    advanceDays: (d) => { t += d * 86_400_000; return new Date(t); },
  };
}

/**
 * In-memory stand-in for the private `inventory-evidence` bucket (D2-8): the API issues a signed UPLOAD token, the browser
 * uploads, the API issues a 5-minute signed VIEW url after its own permission check. Tests inject it where the real
 * Supabase Storage client would go and may simulate the browser with put().
 *   const storage = fakeStorage({ clock });
 *   const up = await storage.createSignedUpload({ path, contentType, size });      // { path, token, expiresAt }
 *   await storage.put(up.path, up.token, bytes);                                  // what the browser would do
 *   const view = await storage.createSignedUrl(path, 300);                         // { url, expiresAt }
 *   storage.verify(view.url) -> true until expiry
 * Rules mirror D2-8: jpeg/png/webp/pdf only, at most 8 MB; an upload token works once and for 10 minutes.
 */
export function fakeStorage({ clock = fakeClock(), maxBytes = 8 * 1024 * 1024, allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] } = {}) {
  const objects = new Map();   // path -> { bytes, contentType, size, storedAt }
  const tokens = new Map();    // token -> { path, contentType, size, expiresAt, used }
  let n = 0;
  const refuse = (message, code) => Object.assign(new Error(message), { status: 400, details: { code } });
  return {
    objects,
    async createSignedUpload({ path, contentType, size }) {
      if (!allowed.includes(contentType)) throw refuse('Only photos (JPEG, PNG, WebP) and PDFs can be attached.', 'bad_file_type');
      if (!(size > 0) || size > maxBytes) throw refuse('That file is too big. The limit is 8 MB.', 'file_too_big');
      const token = `up-${++n}`;
      const expiresAt = new Date(clock.now().getTime() + 10 * 60_000);
      tokens.set(token, { path, contentType, size, expiresAt, used: false });
      return { path, token, expiresAt };
    },
    async put(path, token, bytes) {
      const t = tokens.get(token);
      if (!t || t.path !== path) throw refuse('Upload link not recognised.', 'bad_upload_token');
      if (t.used) throw refuse('Upload link already used.', 'upload_token_used');
      if (clock.now() > t.expiresAt) throw refuse('Upload link expired.', 'upload_token_expired');
      if (bytes.length > t.size) throw refuse('File is larger than announced.', 'file_too_big');
      t.used = true;
      objects.set(path, { bytes, contentType: t.contentType, size: bytes.length, storedAt: clock.now() });
    },
    async exists(path) { return objects.has(path); },
    async head(path) { const o = objects.get(path); return o ? { contentType: o.contentType, size: o.size } : null; },
    async createSignedUrl(path, expiresInSeconds = 300) {
      if (!objects.has(path)) throw Object.assign(new Error('File not found.'), { status: 404, details: { code: 'file_not_found' } });
      const expiresAt = new Date(clock.now().getTime() + expiresInSeconds * 1000);
      return { url: `https://storage.test/inventory-evidence/${encodeURIComponent(path)}?exp=${expiresAt.getTime()}`, expiresAt };
    },
    verify(url) {
      const m = /inventory-evidence\/([^?]+)\?exp=(\d+)/.exec(url);
      return !!m && objects.has(decodeURIComponent(m[1])) && clock.now().getTime() <= Number(m[2]);
    },
    async remove(path) { objects.delete(path); },
  };
}
