// Table sessions (proposed migration 011, docs/v2/TABLE-SESSIONS.md): one shared cart per table.
// `db` is anything with query(sql, params) (a pg client, or PGlite in tests). Public functions take the guest's
// hashed visitor id (lib/operations.js visitorId); staff functions must be called after staffContext checked the
// branch. Pricing is passed in (`price(rawLines)`, throwing HttpError like priceLines) so the menu rules stay in one place.
import { randomInt, randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { CART_TTL_MS, cartQrValue, newCartCode } from './operations.js';

export const MAX_LINES = 30;
export const MAX_QUANTITY = 20;
export const IDLE_MS = { unverified: 15 * 60_000, verified: 45 * 60_000 };
export const JOIN_LOCK = { failures: 5, windowMs: 10 * 60_000, lockMs: 10 * 60_000 };
const NOT_FOUND = 'This table’s order has closed. Scan the table again to start a new one.';

let installed = null; // true once seen; false is re-checked after a minute
let checkedAt = 0;
/** True when migration 011 is applied. Without it, guests get today's per-phone cart. */
export async function sessionsAvailable(db) {
  if (installed === true) return true;
  if (installed === false && Date.now() - checkedAt < 60_000) return false;
  const { rows } = await db.query(`select to_regclass('public.table_sessions') is not null as ok,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'guest_carts' and column_name = 'session_id') as linked`);
  checkedAt = Date.now();
  installed = Boolean(rows[0].ok && rows[0].linked);
  return installed;
}
export const resetSchemaCache = () => { installed = null; };

/** A short random wait before retrying a version conflict, so racing phones spread out. */
const pause = (attempt) => new Promise((resolve) => { setTimeout(resolve, randomInt(5, 20) * attempt); });
const newJoinCode = () => String(randomInt(10000)).padStart(4, '0');
const iso = (value) => (value ? new Date(value).toISOString() : null);
const idleLimit = (row) => (row.verified_at ? IDLE_MS.verified : IDLE_MS.unverified);

function cleanName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Your name must be text.', { field: 'name' });
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length > 24) throw new HttpError(400, 'Keep your name to 24 characters.', { field: 'name' });
  return name || null;
}

/* ---------- Closing stale sessions ---------- */

/** Closes open sessions (optionally only `where`) that idled out or hit the hard cap. */
async function closeStale(db, where, params, now = new Date()) {
  await db.query(`update public.table_sessions set status = 'closed', closed_at = $1,
      closed_reason = case when expires_at <= $1 then 'expired' else 'idle' end
    where status = 'open' and ${where} and (expires_at <= $1 or last_active_at + case when verified_at is null
      then make_interval(secs => ${IDLE_MS.unverified / 1000}) else make_interval(secs => ${IDLE_MS.verified / 1000}) end <= $1)`,
  [now, ...params]);
}

/* ---------- Reading ---------- */

async function loadOpen(db, sessionId) {
  const { rows } = await db.query(`select * from public.table_sessions where id = $1 and status = 'open'`, [sessionId]);
  return rows[0] || null;
}

async function member(db, sessionId, visitor) {
  if (!visitor) return null;
  const { rows } = await db.query('select * from public.table_session_members where session_id = $1 and visitor_id = $2', [sessionId, visitor]);
  return rows[0] || null;
}

/**
 * The guest's own session, after closing it if stale and folding in a waiter's confirmation. Throws 404 for
 * anyone who isn't a member (same answer as an unknown or closed session: nothing leaks).
 */
async function memberSession(db, sessionId, visitor, now = new Date()) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new HttpError(404, NOT_FOUND, { reason: 'closed' });
  await closeStale(db, 'id = $2', [sessionId], now);
  const row = await loadOpen(db, sessionId);
  const me = row && await member(db, row.id, visitor);
  if (!row || !me) throw new HttpError(404, NOT_FOUND, { reason: 'closed' });
  return { row: await syncCart(db, row), me };
}

const label = (m) => m.name || `Guest ${m.guest_number}`;
const lineSig = (line) => JSON.stringify([line.id, line.quantity, line.note || '', line.extraIds || []]);
const cartSig = (lines) => JSON.stringify((lines || []).map(lineSig));

/**
 * When the table's saved cart was confirmed by a waiter: remove the lines it carried (unless changed since),
 * forget the code and mark the session verified (the waiter was at the table). When it expired unclaimed: forget it.
 */
async function syncCart(db, row) {
  if (!row.cart_code) return row;
  const { rows } = await db.query(`select id, claimed_at, claimed_by, claimed_order_id, expires_at from public.guest_carts
    where session_id = $1 and code = $2 order by created_at desc limit 1`, [row.id, row.cart_code]);
  const cart = rows[0];
  const confirmed = cart?.claimed_at && cart.claimed_order_id;
  const expired = !cart || (!cart.claimed_at && new Date(cart.expires_at) <= new Date());
  if (!confirmed && !expired) return row;
  let cartLines = row.cart;
  if (confirmed) {
    const sent = new Set((row.ready_lines || []).map(lineSig));
    cartLines = row.cart.filter((line) => !sent.has(lineSig(line)));
  }
  const { rows: updated } = await db.query(`update public.table_sessions set cart = $2, cart_code = null, ready_lines = null,
      cart_version = cart_version + 1,
      verified_at = case when $3::timestamptz is not null then coalesce(verified_at, $3) else verified_at end,
      verified_by = case when $3::timestamptz is not null and verified_at is null then $4 else verified_by end
    where id = $1 and cart_code = $5 returning *`,
  [row.id, JSON.stringify(cartLines), confirmed ? cart.claimed_at : null, confirmed ? cart.claimed_by : null, row.cart_code]);
  return updated[0] || await loadOpen(db, row.id) || row;
}

/** What a member sees. Visitor ids never leave the server: people are "Guest 2" or their name. */
async function memberView(db, row, me) {
  const [{ rows: members }, { rows: rounds }, pending] = await Promise.all([
    db.query('select * from public.table_session_members where session_id = $1 order by guest_number', [row.id]),
    db.query(`select o.id, o.short_id, o.status, o.taken_at, p.name as confirmed_by,
        coalesce((select json_agg(json_build_object('name', i.name, 'quantity', i.quantity) order by i.position)
          from public.order_items i where i.order_id = o.id), '[]') as items
      from public.guest_carts c join public.orders o on o.id = c.claimed_order_id
      left join public.profiles p on p.id = o.taken_by
      where c.session_id = $1 order by o.taken_at`, [row.id]),
    row.cart_code ? db.query('select code, expires_at from public.guest_carts where session_id = $1 and code = $2 and claimed_at is null', [row.id, row.cart_code]) : null,
  ]);
  const byVisitor = new Map(members.map((m) => [m.visitor_id, m]));
  const table = (await db.query('select number from public.restaurant_tables where id = $1', [row.table_id])).rows[0];
  const saved = pending?.rows?.[0];
  return {
    id: row.id,
    table: { number: table?.number ?? null },
    joinCode: row.join_code,
    verified: Boolean(row.verified_at),
    version: row.cart_version,
    openedAt: iso(row.opened_at), expiresAt: iso(row.expires_at),
    you: { guestNumber: me.guest_number, name: me.name, label: label(me), isHost: me.is_host },
    members: members.map((m) => ({ guestNumber: m.guest_number, label: label(m), isHost: m.is_host, you: m.visitor_id === me.visitor_id })),
    cart: row.cart.map((line) => {
      const who = byVisitor.get(line.addedBy);
      return {
        id: line.id, kind: line.kind, itemId: line.itemId || null, dealId: line.dealId || null, extraIds: line.extraIds || [],
        quantity: line.quantity, note: line.note || '',
        addedBy: { label: who ? label(who) : 'Someone who left', guestNumber: who?.guest_number ?? null, you: line.addedBy === me.visitor_id },
      };
    }),
    ready: saved ? {
      code: saved.code, expiresAt: iso(saved.expires_at), qrValue: cartQrValue(saved.code),
      changedSinceReady: cartSig(row.cart) !== cartSig(row.ready_lines),
    } : null,
    ordered: rounds.map((o) => ({
      orderShortId: (o.short_id || o.id).toString().slice(0, 6), status: o.status, confirmedAt: iso(o.taken_at),
      confirmedBy: o.confirmed_by ? String(o.confirmed_by).trim().split(/\s+/)[0] : null, items: o.items,
    })),
  };
}

/* ---------- Guests ---------- */

/**
 * Scanning a table: the guest's session if they're in it; otherwise, if the table has an open session, "join"
 * (no contents); otherwise a new session with this guest as host.
 * @returns { state: 'member', session } | { state: 'join', table, verified, locked, lockedUntil }
 */
export async function openOrGet(db, { restaurantId, table, visitor, name, now = new Date() }) {
  if (!visitor) throw new HttpError(400, 'Send the X-Cravio-Visitor header.', { field: 'X-Cravio-Visitor' });
  await closeStale(db, 'table_id = $2', [table.id], now);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { rows } = await db.query(`select * from public.table_sessions where table_id = $1 and status = 'open'`, [table.id]);
    const open = rows[0];
    if (open) {
      const me = await member(db, open.id, visitor);
      if (me) return { state: 'member', session: await memberView(db, await syncCart(db, open), me) };
      const locked = open.locked_until && new Date(open.locked_until) > now;
      return { state: 'join', table: { number: table.number }, verified: Boolean(open.verified_at), locked: Boolean(locked), lockedUntil: locked ? iso(open.locked_until) : null };
    }
    const id = randomUUID();
    try {
      await db.query(`insert into public.table_sessions (id, restaurant_id, table_id, join_code, opened_at, last_active_at, expires_at)
        values ($1, $2, $3, $4, $5, $5, $6)`, [id, restaurantId, table.id, newJoinCode(), now, new Date(now.getTime() + 6 * 3600_000)]);
    } catch (error) {
      if (error.code === '23505') continue; // another phone opened it a moment ago: join that one
      throw error;
    }
    await db.query(`insert into public.table_session_members (session_id, visitor_id, name, guest_number, is_host, joined_at, last_seen_at)
      values ($1, $2, $3, 1, true, $4, $4)`, [id, visitor, cleanName(name), now]);
    const row = await loadOpen(db, id);
    return { state: 'member', session: await memberView(db, row, await member(db, id, visitor)) };
  }
  throw new HttpError(503, 'We couldn’t open your table just now. Please try again.');
}

/** Joining with the 4-digit code. Wrong codes count per session; too many lock joining (staff can rotate the code). */
export async function join(db, { table, visitor, code, name, now = new Date() }) {
  if (!visitor) throw new HttpError(400, 'Send the X-Cravio-Visitor header.', { field: 'X-Cravio-Visitor' });
  const typed = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  if (!/^[0-9]{4}$/.test(typed)) throw new HttpError(400, 'Enter the 4-digit code.', { field: 'code' });
  const cleanedName = cleanName(name);
  await closeStale(db, 'table_id = $2', [table.id], now);
  const { rows } = await db.query(`select * from public.table_sessions where table_id = $1 and status = 'open'`, [table.id]);
  const open = rows[0];
  if (!open) throw new HttpError(404, 'Nobody is ordering at this table any more. Scan again to start.', { reason: 'closed' });
  const already = await member(db, open.id, visitor);
  if (already) return { state: 'member', session: await memberView(db, await syncCart(db, open), already) };
  if (open.locked_until && new Date(open.locked_until) > now) {
    throw new HttpError(429, 'Too many wrong codes. Ask a waiter for help, or order on your own.', { reason: 'locked', lockedUntil: iso(open.locked_until) });
  }
  if (typed !== open.join_code) {
    // Failures count inside a 10-minute window that starts at the first one.
    const { rows: [after] } = await db.query(`update public.table_sessions set
        failed_joins = case when failed_since is null or failed_since <= $2 then 1 else failed_joins + 1 end,
        failed_since = case when failed_since is null or failed_since <= $2 then $3 else failed_since end
      where id = $1 returning failed_joins`, [open.id, new Date(now.getTime() - JOIN_LOCK.windowMs), now]);
    if (after.failed_joins >= JOIN_LOCK.failures) {
      await db.query('update public.table_sessions set locked_until = $2, failed_joins = 0, failed_since = null where id = $1',
        [open.id, new Date(now.getTime() + JOIN_LOCK.lockMs)]);
    }
    throw new HttpError(403, 'That code doesn’t match. Check it with someone at your table.', { reason: 'wrong_code', field: 'code' });
  }
  await db.query(`insert into public.table_session_members (session_id, visitor_id, name, guest_number, joined_at, last_seen_at)
    values ($1, $2, $3, (select coalesce(max(guest_number), 0) + 1 from public.table_session_members where session_id = $1), $4, $4)
    on conflict do nothing`, [open.id, visitor, cleanedName, now]);
  await db.query(`update public.table_sessions set cart_version = cart_version + 1, last_active_at = $2, failed_joins = 0, failed_since = null
    where id = $1`, [open.id, now]);
  return { state: 'member', session: await memberView(db, await loadOpen(db, open.id), await member(db, open.id, visitor)) };
}

/** Polling. `since` = the version the phone has: { changed: false, version } when nothing moved. */
export async function getSession(db, { sessionId, visitor, since, now = new Date() }) {
  const { row, me } = await memberSession(db, sessionId, visitor, now);
  if (now - new Date(me.last_seen_at) > 30_000) {
    await db.query('update public.table_session_members set last_seen_at = $3 where session_id = $1 and visitor_id = $2', [row.id, visitor, now]);
  }
  if (since !== undefined && since !== null && String(since) === String(row.cart_version)) return { changed: false, version: row.cart_version };
  return { changed: true, session: await memberView(db, row, me) };
}

function applyOne(lines, op, visitor) {
  const find = () => {
    const line = lines.find((l) => l.id === op.lineId);
    if (!line) throw new HttpError(409, 'Someone at your table just changed that. Here’s the latest.', { reason: 'line_gone' });
    return line;
  };
  const quantity = (value) => {
    if (!Number.isInteger(value) || value < 0 || value > MAX_QUANTITY) throw new HttpError(400, `Quantity must be between 0 and ${MAX_QUANTITY}.`, { field: 'quantity' });
    return value;
  };
  switch (op?.type) {
    case 'add': {
      const raw = op.line || {};
      const extraIds = Array.isArray(raw.extraIds) ? [...new Set(raw.extraIds.map((id) => String(id).toLowerCase()))].sort() : [];
      const line = raw.dealId
        ? { kind: 'deal', dealId: String(raw.dealId).toLowerCase(), extraIds: [] }
        : { kind: 'item', itemId: String(raw.itemId || '').toLowerCase(), extraIds };
      const qty = raw.quantity === undefined ? 1 : quantity(raw.quantity);
      const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 140) : '';
      // The same dish (same extras) added by the same person merges; other people's lines stay theirs.
      const same = lines.find((l) => l.addedBy === visitor && l.kind === line.kind && l.itemId === line.itemId && l.dealId === line.dealId
        && JSON.stringify(l.extraIds || []) === JSON.stringify(line.extraIds));
      if (same) return lines.map((l) => (l === same ? { ...l, quantity: Math.min(MAX_QUANTITY, l.quantity + qty), note: note || l.note } : l));
      if (lines.length >= MAX_LINES) throw new HttpError(400, `An order can have up to ${MAX_LINES} lines.`, { field: 'items' });
      return [...lines, { id: randomUUID().slice(0, 8), ...line, quantity: Math.max(1, qty), note, addedBy: visitor }];
    }
    case 'change': {
      const line = find();
      if (!Number.isInteger(op.delta) || Math.abs(op.delta) > MAX_QUANTITY) throw new HttpError(400, 'delta must be a small whole number.', { field: 'delta' });
      const next = Math.min(MAX_QUANTITY, line.quantity + op.delta);
      return next <= 0 ? lines.filter((l) => l !== line) : lines.map((l) => (l === line ? { ...l, quantity: next } : l));
    }
    case 'quantity': {
      const line = find();
      const next = quantity(op.quantity);
      return next === 0 ? lines.filter((l) => l !== line) : lines.map((l) => (l === line ? { ...l, quantity: next } : l));
    }
    case 'note': {
      const line = find();
      if (op.note !== null && typeof op.note !== 'string') throw new HttpError(400, 'The note must be text.', { field: 'note' });
      return lines.map((l) => (l === line ? { ...l, note: (op.note || '').trim().slice(0, 140) } : l));
    }
    case 'remove': return lines.filter((l) => l !== find());
    case 'clear': return [];
    default: throw new HttpError(400, 'type must be add, change, quantity, note, remove or clear.', { field: 'type' });
  }
}

const storedLines = (lines) => lines.map((l) => (l.kind === 'deal'
  ? { dealId: l.dealId, quantity: l.quantity, ...(l.note ? { note: l.note } : {}) }
  : { itemId: l.itemId, quantity: l.quantity, ...(l.note ? { note: l.note } : {}), ...(l.extraIds?.length ? { extraIds: l.extraIds } : {}) }));

/**
 * One cart operation, applied to the latest cart with optimistic concurrency: update … where cart_version = v,
 * re-reading and re-applying on a conflict, so two phones adding at once both land.
 */
export async function applyOp(db, { sessionId, visitor, op, price, now = new Date() }) {
  if (op?.type === 'add' && price) {
    const [line] = storedLines([applyOne([], op, visitor)[0]]);
    await price([line]); // the dish, its extras or the deal must be on the menu and available
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await pause(attempt);
    const { row, me } = await memberSession(db, sessionId, visitor, now);
    const lines = applyOne(row.cart, op, visitor);
    const { rows } = await db.query(`update public.table_sessions set cart = $3, cart_version = cart_version + 1, last_active_at = $4
      where id = $1 and status = 'open' and cart_version = $2 returning *`, [row.id, row.cart_version, JSON.stringify(lines), now]);
    if (rows[0]) return { session: await memberView(db, rows[0], me), attempts: attempt + 1 };
  }
  throw new HttpError(409, 'Your table is busy. Please try again.', { reason: 'busy' });
}

/**
 * "Ready to order" for the whole table: one guest_carts row (session_id) with the shared cart, the same code
 * while it's waiting for the waiter. The waiter's scan stays the gate (docs/ORDER-FLOW.md).
 */
export async function ready(db, { sessionId, visitor, price, now = new Date(), readyColumn = true }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { row, me } = await memberSession(db, sessionId, visitor, now);
    if (!row.cart.length) throw new HttpError(400, 'Add at least one dish.', { field: 'items' });
    const items = storedLines(row.cart);
    const priced = price ? await price(items) : { lines: null, subtotal: null };
    const expiresAt = new Date(now.getTime() + CART_TTL_MS);
    let code = row.cart_code;
    let inserted = null;
    if (code) {
      const { rowCount } = await db.query(`update public.guest_carts set items = $3, expires_at = $4${readyColumn ? ', ready_at = $5' : ''}
        where session_id = $1 and code = $2 and claimed_at is null`, [row.id, code, JSON.stringify(items), expiresAt, ...(readyColumn ? [now] : [])]);
      if (!rowCount) continue; // confirmed or gone a moment ago: the next round syncs and starts fresh
    } else {
      for (let tries = 0; tries < 5 && !inserted; tries++) {
        const candidate = newCartCode();
        const { rows: [taken] } = await db.query('select 1 from public.guest_carts where code = $1 and claimed_at is null', [candidate]);
        if (taken) continue;
        const { rows: [cart] } = await db.query(`insert into public.guest_carts (restaurant_id, table_id, code, items, visitor_id, expires_at, session_id${readyColumn ? ', ready_at' : ''})
          values ($1, $2, $3, $4, $5, $6, $7${readyColumn ? ', $8' : ''}) returning id, code`,
        [row.restaurant_id, row.table_id, candidate, JSON.stringify(items), visitor, expiresAt, row.id, ...(readyColumn ? [now] : [])]);
        inserted = cart;
      }
      if (!inserted) throw new HttpError(503, 'We couldn’t save your order just now. Please try again.');
      code = inserted.code;
    }
    const { rows } = await db.query(`update public.table_sessions set cart_code = $3, ready_lines = cart, cart_version = cart_version + 1, last_active_at = $4
      where id = $1 and cart_version = $2 returning *`, [row.id, row.cart_version, code, now]);
    if (rows[0]) {
      const session = await memberView(db, rows[0], me);
      return { session, cart: { code, status: 'ready', readyAt: iso(now), expiresAt: iso(expiresAt), table: session.table, items: priced.lines, total: priced.subtotal, currency: 'KES', qrValue: cartQrValue(code) } };
    }
    // Someone changed the cart meanwhile: drop a cart we just made and try again with the latest lines.
    if (inserted) await db.query('delete from public.guest_carts where id = $1 and claimed_at is null', [inserted.id]);
  }
  throw new HttpError(409, 'Your table is busy. Please try again.', { reason: 'busy' });
}

/** Leaving: the phone goes back to its own cart. The last one out closes the session. */
export async function leave(db, { sessionId, visitor, now = new Date() }) {
  const { row } = await memberSession(db, sessionId, visitor, now);
  await db.query('delete from public.table_session_members where session_id = $1 and visitor_id = $2', [row.id, visitor]);
  const { rows: [left] } = await db.query('select count(*)::int as n from public.table_session_members where session_id = $1', [row.id]);
  if (!left.n) await close(db, { sessionId: row.id, reason: 'empty', now });
  else await db.query('update public.table_sessions set cart_version = cart_version + 1 where id = $1', [row.id]);
  return { left: true };
}

/** Whether `visitor` is a member of the session that saved guest cart `code` (for the cart status endpoint). */
export async function isCartMember(db, { restaurantId, code, visitor }) {
  if (!visitor) return false;
  const { rows } = await db.query(`select 1 from public.guest_carts c join public.table_session_members m on m.session_id = c.session_id
    where c.code = $1 and c.restaurant_id = $2 and m.visitor_id = $3 limit 1`, [code, restaurantId, visitor]);
  return rows.length > 0;
}

/* ---------- Staff ---------- */

async function close(db, { sessionId, restaurantId, reason, userId = null, now = new Date() }) {
  const { rows } = await db.query(`update public.table_sessions set status = 'closed', closed_at = $2, closed_reason = $3, closed_by = $4,
      cart_version = cart_version + 1
    where id = $1 and status = 'open' ${restaurantId ? 'and restaurant_id = $5' : ''} returning id`,
  [sessionId, now, reason, userId, ...(restaurantId ? [restaurantId] : [])]);
  // A saved cart that nobody confirmed can't be confirmed for a closed table.
  if (rows[0]) await db.query('update public.guest_carts set expires_at = $2 where session_id = $1 and claimed_at is null and expires_at > $2', [sessionId, now]);
  return Boolean(rows[0]);
}

/** Open sessions of a branch for the waiter app: table, people, join code, verified, last activity. */
export async function listOpen(db, restaurantId, now = new Date()) {
  await closeStale(db, 'restaurant_id = $2', [restaurantId], now);
  const { rows } = await db.query(`select s.id, s.join_code, s.verified_at, s.opened_at, s.last_active_at, s.locked_until, s.cart_code,
      jsonb_array_length(s.cart) as lines, t.number as table_number,
      (select count(*)::int from public.table_session_members m where m.session_id = s.id) as people
    from public.table_sessions s join public.restaurant_tables t on t.id = s.table_id
    where s.restaurant_id = $1 and s.status = 'open' order by t.number`, [restaurantId]);
  return rows.map((r) => ({
    id: r.id, table: { number: r.table_number }, joinCode: r.join_code, people: r.people, verified: Boolean(r.verified_at),
    cartLines: r.lines, waitingForWaiter: Boolean(r.cart_code), openedAt: iso(r.opened_at), lastActiveAt: iso(r.last_active_at),
    idleClosesAt: iso(new Date(new Date(r.last_active_at).getTime() + idleLimit(r))),
    joinLockedUntil: r.locked_until && new Date(r.locked_until) > now ? iso(r.locked_until) : null,
  }));
}

export async function staffClose(db, { restaurantId, sessionId, userId, now = new Date() }) {
  if (!await close(db, { sessionId, restaurantId, reason: 'staff', userId, now })) throw new HttpError(404, 'That table’s order is already closed.');
  return { closed: true };
}

/** A new join code; also lifts a join lock. Members see the new code on their next poll. */
export async function rotateCode(db, { restaurantId, sessionId, now = new Date() }) {
  const { rows } = await db.query(`update public.table_sessions set join_code = $3, locked_until = null, failed_joins = 0, failed_since = null,
      cart_version = cart_version + 1, last_active_at = $4
    where id = $1 and restaurant_id = $2 and status = 'open' returning join_code`, [sessionId, restaurantId, newJoinCode(), now]);
  if (!rows[0]) throw new HttpError(404, 'That table’s order is already closed.');
  return { joinCode: rows[0].join_code };
}

/** "Confirm guests are here": a member of staff is at the table. */
export async function verify(db, { restaurantId, sessionId, userId, now = new Date() }) {
  const { rows } = await db.query(`update public.table_sessions set verified_at = coalesce(verified_at, $3), verified_by = coalesce(verified_by, $4),
      cart_version = cart_version + 1, last_active_at = $3
    where id = $1 and restaurant_id = $2 and status = 'open' returning id`, [sessionId, restaurantId, now, userId]);
  if (!rows[0]) throw new HttpError(404, 'That table’s order is already closed.');
  return { verified: true };
}

/**
 * After a waiter confirmed guest cart `cartId`: a table cart verifies its session and empties what was sent;
 * a solo cart at a table replaces any unverified session there (someone not at the table must not hold it).
 */
export async function afterCartClaimed(db, { cartId, now = new Date() }) {
  const { rows: [cart] } = await db.query('select id, session_id, table_id from public.guest_carts where id = $1', [cartId]);
  if (!cart) return;
  if (cart.session_id) {
    const row = await loadOpen(db, cart.session_id);
    if (row) await syncCart(db, row);
    return;
  }
  if (!cart.table_id) return;
  const { rows } = await db.query(`select id from public.table_sessions where table_id = $1 and status = 'open' and verified_at is null`, [cart.table_id]);
  for (const s of rows) await close(db, { sessionId: s.id, reason: 'replaced', now });
}

/** After an order was paid: close its session when everything it ordered is paid and nothing is waiting. */
export async function afterOrderPaid(db, { orderId, now = new Date() }) {
  const { rows: [found] } = await db.query(`select s.* from public.orders o join public.guest_carts c on c.id = o.guest_cart_id
    join public.table_sessions s on s.id = c.session_id where o.id = $1 and s.status = 'open'`, [orderId]);
  if (!found) return false;
  const row = await syncCart(db, found);
  if (row.cart.length || row.cart_code) return false;
  const { rows: [unpaid] } = await db.query(`select count(*)::int as n from public.guest_carts c join public.orders o on o.id = c.claimed_order_id
    where c.session_id = $1 and o.status not in ('paid', 'cancelled')`, [row.id]);
  if (unpaid.n) return false;
  return close(db, { sessionId: row.id, reason: 'paid', now });
}
