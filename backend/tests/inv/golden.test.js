// P3-02: the golden dataset (backend/tests/inv/golden.js) is built through the real ledger and order triggers, and every figure the code can
// already produce is compared with the figures worked out independently by hand (golden-data.js EXPECTED, written up in
// docs/inventory-kb/golden-dataset.md). Later report / insight tickets assert against the same figures.
// Also covers the Phase 3 harness helpers (makePrepared, addStaff, postAt, makeBatch before migration 022) and DOC SYNC: every headline
// figure must appear in the document.
// Usage: node backend/tests/inv/golden.test.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadGolden, SPEC, EXPECTED } from './golden.js';
import { makeAsserts, makeBatch, makePrepared, postAt } from './helpers.js';
import { reconcile, balance } from '../../src/inventory/ledger.js';
import { computeCost } from '../../src/inventory/recipes.js';

const { eq, ok, count } = makeAsserts();
/** "29642.8570" and "29642.857" and "29642.857000" are the same quantity. */
const norm = (v) => { const s = String(v); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
const same = (actual, expected, m) => eq(norm(actual), norm(expected), `${m}: ${actual} vs ${expected}`);
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const g = await loadGolden();
const { db, itemIds, locIds, restaurantIds, ids } = g;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
console.log(`golden dataset: ${g.stats.movements} movements, ${g.stats.orders} orders, built in ${g.stats.buildMs} ms (after the schema)`);
ok(g.stats.buildMs < 2000, `the dataset loads in under 2 s on PGlite (took ${g.stats.buildMs} ms)`);
eq(g.stats.movements, EXPECTED.movements, 'movement count');
eq(g.stats.orders, 14, '14 orders: 7 days x 2 branches');

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Ledger sums per location and item against the hand-worked table (opening, purchases, transfers, consumption, waste, count, closing)
// ---------------------------------------------------------------------------------------------------------------------------------
const sums = {};
for (const r of await q(`select location_id, item_id, reason, sum(delta)::text as total from public.stock_movements group by 1, 2, 3`)) {
  sums[`${r.location_id}.${r.item_id}.${r.reason}`] = r.total;
}
const sumOf = (loc, item, reason) => sums[`${locIds[loc]}.${itemIds[item]}.${reason}`] ?? '0';
const neg = (v) => (v === '0' ? '0' : v.startsWith('-') ? v.slice(1) : `-${v}`);
for (const [key, e] of Object.entries(EXPECTED.rows)) {
  const [loc, item] = key.split('.');
  same(sumOf(loc, item, 'opening'), e.opening, `${key} opening`);
  same(sumOf(loc, item, 'purchase_receipt'), e.purchases, `${key} purchases`);
  same(sumOf(loc, item, 'transfer_receipt'), e.transfer_in, `${key} transfers in`);
  same(neg(sumOf(loc, item, 'transfer_dispatch')), e.transfer_out, `${key} transfers out`);
  same(neg(sumOf(loc, item, 'served')), e.served, `${key} consumed by orders (theoretical)`);
  same(neg(sumOf(loc, item, 'wastage')), e.wastage, `${key} wastage`);
  same(neg(sumOf(loc, item, 'staff_meal')), e.staff_meal, `${key} staff meals`);
  same(neg(sumOf(loc, item, 'complimentary')), e.complimentary, `${key} complimentaries`);
  same(sumOf(loc, item, 'count_correction'), e.correction, `${key} count correction`);
  same(g.counts.closing[key], e.counted, `${key} counted`);
  const onHand = (await one('select on_hand::text as v from public.stock_balances where location_id = $1 and item_id = $2', [locIds[loc], itemIds[item]])).v;
  same(onHand, e.closing, `${key} on hand after the count`);
  same(onHand, e.counted, `${key} on hand = counted`);
}
eq(await reconcile(db, { businessId: ids.businessId }), [], 'the ledger agrees with every balance');

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Actual use and variance by the D3-9 formula, from ledger sums and the two counts (opening count = the opening, closing count = counted)
//    actual = opening + receipts + transfers in - transfers out - wastage - staff meals - complimentaries - closing count
//    variance = actual - theoretical (what the orders' recipes needed); a positive number = used more than the recipes explain
// ---------------------------------------------------------------------------------------------------------------------------------
const cents = (v) => Math.round(Number(v) * 10000);       // quantities have at most 4 dp: integers of 1/10000 are exact in a double here
const back = (n) => (n / 10000).toFixed(4);
const avgNow = Object.fromEntries((await q('select id, avg_cost::text as c from public.stock_items where business_id = $1', [ids.businessId])).map((r) => [r.id, r.c]));
let kesByBranch = { A: 0, B: 0 };
for (const loc of ['A', 'B']) {
  for (const it of SPEC.items) {
    const key = `${loc}.${it.key}`; const e = EXPECTED.rows[key];
    const actual = cents(sumOf(loc, it.key, 'opening')) + cents(sumOf(loc, it.key, 'purchase_receipt')) + cents(sumOf(loc, it.key, 'transfer_receipt'))
      + cents(sumOf(loc, it.key, 'transfer_dispatch')) + cents(sumOf(loc, it.key, 'wastage')) + cents(sumOf(loc, it.key, 'staff_meal'))
      + cents(sumOf(loc, it.key, 'complimentary')) - cents(g.counts.closing[key]) * 1;
    // transfer_dispatch/wastage/staff_meal/complimentary sums are negative, so adding them subtracts them
    same(back(actual), e.actual, `${key} actual use`);
    const theoretical = -cents(sumOf(loc, it.key, 'served'));
    same(back(actual - theoretical), e.variance, `${key} variance (actual - theoretical)`);
    // the correction the count posted is exactly minus the variance
    same(back(-cents(sumOf(loc, it.key, 'count_correction'))), e.variance, `${key} variance = minus the count correction`);
    same(EXPECTED.varianceKes[key], (Math.round(Number(e.variance) * Number(avgNow[itemIds[it.key]]) * 100) / 100).toFixed(2), `${key} variance in KES at the average cost (half-up on a hand figure)`);
    kesByBranch[loc] += Number(EXPECTED.varianceKes[key]);
  }
  same(kesByBranch[loc].toFixed(2), EXPECTED.varianceKesTotal[loc], `${loc} total variance KES`);
  same((await one(`select (-coalesce(sum(value), 0))::text as v from public.stock_movements where location_id = $1 and reason = 'count_correction'`, [locIds[loc]])).v, EXPECTED.varianceKesTotal[loc], `${loc} value of the count corrections = variance KES`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Theoretical consumption two ways: the order snapshot (order_stock_lines of served orders) and the ledger (served movements) agree
// ---------------------------------------------------------------------------------------------------------------------------------
for (const loc of ['A', 'B']) {
  const rows = await q(`select s.item_id, sum(s.qty_base)::text as qty from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id join public.orders o on o.id = oi.order_id
    where o.restaurant_id = $1 and o.status = 'served' group by s.item_id`, [restaurantIds[loc]]);
  const snap = Object.fromEntries(rows.map((r) => [r.item_id, r.qty]));
  for (const it of SPEC.items) same(snap[itemIds[it.key]] ?? '0', EXPECTED.rows[`${loc}.${it.key}`].served, `${loc} ${it.key} snapshot = served movements`);
  const served = await q(`select count(*)::int as n from public.stock_movements where location_id = $1 and reason = 'served'`, [locIds[loc]]);
  eq(served[0].n, EXPECTED.servedMovements[loc], `${loc} number of serve movements`);
}
eq((await one(`select count(*)::int as n from public.stock_exceptions`)).n, 0, 'no sale was ever short: no stock exceptions');

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Weighted average cost: end of week, and as it moves day by day (the unit cost the serve trigger used that day)
// ---------------------------------------------------------------------------------------------------------------------------------
for (const it of SPEC.items) same(avgNow[itemIds[it.key]], EXPECTED.avgCostEnd[it.key], `${it.key} average cost at the end of the week`);
const byDay = await q(`select m.item_id, (m.occurred_at at time zone 'Africa/Nairobi')::date::text as day, min(m.unit_cost)::text as lo, max(m.unit_cost)::text as hi
  from public.stock_movements m where m.reason = 'served' group by 1, 2`);
for (const r of byDay) {
  const item = SPEC.items.find((i) => itemIds[i.key] === r.item_id).key;
  same(r.lo, EXPECTED.servedUnitCostByDay[item][r.day], `${item} ${r.day} cost (low)`);
  same(r.hi, EXPECTED.servedUnitCostByDay[item][r.day], `${item} ${r.day} cost (high): one cost per day, no receipt happens between serves`);
}
eq((await one(`select count(*)::int as n from public.stock_movements where value is null`)).n, EXPECTED.costlessMovements, 'no movement without a cost');

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Money: sales, food cost (served consumption at the average cost of the day), gross profit after food cost, per branch
// ---------------------------------------------------------------------------------------------------------------------------------
for (const loc of ['A', 'B']) {
  const rev = (await one(`select coalesce(sum(oi.line_total), 0)::text as v from public.order_items oi join public.orders o on o.id = oi.order_id where o.restaurant_id = $1 and o.status = 'served'`, [restaurantIds[loc]])).v;
  same(rev, EXPECTED.revenue[loc], `${loc} sales`);
  same((await one(`select sum(total)::text as v from public.orders where restaurant_id = $1`, [restaurantIds[loc]])).v, EXPECTED.revenue[loc], `${loc} order totals agree with the lines`);
  for (const [day, amount] of Object.entries(EXPECTED.revenueByDay[loc])) {
    same((await one(`select sum(total)::text as v from public.orders where restaurant_id = $1 and (served_at at time zone 'Africa/Nairobi')::date = $2::date`, [restaurantIds[loc], day])).v, amount, `${loc} sales on ${day}`);
  }
  const food = (await one(`select (-sum(value))::text as v from public.stock_movements where location_id = $1 and reason = 'served'`, [locIds[loc]])).v;
  same(food, EXPECTED.foodCost[loc], `${loc} food cost`);
  const gp = (Number(rev) * 100 - Math.round(Number(food) * 100)) / 100;
  same(gp.toFixed(2), EXPECTED.grossProfit[loc], `${loc} gross profit after food cost`);
  same(((gp * 100) / Number(rev)).toFixed(1), EXPECTED.grossProfitPct[loc], `${loc} gross profit %`);
  for (const [dish, n] of Object.entries(EXPECTED.unitsSold[loc])) {
    same((await one(`select coalesce(sum(oi.quantity), 0)::text as v from public.order_items oi join public.orders o on o.id = oi.order_id where o.restaurant_id = $1 and oi.item_id = $2`, [restaurantIds[loc], g.dishIds[loc][dish]])).v, n, `${loc} ${dish} units sold`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Dish food cost at the end-of-week average (recipes.computeCost: exact sum, rounded once) and food cost %
// ---------------------------------------------------------------------------------------------------------------------------------
for (const d of SPEC.dishes) {
  const lines = (await q(`select rl.qty_base::text as qty, i.name, i.yield_pct::text as y, i.avg_cost::text as c from public.recipes r join public.recipe_lines rl on rl.version_id = r.current_version_id
    join public.stock_items i on i.id = rl.item_id where r.menu_item_id = $1`, [g.dishIds.A[d.key]])).map((r) => ({ name: r.name, qtyBase: r.qty, yieldPct: r.y, avgCost: r.c }));
  const out = computeCost(lines, d.price);
  same(out.cost, EXPECTED.dishCost[d.key].cost, `${d.name} food cost`);
  same(out.costPct, EXPECTED.dishCost[d.key].costPct, `${d.name} food cost %`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. Inventory valuation: the sum of signed movement values up to the end of a day (D3-8), and the on-hand x average cross-check
// ---------------------------------------------------------------------------------------------------------------------------------
const asOf = async (day, loc = null) => (await one(`select coalesce(sum(value), 0)::text as v from public.stock_movements
  where (occurred_at at time zone 'Africa/Nairobi')::date <= $1::date and ($2::uuid is null or location_id = $2)`, [day, loc ? locIds[loc] : null])).v;
for (const [day, v] of Object.entries(EXPECTED.valuationAsOf)) same(await asOf(day), v, `valuation at the end of ${day}`);
same(await asOf('2026-11-08'), EXPECTED.valuationTotalEnd, 'valuation at the end of the week (after the count)');
for (const loc of ['W', 'A', 'B']) same(await asOf('2026-11-08', loc), EXPECTED.valuationByLocationEnd[loc], `${loc} valuation`);
same((await one(`select coalesce(sum(value), 0)::text as v from public.stock_movements where reason <> 'count_correction'`)).v, EXPECTED.valuationBeforeCount, 'valuation before the closing count');
same((await one(`select round(sum(b.on_hand * i.avg_cost), 2)::text as v from public.stock_balances b join public.stock_items i on i.id = b.item_id`)).v, EXPECTED.onHandTimesAvgTotalEnd, 'on hand x average cost');
const gap = Math.abs(Number(EXPECTED.onHandTimesAvgTotalEnd) - Number(EXPECTED.valuationTotalEnd));
ok(gap > 0 && gap < 0.1, `the two valuations differ only by per-movement rounding (KES ${gap.toFixed(2)}); P3-23 must document that difference`);

// ---------------------------------------------------------------------------------------------------------------------------------
// 8. Determinism: a second build gives the identical ledger (same quantities, costs, values, dates in the same order)
// ---------------------------------------------------------------------------------------------------------------------------------
const second = await loadGolden();
// Locations carry random ids, so the ledger is compared by location NAME, item name, reason and the figures, in a stable order.
// balance_after is left out: two order lines that use the same ingredient are served in an order that follows random uuids, which swaps the
// running balance between those two movements (their quantities, costs and values do not change).
const byName = async (d) => createHash('sha256').update(JSON.stringify((await d.query(`select case when x.kind = 'center' then 'Warehouse' else r.name end as loc, i.name as item, m.reason, m.delta::text as delta,
    m.unit_cost::text as cost, m.value::text as value, to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as at
  from public.stock_movements m join public.stock_items i on i.id = m.item_id join public.stock_locations x on x.id = m.location_id left join public.restaurants r on r.id = x.restaurant_id
  order by 1, 2, m.occurred_at, m.reason, m.delta, m.value`)).rows)).digest('hex');
eq(await byName(second.db), await byName(db), 'two builds produce the same ledger');

// ---------------------------------------------------------------------------------------------------------------------------------
// 9. Harness helpers
// ---------------------------------------------------------------------------------------------------------------------------------
const prepared = await makePrepared(db, ids.businessId, 'Bolognese sauce', { unit: 'ml', displayUnit: 'l' });
eq((await one('select kind from public.stock_items where id = $1', [prepared])).kind, 'prepared', 'makePrepared sets kind = prepared');
eq(g.counters.A.length, 2, 'two extra counters at Westlands');
ok(g.counters.B[0].ctx.memberships[0].restaurant.id === restaurantIds.B && g.counters.B[0].ctx.memberships[0].role === 'manager', 'counter contexts are ready for inventoryScope()');
const at = await postAt(db, '2026-11-09T08:00:00+03:00', { businessId: ids.businessId, locationId: locIds.W, itemId: itemIds.rice, qty: '100', reason: 'adjustment_gain', unitCost: EXPECTED.avgCostEnd.rice });
eq(new Date(at.movement.occurredAt).toISOString(), '2026-11-09T05:00:00.000Z', 'postAt dates the movement');
await postAt(db, g.clock, { businessId: ids.businessId, locationId: locIds.W, itemId: itemIds.rice, qty: '-100', reason: 'adjustment_loss' });
same((await balance(db, locIds.W, itemIds.rice)).onHand, EXPECTED.rows['W.rice'].closing, 'the test movements cancel out');
let early = null;
try { await makeBatch(db, { businessId: ids.businessId, locationId: locIds.W, itemId: itemIds.rice, batchNo: 'R1', qty: '10', expiryInDays: 3 }); } catch (e) { early = e; }
ok(early && /migration 022/.test(early.message), 'makeBatch says plainly that migration 022 is needed when it is not applied');
// ...and works once batches exist (the spike's schema stands in for 022 until P3-16 lands; revisit this block then).
{
  const { inventoryFixture } = await import('./fixture.js');
  const { ALL_INVENTORY_MIGRATIONS } = await import('./migrations.js');
  const spike = fileURLToPath(new URL('../../../docs/inventory-kb/spikes/fefo-serve/spike_022.sql', import.meta.url));
  const f = await inventoryFixture({ extra: [...ALL_INVENTORY_MIGRATIONS, spike] });
  const { makeItem } = await import('./helpers.js');
  const item = await makeItem(f.db, f.ids.businessId, 'Milk');
  const batchId = await makeBatch(f.db, { businessId: f.ids.businessId, locationId: f.ids.branchLocationId, itemId: item, batchNo: 'M1', qty: '5000', expiryInDays: 3, unitCost: '0.1' });
  const b = await f.db.query(`select b.batch_no, (b.expiry_date - (now() at time zone 'Africa/Nairobi')::date) as days, bb.on_hand::text as batch_on_hand, s.on_hand::text as on_hand
    from public.batches b join public.batch_balances bb on bb.batch_id = b.id join public.stock_balances s on s.item_id = b.item_id and s.location_id = bb.location_id where b.id = $1`, [batchId]);
  eq(b.rows[0], { batch_no: 'M1', days: 3, batch_on_hand: '5000.0000', on_hand: '5000.0000' }, 'makeBatch writes the batch, its balance and the stock balance');
  eq((await reconcile(f.db, { businessId: f.ids.businessId })), [], 'and the ledger still agrees');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 10. Doc sync: the headline figures are in docs/inventory-kb/golden-dataset.md (write the figures there when you change them here)
// ---------------------------------------------------------------------------------------------------------------------------------
const doc = readFileSync(new URL('../../../docs/inventory-kb/golden-dataset.md', import.meta.url), 'utf8');
const mustAppear = [
  EXPECTED.revenue.A, EXPECTED.revenue.B, EXPECTED.foodCost.A, EXPECTED.foodCost.B, EXPECTED.grossProfit.A, EXPECTED.grossProfit.B,
  EXPECTED.valuationAsOf['2026-11-02'], EXPECTED.valuationAsOf['2026-11-04'], EXPECTED.valuationTotalEnd, EXPECTED.onHandTimesAvgTotalEnd,
  EXPECTED.valuationByLocationEnd.W, EXPECTED.valuationByLocationEnd.A, EXPECTED.valuationByLocationEnd.B, EXPECTED.varianceKesTotal.A, EXPECTED.varianceKesTotal.B,
  ...Object.values(EXPECTED.dishCost).map((d) => d.cost),
].map((v) => fmt(v));
for (const text of mustAppear) ok(doc.includes(text), `golden-dataset.md shows ${text}`);
for (const [k, e] of Object.entries(EXPECTED.rows)) if (k.startsWith('A.')) ok(doc.includes(Number(e.served).toLocaleString('en-US', { maximumFractionDigits: 4 })), `golden-dataset.md shows the theoretical use ${k}: ${e.served}`);
for (const [item, cost] of Object.entries(EXPECTED.avgCostEnd)) ok(doc.includes(cost), `golden-dataset.md shows the end average cost of ${item}: ${cost}`);

console.log(`${count()} checks passed`);
