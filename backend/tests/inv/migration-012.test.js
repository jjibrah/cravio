// Migration 012 (proposed): rehearsal on PGlite. Seeds 009 data with main's own service functions, applies 012, and checks
// nothing changed, then exercises the new rules and the down migration.
// Usage: node backend/tests/inv/migration-012.test.js
import assert from 'node:assert/strict';
import { createUser, freshDatabase, readSql, asUser } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';
import { DEFAULT_UNITS } from '../../src/inventory/units.js';
import { adjust, createItem, dispatch, receive, reviewRequest, submitRequest, linkMenuItem, centerLocation, branchLocation } from '../../src/stock/service.js';

const UP = 'migrations/012_inventory_catalogue.sql';
const DOWN = 'proposed/012_inventory_catalogue.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(e.message, re, m); return true; }, m);
  checks++;
};

// ---------------------------------------------------------------------------------------------------------------
// 1. Rehearsal: 009 data first, then 012.
// ---------------------------------------------------------------------------------------------------------------
const { db, ids, users, helpers } = await inventoryFixture({ extra: [] });   // committed migrations only (through 010): the rehearsal starts here
const { one, tx } = helpers;
const west = (await one(`insert into public.restaurants (owner_id, name, business_id, owner_primary, status) values ($1, 'West', $2, false, 'live') returning id`, [users.owner, ids.businessId])).id;
const westLoc = await tx((t) => branchLocation(t, west));
const ctx = { businessId: ids.businessId, actorId: users.manager };
const branchCtx = { ...ctx, restaurantId: ids.branchId, locationId: ids.branchLocationId };
const westCtx = { ...ctx, restaurantId: west, locationId: westLoc };
const ownerCtx = { businessId: ids.businessId, actorId: users.owner };

const [buns, cola] = await tx(async (t) => [await createItem(t, ctx, { name: 'Buns', lowLevel: 12.5 }), await createItem(t, ctx, { name: 'Cola' })]);
await tx((t) => linkMenuItem(t, branchCtx, ids.burgerId, { itemId: buns.id, servings: 1 }));
await tx((t) => adjust(t, { ...ctx, locationId: ids.centerLocationId }, { kind: 'count', itemId: buns.id, quantity: 100.125 }));
await tx((t) => adjust(t, branchCtx, { kind: 'count', itemId: buns.id, quantity: 10 }));
await tx((t) => adjust(t, branchCtx, { kind: 'waste', itemId: buns.id, quantity: 0.5, note: 'dropped' }));
await tx((t) => adjust(t, { ...ctx, locationId: ids.centerLocationId }, { kind: 'count', itemId: cola.id, quantity: 40 }));
const served = await helpers.order([{ itemId: ids.burgerId, name: 'Chicken burger', quantity: 2 }]);
await db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [served, users.waiter]);
const req = await tx((t) => submitRequest(t, westCtx, { lines: [{ itemId: buns.id, quantity: 20 }, { itemId: cola.id, quantity: 6 }], note: 'Weekend' }));
await tx((t) => reviewRequest(t, ownerCtx, req.id, { decision: 'approve', lines: [{ itemId: buns.id, approved: 15 }, { itemId: cola.id, approved: 6 }] }));
const transfer = await tx((t) => dispatch(t, ownerCtx, { requestId: req.id }));
await tx((t) => receive(t, { ...westCtx }, transfer.id, { lines: [{ itemId: buns.id, received: 14 }, { itemId: cola.id, received: 6 }], note: 'one bun squashed' }));

const TABLES = ['stock_items', 'stock_locations', 'stock_balances', 'menu_item_stock', 'stock_requests', 'stock_request_lines',
  'stock_transfers', 'stock_transfer_lines', 'stock_movements', 'order_stock_effects', 'stock_commands'];
const snapshot = async () => {
  const out = {};
  for (const t of TABLES) out[t] = Number((await one(`select count(*) as n from public.${t}`)).n);
  return out;
};
const dump = async () => ({
  balances: (await db.query(`select location_id, item_id, on_hand::text from public.stock_balances order by 1, 2`)).rows,
  movements: (await db.query(`select id::text, location_id, item_id, delta::text, balance_after::text, reason, note, order_id, transfer_id, created_at from public.stock_movements order by id`)).rows,
  lines: (await db.query(`select request_id, item_id, requested::text, approved::text from public.stock_request_lines order by 1, 2`)).rows,
  tlines: (await db.query(`select transfer_id, item_id, quantity::text, received::text from public.stock_transfer_lines order by 1, 2`)).rows,
  effects: (await db.query(`select order_item_id, item_id, quantity::text from public.order_stock_effects order by 1, 2`)).rows,
  items: (await db.query(`select id, name, unit, low_level::text, active from public.stock_items order by name`)).rows,
  locations: (await db.query(`select id, kind, restaurant_id, name from public.stock_locations order by id`)).rows,
});
const before = { counts: await snapshot(), data: await dump() };
assert.ok(before.counts.stock_movements >= 8 && before.counts.stock_transfers === 1 && before.counts.order_stock_effects === 1, 'seed looks right');
const movedAt = (await one(`select min(created_at) as t from public.stock_movements`)).t;

await db.exec(readSql(UP));
eq(await snapshot(), before.counts, 'row counts identical after 012');
const after = await dump();
// Values are text-compared, so 100.125 becomes 100.1250: compare numerically.
const norm = (rows) => JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'string' && /^-?\d+\.\d+$/.test(v) ? Number(v) : v)));
eq(norm(after), norm(before.data), 'every quantity and row preserved (values equal; scale widened)');
eq((await one(`select kind from public.stock_locations where id = $1`, [ids.centerLocationId])).kind, 'center', 'center untouched');
eq((await one(`select unit, kind, yield_pct::int as y, vat_class, sku, archived_at is null as live, low_level::text as low from public.stock_items where id = $1`, [buns.id])),
  { unit: 'serving', kind: 'raw', y: 100, vat_class: 'standard', sku: null, live: true, low: '12.5000' }, 'items get defaults; low_level kept as the org default');
eq(Number((await one(`select count(*) as n from public.stock_item_levels`)).n), 0, 'levels start empty');
eq((await one(`select occurred_at = created_at as same from public.stock_movements order by id limit 1`)).same, true, 'existing movements: occurred_at = created_at (not the migration time)');
eq((await one(`select min(created_at) as t from public.stock_movements`)).t, movedAt, 'created_at untouched');
eq((await one(`select count(*)::int as n from public.stock_movements where occurred_at is null`)).n, 0, 'no null occurred_at');
eq((await one(`select reserved::text as r from public.stock_balances limit 1`)).r, '0.0000', 'reserved defaults to 0');
eq((await one(`select inventory_enabled from public.businesses where id = $1`, [ids.businessId])).inventory_enabled, false, 'inventory off by default');

// Re-running is a no-op.
await db.exec(readSql(UP));
eq(await snapshot(), before.counts, 'second run changes nothing');
eq((await one(`select count(*)::int as n from public.units`)).n, DEFAULT_UNITS.length, 'units not duplicated on re-run');

// units seeded = DEFAULT_UNITS exactly
const seeded = (await db.query(`select code, dimension, to_base::text, label, plural from public.units order by position`)).rows;
eq(seeded.map((r) => ({ code: r.code, dimension: r.dimension, toBase: Number(r.to_base), label: r.label, plural: r.plural })),
  DEFAULT_UNITS.map((u) => ({ code: u.code, dimension: u.dimension, toBase: Number(u.toBase), label: u.label, plural: u.plural })), 'units seeded from DEFAULT_UNITS');

// ---------------------------------------------------------------------------------------------------------------
// 2. New rules on a database with 012 applied.
// ---------------------------------------------------------------------------------------------------------------
const item = async (name, extra = '') => (await one(`insert into public.stock_items (business_id, name, unit) values ($1, $2, 'g') returning id`, [ids.businessId, name])).id;
const move = (itemId, reason, delta, more = {}) => db.query(
  `insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, idempotency_key, entered_quantity, entered_unit, unit_cost, value, ref_type)
   values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11)`,
  [ids.businessId, ids.centerLocationId, itemId, delta, reason, more.key ?? null, more.entered ?? null, more.unit ?? null, more.cost ?? null, more.value ?? null, more.ref ?? null]);

// base unit widened; invalid unit still refused
const flour = await item('Flour');
await fails(db.query(`insert into public.stock_items (business_id, name, unit) values ($1, 'Bad', 'kg')`, [ids.businessId]), /stock_items_unit_check/, 'kg is not a base unit');
for (const u of ['serving', 'piece', 'g', 'ml']) await db.query(`insert into public.stock_items (business_id, name, unit) values ($1, $2, $3)`, [ids.businessId, `Unit ${u}`, u]);
checks++;

// unit immutable once a movement exists
await db.query(`update public.stock_items set unit = 'ml' where id = $1`, [flour]);
await db.query(`update public.stock_items set unit = 'g' where id = $1`, [flour]);
checks++;
await move(flour, 'opening', 5000, { entered: 5, unit: 'kg', cost: 0.002, value: 10, ref: 'opening' });
await fails(db.query(`update public.stock_items set unit = 'ml' where id = $1`, [flour]), /can.t change because it already has stock history/, 'unit locked after first movement');
try { await db.query(`update public.stock_items set unit = 'ml' where id = $1`, [flour]); } catch (e) { eq(e.code, '23514', 'errcode check_violation'); }
await db.query(`update public.stock_items set name = 'Flour (plain)', unit = 'g' where id = $1`, [flour]);
checks++;
eq((await one(`select entered_quantity::text as q, entered_unit as u, unit_cost::text as c, value::text as v from public.stock_movements where item_id = $1`, [flour])),
  { q: '5.0000', u: 'kg', c: '0.002000', v: '10.00' }, 'new ledger columns stored');
eq((await one(`select updated_at > created_at as bumped from public.stock_items where id = $1`, [flour])).bumped, true, 'updated_at bumps on update');

// superset reasons
const NEW_REASONS = ['opening', 'purchase_receipt', 'emergency_receipt', 'supplier_return', 'transfer_dispatch', 'transfer_receipt', 'transfer_discrepancy',
  'transfer_cancelled', 'pos_consumption', 'production_input', 'production_output', 'wastage', 'adjustment_gain', 'adjustment_loss', 'count_correction',
  'staff_meal', 'complimentary', 'reversal'];
const rice = await item('Rice');
for (const r of NEW_REASONS) await move(rice, r, 1);
for (const r of ['count', 'added', 'waste', 'served', 'order_correction', 'dispatched', 'received', 'lost_in_transit', 'dispatch_cancelled']) await move(rice, r, 1);
checks += 2;
await fails(move(rice, 'bogus', 1), /stock_movements_reason_check/, 'unknown reason refused');

// idempotency
await move(rice, 'purchase_receipt', 3, { key: 'k-1' });
await fails(move(rice, 'purchase_receipt', 3, { key: 'k-1' }), /stock_movements_idempotency/, 'same key + reason refused');
await move(rice, 'adjustment_gain', 3, { key: 'k-1' });
await move(rice, 'adjustment_gain', 3);
await move(rice, 'adjustment_gain', 3);
checks += 3;

// append-only still holds on movements and events
await fails(db.query(`update public.stock_movements set note = 'x' where item_id = $1`, [rice]), /append-only/, 'movements stay append-only');
await fails(db.query(`delete from public.stock_movements where item_id = $1`, [rice]), /append-only/, 'movements cannot be deleted');
await db.query(`insert into public.inventory_events (business_id, entity, action, after) values ($1, 'stock_item', 'create', '{"a":1}')`, [ids.businessId]);
await fails(db.query(`update public.inventory_events set action = 'x'`), /append-only/, 'events append-only (update)');
await fails(db.query(`delete from public.inventory_events`), /append-only/, 'events append-only (delete)');

// 4-dp quantities
const bean = await item('Beans');
await db.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 285.7143)`, [ids.centerLocationId, bean]);
eq((await one(`select on_hand::text as v from public.stock_balances where item_id = $1`, [bean])).v, '285.7143', '4 decimal places stored');
await move(bean, 'opening', 285.7143);
eq((await one(`select delta::text as v, balance_after::text as b from public.stock_movements where item_id = $1`, [bean])), { v: '285.7143', b: '285.7143' }, 'ledger keeps 4 dp');
await db.query(`update public.stock_balances set on_hand = 1234567890123.4567 where item_id = $1`, [bean]);
checks++;
await fails(db.query(`update public.stock_balances set reserved = -1 where item_id = $1`, [bean]), /reserved/, 'reserved cannot go negative');

// archived items
const stale = await item('Old stock');
await move(stale, 'opening', 10);
await db.query(`update public.stock_items set archived_at = now() where id = $1`, [stale]);
await fails(move(stale, 'purchase_receipt', 1), /archived/, 'archived: receipts refused');
await fails(move(stale, 'opening', 1), /archived/, 'archived: opening refused');
await fails(move(stale, 'staff_meal', -1), /archived/, 'archived: staff meal refused');
await fails(move(stale, 'transfer_dispatch', -1), /archived/, 'archived: dispatch refused');
for (const r of ['count', 'count_correction', 'reversal', 'adjustment_loss', 'wastage', 'waste', 'served', 'pos_consumption', 'order_correction', 'dispatch_cancelled', 'received', 'lost_in_transit']) await move(stale, r, -1);
checks++;
await db.query(`update public.stock_items set archived_at = null where id = $1`, [stale]);
await move(stale, 'purchase_receipt', 1);
checks++;
// serving an order for an archived item still works (service must not break)
const burgerItem = await item('Patty');
await db.query(`update public.menu_item_stock set item_id = $1, servings = 1, allow_when_out = true where menu_item_id = $2`, [burgerItem, ids.burgerId]);
await db.query(`update public.stock_items set archived_at = now() where id = $1`, [burgerItem]);
const o2 = await helpers.order([{ itemId: ids.burgerId, name: 'Chicken burger', quantity: 1 }], 'taken');
await db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [o2, users.waiter]);
eq((await one(`select count(*)::int as n from public.stock_movements where order_id = $1 and reason = 'served'`, [o2])).n, 1, 'serving an order for an archived item still deducts');

// sku / barcode / category / levels / own units / settings / exceptions
await db.query(`update public.stock_items set sku = 'FL-001' where id = $1`, [flour]);
await fails(db.query(`update public.stock_items set sku = 'fl-001 ' where id = $1`, [rice]), /stock_items_sku/, 'sku unique per business, case-insensitive');
await db.query(`update public.stock_items set sku = null where id = $1`, [rice]);
await db.query(`update public.stock_items set sku = null where id = $1`, [bean]);
checks++;
await db.query(`insert into public.stock_item_barcodes (item_id, business_id, code) values ($1, $2, '6001')`, [flour, ids.businessId]);
await fails(db.query(`insert into public.stock_item_barcodes (item_id, business_id, code) values ($1, $2, '6001')`, [rice, ids.businessId]), /duplicate key/, 'barcode unique per business');
const biz2 = (await one(`insert into public.businesses (name) values ('Other') returning id`)).id;
await fails(db.query(`insert into public.stock_item_barcodes (item_id, business_id, code) values ($1, $2, '7001')`, [flour, biz2]), /foreign key/, 'barcode cannot point at another business’s item');
await fails(db.query(`update public.stock_items set yield_pct = 0 where id = $1`, [flour]), /yield_pct/, 'yield 0 refused');
await fails(db.query(`update public.stock_items set yield_pct = 100.5 where id = $1`, [flour]), /yield_pct/, 'yield over 100 refused');
await fails(db.query(`update public.stock_items set kind = 'weird' where id = $1`, [flour]), /kind/, 'invalid kind refused');
await fails(db.query(`update public.stock_items set storage = 'hot' where id = $1`, [flour]), /storage/, 'invalid storage refused');
await fails(db.query(`update public.stock_items set vat_class = 'x' where id = $1`, [flour]), /vat_class/, 'invalid vat class refused');
await fails(db.query(`update public.stock_items set avg_cost = -1 where id = $1`, [flour]), /avg_cost/, 'negative cost refused');
await db.query(`update public.stock_items set yield_pct = 87.5, kind = 'prepared', storage = 'chilled', avg_cost = 0.0021, display_unit = 'crate' where id = $1`, [flour]);
checks++;
const cat = (await one(`insert into public.stock_categories (business_id, name) values ($1, 'Dry goods') returning id`, [ids.businessId])).id;
await fails(db.query(`insert into public.stock_categories (business_id, name) values ($1, ' dry GOODS ')`, [ids.businessId]), /stock_categories_name/, 'category names unique per parent');
const sub = (await one(`insert into public.stock_categories (business_id, parent_id, name) values ($1, $2, 'Dry goods') returning id`, [ids.businessId, cat])).id;
await fails(db.query(`insert into public.stock_categories (business_id, parent_id, name) values ($1, $2, 'x')`, [biz2, cat]), /foreign key/, 'parent must be in the same business');
await db.query(`update public.stock_items set category_id = $2 where id = $1`, [flour, sub]);
await fails(db.query(`update public.stock_items set category_id = $2 where id = $1`, [rice, (await one(`insert into public.stock_categories (business_id, name) values ($1, 'Theirs') returning id`, [biz2])).id]), /foreign key/, 'category must be in the same business');
await db.query(`insert into public.stock_item_units (item_id, name, factor) values ($1, 'Crate', 10000.5)`, [flour]);
await fails(db.query(`insert into public.stock_item_units (item_id, name, factor) values ($1, 'crate', 5)`, [flour]), /stock_item_units_name/, 'item unit names unique per item');
await fails(db.query(`insert into public.stock_item_units (item_id, name, factor) values ($1, 'sack', 0)`, [flour]), /factor/, 'factor must be positive');
await db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, min, reorder, par, max) values ($1, $2, $3, 1, 2, 3, 4)`, [ids.centerLocationId, flour, ids.businessId]);
await fails(db.query(`insert into public.stock_item_levels (location_id, item_id, business_id, min) values ($1, $2, $3, -1)`, [ids.centerLocationId, rice, ids.businessId]), /min/, 'negative level refused');
await db.query(`insert into public.inventory_settings (business_id, key, value) values ($1, 'negative_policy', '"block"')`, [ids.businessId]);
await fails(db.query(`insert into public.inventory_settings (business_id, key, value) values ($1, 'negative_policy', '"allow"')`, [ids.businessId]), /inventory_settings_key/, 'one default per key');
await db.query(`insert into public.inventory_settings (business_id, location_id, key, value) values ($1, $2, 'negative_policy', '"allow"')`, [ids.businessId, westLoc]);
checks++;
await db.query(`insert into public.stock_exceptions (business_id, location_id, item_id, short_qty) values ($1, $2, $3, 2.5)`, [ids.businessId, westLoc, flour]);
await fails(db.query(`insert into public.stock_exceptions (business_id, location_id, item_id, short_qty) values ($1, $2, $3, 0)`, [ids.businessId, westLoc, flour]), /short_qty/, 'exception shortfall must be positive');
// locations
await db.query(`update public.stock_locations set code = 'WH1', status = 'suspended' where id = $1`, [ids.centerLocationId]);
await fails(db.query(`update public.stock_locations set status = 'gone' where id = $1`, [ids.centerLocationId]), /status/, 'invalid location status refused');
await db.query(`update public.stock_locations set code = null, status = 'active' where id = $1`, [ids.centerLocationId]);
await db.query(`insert into public.stock_locations (business_id, kind, name) values ($1, 'warehouse', 'Second')`, [ids.businessId]);
await fails(db.query(`insert into public.stock_locations (business_id, kind, name) values ($1, 'center', 'Another center')`, [ids.businessId]), /stock_locations_one_center/, 'still one center per business');
await db.query(`delete from public.stock_locations where kind = 'warehouse'`);
checks++;

// RLS: browser clients read the catalogue, not costs or ledger-side tables
const sees = (userId, sql) => asUser(db, userId, (t) => t.query(sql)).then((r) => r.rows);
eq((await sees(users.manager, `select count(*)::int as n from public.units`))[0].n, DEFAULT_UNITS.length, 'branch manager reads units');
eq((await sees(users.manager, `select name, sku, kind from public.stock_items where id = '${flour}'`))[0].name, 'Flour (plain)', 'branch member reads catalogue columns');
await fails(sees(users.manager, `select avg_cost from public.stock_items`), /permission denied/, 'costs are not readable by browser clients');
eq((await sees(users.manager, `select count(*)::int as n from public.stock_categories`))[0].n, 2, 'member reads categories');
eq((await sees(users.manager, `select count(*)::int as n from public.stock_item_units`))[0].n, 1, 'member reads item units');
eq((await sees(users.manager, `select count(*)::int as n from public.stock_item_barcodes`))[0].n, 1, 'member reads barcodes');
const rival = await createUser(db, 'rival@example.test', { role: 'owner' });
await db.query(`insert into public.restaurants (owner_id, name) values ($1, 'Rival')`, [rival]);
eq((await sees(rival, `select count(*)::int as n from public.stock_categories`))[0].n, 0, 'rival sees no categories');
eq((await sees(rival, `select count(*)::int as n from public.stock_item_units`))[0].n, 0, 'rival sees no item units');
for (const t of ['stock_item_levels', 'inventory_settings', 'inventory_events', 'stock_exceptions']) await fails(sees(users.owner, `select * from public.${t}`), /permission denied/, `${t} not readable by browsers`);
await fails(asUser(db, users.owner, (t) => t.query(`insert into public.stock_categories (business_id, name) values ('${ids.businessId}', 'x')`)), /permission denied/, 'browsers cannot write categories');
await db.close();

// ---------------------------------------------------------------------------------------------------------------
// 3. Down migration.
// ---------------------------------------------------------------------------------------------------------------
{ // 009-style data only → succeeds, 009 checks restored, data intact
  const f = await inventoryFixture({ extra: [] });
  const { ids: i, users: u, helpers: h } = f;
  const c = { businessId: i.businessId, actorId: u.manager };
  const it = await h.tx((t) => createItem(t, c, { name: 'Buns', lowLevel: 12.5 }));
  await h.tx((t) => adjust(t, { ...c, locationId: i.branchLocationId }, { kind: 'count', itemId: it.id, quantity: 10.125 }));
  const pre = await f.db.query(`select on_hand::text from public.stock_balances`);
  await f.db.exec(readSql(UP));
  await f.db.query(`insert into public.access_events (business_id, action) values ($1, 'inventory_enabled'), ($1, 'inventory_disabled')`, [i.businessId]);
  eq((await f.db.query(`select count(*)::int as n from public.access_events where action like 'inventory_%'`)).rows[0].n, 2, '012 allows the admin switch audit kinds');
  await f.db.exec(readSql(DOWN));
  await fails(f.db.query(`insert into public.access_events (business_id, action) values ($1, 'inventory_enabled')`, [i.businessId]), /access_events_action_check/, 'down: audit kind list restored to 008');
  eq((await f.db.query(`select count(*)::int as n from public.access_events where action like 'inventory_%'`)).rows[0].n, 2, 'down: existing audit events are kept (append-only)');
  const q = async (sql) => (await f.db.query(sql)).rows;
  eq(norm(await q(`select on_hand::text from public.stock_balances`)), norm(pre.rows), 'down: data intact');
  eq((await q(`select to_regclass('public.units') is null as gone, to_regclass('public.stock_categories') is null as g2, to_regclass('public.inventory_events') is null as g3`))[0], { gone: true, g2: true, g3: true }, 'down: new tables dropped');
  eq((await q(`select count(*)::int as n from information_schema.columns where table_name = 'stock_items' and column_name in ('sku','category_id','kind','avg_cost','archived_at','display_unit')`))[0].n, 0, 'down: new item columns dropped');
  eq((await q(`select numeric_scale as s, numeric_precision as p from information_schema.columns where table_name = 'stock_balances' and column_name = 'on_hand'`))[0], { s: 3, p: 12 }, 'down: numerics narrowed back');
  await fails(f.db.query(`insert into public.stock_items (business_id, name, unit) values ('${i.businessId}', 'G', 'g')`), /stock_items_unit_check/, 'down: unit check is serving-only again');
  await fails(f.db.query(`insert into public.stock_locations (business_id, kind, name) values ('${i.businessId}', 'warehouse', 'W')`), /stock_locations_kind_check/, 'down: kind check restored');
  await fails(f.db.query(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason) values ('${i.businessId}', '${i.branchLocationId}', '${it.id}', 1, 1, 'opening')`), /stock_movements_reason_check/, 'down: reason check restored');
  await fails(f.db.query(`update public.stock_movements set note = 'x'`), /append-only/, 'down: movements still append-only');
  eq((await q(`select count(*)::int as n from pg_trigger where tgname in ('stock_items_unit_guard','stock_movements_guard','inventory_events_no_change')`))[0].n, 0, 'down: triggers dropped');
  await f.db.exec(readSql(DOWN)); checks++;   // second run is a no-op
  await f.db.exec(readSql(UP));                // and 012 can be re-applied
  eq((await q(`select count(*)::int as n from public.units`))[0].n, DEFAULT_UNITS.length, 'down then up again works');
  await f.db.close();
}
const refuses = async (label, setup, re = /Refusing rollback of 012/) => {
  const f = await inventoryFixture({ extra: [UP] });
  await setup(f);
  await fails(f.db.exec(readSql(DOWN)), re, `down refuses: ${label}`);
  eq((await f.db.query(`select to_regclass('public.units') is not null as still`)).rows[0].still, true, `down refusal changed nothing (${label})`);
  await f.db.close();
};
const fx = (f) => ({ b: f.ids.businessId, loc: f.ids.centerLocationId, q: (s, p) => f.db.query(s, p) });
await refuses('a g item', async (f) => { const { b, q } = fx(f); await q(`insert into public.stock_items (business_id, name, unit) values ($1, 'Flour', 'g')`, [b]); }, /not counted in servings/);
await refuses('a category', async (f) => { const { b, q } = fx(f); await q(`insert into public.stock_categories (business_id, name) values ($1, 'C')`, [b]); }, /stock categories/);
await refuses('an item unit', async (f) => { const { b, q } = fx(f); const i = (await q(`insert into public.stock_items (business_id, name) values ($1, 'X') returning id`, [b])).rows[0].id; await q(`insert into public.stock_item_units (item_id, name, factor) values ($1, 'crate', 2)`, [i]); }, /item units/);
await refuses('a barcode', async (f) => { const { b, q } = fx(f); const i = (await q(`insert into public.stock_items (business_id, name) values ($1, 'X') returning id`, [b])).rows[0].id; await q(`insert into public.stock_item_barcodes (item_id, business_id, code) values ($1, $2, '1')`, [i, b]); }, /barcodes/);
await refuses('a level', async (f) => { const { b, loc, q } = fx(f); const i = (await q(`insert into public.stock_items (business_id, name) values ($1, 'X') returning id`, [b])).rows[0].id; await q(`insert into public.stock_item_levels (location_id, item_id, business_id, min) values ($1, $2, $3, 1)`, [loc, i, b]); }, /stock levels/);
await refuses('a setting', async (f) => { const { b, q } = fx(f); await q(`insert into public.inventory_settings (business_id, key, value) values ($1, 'k', '1')`, [b]); }, /settings/);
await refuses('an audit event', async (f) => { const { b, q } = fx(f); await q(`insert into public.inventory_events (business_id, entity, action) values ($1, 'e', 'a')`, [b]); }, /audit events/);
await refuses('an exception', async (f) => { const { b, loc, q } = fx(f); const i = (await q(`insert into public.stock_items (business_id, name) values ($1, 'X') returning id`, [b])).rows[0].id; await q(`insert into public.stock_exceptions (business_id, location_id, item_id, short_qty) values ($1, $2, $3, 1)`, [b, loc, i]); }, /exceptions/);
await refuses('a sku', async (f) => { const { b, q } = fx(f); await q(`insert into public.stock_items (business_id, name, sku) values ($1, 'X', 'S1')`, [b]); }, /new catalogue fields/);
await refuses('a new-reason movement', async (f) => { const { b, loc, q } = fx(f); const i = (await q(`insert into public.stock_items (business_id, name) values ($1, 'X') returning id`, [b])).rows[0].id; await q(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason) values ($1, $2, $3, 1, 1, 'opening')`, [b, loc, i]); }, /new reasons or columns/);
await refuses('a movement with an idempotency key', async (f) => { const { b, loc, q } = fx(f); const i = (await q(`insert into public.stock_items (business_id, name) values ($1, 'X') returning id`, [b])).rows[0].id; await q(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, idempotency_key) values ($1, $2, $3, 1, 1, 'count', 'k')`, [b, loc, i]); }, /new reasons or columns/);
await refuses('a 4-dp quantity', async (f) => { const { b, loc, q } = fx(f); const i = (await q(`insert into public.stock_items (business_id, name) values ($1, 'X') returning id`, [b])).rows[0].id; await q(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 1.2345)`, [loc, i]); }, /3 decimal places/);
await refuses('inventory switched on', async (f) => { const { b, q } = fx(f); await q(`update public.businesses set inventory_enabled = true where id = $1`, [b]); }, /switched on/);
await refuses('a warehouse location', async (f) => { const { b, q } = fx(f); await q(`insert into public.stock_locations (business_id, kind, name) values ($1, 'warehouse', 'W')`, [b]); }, /warehouse/);

console.log(`Migration 012 rehearsal: ${checks} checks passed (disposable PGlite databases).`);
