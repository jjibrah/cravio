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

// ---------------------------------------------------------------------------------------------------------------------
// Phase 3 additions (P3-02). Additive: nothing above changes.
// ---------------------------------------------------------------------------------------------------------------------

/** The reason codes P3-03 seeds on first use (10 P3-03): handy for tests of wastage/adjustments before that service exists. */
export const DEFAULT_REASON_CODES = Object.freeze({
  wastage: ['burned', 'spoiled', 'expired', 'prep_error', 'spill', 'damaged', 'customer_return', 'over_production', 'theft_suspected'],
  adjustment: ['found', 'recount', 'damaged', 'theft_suspected'],
});

/** A prepared (made in-house) item: makeItem plus kind = 'prepared' (012 column). Recipes for it arrive with P3-12/13. Returns the item id. */
export async function makePrepared(db, businessId, name, options = {}) {
  const id = await makeItem(db, businessId, name, options);
  await db.query(`update public.stock_items set kind = 'prepared' where id = $1`, [id]);
  return id;
}

/**
 * A batch of a tracked item at a location (needs migration 022, P3-16; the columns follow 10 P3-16 and the fefo-serve spike, revisit when
 * 022 lands). Writes the batch, its balance and an inbound movement that carries batch_id, in one transaction. Returns the batch id.
 *   makeBatch(db, { businessId, locationId, itemId, batchNo: 'A', qty: '5000', expiryInDays: 3, unitCost: '0.4' })
 */
export async function makeBatch(db, { businessId, locationId, itemId, batchNo, qty, expiryInDays = null, expiryDate = null, unitCost = null, receivedAt = null, key = null }) {
  const present = (await db.query(`select to_regclass('public.batches') is not null as ok`)).rows[0].ok;
  if (!present) throw new Error('makeBatch needs migration 022 (batches), which is not applied in this database.');
  return db.transaction(async (t) => {
    const batchId = (await t.query(`insert into public.batches (business_id, item_id, batch_no, received_at, expiry_date, unit_cost)
      values ($1, $2, $3, coalesce($4::timestamptz, now()), coalesce($5::date, case when $6::int is null then null else (now() at time zone 'Africa/Nairobi')::date + $6::int end), $7) returning id`,
    [businessId, itemId, batchNo, receivedAt, expiryDate, expiryInDays, unitCost])).rows[0].id;
    await t.query(`insert into public.batch_balances (location_id, item_id, batch_id, on_hand) values ($1, $2, $3, $4)`, [locationId, itemId, batchId, qty]);
    await t.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, $3)
      on conflict (location_id, item_id) do update set on_hand = public.stock_balances.on_hand + excluded.on_hand`, [locationId, itemId, qty]);
    const after = (await t.query(`select on_hand from public.stock_balances where location_id = $1 and item_id = $2`, [locationId, itemId])).rows[0].on_hand;
    await t.query(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, unit_cost, value, batch_id, idempotency_key)
      values ($1, $2, $3, $4, $5, 'purchase_receipt', $6, case when $6::numeric is null then null else round($4::numeric * $6::numeric, 2) end, $7, $8)`,
    [businessId, locationId, itemId, qty, after, unitCost, batchId, key || `helper-batch-${batchNo}-${itemId}-${locationId}`]);
    return batchId;
  });
}

let staffSeq = 0;
/**
 * Extra people on a branch, e.g. several counters for a stock count: addStaff(db, f, { restaurantId, role: 'manager' | 'waiter', n: 3 }).
 * `f` is what inventoryFixture()/rig() returned (needs f.helpers.ctx). Returns [{ userId, ctx }] with contexts ready for inventoryScope().
 */
export async function addStaff(db, f, { restaurantId, role = 'manager', n = 1, prefix = role } = {}) {
  const { createUser } = await import('../support/pg.js');
  const out = [];
  for (let i = 0; i < n; i++) {
    const userId = await createUser(db, `${prefix}${++staffSeq}@example.test`, { role: role === 'waiter' ? 'waiter' : 'owner' });
    await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, $3)`, [restaurantId, userId, role]);
    out.push({ userId, ctx: f.helpers.ctx(userId, { role: role === 'waiter' ? 'waiter' : 'owner', memberships: [[restaurantId, role]] }) });
  }
  return out;
}

/**
 * Posts through the ledger at a fixed moment (fake clock or ISO string) in its own transaction: the way the golden dataset and the
 * report tests date their movements. `input` is ledger.post's input; occurredAt is set from `at`; a key is generated when missing.
 */
export function postAt(db, at, input) {
  const when = typeof at === 'string' ? at : at.now ? at.now().toISOString() : new Date(at).toISOString();
  return db.transaction((t) => post(t, { idempotencyKey: input.idempotencyKey || `helper-at-${++receiveSeq}`, ...input, occurredAt: when }));
}
