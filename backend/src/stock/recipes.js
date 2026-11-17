// Recipes (migration 012): which stock items one serving of a dish uses. Quantities may be entered in any unit
// compatible with the item (200 g of a kg item) or in its pack; they are stored converted to the item's unit, with
// what was entered kept for display. Serving deducts every line; a dish is sold out when any ingredient is short.
// A recipe replaces the dish's 009 single link (one source of ingredients per dish).
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { formatAmount, toItemUnit } from '../lib/units.js';
import { suggestRecipe as aiSuggest } from '../lib/ai.js';
import { hasRecipes, quantity, requireItem } from './service.js';

const MAX_LINES = 30;

async function requireDish(db, restaurantId, menuItemId) {
  if (!isId(menuItemId)) throw new HttpError(400, 'Dish is invalid.');
  const { rows } = await db.query(`select m.id, m.name, m.description, c.name as category from public.menu_items m
    left join public.menu_categories c on c.id = m.category_id where m.id = $1 and m.restaurant_id = $2`, [menuItemId.toLowerCase(), restaurantId]);
  if (!rows[0]) throw new HttpError(404, 'That dish isn’t on this branch’s menu.');
  return rows[0];
}

/** "1 Burger uses 200 g Chicken breast" — one sentence per line. */
export const preview = (dishName, lines) => lines.map((line) => `1 ${dishName} uses ${formatAmount(line.enteredQuantity, line.enteredUnit === 'pack' ? line.packName || 'pack' : line.enteredUnit)} ${line.name}`);

/**
 * Saves a dish's recipe: { lines: [{ itemId, quantity, unit? }], allowWhenOut? }. No lines = stop tracking the dish.
 * Returns the stored lines (quantity in the item's unit) and a per-serving preview.
 */
export async function saveRecipe(db, { businessId, restaurantId, actorId }, menuItemId, body = {}) {
  if (!(await hasRecipes(db))) throw new HttpError(503, 'Recipes need database update 012, which hasn’t been applied yet. Single-item dish links still work.', { code: 'recipes_schema_missing' });
  const dish = await requireDish(db, restaurantId, menuItemId);
  if (!Array.isArray(body.lines)) throw new HttpError(400, 'Send the recipe lines (an empty list stops tracking this dish).');
  if (body.lines.length > MAX_LINES) throw new HttpError(400, `Keep a recipe under ${MAX_LINES} ingredients.`);
  const lines = [];
  const seen = new Set();
  for (const [index, line] of body.lines.entries()) {
    const item = await requireItem(db, businessId, line?.itemId);
    if (seen.has(item.id)) throw new HttpError(400, `${item.name} is in the recipe twice. Combine the amounts into one line.`);
    seen.add(item.id);
    const label = `${item.name} amount`;
    const entered = quantity(line.quantity, label);
    const enteredUnit = line.unit === undefined || line.unit === null || line.unit === '' ? item.unit : line.unit;
    const stored = toItemUnit(entered, enteredUnit, item, { label });
    lines.push({ itemId: item.id, name: item.name, unit: item.unit, packName: item.pack_name, quantity: stored, enteredQuantity: entered,
      enteredUnit: enteredUnit === item.pack_name ? 'pack' : enteredUnit, position: index });
  }
  const keepSelling = body.allowWhenOut === true;
  await db.query('delete from public.menu_item_stock where menu_item_id = $1', [dish.id]);
  if (!lines.length) {
    await db.query('delete from public.menu_item_recipes where menu_item_id = $1', [dish.id]);
    return { menuItemId: dish.id, tracked: false, lines: [], preview: [] };
  }
  await db.query(`insert into public.menu_item_recipes (menu_item_id, restaurant_id, allow_when_out, updated_by) values ($1, $2, $3, $4)
    on conflict (menu_item_id) do update set allow_when_out = excluded.allow_when_out, updated_by = excluded.updated_by, updated_at = now()`,
  [dish.id, restaurantId, keepSelling, actorId]);
  await db.query('delete from public.menu_item_recipe_lines where menu_item_id = $1', [dish.id]);
  for (const line of lines) {
    await db.query(`insert into public.menu_item_recipe_lines (menu_item_id, item_id, quantity, entered_quantity, entered_unit, position)
      values ($1, $2, $3, $4, $5, $6)`, [dish.id, line.itemId, line.quantity, line.enteredQuantity, line.enteredUnit, line.position]);
  }
  return {
    menuItemId: dish.id, tracked: true, allowWhenOut: keepSelling,
    lines: lines.map(({ itemId, name, unit, quantity: q, enteredQuantity, enteredUnit }) => ({ itemId, name, unit, quantity: q, enteredQuantity, enteredUnit })),
    preview: preview(dish.name, lines),
  };
}

/** What the AI needs for one dish: menu text and the business's stock item names/units (no people, prices or orders). */
export async function suggestionInput(db, { businessId, restaurantId }, menuItemId) {
  const dish = await requireDish(db, restaurantId, menuItemId);
  const { rows } = await db.query('select id, name, unit from public.stock_items where business_id = $1 and active order by name', [businessId]);
  return { dish: { id: dish.id, name: dish.name, description: dish.description || '', category: dish.category || '' }, stockItems: rows };
}

/** A DRAFT recipe from the AI. Never saves; the manager reviews it in the recipe editor. */
export async function suggest(input, options = {}) {
  const result = await aiSuggest(input, options);
  return { menuItemId: input.dish.id, ...result };
}
