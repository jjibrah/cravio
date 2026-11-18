// Inventory ledger service (P1-06), on PGlite with proposed migration 012 applied.
// Usage: node backend/tests/inv/ledger.test.js
import assert from 'node:assert/strict';
import { inventoryFixture } from './fixture.js';
import { post, postMany, reverse, balance, reconcile, REASONS, RECONCILE_SQL } from '../../src/inventory/ledger.js';
import { display } from '../../src/inventory/units.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };

const { db, ids, users, helpers } = await inventoryFixture({ extra: ['proposed/012_inventory_catalogue.sql'] });
const { tx, one } = helpers;
const { businessId, centerLocationId: center, branchLocationId: branchLoc } = ids;
const actorId = users.owner;

const newItem = async (name, unit = 'g', displayUnit = null) =>
  (await one(`insert into public.stock_items (business_id, name, unit, display_unit) values ($1, $2, $3, $4) returning id`, [businessId, name, unit, displayUnit])).id;

let seq = 0;
const key = () => `k-${++seq}`;
const mv = (itemId, qty, reason, extra = {}) => ({ businessId, locationId: center, itemId, qty, reason, actorId, idempotencyKey: key(), ...extra });
const run = (entry) => tx((t) => post(t, entry));
const refuses = async (promise, status, code, re, m) => {
  await assert.rejects(promise, (e) => {
    eq(e.status, status, `${m}: status`);
    eq(e.details?.code, code, `${m}: code`);
    if (re) assert.match(e.message, re, `${m}: message`);
    return true;
  }, m);
};

// Direction table is documented and complete.
eq(Object.keys(REASONS).length, 27, 'every 012 reason has a direction');
eq(typeof RECONCILE_SQL, 'string', 'reconcile SQL exported');

// ---- T-INV-1, T-INV-2: receive 5 kg, waste 300 g --------------------------------------------------------------
const beef = await newItem('Beef', 'g', 'kg');
await db.query(`insert into public.stock_item_units (item_id, name, factor) values ($1, 'crate', 10000)`, [beef]);
const r1 = await run(mv(beef, '5000', 'purchase_receipt', { entered: { quantity: '5', unit: 'kg' } }));
eq(r1.movement.delta, '5000.0000', 'T-INV-1 +5000 g');
eq(r1.movement.entered, { quantity: '5.0000', unit: 'kg' }, 'T-INV-1 entered kept');
eq(r1.replayed, false, 'fresh result');
eq(r1.balance, { onHand: '5000.0000', reserved: '0.0000', available: '5000.0000' }, 'T-INV-1 balance 5000');
eq((await tx((t) => balance(t, center, beef))).onHand, '5000.0000', 'balance() agrees');

const r2 = await run(mv(beef, '-300', 'wastage'));
eq(r2.balance.onHand, '4700.0000', 'T-INV-2 balance 4700');
eq(r2.movement.balanceAfter, '4700.0000', 'balance_after stored');
eq(display(r2.balance.onHand, { name: 'Beef', baseUnit: 'g', displayUnit: 'kg', units: [] }), '4.7 kg', 'T-INV-2 displays 4.7 kg');

// An item's own unit as the entered unit.
const rCrate = await run(mv(beef, '10000', 'opening', { locationId: branchLoc, entered: { quantity: '1', unit: 'crate' } }));
eq(rCrate.movement.entered.unit, 'crate', 'own unit kept as entered');

// ---- Stop at zero ---------------------------------------------------------------------------------------------
await refuses(run(mv(beef, '-4701', 'wastage')), 409, 'insufficient_stock', /Only 4\.7 kg of Beef left here; you tried to take 4\.701 kg\./, 'stop at zero');
eq((await tx((t) => balance(t, center, beef))).onHand, '4700.0000', 'refused take changed nothing');
eq((await one(`select count(*)::int as n from public.stock_movements where item_id = $1 and location_id = $2`, [beef, center])).n, 2, 'refused take wrote no movement');
const exact = await run(mv(beef, '-4700', 'wastage'));
eq(exact.balance.onHand, '0.0000', 'taking exactly all is allowed');

// ---- Reserved stock -------------------------------------------------------------------------------------------
const chicken = await newItem('Chicken', 'g', 'kg');
await run(mv(chicken, '5000', 'purchase_receipt'));
await db.query(`update public.stock_balances set reserved = 1000 where location_id = $1 and item_id = $2`, [center, chicken]);
eq(await tx((t) => balance(t, center, chicken)), { onHand: '5000.0000', reserved: '1000.0000', available: '4000.0000' }, 'available = on hand - reserved');
await refuses(run(mv(chicken, '-4001', 'wastage')), 409, 'stock_reserved', /free here/, 'reserved');
const rRes = await run(mv(chicken, '-4000', 'wastage'));
eq(rRes.balance, { onHand: '1000.0000', reserved: '1000.0000', available: '0.0000' }, 'can take exactly the available stock');
await refuses(run(mv(chicken, '-1', 'wastage')), 409, 'stock_reserved', null, 'nothing free');

// ---- Idempotency ----------------------------------------------------------------------------------------------
const flour = await newItem('Flour', 'g');
const dup = mv(flour, '1000', 'purchase_receipt');
const first = await run(dup);
const second = await run(dup);
eq(second.replayed, true, 'second call replayed');
eq(second.movement, first.movement, 'replay returns the first movement unchanged');
eq((await one(`select count(*)::int as n from public.stock_movements where idempotency_key = $1`, [dup.idempotencyKey])).n, 1, 'one row only');
await refuses(run({ ...dup, qty: '2000' }), 409, 'idempotency_conflict', /already used/, 'same key different qty');
await refuses(run({ ...dup, locationId: branchLoc }), 409, 'idempotency_conflict', null, 'same key different location');
eq((await tx((t) => balance(t, center, flour))).onHand, '1000.0000', 'replay and conflict left stock alone');
// Same key under a different reason is a different movement.
const otherReason = await run({ ...dup, qty: '-10', reason: 'wastage' });
eq(otherReason.replayed, false, 'unique is (key, reason)');
await refuses(run({ ...mv(flour, '5', 'purchase_receipt'), idempotencyKey: '' }), 400, 'idempotency_required', null, 'key required');

// ---- Weighted average cost ------------------------------------------------------------------------------------
const oil = await newItem('Oil', 'ml', 'l');
const b1 = await run(mv(oil, '1000', 'purchase_receipt', { unitCost: '0.60' }));
eq(b1.movement.value, '600.00', 'value = qty x cost, 2 dp');
eq((await one(`select avg_cost::text as a, last_cost::text as l from public.stock_items where id = $1`, [oil])), { a: '0.600000', l: '0.600000' }, 'first buy sets avg');
await run(mv(oil, '1000', 'purchase_receipt', { unitCost: '0.80' }));
eq((await one(`select avg_cost::text as a, last_cost::text as l from public.stock_items where id = $1`, [oil])), { a: '0.700000', l: '0.800000' }, 'avg 0.70, last 0.80');
const out = await run(mv(oil, '-333', 'wastage'));
eq(out.movement.unitCost, '0.700000', 'outbound takes avg cost');
eq(out.movement.value, '-233.10', 'outbound value 2dp');
const odd = await run(mv(oil, '-1', 'wastage', { unitCost: '0.333333' }));
eq(odd.movement.value, '-0.33', 'value rounds to 2 dp');
eq((await one(`select avg_cost::text as a from public.stock_items where id = $1`, [oil])).a, '0.700000', 'outbound leaves avg alone');
// Stock in other locations counts toward the average; a cost-less receipt leaves it alone.
await run(mv(oil, '667', 'opening', { locationId: branchLoc }));
eq((await one(`select avg_cost::text as a from public.stock_items where id = $1`, [oil])).a, '0.700000', 'receipt without cost leaves avg');
const noCost = await newItem('Salt', 'g');
const sNo = await run(mv(noCost, '100', 'purchase_receipt'));
eq(sNo.movement.unitCost, null, 'no cost known stays null');
eq((await run(mv(noCost, '-10', 'wastage'))).movement.value, null, 'value unknown without cost');

// ---- Reversal -------------------------------------------------------------------------------------------------
const rice = await newItem('Rice', 'g');
const rec = await run(mv(rice, '2000', 'purchase_receipt', { unitCost: '0.10' }));
const rev = await tx((t) => reverse(t, { movementId: rec.movement.id, actorId, note: 'wrong delivery', idempotencyKey: key() }));
eq(rev.movement.reason, 'reversal', 'reversal reason');
eq(rev.movement.delta, '-2000.0000', 'opposite delta');
eq(rev.movement.refType, 'movement', 'ref type movement');
eq(rev.balance.onHand, '0.0000', 'balance back');
await assert.rejects(tx((t) => reverse(t, { movementId: rec.movement.id, idempotencyKey: key() })), (e) => { eq(e.status, 409, 'twice'); eq(e.details.code, 'already_reversed', 'twice code'); return true; });
await assert.rejects(tx((t) => reverse(t, { movementId: rev.movement.id, idempotencyKey: key() })), (e) => { eq(e.status, 409, 'reversal of reversal'); eq(e.details.code, 'already_reversal', 'code'); return true; });
const rev2 = await tx((t) => reverse(t, { movementId: rec.movement.id, idempotencyKey: rev.movement.idempotencyKey }));
eq(rev2.replayed, true, 'retrying the same reversal replays');
eq(rev.movement.reversesMovementId, rec.movement.id, 'reversal points at the original');
eq([rev.movement.refType, rev.movement.refId], ['movement', null], 'ref_type movement, ref_id null');
await assert.rejects(db.query(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, reverses_movement_id)
  values ($1, $2, $3, -1, 0, 'reversal', $4)`, [businessId, center, rice, rec.movement.id]), /stock_movements_reversed_once|duplicate key/);
checks++;
// Reversing a receipt whose stock was used would go below zero.
const rec2 = await run(mv(rice, '500', 'purchase_receipt'));
await run(mv(rice, '-400', 'wastage'));
await refuses(tx((t) => reverse(t, { movementId: rec2.movement.id, idempotencyKey: key() })), 409, 'insufficient_stock', /Only 100 g of Rice/, 'reverse below zero');
// Reversing an outbound movement puts stock back.
const waste = await run(mv(rice, '-50', 'wastage'));
const back = await tx((t) => reverse(t, { movementId: waste.movement.id, idempotencyKey: key() }));
eq(back.movement.delta, '50.0000', 'reversing a take adds stock');
await refuses(tx((t) => reverse(t, { movementId: '999999', idempotencyKey: key() })), 404, 'movement_not_found', null, 'unknown movement');

// ---- Direction rules and validation ---------------------------------------------------------------------------
const pasta = await newItem('Pasta', 'g');
await refuses(run(mv(pasta, '100', 'wastage')), 400, 'wrong_direction', /removes stock/, 'wastage positive');
await refuses(run(mv(pasta, '-100', 'purchase_receipt')), 400, 'wrong_direction', /adds stock/, 'receipt negative');
await refuses(run(mv(pasta, '0', 'count_correction')), 400, 'zero_quantity', null, 'zero');
await refuses(run(mv(pasta, '1.00001', 'purchase_receipt')), 400, 'precision', /4 decimal/, '5 dp');
await refuses(run(mv(pasta, '5', 'bogus')), 400, 'bad_reason', null, 'unknown reason');
await refuses(run({ ...mv(pasta, '5', 'purchase_receipt'), itemId: '11111111-1111-4111-8111-111111111111' }), 404, 'item_not_found', null, 'foreign item');
await refuses(run({ ...mv(pasta, '5', 'purchase_receipt'), locationId: '11111111-1111-4111-8111-111111111111' }), 404, 'location_not_found', null, 'foreign location');
await refuses(run(mv(pasta, '5', 'purchase_receipt', { entered: { quantity: '1', unit: 'l' } })), 400, 'unit_mismatch', /by weight/, 'unit mismatch');
await refuses(run(mv(pasta, '5', 'purchase_receipt', { entered: { quantity: '1', unit: 'kg' } })), 400, 'entered_mismatch', null, 'entered disagrees');
eq((await run(mv(pasta, '5', 'count_correction'))).balance.onHand, '5.0000', 'count_correction + allowed');
eq((await run(mv(pasta, '-2', 'count_correction'))).balance.onHand, '3.0000', 'count_correction - allowed');
eq((await one(`select count(*)::int as n from public.stock_movements where item_id = $1`, [pasta])).n, 2, 'refused inputs wrote nothing');

// ---- T-SEC-3: append-only -------------------------------------------------------------------------------------
await assert.rejects(db.query(`update public.stock_movements set note = 'x' where id = $1`, [r1.movement.id]), /append-only|can.?t|not allowed|cannot/i);
await assert.rejects(db.query(`delete from public.stock_movements where id = $1`, [r1.movement.id]), /append-only|can.?t|not allowed|cannot/i);
checks += 2;

// ---- Archived item, base unit lock ----------------------------------------------------------------------------
const old = await newItem('Old stock', 'g');
await run(mv(old, '100', 'purchase_receipt'));
await db.query(`update public.stock_items set archived_at = now() where id = $1`, [old]);
await refuses(run(mv(old, '10', 'purchase_receipt')), 409, 'item_archived', /archived/, 'archived receipt');
eq((await run(mv(old, '-10', 'wastage'))).balance.onHand, '90.0000', 'write-offs still allowed on archived item');
await assert.rejects(db.query(`update public.stock_items set unit = 'ml' where id = $1`, [beef]), /stock history/);
checks++;
const fresh = await newItem('Brand new', 'g');
await db.query(`update public.stock_items set unit = 'ml' where id = $1`, [fresh]); // no history yet: allowed
checks++;

// ---- Location status ------------------------------------------------------------------------------------------
const pot = await newItem('Pot', 'piece');
await run(mv(pot, '10', 'purchase_receipt'));
await db.query(`update public.stock_locations set status = 'suspended' where id = $1`, [center]);
await refuses(run(mv(pot, '5', 'purchase_receipt')), 409, 'location_suspended', /suspended/, 'suspended inbound');
eq((await run(mv(pot, '-3', 'pos_consumption'))).balance.onHand, '7.0000', 'suspended location still serves');
eq((await run(mv(pot, '-1', 'count_correction'))).balance.onHand, '6.0000', 'suspended location still takes corrections');
await db.query(`update public.stock_locations set status = 'archived', archived_at = now() where id = $1`, [center]);
await refuses(run(mv(pot, '-1', 'wastage')), 409, 'location_archived', /archived, so its stock can’t change\. Reopen it first\./, 'archived outbound');
await refuses(run(mv(pot, '5', 'purchase_receipt')), 409, 'location_archived', null, 'archived inbound');
await db.query(`update public.stock_locations set status = 'active', archived_at = null where id = $1`, [center]);
eq((await run(mv(pot, '5', 'purchase_receipt'))).balance.onHand, '11.0000', 'reopened location works again');

// ---- postMany -------------------------------------------------------------------------------------------------
const many = await tx((t) => postMany(t, [
  mv(pasta, '10', 'purchase_receipt', { locationId: branchLoc }),
  mv(flour, '5', 'purchase_receipt'),
  mv(pasta, '10', 'purchase_receipt'),
]));
eq(many.map((r) => r.movement.itemId), [pasta, flour, pasta], 'postMany keeps input order');
eq(many.map((r) => r.movement.locationId), [branchLoc, center, center], 'postMany keeps input locations');

// ---- Sequential 50-deduction loop (true parallelism T-INV-7 deferred to P1-18) --------------------------------
const bun = await newItem('Buns', 'piece');
await run(mv(bun, '1000', 'purchase_receipt'));
await tx(async (t) => { for (let i = 0; i < 50; i++) await post(t, mv(bun, '-7', 'pos_consumption')); });
eq((await tx((t) => balance(t, center, bun))).onHand, '650.0000', 'after 50 deductions of 7');

// ---- T-INV-6: random operations never break the ledger --------------------------------------------------------
let seed = 20261118;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const items = [];
for (let i = 0; i < 5; i++) items.push(await newItem(`Random ${i}`, 'g'));
const locs = [center, branchLoc];
const model = new Map();
let applied = 0;
for (let i = 0; i < 200; i++) {
  const itemId = items[rnd(5)]; const locationId = locs[rnd(2)];
  const k = `${locationId}:${itemId}`; const have = model.get(k) ?? 0;
  const pick = rnd(3);
  const amount = 1 + rnd(900);
  const [reason, delta] = pick === 0 ? ['purchase_receipt', amount] : pick === 1 ? ['wastage', -amount] : ['count_correction', rnd(2) ? amount : -amount];
  if (have + delta < 0) continue;
  await run(mv(itemId, String(delta), reason, { locationId, unitCost: pick === 0 ? `0.${10 + rnd(80)}` : undefined }));
  model.set(k, have + delta);
  applied++;
}
ok(applied > 100, `random run applied ${applied} posts`);
eq(await tx((t) => reconcile(t, { businessId })), [], 'T-INV-6 reconcile finds nothing (whole business)');
eq(await tx((t) => reconcile(t, { businessId, locationId: center })), [], 'reconcile one location');
for (const [k, v] of model) {
  const [l, i] = k.split(':');
  eq((await tx((t) => balance(t, l, i))).onHand, `${v}.0000`, `model matches ${k}`);
}
// Reconcile does catch a tampered balance.
await db.query(`update public.stock_balances set on_hand = on_hand + 1 where location_id = $1 and item_id = $2`, [center, bun]);
const bad = await tx((t) => reconcile(t, { businessId }));
eq(bad.length, 1, 'tampered balance detected');
eq([bad[0].on_hand, bad[0].ledger_total], ['651.0000', '650.0000'], 'reconcile shows both numbers');

console.log(`Ledger: ${checks} checks passed.`);
await db.close();
