import assert from 'node:assert/strict';
import { freshDatabase, createUser } from '/Users/it-macmini-5/projects/p2/cravio/backend/tests/support/pg.js';
const HERE = new URL('./', import.meta.url).pathname;
const db = await freshDatabase({ extra: [HERE + 'spike_013.sql'] });
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS ${name}`); };
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];

const owner = await createUser(db, 'o@x.test', { role: 'owner' });
const waiter = await createUser(db, 'w@x.test', { role: 'waiter' });
const R = await one(`insert into public.restaurants (owner_id,name,status) values ($1,'Main','live') returning id, business_id`, [owner]);
const cat = (await one(`insert into public.menu_categories (restaurant_id,name) values ($1,'c') returning id`, [R.id])).id;
const dish = async (name) => (await one(`insert into public.menu_items (restaurant_id,category_id,name,price) values ($1,$2,$3,100) returning id`, [R.id, cat, name])).id;
const item = async (name, yp = 100) => (await one(`insert into public.stock_items (business_id,name,yield_pct) values ($1,$2,$3) returning id`, [R.business_id, name, yp])).id;
const loc = (await one(`select private.branch_location($1) as id`, [R.id])).id;
const setStock = (i, v) => db.query(`insert into public.stock_balances (location_id,item_id,on_hand) values ($1,$2,$3) on conflict (location_id,item_id) do update set on_hand=excluded.on_hand`, [loc, i, v]);
const onHand = async (i) => Number((await one(`select on_hand from public.stock_balances where location_id=$1 and item_id=$2`, [loc, i]))?.on_hand ?? 0);
// recipe(menuItem, [[item, qty]], allowWhenOut) -> new version, becomes current
const recipe = async (m, lines, allow = false) => {
  let r = await one(`select id from public.recipes where menu_item_id=$1`, [m]);
  if (!r) r = await one(`insert into public.recipes (menu_item_id, allow_when_out) values ($1,$2) returning id`, [m, allow]);
  const v = (await one(`select coalesce(max(version),0)+1 as v from public.recipe_versions where recipe_id=$1`, [r.id])).v;
  const ver = await one(`insert into public.recipe_versions (recipe_id,version) values ($1,$2) returning id`, [r.id, v]);
  for (const [i, qty] of lines) await db.query(`insert into public.recipe_lines (version_id,item_id,qty_base) values ($1,$2,$3)`, [ver.id, i, qty]);
  await db.query(`update public.recipes set current_version_id=$2 where id=$1`, [r.id, ver.id]);
  return ver.id;
};
const extra = async (m, name, lines) => {
  const e = await one(`insert into public.menu_item_extras (restaurant_id,item_id,name,price) values ($1,$2,$3,10) returning id`, [R.id, m, name]);
  for (const [i, qty] of lines) await db.query(`insert into public.menu_extra_recipe_lines (extra_id,item_id,qty_base) values ($1,$2,$3)`, [e.id, i, qty]);
  return e.id;
};
// One multi-row insert, like operations.js. line: {itemId,name,quantity,kind,extras,components}
const place = async (lines, status = 'taken') => {
  const o = (await one(`insert into public.orders (restaurant_id,status,taken_by) values ($1,$2,$3) returning id`, [R.id, status, waiter])).id;
  try {
    await db.query(`insert into public.order_items (order_id,restaurant_id,item_id,name,unit_price,quantity,line_total,position,kind,extras,components)
      select $1,$2,(l->>'itemId')::uuid,l->>'name',100,(l->>'quantity')::int,100,0,coalesce(l->>'kind','item'),coalesce(l->'extras','[]'::jsonb),l->'components'
      from jsonb_array_elements($3::jsonb) l`, [o, R.id, JSON.stringify(lines)]);
  } catch (e) { await db.query('delete from public.orders where id=$1', [o]); throw e; } // API does the same on failure
  return o;
};
const snap = (o) => q(`select s.source, si.name as ing, s.qty_base::text as qty, s.recipe_version_id is not null as has_ver from public.order_stock_lines s join public.order_items oi on oi.id=s.order_item_id join public.stock_items si on si.id=s.item_id where oi.order_id=$1 order by s.source, si.name`, [o]);
const serve = (o) => db.query(`update public.orders set status='served', served_at=now(), served_by=$2 where id=$1`, [o, waiter]);
const cancel = (o) => db.query(`update public.orders set status='cancelled', cancelled_at=now(), cancelled_by=$2 where id=$1`, [o, waiter]);
const cancelOpen = () => db.query(`update public.orders set status='cancelled', cancelled_at=now() where status in ('taken','accepted')`);
const soldOut = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ---- 1 yield
const chicken = await item('Chicken', 70), sauce = await item('Sauce'), buns = await item('Buns'), cheese = await item('Cheese'), fries = await item('Potatoes'), mince = await item('Mince');
const burger = await dish('Chicken burger'), friesDish = await dish('Fries'), slider = await dish('Slider');
const v1 = await recipe(burger, [[chicken, 200], [sauce, 20], [buns, 1]]);
await setStock(chicken, 10000); await setStock(sauce, 1000); await setStock(buns, 100);
const o1 = await place([{ itemId: burger, name: 'Chicken burger', quantity: 1 }]);
const s1 = await snap(o1);
ok('yield 70%: 200 g -> 285.7143 g, sauce 20, buns 1', () => {
  assert.deepEqual(s1.map(r => [r.ing, r.qty]), [['Buns', '1.0000'], ['Chicken', '285.7143'], ['Sauce', '20.0000']]);
  console.log('    ', JSON.stringify(s1));
});
await serve(o1);
const afterServe1 = await onHand(chicken);
ok('serve deducts 285.7143 exactly (needs 4dp columns)', () => assert.equal(afterServe1, 10000 - 285.7143));

// ---- 2 shared buns aggregation
await recipe(friesDish, [[fries, 150], [buns, 1]]); // contrived shared ingredient
await setStock(buns, 5); await setStock(fries, 10000);
const mk = (b, f) => [{ itemId: burger, name: 'Chicken burger', quantity: b }, { itemId: friesDish, name: 'Fries', quantity: f }];
const e2 = await soldOut(place(mk(3, 3)));      // needs 6 > 5
const o2 = await place(mk(3, 2));               // needs 5 == 5
const e2b = await soldOut(place(mk(1, 0 + 1))); // 1 more bun: held 5, avail 0 -> refused
ok('2. 6 buns needed vs 5: refused P0001/stock_sold_out', () => { assert.equal(e2.code, 'P0001'); assert.equal(e2.hint, 'stock_sold_out'); assert.match(e2.message, /Sold out:/); console.log('    ', e2.message, '| hint', e2.hint); });
const t2 = Number((await one(`select sum(s.qty_base) as t from public.order_stock_lines s join public.order_items oi on oi.id=s.order_item_id where oi.order_id=$1 and s.item_id=$2`, [o2, buns])).t);
ok('2. 5 needed == 5 available: allowed (buns from 2 lines summed = 5)', () => assert.equal(t2, 5));
ok('2. holds then refuse next bun; refused order left no rows', () => assert.equal(e2b.hint, 'stock_sold_out'));
assert.equal((await one(`select count(*)::int n from public.orders where restaurant_id=$1`, [R.id])).n, 2);
await cancel(o2);

// ---- 3 extra
await setStock(cheese, 1000); await setStock(buns, 100);
const xc = await extra(burger, 'Extra cheese', [[cheese, 30]]);
const o3 = await place([{ itemId: burger, name: 'Chicken burger', quantity: 3, extras: [{ id: xc, name: 'Extra cheese', price: 10 }] }]);
const s3 = await snap(o3);
ok('3. extra cheese 30 g x line qty 3 = 90 (+ dish lines x3)', () => {
  assert.deepEqual(s3.map(r => [r.source, r.ing, r.qty]), [['dish', 'Buns', '3.0000'], ['dish', 'Chicken', '857.1429'], ['dish', 'Sauce', '60.0000'], ['extra', 'Cheese', '90.0000']]);
  console.log('    ', JSON.stringify(s3.map(r => [r.source, r.ing, r.qty])));
});

// ---- 4 deal x2 (components per ONE deal: burger x1, fries x2, plus slider(link-only) x1) and shared buns
const sliderStock = await item('Slider patty'); await db.query(`insert into public.menu_item_stock (menu_item_id,restaurant_id,item_id,servings) values ($1,$2,$3,2)`, [slider, R.id, sliderStock]);
await setStock(sliderStock, 100); await setStock(buns, 100);
const comps = [{ itemId: burger, name: 'Chicken burger', quantity: 1, unitPrice: 100 }, { itemId: friesDish, name: 'Fries', quantity: 2, unitPrice: 50 }, { itemId: slider, name: 'Slider', quantity: 1, unitPrice: 80 }];
const o4 = await place([{ itemId: null, name: 'Meal deal', quantity: 2, kind: 'deal', components: comps }]);
const s4 = await q(`select s.source, si.name ing, s.qty_base::text qty, m.name as dish from public.order_stock_lines s join public.order_items oi on oi.id=s.order_item_id join public.stock_items si on si.id=s.item_id join public.menu_items m on m.id=s.ref_id where oi.order_id=$1 order by si.name, m.name`, [o4]);
ok('4. deal x2: per-component expansion (burger x2, fries x4, slider x2 via 009 link), buns from two components kept as two rows', () => {
  const get = (ing, d) => s4.find(r => r.ing === ing && r.dish === d)?.qty;
  assert.ok(s4.every(r => r.source === 'deal_component'));
  assert.equal(get('Chicken', 'Chicken burger'), '571.4286'); assert.equal(get('Buns', 'Chicken burger'), '2.0000');
  assert.equal(get('Buns', 'Fries'), '4.0000'); assert.equal(get('Potatoes', 'Fries'), '600.0000');
  assert.equal(get('Slider patty', 'Slider'), '4.0000');
  console.log('    ', JSON.stringify(s4.map(r => [r.dish, r.ing, r.qty])));
  assert.equal(s4.length, 6); assert.equal(get('Sauce', 'Chicken burger'), '40.0000');
});
const needs4 = await q(`select si.name, n.quantity::text from private.order_stock_needs($1) n join public.stock_items si on si.id=n.item_id order by 1`, [o4]);
ok('4. order_stock_needs sums buns across components -> 6', () => { assert.equal(needs4.find(r => r.name === 'Buns').quantity, '6.0000'); console.log('    ', JSON.stringify(needs4)); });

// ---- 5 recipe change after order
await setStock(chicken, 10000); await setStock(buns, 100); await setStock(sauce, 1000); await setStock(cheese, 1000);
const o5 = await place([{ itemId: burger, name: 'Chicken burger', quantity: 1 }]);
const v2 = await recipe(burger, [[chicken, 300], [buns, 1]]); // new version: 300 g, no sauce
const before = await onHand(chicken);
const o5b = await place([{ itemId: burger, name: 'Chicken burger', quantity: 1 }]);
const s5 = await snap(o5), s5b = await snap(o5b);
await serve(o5);
const afterOld = await onHand(chicken);
await serve(o5b);
const afterNew = await onHand(chicken);
ok('5. old order keeps v1 snapshot (285.7143, sauce 20); new order uses v2 (428.5714, no sauce)', () => {
  assert.equal(s5.find(r => r.ing === 'Chicken').qty, '285.7143'); assert.ok(s5.find(r => r.ing === 'Sauce'));
  assert.equal(s5b.find(r => r.ing === 'Chicken').qty, '428.5714'); assert.ok(!s5b.find(r => r.ing === 'Sauce'));
});
const ver5 = await one(`select distinct s.recipe_version_id from public.order_stock_lines s join public.order_items oi on oi.id=s.order_item_id where oi.order_id=$1`, [o5]);
const ver5b = await one(`select distinct s.recipe_version_id from public.order_stock_lines s join public.order_items oi on oi.id=s.order_item_id where oi.order_id=$1`, [o5b]);
ok('5. snapshot rows point at the right recipe_version_id', () => { assert.equal(ver5.recipe_version_id, v1); assert.equal(ver5b.recipe_version_id, v2); });
ok('5. serving deducts OLD snapshot (285.7143) then NEW (428.5714)', () => {
  assert.equal(Number((before - afterOld).toFixed(4)), 285.7143); assert.equal(Number((afterOld - afterNew).toFixed(4)), 428.5714);
  console.log('    ', before, '->', afterOld, '->', afterNew);
});

// ---- 6 replay
const o6 = await place([{ itemId: burger, name: 'Chicken burger', quantity: 1 }]);
const b6 = await onHand(chicken);
await serve(o6);
for (let i = 0; i < 4; i++) { await db.query(`update public.orders set status='accepted', accepted_at=now() where id=$1`, [o6]); await serve(o6); } // replays re-fire trigger
const eff = await one(`select count(*)::int n from public.order_stock_effects e join public.order_items oi on oi.id=e.order_item_id where oi.order_id=$1`, [o6]);
const mv = await one(`select count(*)::int n from public.stock_movements where order_id=$1`, [o6]);
const d6 = Number((b6 - await onHand(chicken)).toFixed(4));
ok('6. serve replayed 5x (status bounced back to accepted each time): deducted once (428.5714), 2 movements/effects (chicken, buns)', () => { assert.equal(d6, 428.5714); assert.equal(mv.n, 2); assert.equal(eff.n, 2); console.log('    ', d6, 'movements', mv.n); });

// ---- 7 cancel
await cancelOpen(); await setStock(buns, 10);
const o7 = await place([{ itemId: burger, name: 'Chicken burger', quantity: 9 }]); // holds 9 of 10 buns
const refusedWhileHeld = await soldOut(place([{ itemId: burger, name: 'Chicken burger', quantity: 2 }]));
const b7 = await onHand(buns), c7 = await onHand(chicken);
await cancel(o7);
const o7b = await place([{ itemId: burger, name: 'Chicken burger', quantity: 10 }]); // hold released -> all 10 fit
ok('7. cancel: nothing deducted, hold released (10 buns now orderable; 2 were refused while 9 held)', () => {
  assert.equal(refusedWhileHeld?.hint, 'stock_sold_out'); assert.equal(b7, 10);
});
assert.equal((await one(`select count(*)::int n from public.stock_movements where order_id=$1`, [o7])).n, 0);
assert.equal(c7, await onHand(chicken));
console.log('PASS 7b. cancelled order wrote no movements and chicken on_hand unchanged');

// ---- 8 no recipe, no link
const water = await dish('Water');
const o8 = await place([{ itemId: water, name: 'Water', quantity: 5 }]);
await serve(o8);
const n8 = (await one(`select count(*)::int n from public.stock_movements where order_id=$1`, [o8])).n;
ok('8. no recipe / no link: zero snapshot rows, order allowed, serve is a no-op', async () => {});
assert.equal((await snap(o8)).length, 0); assert.equal(n8, 0);

// ---- 9 link-only
const juiceItem = await item('Juice'); const juice = await dish('Juice');
await db.query(`insert into public.menu_item_stock (menu_item_id,restaurant_id,item_id,servings) values ($1,$2,$3,2)`, [juice, R.id, juiceItem]);
await setStock(juiceItem, 5);
const o9 = await place([{ itemId: juice, name: 'Juice', quantity: 2 }]); // needs 4 of 5
const s9 = await snap(o9);
const e9 = await soldOut(place([{ itemId: juice, name: 'Juice', quantity: 1 }])); // needs 2, 1 left
await serve(o9);
ok('9. 009 link-only dish: snapshot 4 servings (has_ver=false), sold-out works, serve deducts', () => {
  assert.deepEqual(s9.map(r => [r.ing, r.qty, r.has_ver]), [['Juice', '4.0000', false]]);
  assert.equal(e9.hint, 'stock_sold_out'); console.log('    ', e9.message);
});
assert.equal(await onHand(juiceItem), 1);

// ---- 10 multi-row insert
await cancelOpen(); await setStock(buns, 100); await setStock(sauce, 1000); await setStock(juiceItem, 50); await setStock(chicken, 10000); await setStock(fries, 10000);
const o10 = await place([{ itemId: burger, name: 'Chicken burger', quantity: 1 }, { itemId: friesDish, name: 'Fries', quantity: 1 }, { itemId: juice, name: 'Juice', quantity: 0 + 1 }, { itemId: water, name: 'Water', quantity: 1 }, { itemId: null, name: 'Deal', quantity: 1, kind: 'deal', components: [comps[0]] }]);
const per = await q(`select oi.name, count(s.*)::int n from public.order_items oi left join public.order_stock_lines s on s.order_item_id=oi.id where oi.order_id=$1 group by oi.name order by 1`, [o10]);
ok('10. five lines in ONE insert: every line snapshotted before the statement-level check ran', () => {
  console.log('    ', JSON.stringify(per));
  assert.equal(per.find(r => r.name === 'Water').n, 0); assert.ok(per.filter(r => r.name !== 'Water').every(r => r.n > 0));
});
// check trigger really reads snapshot written in same statement: oversell inside one multi-row statement
await cancelOpen(); await setStock(buns, 3);
const eMulti = await soldOut(place([{ itemId: burger, name: 'Chicken burger', quantity: 2 }, { itemId: friesDish, name: 'Fries', quantity: 2 }]));
ok('10. same-statement lines aggregate (2+2 buns vs 3-held) -> refused', () => assert.equal(eMulti?.hint, 'stock_sold_out'));

// keep-selling via recipes.allow_when_out
const keep = await dish('Keep'); const kItem = await item('KeepIng'); await recipe(keep, [[kItem, 10]], true); await setStock(kItem, 0);
const oK = await place([{ itemId: keep, name: 'Keep', quantity: 1 }]);
await serve(oK);
ok('extra: recipes.allow_when_out lets an out-of-stock dish through', () => {});
console.log('     keep-selling served, on_hand now', await onHand(kItem), '(009 serve goes negative; plan A5 floor+exception is a later change)');

// trigger order proof on the real table
const trg = await q(`select tgname, (tgtype & 1)=1 as row_level from pg_trigger where tgrelid='public.order_items'::regclass and not tgisinternal order by tgname`);
console.log('triggers on order_items:', JSON.stringify(trg));
console.log(`\nALL ${n} NUMBERED CHECKS PASSED`);
