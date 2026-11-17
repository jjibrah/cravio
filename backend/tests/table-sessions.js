// Table sessions (proposed migration 011) on a disposable PGlite database: open, join with the right and wrong code,
// lockout, nothing for non-members, concurrent adds (version conflicts), ready to order, confirmation by a waiter,
// unverified sessions (short idle, replaced by a solo cart), close, expiry, paid auto-close, isolation.
// Usage: node backend/tests/table-sessions.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUser, freshDatabase, readSql } from './support/pg.js';
import { HttpError } from '../src/lib/http.js';
import {
  IDLE_MS, afterCartClaimed, afterOrderPaid, applyOp, getSession, isCartMember, join, leave, listOpen, openOrGet, ready, rotateCode,
  sessionsAvailable, staffClose, verify,
} from '../src/lib/table-sessions.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, test, m) => {
  await assert.rejects(promise, (e) => { if (typeof test === 'number') assert.equal(e.status, test, `${m}: ${e.status} ${e.message}`); else assert.match(e.message, test, m); return true; }, m);
  checks++;
};

const bare = await freshDatabase();
eq(await sessionsAvailable(bare), false, 'without 011: sessions unavailable (guests get the solo cart)');
await bare.close();
const { resetSchemaCache } = await import('../src/lib/table-sessions.js');
resetSchemaCache();

const db = await freshDatabase({ extra: ['proposed/011_table_sessions.sql'] });
await db.exec(readSql('proposed/011_table_sessions.sql')); // idempotent re-run
eq(await sessionsAvailable(db), true, 'with 011: available');
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

const owner = await createUser(db, 'owner@example.test', { role: 'owner' });
const waiter = await createUser(db, 'jane.waiter@example.test', { role: 'waiter', name: 'Jane Wanjiru' });
await db.query(`update public.profiles set name = 'Jane Wanjiru' where id = $1`, [waiter]).catch(() => {});
const main = (await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Main', 'live') returning id`, [owner])).id;
const rival = (await one(`insert into public.restaurants (owner_id, name, status, owner_primary) values ($1, 'Rival', 'live', false) returning id`, [owner])).id;
const table = async (r, n) => ({ ...(await one('insert into public.restaurant_tables (restaurant_id, number) values ($1, $2) returning id, number', [r, n])) });
const t7 = await table(main, 7);
const t8 = await table(main, 8);
const r7 = await table(rival, 7);
const cat = (await one(`insert into public.menu_categories (restaurant_id, name) values ($1, 'Mains') returning id`, [main])).id;
const pilau = (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, 'Pilau', 600) returning id`, [main, cat])).id;
const chai = (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, 'Chai', 150) returning id`, [main, cat])).id;

// Stand-in for priceLines: dishes must exist at this restaurant.
const price = async (lines) => {
  let subtotal = 0;
  const out = [];
  for (const [index, line] of lines.entries()) {
    const item = await one('select name, price from public.menu_items where id = $1 and restaurant_id = $2', [line.itemId, main]);
    if (!item) throw new HttpError(404, 'That dish isn’t on the menu any more.', { index, reason: 'missing' });
    subtotal += Number(item.price) * line.quantity;
    out.push({ name: item.name, quantity: line.quantity });
  }
  return { lines: out, subtotal };
};

const A = 'a'.repeat(32); const B = 'b'.repeat(32); const C = 'c'.repeat(32); const X = 'x'.repeat(32);
const add = (s, v, itemId, quantity = 1) => applyOp(db, { sessionId: s, visitor: v, op: { type: 'add', line: { itemId, quantity } }, price });

// Open: the first guest hosts; the second sees only "join".
const opened = await openOrGet(db, { restaurantId: main, table: t7, visitor: A, name: 'Amina' });
eq(opened.state, 'member', 'first scan opens a session');
const sid = opened.session.id;
const code = opened.session.joinCode;
ok(/^\d{4}$/.test(code), 'join code is 4 digits');
eq(opened.session.verified, false, 'starts unverified');
eq(opened.session.you, { guestNumber: 1, name: 'Amina', label: 'Amina', isHost: true }, 'host');
eq((await openOrGet(db, { restaurantId: main, table: t7, visitor: A })).session.id, sid, 'host rescans: same session');
const stranger = await openOrGet(db, { restaurantId: main, table: t7, visitor: B });
eq(Object.keys(stranger).sort(), ['locked', 'lockedUntil', 'state', 'table', 'verified'], 'non-member gets no cart, names or code');
eq(stranger.state, 'join', 'second phone must join');
await fails(getSession(db, { sessionId: sid, visitor: B }), 404, 'non-member cannot read the session');
await fails(applyOp(db, { sessionId: sid, visitor: B, op: { type: 'clear' } }), 404, 'non-member cannot change the cart');
await fails(ready(db, { sessionId: sid, visitor: B, price }), 404, 'non-member cannot send the order');

// Join: wrong codes count, the right one works.
const wrong = code === '0000' ? '1111' : '0000';
await fails(join(db, { table: t7, visitor: B, code: '12a' }), 400, 'code must be 4 digits');
await fails(join(db, { table: t7, visitor: B, code: wrong }), 403, 'wrong code refused');
const joined = await join(db, { table: t7, visitor: B, code, name: ' ' });
eq(joined.session.you.label, 'Guest 2', 'unnamed member is Guest 2');
eq(joined.session.members.map((m) => m.label), ['Amina', 'Guest 2'], 'members listed');
await fails(join(db, { table: t7, visitor: C, code, name: 'x'.repeat(25) }), 400, 'name up to 24 characters');

// Shared cart: both add; lines show who added them; anyone can change any line.
await add(sid, A, pilau, 2);
const afterB = (await add(sid, B, chai)).session;
eq(afterB.cart.map((l) => [l.itemId, l.quantity, l.addedBy.label, l.addedBy.you]), [[pilau, 2, 'Amina', false], [chai, 1, 'Guest 2', true]], 'one cart, labelled by person');
const pilauLine = afterB.cart[0].id;
await applyOp(db, { sessionId: sid, visitor: B, op: { type: 'change', lineId: pilauLine, delta: 1 } });
await applyOp(db, { sessionId: sid, visitor: A, op: { type: 'note', lineId: pilauLine, note: 'No onions' } });
eq((await add(sid, A, pilau)).session.cart[0].quantity, 4, 'same dish from the same person merges');
await fails(add(sid, A, randomUUID()), 404, 'unknown dish refused by pricing');
await fails(applyOp(db, { sessionId: sid, visitor: A, op: { type: 'remove', lineId: 'nope' } }), 409, 'unknown line: conflict');
await fails(applyOp(db, { sessionId: sid, visitor: A, op: { type: 'quantity', lineId: pilauLine, quantity: 21 } }), 400, 'quantity limit');

// Concurrent adds: interleaved writers hit version conflicts and retry; nothing is lost.
const before = (await getSession(db, { sessionId: sid, visitor: A })).session;
const results = await Promise.all(Array.from({ length: 6 }, (_, i) => add(sid, i % 2 ? A : B, i < 3 ? chai : pilau)));
const after = (await getSession(db, { sessionId: sid, visitor: A })).session;
const total = (s) => s.cart.reduce((n, l) => n + l.quantity, 0);
eq(total(after), total(before) + 6, 'six concurrent adds all landed');
ok(results.some((r) => r.attempts > 1), 'at least one add retried after a version conflict');
eq(await getSession(db, { sessionId: sid, visitor: A, since: after.version }), { changed: false, version: after.version }, 'unchanged since version N');

// Ready to order: one guest cart for the table; every member can follow it.
const sent = await ready(db, { sessionId: sid, visitor: B, price });
ok(/^[A-Z0-9]{6}$/.test(sent.cart.code), 'one cart code');
eq((await one('select count(*)::int as n from public.guest_carts where session_id = $1', [sid])).n, 1, 'one guest_carts row');
const again = await ready(db, { sessionId: sid, visitor: A, price });
eq(again.cart.code, sent.cart.code, 'ready again keeps the code');
eq((await one('select count(*)::int as n from public.guest_carts where session_id = $1', [sid])).n, 1, 'still one row');
eq(await isCartMember(db, { restaurantId: main, code: sent.cart.code, visitor: A }), true, 'member can follow the table code');
eq(await isCartMember(db, { restaurantId: main, code: sent.cart.code, visitor: X }), false, 'outsider cannot');
eq((await getSession(db, { sessionId: sid, visitor: A })).session.ready.changedSinceReady, false, 'ready, unchanged');

// A late add while waiting stays in the cart after the waiter confirms what was sent.
await join(db, { table: t7, visitor: C, code, name: 'Chris' });
await add(sid, C, chai, 3);
eq((await getSession(db, { sessionId: sid, visitor: C })).session.ready.changedSinceReady, true, 'changed since ready');
// The waiter scans and confirms (as POST /api/ops/orders does): claim, create the order, link it.
const confirm = async (cartCode) => {
  const cart = await one('select * from public.guest_carts where code = $1 and claimed_at is null', [cartCode]);
  const order = (await one(`insert into public.orders (restaurant_id, table_id, table_number, status, taken_by, taken_at, source, guest_cart_id, subtotal, total)
    values ($1, $2, 7, 'taken', $3, now(), 'guest_cart', $4, 100, 100) returning id`, [cart.restaurant_id, cart.table_id, waiter, cart.id])).id;
  await db.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total) values ($1, $2, $3, 'Pilau', 600, 1, 600)`, [order, cart.restaurant_id, pilau]);
  await db.query('update public.guest_carts set claimed_at = now(), claimed_by = $2, claimed_order_id = $3 where id = $1', [cart.id, waiter, order]);
  await afterCartClaimed(db, { cartId: cart.id });
  return order;
};
// Before 011 is applied to orders here, ready ran the version-checked update; the snapshot holds what was sent.
const round1 = await confirm(sent.cart.code);
const confirmed = (await getSession(db, { sessionId: sid, visitor: B })).session;
eq(confirmed.verified, true, 'the waiter’s confirmation verifies the session');
eq(confirmed.ready, null, 'code cleared');
eq(confirmed.cart.map((l) => [l.addedBy.label, l.quantity]), [['Chris', 3]], 'sent lines left the cart; the late add stayed');
eq(confirmed.ordered.length, 1, 'ordered so far: one round');
eq(confirmed.ordered[0].status, 'taken', 'round status');
await fails(ready(db, { sessionId: sid, visitor: X, price }), 404, 'outsider still cannot send');

// Second round and paid auto-close.
const sent2 = await ready(db, { sessionId: sid, visitor: C, price });
ok(sent2.cart.code !== sent.cart.code, 'new round, new code');
const round2 = await confirm(sent2.cart.code);
await db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = any($1)`, [[round1, round2], waiter]);
await db.query(`update public.orders set status = 'paid', paid_at = now(), paid_by = $2 where id = $1`, [round1, waiter]);
eq(await afterOrderPaid(db, { orderId: round1 }), false, 'one round unpaid: stays open');
await db.query(`update public.orders set status = 'paid', paid_at = now(), paid_by = $2 where id = $1`, [round2, waiter]);
eq(await afterOrderPaid(db, { orderId: round2 }), true, 'all paid and nothing waiting: closed');
eq((await one('select closed_reason from public.table_sessions where id = $1', [sid])).closed_reason, 'paid', 'closed as paid');
await fails(getSession(db, { sessionId: sid, visitor: A }), 404, 'closed session gone for members');

// Lockout: 5 wrong codes lock the table's joining for 10 minutes; staff rotate the code to lift it.
const s8 = (await openOrGet(db, { restaurantId: main, table: t8, visitor: A })).session;
const bad = s8.joinCode === '0000' ? '1111' : '0000';
for (let i = 0; i < 5; i++) await fails(join(db, { table: t8, visitor: `${'v'.repeat(30)}${i}${i}`, code: bad }), 403, `wrong code ${i + 1}`);
await fails(join(db, { table: t8, visitor: B, code: s8.joinCode }), 429, 'locked: even the right code waits');
eq((await openOrGet(db, { restaurantId: main, table: t8, visitor: B })).locked, true, 'join screen knows it is locked');
eq((await listOpen(db, main)).find((s) => s.table.number === 8).joinLockedUntil !== null, true, 'staff see the lock');
await fails(rotateCode(db, { restaurantId: rival, sessionId: s8.id }), 404, 'another branch cannot rotate');
const { joinCode: fresh } = await rotateCode(db, { restaurantId: main, sessionId: s8.id });
await fails(join(db, { table: t8, visitor: B, code: s8.joinCode === fresh ? bad : s8.joinCode }), 403, 'old code no longer works');
eq((await join(db, { table: t8, visitor: B, code: fresh })).state, 'member', 'new code works');
const later = new Date(Date.now() + 11 * 60_000);
eq((await getSession(db, { sessionId: s8.id, visitor: A, now: later })).session.joinCode, fresh, 'members see the new code');

// Staff list, verify, close; isolation between branches and tables.
const list = await listOpen(db, main);
eq(list.map((s) => [s.table.number, s.people, s.verified]), [[8, 2, false]], 'open sessions with people and verified flag');
eq((await listOpen(db, rival)).length, 0, 'rival sees none');
await fails(staffClose(db, { restaurantId: rival, sessionId: s8.id, userId: owner }), 404, 'rival cannot close');
await verify(db, { restaurantId: main, sessionId: s8.id, userId: waiter });
eq((await listOpen(db, main))[0].verified, true, 'confirm guests are here');
const rs = (await openOrGet(db, { restaurantId: rival, table: r7, visitor: A })).session;
ok(rs.id !== s8.id && rs.id !== sid, 'same visitor, other restaurant: separate session');
await fails(join(db, { table: r7, visitor: B, code: s8.joinCode }), /match/, 'codes do not cross tables');
await staffClose(db, { restaurantId: main, sessionId: s8.id, userId: waiter });
await fails(getSession(db, { sessionId: s8.id, visitor: B }), 404, 'closed by staff');
await fails(staffClose(db, { restaurantId: main, sessionId: s8.id, userId: waiter }), 404, 'closing twice: already closed');

// Unverified sessions idle out after 15 minutes; verified ones after 45; the hard cap is 6 hours.
const u = (await openOrGet(db, { restaurantId: main, table: t8, visitor: X })).session;
const in16 = new Date(Date.now() + IDLE_MS.unverified + 60_000);
await fails(getSession(db, { sessionId: u.id, visitor: X, now: in16 }), 404, 'unverified: closed after 15 idle minutes');
eq((await one('select closed_reason from public.table_sessions where id = $1', [u.id])).closed_reason, 'idle', 'idle reason');
const v = (await openOrGet(db, { restaurantId: main, table: t8, visitor: X })).session;
await verify(db, { restaurantId: main, sessionId: v.id, userId: waiter });
eq((await getSession(db, { sessionId: v.id, visitor: X, now: in16 })).changed, true, 'verified: still open after 16 minutes');
await fails(getSession(db, { sessionId: v.id, visitor: X, now: new Date(Date.now() + 7 * 3600_000) }), 404, 'hard cap');
eq((await one('select closed_reason from public.table_sessions where id = $1', [v.id])).closed_reason, 'expired', 'expired reason');

// A guest at home holds table 7 (unverified). A real guest orders on their own; the waiter's confirmation replaces it.
const home = (await openOrGet(db, { restaurantId: main, table: t7, visitor: X })).session;
await add(home.id, X, pilau);
const solo = (await one(`insert into public.guest_carts (restaurant_id, table_id, code, items, visitor_id, expires_at)
  values ($1, $2, 'ACDEFH', $3, $4, now() + interval '2 hours') returning code`, [main, t7.id, JSON.stringify([{ itemId: chai, quantity: 1 }]), C])).code;
await confirm(solo);
eq((await one('select status, closed_reason from public.table_sessions where id = $1', [home.id])), { status: 'closed', closed_reason: 'replaced' }, 'unverified session replaced');
eq((await openOrGet(db, { restaurantId: main, table: t7, visitor: C })).state, 'member', 'the table is free for the real guests');
// A verified session is not replaced by a solo order.
const real = (await openOrGet(db, { restaurantId: main, table: t7, visitor: C })).session;
await verify(db, { restaurantId: main, sessionId: real.id, userId: waiter });
await db.query(`insert into public.guest_carts (restaurant_id, table_id, code, items, visitor_id, expires_at) values ($1, $2, 'ACDEFJ', $3, $4, now() + interval '2 hours')`,
  [main, t7.id, JSON.stringify([{ itemId: chai, quantity: 1 }]), A]);
await confirm('ACDEFJ');
eq((await one('select status from public.table_sessions where id = $1', [real.id])).status, 'open', 'verified session kept');

// Leaving: the last one out closes it; a saved, unconfirmed cart of a closed session expires.
await add(real.id, C, chai);
const pend = await ready(db, { sessionId: real.id, visitor: C, price });
await leave(db, { sessionId: real.id, visitor: C });
eq((await one('select closed_reason from public.table_sessions where id = $1', [real.id])).closed_reason, 'empty', 'last one out closes');
ok(new Date((await one('select expires_at from public.guest_carts where code = $1', [pend.cart.code])).expires_at) <= new Date(), 'its waiting code can no longer be confirmed');

// One open session per table (the partial unique index).
await openOrGet(db, { restaurantId: main, table: t7, visitor: A });
await assert.rejects(db.query(`insert into public.table_sessions (restaurant_id, table_id, join_code) values ($1, $2, '1234')`, [main, t7.id]), /duplicate|unique/);
checks++;

// No browser access.
const { rows: grants } = await db.query(`select grantee from information_schema.role_table_grants
  where table_name in ('table_sessions', 'table_session_members') and grantee in ('anon', 'authenticated')`);
eq(grants.length, 0, 'no anon/authenticated grants');

// The down migration removes it cleanly.
await db.exec(readSql('proposed/011_table_sessions.down.sql'));
eq((await one(`select to_regclass('public.table_sessions') is null as gone`)).gone, true, 'down migration');

console.log(`table sessions: ${checks} checks passed`);
await db.close();
