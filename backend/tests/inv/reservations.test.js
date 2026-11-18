// Ledger reservations (P2-20): the spike scenarios S1-S10 ported onto the real backend/src/inventory/ledger.js, on PGlite with 012-018.
// Usage: node backend/tests/inv/reservations.test.js   (nothing here touches the shared database)
import assert from 'node:assert/strict';
import { inventoryFixture } from './fixture.js';
import { inventoryUpTo } from './migrations.js';
import * as L from '../../src/inventory/ledger.js';

const { db, ids, users, helpers } = await inventoryFixture({ extra: inventoryUpTo(18) });
const { tx, one } = helpers;
const { businessId, centerLocationId: WH, branchLocationId: BR, branchId } = ids;
const actorId = users.owner;

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const say = (s) => { if (process.env.VERBOSE) console.log(s); };
const refuses = async (p, status, code, m) => {
  try { await p; } catch (e) { eq([e.status, e.details?.code], [status, code], m); say(`    refused: ${e.message}`); return e; }
  assert.fail(`${m}: expected refusal ${code}`);
};

let seq = 0; const key = (p = 'k') => `${p}-${++seq}`;
const newItem = async (name) => (await one(`insert into public.stock_items (business_id, name, unit, display_unit) values ($1, $2, 'g', 'kg') returning id`, [businessId, name])).id;
let reqNo = 0;
const newRequest = async (lines) => tx(async (t) => {
  const r = (await t.query(`insert into public.stock_requests (business_id, restaurant_id, number, status) values ($1, $2, $3, 'submitted') returning id`, [businessId, branchId, ++reqNo])).rows[0];
  for (const [itemId, qty] of lines) await t.query(`insert into public.stock_request_lines (request_id, item_id, requested) values ($1, $2, $3)`, [r.id, itemId, qty]);
  return r.id;
});
const receive = (itemId, qty, loc = WH) => tx((t) => L.post(t, { businessId, locationId: loc, itemId, qty, reason: 'purchase_receipt', unitCost: '1', actorId, idempotencyKey: key('rcv') }));
const bal = async (loc, itemId) => { const b = await L.balance(db, loc, itemId); return `on_hand=${b.onHand} reserved=${b.reserved} available=${b.available}`; };
const recon = async () => ({ onHand: (await L.reconcile(db, { businessId })).filter((r) => r.kind !== 'reserved'), reserved: await L.reconcileReserved(db, { businessId }) });
const zeroDiffs = async (m) => { const r = await recon(); eq(r, { onHand: [], reserved: [] }, `${m}: reconciliation has zero diffs`); };

// Service-shaped helpers (what P2-21 will be): approve = reserve per line; dispatch = post transfer_dispatch consuming the reservation; cancel = release.
const approve = (requestId, lines, k = key('apr')) => tx(async (t) => {
  const out = [];
  for (const [itemId, qty] of [...lines].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(await L.reserve(t, { businessId, locationId: WH, itemId, qty, requestId, actorId, idempotencyKey: `${k}:${itemId}` }));
    await t.query('update public.stock_request_lines set approved = $3 where request_id = $1 and item_id = $2', [requestId, itemId, qty]);
  }
  await t.query(`update public.stock_requests set status = 'approved' where id = $1`, [requestId]);
  return out;
});
const activeRes = async (requestId, itemId) => (await one(`select id, status, qty_reserved::text qr, qty_consumed::text qc, qty_released::text qrel from public.stock_reservations where request_id = $1 and item_id = $2 order by created_at desc limit 1`, [requestId, itemId]));
const dispatchLine = (requestId, itemId, qty, k = key('dsp')) => tx(async (t) => {
  const r = await t.query(`select id from public.stock_reservations where request_id = $1 and item_id = $2 and status = 'active'`, [requestId, itemId]);
  return L.post(t, { businessId, locationId: WH, itemId, qty: `-${qty}`, reason: 'transfer_dispatch', ref: { type: 'request', id: requestId }, counterpartyLocationId: BR, reservationId: r.rows[0]?.id ?? null, actorId, idempotencyKey: k });
});
const cancelRequest = (requestId, k = key('cnl')) => tx(async (t) => {
  const rs = (await t.query(`select id from public.stock_reservations where request_id = $1 and status = 'active'`, [requestId])).rows;
  for (const r of rs) await L.release(t, r.id, { reason: 'request_cancelled', actorId, idempotencyKey: `${k}:${r.id}` });
  await t.query(`update public.stock_requests set status = 'cancelled' where id = $1`, [requestId]);
});

// =====================================================================================================================
say('S1  Two approvals race for the last 10 kg at the Warehouse');
const beef = await newItem('Beef');
await receive(beef, '10000');
const reqA = await newRequest([[beef, '10000']]);
const reqB = await newRequest([[beef, '10000']]);
say(`    start: ${await bal(WH, beef)}`);
await approve(reqA, [[beef, '10000']]);
say(`    after A approved: ${await bal(WH, beef)}`);
const e1 = await refuses(approve(reqB, [[beef, '10000']]), 409, 'insufficient_available', 'second approval refused');
eq(e1.details.available, '0.0000', 'refusal carries the available figure');
eq((await L.balance(db, WH, beef)).reserved, '10000.0000', 'B reserved nothing (the failed transaction rolled back)');
eq((await one(`select count(*)::int n from public.stock_reservations where request_id = $1`, [reqB])).n, 0, 'no reservation row for B');
eq((await one(`select status from public.stock_requests where id = $1`, [reqB])).status, 'submitted', 'B is still submitted');
await zeroDiffs('S1');
// Same race as two concurrent calls (PGlite queues transactions on one connection, so this is a serial race, not parallel):
await cancelRequest(reqA);
const [r1, r2] = await Promise.allSettled([approve(reqA, [[beef, '10000']]), approve(reqB, [[beef, '10000']])]);
eq([r1.status, r2.status].sort(), ['fulfilled', 'rejected'], 'Promise.allSettled: exactly one of two approvals wins');
say(`    allSettled -> ${r1.status} / ${r2.status}; ${await bal(WH, beef)}`);
await zeroDiffs('S1 allSettled');

// =====================================================================================================================
say('S2  Partial approval: asks 20 kg, only 15 kg free');
const rice = await newItem('Rice'); await receive(rice, '15000');
const reqC = await newRequest([[rice, '20000']]);
await refuses(approve(reqC, [[rice, '20000']]), 409, 'insufficient_available', 'approving 20 of 15 refused with the free figure');
await approve(reqC, [[rice, '15000']]);
say(`    approved 15 kg: ${await bal(WH, rice)}`);
eq((await L.balance(db, WH, rice)).available, '0.0000', 'available drops by 15 kg');

// =====================================================================================================================
say('S3  Dispatch consumes its reservation (reserved and on_hand fall together)');
await tx((t) => L.post(t, { businessId, locationId: WH, itemId: beef, qty: '5000', reason: 'purchase_receipt', actorId, idempotencyKey: key('rcv') })); // top-up
say(`    before: ${await bal(WH, rice)}`);
const d1 = await dispatchLine(reqC, rice, '15000', 'dsp-rice-1');
say(`    dispatched 15 kg: ${await bal(WH, rice)}  consumedFromReservation=${d1.consumedFromReservation}`);
eq([d1.balance.onHand, d1.balance.reserved, d1.consumedFromReservation], ['0.0000', '0.0000', '15000.0000'], 'on_hand and reserved both fell by 15 kg');
const resC = await activeRes(reqC, rice);
eq([resC.status, resC.qc, resC.qrel], ['consumed', '15000.0000', '0.0000'], 'reservation closed as consumed');
const d1b = await dispatchLine(reqC, rice, '15000', 'dsp-rice-1');   // replay (reservation is closed now: lookup finds none, reservationId = null) -> must still be a pure replay
eq([d1b.replayed, d1b.movement.id], [true, d1.movement.id], 'replaying the same dispatch key returns the same movement');
eq((await L.balance(db, WH, rice)).onHand, '0.0000', 'replay did not take stock twice');
eq((await one(`select count(*)::int n from public.stock_reservation_events where kind = 'consume' and reservation_id = $1`, [resC.id])).n, 1, 'one consume event');
await zeroDiffs('S3');

// =====================================================================================================================
say('S4  Nothing else can dip into reserved stock');
const oil = await newItem('Oil'); await receive(oil, '10000');
const reqD = await newRequest([[oil, '8000']]);
await approve(reqD, [[oil, '8000']]);
say(`    ${await bal(WH, oil)}  (8 kg held for D)`);
await refuses(tx((t) => L.post(t, { businessId, locationId: WH, itemId: oil, qty: '-3000', reason: 'wastage', actorId, idempotencyKey: key() })), 409, 'stock_reserved', 'wastage into reserved refused');
await refuses(tx((t) => L.post(t, { businessId, locationId: WH, itemId: oil, qty: '-3000', reason: 'transfer_dispatch', actorId, idempotencyKey: key() })), 409, 'stock_reserved', 'dispatch WITHOUT the reservation id cannot dip in either');
await refuses(tx((t) => L.post(t, { businessId, locationId: WH, itemId: oil, qty: '-3000', reason: 'wastage', reservationId: resC.id, actorId, idempotencyKey: key() })), 400, 'reservation_not_applicable', 'wastage cannot name a reservation');
await refuses(tx((t) => L.post(t, { businessId, locationId: WH, itemId: oil, qty: '-3000', reason: 'transfer_dispatch', reservationId: resC.id, actorId, idempotencyKey: key() })), 409, 'reservation_mismatch', 'a reservation for another item is rejected');
ok((await tx((t) => L.post(t, { businessId, locationId: WH, itemId: oil, qty: '-2000', reason: 'wastage', actorId, idempotencyKey: key() }))).balance.onHand === '8000.0000', 'the 2 kg that is free can still be wasted');
say(`    free 2 kg wasted: ${await bal(WH, oil)}`);
await refuses(tx((t) => L.reserve(t, { businessId, locationId: BR, itemId: oil, qty: '1000', requestId: reqD, idempotencyKey: key() })), 409, 'reservation_not_at_warehouse', 'no reservations at a branch (D2-12)');
// A legacy writer (main's 009 code) that bypasses ledger.js: the DB check is the backstop.
await assert.rejects(db.query('update public.stock_balances set on_hand = on_hand - 1000 where location_id = $1 and item_id = $2', [WH, oil]), /stock_balances_reserved_within_on_hand/);
checks++; say('    refused by DB: direct UPDATE of on_hand below reserved (check stock_balances_reserved_within_on_hand)');
await zeroDiffs('S4');

// =====================================================================================================================
say('S5  Cancel releases; replays are idempotent; over-release refused');
const resD = await activeRes(reqD, oil);
await cancelRequest(reqD, 'cnl-D');
say(`    after cancel: ${await bal(WH, oil)}`);
eq([(await L.balance(db, WH, oil)).reserved, (await activeRes(reqD, oil)).status], ['0.0000', 'released'], 'released, available restored');
await cancelRequest(reqD, 'cnl-D');   // retry of the same command
eq((await L.balance(db, WH, oil)).reserved, '0.0000', 'cancel replay changes nothing');
const rep = await tx((t) => L.release(t, resD.id, { idempotencyKey: `cnl-D:${resD.id}`, qty: '1000' }));
eq(rep.replayed, true, 'release replay flagged');
await refuses(tx((t) => L.release(t, resD.id, { qty: '1', idempotencyKey: key() })), 409, 'release_too_much', 'over-release refused');
await zeroDiffs('S5');

// =====================================================================================================================
say('S6  Partial dispatch: consumed part leaves, remainder STAYS reserved (decision); cancel releases only the remainder');
const flour = await newItem('Flour'); await receive(flour, '10000');
const reqE = await newRequest([[flour, '8000']]);
await approve(reqE, [[flour, '8000']]);
await dispatchLine(reqE, flour, '5000');
const resE = await activeRes(reqE, flour);
say(`    dispatched 5 of 8: ${await bal(WH, flour)}  reservation ${resE.status} consumed=${resE.qc}`);
eq([(await L.balance(db, WH, flour)).onHand, (await L.balance(db, WH, flour)).reserved, resE.status], ['5000.0000', '3000.0000', 'active'], 'remainder 3 kg still held');
await zeroDiffs('S6a');
// dispatch rule: qty <= reservation remaining + free stock.  3 kg held, 2 kg free (5 on hand - 3 held).
await receive(flour, '2000');   // 7 on hand, 3 held, 4 free
await refuses(dispatchLine(reqE, flour, '8000'), 409, 'insufficient_stock', 'more than on hand refused');
await refuses(dispatchLine(reqE, flour, '7500'), 409, 'insufficient_stock', 'beyond on hand refused');
await refuses(dispatchLine(reqE, flour, '7000.5'), 409, 'insufficient_stock', 'beyond on hand refused (decimals)');
await tx((t) => L.post(t, { businessId, locationId: WH, itemId: flour, qty: '-3000', reason: 'wastage', actorId, idempotencyKey: key() })); // free 4 -> 1
say(`    free stock down to 1 kg: ${await bal(WH, flour)}`);
await refuses(dispatchLine(reqE, flour, '4500'), 409, 'insufficient_stock', 'on hand is 4 kg: asking 4.5 refused');
const d4 = await dispatchLine(reqE, flour, '4000');
say(`    dispatch 4 kg (3 reserved + 1 free): ${await bal(WH, flour)} consumedFromReservation=${d4.consumedFromReservation}`);
eq([d4.consumedFromReservation, d4.balance.onHand, d4.balance.reserved], ['3000.0000', '0.0000', '0.0000'], 'reservation consumed first, free stock covers the rest');
await zeroDiffs('S6b');
// A dispatch can use its OWN reservation plus FREE stock, but never another request's reservation.
const pepper = await newItem('Pepper'); await receive(pepper, '10000');
const reqX = await newRequest([[pepper, '4000']]); const reqY = await newRequest([[pepper, '4000']]);
await approve(reqX, [[pepper, '4000']]); await approve(reqY, [[pepper, '4000']]);
say(`    X and Y each hold 4 kg: ${await bal(WH, pepper)}`);
await refuses(dispatchLine(reqX, pepper, '7000'), 409, 'stock_reserved', 'X asks 7 kg = its 4 + 3, but only 2 kg is free (Y holds 4)');
const dx = await dispatchLine(reqX, pepper, '6000');
say(`    X dispatches 6 kg (4 reserved + 2 free): ${await bal(WH, pepper)}`);
eq([dx.balance.onHand, dx.balance.reserved], ['4000.0000', '4000.0000'], 'Y still holds its 4 kg');
// partial dispatch then cancel: only the remainder is released and the row closes as consumed
const sugar = await newItem('Sugar'); await receive(sugar, '10000');
const reqF = await newRequest([[sugar, '6000']]);
await approve(reqF, [[sugar, '6000']]);
await dispatchLine(reqF, sugar, '2000');
await cancelRequest(reqF);
const resF = await activeRes(reqF, sugar);
say(`    dispatch 2 of 6 then cancel: ${await bal(WH, sugar)} reservation ${resF.status} consumed=${resF.qc} released=${resF.qrel}`);
eq([resF.status, resF.qc, resF.qrel, (await L.balance(db, WH, sugar)).reserved, (await L.balance(db, WH, sugar)).onHand], ['consumed', '2000.0000', '4000.0000', '0.0000', '8000.0000'], 'only the undispatched remainder was released');
await zeroDiffs('S6c');

// =====================================================================================================================
say('S7  Reserve idempotency and one-active-per-line');
const salt = await newItem('Salt'); await receive(salt, '5000');
const reqG = await newRequest([[salt, '2000']]);
const k1 = key('res');
const a1 = await tx((t) => L.reserve(t, { businessId, locationId: WH, itemId: salt, qty: '2000', requestId: reqG, actorId, idempotencyKey: k1 }));
const a2 = await tx((t) => L.reserve(t, { businessId, locationId: WH, itemId: salt, qty: '2000', requestId: reqG, actorId, idempotencyKey: k1 }));
eq([a1.replayed, a2.replayed, a1.reservation.id === a2.reservation.id, (await L.balance(db, WH, salt)).reserved], [false, true, true, '2000.0000'], 'same key -> same reservation, held once');
await refuses(tx((t) => L.reserve(t, { businessId, locationId: WH, itemId: salt, qty: '1000', requestId: reqG, actorId, idempotencyKey: k1 })), 409, 'idempotency_conflict', 'same key, different qty refused');
await refuses(tx((t) => L.reserve(t, { businessId, locationId: WH, itemId: salt, qty: '1000', requestId: reqG, actorId, idempotencyKey: key() })), 409, 'already_reserved', 'second active hold on the same line refused');
// Changing an approval = release then reserve (in one transaction in the service)
await tx(async (t) => { await L.release(t, a1.reservation.id, { idempotencyKey: key(), reason: 'edited' }); await L.reserve(t, { businessId, locationId: WH, itemId: salt, qty: '1000', requestId: reqG, actorId, idempotencyKey: key() }); });
eq((await L.balance(db, WH, salt)).reserved, '1000.0000', 're-approving a smaller amount works (release + reserve)');
await zeroDiffs('S7');

// =====================================================================================================================
say('S8  Order holds (013 snapshots) combine: available = on_hand - reserved - held');
// Branch: 10 kg of chicken, a burger uses 500 g; an open (taken) order for 6 burgers holds 3 kg.
const chicken = await newItem('Chicken');
await db.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings) values ($1, $2, $3, 500)`, [ids.burgerId, branchId, chicken]);
await receive(chicken, '10000', BR);
await receive(chicken, '20000', WH);
const order1 = await helpers.order([{ itemId: ids.burgerId, name: 'Chicken burger', quantity: 6 }], 'taken');
const av = await L.availability(db, BR, chicken);
say(`    branch: ${JSON.stringify(av)}`);
eq(av, { onHand: '10000.0000', reserved: '0.0000', held: '3000.0000', available: '7000.0000' }, 'branch available = 10 - 0 - 3 kg');
const reqH = await newRequest([[chicken, '12000']]);
await approve(reqH, [[chicken, '12000']]);
const avw = await L.availability(db, WH, chicken);
say(`    warehouse: ${JSON.stringify(avw)}`);
eq(avw, { onHand: '20000.0000', reserved: '12000.0000', held: '0.0000', available: '8000.0000' }, 'warehouse available = 20 - 12 reserved - 0 held');
// branch -> branch style dispatch must respect held orders; a plain post (no flag) would not, so the service passes respectHeld.
await refuses(tx((t) => L.post(t, { businessId, locationId: BR, itemId: chicken, qty: '-8000', reason: 'transfer_dispatch', counterpartyLocationId: WH, respectHeld: true, actorId, idempotencyKey: key() })), 409, 'stock_held', 'branch dispatch of 8 kg refused: 3 kg held for open orders');
const ok7 = await tx((t) => L.post(t, { businessId, locationId: BR, itemId: chicken, qty: '-7000', reason: 'transfer_dispatch', counterpartyLocationId: WH, respectHeld: true, actorId, idempotencyKey: key() }));
say(`    branch dispatch of 7 kg allowed: ${await bal(BR, chicken)}`);
eq(ok7.balance.onHand, '3000.0000', 'exactly the free 7 kg left the branch');
// ...and the other direction: the 013 order check sees on_hand drop, so a new order that needs more than is left is refused (sold out).
let soldOut = null;
try { await helpers.order([{ itemId: ids.burgerId, name: 'Chicken burger', quantity: 1 }], 'taken'); } catch (e) { soldOut = e; }
ok(soldOut && /Sold out/.test(soldOut.message), 'order check: 3 kg on hand, 3 kg held -> a 7th burger is refused (stock_sold_out)');
say(`    new order after the dispatch: ${soldOut?.message}`);
// Dispatching branch stock does not touch reservations, and a warehouse reservation is not seen by the order check (orders never read the Warehouse).
await zeroDiffs('S8');
// Backstop on a branch: keep-selling overdraw (on_hand < 0 with reserved = 0) is still allowed by the new check.
await db.query('update public.stock_balances set on_hand = -5 where location_id = $1 and item_id = $2', [BR, chicken]); checks++;
say('    DB check does not block branch overdraw (reserved = 0 rows are exempt)');
await db.query('update public.stock_balances set on_hand = 3000 where location_id = $1 and item_id = $2', [BR, chicken]);

// =====================================================================================================================
say('S9  Randomised ledger (seeded): reserve / release / dispatch / waste / receive, invariants after every step');
let seed = 20261118; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const items = [await newItem('R-a'), await newItem('R-b'), await newItem('R-c')];
for (const i of items) await receive(i, '20000');
const reqs = []; for (let i = 0; i < 6; i++) reqs.push(await newRequest(items.map((it) => [it, '1000'])));
let done = 0, refusedN = 0;
for (let step = 0; step < 400; step++) {
  const item = items[Math.floor(rnd() * items.length)]; const rq = reqs[Math.floor(rnd() * reqs.length)];
  const kg = String(Math.floor(rnd() * 9000) + 1);
  const act = Math.floor(rnd() * 5);
  try {
    if (act === 0) await tx((t) => L.reserve(t, { businessId, locationId: WH, itemId: item, qty: kg, requestId: rq, actorId, idempotencyKey: key('r') }));
    else if (act === 1) { const r = (await one(`select id from public.stock_reservations where request_id = $1 and item_id = $2 and status = 'active'`, [rq, item])); if (r) await tx((t) => L.release(t, r.id, { qty: rnd() < 0.5 ? null : String(Math.floor(rnd() * 4000) + 1), idempotencyKey: key('x') })); }
    else if (act === 2) await dispatchLine(rq, item, kg);
    else if (act === 3) await tx((t) => L.post(t, { businessId, locationId: WH, itemId: item, qty: `-${kg}`, reason: 'wastage', actorId, idempotencyKey: key('w') }));
    else await receive(item, kg);
    done++;
  } catch (e) { if (!e.status) throw e; refusedN++; }
  const r = await recon();
  if (r.onHand.length || r.reserved.length) assert.fail(`step ${step}: ${JSON.stringify(r)}`);
  const bad = await db.query('select 1 from public.stock_balances where location_id = $1 and (on_hand < reserved or reserved < 0)', [WH]);
  if (bad.rows.length) assert.fail(`step ${step}: reserved exceeds on_hand`);
}
checks++; say(`    400 random steps: ${done} applied, ${refusedN} refused; reserved = sum of active remainders and on_hand = ledger after EVERY step`);

// =====================================================================================================================
say('S10 Table-level guards');
await assert.rejects(db.query(`update public.stock_reservations set qty_consumed = qty_reserved + 1 where id = $1`, [resE.id]), /check/i); checks++;
await assert.rejects(db.query(`update public.stock_reservations set status = 'active' where id = $1`, [resE.id]), /check/i); checks++;
say('    refused by DB: consumed > reserved; status out of step with the remainder');

// =====================================================================================================================
say('S11 reconcile() also checks reserved = sum of active reservations; plain messages');
await zeroDiffs('before tampering');
eq((await L.reconcile(db, { businessId })), [], 'reconcile() (on hand AND reserved) is clean');
await db.query('update public.stock_balances set reserved = reserved + 100 where location_id = $1 and item_id = $2', [WH, items[0]]);
const drift = await L.reconcile(db, { businessId });
eq(drift.map((r) => [r.kind, r.item_id]), [['reserved', items[0]]], 'reconcile() reports a balance whose reserved drifted from its reservations');
eq([drift[0].reserved === drift[0].reservations_total, Number(drift[0].reserved) - Number(drift[0].reservations_total)], [false, 100], 'both numbers are shown');
eq((await L.reconcile(db, { businessId, locationId: BR })), [], 'a location filter ignores another location\'s drift');
await db.query('update public.stock_balances set reserved = reserved - 100 where location_id = $1 and item_id = $2', [WH, items[0]]);
await zeroDiffs('after repairing');
const msg = await refuses(tx((t) => L.release(t, resE.id, { qty: '1', idempotencyKey: key() })), 409, 'release_too_much', 'release message');
ok(/^Only .* of Flour is still held/.test(msg.message) && !/\d{4,}\.\d{4}/.test(msg.message), 'release_too_much speaks in the item\'s unit, not raw base units');
await refuses(tx((t) => L.reserve(t, { businessId, locationId: WH, itemId: flour, qty: '0', requestId: reqE, idempotencyKey: key() })), 400, 'bad_quantity', 'zero hold refused');

console.log(`Ledger reservations: ${checks} checks passed.`);
await db.close();
