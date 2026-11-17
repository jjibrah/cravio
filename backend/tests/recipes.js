// Recipes and units (proposed migration 012) on a disposable PGlite database: kg/g conversion, packs, multi-ingredient
// dishes (deduction on serving, holds, sold out when any ingredient is short, per-dish keep selling, deals),
// 009 servings links unchanged, idempotent serving, and the AI recipe suggestion with a stubbed fetch.
// Never calls the real OpenRouter API. Usage: node backend/tests/recipes.js
import assert from 'node:assert/strict';
import { createUser, freshDatabase, readSql } from './support/pg.js';
import { adjust, availability, branchLocation, branchSnapshot, createItem, linkMenuItem, updateItem } from '../src/stock/service.js';
import { saveRecipe, suggest, suggestionInput } from '../src/stock/recipes.js';
import { DEFAULT_MODEL, OPENROUTER_URL, matchItem, normaliseSuggestion, parseJson, recipePrompt } from '../src/lib/ai.js';
import { compatibleUnits, convert, friendlyAmount, normaliseUnit, toItemUnit } from '../src/lib/units.js';

// Any accidental network call fails the test instead of reaching OpenRouter.
globalThis.fetch = async () => { throw new Error('Network disabled in tests'); };

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fails = async (promise, test, m) => {
  await assert.rejects(promise, (error) => { if (typeof test === 'number') assert.equal(error.status, test, `${m}: ${error.status} ${error.message}`); else assert.match(error.message, test, m); return true; }, m);
  checks++;
};
const throwsSync = (fn, test, m) => fails(Promise.resolve().then(fn), test, m);

/* ---------- Units (pure) ---------- */
eq(convert(200, 'g', 'kg'), 0.2, '200 g = 0.2 kg');
eq(convert(1.5, 'l', 'ml'), 1500, '1.5 l = 1500 ml');
eq(compatibleUnits('kg'), ['g', 'kg'], 'kg item accepts g and kg');
eq(compatibleUnits('serving'), ['serving'], 'servings only convert to servings');
await throwsSync(() => convert(200, 'g', 'ml'), /Can’t convert g to ml/, 'weight → volume refused');
await throwsSync(() => convert(2, 'piece', 'kg'), 400, 'piece → kg refused');
await throwsSync(() => convert(0.5, 'g', 'kg'), /too small/, 'precision below 1 g in kg refused, not rounded away');
eq(toItemUnit(40, 'pack', { unit: 'kg', pack_name: 'crate', pack_size: 10 }), 400, '40 crates = 400 kg');
eq(toItemUnit(2, 'crate', { unit: 'kg', packName: 'Crate', packSize: 10 }), 20, 'pack by its own name');
eq(friendlyAmount(38.4, { unit: 'kg', packName: 'crate', packSize: 10 }), '38.4 kg · about 3.8 crates', 'friendly balance with packs');
eq([normaliseUnit('Grams'), normaliseUnit('litres'), normaliseUnit('pcs'), normaliseUnit('cups')], ['g', 'l', 'piece', null], 'unit aliases');

/* ---------- Database fixture ---------- */
const db = await freshDatabase({ extra: ['proposed/012_recipes_units.sql'] });
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const tx = (fn) => db.transaction(fn);
const owner = await createUser(db, 'owner@example.test', { role: 'owner' });
const waiter = await createUser(db, 'waiter@example.test', { role: 'waiter' });
const main = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Main', 'live') returning id, business_id`, [owner]);
const biz = main.business_id;
const cat = (await one(`insert into public.menu_categories (restaurant_id, name) values ($1, 'Grill') returning id`, [main.id])).id;
const dish = async (name) => (await one(`insert into public.menu_items (restaurant_id, category_id, name, price, description) values ($1, $2, $3, 500, 'House special') returning id`, [main.id, cat, name])).id;
const burgerDish = await dish('Chicken burger');
const tandooriDish = await dish('Chicken tandoori');
const sodaDish = await dish('Soda');
const comboDish = await dish('Burger combo');
const loc = await tx((t) => branchLocation(t, main.id));
const ctx = { businessId: biz, restaurantId: main.id, locationId: loc, actorId: owner };

const [chicken, buns, soda, oil] = await tx(async (t) => [
  await createItem(t, ctx, { name: 'Chicken', unit: 'kg', packName: 'crate', packSize: 10 }),
  await createItem(t, ctx, { name: 'Burger buns', unit: 'piece', packName: 'bag', packSize: 12 }),
  await createItem(t, ctx, { name: 'Soda 300ml' }),
  await createItem(t, ctx, { name: 'Cooking oil', unit: 'l' }),
]);
eq([chicken.unit, chicken.packName, chicken.packSize, soda.unit], ['kg', 'crate', 10, 'serving'], 'items keep unit and pack; default is servings');
await fails(tx((t) => createItem(t, ctx, { name: 'Rice', unit: 'cups' })), 400, 'unknown unit refused');
await fails(tx((t) => createItem(t, ctx, { name: 'Rice', unit: 'kg', packName: 'sack' })), /how much one sack holds/, 'pack needs a size');

// Packs convert on add/count.
await tx((t) => adjust(t, ctx, { kind: 'added', itemId: chicken.id, quantity: 4, unit: 'pack', note: 'Supplier' }));
eq(Number((await one('select on_hand from public.stock_balances where item_id = $1', [chicken.id])).on_hand), 40, '4 crates added = 40 kg');
const counted = await tx((t) => adjust(t, ctx, { kind: 'count', itemId: chicken.id, quantity: 38400, unit: 'g' }));
eq([counted.onHand, counted.change], [38.4, -1.6], 'count in g on a kg item');
await fails(tx((t) => adjust(t, ctx, { kind: 'added', itemId: chicken.id, quantity: 1, unit: 'l' })), /Can’t convert/, 'cross-dimension add refused');
await fails(tx((t) => adjust(t, ctx, { kind: 'added', itemId: soda.id, quantity: 1, unit: 'pack' })), /no pack size/, 'pack on an item without one refused');
await tx((t) => adjust(t, ctx, { kind: 'count', itemId: buns.id, quantity: 1, unit: 'pack' }));
await tx((t) => adjust(t, ctx, { kind: 'count', itemId: soda.id, quantity: 5 }));
await tx((t) => adjust(t, ctx, { kind: 'count', itemId: oil.id, quantity: 2 }));

// Recipes: entered in any compatible unit, stored in the item's unit.
const saved = await tx((t) => saveRecipe(t, ctx, burgerDish, { lines: [{ itemId: chicken.id, quantity: 200, unit: 'g' }, { itemId: buns.id, quantity: 1 }, { itemId: oil.id, quantity: 20, unit: 'ml' }] }));
eq(saved.lines.map((l) => [l.quantity, l.unit, l.enteredQuantity, l.enteredUnit]), [[0.2, 'kg', 200, 'g'], [1, 'piece', 1, 'piece'], [0.02, 'l', 20, 'ml']], 'stored converted, entered unit kept');
eq(saved.preview[0], '1 Chicken burger uses 200 g Chicken', 'per-serving preview');
await fails(tx((t) => saveRecipe(t, ctx, tandooriDish, { lines: [{ itemId: chicken.id, quantity: 500, unit: 'ml' }] })), /Can’t convert ml to kg/, 'recipe in a cross-dimension unit refused');
await fails(tx((t) => saveRecipe(t, ctx, tandooriDish, { lines: [{ itemId: chicken.id, quantity: 1 }, { itemId: chicken.id, quantity: 2 }] })), /twice/, 'duplicate ingredient refused');
await fails(tx((t) => saveRecipe(t, ctx, tandooriDish, { lines: [{ itemId: chicken.id, quantity: 0 }] })), 400, 'zero quantity refused');
await tx((t) => saveRecipe(t, ctx, tandooriDish, { lines: [{ itemId: chicken.id, quantity: 0.5, unit: 'kg' }] }));
await tx((t) => linkMenuItem(t, ctx, sodaDish, { itemId: soda.id })); // 009 single servings link
await fails(tx((t) => updateItem(t, ctx, chicken.id, { unit: 'g' })), 409, 'unit cannot change once used');
eq((await tx((t) => updateItem(t, ctx, chicken.id, { packName: 'box', packSize: 5 }))).packName, 'box', 'pack can change any time');
await tx((t) => updateItem(t, ctx, chicken.id, { packName: 'crate', packSize: 10 }));

// Orders
const order = async (lines) => tx(async (t) => {
  const o = (await t.query(`insert into public.orders (restaurant_id, status, taken_by) values ($1, 'taken', $2) returning id`, [main.id, waiter])).rows[0].id;
  await t.query(`insert into public.order_items (order_id, restaurant_id, item_id, name, unit_price, quantity, line_total, kind, components)
    select $1, $2, (l->>'itemId')::uuid, l->>'name', 100, (l->>'quantity')::int, 100, coalesce(l->>'kind', 'item'), l->'components'
    from jsonb_array_elements($3::jsonb) l`, [o, main.id, JSON.stringify(lines)]);
  return o;
});
const serve = (o) => db.query(`update public.orders set status = 'served', served_at = now(), served_by = $2 where id = $1`, [o, waiter]);
const onHand = async (item) => Number((await one('select on_hand from public.stock_balances where location_id = $1 and item_id = $2', [loc, item]))?.on_hand ?? 0);
const avail = async () => Object.fromEntries((await availability(db, main.id)).map((a) => [a.menuItemId, a]));

// 3 burgers: 0.6 kg chicken, 3 buns, 0.06 l oil — held while confirmed, deducted on serving.
const o1 = await order([{ itemId: burgerDish, name: 'Chicken burger', quantity: 3 }]);
eq(await onHand(chicken.id), 38.4, 'confirming does not deduct');
const snap = await branchSnapshot(db, main.id);
eq(snap.items.find((i) => i.id === chicken.id).reserved, 0.6, 'confirmed order holds 0.6 kg chicken');
eq(snap.items.find((i) => i.id === buns.id).available, 9, 'and 3 buns (12 − 3 available)');
eq(snap.dishes.find((d) => d.id === burgerDish).recipe.lines.length, 3, 'snapshot shows the recipe');
eq(snap.dishes.find((d) => d.id === sodaDish).recipe.source, 'link', 'a 009 link shows as a one-line recipe');
eq(snap.items.find((i) => i.id === chicken.id).dishes, 2, 'chicken used by two dishes');
await serve(o1);
eq([await onHand(chicken.id), await onHand(buns.id), await onHand(oil.id)], [37.8, 9, 1.94], 'serving 3 burgers deducts 0.6 kg chicken, 3 buns, 60 ml oil');
await db.query(`update public.orders set status = 'paid', paid_at = now() where id = $1`, [o1]);
await db.query(`update public.orders set status = 'served', paid_at = null where id = $1`, [o1]);
eq(await onHand(chicken.id), 37.8, 're-serve is idempotent');
eq((await one(`select count(*)::int as n from public.stock_movements where reason = 'served' and order_id = $1`, [o1])).n, 3, 'one movement per ingredient');

// Two-ingredient dish: sold out when EITHER ingredient is short.
eq((await avail())[burgerDish].soldOut, false, 'burger available');
const o2 = await order([{ itemId: burgerDish, name: 'Chicken burger', quantity: 9 }]);
eq((await avail())[burgerDish].soldOut, true, 'buns all held → burger sold out though chicken is plenty');
eq((await avail())[tandooriDish].soldOut, false, 'tandoori (chicken only) still available');
await fails(order([{ itemId: burgerDish, name: 'Chicken burger', quantity: 1 }]), /Sold out: Chicken burger \(not enough Burger buns left\)/, 'ordering a burger with no buns refused');
await db.query(`update public.orders set status = 'cancelled', cancelled_at = now() where id = $1`, [o2]);
await tx((t) => adjust(t, ctx, { kind: 'count', itemId: chicken.id, quantity: 0.3 }));
eq([(await avail())[burgerDish].soldOut, (await avail())[tandooriDish].soldOut], [false, true], '0.3 kg chicken: burger (0.2) ok, tandoori (0.5) sold out');
eq((await availability(db, main.id)).length, 3, 'one availability row per tracked dish');
await fails(order([{ itemId: burgerDish, name: 'Chicken burger', quantity: 2 }]), /not enough Chicken/, 'chicken short for 2 burgers');

// Keep selling when out: per dish.
await tx((t) => saveRecipe(t, ctx, tandooriDish, { lines: [{ itemId: chicken.id, quantity: 500, unit: 'g' }], allowWhenOut: true }));
const o3 = await order([{ itemId: tandooriDish, name: 'Chicken tandoori', quantity: 1 }]);
eq((await avail())[tandooriDish].soldOut, false, 'keep-selling dish stays orderable');
await fails(order([{ itemId: burgerDish, name: 'Chicken burger', quantity: 1 }]), /Sold out: Chicken burger/, 'the other dish on the same item is still refused');
await serve(o3);
eq(await onHand(chicken.id), -0.2, 'balance goes negative, shows the gap to count');

// Deals use their components' recipes.
await tx((t) => adjust(t, ctx, { kind: 'count', itemId: chicken.id, quantity: 2, unit: 'kg' }));
const o4 = await order([{ kind: 'deal', name: 'Burger combo', quantity: 2, components: [{ itemId: burgerDish, name: 'Chicken burger', quantity: 1 }, { itemId: sodaDish, name: 'Soda', quantity: 1 }] }]);
await serve(o4);
eq([await onHand(chicken.id), await onHand(buns.id), await onHand(soda.id)], [1.6, 7, 3], 'deal: 2 burgers (0.4 kg, 2 buns) + 2 sodas via the 009 link');

// 009 servings link still deducts on its own.
const o5 = await order([{ itemId: sodaDish, name: 'Soda', quantity: 3 }]);
await fails(order([{ itemId: sodaDish, name: 'Soda', quantity: 1 }]), /Sold out: Soda/, 'servings link holds and sells out as before');
await serve(o5);
eq(await onHand(soda.id), 0, 'servings link deducts');

// Linking replaces a recipe and vice versa; empty recipe stops tracking.
await tx((t) => linkMenuItem(t, ctx, tandooriDish, { itemId: chicken.id, servings: 0.5 }));
eq((await one('select count(*)::int as n from public.menu_item_recipes where menu_item_id = $1', [tandooriDish])).n, 0, 'link replaces the recipe');
await tx((t) => saveRecipe(t, ctx, tandooriDish, { lines: [{ itemId: chicken.id, quantity: 500, unit: 'g' }] }));
eq((await one('select count(*)::int as n from public.menu_item_stock where menu_item_id = $1', [tandooriDish])).n, 0, 'recipe replaces the link');
await tx((t) => saveRecipe(t, ctx, comboDish, { lines: [] }));
eq((await avail())[comboDish], undefined, 'empty recipe = untracked');

/* ---------- AI suggestion (stubbed fetch; never the real API) ---------- */
const input = await tx((t) => suggestionInput(t, ctx, tandooriDish));
const prompt = recipePrompt(input.dish, input.stockItems);
eq(/owner@|waiter@|500/.test(prompt), false, 'prompt carries menu text and item names only');
eq(prompt.includes('Chicken (kg)') && prompt.includes('Dish: Chicken tandoori'), true, 'prompt lists dish and stock items');

let sent = null;
const reply = (content, status = 200) => async (url, init) => { sent = { url, init }; return { ok: status < 400, status, json: async () => ({ choices: [{ message: { content } }] }) }; };
const env = { OPENROUTER_API_KEY: 'test-key' };
const good = await suggest(input, { env, fetchImpl: reply('```json\n{"lines":[{"name":"chicken","quantity":"500","unit":"grams"},{"name":"Yoghurt","quantity":50,"unit":"g"},{"name":"Cooking Oil","quantity":15,"unit":"ml"},{"name":"bad","quantity":-2,"unit":"g"},{"name":"Salt","quantity":2,"unit":"pinch"}],"note":"Typical tandoori."}\n```') });
eq(sent.url, OPENROUTER_URL, 'calls OpenRouter');
eq(JSON.parse(sent.init.body).model, DEFAULT_MODEL, 'default model when OPENROUTER_MODEL is unset');
eq(good.draft, true, 'a draft, never saved');
eq(good.lines.map((l) => [l.itemId, l.name, l.quantity, l.unit, l.newItem]), [
  [chicken.id, 'Chicken', 500, 'g', false], [null, 'Yoghurt', 50, 'g', true], [oil.id, 'Cooking oil', 15, 'ml', false],
], 'normalised: units mapped, bad lines dropped, matched by name, unmatched flagged new');
eq((await one('select count(*)::int as n from public.menu_item_recipe_lines where menu_item_id = $1', [tandooriDish])).n, 1, 'suggesting saved nothing');
await suggest(input, { env: { ...env, OPENROUTER_MODEL: 'some/other-model' }, fetchImpl: reply('{"lines":[{"name":"Chicken","quantity":1,"unit":"kg"}]}') });
eq(JSON.parse(sent.init.body).model, 'some/other-model', 'OPENROUTER_MODEL overrides');
await fails(suggest(input, { env, fetchImpl: reply('Sorry, I cannot help with that.') }), 502, 'non-JSON answer rejected');
await fails(suggest(input, { env, fetchImpl: reply('{"lines":[{"name":"x","quantity":"lots","unit":"bucket"}]}') }), /no usable ingredients/, 'garbage lines rejected');
await fails(suggest(input, { env, fetchImpl: reply('{}', 500) }), 502, 'API error → 502');
await fails(suggest(input, { env: {}, fetchImpl: reply('{}') }), 503, 'no key → 503 not set up');
await fails(suggest(input, { env: {} }), /aren’t set up/, 'no key message, no network call');
eq(normaliseSuggestion({ lines: [{ name: 'Chicken', quantity: 2, unit: 'l' }] }, input.stockItems).lines[0].unit, 'kg', 'incompatible unit is replaced by the item unit, with a warning');
eq(matchItem('burger bun', input.stockItems)?.name, 'Burger buns', 'fuzzy match by words');
eq(parseJson('Here you go: {"lines": []} hope it helps'), { lines: [] }, 'JSON found inside text');

/* ---------- 012 without data loss: re-apply, rollback guard ---------- */
await db.exec(readSql('proposed/012_recipes_units.sql'));
eq((await avail())[tandooriDish].soldOut, false, '012 re-applies cleanly');
await fails(db.exec(readSql('proposed/012_recipes_units.down.sql')), /Refusing rollback/, 'rollback refuses while non-serving items exist');

// Rollback on a database with only servings items returns to 009 behaviour.
const plain = await freshDatabase({ extra: ['proposed/012_recipes_units.sql'] });
await plain.exec(readSql('proposed/012_recipes_units.down.sql'));
eq((await plain.query(`select to_regclass('public.menu_item_recipes') is null as gone`)).rows[0].gone, true, 'rollback drops recipes');
await plain.exec(readSql('proposed/012_recipes_units.sql'));
await plain.close();

console.log(`Recipes and units: ${checks} checks passed (disposable PGlite database, stubbed AI).`);
await db.close();
