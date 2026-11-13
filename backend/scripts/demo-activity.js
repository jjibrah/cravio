// Realistic menu and activity for owner@gmail.com's "Demo Restaurant" only. Called by seed-users.js.
// Idempotent: menu rows are upserted by name, and all demo activity (orders, items, payments, guest requests,
// menu scans, menu events, guest carts) is deleted and regenerated relative to "now" on every run.
// With migration 004 applied it also (re)creates pairings, extras, featured dishes and deals, puts extras and
// deals into some orders, and logs ~1,500 dish views, video plays and deal views consistent with the scans.
// History covers 90 days with lunch (12–14) and dinner (19–21) peaks and a gentle upward trend.
// Orders follow the agreed flow (docs/ORDER-FLOW.md): confirmed with the guest (taken) -> served -> paid, with no
// accepted stage. With migration 005 applied each order records how it was confirmed (mostly the guest's QR,
// some typed codes, a few entered by hand), and two guest carts are "ready to order".
import { randomUUID, createHash } from 'node:crypto';
import { CART_ALPHABET, hasConfirmationSchema, nairobiMidnight } from '../src/lib/operations.js';
import { hasMerchSchema } from '../src/lib/menu-merch.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const SECTIONS = [{ name: 'Indoor', tables: [1, 2, 3, 4, 5, 6, 7, 8] }, { name: 'Terrace', tables: [9, 10, 11, 12] }];
const MENU = [
  { category: 'Mains', items: [
    { name: 'Nyama choma', price: 950, description: 'Goat ribs slow-roasted over charcoal, with kachumbari.' },
    { name: 'Chicken wings', price: 750, description: 'Peri-peri wings, chilli lime dip.' },
    { name: 'Pilau ya nyama', price: 650, description: 'Spiced Swahili rice with tender beef.' },
    { name: 'Ugali & beef stew', price: 550, description: 'Ugali, slow-cooked beef stew and sukuma wiki.' },
    { name: 'Whole tilapia', price: 1200, description: 'Fried Lake Victoria tilapia with ugali.', available: false },
    { name: 'Chicken biryani', price: 800, description: 'Mombasa-style biryani with raita.' },
    { name: 'Grilled chicken', price: 850, description: 'Quarter chicken off the charcoal, lemon and chilli.' },
    { name: 'Classic beef burger', price: 950, description: 'Beef patty, tomato, lettuce and house sauce in a brioche bun.' },
  ] },
  { category: 'Sides', items: [
    { name: 'Kachumbari', price: 150, description: 'Tomato, onion and coriander salad.' },
    { name: 'Chapati (2 pcs)', price: 100, description: 'Soft layered flatbread.' },
    { name: 'Beef samosa (3 pcs)', price: 250, description: 'Crisp pastry, spiced minced beef.' },
    { name: 'Bhajia', price: 350, description: 'Potato fritters, tamarind sauce.', available: false },
    { name: 'Chips', price: 250, description: 'Hand-cut fries, sea salt.' },
    { name: 'Mandazi (3 pcs)', price: 150, description: 'Coconut and cardamom doughnuts, warm.' },
  ] },
  { category: 'Drinks', items: [
    { name: 'Kenyan chai', price: 150, description: 'Spiced milk tea.' },
    { name: 'Fresh passion juice', price: 250, description: 'Pressed to order.' },
    { name: 'Tusker lager', price: 350, description: '500 ml, ice cold.' },
    { name: 'Stoney tangawizi', price: 120, description: 'Ginger soda, 300 ml.' },
  ] },
];
const NOTES = ['No onions', 'Extra spicy', 'Well done', 'Less salt', 'No ice', 'Sauce on the side'];
const HISTORY_DAYS = 90;

/* Merchandising (migration 004). Names refer to MENU above. */
const PAIRINGS = [
  ['Chips', 'Grilled chicken'], ['Grilled chicken', 'Chips'],
  ['Kachumbari', 'Nyama choma'], ['Nyama choma', 'Kachumbari'],
  ['Kenyan chai', 'Mandazi (3 pcs)'], ['Mandazi (3 pcs)', 'Kenyan chai'],
  ['Classic beef burger', 'Chips'], ['Classic beef burger', 'Stoney tangawizi'],
  ['Nyama choma', 'Tusker lager'], ['Nyama choma', 'Chapati (2 pcs)'],
  ['Chicken wings', 'Tusker lager'], ['Chicken wings', 'Chips'],
  ['Pilau ya nyama', 'Kachumbari'], ['Chicken biryani', 'Fresh passion juice'],
];
const EXTRAS = {
  'Classic beef burger': [['Cheese', 150], ['Bacon', 200], ['Make it a meal (fries + drink)', 450]],
  'Grilled chicken': [['Extra peri-peri sauce', 50], ['Swap to ugali', 0]],
  'Nyama choma': [['Extra kachumbari', 100], ['Ugali', 100]],
  Chips: [['Cheese sauce', 100], ['Masala spice', 50]],
  'Kenyan chai': [['Extra ginger', 20]],
};
const FEATURED = ['Nyama choma', 'Classic beef burger', 'Grilled chicken', 'Chicken biryani', 'Fresh passion juice'];
const DEALS = [
  { name: 'Burger meal', description: 'Classic beef burger, chips and a Stoney.', price: 1150,
    items: [['Classic beef burger', 1], ['Chips', 1], ['Stoney tangawizi', 1]] },
  { name: 'Nyama choma for two', description: 'Goat ribs for two with kachumbari, chapati and two Tuskers.', price: 2500,
    items: [['Nyama choma', 2], ['Kachumbari', 1], ['Chapati (2 pcs)', 1], ['Tusker lager', 2]] },
  { name: 'Chai & mandazi', description: 'The morning classic.', price: 250,
    items: [['Kenyan chai', 1], ['Mandazi (3 pcs)', 1]] },
];
/** Relative orders per hour of the day (Nairobi): breakfast trickle, lunch 12–14, dinner 19–21. */
const HOUR_WEIGHTS = { 8: 3, 9: 4, 10: 3, 11: 4, 12: 9, 13: 11, 14: 7, 15: 3, 16: 3, 17: 4, 18: 6, 19: 12, 20: 15, 21: 8 };

/** Small deterministic PRNG, so every run has the same shape (times shift with "now"). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const must = (result, what) => { if (result.error) throw Object.assign(new Error(`${what}: ${result.error.message}`), { code: result.error.code }); return result.data; };

async function insertAll(db, table, rows, what) {
  for (let index = 0; index < rows.length; index += 500) must(await db.from(table).insert(rows.slice(index, index + 500)), what);
}

/** Sections, 12 tables and a Kenyan menu with prices. Keeps photos and any extra items the owner added. */
async function seedMenu(db, restaurantId) {
  const existingSections = must(await db.from('restaurant_sections').select('id, name').eq('restaurant_id', restaurantId), 'Demo sections');
  const sectionIds = {};
  for (const [position, section] of SECTIONS.entries()) {
    const found = existingSections.find((row) => row.name.toLowerCase() === section.name.toLowerCase());
    sectionIds[section.name] = found?.id || must(await db.from('restaurant_sections')
      .insert({ restaurant_id: restaurantId, name: section.name, position }).select('id').single(), 'Demo section').id;
  }
  must(await db.from('restaurant_tables').upsert(
    Array.from({ length: 12 }, (_, index) => ({ restaurant_id: restaurantId, number: index + 1 })),
    { onConflict: 'restaurant_id,number', ignoreDuplicates: true },
  ), 'Demo tables');
  for (const section of SECTIONS) {
    must(await db.from('restaurant_tables').update({ section_id: sectionIds[section.name] })
      .eq('restaurant_id', restaurantId).in('number', section.tables), 'Demo table sections');
  }
  const tables = must(await db.from('restaurant_tables').select('id, number').eq('restaurant_id', restaurantId).order('number'), 'Demo tables');

  const categories = must(await db.from('menu_categories').select('id, name').eq('restaurant_id', restaurantId), 'Demo categories');
  const items = [];
  for (const [position, group] of MENU.entries()) {
    let category = categories.find((row) => row.name.toLowerCase() === group.category.toLowerCase());
    if (category) must(await db.from('menu_categories').update({ position }).eq('id', category.id), 'Demo category order');
    else category = must(await db.from('menu_categories').insert({ restaurant_id: restaurantId, name: group.category, position }).select('id, name').single(), 'Demo category');
    const existing = must(await db.from('menu_items').select('id, name').eq('restaurant_id', restaurantId), 'Demo items');
    for (const [itemPosition, item] of group.items.entries()) {
      const fields = { category_id: category.id, name: item.name, price: item.price, description: item.description, position: itemPosition, available: item.available !== false };
      const found = existing.find((row) => row.name.toLowerCase() === item.name.toLowerCase());
      const saved = found
        ? must(await db.from('menu_items').update(fields).eq('id', found.id).select('id, name, price, available').single(), 'Demo item')
        : must(await db.from('menu_items').insert({ ...fields, restaurant_id: restaurantId }).select('id, name, price, available').single(), 'Demo item');
      items.push({ ...saved, category: group.category, price: Number(saved.price) });
    }
  }
  return { tables, items };
}

/** Pairings, extras, featured dishes and deals, replaced on every run. Returns lookups for the activity. */
async function seedMerch(db, restaurantId, items) {
  const byName = new Map(items.map((item) => [item.name, item]));
  const id = (name) => {
    const item = byName.get(name);
    if (!item) throw new Error(`Demo merchandising refers to a missing dish: ${name}`);
    return item.id;
  };
  for (const table of ['menu_item_pairings', 'menu_item_extras', 'menu_deals']) {
    must(await db.from(table).delete().eq('restaurant_id', restaurantId), `Clear demo ${table}`);
  }
  const positions = new Map();
  must(await db.from('menu_item_pairings').insert(PAIRINGS.map(([from, to]) => {
    const position = positions.get(from) || 0;
    positions.set(from, position + 1);
    return { restaurant_id: restaurantId, item_id: id(from), paired_item_id: id(to), position };
  })), 'Demo pairings');
  const extras = must(await db.from('menu_item_extras').insert(Object.entries(EXTRAS).flatMap(([dish, list]) => list.map(([name, price], position) => ({
    restaurant_id: restaurantId, item_id: id(dish), name, price, position,
  })))).select('id, item_id, name, price'), 'Demo extras');
  must(await db.from('menu_items').update({ featured: false, featured_position: null }).eq('restaurant_id', restaurantId), 'Demo unfeature');
  for (const [position, name] of FEATURED.entries()) {
    must(await db.from('menu_items').update({ featured: true, featured_position: position }).eq('id', id(name)), 'Demo featured');
  }
  const deals = [];
  for (const [position, deal] of DEALS.entries()) {
    const row = must(await db.from('menu_deals').insert({
      restaurant_id: restaurantId, name: deal.name, description: deal.description, price: deal.price, position, active: true,
    }).select('id, name, price').single(), 'Demo deal');
    must(await db.from('menu_deal_items').insert(deal.items.map(([name, quantity], index) => ({
      deal_id: row.id, restaurant_id: restaurantId, item_id: id(name), quantity, position: index,
    }))), 'Demo deal items');
    const components = deal.items.map(([name, quantity]) => ({ itemId: id(name), name, quantity, unitPrice: byName.get(name).price }));
    const regular = components.reduce((sum, c) => sum + c.unitPrice * c.quantity, 0);
    deals.push({ id: row.id, name: row.name, price: Number(row.price), components, saving: regular - Number(row.price) });
  }
  const extrasByItem = new Map();
  for (const extra of extras) extrasByItem.set(extra.item_id, [...(extrasByItem.get(extra.item_id) || []), { id: extra.id, name: extra.name, price: Number(extra.price) }]);
  return { deals, extrasByItem, featuredIds: FEATURED.map(id), pairings: PAIRINGS.length, extras: extras.length };
}

/**
 * @param db service-role client
 * @param staff { ownerId, waiterId }
 * @returns summary counts for the console
 */
export async function seedDemoActivity(db, restaurantId, { ownerId, waiterId }) {
  const { tables, items } = await seedMenu(db, restaurantId);
  const tableByNumber = new Map(tables.map((t) => [t.number, t]));
  const merchInstalled = await hasMerchSchema(db);
  const flowInstalled = await hasConfirmationSchema(db);

  // Wipe previous demo activity (order_items and payments cascade from orders).
  for (const table of ['service_requests', 'menu_scans', ...(merchInstalled ? ['menu_events'] : []), 'guest_carts', 'orders']) {
    must(await db.from(table).delete().eq('restaurant_id', restaurantId), `Clear demo ${table}`);
  }
  const merch = merchInstalled ? await seedMerch(db, restaurantId, items) : null;

  const random = prng(20261112);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (min, max) => min + random() * (max - min);
  const int = (min, max) => Math.floor(between(min, max + 1));
  const now = Date.now();
  const visitor = () => createHash('sha256').update(`demo-visitor:${random()}`).digest('hex').slice(0, 32);

  const mains = items.filter((i) => i.category === 'Mains');
  const sides = items.filter((i) => i.category === 'Sides');
  const drinks = items.filter((i) => i.category === 'Drinks');
  const orders = [];
  const lines = [];
  const payments = [];
  const scans = [];
  const requests = [];

  /** Builds an order with 1–4 lines; `stages` holds the times (ms) for each stage reached. */
  function addOrder({ table, stages, status, takenBy = random() < 0.75 ? waiterId : ownerId, confirmation, availableOnly = false }) {
    const pool = (list) => (availableOnly ? list.filter((i) => i.available) : list);
    const chosen = new Map();
    chosen.set(pick(pool(mains)).id, null);
    if (random() < 0.8) chosen.set(pick(pool(drinks)).id, null);
    if (random() < 0.45) chosen.set(pick(pool(sides)).id, null);
    if (random() < 0.25) chosen.set(pick(pool(mains)).id, null);
    const id = randomUUID();
    let cents = 0;
    let position = 0;
    [...chosen.keys()].forEach((itemId) => {
      const item = items.find((i) => i.id === itemId);
      const quantity = item.category === 'Drinks' ? int(1, 4) : int(1, 2);
      // Some guests add an extra (cheese on the burger, sauce on the chicken).
      const options = merch?.extrasByItem.get(item.id) || [];
      const extras = options.length && random() < 0.35 ? [pick(options)] : [];
      const unit = Math.round(item.price * 100);
      const add = extras.reduce((sum, extra) => sum + Math.round(extra.price * 100), 0);
      cents += (unit + add) * quantity;
      lines.push({
        order_id: id, restaurant_id: restaurantId, item_id: item.id, name: item.name, unit_price: item.price, quantity,
        note: random() < 0.12 ? pick(NOTES) : null, line_total: ((unit + add) * quantity) / 100, position: position++, created_at: new Date(stages.taken).toISOString(),
        ...(merch ? { kind: 'item', extras } : {}),
      });
    });
    // About one order in eight includes a deal.
    if (merch && random() < 0.13) {
      const deal = pick(merch.deals);
      const quantity = random() < 0.85 ? 1 : 2;
      const unit = Math.round(deal.price * 100);
      cents += unit * quantity;
      lines.push({
        order_id: id, restaurant_id: restaurantId, item_id: null, name: deal.name, unit_price: deal.price, quantity, note: null,
        line_total: (unit * quantity) / 100, position: position++, created_at: new Date(stages.taken).toISOString(),
        kind: 'deal', deal_id: deal.id, extras: [], components: deal.components,
      });
    }
    const at = (key) => (stages[key] ? new Date(stages[key]).toISOString() : null);
    const by = (key, who) => (stages[key] ? who : null);
    const staffer = () => (random() < 0.8 ? waiterId : ownerId);
    const last = Math.max(...Object.values(stages));
    // Mostly the guest's QR, some typed codes, a few entered by hand for guests without a phone.
    const how = confirmation || (random() < 0.8 ? 'qr' : random() < 0.6 ? 'code' : 'manual');
    // Before migration 005 the database still requires an accepted time on served and paid orders: use the
    // serving time, as the API does.
    const acceptedAt = flowInstalled ? null : stages.served;
    orders.push({
      id, restaurant_id: restaurantId, table_id: table.id, table_number: table.number, status,
      taken_by: takenBy, taken_at: at('taken'),
      accepted_by: acceptedAt ? by('served', takenBy) : null, accepted_at: acceptedAt ? new Date(acceptedAt).toISOString() : null,
      served_by: by('served', staffer()), served_at: at('served'),
      paid_by: by('paid', staffer()), paid_at: at('paid'),
      cancelled_by: by('cancelled', ownerId), cancelled_at: at('cancelled'),
      cancel_reason: stages.cancelled ? pick(['Guest left', 'Entered twice', 'Changed their mind']) : null,
      note: random() < 0.08 ? 'Birthday at this table' : null,
      subtotal: cents / 100, total: cents / 100, currency: 'KES', source: how === 'manual' ? 'waiter' : 'guest_cart',
      ...(flowInstalled ? { confirmation: how } : {}),
      created_at: at('taken'), updated_at: new Date(last).toISOString(),
    });
    const order = orders[orders.length - 1];
    if (status === 'paid') {
      const method = random() < 0.6 ? 'mpesa' : random() < 0.6 ? 'cash' : 'card';
      const reference = method === 'mpesa' ? `S${Array.from({ length: 9 }, () => pick([...'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'])).join('')}`
        : method === 'card' ? `CARD-${int(1000, 9999)}` : null;
      payments.push({
        restaurant_id: restaurantId, order_id: id, provider: 'manual', provider_reference: reference, method, status: 'succeeded',
        amount: order.total, currency: 'KES', recorded_by: order.paid_by, created_at: order.paid_at, confirmed_at: order.paid_at, updated_at: order.paid_at,
      });
    }
    // Most orders follow a guest opening the menu at that table a few minutes earlier.
    if (random() < 0.85) scans.push({ restaurant_id: restaurantId, table_id: table.id, visitor_id: visitor(), created_at: new Date(stages.taken - between(2, 12) * MINUTE).toISOString() });
    return order;
  }

  /** A time on day `dayStart` drawn from the hour weights. */
  const totalWeight = Object.values(HOUR_WEIGHTS).reduce((a, b) => a + b, 0);
  const busyTime = (dayStart) => {
    let roll = random() * totalWeight;
    for (const [hour, weight] of Object.entries(HOUR_WEIGHTS)) {
      roll -= weight;
      if (roll <= 0) return dayStart + (Number(hour) + random()) * HOUR;
    }
    return dayStart + 20.5 * HOUR;
  };

  // History: the last 89 days plus today up to an hour ago. Busier on Fridays and Saturdays, and growing:
  // the oldest weeks have about three quarters of today's traffic.
  for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 0; daysAgo--) {
    const dayStart = nairobiMidnight(new Date(now), daysAgo).getTime();
    const weekday = new Date(dayStart + 3 * HOUR).getUTCDay(); // 5 = Friday, 6 = Saturday in Nairobi
    const trend = 0.75 + 0.25 * (1 - daysAgo / HISTORY_DAYS);
    const count = Math.round((int(9, 14) + (weekday === 5 || weekday === 6 ? 4 : 0)) * trend);
    for (let index = 0; index < count; index++) {
      const taken = busyTime(dayStart);
      const served = taken + between(12, 30) * MINUTE;
      const paid = served + between(15, 50) * MINUTE;
      if (paid > now - 20 * MINUTE) continue;
      const table = tableByNumber.get(int(1, 12));
      if (random() < 0.07) {
        const cancelledEarly = random() < 0.6;
        addOrder({ table, status: 'cancelled', stages: { taken, cancelled: taken + (cancelledEarly ? between(3, 9) : between(8, 20)) * MINUTE } });
      } else {
        addOrder({ table, status: 'paid', stages: { taken, served, paid } });
      }
    }
    // Guests browsing without ordering, at the same busy times.
    for (let index = Math.round(int(10, 18) * trend); index > 0; index--) {
      const at = busyTime(dayStart) - between(0, 30) * MINUTE;
      if (at < now) scans.push({ restaurant_id: restaurantId, table_id: pick(tables).id, visitor_id: visitor(), created_at: new Date(at).toISOString() });
    }
    // Requests that were handled.
    for (let index = int(2, 5); index > 0; index--) {
      const at = busyTime(dayStart);
      if (at > now - 30 * MINUTE) continue;
      const acknowledged = at + between(0.5, 3) * MINUTE;
      requests.push({
        restaurant_id: restaurantId, table_id: pick(tables).id, type: pick(['call_waiter', 'call_waiter', 'bill', 'payment']), status: 'resolved',
        created_at: new Date(at).toISOString(), acknowledged_by: waiterId, acknowledged_at: new Date(acknowledged).toISOString(),
        resolved_by: waiterId, resolved_at: new Date(acknowledged + between(2, 8) * MINUTE).toISOString(), updated_at: new Date(acknowledged + 8 * MINUTE).toISOString(),
      });
    }
  }

  // Live right now: four confirmed with the guest and waiting to be served (one entered by hand), two served and
  // waiting to pay. No order is `accepted`: that stage is gone.
  const ago = (minutes) => now - minutes * MINUTE;
  const live = [
    { number: 2, status: 'taken', stages: { taken: ago(3) }, confirmation: 'qr' },
    { number: 5, status: 'taken', stages: { taken: ago(6) }, confirmation: 'manual' },
    { number: 4, status: 'taken', stages: { taken: ago(14) }, confirmation: 'code' },
    { number: 9, status: 'taken', stages: { taken: ago(21) }, confirmation: 'qr' },
    { number: 7, status: 'served', stages: { taken: ago(48), served: ago(27) }, confirmation: 'qr' },
    { number: 11, status: 'served', stages: { taken: ago(62), served: ago(36) }, confirmation: 'code' },
  ];
  for (const order of live) {
    addOrder({ table: tableByNumber.get(order.number), status: order.status, stages: order.stages, confirmation: order.confirmation, takenBy: waiterId, availableOnly: true });
    scans.push({ restaurant_id: restaurantId, table_id: tableByNumber.get(order.number).id, visitor_id: visitor(), created_at: new Date(order.stages.taken - 4 * MINUTE).toISOString() });
  }
  // Open guest requests right now: the "needs attention" feed.
  const openRequests = [
    { number: 7, type: 'bill', status: 'open', created: ago(2) },
    { number: 11, type: 'payment', status: 'acknowledged', created: ago(6), acknowledged: ago(5) },
    { number: 4, type: 'call_waiter', status: 'open', created: ago(3) },
    { number: 1, type: 'call_waiter', status: 'open', created: ago(1) },
  ];
  for (const request of openRequests) {
    requests.push({
      restaurant_id: restaurantId, table_id: tableByNumber.get(request.number).id, type: request.type, status: request.status,
      created_at: new Date(request.created).toISOString(), updated_at: new Date(request.acknowledged || request.created).toISOString(),
      acknowledged_by: request.acknowledged ? waiterId : null, acknowledged_at: request.acknowledged ? new Date(request.acknowledged).toISOString() : null,
    });
  }

  // Menu events: while browsing, about 4 in 10 guests open one or two dish sheets (featured dishes more often),
  // some play the dish video, and some open a deal. Same visitor as the scan, a few minutes after it.
  const events = [];
  if (merch) {
    const visible = items.filter((i) => i.available);
    const featured = visible.filter((i) => merch.featuredIds.includes(i.id));
    for (const scan of scans) {
      const opened = Date.parse(scan.created_at);
      if (random() < 0.45) {
        const seen = new Set();
        for (let n = random() < 0.5 ? 1 : 2; n > 0; n--) {
          const item = random() < 0.45 ? pick(featured) : pick(visible);
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const at = Math.min(now - MINUTE, opened + between(0.5, 8) * MINUTE);
          events.push({ restaurant_id: restaurantId, type: 'dish_view', item_id: item.id, table_id: scan.table_id, visitor_id: scan.visitor_id, created_at: new Date(at).toISOString() });
          if (random() < 0.12) events.push({ restaurant_id: restaurantId, type: 'video_play', item_id: item.id, table_id: scan.table_id, visitor_id: scan.visitor_id, created_at: new Date(Math.min(now - MINUTE, at + 20_000)).toISOString() });
        }
      }
      if (random() < 0.06) {
        events.push({ restaurant_id: restaurantId, type: 'deal_view', deal_id: pick(merch.deals).id, table_id: scan.table_id, visitor_id: scan.visitor_id, created_at: new Date(Math.min(now - MINUTE, opened + between(0.5, 5) * MINUTE)).toISOString() });
      }
    }
  }

  await insertAll(db, 'orders', orders, 'Demo orders');
  await insertAll(db, 'order_items', lines, 'Demo order items');
  await insertAll(db, 'payments', payments, 'Demo payments');
  await insertAll(db, 'service_requests', requests, 'Demo requests');
  await insertAll(db, 'menu_scans', scans, 'Demo menu scans');
  if (events.length) await insertAll(db, 'menu_events', events, 'Demo menu events');

  // Two guests who tapped "Ready to order" and are waiting for a waiter (codes valid for 2 hours from now):
  // "Table 6 is ready to order" and "Table 10 is ready to order" on the live screens.
  const available = items.filter((i) => i.available);
  const drink = available.find((i) => i.category === 'Drinks');
  const readyCarts = [
    { number: 6, minutesAgo: 2, items: [{ itemId: available[0].id, quantity: 2 }, { itemId: drink.id, quantity: 2, note: 'No ice' }] },
    { number: 10, minutesAgo: 5, items: [{ itemId: available.find((i) => i.category === 'Mains' && i.id !== available[0].id).id, quantity: 1 }, { itemId: drink.id, quantity: 1 }] },
  ];
  if (merch) {
    const burger = items.find((i) => i.name === 'Classic beef burger');
    readyCarts[0].items.push({ itemId: burger.id, quantity: 1, extraIds: [merch.extrasByItem.get(burger.id)[0].id] }, { dealId: merch.deals[2].id, quantity: 1 });
  }
  const cartCodes = [];
  for (const cart of readyCarts) {
    const readyAt = new Date(now - cart.minutesAgo * MINUTE).toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: 6 }, () => CART_ALPHABET[Math.floor(Math.random() * CART_ALPHABET.length)]).join('');
      const { error } = await db.from('guest_carts').insert({
        restaurant_id: restaurantId, table_id: tableByNumber.get(cart.number).id, code, items: cart.items,
        created_at: readyAt, expires_at: new Date(now + 2 * HOUR).toISOString(), ...(flowInstalled ? { ready_at: readyAt } : {}),
      });
      if (!error) { cartCodes.push(code); break; }
      if (error.code !== '23505') throw new Error(`Demo guest cart: ${error.message}`);
    }
  }
  const cartCode = cartCodes[0] || null;

  return {
    tables: tables.length, items: items.length, soldOut: items.filter((i) => !i.available).length,
    orders: orders.length, live: live.length, payments: payments.length, openRequests: openRequests.length,
    scans: scans.length, cartCode, readyCarts: cartCodes.length, days: HISTORY_DAYS,
    merch: merch ? { pairings: merch.pairings, extras: merch.extras, featured: merch.featuredIds.length, deals: merch.deals.length, events: events.length } : null,
  };
}
