// Recipes service (P1-10, migration 013): which stock items ONE dish (or one extra) uses.
// Quantities are typed in any unit that fits the item (200 g, 0.2 kg, 1 tray) and STORED in the item's base unit
// (recipe_lines.qty_base, 4 dp, before yield) next to what was typed. A recipe is versioned: every save writes a NEW
// version and supersedes the old one; a version that an order has used is never touched (013 triggers enforce it too).
// Extras (menu_item_extras) have a flat list of lines without versions: orders snapshot what they needed when taken.
//
// Rules decided here (see the P1-10 report):
//  * The same item twice in one recipe is REFUSED (400 duplicate_item): summing would hide what was typed.
//  * Saving a recipe, or emptying it, also deletes the dish's 009 single link (menu_item_stock). With a recipe the link is
//    ignored anyway except for its keep-selling switch (013 ORs both), and after emptying a recipe the link would silently
//    become the active source again and the dish would stay tracked. The link's keep-selling switch is carried into the recipe
//    when the caller does not say otherwise.
//  * Emptying a recipe keeps its history: current_version_id becomes null, the last version is marked superseded.
//  * Costs (food cost, line cost) are only ever returned to callers holding inv.cost.view at the dish's branch.
// Services take (db, scope, ...) like catalogue.js: `db` is a transaction for writes; routes authorize before opening it.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { call as aiCall, matchItem, recipePrompt } from '../ai/gateway.js';
import { COST, MONEY, QTY, add, cmp, dec, div, isZero, mul, rescale } from './decimal.js';
import { compatibleUnits, display, fromBase, normaliseUnit, toBase } from './units.js';
import { can, requireCan } from './permissions.js';
import { diff, record } from './audit.js';
import { loadUnits } from './catalogue.js';
import { together } from '../lib/pool.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
export const MAX_LINES = 30;
const NO_LOCATION = 'no-location';
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is invalid.`, 'bad_id');
  return value.toLowerCase();
};

/* ---------- loading ---------- */

/** The dish (any branch of the business), its branch and the branch's stock location. 404 when it isn't this business's. */
export async function loadDish(db, scope, menuItemId, { restaurantId } = {}) {
  const id = needId(menuItemId, 'The dish');
  const { rows } = await db.query(`select m.id, m.name, m.price::text as price, m.currency, m.restaurant_id, r.name as branch_name, c.name as category, m.description
    from public.menu_items m join public.restaurants r on r.id = m.restaurant_id left join public.menu_categories c on c.id = m.category_id
    where m.id = $1 and r.business_id = $2`, [id, scope.businessId]);
  const row = rows[0];
  if (!row || (restaurantId && row.restaurant_id !== String(restaurantId).toLowerCase())) {
    throw fail(404, 'That dish isn’t on this menu. Pick it from the menu list.', 'dish_not_found');
  }
  return { id: row.id, name: row.name, price: row.price, currency: row.currency, restaurantId: row.restaurant_id, branchName: row.branch_name,
    category: row.category, description: row.description,
    locationId: scope.locations.find((l) => l.restaurantId === row.restaurant_id)?.id || NO_LOCATION };
}

/** The extra, its dish and branch. */
export async function loadExtra(db, scope, extraId, { restaurantId } = {}) {
  const id = needId(extraId, 'The extra');
  const { rows } = await db.query(`select e.id, e.name, e.price::text as price, e.item_id, e.restaurant_id, r.name as branch_name
    from public.menu_item_extras e join public.restaurants r on r.id = e.restaurant_id where e.id = $1 and r.business_id = $2`, [id, scope.businessId]);
  const row = rows[0];
  if (!row || (restaurantId && row.restaurant_id !== String(restaurantId).toLowerCase())) {
    throw fail(404, 'That extra isn’t on this menu. Pick it from the menu list.', 'extra_not_found');
  }
  return { id: row.id, name: row.name, price: row.price, dishId: row.item_id, restaurantId: row.restaurant_id, branchName: row.branch_name,
    locationId: scope.locations.find((l) => l.restaurantId === row.restaurant_id)?.id || NO_LOCATION };
}

/** The stock location of a dish / an extra, for routes that authorize before the transaction. */
export const dishLocationId = async (db, scope, menuItemId, options) => (await loadDish(db, scope, menuItemId, options)).locationId;
export const extraLocationId = async (db, scope, extraId, options) => (await loadExtra(db, scope, extraId, options)).locationId;
/** The stock location of a branch of this business (404 when it isn't one). */
export function branchLocationId(scope, restaurantId) {
  const id = scope.locations.find((l) => l.restaurantId === String(restaurantId || '').toLowerCase())?.id;
  if (!id) throw fail(404, 'That branch isn’t part of this business. Pick it from the branch list.', 'branch_not_found');
  return id;
}

/** Items by id with what units.js needs. Missing ids are simply absent from the map. */
async function loadItems(db, scope, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;
  // One statement: each item with its own units (crate = 10 kg) folded in as JSON.
  const { rows } = await db.query(`select i.id, i.name, i.unit, i.display_unit, i.yield_pct::text as yield_pct, i.avg_cost::text as avg_cost, i.archived_at, i.active,
      coalesce((select json_agg(json_build_object('name', u.name, 'factor', u.factor::text) order by u.position, lower(u.name))
        from public.stock_item_units u where u.item_id = i.id), '[]'::json) as own_units
    from public.stock_items i where i.business_id = $1 and i.id = any($2::uuid[])`, [scope.businessId, unique]);
  for (const row of rows) {
    const own = typeof row.own_units === 'string' ? JSON.parse(row.own_units) : row.own_units;
    map.set(row.id, { id: row.id, name: row.name, baseUnit: row.unit, yieldPct: row.yield_pct, avgCost: row.avg_cost,
      archived: row.archived_at !== null || row.active === false,
      unitItem: { name: row.name, baseUnit: row.unit, displayUnit: row.display_unit || undefined,
        units: own.map((u) => ({ name: u.name, factor: u.factor })) } });
  }
  return map;
}

async function namesOf(db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { rows } = await db.query('select id, name from public.profiles where id = any($1::uuid[])', [unique]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* ---------- reading lines from people ---------- */

/**
 * [{ itemId, quantity, unit? }] -> validated lines { item, qtyBase, enteredQuantity, enteredUnit }.
 * Items must be in the business and not archived; quantities positive and convertible exactly (units.toBase).
 * A blank unit means the item's display unit (else its base unit), like the catalogue forms.
 */
async function resolveLines(db, scope, raw, units) {
  if (!Array.isArray(raw)) throw fail(400, 'Send the recipe lines (an empty list stops tracking this dish).', 'bad_lines');
  if (raw.length > MAX_LINES) throw fail(400, `Keep a recipe under ${MAX_LINES} ingredients.`, 'too_many_lines');
  const ids = raw.map((line) => needId(line?.itemId, 'An ingredient'));
  const items = await loadItems(db, scope, ids);
  const seen = new Set();
  const lines = [];
  for (const [index, line] of raw.entries()) {
    const item = items.get(ids[index]);
    if (!item) throw fail(404, 'One of the ingredients isn’t a stock item of this business. Pick it from the items list.', 'item_not_found');
    if (item.archived) throw fail(400, `${item.name} is archived. Restore it, or pick another item.`, 'item_archived');
    if (seen.has(item.id)) throw fail(400, `${item.name} is in the recipe twice. Combine the amounts into one line.`, 'duplicate_item');
    seen.add(item.id);
    const label = `${item.name} amount`;
    const typed = dec(typeof line.quantity === 'string' ? line.quantity.trim() : line.quantity, { label });
    const unit = line.unit === undefined || line.unit === null || String(line.unit).trim() === '' ? item.unitItem.displayUnit ?? item.baseUnit : line.unit;
    const qtyBase = toBase(typed, unit, item.unitItem, units, { positive: true, label });
    lines.push({ item, qtyBase, enteredQuantity: rescale(typed, QTY, 'half-up').toString(QTY),
      enteredUnit: normaliseUnit(unit, item.unitItem, units) || item.baseUnit });
  }
  return lines;
}

/* ---------- sentences and cost (pure) ---------- */

function amountText(qtyBase, unitCode, item, units) {
  const unit = compatibleUnits(item, units).find((u) => u.code === unitCode) || compatibleUnits(item, units).find((u) => u.code === item.baseUnit);
  const value = fromBase(qtyBase, unit.code, item, units, { scale: 9 });
  const dp = cmp(value, 10) >= 0 ? 1 : 3;
  let text = rescale(value, dp, 'half-up').toString(dp);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  text = text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${text} ${text === '1' ? unit.label : unit.plural}`;
}

/** "1 Chicken burger uses 285.7 g Chicken (200 g at 70% usable)" for one line. Lines: { name, qtyBase, yieldPct, enteredUnit, item (unit item) }. */
export function describeLine(dishName, line, units) {
  const yieldPct = dec(line.yieldPct ?? 100);
  const unit = line.enteredUnit || line.item.baseUnit;
  const typed = amountText(line.qtyBase, unit, line.item, units);
  if (cmp(yieldPct, 100) === 0) return `1 ${dishName} uses ${typed} ${line.name}`;
  const needed = div(dec(line.qtyBase), div(yieldPct, 100, 9), QTY);
  const pct = rescale(yieldPct, 2, 'half-up').toString(2).replace(/0+$/, '').replace(/\.$/, '');
  return `1 ${dishName} uses ${amountText(needed.toString(QTY), unit, line.item, units)} ${line.name} (${typed} at ${pct}% usable)`;
}

/** One plain sentence per line. */
export const preview = (dishName, lines, units) => lines.map((line) => describeLine(dishName, line, units));

/**
 * Σ qty_base / (yield / 100) × avg_cost, exact (BigInt), rounded half-up to MONEY once at the end.
 * lines: [{ name, qtyBase, yieldPct, avgCost }]. Any item without a cost makes the total unknown: cost is null, never 0.
 * Returns { cost: string|null, costPct: string|null, unknown: [names], lines: [{ cost: string|null }] }.
 */
export function computeCost(lines, price) {
  let total = dec(0);
  const unknown = [];
  const each = [];
  for (const line of lines) {
    if (line.avgCost === null || line.avgCost === undefined) { unknown.push(line.name); each.push({ cost: null }); continue; }
    const gross = mul(mul(line.qtyBase, line.avgCost, QTY + COST, 'exact'), 100, QTY + COST, 'exact');
    const exact = div(gross, line.yieldPct ?? 100, 12);
    total = add(total, exact);
    each.push({ cost: rescale(exact, MONEY, 'half-up').toString(MONEY) });
  }
  if (unknown.length || !lines.length) return { cost: null, costPct: null, unknown, lines: each };
  const cost = rescale(total, MONEY, 'half-up');
  const p = price === null || price === undefined ? null : dec(price);
  const costPct = p && !isZero(p) ? div(mul(cost, 100, MONEY, 'exact'), p, 1).toString(1) : null;
  return { cost: cost.toString(MONEY), costPct, unknown: [], lines: each };
}

/* ---------- reading a recipe ---------- */

async function currentSource(db, dishId) {
  const recipe = (await db.query(`select r.id, r.current_version_id, r.allow_when_out, r.updated_at, v.version, v.note, v.created_by, v.created_at
    from public.recipes r left join public.recipe_versions v on v.id = r.current_version_id where r.menu_item_id = $1`, [dishId])).rows[0] || null;
  const link = (await db.query(`select item_id, servings::text as servings, allow_when_out from public.menu_item_stock where menu_item_id = $1`, [dishId])).rows[0] || null;
  return { recipe, link };
}

const versionLines = async (db, versionId) => (await db.query(`select item_id, qty_base::text as qty_base, entered_quantity::text as entered_quantity, entered_unit, takeaway_only
  from public.recipe_lines where version_id = $1 order by position`, [versionId])).rows;

function lineView(row, item, units) {
  const unitItem = item?.unitItem;
  return { itemId: row.item_id, name: item?.name || 'Unknown item', archived: item?.archived === true, baseUnit: item?.baseUnit || null,
    qtyBase: dec(row.qty_base).toString(QTY), display: unitItem ? display(row.qty_base, unitItem, units) : row.qty_base,
    entered: row.entered_quantity ? { quantity: row.entered_quantity, unit: row.entered_unit } : null,
    yieldPct: item ? Number(item.yieldPct) : 100, takeawayOnly: row.takeaway_only === true,
    compatibleUnits: unitItem ? compatibleUnits(unitItem, units).map((u) => ({ code: u.code, label: u.label, plural: u.plural, kind: u.kind })) : [] };
}

/** Pure view helper shared by dish and extra lines: adds the sentence and (when allowed) costs. */
function decorate(dishName, rawLines, items, units, { withCost, price }) {
  const views = rawLines.map((row) => lineView(row, items.get(row.item_id), units));
  const sentences = preview(dishName, rawLines.map((row, i) => ({ name: views[i].name, qtyBase: row.qty_base, yieldPct: views[i].yieldPct,
    enteredUnit: row.entered_unit, item: items.get(row.item_id)?.unitItem })).filter((l) => l.item), units);
  let foodCost;
  if (withCost) {
    const costed = computeCost(rawLines.filter((r) => r.takeaway_only !== true).map((row) => {
      const item = items.get(row.item_id);
      return { name: item?.name || 'Unknown item', qtyBase: row.qty_base, yieldPct: item?.yieldPct, avgCost: item?.avgCost ?? null };
    }), price);
    let k = 0;
    for (const [i, row] of rawLines.entries()) if (row.takeaway_only !== true) views[i].cost = costed.lines[k++].cost;
    foodCost = { cost: costed.cost, costPct: costed.costPct, unknown: costed.unknown };
  }
  return { lines: views, preview: sentences, foodCost };
}

/**
 * One dish's recipe and everything the recipe editor shows:
 *   { dish, source: 'recipe'|'link'|'none', tracked, allowWhenOut, version, lines, preview, foodCost?, link, versions, extras, canEdit, canSeeCost }
 * `link` is the 009 single link; when there is no recipe it is what is in force and `lines` shows it as one line.
 */
export async function getRecipe(db, scope, menuItemId, options = {}) {
  const dish = await loadDish(db, scope, menuItemId, options);
  requireCan(scope, 'inv.view', { locationId: dish.locationId });
  const units = await loadUnits(db);
  const withCost = can(scope, 'inv.cost.view', { locationId: dish.locationId });
  const { recipe, link } = await currentSource(db, dish.id);
  const versionRows = recipe ? (await db.query(`select v.id, v.version, v.note, v.created_by, v.created_at, v.superseded_at,
      exists (select 1 from public.order_stock_lines s where s.recipe_version_id = v.id) as used,
      (select count(*)::int from public.recipe_lines l where l.version_id = v.id) as line_count
    from public.recipe_versions v where v.recipe_id = $1 order by v.version desc`, [recipe.id])).rows : [];
  const extraRows = (await db.query(`select id, name, price::text as price, available from public.menu_item_extras where item_id = $1 order by position, lower(name)`, [dish.id])).rows;
  const extraLines = extraRows.length ? (await db.query(`select extra_id, item_id, qty_base::text as qty_base, entered_quantity::text as entered_quantity, entered_unit
    from public.menu_extra_recipe_lines where extra_id = any($1::uuid[]) order by extra_id, item_id`, [extraRows.map((e) => e.id)])).rows : [];

  const tracked = Boolean(recipe?.current_version_id);
  const recipeLines = tracked ? await versionLines(db, recipe.current_version_id) : [];
  const linkLines = !tracked && link ? [{ item_id: link.item_id, qty_base: link.servings, entered_quantity: null, entered_unit: null, takeaway_only: false }] : [];
  const mainLines = tracked ? recipeLines : linkLines;
  const items = await loadItems(db, scope, [...mainLines.map((l) => l.item_id), ...extraLines.map((l) => l.item_id)]);
  const names = await namesOf(db, versionRows.map((v) => v.created_by));
  const main = decorate(dish.name, mainLines, items, units, { withCost, price: dish.price });
  const source = tracked ? 'recipe' : link ? 'link' : 'none';
  const person = (id) => (id ? { id, name: names.get(id) || null } : null);
  const extras = extraRows.map((e) => {
    const lines = extraLines.filter((l) => l.extra_id === e.id).map((l) => ({ ...l, takeaway_only: false }));
    const view = decorate(e.name, lines, items, units, { withCost, price: e.price });
    return { id: e.id, name: e.name, price: Number(e.price), available: e.available, tracked: lines.length > 0, lines: view.lines, preview: view.preview,
      ...(view.foodCost ? { foodCost: view.foodCost } : {}) };
  });
  return {
    dish: { id: dish.id, name: dish.name, price: Number(dish.price), currency: dish.currency, category: dish.category, restaurantId: dish.restaurantId, branchName: dish.branchName },
    source, tracked: tracked || Boolean(link),
    allowWhenOut: tracked ? recipe.allow_when_out === true : link ? link.allow_when_out === true : false,
    version: tracked ? { id: recipe.current_version_id, version: recipe.version, note: recipe.note, createdAt: recipe.created_at, createdBy: person(recipe.created_by) } : null,
    lines: main.lines, preview: main.preview, ...(main.foodCost ? { foodCost: main.foodCost } : {}),
    link: link ? { itemId: link.item_id, name: items.get(link.item_id)?.name || null, servings: link.servings, allowWhenOut: link.allow_when_out === true, inForce: !tracked } : null,
    versions: versionRows.map((v) => ({ id: v.id, version: v.version, note: v.note, createdAt: v.created_at, supersededAt: v.superseded_at,
      current: v.id === recipe.current_version_id, used: v.used === true, lineCount: v.line_count, createdBy: person(v.created_by) })),
    extras,
    canEdit: can(scope, 'inv.recipe.edit', { locationId: dish.locationId }), canSeeCost: withCost,
  };
}

/** The version history of a dish (newest first). */
export async function versions(db, scope, menuItemId, options = {}) {
  const view = await getRecipe(db, scope, menuItemId, options);
  return { dish: view.dish, versions: view.versions };
}

/** One saved version with its lines, sentences and (when allowed) cost, for the history view. */
export async function getVersion(db, scope, menuItemId, versionId, options = {}) {
  const dish = await loadDish(db, scope, menuItemId, options);
  requireCan(scope, 'inv.view', { locationId: dish.locationId });
  const vid = needId(versionId, 'The version');
  const row = (await db.query(`select v.id, v.version, v.note, v.created_by, v.created_at, v.superseded_at, r.current_version_id,
      exists (select 1 from public.order_stock_lines s where s.recipe_version_id = v.id) as used
    from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where v.id = $1 and r.menu_item_id = $2`, [vid, dish.id])).rows[0];
  if (!row) throw fail(404, 'That version isn’t part of this dish’s recipe history.', 'version_not_found');
  const units = await loadUnits(db);
  const lines = await versionLines(db, vid);
  const items = await loadItems(db, scope, lines.map((l) => l.item_id));
  const view = decorate(dish.name, lines, items, units, { withCost: can(scope, 'inv.cost.view', { locationId: dish.locationId }), price: dish.price });
  const names = await namesOf(db, [row.created_by]);
  return { dish: { id: dish.id, name: dish.name }, version: { id: row.id, version: row.version, note: row.note, createdAt: row.created_at, supersededAt: row.superseded_at,
    current: row.id === row.current_version_id, used: row.used === true, createdBy: row.created_by ? { id: row.created_by, name: names.get(row.created_by) || null } : null },
  lines: view.lines, preview: view.preview, ...(view.foodCost ? { foodCost: view.foodCost } : {}) };
}

/**
 * Sentences and food cost for lines that are NOT saved yet ({ itemId, quantity, unit }), for the editor's live preview.
 * Same validation as saving; saves nothing.
 */
export async function previewDraft(db, scope, menuItemId, body = {}, options = {}) {
  const dish = await loadDish(db, scope, menuItemId, options);
  requireCan(scope, 'inv.view', { locationId: dish.locationId });
  const units = await loadUnits(db);
  const lines = await resolveLines(db, scope, body.lines, units);
  const sentences = preview(dish.name, lines.map((l) => ({ name: l.item.name, qtyBase: l.qtyBase, yieldPct: l.item.yieldPct, enteredUnit: l.enteredUnit, item: l.item.unitItem })), units);
  const out = { dish: { id: dish.id, name: dish.name }, preview: sentences };
  const cost = await foodCost(db, scope, { menuItemId: dish.id, lines: body.lines }, options);
  if (cost) out.foodCost = cost;
  return out;
}

/**
 * Food cost of one serving: Σ qty_base / (yield/100) × avg_cost, at money scale, with decimal arithmetic.
 * `target` is a menuItemId (its current recipe, else its 009 link) or { menuItemId, lines: [{ itemId, quantity, unit }] } for a draft.
 * Returns { cost, costPct, unknown } (cost null when any ingredient has no cost yet) or null when the caller can't see costs here.
 */
export async function foodCost(db, scope, target, options = {}) {
  const menuItemId = typeof target === 'string' ? target : target?.menuItemId;
  const dish = await loadDish(db, scope, menuItemId, options);
  requireCan(scope, 'inv.view', { locationId: dish.locationId });
  if (!can(scope, 'inv.cost.view', { locationId: dish.locationId })) return null;
  let rows;
  if (target && typeof target === 'object' && Array.isArray(target.lines)) {
    const resolved = await resolveLines(db, scope, target.lines, await loadUnits(db));
    rows = resolved.map((l) => ({ item_id: l.item.id, qty_base: l.qtyBase }));
  } else {
    const { recipe, link } = await currentSource(db, dish.id);
    rows = recipe?.current_version_id ? (await versionLines(db, recipe.current_version_id)).filter((l) => !l.takeaway_only)
      : link ? [{ item_id: link.item_id, qty_base: link.servings }] : [];
  }
  const items = await loadItems(db, scope, rows.map((r) => r.item_id));
  const { cost, costPct, unknown } = computeCost(rows.map((r) => {
    const item = items.get(r.item_id);
    return { name: item?.name || 'Unknown item', qtyBase: r.qty_base, yieldPct: item?.yieldPct, avgCost: item?.avgCost ?? null };
  }), dish.price);
  return { cost, costPct, unknown };
}

/* ---------- saving ---------- */

const auditView = (dish, state) => ({ version: state.version ?? null, tracked: state.tracked, allowWhenOut: state.allowWhenOut,
  lines: state.lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })), link: state.link ?? null, menuItemId: dish.id });

async function stateOf(db, scope, dish) {
  const { recipe, link } = await currentSource(db, dish.id);
  const lines = recipe?.current_version_id ? (await versionLines(db, recipe.current_version_id)).map((l) => ({ itemId: l.item_id, qtyBase: dec(l.qty_base).toString(QTY) })) : [];
  return { version: recipe?.version ?? null, tracked: Boolean(recipe?.current_version_id), allowWhenOut: recipe?.allow_when_out === true, lines,
    link: link ? { itemId: link.item_id, servings: link.servings, allowWhenOut: link.allow_when_out === true } : null };
}

/**
 * Saves a dish's recipe: { lines: [{ itemId, quantity, unit? }], allowWhenOut?, note? }.
 * Always writes a NEW version and supersedes the previous one. An empty list stops tracking the dish (history is kept).
 * Returns getRecipe().
 */
export async function saveRecipe(db, scope, menuItemId, body = {}, options = {}) {
  const dish = await loadDish(db, scope, menuItemId, options);
  requireCan(scope, 'inv.recipe.edit', { locationId: dish.locationId });
  const units = await loadUnits(db);
  const lines = await resolveLines(db, scope, body.lines, units);
  const note = tidy(body.note);
  if (note.length > 280) throw fail(400, 'Keep the note under 280 characters.', 'note_too_long');
  if (body.allowWhenOut !== undefined && typeof body.allowWhenOut !== 'boolean') throw fail(400, 'allowWhenOut must be true or false.', 'bad_allow_when_out');

  const before = await stateOf(db, scope, dish);
  const link = before.link;
  const allow = body.allowWhenOut === undefined ? (before.tracked ? before.allowWhenOut : link?.allowWhenOut ?? before.allowWhenOut) : body.allowWhenOut;

  if (!lines.length) {
    if (!before.tracked && !link) return getRecipe(db, scope, dish.id, options); // nothing to stop
    const row = (await db.query('select id, current_version_id from public.recipes where menu_item_id = $1 for update', [dish.id])).rows[0];
    if (row) {
      await db.query('update public.recipes set current_version_id = null, allow_when_out = $2, updated_at = now() where id = $1', [row.id, allow]);
      if (row.current_version_id) await db.query('update public.recipe_versions set superseded_at = now() where id = $1 and superseded_at is null', [row.current_version_id]);
    }
    await db.query('delete from public.menu_item_stock where menu_item_id = $1', [dish.id]);
    const after = await stateOf(db, scope, dish);
    const d = diff(auditView(dish, before), auditView(dish, after));
    await record(db, { businessId: scope.businessId, locationId: dish.locationId === NO_LOCATION ? null : dish.locationId, actorId: scope.userId, actorRole: scope.role,
      entity: 'recipe', entityId: row?.id || null, action: 'stop_tracking', before: { ...d.before, dish: dish.name }, after: { ...d.after, dish: dish.name, note: note || undefined } });
    return getRecipe(db, scope, dish.id, options);
  }

  const recipeId = (await db.query(`insert into public.recipes (business_id, restaurant_id, menu_item_id, allow_when_out) values ($1, $2, $3, $4)
    on conflict (menu_item_id) do update set updated_at = now() returning id`, [scope.businessId, dish.restaurantId, dish.id, allow])).rows[0].id;
  const locked = (await db.query('select id from public.recipes where id = $1 for update', [recipeId])).rows[0];
  const next = (await db.query('select coalesce(max(version), 0) + 1 as v from public.recipe_versions where recipe_id = $1', [locked.id])).rows[0].v;
  const versionId = (await db.query(`insert into public.recipe_versions (business_id, recipe_id, version, note, created_by) values ($1, $2, $3, $4, $5) returning id`,
    [scope.businessId, locked.id, next, note || null, scope.userId])).rows[0].id;
  for (const [position, line] of lines.entries()) {
    await db.query(`insert into public.recipe_lines (business_id, version_id, item_id, position, qty_base, entered_quantity, entered_unit) values ($1, $2, $3, $4, $5, $6, $7)`,
      [scope.businessId, versionId, line.item.id, position, line.qtyBase, line.enteredQuantity, line.enteredUnit]);
  }
  await db.query('update public.recipes set current_version_id = $2, allow_when_out = $3, updated_at = now() where id = $1', [locked.id, versionId, allow]);
  await db.query('update public.recipe_versions set superseded_at = now() where recipe_id = $1 and id <> $2 and superseded_at is null', [locked.id, versionId]);
  await db.query('delete from public.menu_item_stock where menu_item_id = $1', [dish.id]);

  const after = await stateOf(db, scope, dish);
  const d = diff(auditView(dish, before), auditView(dish, after));
  await record(db, { businessId: scope.businessId, locationId: dish.locationId === NO_LOCATION ? null : dish.locationId, actorId: scope.userId, actorRole: scope.role,
    entity: 'recipe', entityId: locked.id, action: 'save', before: { ...d.before, dish: dish.name }, after: { ...d.after, dish: dish.name, note: note || undefined } });
  return getRecipe(db, scope, dish.id, options);
}

/**
 * Replaces an extra's ingredient lines: { lines: [{ itemId, quantity, unit? }] }. Extras are not versioned (orders snapshot what
 * they needed when taken). An empty list stops tracking the extra. Returns { extra, lines, preview, foodCost? }.
 */
export async function saveExtraRecipe(db, scope, extraId, body = {}, options = {}) {
  const extra = await loadExtra(db, scope, extraId, options);
  requireCan(scope, 'inv.recipe.edit', { locationId: extra.locationId });
  const units = await loadUnits(db);
  const lines = await resolveLines(db, scope, body.lines, units);
  const stored = async () => (await db.query(`select item_id, qty_base::text as qty_base from public.menu_extra_recipe_lines where extra_id = $1 order by item_id`, [extra.id])).rows
    .map((r) => ({ itemId: r.item_id, qtyBase: dec(r.qty_base).toString(QTY) }));
  const before = await stored();
  await db.query('delete from public.menu_extra_recipe_lines where extra_id = $1', [extra.id]);
  for (const line of lines) {
    await db.query(`insert into public.menu_extra_recipe_lines (business_id, restaurant_id, extra_id, item_id, qty_base, entered_quantity, entered_unit) values ($1, $2, $3, $4, $5, $6, $7)`,
      [scope.businessId, extra.restaurantId, extra.id, line.item.id, line.qtyBase, line.enteredQuantity, line.enteredUnit]);
  }
  const after = await stored();
  const d = diff({ lines: before }, { lines: after });
  if (d.changed.length) {
    await record(db, { businessId: scope.businessId, locationId: extra.locationId === NO_LOCATION ? null : extra.locationId, actorId: scope.userId, actorRole: scope.role,
      entity: 'extra_recipe', entityId: extra.id, action: after.length ? 'save' : 'stop_tracking', before: { ...d.before, extra: extra.name }, after: { ...d.after, extra: extra.name } });
  }
  return getExtraRecipe(db, scope, extra.id, options);
}

/** An extra's lines with sentences and (when allowed) cost. */
export async function getExtraRecipe(db, scope, extraId, options = {}) {
  const extra = await loadExtra(db, scope, extraId, options);
  requireCan(scope, 'inv.view', { locationId: extra.locationId });
  const units = await loadUnits(db);
  const rows = (await db.query(`select item_id, qty_base::text as qty_base, entered_quantity::text as entered_quantity, entered_unit, false as takeaway_only
    from public.menu_extra_recipe_lines where extra_id = $1 order by item_id`, [extra.id])).rows;
  const items = await loadItems(db, scope, rows.map((r) => r.item_id));
  const view = decorate(extra.name, rows, items, units, { withCost: can(scope, 'inv.cost.view', { locationId: extra.locationId }), price: extra.price });
  return { extra: { id: extra.id, name: extra.name, price: Number(extra.price), dishId: extra.dishId, restaurantId: extra.restaurantId, branchName: extra.branchName },
    tracked: rows.length > 0, lines: view.lines, preview: view.preview, ...(view.foodCost ? { foodCost: view.foodCost } : {}) };
}

/* ---------- every dish of a branch ---------- */

/**
 * Every dish of one branch with its recipe status, source, portions possible now, limiting ingredient and (when allowed) food cost.
 * Portions and sold-out come from public.stock_menu_availability (013): the same numbers serving uses.
 */
export async function listRecipes(db, scope, { restaurantId } = {}) {
  const locationId = scope.locations.find((l) => l.restaurantId === String(restaurantId || '').toLowerCase())?.id;
  if (!locationId) throw fail(404, 'That branch isn’t part of this business. Pick it from the branch list.', 'branch_not_found');
  requireCan(scope, 'inv.view', { locationId });
  const rid = String(restaurantId).toLowerCase();
  const withCost = can(scope, 'inv.cost.view', { locationId });
  // The branch name came with the scope; dishes, recipe lines and availability don't depend on each other: together (separate connections).
  const [branch, dishes, recipeLines, availabilityRows] = await together(db,
    async () => { const row = scope.locationRows?.find((l) => l.restaurant_id === rid); return row ? { name: row.display_name ?? row.name } : (await db.query('select name from public.restaurants where id = $1', [rid])).rows[0]; },
    async () => (await db.query(`select m.id, m.name, m.price::text as price, m.available, c.name as category, r.id as recipe_id, r.current_version_id, r.allow_when_out,
      v.version, mis.item_id as link_item, mis.servings::text as link_servings, mis.allow_when_out as link_allow
    from public.menu_items m
    left join public.menu_categories c on c.id = m.category_id
    left join public.recipes r on r.menu_item_id = m.id
    left join public.recipe_versions v on v.id = r.current_version_id
    left join public.menu_item_stock mis on mis.menu_item_id = m.id
    where m.restaurant_id = $1 order by lower(coalesce(c.name, '')), m.position, lower(m.name)`, [rid])).rows,
    async () => (await db.query(`select r.menu_item_id, rl.item_id, rl.qty_base::text as qty_base from public.recipes r
    join public.recipe_lines rl on rl.version_id = r.current_version_id where r.restaurant_id = $1 and not rl.takeaway_only`, [rid])).rows,
    async () => (await db.query('select * from public.stock_menu_availability($1)', [rid])).rows);
  const availability = new Map(availabilityRows.map((a) => [a.menu_item_id, a]));
  const items = await loadItems(db, scope, [...recipeLines.map((l) => l.item_id), ...dishes.map((d) => d.link_item), ...[...availability.values()].map((a) => a.item_id)]);

  const out = dishes.map((d) => {
    const source = d.current_version_id ? 'recipe' : d.link_item ? 'link' : 'none';
    const rows = source === 'recipe' ? recipeLines.filter((l) => l.menu_item_id === d.id) : source === 'link' ? [{ item_id: d.link_item, qty_base: d.link_servings }] : [];
    const entry = { id: d.id, name: d.name, category: d.category, price: Number(d.price), available: d.available, tracked: source !== 'none', source,
      version: d.version ?? null, lineCount: rows.length, allowWhenOut: source === 'recipe' ? d.allow_when_out === true : d.link_allow === true,
      portions: null, limitingItem: null, soldOut: false };
    const a = availability.get(d.id);
    if (a && source !== 'none') {
      const per = dec(a.servings);
      const avail = dec(a.available);
      entry.portions = isZero(per) || cmp(avail, 0) <= 0 ? 0 : Number(div(avail, per, 0, 'down').toString(0));
      entry.limitingItem = items.get(a.item_id) ? { id: a.item_id, name: items.get(a.item_id).name } : { id: a.item_id, name: null };
      entry.soldOut = a.sold_out === true;
    }
    if (withCost && source !== 'none') {
      const c = computeCost(rows.map((r) => ({ name: items.get(r.item_id)?.name || 'Unknown item', qtyBase: r.qty_base, yieldPct: items.get(r.item_id)?.yieldPct, avgCost: items.get(r.item_id)?.avgCost ?? null })), d.price);
      entry.foodCost = { cost: c.cost, costPct: c.costPct, unknown: c.unknown };
    }
    return entry;
  });
  return { restaurantId: rid, branchName: branch?.name || null, canSeeCost: withCost, canEdit: can(scope, 'inv.recipe.edit', { locationId }),
    summary: { dishes: out.length, tracked: out.filter((d) => d.tracked).length, untracked: out.filter((d) => !d.tracked).length, soldOut: out.filter((d) => d.soldOut).length },
    dishes: out };
}

/* ---------- AI draft ---------- */

const SYSTEM = (unitCodes) => `You help restaurant managers write recipes for stock control: how much of each ingredient ONE serving of a dish uses.
Answer with JSON only: {"lines":[{"name":"<ingredient>","quantity":<number>,"unit":"<unit>"}],"note":"<one short sentence>"}
Rules: unit is one of ${unitCodes.join(', ')}. quantity is a positive number per ONE dish. Prefer the restaurant's existing stock item names
(given with their units) and a unit compatible with that item (g or kg for weight, ml or l for volume, piece, serving).
Include only ingredients worth tracking (main proteins, starches, drinks, bread, packaging); skip salt, spices and water. At most 8 lines.`;

/**
 * Validates a model answer into a draft: units known to units.js, positive quantities, lines matched to existing stock items
 * by name (else newItem). A unit that doesn't fit the matched item is replaced by the item's base unit with a warning.
 */
export function normaliseDraft(raw, items, units) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.lines) ? raw.lines : Array.isArray(raw?.ingredients) ? raw.ingredients : null;
  if (!list) throw fail(502, 'The AI answer couldn’t be used. Try again, or enter the recipe yourself.', 'ai_bad_answer');
  const lines = [];
  const seen = new Set();
  for (const entry of list.slice(0, 20)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
    const quantity = typeof entry.quantity === 'string' ? Number(entry.quantity.trim()) : entry.quantity;
    if (!name || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) continue;
    const match = matchItem(name, items);
    const key = match ? match.id : name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rounded = Math.round(quantity * 1000) / 1000;
    if (rounded <= 0) continue;
    if (!match) {
      const unit = normaliseUnit(entry.unit, undefined, units);
      if (!unit) continue;
      lines.push({ itemId: null, name, quantity: rounded, unit, newItem: true, warning: 'Not a stock item yet. Add it first, or choose an existing item.' });
    } else {
      const unit = normaliseUnit(entry.unit, match.unitItem, units);
      let ok = Boolean(unit);
      if (ok) { try { toBase(String(rounded), unit, match.unitItem, units, { positive: true }); } catch { ok = false; } }
      const line = { itemId: match.id, name: match.name, quantity: rounded, unit: ok ? unit : match.baseUnit, newItem: false };
      if (!ok) line.warning = `Suggested in ${entry.unit || 'an unknown unit'}, but ${match.name} is counted in ${match.baseUnit}. Check the amount.`;
      lines.push(line);
    }
    if (lines.length >= 12) break;
  }
  if (!lines.length) throw fail(502, 'The AI answer had no usable ingredients. Try again, or enter the recipe yourself.', 'ai_bad_answer');
  return { lines, note: typeof raw?.note === 'string' ? raw.note.trim().slice(0, 200) : '' };
}

/**
 * A DRAFT recipe for one dish from the AI, through the metered gateway (ai/gateway.js, feature 'recipe_draft'). Never saves.
 * Sends only the dish's name/description/category and the business's active stock item names and units: no people, prices, orders or costs.
 * 503 ai_not_configured without OPENROUTER_API_KEY; 403 ai_off when the business has no allowance or the switch is off;
 * 429 ai_allowance_used at the limit (plain message). `options` { env, fetchImpl, now, sleep } exist for tests.
 */
export async function suggest(db, scope, menuItemId, options = {}) {
  const dish = await loadDish(db, scope, menuItemId, options);
  requireCan(scope, 'inv.recipe.edit', { locationId: dish.locationId });
  const units = await loadUnits(db);
  const rows = (await db.query(`select id from public.stock_items where business_id = $1 and active and archived_at is null order by name limit 150`, [scope.businessId])).rows;
  const map = await loadItems(db, scope, rows.map((r) => r.id));
  const items = rows.map((r) => map.get(r.id)).filter(Boolean).map((i) => ({ id: i.id, name: i.name, unit: i.baseUnit, baseUnit: i.baseUnit, unitItem: i.unitItem }));
  const { env, fetchImpl, now, sleep } = options;
  const result = await aiCall(db, {
    businessId: scope.businessId, feature: 'recipe_draft', actorId: scope.userId,
    system: SYSTEM(units.map((u) => u.code)), user: recipePrompt({ name: dish.name, description: dish.description || '', category: dish.category || '' }, items),
    parse: (data) => normaliseDraft(data, items, units), maxTokens: 800,
    ...(env ? { env } : {}), ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(sleep ? { sleep } : {}),
  });
  return { draft: true, menuItemId: dish.id, model: result.model, ...result.data,
    ...(result.allowance.warning ? { allowanceWarning: `You have used ${Math.floor(result.allowance.percent)}% of this month’s AI allowance.` } : {}) };
}
