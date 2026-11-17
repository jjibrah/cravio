# Recipes, units and packs (migration 012) — review pack

Status: **proposed, NOT applied.** File: `backend/db/proposed/012_recipes_units.sql` (rollback: `012_recipes_units.down.sql`). Requires 009. Rehearsed on disposable PGlite only (`node backend/tests/recipes.js`; `inventory-v2.js` also passes with 012 applied on top).

## The problem

“We buy chicken in bulk (40 crates). A burger uses 200 g, chicken tandoori 500 g. When a burger is ordered, the chicken should come off stock automatically. Different restaurants use different measurements and SOPs.”

## Rules

| Topic | Rule |
| --- | --- |
| Units | A stock item is counted in one unit: **serving, piece, g, kg, ml, l**. Balances, history, requests and dispatches are stored in that unit. Existing items stay `serving` and behave exactly as in 009. |
| Conversion | Within a dimension only: g ↔ kg, ml ↔ l. Weight ↔ volume, pieces ↔ weight and servings ↔ anything are **refused** with a clear message (400). Amounts are kept to 3 decimals in the item's unit (1 g of a kg item); finer amounts are refused rather than rounded away (“count the item in g instead”). |
| Packs (SOP) | Optional per item: a pack name and size in the item's unit (“crate” = 10 kg, “carton” = 24 pieces, “bag” = 12 buns). Add stock and Count accept units **or packs** (“40 crates” → 400 kg). Balances show “38.4 kg · about 3.8 crates”. The pack can change any time; it is only a way of entering amounts. |
| Changing a unit | Allowed only while the item has no stock history, no requests and no dish uses it (stored amounts are in that unit). Otherwise add a new item. |
| Recipes | A dish has ingredient lines: stock item + amount per ONE dish, entered in any compatible unit or pack (“200 g” of a kg item), stored converted (0.2 kg) with the entered amount and unit kept for display. |
| 009 links | The single servings link is a one-line recipe and keeps working unchanged. A dish has either a link or a recipe: saving a recipe removes the link; linking removes the recipe (the database also prefers the recipe if both ever exist). |
| Serving | Serving deducts **every** ingredient (once per order line and item; re-serving after a failed payment does nothing — `order_stock_effects`). |
| Hold | Confirmed, unserved orders hold every ingredient (on hand − held = available). |
| Sold out | A dish is sold out when **any** ingredient is short for one more dish. Ordering it is refused (“Sold out: Chicken burger (not enough Burger buns left)”). |
| Keep selling | Per dish. An ingredient may go short only if every dish in the order using it keeps selling; another dish on the same item is still refused. |
| Deals | Use their component dishes' recipes (or links). |

## Database (012)

- `stock_items`: unit check widened to `serving, piece, g, kg, ml, l`; new `pack_name`, `pack_size` (both or neither; size > 0).
- `menu_item_recipes` (dish → branch, `allow_when_out`) and `menu_item_recipe_lines` (item, `quantity` in item unit, `entered_quantity`, `entered_unit`, position). RLS: branch members/overseers read; writes via the API.
- View `private.dish_ingredients` = 009 links ∪ recipe lines (a recipe hides the link of the same dish).
- `create or replace` (same signatures as 009): `private.order_stock_needs`, `private.stock_check_new_lines`, `public.stock_menu_availability` (still one row per dish: the limiting ingredient, its amount per dish, what's available, `sold_out`). New `private.order_dish_needs`. `stock_on_serve` and `branch_committed` are unchanged and pick up recipes through `order_stock_needs`.
- Rollback refuses while any item uses a unit other than servings; otherwise restores the 009 functions and drops recipes and pack columns. Links, balances and history are untouched.

## API

| Endpoint | Who | What |
| --- | --- | --- |
| `POST /api/stock/items`, `POST /api/owner/stock/:biz/items` | Branch manager / owner | Now take `unit`, `packName`, `packSize`. |
| `PATCH /api/stock/items/:id`, `PATCH /api/owner/stock/:biz/items/:id` | Branch manager / owner | Edit name, low level, pack, unit (unit only while unused). |
| `POST /api/stock/adjust` (and owner) | as before | Takes `unit`: the item's unit, a compatible one (`g`) or `pack`. |
| `PUT /api/stock/recipes/:menuItemId` | Branch manager | `{ lines: [{ itemId, quantity, unit }], allowWhenOut }`. Empty lines = stop tracking. Returns stored lines and a preview (“1 Chicken burger uses 200 g Chicken”). |
| `POST /api/stock/recipes/suggest` | Branch manager | `{ menuItemId }` → AI **draft** `{ draft: true, lines: [{ itemId|null, name, quantity, unit, newItem, warning? }], note }`. Never saves. 503 `ai_not_configured` when no key. |

`GET /api/stock` now returns `recipes: true|false` (whether 012 is applied), items with `packName`/`packSize`, and each dish's `recipe` (`source: 'recipe'|'link'`). Without 012 everything works as in 009 (servings only; creating a non-serving item answers 503 “needs database update 012”).

## AI suggestion (optional)

- Module: `backend/src/lib/ai.js` → OpenRouter `https://openrouter.ai/api/v1/chat/completions`, strict JSON (`response_format: json_object`), 25 s timeout.
- Settings (backend `.env`): `OPENROUTER_API_KEY` (required to switch on), `OPENROUTER_MODEL` (optional; default `openai/gpt-4o-mini`, any OpenRouter model id).
- Sent: dish name, description and category, and the business's stock item names with their units. **No people, orders, prices or contact details.**
- The answer is validated: units must map to the allowed list (aliases like “grams”, “litres”, “pcs” accepted), quantities positive and finite, at most 12 lines; lines are matched to existing items by name (exact, then contains, then word overlap) or flagged “new item”; an incompatible unit is replaced by the item's unit with a warning. Nothing usable → 502.
- The manager reviews the draft in the recipe editor and saves it. Without a key the button shows a short setup hint; manual recipes work fully.

## UI (branch Inventory)

- **How stock works** guide (open until there are items and a tracked dish): add items with units and packs → count opening stock → set recipes → stock comes off automatically when an order is served.
- New/Edit item: unit (“Counted in”) and optional pack. Stock table: balances in units, available with packs (“38.4 kg · about 3.8 crates”), an Edit button.
- Count / Add / Waste: amount + unit dropdown (compatible units and the pack), with the converted total shown for packs.
- **Recipes** view (was “Dish links” — shown as “Dish links” until 012 is applied): per-dish editor with ingredient lines (item, amount, unit limited to compatible units and the pack), ✨ Suggest with AI, live preview (“1 Chicken burger uses 200 g of Chicken”), keep-selling switch.
- Requests, deliveries, history and the owner page show amounts in each item's unit.

## For the product owner

1. Review and approve migration 012 (then: snapshot, move the file to `db/migrations/`, `npm run db:migrate -- --dry-run`, `npm run db:migrate`).
2. Optional: add `OPENROUTER_API_KEY` (and `OPENROUTER_MODEL` if you want a different model) to the backend environment to switch on AI suggestions.
3. After 012 is applied, the read-only browser test that clicks “Dish links” needs to click “Recipes”.

## Not included

Unit conversion between items (e.g. a “serving of pilau” made from kg of rice: count the cooked servings, or recipe the raw rice), yield/waste factors, cost per dish, prep batches (sub-recipes), modifiers/extras with their own ingredients, supplier purchasing, request/dispatch entry in packs (they are in the item's unit), owner-side recipe editing.
