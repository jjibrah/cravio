// Spike 1 (P3-01): FEFO allocation inside the serve trigger. Run: node docs/inventory-kb/spikes/fefo-serve/spike_test.mjs
// PGlite, 009 + proposed 012..017 + spike_022.sql. Nothing touches the shared database.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)) + '/';
// Inside the repo (docs/inventory-kb/spikes/<name>/) the root is four levels up; set REPO to run a copy from elsewhere.
const REPO = process.env.REPO || resolve(HERE, '../../../..');
const { inventoryFixture } = await import(`${REPO}/backend/tests/inv/fixture.js`);
const { PROPOSED_MIGRATIONS } = await import(`${REPO}/backend/tests/inv/migrations.js`);
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const say = (s) => console.log(s);
const section = (s) => say(`\n== ${s}`);

async function world(withSpike = true) {
  const f = await inventoryFixture({ extra: [...PROPOSED_MIGRATIONS, ...(withSpike ? [HERE + 'spike_022.sql'] : [])] });
  const { db, ids, users, helpers } = f;
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const one = async (sql, p) => (await q(sql, p))[0];
  const biz = ids.businessId, loc = ids.branchLocationId, branchId = ids.branchId;
  let seq = 0;
  const item = async (name, { tracked = false, cost = null } = {}) =>
    (await one(`insert into public.stock_items (business_id, name, unit, yield_pct, avg_cost${withSpike ? ', expiry_tracking' : ''}) values ($1, $2, 'g', 100, $3${withSpike ? ', $4' : ''}) returning id`,
      withSpike ? [biz, name, cost, tracked ? 'optional' : 'off'] : [biz, name, cost])).id;
  const dish = async (name) => (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, 100) returning id`, [branchId, ids.categoryId, name])).id;
  const recipe = async (menuItem, lines, { allow = false } = {}) => {
    const r = await one(`insert into public.recipes (business_id, restaurant_id, menu_item_id, allow_when_out) values ($1, $2, $3, $4) returning id`, [biz, branchId, menuItem, allow]);
    const ver = await one(`insert into public.recipe_versions (business_id, recipe_id, version) values ($1, $2, 1) returning id`, [biz, r.id]);
    let pos = 0;
    for (const [i, qty] of lines) await db.query(`insert into public.recipe_lines (business_id, version_id, item_id, position, qty_base) values ($1, $2, $3, $4, $5)`, [biz, ver.id, i, pos++, qty]);
    await db.query(`update public.recipes set current_version_id = $2 where id = $1`, [r.id, ver.id]);
  };
  const place = async (lines) => {
    const o = (await one(`insert into public.orders (restaurant_id, status, taken_by) values ($1, 'taken', $2) returning id`, [branchId, users.waiter])).id;
    try {
      await db.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, kind)
        select $1, $2, (l->>'itemId')::uuid, l->>'name', 100, (l->>'quantity')::int, 100, 'item' from jsonb_array_elements($3::jsonb) l`, [o, branchId, JSON.stringify(lines)]);
    } catch (e) { await db.query('delete from public.orders where id = $1', [o]); throw e; }
    return o;
  };
  const serve = (o) => db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [o, users.waiter]);
  const attempt = async (p) => { try { await p; return null; } catch (e) { return e; } };
  const onHand = async (i) => Number((await one(`select on_hand from public.stock_balances where location_id = $1 and item_id = $2`, [loc, i]))?.on_hand ?? 0);
  /** Unbatched stock (what exists before an item becomes tracked): a plain opening movement. */
  const plainStock = (i, qty, cost = null) => db.query(`with b as (insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, $3)
      on conflict (location_id, item_id) do update set on_hand = public.stock_balances.on_hand + excluded.on_hand returning on_hand)
    insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, unit_cost, value)
    select $4, $1, $2, $3, on_hand, 'opening', $5, case when $5::numeric is null then null else round($3 * $5::numeric, 2) end from b`, [loc, i, qty, biz, cost]);
  /** A received batch: expiry in `days` from today (Nairobi date), cost per base unit. */
  const batch = async (i, no, qty, days, cost = null) => {
    const b = await one(`insert into public.batches (business_id, item_id, batch_no, received_at, expiry_date, unit_cost)
      values ($1, $2, $3, now() - ($6 || ' minutes')::interval, case when $4::int is null then null else (now() at time zone 'Africa/Nairobi')::date + $4::int end, $5) returning id`, [biz, i, no, days, cost, String(++seq)]);
    await db.query(`insert into public.batch_balances (location_id, item_id, batch_id, on_hand) values ($1, $2, $3, $4)`, [loc, i, b.id, qty]);
    await db.query(`with s as (insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, $3)
        on conflict (location_id, item_id) do update set on_hand = public.stock_balances.on_hand + excluded.on_hand returning on_hand)
      insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, unit_cost, value, batch_id)
      select $4, $1, $2, $3, on_hand, 'purchase_receipt', $5, case when $5::numeric is null then null else round($3 * $5::numeric, 2) end, $6 from s`, [loc, i, qty, biz, cost, b.id]);
    return b.id;
  };
  const moves = (o) => q(`select coalesce(b.batch_no, '(no batch)') as batch, (-m.delta)::text as qty, m.unit_cost::text as unit_cost, (-m.value)::text as value
      from public.stock_movements m left join public.batches b on b.id = m.batch_id where m.order_id = $1 order by m.id`, [o]);
  const balances = (i) => q(`select b.batch_no, bb.on_hand::text as on_hand from public.batch_balances bb join public.batches b on b.id = bb.batch_id
      where bb.location_id = $1 and bb.item_id = $2 order by b.batch_no`, [loc, i]);
  /** The three invariants a reconciliation job would check. Returns the list of differences (expect []). */
  const invariants = async () => {
    const diffs = [];
    for (const r of await q(`select item_id, sum(delta)::text as total, (select on_hand::text from public.stock_balances s where s.location_id = m.location_id and s.item_id = m.item_id) as on_hand
        from public.stock_movements m where location_id = $1 group by location_id, item_id`, [loc])) if (Number(r.total) !== Number(r.on_hand)) diffs.push(['ledger != on_hand', r]);
    for (const r of await q(`select bb.batch_id, bb.on_hand::text as on_hand, coalesce((select sum(delta) from public.stock_movements m where m.batch_id = bb.batch_id and m.location_id = bb.location_id), 0)::text as moved
        from public.batch_balances bb where bb.location_id = $1`, [loc])) if (Number(r.on_hand) !== Number(r.moved)) diffs.push(['batch_balance != batch movements', r]);
    for (const r of await q(`select bb.item_id, sum(bb.on_hand)::text as batch_sum, (select on_hand::text from public.stock_balances s where s.location_id = bb.location_id and s.item_id = bb.item_id) as on_hand
        from public.batch_balances bb where bb.location_id = $1 group by bb.location_id, bb.item_id`, [loc])) if (Number(r.batch_sum) > Number(r.on_hand)) diffs.push(['sum(batches) > on_hand', r]);
    return diffs;
  };
  return { ...f, q, one, item, dish, recipe, place, serve, attempt, onHand, plainStock, batch, moves, balances, invariants, biz, loc, branchId };
}

const w = await world();
const { db, q, one, item, dish, recipe, place, serve, attempt, onHand, plainStock, batch, moves, balances, invariants } = w;

// A dish that uses 1 g of the tracked item per serving, so quantities in the script read directly.
const chicken = await item('Chicken (tracked)', { tracked: true, cost: 430 });
const buns = await item('Buns (untracked)', { tracked: false, cost: 10 });
const wing = await dish('Wing'), bun = await dish('Bun');
await recipe(wing, [[chicken, 1]]);
await recipe(bun, [[buns, 1]]);
const wings = (n) => [{ itemId: wing, name: 'Wing', quantity: n }];

section('S1 FEFO across 3 batches: expiries +3, +5, +9 days (5 each); serve 12');
const A = await batch(chicken, 'A', 5, 3, 400), B = await batch(chicken, 'B', 5, 5, 450), C = await batch(chicken, 'C', 5, 9, 500);
const o1 = await place(wings(12));
await serve(o1);
const m1 = await moves(o1);
say(JSON.stringify(m1));
eq(m1.map((r) => [r.batch, r.qty]), [['A', '5.0000'], ['B', '5.0000'], ['C', '2.0000']], 'A 5, B 5, C 2 in expiry order');
eq(await balances(chicken), [{ batch_no: 'A', on_hand: '0.0000' }, { batch_no: 'B', on_hand: '0.0000' }, { batch_no: 'C', on_hand: '3.0000' }], 'batch balances');
eq(await onHand(chicken), 3, 'on hand 3');
eq(await invariants(), [], 'reconciliation clean');
const eff1 = await one(`select count(*)::int as n, bool_and(movement_id is not null) as linked from public.order_stock_effects e join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [o1]);
eq(eff1, { n: 1, linked: true }, 'one effect row per (line, item); linked to the first movement');

section('S2 expired batches are skipped and block the sale; override brings one back');
await db.query(`update public.batches set expiry_date = (now() at time zone 'Africa/Nairobi')::date - 1 where id = $1`, [C]); // C (3 left) expired yesterday
const eSold = await attempt(place(wings(1)));
say(`order for 1 with only expired stock left -> ${eSold?.code} ${eSold?.hint}: ${eSold?.message}`);
ok(eSold && eSold.code === 'P0001' && eSold.hint === 'stock_sold_out', 'refused P0001 / stock_sold_out');
eq((await one(`select private.sellable_qty($1, $2)::text as s`, [w.loc, chicken])).s, '0.0000', 'sellable 0 while on hand is 3');
await db.query(`update public.batches set override_until = now() + interval '24 hours', override_by = $2, override_reason = 'checked, still good' where id = $1`, [C, w.users.manager]);
const o2 = await place(wings(2));
await serve(o2);
eq((await moves(o2)).map((r) => [r.batch, r.qty]), [['C', '2.0000']], 'overridden batch C is used');
await db.query(`update public.batches set override_until = now() - interval '1 minute' where id = $1`, [C]); // override lapsed
ok((await attempt(place(wings(1))))?.hint === 'stock_sold_out', 'override over: blocked again');
eq(await invariants(), [], 'reconciliation clean');

section('S3 stop at zero + exception still works (expired stock is not sold)');
// C has 1 left and is expired; add a fresh batch D with 4; a keep-selling dish would still be served but short.
const D = await batch(chicken, 'D', 4, 10, 480);
const wingKeep = await dish('Wing (keeps selling)');
await recipe(wingKeep, [[chicken, 1]], { allow: true });
const o3 = await place([{ itemId: wingKeep, name: 'Wing (keeps selling)', quantity: 7 }]); // allowed: keep-selling
await serve(o3);
eq((await moves(o3)).map((r) => [r.batch, r.qty]), [['D', '4.0000']], 'only the 4 g that is sellable is taken');
const exc = await one(`select short_qty::text as s, kind, status from public.stock_exceptions where order_id = $1`, [o3]);
eq(exc, { s: '3.0000', kind: 'unfulfilled_consumption', status: 'open' }, 'shortfall 3 logged as an exception');
eq(await onHand(chicken), 1, 'the expired 1 g is still on hand (not sold, not deleted)');
ok((await balances(chicken)).every((r) => Number(r.on_hand) >= 0), 'no negative batch balance');
eq(await invariants(), [], 'reconciliation clean');

section('S4 replay: serve fired 5 times deducts once');
const E = await batch(chicken, 'E', 10, 20, 470);
const o4 = await place(wings(3));
const before = await onHand(chicken);
await serve(o4);
for (let i = 0; i < 4; i++) { await db.query(`update public.orders set status = 'accepted', accepted_at = now() where id = $1`, [o4]); await serve(o4); }
eq(before - await onHand(chicken), 3, 'deducted once');
eq((await moves(o4)).length, 1, 'one movement');
eq((await one(`select count(*)::int as n from public.order_stock_effects e join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [o4])).n, 1, 'one effect');

section('S5 no-batch bucket is used LAST; batches with no expiry date come after dated ones');
const w5 = await world();
const c5 = await w5.item('Cream', { tracked: true, cost: 100 });
const d5 = await w5.dish('Cream dish'); await w5.recipe(d5, [[c5, 1]]);
await w5.plainStock(c5, 10, 90);                         // existing stock before the item was tracked: the bucket
await w5.batch(c5, 'X-nodate', 4, null, 120);            // no expiry date
await w5.batch(c5, 'Y-dated', 4, 30, 110);
const o5 = await w5.place([{ itemId: d5, name: 'Cream dish', quantity: 12 }]); await w5.serve(o5);
const m5 = await w5.moves(o5);
say(JSON.stringify(m5));
eq(m5.map((r) => [r.batch, r.qty]), [['Y-dated', '4.0000'], ['X-nodate', '4.0000'], ['(no batch)', '4.0000']], 'dated, then undated, then the bucket');
eq(await w5.invariants(), [], 'reconciliation clean');
eq(await w5.onHand(c5), 6, 'bucket has 6 left');

section('S6 quarantined batch is never sold');
const w6 = await world();
const c6 = await w6.item('Milk', { tracked: true, cost: 100 });
const d6 = await w6.dish('Milk dish'); await w6.recipe(d6, [[c6, 1]]);
const q1 = await w6.batch(c6, 'Q1', 5, 2, 100); await w6.batch(c6, 'Q2', 5, 8, 100);
await db.query('select 1'); await w6.db.query(`update public.batches set status = 'quarantined' where id = $1`, [q1]);
const o6 = await w6.place([{ itemId: d6, name: 'Milk dish', quantity: 5 }]); await w6.serve(o6);
eq((await w6.moves(o6)).map((r) => [r.batch, r.qty]), [['Q2', '5.0000']], 'only Q2 used');
ok((await w6.attempt(w6.place([{ itemId: d6, name: 'Milk dish', quantity: 1 }])))?.hint === 'stock_sold_out', 'quarantined stock does not count as sellable');

section('S7 cost: weighted average (default) vs batch cost (D3-1)');
const w7 = await world();
const c7 = await w7.item('Beef', { tracked: true, cost: 420 });  // average 420
const d7 = await w7.dish('Beef dish'); await w7.recipe(d7, [[c7, 1]]);
await w7.batch(c7, 'BA', 3, 3, 400); await w7.batch(c7, 'BB', 5, 6, 450);
const o7 = await w7.place([{ itemId: d7, name: 'Beef dish', quantity: 5 }]); await w7.serve(o7);
eq((await w7.moves(o7)).map((r) => [r.batch, r.qty, r.unit_cost, r.value]), [['BA', '3.0000', '420.000000', '1260.00'], ['BB', '2.0000', '420.000000', '840.00']], 'average cost: 5 x 420 = 2100');
await w7.db.query(`insert into public.inventory_settings (business_id, key, value) values ($1, 'cost_method', '"batch"')`, [w7.biz]);
const o7b = await w7.place([{ itemId: d7, name: 'Beef dish', quantity: 3 }]); await w7.serve(o7b);
eq((await w7.moves(o7b)).map((r) => [r.batch, r.qty, r.unit_cost, r.value]), [['BB', '3.0000', '450.000000', '1350.00']], 'batch cost: BB at 450 (history untouched)');
eq((await w7.moves(o7)).map((r) => r.value), ['1260.00', '840.00'], 'earlier movements not re-costed');

section('S8 untracked item and untracked dish are unaffected; tracked + untracked in one order');
const w8 = await world();
const ch8 = await w8.item('Chicken', { tracked: true, cost: 430 }), bn8 = await w8.item('Buns', { tracked: false, cost: 10 });
const burger = await w8.dish('Burger'); await w8.recipe(burger, [[ch8, 2], [bn8, 1]]);
await w8.batch(ch8, 'P', 3, 2, 400); await w8.batch(ch8, 'Q', 10, 9, 410); await w8.plainStock(bn8, 5, 10);
const o8 = await w8.place([{ itemId: burger, name: 'Burger', quantity: 3 }]); await w8.serve(o8);
const m8 = await w8.q(`select si.name, coalesce(b.batch_no, '-') as batch, (-m.delta)::text as qty from public.stock_movements m join public.stock_items si on si.id = m.item_id left join public.batches b on b.id = m.batch_id where m.order_id = $1 order by si.name, m.id`, [o8]);
say(JSON.stringify(m8));
eq(m8, [{ name: 'Buns', batch: '-', qty: '3.0000' }, { name: 'Chicken', batch: 'P', qty: '3.0000' }, { name: 'Chicken', batch: 'Q', qty: '3.0000' }], '6 g chicken = 3 from P, 3 from Q; buns plain');
eq(await w8.invariants(), [], 'reconciliation clean');

section('S9 one order, two lines of the same tracked item: allocated line by line, no batch unit used twice');
const w9 = await world();
const c9 = await w9.item('Rice', { tracked: true, cost: 100 });
const dA = await w9.dish('Rice plate'), dB = await w9.dish('Rice bowl');
await w9.recipe(dA, [[c9, 3]]); await w9.recipe(dB, [[c9, 2]]);
await w9.batch(c9, 'R1', 5, 4, 100); await w9.batch(c9, 'R2', 5, 7, 100);
const o9 = await w9.place([{ itemId: dA, name: 'Rice plate', quantity: 2 }, { itemId: dB, name: 'Rice bowl', quantity: 2 }]); // 6 + 4 = 10
await w9.serve(o9);
const m9 = await w9.moves(o9);
say(JSON.stringify(m9.map((r) => [r.batch, r.qty])));
eq(m9.reduce((s, r) => s + Number(r.qty), 0), 10, 'all 10 taken');
eq(await w9.balances(c9), [{ batch_no: 'R1', on_hand: '0.0000' }, { batch_no: 'R2', on_hand: '0.0000' }], 'both batches exactly empty');
eq(await w9.invariants(), [], 'reconciliation clean');
ok((await w9.attempt(w9.place([{ itemId: dB, name: 'Rice bowl', quantity: 1 }])))?.hint === 'stock_sold_out', 'nothing left');

section('S9b availability: an expired-only dish shows sold out in stock_menu_availability');
const w9b = await world();
const c9b = await w9b.item('Fish', { tracked: true, cost: 100 });
const d9b = await w9b.dish('Fish dish'); await w9b.recipe(d9b, [[c9b, 2]]);
const f1 = await w9b.batch(c9b, 'F1', 6, 2, 100);
const av = () => w9b.one(`select available::text as available, sold_out from public.stock_menu_availability($1) where menu_item_id = $2`, [w9b.branchId, d9b]);
eq(await av(), { available: '6.0000', sold_out: false }, 'fresh stock: available 6');
await w9b.db.query(`update public.batches set expiry_date = (now() at time zone 'Africa/Nairobi')::date - 1 where id = $1`, [f1]);
eq(await av(), { available: '0.0000', sold_out: true }, 'expired: available 0 (on hand is still 6), sold out');

section('S10 regression drill: 60 random orders, untracked items, 013 function vs the spike function -> identical movements');
async function randomRun(spike) {
  const x = await world(spike);
  const items = [await x.item('I1', { cost: 5 }), await x.item('I2', { cost: 7 }), await x.item('I3', { cost: 11 })];
  const dishes = [];
  for (let d = 0; d < 4; d++) { const m = await x.dish('D' + d); await x.recipe(m, [[items[d % 3], 2 + d], [items[(d + 1) % 3], 1]], { allow: d === 3 }); dishes.push(m); }
  for (const i of items) await x.plainStock(i, 100, 5);
  let s = 12345; const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const trace = [];
  for (let k = 0; k < 60; k++) {
    const lines = [{ itemId: dishes[rnd(4)], name: 'x', quantity: 1 + rnd(3) }];
    const e = await x.attempt(x.place(lines));
    if (e) { trace.push('refused:' + e.hint); continue; }
    const o = (await x.one(`select id from public.orders where restaurant_id = $1 order by created_at desc, id desc limit 1`, [x.branchId])).id;
    await x.serve(o);
    trace.push((await x.q(`select item_id, delta::text, balance_after::text, unit_cost::text, value::text from public.stock_movements where order_id = $1 order by id`, [o])).map((r) => `${items.indexOf(r.item_id)}:${r.delta}:${r.balance_after}:${r.unit_cost}:${r.value}`).sort().join('|'));
  }
  const ex = (await x.q(`select count(*)::int n, coalesce(sum(short_qty), 0)::text s from public.stock_exceptions`))[0];
  return { trace, ex, end: await Promise.all(items.map((i) => x.onHand(i))) };
}
const old = await randomRun(false), neu = await randomRun(true);
say(`refused ${old.trace.filter((t) => t.startsWith('refused')).length} of 60; exceptions ${JSON.stringify(old.ex)}; end ${old.end}`);
const firstDiff = old.trace.findIndex((t, i) => t !== neu.trace[i]);
if (firstDiff >= 0) say(`first difference at order ${firstDiff}: old=${old.trace[firstDiff]} new=${neu.trace[firstDiff]}`);
eq(neu, old, 'identical movement-by-movement');

say(`\n${checks} checks passed`);
