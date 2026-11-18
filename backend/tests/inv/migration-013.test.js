// Migration 013 (proposed): versioned recipes, order stock snapshots, stop-at-zero serving with exceptions, stored notifications.
// Runs on PGlite with 012 + 013 applied (T-POS-* ids are the PRD's acceptance tests). Also rehearses applying 013 over live 009
// data, the trigger-order proof (ported from the spike's probe_order.mjs) and the down migration.
// Usage: node backend/tests/inv/migration-013.test.js
import assert from 'node:assert/strict';
import { asUser, createUser, freshDatabase, readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';

const U012 = 'migrations/012_inventory_catalogue.sql';
const UP = 'migrations/013_inventory_recipes.sql';
const DOWN = 'proposed/013_inventory_recipes.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(e.message, re, m); return true; }, m);
  checks++;
};
const soldOut = async (promise) => { try { await promise; return null; } catch (e) { return e; } };

// ---------------------------------------------------------------------------------------------------------------
// Fixture: one business, one live branch (owner = business owner; manager = branch manager; waiter), a second branch.
// ---------------------------------------------------------------------------------------------------------------
const { db, ids, users, helpers } = await inventoryFixture({ extra: [U012, UP] });
const { one, tx } = helpers;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const { businessId: biz, branchId, branchLocationId: loc } = ids;

const item = async (name, { unit = 'g', yieldPct = 100, display = null, cost = null } = {}) =>
  (await one(`insert into public.stock_items (business_id, name, unit, yield_pct, display_unit, avg_cost) values ($1, $2, $3, $4, $5, $6) returning id`,
    [biz, name, unit, yieldPct, display, cost])).id;
const dish = async (name) => (await one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, 100) returning id`, [branchId, ids.categoryId, name])).id;
const setStock = (i, v, l = loc) => db.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, $3)
  on conflict (location_id, item_id) do update set on_hand = excluded.on_hand`, [l, i, v]);
const onHand = async (i, l = loc) => Number((await one(`select on_hand from public.stock_balances where location_id = $1 and item_id = $2`, [l, i]))?.on_hand ?? 0);
/** Saves a recipe as a new version (the API's job) and makes it current. lines: [[item, qty, extra?]] */
const recipe = async (menuItem, lines, { allow = null, note = null } = {}) => {
  let r = await one(`select id, allow_when_out from public.recipes where menu_item_id = $1`, [menuItem]);
  if (!r) r = await one(`insert into public.recipes (business_id, restaurant_id, menu_item_id, allow_when_out) values ($1, $2, $3, coalesce($4, false)) returning id`, [biz, branchId, menuItem, allow]);
  else if (allow !== null) await db.query(`update public.recipes set allow_when_out = $2 where id = $1`, [r.id, allow]);
  const v = (await one(`select coalesce(max(version), 0) + 1 as v from public.recipe_versions where recipe_id = $1`, [r.id])).v;
  const ver = await one(`insert into public.recipe_versions (business_id, recipe_id, version, note, created_by) values ($1, $2, $3, $4, $5) returning id`, [biz, r.id, v, note, users.manager]);
  let pos = 0;
  for (const [i, qty, more = {}] of lines) {
    await db.query(`insert into public.recipe_lines (business_id, version_id, item_id, position, qty_base, takeaway_only) values ($1, $2, $3, $4, $5, $6)`,
      [biz, ver.id, i, pos++, qty, more.takeawayOnly ?? false]);
  }
  await db.query(`update public.recipes set current_version_id = $2, updated_at = now() where id = $1`, [r.id, ver.id]);
  await db.query(`update public.recipe_versions set superseded_at = now() where recipe_id = $1 and id <> $2 and superseded_at is null`, [r.id, ver.id]);
  return { recipeId: r.id, versionId: ver.id, version: v };
};
const extra = async (menuItem, name, lines) => {
  const e = (await one(`insert into public.menu_item_extras (restaurant_id, item_id, name, price) values ($1, $2, $3, 10) returning id`, [branchId, menuItem, name])).id;
  for (const [i, qty] of lines) await db.query(`insert into public.menu_extra_recipe_lines (business_id, restaurant_id, extra_id, item_id, qty_base) values ($1, $2, $3, $4, $5)`, [biz, branchId, e, i, qty]);
  return e;
};
/** One multi-row insert, like the API. A refused order is deleted again, as the API does. */
const place = async (lines, status = 'taken') => {
  const o = (await one(`insert into public.orders (restaurant_id, status, taken_by) values ($1, $2, $3) returning id`, [branchId, status, users.waiter])).id;
  try {
    await db.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, position, kind, extras, components)
      select $1, $2, (l->>'itemId')::uuid, l->>'name', 100, (l->>'quantity')::int, 100, 0, coalesce(l->>'kind', 'item'), coalesce(l->'extras', '[]'::jsonb), l->'components'
      from jsonb_array_elements($3::jsonb) l`, [o, branchId, JSON.stringify(lines)]);
  } catch (e) { await db.query('delete from public.orders where id = $1', [o]); throw e; }
  return o;
};
const L = (itemId, name, quantity, more = {}) => ({ itemId, name, quantity, ...more });
const serve = (o) => db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [o, users.waiter]);
const cancel = (o) => db.query(`update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = $2 where id = $1`, [o, users.waiter]);
const cancelOpen = () => db.query(`update public.orders set status = 'cancelled', cancelled_at = now() where status in ('taken', 'accepted')`);
const snap = (o) => q(`select s.source, si.name as ing, s.qty_base::text as qty, s.recipe_version_id is not null as has_ver from public.order_stock_lines s
  join public.order_items oi on oi.id = s.order_item_id join public.stock_items si on si.id = s.item_id where oi.order_id = $1 order by s.source, si.name`, [o]);
const held = async (i) => Number((await one(`select coalesce(sum(quantity), 0) as q from private.branch_committed($1) where item_id = $2`, [branchId, i])).q);
const avail = async () => Object.fromEntries((await q(`select * from public.stock_menu_availability($1)`, [branchId])).map((r) => [r.menu_item_id, r]));
const notes = (kind, itemId) => q(`select n.recipient_id, n.title, n.body, n.link, n.dedupe_key from public.notifications n where n.kind = $1 and ($2::uuid is null or n.entity_id = $2) order by n.recipient_id`, [kind, itemId]);

// ---------------------------------------------------------------------------------------------------------------
// T-POS-1: 3 x 100 g burgers against 2000 g. Held 300 while open, serve -> 1700, movement references the order.
// ---------------------------------------------------------------------------------------------------------------
const patty = await item('Patty', { cost: 0.002 });
const burger = await dish('Burger');
await recipe(burger, [[patty, 100]]);
await setStock(patty, 2000);
const o1 = await place([L(burger, 'Burger', 3)]);
eq(await held(patty), 300, 'T-POS-1 3 burgers hold 300 g');
eq(Number((await avail())[burger].available), 1700, 'T-POS-1 available 1700 while held');
eq(await onHand(patty), 2000, 'T-POS-1 confirming does not deduct');
await serve(o1);
eq(await onHand(patty), 1700, 'T-POS-1 serve -> 1700');
eq(await held(patty), 0, 'T-POS-1 hold released once served');
const mv1 = await one(`select delta::text as delta, balance_after::text as after, reason, order_id, ref_type, unit_cost::text as unit_cost, value::text as value from public.stock_movements where item_id = $1`, [patty]);
eq({ ...mv1, order_id: mv1.order_id === o1 }, { delta: '-300.0000', after: '1700.0000', reason: 'served', order_id: true, ref_type: 'order_item', unit_cost: '0.002000', value: '-0.60' },
  'T-POS-1 movement references the order, reason served, with unit_cost and value (delta x avg cost)');

// ---------------------------------------------------------------------------------------------------------------
// T-POS-2: ingredients shared by several dishes are aggregated over the whole order and branch.
// ---------------------------------------------------------------------------------------------------------------
const buns = await item('Buns', { unit: 'piece' });
const potato = await item('Potatoes');
const burger2 = await dish('Bun burger'), fries = await dish('Bun fries');
await recipe(burger2, [[buns, 1]]);
await recipe(fries, [[potato, 150], [buns, 1]]);
await setStock(buns, 5); await setStock(potato, 10000);
const refused2 = await soldOut(place([L(burger2, 'Bun burger', 3), L(fries, 'Bun fries', 3)]));
eq([refused2?.code, refused2?.hint], ['P0001', 'stock_sold_out'], 'T-POS-2 6 buns needed vs 5: refused, P0001 / stock_sold_out');
ok(/Sold out: /.test(refused2.message), 'T-POS-2 same message style as 009');
eq((await one(`select count(*)::int as n from public.orders where status = 'taken'`)).n, 0, 'T-POS-2 refused order left nothing behind (API deletes it; no hold remains)');
const o2 = await place([L(burger2, 'Bun burger', 3), L(fries, 'Bun fries', 2)]);
eq(await held(buns), 5, 'T-POS-2 two dishes each use buns: 3 + 2 = 5 held');
eq((await soldOut(place([L(burger2, 'Bun burger', 1)])))?.hint, 'stock_sold_out', 'T-POS-2 the next bun is refused (branch-wide aggregation)');
eq((await avail())[burger2].available == 0 && (await avail())[burger2].sold_out, true, 'T-POS-2 availability shows the dish sold out');

// ---------------------------------------------------------------------------------------------------------------
// T-POS-3: cancelling releases the hold. (Orders are insert-only: lines are never edited, so there is no "remove a line" path.)
// ---------------------------------------------------------------------------------------------------------------
await cancel(o2);
eq(await held(buns), 0, 'T-POS-3 cancel releases the hold');
eq(await onHand(buns), 5, 'T-POS-3 cancel moved no stock');
eq((await one(`select count(*)::int as n from public.stock_movements where order_id = $1`, [o2])).n, 0, 'T-POS-3 no movement for a cancelled order');
await place([L(burger2, 'Bun burger', 5)]);
checks++; // all five fit again
await cancelOpen();

// ---------------------------------------------------------------------------------------------------------------
// T-POS-4: serve replayed (status bounced back each time) deducts once.
// ---------------------------------------------------------------------------------------------------------------
await setStock(buns, 50); await setStock(potato, 10000);
const o4 = await place([L(fries, 'Bun fries', 2)]);
await serve(o4);
for (let i = 0; i < 4; i++) { await db.query(`update public.orders set status = 'accepted', accepted_at = now() where id = $1`, [o4]); await serve(o4); }
eq([await onHand(potato), await onHand(buns)], [9700, 48], 'T-POS-4 five serves, one deduction');
eq((await one(`select count(*)::int as n from public.stock_movements where order_id = $1`, [o4])).n, 2, 'T-POS-4 one movement per ingredient');
eq((await one(`select count(*)::int as n from public.order_stock_effects e join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [o4])).n, 2, 'T-POS-4 one effect per ingredient');

// ---------------------------------------------------------------------------------------------------------------
// T-POS-5: a new recipe version after a sale leaves old orders unchanged; versions that orders used are immutable.
// ---------------------------------------------------------------------------------------------------------------
const sauce = await item('Sauce'), wings = await item('Wings');
const dish5 = await dish('Wing basket');
const v1 = await recipe(dish5, [[wings, 200], [sauce, 20]], { note: 'first' });
await setStock(wings, 10000); await setStock(sauce, 1000);
const oOld = await place([L(dish5, 'Wing basket', 1)]);
const v2 = await recipe(dish5, [[wings, 300]], { note: 'bigger, no sauce' });
const oNew = await place([L(dish5, 'Wing basket', 1)]);
eq((await snap(oOld)).map((r) => [r.ing, r.qty]), [['Sauce', '20.0000'], ['Wings', '200.0000']], 'T-POS-5 old order keeps the old recipe');
eq((await snap(oNew)).map((r) => [r.ing, r.qty]), [['Wings', '300.0000']], 'T-POS-5 new order uses the new version');
eq([(await one(`select distinct recipe_version_id as v from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id where oi.order_id = $1`, [oOld])).v,
  (await one(`select distinct recipe_version_id as v from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id where oi.order_id = $1`, [oNew])).v], [v1.versionId, v2.versionId], 'T-POS-5 snapshot rows point at their version');
await serve(oOld);
eq(await onHand(wings), 9800, 'T-POS-5 serving the old order deducts the old quantity');
const IMMUTABLE = /This recipe version has been used by orders; save a new version instead\./;
await fails(db.query(`update public.recipe_versions set note = 'edited' where id = $1`, [v1.versionId]), IMMUTABLE, 'T-POS-5 used version cannot be edited');
await fails(db.query(`delete from public.recipe_versions where id = $1`, [v1.versionId]), IMMUTABLE, 'T-POS-5 used version cannot be deleted');
await fails(db.query(`update public.recipe_lines set qty_base = 1 where version_id = $1`, [v1.versionId]), IMMUTABLE, 'T-POS-5 its lines cannot be edited');
await fails(db.query(`delete from public.recipe_lines where version_id = $1`, [v1.versionId]), IMMUTABLE, 'T-POS-5 its lines cannot be deleted');
await fails(db.query(`insert into public.recipe_lines (business_id, version_id, item_id, position, qty_base) values ($1, $2, $3, 9, 1)`, [biz, v1.versionId, buns]), IMMUTABLE, 'T-POS-5 lines cannot be added to it');
await fails(db.query(`delete from public.recipes where id = $1`, [v1.recipeId]), IMMUTABLE, 'T-POS-5 a used recipe cannot be deleted while its dish exists');
try { await db.query(`update public.recipe_versions set note = 'x' where id = $1`, [v1.versionId]); } catch (e) { eq([e.code, e.hint], ['23514', 'recipe_version_used'], 'T-POS-5 error code and hint'); }
// Marking a used version superseded is allowed (that is what saving a new version does).
await db.query(`update public.recipe_versions set superseded_at = superseded_at where id = $1`, [v1.versionId]); checks++;
const unusedV = await recipe(dish5, [[wings, 250]], { note: 'draft' });
await db.query(`update public.recipe_versions set note = 'still editable' where id = $1`, [unusedV.versionId]);
await db.query(`update public.recipe_lines set qty_base = 260 where version_id = $1`, [unusedV.versionId]);
checks++; // a version no order used stays editable
eq(Number((await one(`select count(*) as n from public.recipe_versions where recipe_id = $1`, [v1.recipeId])).n), 3, 'T-POS-5 versions kept');
await fails(db.query(`insert into public.recipe_versions (business_id, recipe_id, version) values ($1, $2, 1)`, [biz, v1.recipeId]), /recipe_versions_recipe_id_version_key/, 'version numbers unique per recipe');
await fails(db.query(`update public.recipes set current_version_id = $1 where id = $2`, [(await recipe(await dish('Other'), [[wings, 1]])).versionId, v1.recipeId]), /recipes_current_version_fk/, 'current version must belong to the recipe');
// Deleting a dish for good is allowed even when orders used its recipe; history stays, the version link is cleared.
const gone = await dish('Short-lived');
await recipe(gone, [[sauce, 5]]);
const oGone = await place([L(gone, 'Short-lived', 1)]);
await db.query(`delete from public.menu_items where id = $1`, [gone]);
eq((await one(`select count(*)::int as n from public.recipes where menu_item_id = $1`, [gone])).n, 0, 'deleting the dish removes its recipe');
eq((await q(`select recipe_version_id from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id where oi.order_id = $1`, [oGone])).map((r) => r.recipe_version_id), [null], 'snapshot survives, version link cleared');
await cancelOpen();

// ---------------------------------------------------------------------------------------------------------------
// T-POS-6: partial availability, refusal, keep-selling served short -> on_hand 0, exception, notifications.
// ---------------------------------------------------------------------------------------------------------------
const beef = await item('Steak beef');
const steak = await dish('Steak');
await recipe(steak, [[beef, 100]]);
await setStock(beef, 150);
const a6 = (await avail())[steak];
eq([Number(a6.available), Number(a6.servings), Math.floor(a6.available / a6.servings), a6.sold_out, a6.item_id], [150, 100, 1, false, beef], 'T-POS-6 150 g / 100 g = 1 available');
eq(Object.keys(a6), ['menu_item_id', 'item_id', 'servings', 'available', 'allow_when_out', 'sold_out'], 'availability columns unchanged from 009');
await place([L(steak, 'Steak', 1)]);
eq((await soldOut(place([L(steak, 'Steak', 1)])))?.hint, 'stock_sold_out', 'T-POS-6 the second steak is refused');
eq((await avail())[steak].sold_out, true, 'T-POS-6 availability now sold out (50 g left < 100 g)');
await cancelOpen();

const chicken = await item('Chicken', { display: 'kg' });
const kebab = await dish('Kebab');
await recipe(kebab, [[chicken, 200]], { allow: true });
await setStock(chicken, 1000);
eq((await avail())[kebab].allow_when_out, true, 'keep-selling flag reported');
const oShort = await place([L(kebab, 'Kebab', 8)]);   // needs 1600 of 1000: keep-selling lets it in
await serve(oShort);
eq(await onHand(chicken), 0, 'T-POS-6 keep-selling served short: on_hand floors at 0');
const ex = await one(`select e.short_qty::text as short, e.kind, e.status, e.order_id, e.order_item_id, e.location_id, e.item_id, e.id from public.stock_exceptions e where e.item_id = $1`, [chicken]);
eq([ex.short, ex.kind, ex.status, ex.order_id === oShort, ex.location_id === loc], ['600.0000', 'unfulfilled_consumption', 'open', true, true], 'T-POS-6 exception records the 600 g short');
eq((await one(`select order_item_id is not null as has from public.stock_exceptions where id = $1`, [ex.id])).has, true, 'exception names the order line');
eq((await one(`select delta::text as d, balance_after::text as b from public.stock_movements where item_id = $1 and order_id = $2`, [chicken, oShort])), { d: '-1000.0000', b: '0.0000' }, 'T-POS-6 movement deducts only what was there');
const effect = await one(`select e.quantity::text as q, e.movement_id is not null as has_move from public.order_stock_effects e join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [oShort]);
eq(effect, { q: '1600.0000', has_move: true }, 'effect keeps what the line needed');
const exNotes = await notes('stock_exception', ex.id);
eq(exNotes.map((n) => n.recipient_id).sort(), [users.owner, users.manager].sort(), 'T-POS-6 exception notifies the owner and the branch manager (not the waiter)');
ok(/^Chicken was short at Main branch$/.test(exNotes[0].title), 'exception title in plain words');
ok(/1 order was served without enough Chicken \(0\.6 kg short\)\. Count it or record a delivery\./.test(exNotes[0].body), `exception body: ${exNotes[0].body}`);
eq(exNotes[0].link, `/branch/${branchId}/inventory`, 'exception link goes to the branch inventory');
const outNotes = await notes('stock_out', chicken);
eq(outNotes.map((n) => n.recipient_id).sort(), [users.owner, users.manager].sort(), 'T-POS-6 stock_out notifies owner and branch manager only');
ok(/^Chicken ran out at Main branch$/.test(outNotes[0].title), 'stock_out title in plain words');
eq((await q(`select 1 from public.notifications where recipient_id = $1`, [users.waiter])).length, 0, 'the waiter gets no stock notifications');
ok(outNotes[0].dedupe_key.startsWith(`stock_out:${loc}:${chicken}:`) && /\d{4}-\d{2}-\d{2}$/.test(outNotes[0].dedupe_key), 'stock_out dedupe key shape');

// A second order served at 0: nothing to deduct, effect recorded without a movement, a new exception, still not negative.
const oZero = await place([L(kebab, 'Kebab', 1)]);
await serve(oZero);
eq(await onHand(chicken), 0, 'served at zero stays 0');
const effZero = await one(`select e.movement_id as m, e.quantity::text as q from public.order_stock_effects e join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [oZero]);
eq(effZero, { m: null, q: '200.0000' }, 'zero deducted: effect recorded with no movement');
eq((await one(`select count(*)::int as n from public.stock_movements where order_id = $1`, [oZero])).n, 0, 'no movement written when nothing was deducted');
eq((await q(`select short_qty::text as s from public.stock_exceptions where order_id = $1`, [oZero])).map((r) => r.s), ['200.0000'], 'exception for the full 200 g');
await db.query(`update public.orders set status = 'accepted', accepted_at = now() where id = $1`, [oZero]); await serve(oZero);
eq((await one(`select count(*)::int as n from public.stock_exceptions where order_id = $1`, [oZero])).n, 1, 'replay does not repeat the exception');

// Stock-out notification dedupe: two hits on the same day -> one per recipient.
await setStock(chicken, 500);
const oHit = await place([L(kebab, 'Kebab', 2)]);   // 400 of 500: stays above 0
await serve(oHit);
await db.query(`update public.stock_balances set on_hand = 100 where location_id = $1 and item_id = $2`, [loc, chicken]);
await db.query(`update public.stock_balances set on_hand = 0 where location_id = $1 and item_id = $2`, [loc, chicken]);
eq((await notes('stock_out', chicken)).length, 2, 'two hits the same day: still one stock_out per recipient (2 recipients)');
// Another item hitting zero is its own notification; a balance going 0 -> 0 or negative -> lower sends nothing.
const salt = await item('Salt'); await setStock(salt, 5);
await db.query(`update public.stock_balances set on_hand = 0 where item_id = $1`, [salt]);
await db.query(`update public.stock_balances set on_hand = 0 where item_id = $1`, [salt]);
eq((await notes('stock_out', salt)).length, 2, 'a different item notifies separately; 0 -> 0 sends nothing more');
// Different day -> new notification (dedupe key carries the day).
await db.query(`update public.notifications set dedupe_key = replace(dedupe_key, to_char((now() at time zone 'Africa/Nairobi')::date, 'YYYY-MM-DD'), '2020-01-01') where entity_id = $1`, [salt]);
await db.query(`update public.stock_balances set on_hand = 3 where item_id = $1`, [salt]);
await db.query(`update public.stock_balances set on_hand = 0 where item_id = $1`, [salt]);
eq((await notes('stock_out', salt)).length, 4, 'next day: notifies again');
// The warehouse tells owners only (no branch managers).
await setStock(salt, 4, ids.centerLocationId);
await db.query(`update public.stock_balances set on_hand = 0 where item_id = $1 and location_id = $2`, [salt, ids.centerLocationId]);
const wh = await q(`select recipient_id, link from public.notifications where location_id = $1 and kind = 'stock_out'`, [ids.centerLocationId]);
eq([wh.map((r) => r.recipient_id), wh[0].link], [[users.owner], '/owner/inventory'], 'warehouse stock-out goes to business owners, linking to /owner/inventory');
// A notification failure never aborts the sale: break the table, serve still works.
await db.exec(`alter table public.notifications rename to notifications_x`);
await setStock(chicken, 100);
const oBroken = await place([L(kebab, 'Kebab', 1)]); await serve(oBroken);
await db.query(`update public.stock_balances set on_hand = 5 where item_id = $1 and location_id = $2`, [chicken, loc]);
await db.query(`update public.stock_balances set on_hand = 0 where item_id = $1 and location_id = $2`, [chicken, loc]);
await db.exec(`alter table public.notifications_x rename to notifications`);
eq((await one(`select status from public.orders where id = $1`, [oBroken])).status, 'served', 'a notification failure does not stop serving or counting');
await cancelOpen();

// ---------------------------------------------------------------------------------------------------------------
// T-POS-7: yield. 200 g at 70% yield -> 285.7143 g.
// ---------------------------------------------------------------------------------------------------------------
const rawChicken = await item('Raw chicken', { yieldPct: 70, cost: 0.01 });
const roast = await dish('Roast');
await recipe(roast, [[rawChicken, 200]]);
await setStock(rawChicken, 10000);
const o7 = await place([L(roast, 'Roast', 1)]);
eq((await snap(o7)).map((r) => r.qty), ['285.7143'], 'T-POS-7 200 g at 70% yield -> 285.7143 g');
eq((await one(`select servings::text as s, available::text as a from public.stock_menu_availability($1) where menu_item_id = $2`, [branchId, roast])), { s: '285.7143', a: '9714.2857' }, 'availability uses the yield-adjusted need and the hold');
await serve(o7);
eq(await onHand(rawChicken), 10000 - 285.7143, 'T-POS-7 serving deducts 285.7143 exactly (4 dp)');
eq((await one(`select value::text as v from public.stock_movements where item_id = $1`, [rawChicken])).v, '-2.86', 'value = -285.7143 x 0.01 rounded to 2 dp');
const o7b = await place([L(roast, 'Roast', 3)]);
eq((await snap(o7b)).map((r) => r.qty), ['857.1429'], 'yield applied to the whole line (3 x), rounded once');
await cancelOpen();

// ---------------------------------------------------------------------------------------------------------------
// Extras, deals, link-only fallback, recipe over link, untracked dish, takeaway-only lines.
// ---------------------------------------------------------------------------------------------------------------
const cheese = await item('Cheese'), bunsB = await item('Burger buns', { unit: 'piece' });
const dishX = await dish('Cheeseburger');
await recipe(dishX, [[bunsB, 1], [patty, 100]]);
const xCheese = await extra(dishX, 'Extra cheese', [[cheese, 30]]);
await setStock(cheese, 100); await setStock(bunsB, 100); await setStock(patty, 5000);
const oX = await place([L(dishX, 'Cheeseburger', 3, { extras: [{ id: xCheese, name: 'Extra cheese', price: 10 }] })]);
eq((await snap(oX)).map((r) => [r.source, r.ing, r.qty]), [['dish', 'Burger buns', '3.0000'], ['dish', 'Patty', '300.0000'], ['extra', 'Cheese', '90.0000']], 'extras: 30 g x line quantity 3 = 90 g');
eq(await held(cheese), 90, 'extras are held with the order');
eq((await soldOut(place([L(dishX, 'Cheeseburger', 1, { extras: [{ id: xCheese, name: 'Extra cheese' }] })])))?.hint, 'stock_sold_out', 'extras count towards sold out (90 held + 30 > 100)');
await serve(oX);
eq([await onHand(cheese), await onHand(bunsB)], [10, 97], 'extras and dish lines both deducted on serving');
// keep-selling dish: an out-of-stock EXTRA does not block it (the dish's switch applies to its extras)
await recipe(dishX, [[bunsB, 1], [patty, 100]], { allow: true });
await place([L(dishX, 'Cheeseburger', 1, { extras: [{ id: xCheese, name: 'Extra cheese' }] })]);
await place([L(dishX, 'Cheeseburger', 1, { extras: [{ id: xCheese, name: 'Extra cheese' }] })]);
checks += 2;
await recipe(dishX, [[bunsB, 1], [patty, 100]], { allow: false });
await cancelOpen();

// Deals: components per ONE deal, x line quantity; link-only component; shared ingredient kept as separate origin rows.
const slider = await dish('Slider'); const sliderStock = await item('Slider patty', { unit: 'serving' });
await db.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings) values ($1, $2, $3, 2)`, [slider, branchId, sliderStock]);
await setStock(sliderStock, 100); await setStock(buns, 100); await setStock(potato, 10000);
const comps = [{ itemId: burger2, name: 'Bun burger', quantity: 1, unitPrice: 100 }, { itemId: fries, name: 'Bun fries', quantity: 2, unitPrice: 50 }, { itemId: slider, name: 'Slider', quantity: 1, unitPrice: 80 }];
const oDeal = await place([{ itemId: null, name: 'Meal deal', quantity: 2, kind: 'deal', components: comps }]);
const sd = await q(`select s.source, si.name as ing, s.qty_base::text as qty, m.name as dish from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id
  join public.stock_items si on si.id = s.item_id join public.menu_items m on m.id = s.ref_id where oi.order_id = $1 order by si.name, m.name`, [oDeal]);
const get = (ing, d) => sd.find((r) => r.ing === ing && r.dish === d)?.qty;
ok(sd.every((r) => r.source === 'deal_component'), 'deal rows are deal_component');
eq([get('Buns', 'Bun burger'), get('Buns', 'Bun fries'), get('Potatoes', 'Bun fries'), get('Slider patty', 'Slider')], ['2.0000', '4.0000', '600.0000', '4.0000'], 'deal x2: burger x2, fries x4, slider (009 link, 2 servings) x2');
eq((await one(`select quantity::text as q from private.order_stock_needs($1) n join public.stock_items si on si.id = n.item_id where si.name = 'Buns'`, [oDeal])).q, '6.0000', 'order_stock_needs sums shared buns across components');
const cmpName = (await one(`select min(menu_name) as n from public.order_stock_lines where order_item_id = (select id from public.order_items where order_id = $1) and source = 'deal_component' and item_id = $2`, [oDeal, sliderStock])).n;
eq(cmpName, 'Slider', 'component name kept for messages');
await serve(oDeal);
eq(await onHand(sliderStock), 96, 'deal component served through its link');
await cancelOpen();

// Link-only dish: 009 fallback, servings, sold-out, availability.
const juiceItem = await item('Juice', { unit: 'serving' }); const juice = await dish('Juice');
await db.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings) values ($1, $2, $3, 2)`, [juice, branchId, juiceItem]);
await setStock(juiceItem, 5);
const oJ = await place([L(juice, 'Juice', 2)]);
eq((await snap(oJ)).map((r) => [r.ing, r.qty, r.has_ver]), [['Juice', '4.0000', false]], 'link-only dish: snapshot from the 009 link (no version)');
eq((await soldOut(place([L(juice, 'Juice', 1)])))?.hint, 'stock_sold_out', 'link-only dish sells out');
eq([Number((await avail())[juice].servings), Number((await avail())[juice].available)], [2, 1], 'availability for a link-only dish (servings per dish, available after holds)');
await serve(oJ);
eq(await onHand(juiceItem), 1, 'link-only dish deducts through serving');
// the link's keep-selling switch is honoured, and floors at 0 with an exception
await db.query(`update public.menu_item_stock set allow_when_out = true where menu_item_id = $1`, [juice]);
const oJk = await place([L(juice, 'Juice', 3)]); await serve(oJk);
eq(await onHand(juiceItem), 0, 'link keep-selling served short floors at 0');
eq((await one(`select short_qty::text as s from public.stock_exceptions where order_id = $1`, [oJk])).s, '5.0000', 'exception: needed 6 servings, 1 was there');
await db.query(`update public.menu_item_stock set allow_when_out = false where menu_item_id = $1`, [juice]);

// A dish with a recipe ignores its link; the link's keep-selling switch still counts.
const both = await dish('Both'); const bothA = await item('Both A'), bothB = await item('Both B');
await db.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings, allow_when_out) values ($1, $2, $3, 1, true)`, [both, branchId, bothB]);
await setStock(bothA, 10); await setStock(bothB, 10);
await recipe(both, [[bothA, 1]]);
const oBoth = await place([L(both, 'Both', 1)]);
eq((await snap(oBoth)).map((r) => r.ing), ['Both A'], 'recipe wins over the link');
await setStock(bothA, 0);
await place([L(both, 'Both', 1)]); checks++; // allowed: the 009 link says keep selling
await cancelOpen();

// Untracked dish: no rows, order allowed, serve is a no-op.
const water = await dish('Water');
const oW = await place([L(water, 'Water', 5)]);
eq((await snap(oW)).length, 0, 'untracked dish: no snapshot');
await serve(oW);
eq((await one(`select count(*)::int as n from public.stock_movements where order_id = $1`, [oW])).n, 0, 'untracked dish: nothing deducted');
eq((await avail())[water], undefined, 'untracked dish is not in availability');

// takeaway_only lines are skipped (no order type yet).
const box = await item('Takeaway box', { unit: 'piece' }); const meal = await dish('Takeable');
await recipe(meal, [[patty, 50], [box, 1, { takeawayOnly: true }]]);
eq((await snap(await place([L(meal, 'Takeable', 2)]))).map((r) => [r.ing, r.qty]), [['Patty', '100.0000']], 'takeaway_only lines are skipped for now');
// the same ingredient on two lines is summed
const twice = await dish('Twice'); await recipe(twice, [[patty, 30], [patty, 20]]);
eq((await snap(await place([L(twice, 'Twice', 1)]))).map((r) => r.qty), ['50.0000'], 'a repeated ingredient is summed');
await cancelOpen();

// Broken ids and numbers inside the jsonb never abort an order.
await setStock(cheese, 100); await setStock(buns, 100); await setStock(potato, 10000);
const oBad = await place([
  L(burger2, 'Bun burger', 1, { extras: [{ id: 'not-a-uuid', name: 'x' }, { name: 'no id' }, 7, { id: xCheese, name: 'Extra cheese' }] }),
  { itemId: null, name: 'Odd deal', quantity: 1, kind: 'deal', components: [{ itemId: 'zzz', name: 'bad id', quantity: 1 }, { itemId: null, quantity: 2 }, 'text', { itemId: burger2, name: 'Bun burger', quantity: 'many' }, { itemId: fries, name: 'Bun fries', quantity: -1 }, { itemId: fries, name: 'Bun fries', quantity: 2 }] },
]);
eq((await snap(oBad)).map((r) => [r.source, r.ing, r.qty]).sort(), [['deal_component', 'Buns', '1.0000'], ['deal_component', 'Buns', '2.0000'], ['deal_component', 'Potatoes', '300.0000'],
  ['dish', 'Buns', '1.0000'], ['extra', 'Cheese', '30.0000']].sort(), 'bad ids/quantities skipped, valid parts kept (quantity "many" counts as 1)');
await cancelOpen();

// ---------------------------------------------------------------------------------------------------------------
// Multi-row insert and trigger order (ported from the spike's probe_order.mjs).
// ---------------------------------------------------------------------------------------------------------------
await setStock(buns, 100); await setStock(potato, 10000); await setStock(juiceItem, 50); await setStock(patty, 5000);
const o10 = await place([L(burger2, 'Bun burger', 1), L(fries, 'Bun fries', 1), L(juice, 'Juice', 1), L(water, 'Water', 1), { itemId: null, name: 'Deal', quantity: 1, kind: 'deal', components: [comps[0]] }]);
const per = await q(`select oi.name, count(s.*)::int as n from public.order_items oi left join public.order_stock_lines s on s.order_item_id = oi.id where oi.order_id = $1 group by oi.name order by 1`, [o10]);
ok(per.filter((r) => r.name !== 'Water').every((r) => r.n > 0) && per.find((r) => r.name === 'Water').n === 0, 'five lines in one insert: each snapshotted');
await cancelOpen();
await setStock(buns, 3);
eq((await soldOut(place([L(burger2, 'Bun burger', 2), L(fries, 'Bun fries', 2)])))?.hint, 'stock_sold_out', 'lines of one statement are aggregated by the check (2 + 2 buns vs 3)');

await db.exec(`
  create table plog (n serial, who text, snap_rows int);
  create function plog_row() returns trigger language plpgsql as $$ begin insert into plog (who) values (tg_name); return null; end $$;
  create function plog_stmt() returns trigger language plpgsql as $$ begin
    insert into plog (who, snap_rows) values (tg_name, (select count(*) from public.order_stock_lines s join added a on a.id = s.order_item_id)); return null; end $$;
  create trigger zzz_row_late after insert on public.order_items for each row execute function plog_row();
  create trigger aaa_row_early after insert on public.order_items for each row execute function plog_row();
  create trigger aaa_stmt_early after insert on public.order_items referencing new table as added for each statement execute function plog_stmt();
  create trigger zzz_stmt_late after insert on public.order_items referencing new table as added for each statement execute function plog_stmt();`);
await setStock(buns, 100);
await place([L(burger2, 'Bun burger', 1), L(fries, 'Bun fries', 1)]);
const order = (await q(`select who from plog order by n`)).map((r) => r.who);
eq(order.slice(0, 4).sort(), ['aaa_row_early', 'aaa_row_early', 'zzz_row_late', 'zzz_row_late'], 'every row-level trigger fires before any statement-level one');
eq(order.slice(4).sort(), ['aaa_stmt_early', 'zzz_stmt_late'], 'statement-level triggers last');
eq((await q(`select snap_rows from plog where who in ('aaa_stmt_early', 'zzz_stmt_late')`)).map((r) => Number(r.snap_rows)), [3, 3], 'even an early-named statement trigger sees the snapshot rows (burger 1 + fries 2)');
const trg = await q(`select tgname, (tgtype & 1) = 1 as row_level from pg_trigger where tgrelid = 'public.order_items'::regclass and not tgisinternal and tgname in ('order_items_a_snapshot', 'order_items_stock_check') order by tgname`);
eq(trg, [{ tgname: 'order_items_a_snapshot', row_level: true }, { tgname: 'order_items_stock_check', row_level: false }], 'snapshot trigger is row-level, the sold-out check statement-level');
await db.exec(`drop trigger zzz_row_late on public.order_items; drop trigger aaa_row_early on public.order_items; drop trigger aaa_stmt_early on public.order_items; drop trigger zzz_stmt_late on public.order_items; drop table plog;
  drop function plog_row(); drop function plog_stmt();`);
await cancelOpen();

// ---------------------------------------------------------------------------------------------------------------
// RLS and grants
// ---------------------------------------------------------------------------------------------------------------
const rival = await createUser(db, 'rival@example.test', { role: 'owner' });
const rows = (u, sql, p) => asUser(db, u, async (t) => (await t.query(sql, p)).rows);
ok((await rows(users.waiter, `select 1 from public.recipes`)).length > 0, 'a branch member (waiter) reads recipes');
ok((await rows(users.waiter, `select 1 from public.recipe_lines`)).length > 0, 'and recipe lines');
ok((await rows(users.waiter, `select 1 from public.recipe_versions`)).length > 0, 'and versions');
ok((await rows(users.owner, `select 1 from public.menu_extra_recipe_lines`)).length > 0, 'the business owner reads extra recipe lines');
eq((await rows(rival, `select 1 from public.recipes`)).length + (await rows(rival, `select 1 from public.recipe_lines`)).length + (await rows(rival, `select 1 from public.menu_extra_recipe_lines`)).length, 0, 'a stranger reads nothing');
const mine = await rows(users.manager, `select recipient_id from public.notifications`);
ok(mine.length > 0 && mine.every((r) => r.recipient_id === users.manager), 'notifications: a recipient reads only their own');
eq((await rows(users.waiter, `select 1 from public.notifications`)).length, 0, 'the waiter has none');
eq((await rows(rival, `select 1 from public.notifications`)).length, 0, 'a stranger sees none');
await fails(asUser(db, users.owner, (t) => t.query(`select * from public.order_stock_lines`)), /permission denied/, 'snapshots are API-only');
await fails(asUser(db, users.owner, (t) => t.query(`insert into public.recipes (business_id, restaurant_id, menu_item_id) values ($1, $2, $3)`, [biz, branchId, water])), /permission denied/, 'browsers cannot write recipes');
await fails(asUser(db, users.owner, (t) => t.query(`update public.notifications set read_at = now()`)), /permission denied/, 'browsers cannot write notifications (the API marks them read)');
await fails(asUser(db, users.owner, (t) => t.query(`select private.order_stock_needs($1)`, [oBad])), /permission denied/, 'private functions stay private');
ok((await asUser(db, users.waiter, async (t) => (await t.query(`select * from public.stock_menu_availability($1)`, [branchId])).rows)).length > 0, 'availability readable by a branch member');
await fails(asUser(db, rival, (t) => t.query(`select * from public.stock_menu_availability($1)`, [branchId])), /Not a member/, 'availability still limited to branch members');
// composite business FKs
const biz2 = (await one(`insert into public.businesses (name) values ('Other') returning id`)).id;
const foreignItem = (await one(`insert into public.stock_items (business_id, name) values ($1, 'Theirs') returning id`, [biz2])).id;
await fails(db.query(`insert into public.recipe_lines (business_id, version_id, item_id, qty_base) values ($1, $2, $3, 1)`, [biz, unusedV.versionId, foreignItem]), /foreign key/, 'a recipe cannot use another business’s item');
await fails(db.query(`insert into public.recipes (business_id, restaurant_id, menu_item_id) values ($1, $2, $3)`, [biz2, branchId, water]), /foreign key/, 'a recipe’s business must match its branch');
await fails(db.query(`insert into public.recipe_lines (business_id, version_id, item_id, qty_base) values ($1, $2, $3, 0)`, [biz, unusedV.versionId, wings]), /qty_base/, 'quantity must be positive');
await fails(db.query(`insert into public.notifications (business_id, recipient_id, kind, title, dedupe_key) values ($1, $2, 'x', 't', 'k'), ($1, $2, 'x', 't', 'k')`, [biz, users.owner]), /notifications_dedupe/, 'unique (recipient, dedupe_key)');
await db.query(`insert into public.notifications (business_id, recipient_id, kind, title) values ($1, $2, 'x', 't'), ($1, $2, 'x', 't')`, [biz, users.owner]);
checks++; // rows without a dedupe key are not deduped

// ---------------------------------------------------------------------------------------------------------------
// Rehearsal over live 009 data: open orders are back-filled; re-running is a no-op; serving works.
// ---------------------------------------------------------------------------------------------------------------
{
  const f = await inventoryFixture({ extra: [U012] });
  const { db: d, ids: i2, users: u2, helpers: h2 } = f;
  const o = async (s, p) => (await d.query(s, p)).rows;
  const cat = i2.categoryId;
  const mk = async (n) => (await h2.one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, $3, 1) returning id`, [i2.branchId, cat, n])).id;
  const stockItem = async (n) => (await h2.one(`insert into public.stock_items (business_id, name) values ($1, $2) returning id`, [i2.businessId, n])).id;
  const rice = await stockItem('Rice');
  const pilau = await mk('Pilau');
  await d.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings) values ($1, $2, $3, 2)`, [pilau, i2.branchId, rice]);
  await d.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 10)`, [i2.branchLocationId, rice]);
  const open = await h2.order([{ itemId: pilau, name: 'Pilau', quantity: 2 }], 'taken');
  const acc = await h2.order([{ itemId: pilau, name: 'Pilau', quantity: 1 }], 'taken');
  await d.query(`update public.orders set status = 'accepted', accepted_at = now() where id = $1`, [acc]);
  const done = await h2.order([{ itemId: pilau, name: 'Pilau', quantity: 1 }], 'taken');
  await d.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [done, u2.waiter]);
  const gone = await h2.order([{ itemId: pilau, name: 'Pilau', quantity: 1 }], 'taken');
  await d.query(`update public.orders set status = 'cancelled', cancelled_at = now() where id = $1`, [gone]);
  const movedBefore = Number((await h2.one(`select count(*) as n from public.stock_movements`)).n);
  const committed009 = (await o(`select quantity::text as q from private.branch_committed($1)`, [i2.branchId])).map((r) => r.q);
  eq(committed009, ['6.000'], 'before 013: 009 holds 6 servings (2 x 2 + 1 x 2)');
  await d.exec(readSql(UP));
  eq((await o(`select quantity::text as q from private.branch_committed($1)`, [i2.branchId])).map((r) => r.q), ['6.0000'], 'after 013: same hold, now from the snapshot');
  eq(Number((await h2.one(`select count(distinct oi.order_id) as n from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id`)).n), 2, 'only taken/accepted orders were back-filled');
  eq((await o(`select distinct oi.order_id from public.order_stock_lines s join public.order_items oi on oi.id = s.order_item_id`)).map((r) => r.order_id).sort(), [open, acc].sort(), 'back-filled the open orders (not served, not cancelled)');
  await d.exec(readSql(UP));
  eq(Number((await h2.one(`select count(*) as n from public.order_stock_lines`)).n), 2, 're-running 013 does not duplicate snapshots');
  eq(Number((await h2.one(`select count(*) as n from public.stock_movements`)).n), movedBefore, 'applying 013 wrote no stock movement');
  eq((await soldOut(h2.order([{ itemId: pilau, name: 'Pilau', quantity: 3 }], 'taken')))?.hint, 'stock_sold_out', 'after the back-fill the open holds count: 6 held + 6 > 10');
  await d.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [open, u2.waiter]);
  eq(Number((await h2.one(`select on_hand from public.stock_balances where item_id = $1`, [rice])).on_hand), 4, 'an order taken BEFORE 013 deducts on serving, from its back-filled snapshot (10 - 2 served before - 4)');
  await d.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Down migration
// ---------------------------------------------------------------------------------------------------------------
{
  const fn = (database) => database.query(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('private', 'order_stock_needs'), ('private', 'branch_committed'), ('private', 'stock_check_new_lines'), ('private', 'stock_on_serve'),
      ('public', 'stock_menu_availability')) order by 1`).then((r) => r.rows);
  const baseline = await inventoryFixture({ extra: [U012] });
  const f = await inventoryFixture({ extra: [U012, UP] });
  const { db: d, ids: i2, users: u2, helpers: h2 } = f;
  const rec = await h2.one(`insert into public.menu_items (restaurant_id, category_id, name, price) values ($1, $2, 'Rice dish', 1) returning id`, [i2.branchId, i2.categoryId]);
  const it = (await h2.one(`insert into public.stock_items (business_id, name) values ($1, 'Rice') returning id`, [i2.businessId])).id;
  const r = (await h2.one(`insert into public.recipes (business_id, restaurant_id, menu_item_id) values ($1, $2, $3) returning id`, [i2.businessId, i2.branchId, rec.id])).id;
  await fails(d.exec(readSql(DOWN)), /Refusing rollback of 013: 1 recipe\(s\)/, 'down refuses while a recipe exists');
  eq((await h2.one(`select to_regclass('public.recipes') is not null as there`)).there, true, 'refusal changed nothing');
  await d.query(`delete from public.recipes where id = $1`, [r]);
  await d.query(`insert into public.notifications (business_id, recipient_id, kind, title) values ($1, $2, 'x', 'y')`, [i2.businessId, u2.owner]);
  await fails(d.exec(readSql(DOWN)), /1 notification\(s\)/, 'down refuses while notifications exist');
  await d.query(`delete from public.notifications`);
  // a menu item linked by 009, open order with a snapshot
  await d.query(`insert into public.menu_item_stock (menu_item_id, restaurant_id, item_id, servings) values ($1, $2, $3, 1)`, [rec.id, i2.branchId, it]);
  await d.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 3)`, [i2.branchLocationId, it]);
  const open = await h2.order([{ itemId: rec.id, name: 'Rice dish', quantity: 2 }]);
  eq(Number((await h2.one(`select count(*) as n from public.order_stock_lines`)).n), 1, 'snapshot present before the rollback');
  await d.exec(readSql(DOWN));
  eq((await h2.one(`select to_regclass('public.recipes') is null and to_regclass('public.recipe_versions') is null and to_regclass('public.recipe_lines') is null
    and to_regclass('public.menu_extra_recipe_lines') is null and to_regclass('public.order_stock_lines') is null and to_regclass('public.notifications') is null as gone`)).gone, true, 'down drops the 013 tables');
  eq((await h2.one(`select count(*)::int as n from pg_trigger where tgname in ('order_items_a_snapshot', 'stock_balances_stock_out', 'stock_exceptions_notify', 'recipe_versions_guard')`)).n, 0, 'down drops the 013 triggers');
  eq((await h2.one(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname in
    ('snapshot_order_line', 'dish_stock_lines', 'safe_uuid', 'safe_numeric', 'stock_notify', 'stock_fmt_qty', 'recipe_version_guard', 'order_items_snapshot')`)).n, 0, 'down drops the 013 functions');
  eq((await h2.one(`select to_regclass('public.stock_exceptions') is not null and to_regclass('public.units') is not null as kept`)).kept, true, '012 objects untouched');
  eq((await fn(d)).map((x) => x.def), (await fn(baseline.db)).map((x) => x.def), 'the five functions are byte-identical to what 009 (+012) had');
  eq((await h2.one(`select to_regclass('public.menu_item_extras_id_restaurant') is null as gone`)).gone, true, 'the extra index is dropped');
  // 009 behaviour is back: held from the link, serving works (and may go negative again, as in 009)
  eq((await d.query(`select quantity::text as q from private.branch_committed($1)`, [i2.branchId])).rows.map((x) => x.q), ['2.000'], '009 hold computed from the link again');
  await d.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [open, u2.waiter]);
  eq(Number((await h2.one(`select on_hand from public.stock_balances where item_id = $1`, [it])).on_hand), 1, 'serving works after the rollback');
  await d.exec(readSql(DOWN)); checks++;   // running it again is harmless
  await d.exec(readSql(UP));               // and 013 can be re-applied
  eq((await h2.one(`select to_regclass('public.recipes') is not null as back`)).back, true, '013 re-applies after a rollback');
  await d.close(); await baseline.db.close();
}

console.log(`Migration 013: ${checks} checks passed (disposable PGlite database).`);
await db.close();
