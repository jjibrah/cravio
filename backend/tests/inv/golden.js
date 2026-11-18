// The golden dataset loader (P3-02): ONE deterministic week for two branches and the Warehouse, built through the real ledger, the real
// order triggers and the real recipe snapshot, then compared with figures worked out independently by hand
// (docs/inventory-kb/golden-dataset.md; the numbers live in golden-data.js as EXPECTED).
//
//   import { loadGolden, SPEC, EXPECTED } from './golden.js';
//   const g = await loadGolden();            // { db, ids, users, helpers, spec, expected, itemIds, locIds, dishIds, orderIds, counts, clock, stats }
//
// Later tickets assert their outputs against EXPECTED: valuation (P3-23), variance (P3-24), menu engineering (P3-25), reports (P3-26),
// AI fact builders (P3-40). Nothing here touches the shared database: it is PGlite, in memory.
//
// What is real and what is shortcut (so nobody is surprised):
//   real       ledger.post for opening / receipts / transfers / wastage / staff meals / complimentaries / count corrections; the 013
//              snapshot and serve trigger for every order; stock_items.avg_cost maintained by the ledger.
//   shortcut   the Phase 3 services do not exist yet, so wastage, staff meals and count corrections are posted straight to the ledger with the
//              reasons they will use (`wastage`, `staff_meal`, `complimentary`, `count_correction`); transfers are a dispatch + a receipt at the
//              dispatch cost (the Phase 2 transfer service will do the same); orders are inserted as 'taken' then served with a back-dated
//              served_at, and the movements the serve trigger wrote are back-dated to that time (the append-only trigger is switched off for
//              that one statement; the database is disposable).
import { inventoryFixture } from './fixture.js';
import { makeItem, addStaff, fakeClock } from './helpers.js';
import { post } from '../../src/inventory/ledger.js';
import { SPEC, EXPECTED } from './golden-data.js';

export { SPEC, EXPECTED };

const plusMinutes = (iso, minutes) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

export async function loadGolden({ extra } = {}) {
  const f = await inventoryFixture(extra === undefined ? undefined : { extra });
  const { db, ids, users, helpers } = f;
  const started = performance.now();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const one = async (sql, p) => (await q(sql, p))[0];

  // ---- business, branches, people -------------------------------------------------------------------------------------------------
  await db.query('update public.businesses set inventory_enabled = true where id = $1', [ids.businessId]);
  await db.query('update public.restaurants set name = $2 where id = $1', [ids.branchId, SPEC.locations.A]);
  const branchB = await helpers.addBranch(SPEC.locations.B);
  const locIds = { W: ids.centerLocationId, A: ids.branchLocationId, B: branchB.locationId };
  const restaurantIds = { A: ids.branchId, B: branchB.restaurantId };
  const counters = {
    A: await addStaff(db, f, { restaurantId: ids.branchId, role: 'manager', n: 2, prefix: 'counterA' }),
    B: await addStaff(db, f, { restaurantId: branchB.restaurantId, role: 'manager', n: 2, prefix: 'counterB' }),
  };
  const servers = { A: users.waiter, B: (await addStaff(db, f, { restaurantId: branchB.restaurantId, role: 'waiter', n: 1, prefix: 'waiterB' }))[0].userId };

  // ---- items, dishes, recipes -----------------------------------------------------------------------------------------------------
  const itemIds = {};
  for (const it of SPEC.items) {
    itemIds[it.key] = await makeItem(db, ids.businessId, it.name, { unit: it.unit, displayUnit: it.unit === 'g' ? 'kg' : it.unit === 'ml' ? 'l' : 'piece', yieldPct: it.yieldPct === '100' ? null : it.yieldPct });
  }
  const dishIds = { A: {}, B: {} };
  for (const b of ['A', 'B']) {
    const categoryId = (await one(`insert into public.menu_categories (restaurant_id, name) values ($1, 'Golden menu') returning id`, [restaurantIds[b]])).id;
    for (const d of SPEC.dishes) {
      const dishId = (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, $4) returning id`, [restaurantIds[b], categoryId, d.name, d.price])).id;
      dishIds[b][d.key] = dishId;
      const recipeId = (await one(`insert into public.recipes (business_id, restaurant_id, menu_item_id) values ($1, $2, $3) returning id`, [ids.businessId, restaurantIds[b], dishId])).id;
      const versionId = (await one(`insert into public.recipe_versions (business_id, recipe_id, version, created_by) values ($1, $2, 1, $3) returning id`, [ids.businessId, recipeId, users.manager])).id;
      for (const [position, [itemKey, qty]] of d.lines.entries()) {
        await db.query(`insert into public.recipe_lines (business_id, version_id, item_id, position, qty_base) values ($1, $2, $3, $4, $5)`, [ids.businessId, versionId, itemIds[itemKey], position, qty]);
      }
      await db.query('update public.recipes set current_version_id = $2 where id = $1', [recipeId, versionId]);
    }
  }
  const dishByKey = Object.fromEntries(SPEC.dishes.map((d) => [d.key, d]));

  // ---- the ledger: every movement through ledger.post, in time order --------------------------------------------------------------
  let seq = 0;
  const key = () => `golden-${++seq}`;
  const posted = (input) => db.transaction((t) => post(t, { businessId: ids.businessId, idempotencyKey: key(), ...input }));
  const orderIds = [];
  /** What `portions` of a dish need of each ingredient, yield applied, 4 dp: the same expression as 013 private.dish_stock_lines. */
  const expand = async (dishKey, portions) => Promise.all(dishByKey[dishKey].lines.map(([item, qty]) => one(
    `select id as item_id, round($2::numeric * $3::numeric / (yield_pct / 100), 4)::text as qty from public.stock_items where id = $1`, [itemIds[item], qty, portions])));

  for (const it of SPEC.items) {
    for (const l of ['W', 'A', 'B']) {
      await posted({ locationId: locIds[l], itemId: itemIds[it.key], qty: SPEC.opening[it.key][l], reason: 'opening', unitCost: it.openingCost, occurredAt: SPEC.openingAt });
    }
  }
  for (const e of SPEC.events) {
    if (e.kind === 'receipt') {
      for (const [item, qty, cost] of e.lines) await posted({ locationId: locIds[e.loc], itemId: itemIds[item], qty, reason: 'purchase_receipt', unitCost: cost, occurredAt: e.at });
    } else if (e.kind === 'transfer') {
      for (const [item, qty] of e.lines) {
        const out = await posted({ locationId: locIds[e.from_], itemId: itemIds[item], qty: `-${qty}`, reason: 'transfer_dispatch', counterpartyLocationId: locIds[e.to], occurredAt: e.at });
        await posted({ locationId: locIds[e.to], itemId: itemIds[item], qty, reason: 'transfer_receipt', unitCost: out.movement.unitCost, counterpartyLocationId: locIds[e.from_], occurredAt: plusMinutes(e.at, 30) });
      }
    } else if (e.kind === 'wastage') {
      await posted({ locationId: locIds[e.loc], itemId: itemIds[e.item], qty: `-${e.qty}`, reason: 'wastage', occurredAt: e.at });
    } else if (e.kind === 'staff_meal' || e.kind === 'complimentary') {
      for (const line of await expand(e.dish, e.portions)) await posted({ locationId: locIds[e.loc], itemId: line.item_id, qty: `-${line.qty}`, reason: e.kind, occurredAt: e.at });
    } else if (e.kind === 'orders') {
      const b = e.loc;
      const orderId = (await one(`insert into public.orders (restaurant_id, status, taken_by, taken_at, created_at) values ($1, 'taken', $2, $3, $3) returning id`, [restaurantIds[b], servers[b], e.at])).id;
      const lines = Object.entries(e.lines).map(([dish, n]) => ({ itemId: dishIds[b][dish], name: dishByKey[dish].name, unitPrice: dishByKey[dish].price, quantity: n }));
      await db.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, kind)
        select $1, $2, (l->>'itemId')::uuid, l->>'name', (l->>'unitPrice')::numeric, (l->>'quantity')::int, (l->>'unitPrice')::numeric * (l->>'quantity')::int, 'item'
        from jsonb_array_elements($3::jsonb) l`, [orderId, restaurantIds[b], JSON.stringify(lines)]);
      const total = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
      await db.query(`update public.orders set subtotal = $2, total = $2 where id = $1`, [orderId, total]);
      await db.query(`update public.orders set status = 'served', accepted_by = $2, accepted_at = $3, served_by = $2, served_at = $3 where id = $1`, [orderId, servers[b], e.at]);
      orderIds.push(orderId);
    }
  }
  // Closing count (Sun 23:00): physical = what the system says, rounded to whole units, minus the planned shortfall. One correction per difference.
  const counts = { opening: {}, closing: {} };
  for (const [loc, item] of Object.keys(EXPECTED.rows).map((k) => k.split('.'))) counts.opening[`${loc}.${item}`] = SPEC.opening[item][loc];
  for (const l of ['W', 'A', 'B']) {
    for (const it of SPEC.items) {
      const row = await one(`select on_hand::text as on_hand, round(on_hand, 0)::text as whole from public.stock_balances where location_id = $1 and item_id = $2`, [locIds[l], itemIds[it.key]]);
      const loss = Number(SPEC.closingCountLoss[`${l}.${it.key}`] || 0);
      const physical = Math.max(Number(row.whole) - loss, 0);
      counts.closing[`${l}.${it.key}`] = String(physical);
      const delta = (BigInt(physical) * 10000n) - BigInt(row.on_hand.replace('.', ''));
      if (delta === 0n) continue;
      const text = `${delta < 0n ? '-' : ''}${(delta < 0n ? -delta : delta).toString().padStart(5, '0').replace(/(\d{4})$/, '.$1')}`;
      const avg = (await one('select avg_cost::text as c from public.stock_items where id = $1', [itemIds[it.key]])).c;
      // A found surplus carries the average cost too, so valuation never sees a cost-less movement (note for P3-08).
      await posted({ locationId: locIds[l], itemId: itemIds[it.key], qty: text, reason: 'count_correction', unitCost: delta > 0n ? avg : undefined, ref: { type: 'stock_count', id: null }, occurredAt: SPEC.closingCountAt });
    }
  }
  // Date the movements the serve trigger wrote at the time of the order (append-only trigger off for this one statement).
  await db.query('alter table public.stock_movements disable trigger stock_movements_no_change');
  await db.query(`update public.stock_movements m set occurred_at = o.served_at, created_at = o.served_at from public.orders o where m.order_id = o.id and m.reason = 'served'`);
  await db.query('alter table public.stock_movements enable trigger stock_movements_no_change');

  const stats = { buildMs: Math.round(performance.now() - started), movements: (await one('select count(*)::int as n from public.stock_movements')).n, orders: orderIds.length };
  return { ...f, branchB, restaurantIds, locIds, itemIds, dishIds, orderIds, counters, servers, counts, spec: SPEC, expected: EXPECTED, clock: fakeClock(SPEC.closingCountAt), stats };
}
