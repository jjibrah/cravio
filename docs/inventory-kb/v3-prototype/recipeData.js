// Sample data and maths for the recipe-inventory prototype. Nothing here talks to the backend.
// Quantities are stored in base units: g, ml, piece or serving. Costs are KES per base unit.

export const UNITS = {
  g: { short: 'g', name: 'Weight (kg / g)', buy: [['kg', 1000], ['g', 1]], per: ['kg', 1000] },
  ml: { short: 'ml', name: 'Volume (L / ml)', buy: [['L', 1000], ['ml', 1]], per: ['L', 1000] },
  piece: { short: 'pcs', name: 'Pieces', buy: [['pcs', 1]], per: ['pc', 1] },
  serving: { short: 'servings', name: 'Servings (from the main kitchen)', buy: [['servings', 1]], per: ['serving', 1] },
};

const trim = (n, places = 2) => (Number.isInteger(n) ? String(n) : n.toFixed(places).replace(/\.?0+$/, ''));

export function qty(value, unit) {
  const v = Number(value) || 0;
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (unit === 'g') return a >= 1000 ? `${sign}${trim(a / 1000)} kg` : `${sign}${Math.round(a)} g`;
  if (unit === 'ml') return a >= 1000 ? `${sign}${trim(a / 1000)} L` : `${sign}${Math.round(a)} ml`;
  if (unit === 'piece') return `${sign}${trim(a, 1)} ${a === 1 ? 'pc' : 'pcs'}`;
  return `${sign}${trim(a, 1)} serving${a === 1 ? '' : 's'}`;
}
export const kes = (value) => `KES ${Math.round(Number(value) || 0).toLocaleString('en-KE')}`;
export const hasPrice = (item) => Number(item?.cost) > 0;
export const unitCost = (item) => (hasPrice(item) ? `${kes(item.cost * UNITS[item.unit].per[1])} per ${UNITS[item.unit].per[0]}` : 'No price yet');

/** Raw amount taken off stock for one portion: the recipe amount divided by the usable share. */
export const rawNeed = (line, item) => line.amount / ((item?.yieldPct || 100) / 100);

export function heldBy(openOrders, dishes) {
  const held = {};
  for (const order of openOrders) {
    const dish = dishes.find((d) => d.id === order.dishId);
    for (const line of dish?.recipe || []) held[line.itemId] = (held[line.itemId] || 0) + line.amount * order.qty;
  }
  return held;
}

/** Each ingredient with what's held by open orders, what's available and its state. */
export function withAvailability(items, dishes, openOrders) {
  const held = heldBy(openOrders, dishes);
  return items.map((item) => {
    const reserved = (held[item.id] || 0) / ((item.yieldPct || 100) / 100);
    const available = item.onHand - reserved;
    const state = available <= 0 ? 'out' : item.low !== null && available < item.low ? 'low' : 'ok';
    const usedIn = dishes.filter((d) => d.recipe.some((l) => l.itemId === item.id));
    return { ...item, reserved, available, state, usedIn };
  });
}

/**
 * Portions possible now (the scarcest ingredient decides), the limiting ingredient and the food cost.
 * `unpriced` lists ingredients with no price yet: while it isn't empty the food cost is incomplete, not zero.
 */
export function dishStatus(dish, items) {
  if (!dish.recipe.length) return { tracked: false, portions: null, limit: null, cost: 0, unpriced: [] };
  let portions = Infinity;
  let limit = null;
  let cost = 0;
  const unpriced = [];
  for (const line of dish.recipe) {
    const item = items.find((i) => i.id === line.itemId);
    if (!item) continue;
    const need = rawNeed(line, item);
    if (hasPrice(item)) cost += need * item.cost; else unpriced.push(item);
    const can = Math.max(0, Math.floor(item.available / need));
    if (can < portions) { portions = can; limit = item; }
  }
  return { tracked: true, portions, limit, cost, unpriced, soldOut: portions === 0 && !dish.keepSelling };
}

/** "No price yet for chicken" / "…for chicken and cheese". */
export const missingPrices = (unpriced) => `No price yet for ${unpriced.map((i) => i.name.toLowerCase()).join(' and ')}`;

const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString();

export const SAMPLE_ITEMS = [
  { id: 'chicken', name: 'Chicken (raw, bone-in)', unit: 'g', onHand: 3400, yieldPct: 100, cost: 0.65, low: 2500 },
  { id: 'wings', name: 'Chicken wings', unit: 'piece', onHand: 46, yieldPct: 100, cost: 35, low: 30 },
  { id: 'mozzarella', name: 'Mozzarella', unit: 'g', onHand: 1800, yieldPct: 100, cost: 1.2, low: 1000 },
  { id: 'dough', name: 'Pizza dough ball', unit: 'piece', onHand: 14, yieldPct: 100, cost: 40, low: 10 },
  { id: 'beef', name: 'Beef mince', unit: 'g', onHand: 1200, yieldPct: 100, cost: 0.75, low: 1500 },
  { id: 'potatoes', name: 'Potatoes', unit: 'g', onHand: 9000, yieldPct: 100, cost: 0.09, low: 4000 },
  { id: 'oil', name: 'Cooking oil', unit: 'ml', onHand: 6500, yieldPct: 100, cost: 0.32, low: 3000 },
  { id: 'pilau', name: 'Pilau (from main kitchen)', unit: 'serving', onHand: 22, yieldPct: 100, cost: 120, low: 10 },
  { id: 'fanta', name: 'Fanta 300ml', unit: 'piece', onHand: 0, yieldPct: 100, cost: 45, low: 12 },
];

export const SAMPLE_DISHES = [
  { id: 'chicken-pizza', name: 'Chicken pizza', price: 1200, keepSelling: false,
    recipe: [{ itemId: 'chicken', amount: 120 }, { itemId: 'mozzarella', amount: 80 }, { itemId: 'dough', amount: 1 }] },
  { id: 'margherita', name: 'Margherita pizza', price: 950, keepSelling: false,
    recipe: [{ itemId: 'mozzarella', amount: 120 }, { itemId: 'dough', amount: 1 }] },
  { id: 'wings', name: 'Chicken wings (6 pcs)', price: 850, keepSelling: false,
    recipe: [{ itemId: 'wings', amount: 6 }, { itemId: 'oil', amount: 40 }] },
  { id: 'fries', name: 'Fries', price: 300, keepSelling: false,
    recipe: [{ itemId: 'potatoes', amount: 250 }, { itemId: 'oil', amount: 30 }] },
  { id: 'burger', name: 'Beef burger with fries', price: 900, keepSelling: false,
    recipe: [{ itemId: 'beef', amount: 150 }, { itemId: 'potatoes', amount: 200 }, { itemId: 'oil', amount: 30 }] },
  { id: 'pilau', name: 'Pilau', price: 450, keepSelling: false, recipe: [{ itemId: 'pilau', amount: 1 }] },
  { id: 'fanta', name: 'Fanta 300ml', price: 150, keepSelling: false, recipe: [{ itemId: 'fanta', amount: 1 }] },
  { id: 'chapati', name: 'Chapati', price: 50, keepSelling: false, recipe: [] },
];

// Confirmed but not yet served: their ingredients are held.
export const SAMPLE_OPEN_ORDERS = [{ dishId: 'chicken-pizza', qty: 2 }, { dishId: 'wings', qty: 1 }];

// Supplier invoices: payment is cash, credit (owed to the supplier) or bank.
export const SAMPLE_PURCHASES = [
  { id: 'p1', at: ago(5), supplier: 'Mama Njeri Poultry', payment: 'credit',
    lines: [{ itemId: 'chicken', amount: 2000, total: 1300 }, { itemId: 'wings', amount: 60, total: 2100 }] },
  { id: 'p2', at: ago(29), supplier: 'Highland Dairy', payment: 'bank', lines: [{ itemId: 'mozzarella', amount: 2000, total: 2400 }] },
  { id: 'p3', at: ago(30), supplier: 'Wholesale market', payment: 'cash',
    lines: [{ itemId: 'oil', amount: 5000, total: 1600 }, { itemId: 'potatoes', amount: 10000, total: 900 }] },
];

export const SAMPLE_MOVEMENTS = [
  { id: 'm1', at: ago(0.4), itemId: 'chicken', change: -171, reason: 'Served', note: 'Chicken pizza × 1 · order #142' },
  { id: 'm2', at: ago(0.4), itemId: 'mozzarella', change: -80, reason: 'Served', note: 'Chicken pizza × 1 · order #142' },
  { id: 'm3', at: ago(0.4), itemId: 'dough', change: -1, reason: 'Served', note: 'Chicken pizza × 1 · order #142' },
  { id: 'm4', at: ago(1.2), itemId: 'wings', change: -12, reason: 'Served', note: 'Chicken wings (6 pcs) × 2 · order #139' },
  { id: 'm5', at: ago(1.2), itemId: 'oil', change: -80, reason: 'Served', note: 'Chicken wings (6 pcs) × 2 · order #139' },
  { id: 'm6', at: ago(5), itemId: 'chicken', change: 2000, reason: 'Purchased', note: 'Mama Njeri Poultry · KES 1,300' },
  { id: 'm7', at: ago(20), itemId: 'mozzarella', change: -150, reason: 'Wasted', note: 'Dropped on the floor' },
  { id: 'm8', at: ago(22), itemId: 'wings', change: -4, reason: 'Wasted', note: 'Burnt in the fryer' },
];

/**
 * Prototype stand-in for the AI recipe draft: finds "<number> <unit?> <ingredient>" in a description.
 * The real version would send the description (or a photo) to the AI and ask for confirmation in the same way.
 */
const KEYWORDS = { chicken: /chicken(?! wings)/, wings: /wings?/, mozzarella: /mozzarella|cheese/, dough: /dough|base/, beef: /beef|mince/, potatoes: /potato|fries|chips/, oil: /oil/, pilau: /pilau/, fanta: /fanta/ };
export function draftRecipe(text) {
  const lower = text.toLowerCase();
  const lines = [];
  for (const [itemId, pattern] of Object.entries(KEYWORDS)) {
    const match = lower.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(kg|g|grams?|ml|l|litres?|pcs|pieces?)?\\s*(?:of\\s+)?(?:\\w+\\s+){0,2}?(?:${pattern.source})`));
    if (!match) continue;
    let amount = Number(match[1]);
    if (match[2] === 'kg' || match[2] === 'l' || match[2]?.startsWith('litre')) amount *= 1000;
    lines.push({ itemId, amount });
  }
  return lines;
}
