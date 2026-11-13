import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

// Menu merchandising API: extras, pairings, featured dishes, deals, the menu design ("Studio"), the public menu
// shape and its cache, carts and orders with extras and deals, guest menu events, and the richer analytics.
// Needs migrations 003 and 004 applied. Everything happens in a throwaway restaurant with its own owner and
// waiter, created here with the service client and deleted in afterAll (everything else cascades).

const service = createAdmin();
const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `Merch-${stamp}-pw`;
const NOWHERE = '00000000-0000-4000-8000-000000000000';

const ctx = { users: [], restaurantId: null, extras: {}, deals: {} };
const visitor = (label) => `test-${label}-${stamp}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function unwrap(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

async function createUser(role, name) {
  const email = `cravio-merch-${role}-${stamp}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { name }, app_metadata: { role },
  });
  if (error) throw new Error(`Could not create the ${role}: ${error.message}`);
  ctx.users.push(data.user.id);
  unwrap(await service.from('profiles').upsert({ id: data.user.id, name, role }), 'profile');
  return { id: data.user.id, email, name };
}

async function signIn(email) {
  const client = createClient(env.SUPABASE_URL, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  return data.session.access_token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const as = (request, token) => ({
  get: (path) => request.get(path, { headers: auth(token) }),
  post: (path, data = {}) => request.post(path, { headers: auth(token), data }),
  patch: (path, data = {}) => request.patch(path, { headers: auth(token), data }),
  put: (path, data = {}) => request.put(path, { headers: auth(token), data }),
  delete: (path) => request.delete(path, { headers: auth(token) }),
});
const guest = (request, id) => ({
  get: (path, headers = {}) => request.get(path, { headers: { 'X-Cravio-Visitor': id, ...headers } }),
  post: (path, data) => request.post(path, { headers: { 'X-Cravio-Visitor': id }, data }),
});

async function json(response, status) {
  const body = await response.json().catch(() => ({}));
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}

const menuPath = () => `/api/public/menu/${ctx.restaurantId}`;
const folder = () => `${env.SUPABASE_URL}/storage/v1/object/public/restaurant-media/${ctx.restaurantId}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(90000);
  ctx.owner = await createUser('owner', 'Merch Owner');
  ctx.waiter = await createUser('waiter', 'Merch Waiter');
  const restaurant = unwrap(await service.from('restaurants').insert({
    owner_id: ctx.owner.id, name: `Merch Test ${stamp}`, status: 'live', went_live_at: new Date().toISOString(), area: 'Kilimani, Nairobi', theme: 'savanna',
  }).select('id').single(), 'restaurant');
  ctx.restaurantId = restaurant.id;
  unwrap(await service.from('restaurant_members').insert([
    { restaurant_id: restaurant.id, user_id: ctx.owner.id, role: 'owner' },
    { restaurant_id: restaurant.id, user_id: ctx.waiter.id, role: 'waiter' },
  ]), 'members');
  unwrap(await service.from('restaurant_tables').insert([1, 2, 3].map((number) => ({ restaurant_id: restaurant.id, number }))), 'tables');
  const categories = unwrap(await service.from('menu_categories').insert([
    { restaurant_id: restaurant.id, name: 'Mains', position: 0 }, { restaurant_id: restaurant.id, name: 'Sides', position: 1 },
    { restaurant_id: restaurant.id, name: 'Drinks', position: 2 },
  ]).select('id, name'), 'categories');
  ctx.categories = Object.fromEntries(categories.map((c) => [c.name, c.id]));
  const items = unwrap(await service.from('menu_items').insert([
    { restaurant_id: restaurant.id, category_id: ctx.categories.Mains, name: 'Classic beef burger', price: 950, position: 0, available: true },
    { restaurant_id: restaurant.id, category_id: ctx.categories.Mains, name: 'Grilled chicken', price: 850, position: 1, available: true },
    { restaurant_id: restaurant.id, category_id: ctx.categories.Mains, name: 'Whole tilapia', price: 1200, position: 2, available: false },
    { restaurant_id: restaurant.id, category_id: ctx.categories.Sides, name: 'Chips', price: 250, position: 0, available: true },
    { restaurant_id: restaurant.id, category_id: ctx.categories.Drinks, name: 'Stoney tangawizi', price: 120, position: 0, available: true },
  ]).select('id, name'), 'items');
  ctx.items = Object.fromEntries(items.map((item) => [item.name, item.id]));
  ctx.ownerToken = await signIn(ctx.owner.email);
  ctx.waiterToken = await signIn(ctx.waiter.email);
});

test.afterAll(async () => {
  if (ctx.restaurantId) {
    const { error } = await service.from('restaurants').delete().eq('id', ctx.restaurantId);
    if (error) console.error('Could not delete the test restaurant:', error.message);
  }
  for (const id of ctx.users) {
    const { error } = await service.auth.admin.deleteUser(id);
    if (error) console.error('Could not delete a test user:', error.message);
  }
});

test('extras are created, validated, edited and reordered per dish', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const waiter = as(request, ctx.waiterToken);
  const burger = ctx.items['Classic beef burger'];
  for (const [name, price] of [['Cheese', 150], ['Bacon', 200], ['Make it a meal (fries + drink)', 450]]) {
    const { extra } = await json(await owner.post(`/api/restaurant/items/${burger}/extras`, { name, price }), 200);
    expect(extra).toMatchObject({ itemId: burger, name, price, available: true });
    ctx.extras[name] = extra.id;
  }
  const chipsExtra = (await json(await owner.post(`/api/restaurant/items/${ctx.items.Chips}/extras`, { name: 'Cheese sauce', price: 100 }), 200)).extra;
  ctx.extras['Cheese sauce'] = chipsExtra.id;

  await json(await owner.post(`/api/restaurant/items/${burger}/extras`, { name: 'cheese', price: 10 }), 409);
  expect((await json(await owner.post(`/api/restaurant/items/${burger}/extras`, { name: 'Egg', price: -5 }), 400)).details.field).toBe('price');
  await json(await owner.post(`/api/restaurant/items/${burger}/extras`, { price: 5 }), 400);
  await json(await owner.post(`/api/restaurant/items/${NOWHERE}/extras`, { name: 'Egg', price: 5 }), 404);
  await json(await waiter.post(`/api/restaurant/items/${burger}/extras`, { name: 'Egg', price: 5 }), 403);

  const edited = (await json(await owner.patch(`/api/restaurant/extras/${ctx.extras.Bacon}`, { price: 180 }), 200)).extra;
  expect(edited.price).toBe(180);
  await json(await owner.patch(`/api/restaurant/extras/${ctx.extras.Bacon}`, { price: 200 }), 200);

  const order = [ctx.extras['Make it a meal (fries + drink)'], ctx.extras.Cheese, ctx.extras.Bacon];
  const reordered = await json(await owner.put(`/api/restaurant/items/${burger}/extras/order`, { ids: order }), 200);
  expect(reordered.extras.map((e) => e.id)).toEqual(order);
  await json(await owner.put(`/api/restaurant/items/${burger}/extras/order`, { ids: order.slice(1) }), 400);

  // A throwaway extra can be deleted.
  const temp = (await json(await owner.post(`/api/restaurant/items/${burger}/extras`, { name: 'Egg', price: 80 }), 200)).extra;
  expect((await owner.delete(`/api/restaurant/extras/${temp.id}`)).status()).toBe(204);

  const menu = await json(await owner.get('/api/restaurant/menu'), 200);
  const item = menu.items.find((i) => i.id === burger);
  expect(item.extras.map((e) => e.name)).toEqual(['Make it a meal (fries + drink)', 'Cheese', 'Bacon']);
  expect(item.stats30d).toEqual({ views: 0, videoPlays: 0, orderedQuantity: 0, sales: 0 });
  expect(menu.limits).toMatchObject({ pairingsPerDish: 6, featured: 10 });
});

test('pairings are ordered, limited to 6, never self, and can mirror', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const { items } = ctx;
  const set = await json(await owner.put(`/api/restaurant/items/${items.Chips}/pairings`, { itemIds: [items['Grilled chicken'], items['Classic beef burger']], mirror: true }), 200);
  expect(set.pairedItemIds).toEqual([items['Grilled chicken'], items['Classic beef burger']]);
  expect(set.mirroredItemIds.sort()).toEqual([items['Grilled chicken'], items['Classic beef burger']].sort());

  await json(await owner.put(`/api/restaurant/items/${items.Chips}/pairings`, { itemIds: [items.Chips] }), 400);
  await json(await owner.put(`/api/restaurant/items/${items.Chips}/pairings`, { itemIds: [items.Chips, items.Chips] }), 400);
  const seven = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
  expect((await json(await owner.put(`/api/restaurant/items/${items.Chips}/pairings`, { itemIds: seven }), 400)).error).toMatch(/up to 6/);
  await json(await owner.put(`/api/restaurant/items/${items.Chips}/pairings`, { itemIds: [NOWHERE] }), 400);

  // The unavailable tilapia can be paired, but guests never see it as a suggestion.
  await json(await owner.put(`/api/restaurant/items/${items['Grilled chicken']}/pairings`, { itemIds: [items.Chips, items['Whole tilapia'], items['Stoney tangawizi']] }), 200);
  expect((await owner.delete(`/api/restaurant/items/${items['Grilled chicken']}/pairings/${items['Stoney tangawizi']}`)).status()).toBe(204);

  const menu = await json(await owner.get('/api/restaurant/menu'), 200);
  const byId = Object.fromEntries(menu.items.map((i) => [i.id, i]));
  expect(byId[items['Grilled chicken']].pairedItemIds).toEqual([items.Chips, items['Whole tilapia']]);
  expect(byId[items['Classic beef burger']].pairedItemIds).toEqual([items.Chips]);
});

test('featured dishes are ordered and limited', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const { items } = ctx;
  const set = await json(await owner.put('/api/restaurant/featured', { itemIds: [items['Grilled chicken'], items['Classic beef burger']] }), 200);
  expect(set.featuredItemIds).toEqual([items['Grilled chicken'], items['Classic beef burger']]);
  const eleven = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`);
  await json(await owner.put('/api/restaurant/featured', { itemIds: eleven }), 400);

  // Toggling one dish on PATCH appends it; off removes it.
  const on = (await json(await owner.patch(`/api/restaurant/items/${items['Stoney tangawizi']}`, { featured: true }), 200)).item;
  expect(on).toMatchObject({ featured: true, featuredPosition: 2 });
  const off = (await json(await owner.patch(`/api/restaurant/items/${items['Stoney tangawizi']}`, { featured: false }), 200)).item;
  expect(off).toMatchObject({ featured: false, featuredPosition: null });
  await json(await owner.patch(`/api/restaurant/items/${items['Stoney tangawizi']}`, { featured: 'yes' }), 400);

  const menu = await json(await owner.get('/api/restaurant/menu'), 200);
  expect(menu.featuredItemIds).toEqual([items['Grilled chicken'], items['Classic beef burger']]);
});

test('deals validate, price themselves and report availability', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const waiter = as(request, ctx.waiterToken);
  const { items } = ctx;
  const burgerMeal = {
    name: 'Burger meal', description: 'Burger, chips and a Stoney.', price: 1150,
    items: [{ itemId: items['Classic beef burger'] }, { itemId: items.Chips }, { itemId: items['Stoney tangawizi'], quantity: 1 }],
  };
  const created = (await json(await owner.post('/api/restaurant/deals', burgerMeal), 200)).deal;
  expect(created).toMatchObject({
    name: 'Burger meal', price: 1150, regularPrice: 1320, saving: 170, savingPercent: 13, active: true, status: 'live', visibleToGuests: true, issues: [], units: 3,
  });
  expect(created.items.map((i) => [i.name, i.quantity, i.unitPrice])).toEqual([['Classic beef burger', 1, 950], ['Chips', 1, 250], ['Stoney tangawizi', 1, 120]]);
  ctx.deals.burgerMeal = created.id;

  const forTwo = (await json(await owner.post('/api/restaurant/deals', {
    name: 'Chicken & chips for two', price: 1900, items: [{ itemId: items['Grilled chicken'], quantity: 2 }, { itemId: items.Chips, quantity: 2 }],
    photoUrl: `${folder()}/deals/chicken.jpg`,
  }), 200)).deal;
  expect(forTwo).toMatchObject({ regularPrice: 2200, saving: 300, photoUrl: `${folder()}/deals/chicken.jpg` });
  ctx.deals.forTwo = forTwo.id;

  // Invalid deals.
  await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, price: -1 }), 400);
  expect((await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, items: [{ itemId: items.Chips }] }), 400)).error).toMatch(/at least 2/);
  await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, items: [{ itemId: items.Chips }, { itemId: NOWHERE }] }), 400);
  await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, items: [{ itemId: items.Chips }, { itemId: items.Chips }] }), 400);
  await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, startsAt: '2026-12-10', endsAt: '2026-12-01' }), 400);
  await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, photoUrl: `${folder()}/items/x.jpg` }), 400);
  await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, name: '' }), 400);
  await json(await waiter.post('/api/restaurant/deals', burgerMeal), 403);

  // A deal with a sold-out dish is kept for the owner but flagged; a future deal is scheduled.
  const flagged = (await json(await owner.post('/api/restaurant/deals', {
    name: 'Fish feast', price: 1300, items: [{ itemId: items['Whole tilapia'] }, { itemId: items.Chips }],
  }), 200)).deal;
  expect(flagged).toMatchObject({ status: 'unavailable', visibleToGuests: false });
  expect(flagged.issues[0]).toMatchObject({ code: 'item_unavailable', itemId: items['Whole tilapia'] });
  ctx.deals.flagged = flagged.id;
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const scheduled = (await json(await owner.post('/api/restaurant/deals', { ...burgerMeal, name: 'Weekend special', startsAt: tomorrow }), 200)).deal;
  expect(scheduled).toMatchObject({ status: 'scheduled', visibleToGuests: false });
  ctx.deals.scheduled = scheduled.id;

  const patched = (await json(await owner.patch(`/api/restaurant/deals/${created.id}`, { description: 'The classic.' }), 200)).deal;
  expect(patched).toMatchObject({ description: 'The classic.', price: 1150 });
  await json(await owner.patch(`/api/restaurant/deals/${NOWHERE}`, { price: 1 }), 404);

  const ids = [forTwo.id, created.id, flagged.id, scheduled.id];
  const ordered = await json(await owner.put('/api/restaurant/deals/order', { ids }), 200);
  expect(ordered.deals.map((d) => d.id)).toEqual(ids);
  const listed = await json(await owner.get('/api/restaurant/deals'), 200);
  expect(listed.deals.map((d) => d.id)).toEqual(ids);
  expect((await json(await owner.get(`/api/restaurant/deals/${created.id}`), 200)).deal.regularPrice).toBe(1320);
});

test('the menu design validates, drops unknown keys and merges with defaults', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const { categories } = ctx;
  const initial = await json(await owner.get('/api/restaurant/menu-design'), 200);
  expect(initial.isDefault).toBe(true);
  expect(initial.design).toMatchObject({ version: 1, theme: null, fonts: { display: 'playfair', body: 'dm-sans' }, sections: [] });
  expect(initial.resolved.theme).toBe('savanna');
  expect(initial.resolved.sections.map((s) => s.key)).toEqual(['featured', 'deals', `category:${categories.Mains}`, `category:${categories.Sides}`, `category:${categories.Drinks}`]);
  expect(initial.resolved.sections[0]).toMatchObject({ title: 'Featured', layout: 'carousel', visible: true });
  expect(initial.options.fonts.display.map((f) => f.key)).toEqual(['abril', 'playfair', 'fraunces', 'dm-serif', 'bebas', 'syne']);
  expect(initial.options.fonts.body.map((f) => f.key)).toEqual(['dm-sans', 'inter', 'lora', 'work-sans']);
  expect(initial.options.layouts).toEqual(['grid', 'list', 'carousel']);

  for (const [design, field] of [
    [{ fonts: { display: 'comic-sans' } }, 'design.fonts.display'],
    [{ colors: { accent: 'blue' } }, 'design.colors.accent'],
    [{ sections: [{ type: 'featured', layout: 'masonry' }] }, 'design.sections[0].layout'],
    [{ sections: [{ type: 'category' }] }, 'design.sections[0].categoryId'],
    [{ sections: [{ type: 'deals' }, { type: 'deals' }] }, 'design.sections[1]'],
    [{ theme: 'neon' }, 'design.theme'],
  ]) {
    expect((await json(await owner.put('/api/restaurant/menu-design', { design }), 400)).details.field).toBe(field);
  }
  await json(await owner.put('/api/restaurant/menu-design', {}), 400);

  // A category that's in the saved design and then deleted disappears from the resolved order.
  const temp = (await json(await owner.post('/api/restaurant/categories', { name: 'Specials' }), 200)).category;
  const saved = await json(await owner.put('/api/restaurant/menu-design', {
    design: {
      theme: 'midnight', fonts: { display: 'abril', body: 'inter', wingdings: true }, colors: { accent: '#ABC', background: '#ffffff' },
      header: { showSearch: false }, cards: { style: 'photo-side', showDescription: false }, footer: { tagline: 'Karibu!' },
      sections: [
        { type: 'category', categoryId: categories.Drinks, layout: 'grid', title: 'Cold drinks' },
        { type: 'category', categoryId: temp.id },
        { type: 'deals', visible: false, layout: 'list' },
      ],
      sparkles: 'yes',
    },
  }), 200);
  expect(saved.isDefault).toBe(false);
  expect(saved.design).not.toHaveProperty('sparkles');
  expect(saved.design.fonts).toEqual({ display: 'abril', body: 'inter' });
  expect(saved.design.colors).toEqual({ accent: '#aabbcc', background: '#ffffff' });
  expect(saved.design.header).toEqual({ showLogo: true, showSearch: false, showCover: true });
  expect(saved.resolved.theme).toBe('midnight');
  expect((await owner.delete(`/api/restaurant/categories/${temp.id}`)).status()).toBe(204);

  const after = await json(await owner.get('/api/restaurant/menu-design'), 200);
  expect(after.resolved.sections.map((s) => s.key)).toEqual(['featured', `category:${categories.Drinks}`, 'deals', `category:${categories.Mains}`, `category:${categories.Sides}`]);
  expect(after.resolved.sections[1]).toMatchObject({ title: 'Cold drinks', layout: 'grid', visible: true });
  expect(after.resolved.sections[2]).toMatchObject({ visible: false, layout: 'list', title: 'Pairs & deals' });
  expect(after.resolved.sections[3]).toMatchObject({ title: 'Mains', layout: 'list' });

  // The guest menu gets the same resolved design.
  const menu = await json(await guest(request, visitor('design')).get(menuPath()), 200);
  expect(menu.design.sections.map((s) => s.key)).toEqual(after.resolved.sections.map((s) => s.key));
  expect(menu.design.fonts).toEqual({ display: 'abril', body: 'inter' });
});

test('the public menu has merchandising, an ETag, and reflects edits immediately', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const phone = guest(request, visitor('menu'));
  const { items, extras, deals } = ctx;
  await json(await owner.patch(`/api/restaurant/extras/${extras.Bacon}`, { available: false }), 200);

  const response = await phone.get(`${menuPath()}?t=2`);
  const menu = await json(response, 200);
  const etag = response.headers().etag;
  expect(etag).toBeTruthy();
  expect(response.headers()['cache-control']).toBe('public, no-cache');
  expect(Object.keys(menu).sort()).toEqual(['categories', 'deals', 'design', 'featuredItemIds', 'items', 'restaurant', 'table']);
  expect(menu.table.number).toBe(2);
  expect(menu.featuredItemIds).toEqual([items['Grilled chicken'], items['Classic beef burger']]);
  const byId = Object.fromEntries(menu.items.map((i) => [i.id, i]));
  expect(byId[items['Whole tilapia']]).toBeUndefined();
  expect(byId[items['Classic beef burger']].extras.map((e) => e.name)).toEqual(['Make it a meal (fries + drink)', 'Cheese']); // Bacon is unavailable
  expect(byId[items['Classic beef burger']].extras[1]).toEqual({ id: extras.Cheese, name: 'Cheese', price: 150 });
  expect(byId[items['Grilled chicken']].pairedItemIds).toEqual([items.Chips]); // tilapia is sold out
  expect(byId[items['Classic beef burger']]).toMatchObject({ featured: true });
  // Only live deals, in the owner's order; flagged and scheduled ones are hidden.
  expect(menu.deals.map((d) => d.id)).toEqual([deals.forTwo, deals.burgerMeal]);
  expect(menu.deals[1]).toMatchObject({ name: 'Burger meal', price: 1150, regularPrice: 1320, saving: 170 });
  expect(menu.deals[1].items.map((i) => i.name)).toEqual(['Classic beef burger', 'Chips', 'Stoney tangawizi']);
  expect(Object.keys(menu.deals[1])).not.toContain('status');

  // Same content: 304 with the ETag.
  const again = await phone.get(`${menuPath()}?t=2`, { 'If-None-Match': etag });
  expect(again.status()).toBe(304);

  // An owner edit shows up on the very next request (the cache is invalidated), with a new ETag.
  await json(await owner.patch(`/api/restaurant/items/${items['Stoney tangawizi']}`, { price: 130 }), 200);
  const edited = await phone.get(`${menuPath()}?t=2`, { 'If-None-Match': etag });
  const editedMenu = await json(edited, 200);
  expect(edited.headers().etag).not.toBe(etag);
  expect(editedMenu.items.find((i) => i.id === items['Stoney tangawizi']).price).toBe(130);
  expect(editedMenu.deals.find((d) => d.id === deals.burgerMeal).regularPrice).toBe(1330);
  await json(await owner.patch(`/api/restaurant/items/${items['Stoney tangawizi']}`, { price: 120 }), 200);

  // Selling out a component hides the deals that contain it, and flags them for the owner.
  await json(await owner.patch(`/api/restaurant/items/${items.Chips}`, { available: false }), 200);
  expect((await json(await phone.get(menuPath()), 200)).deals).toEqual([]);
  const ownerDeals = await json(await owner.get('/api/restaurant/deals'), 200);
  expect(ownerDeals.deals.find((d) => d.id === deals.burgerMeal)).toMatchObject({ status: 'unavailable', visibleToGuests: false });
  await json(await owner.patch(`/api/restaurant/items/${items.Chips}`, { available: true }), 200);
  expect((await json(await phone.get(menuPath()), 200)).deals.map((d) => d.id)).toEqual([deals.forTwo, deals.burgerMeal]);

  // Featured changes and design resets are immediate too.
  await json(await owner.put('/api/restaurant/featured', { itemIds: [items['Classic beef burger']] }), 200);
  expect((await json(await phone.get(menuPath()), 200)).featuredItemIds).toEqual([items['Classic beef burger']]);
  await json(await owner.put('/api/restaurant/menu-design', { design: null }), 200);
  const reset = await json(await phone.get(menuPath()), 200);
  expect(reset.design.sections.map((s) => s.type)).toEqual(['featured', 'deals', 'category', 'category', 'category']);
  expect(reset.design.theme).toBe('midnight'); // saving a design theme also set the restaurant's theme
});

test('carts and orders price extras and deals from the menu and snapshot them', async ({ request }) => {
  const phone = guest(request, visitor('cart'));
  const waiter = as(request, ctx.waiterToken);
  const owner = as(request, ctx.ownerToken);
  const { restaurantId, items, extras, deals } = ctx;
  const lines = [
    { itemId: items['Classic beef burger'], quantity: 2, extraIds: [extras.Cheese], note: 'No onions' },
    { dealId: deals.burgerMeal, quantity: 1 },
    { itemId: items['Stoney tangawizi'] },
  ];
  const saved = await json(await phone.post('/api/public/carts', { restaurantId, tableNumber: 1, items: lines }), 200);
  expect(saved.total).toBe(3470); // (950 + 150) × 2 + 1150 + 120
  expect(saved.items.map((l) => [l.kind, l.name, l.unitPrice, l.extrasTotal, l.unitTotal, l.quantity, l.lineTotal])).toEqual([
    ['item', 'Classic beef burger', 950, 150, 1100, 2, 2200], ['deal', 'Burger meal', 1150, 0, 1150, 1, 1150], ['item', 'Stoney tangawizi', 120, 0, 120, 1, 120],
  ]);
  expect(saved.items[0].extras).toEqual([{ id: extras.Cheese, name: 'Cheese', price: 150 }]);
  expect(saved.items[1].components.map((c) => [c.name, c.quantity])).toEqual([['Classic beef burger', 1], ['Chips', 1], ['Stoney tangawizi', 1]]);

  // Invalid lines.
  expect((await json(await phone.post('/api/public/carts', { restaurantId, items: [{ itemId: items['Classic beef burger'], extraIds: [extras.Bacon] }] }), 409)).details.reason).toBe('extra_sold_out');
  expect((await json(await phone.post('/api/public/carts', { restaurantId, items: [{ itemId: items.Chips, extraIds: [extras.Cheese] }] }), 400)).details.reason).toBe('extra_missing');
  expect((await json(await phone.post('/api/public/carts', { restaurantId, items: [{ dealId: deals.flagged }] }), 409)).details.reason).toBe('sold_out');
  expect((await json(await phone.post('/api/public/carts', { restaurantId, items: [{ dealId: deals.scheduled }] }), 409)).details.reason).toBe('deal_unavailable');
  expect((await json(await phone.post('/api/public/carts', { restaurantId, items: [{ dealId: NOWHERE }] }), 400)).details.reason).toBe('missing');
  await json(await phone.post('/api/public/carts', { restaurantId, items: [{ dealId: deals.burgerMeal, extraIds: [extras.Cheese] }] }), 400);
  await json(await phone.post('/api/public/carts', { restaurantId, items: [{ itemId: items.Chips, extraIds: 'cheese' }] }), 400);

  // "Table 1 is ready to order" on the live screen is priced with the extras and the deal.
  const live = await json(await waiter.get('/api/ops/live'), 200);
  expect(live.readyToOrder.find((entry) => entry.tableNumber === 1)).toMatchObject({ tableNumber: 1, itemCount: 4, total: 3470 });

  // The waiter's lookup shows extras and deal components; confirming snapshots them on the order.
  const { cart } = await json(await waiter.get(`/api/ops/carts/${saved.code}`), 200);
  expect(cart).toMatchObject({ total: 3470, hasUnavailableItems: false });
  expect(cart.items[0].extras[0].name).toBe('Cheese');
  expect(cart.items[1]).toMatchObject({ kind: 'deal', dealId: deals.burgerMeal, available: true });
  const order = (await json(await waiter.post('/api/ops/orders', { cartCode: saved.code, via: 'scan' }), 200)).order;
  expect(order).toMatchObject({ total: 3470, status: 'taken', statusLabel: 'Confirmed', nextAction: 'serve' });
  expect(order.items.map((l) => [l.kind, l.name, l.lineTotal, l.note])).toEqual([
    ['item', 'Classic beef burger', 2200, 'No onions'], ['deal', 'Burger meal', 1150, null], ['item', 'Stoney tangawizi', 120, null],
  ]);
  expect(order.items[0]).toMatchObject({ extras: [{ id: extras.Cheese, name: 'Cheese', price: 150 }], extrasTotal: 150, unitTotal: 1100, components: null });
  expect(order.items[1]).toMatchObject({ dealId: deals.burgerMeal, itemId: null, extras: [] });
  expect(order.items[1].components).toEqual([
    { itemId: items['Classic beef burger'], name: 'Classic beef burger', quantity: 1, unitPrice: 950 },
    { itemId: items.Chips, name: 'Chips', quantity: 1, unitPrice: 250 },
    { itemId: items['Stoney tangawizi'], name: 'Stoney tangawizi', quantity: 1, unitPrice: 120 },
  ]);
  ctx.cartOrder = order.id;

  // Later price changes don't touch the order's snapshot.
  await json(await owner.patch(`/api/restaurant/extras/${extras.Cheese}`, { price: 999 }), 200);
  const reread = (await json(await waiter.get(`/api/ops/orders/${order.id}`), 200)).order;
  expect(reread.items[0].extras[0].price).toBe(150);
  expect(reread.total).toBe(3470);
  await json(await owner.patch(`/api/restaurant/extras/${extras.Cheese}`, { price: 150 }), 200);

  // Staff can enter deals directly; plain lines without extras still work as before.
  const manual = (await json(await waiter.post('/api/ops/orders', {
    tableNumber: 3, items: [{ itemId: items['Grilled chicken'], quantity: 1 }, { dealId: deals.forTwo, quantity: 1, note: 'Share plates' }],
  }), 200)).order;
  expect(manual.total).toBe(2750);
  expect(manual.items[1]).toMatchObject({ kind: 'deal', name: 'Chicken & chips for two', note: 'Share plates', lineTotal: 1900 });
  ctx.manualOrder = manual.id;

  // An imported cart whose extra sold out meanwhile is flagged for the waiter.
  const second = await json(await guest(request, visitor('cart2')).post('/api/public/carts', { restaurantId, items: [{ itemId: items['Classic beef burger'], extraIds: [extras.Cheese] }] }), 200);
  await json(await owner.patch(`/api/restaurant/extras/${extras.Cheese}`, { available: false }), 200);
  const flagged = (await json(await waiter.get(`/api/ops/carts/${second.code}`), 200)).cart;
  expect(flagged).toMatchObject({ hasUnavailableItems: true, total: 0 });
  expect(flagged.items[0]).toMatchObject({ available: false, unavailableReason: 'extra_unavailable', name: 'Classic beef burger' });
  await json(await owner.patch(`/api/restaurant/extras/${extras.Cheese}`, { available: true }), 200);
});

test('menu events are accepted at once, validated and deduped per visitor', async ({ request }) => {
  const { restaurantId, items, deals } = ctx;
  const count = async () => {
    const { count: n, error } = await service.from('menu_events').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId);
    if (error) throw error;
    return n;
  };
  const start = await count();
  const batch = {
    restaurantId, tableNumber: 1,
    events: [
      { type: 'dish_view', itemId: items['Classic beef burger'] },
      { type: 'dish_view', itemId: items['Classic beef burger'] }, // duplicate in the same batch
      { type: 'video_play', itemId: items['Classic beef burger'], at: new Date(Date.now() - 5000).toISOString() },
      { type: 'deal_view', dealId: deals.burgerMeal },
      { type: 'dish_view', itemId: NOWHERE }, // not this restaurant's: ignored in SQL
      { type: 'dish_like', itemId: items.Chips }, // unknown type: dropped
      { type: 'deal_view', itemId: items.Chips }, // wrong target: dropped
    ],
  };
  const phone = guest(request, visitor('events-a'));
  expect(await json(await phone.post('/api/public/events', batch), 202)).toEqual({ accepted: 5, dropped: 2 });
  await expect.poll(count, { timeout: 10000 }).toBe(start + 3);
  await json(await phone.post('/api/public/events', batch), 202); // same visitor within 10 minutes: deduped
  await json(await guest(request, visitor('events-b')).post('/api/public/events', batch), 202); // another visitor counts
  await expect.poll(count, { timeout: 10000 }).toBe(start + 6);
  const { data: rows } = await service.from('menu_events').select('visitor_id, table_id').eq('restaurant_id', restaurantId).limit(1);
  expect(rows[0].visitor_id).not.toContain('events-a'); // stored hashed
  expect(rows[0].table_id).toBeTruthy();

  await json(await phone.post('/api/public/events', { restaurantId, events: Array.from({ length: 51 }, () => ({ type: 'dish_view', itemId: items.Chips })) }), 400);
  await json(await phone.post('/api/public/events', { events: [] }), 400);
  await json(await phone.post('/api/public/events', { restaurantId, events: 'x' }), 400);
});

test('analytics over 90 days has KPIs, busy hours, dish performance and a summary', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const { items, deals } = ctx;
  // A scan now, so the busiest hour has both scans and orders.
  await json(await guest(request, visitor('analytics')).get(`${menuPath()}?t=1`), 200);
  await expect.poll(async () => (await json(await owner.get('/api/ops/analytics?range=90d'), 200)).kpis.menuScans.value, { timeout: 10000 }).toBeGreaterThan(0);

  const report = await json(await owner.get('/api/ops/analytics?range=90d'), 200);
  expect(report).toMatchObject({ range: '90d', seriesUnit: 'day', timeZone: 'Africa/Nairobi' });
  expect(report.series).toHaveLength(90);
  expect(report.kpis.orders).toMatchObject({ value: 2, previous: 0, isNew: true, deltaPercent: null });
  expect(report.kpis.dishViews.value).toBeGreaterThanOrEqual(2);
  expect(report.kpis.viewsPerScan.value).toBeGreaterThan(0);
  expect(report.kpis.averageOrder.basis).toMatch(/paid/i);
  expect(report.kpis.paidSales).toMatchObject({ value: 0, previous: 0, isNew: false });

  const hour = Number(new Date(Date.now() + 3 * 3600000).toISOString().slice(11, 13));
  expect(report.busyHours.hours).toHaveLength(24);
  expect(report.busyHours.hours[hour].orders).toBeGreaterThanOrEqual(2);
  expect(report.busyHours.peakHour).toMatchObject({ hour, label: `${String(hour).padStart(2, '0')}:00` });
  expect(report.busyHours.peakBy).toBe('orders');
  expect(report.summary).toMatch(new RegExp(`^\\d+ menu scans? led to 2 orders; the busiest hour is ${String(hour).padStart(2, '0')}:00\\.$`));

  const perf = Object.fromEntries(report.dishPerformance.map((row) => [row.id, row]));
  // Burger: 2 sold on their own (with cheese) + 1 inside the Burger meal; the deal's 1150 is split by regular price.
  expect(perf[items['Classic beef burger']]).toMatchObject({
    kind: 'item', directQuantity: 2, dealQuantity: 1, orderedQuantity: 3, directSales: 2200, dealSales: 827.65, sales: 3027.65,
    views: 2, videoPlays: 2, categoryName: 'Mains',
  });
  // Chips: 1 in the Burger meal + 2 in Chicken & chips for two.
  expect(perf[items.Chips]).toMatchObject({ directQuantity: 0, dealQuantity: 3 });
  expect(perf[deals.burgerMeal]).toMatchObject({ kind: 'deal', dealId: deals.burgerMeal, orderedQuantity: 1, sales: 1150, views: 2 });
  expect(perf[items['Whole tilapia']]).toMatchObject({ orderedQuantity: 0, sales: 0, available: false });
  expect(report.dishPerformance[0].sales).toBeGreaterThanOrEqual(report.dishPerformance[1].sales);

  const byViews = await json(await owner.get('/api/ops/analytics?range=90d&sort=views&dir=desc'), 200);
  expect(byViews.dishPerformanceSort).toEqual({ sort: 'views', dir: 'desc' });
  expect(byViews.dishPerformance[0].views).toBe(Math.max(...byViews.dishPerformance.map((r) => r.views)));
  await json(await owner.get('/api/ops/analytics?range=90d&sort=vibes'), 400);
  await json(await owner.get('/api/ops/analytics?range=365d'), 400);
  await json(await as(request, ctx.waiterToken).get('/api/ops/analytics?range=90d'), 403);

  // The owner's menu cards carry the same 30-day numbers.
  const menu = await json(await owner.get('/api/restaurant/menu'), 200);
  expect(menu.items.find((i) => i.id === items['Classic beef burger']).stats30d).toMatchObject({ views: 2, videoPlays: 2, orderedQuantity: 3 });
  expect(menu.deals.find((d) => d.id === deals.burgerMeal).stats30d).toMatchObject({ orderedQuantity: 1, sales: 1150 });

  // Today keeps its existing shape and fields.
  const today = await json(await owner.get('/api/ops/analytics'), 200);
  expect(today).toMatchObject({ range: 'today', seriesUnit: 'hour' });
  expect(Object.keys(today)).toEqual(expect.arrayContaining(['totals', 'previousTotals', 'series', 'bestSellers', 'soldOut', 'topTablesByScans', 'topTablesByRevenue', 'kpis', 'busyHours', 'dishPerformance', 'summary']));
});

test('deleting a dish removes it from deals and pairings, and the guest menu follows', async ({ request }) => {
  const owner = as(request, ctx.ownerToken);
  const { items, deals } = ctx;
  expect((await owner.delete(`/api/restaurant/items/${items['Stoney tangawizi']}`)).status()).toBe(204);
  const deal = (await json(await owner.get(`/api/restaurant/deals/${deals.burgerMeal}`), 200)).deal;
  expect(deal.items.map((i) => i.name)).toEqual(['Classic beef burger', 'Chips']);
  expect(deal.regularPrice).toBe(1200);
  const menu = await json(await guest(request, visitor('after-delete')).get(menuPath()), 200);
  expect(menu.items.map((i) => i.id)).not.toContain(items['Stoney tangawizi']);
  expect(menu.deals.find((d) => d.id === deals.burgerMeal).items).toHaveLength(2);
  // The order taken earlier keeps its snapshot.
  const order = (await json(await as(request, ctx.waiterToken).get(`/api/ops/orders/${ctx.cartOrder}`), 200)).order;
  expect(order.items[2]).toMatchObject({ name: 'Stoney tangawizi', itemId: null });
  expect(order.items[1].components[2].name).toBe('Stoney tangawizi');
  expect((await owner.delete(`/api/restaurant/deals/${deals.scheduled}`)).status()).toBe(204);
  await json(await owner.get(`/api/restaurant/deals/${deals.scheduled}`), 404);
});
