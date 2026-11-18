# 02 · main vs v3-dev

## Where the branches stand

```
63e2bb3 ──┬── 958e04b (units, packs, recipes, AI draft, table sessions…) ── d3e9033  = main
          └── ab6c9c6 "Inventory: recipe-based prototype replaces the Inventory page" = origin/v3-dev
```

`v3-dev` is **one commit, frontend only**, on a base that **predates** main's 012 recipes work. It adds `frontend/src/pages/prototype/{RecipeInventoryPrototype.jsx, recipeData.js, prototype.css}` and points **both** the owner and branch Inventory routes at that one page. The servings pages stay in the code but are no longer shown.

## Side by side

| Topic | main (009 applied + 012 proposed) | v3-dev prototype |
| --- | --- | --- |
| Data | Real: Postgres, API, ledger, triggers | **Sample data in browser state**, lost on reload. No API |
| Who sees what | The owner sees the center plus every branch; the branch manager sees their branch | **The same page** for owner and branch; there's no owner-level view |
| Tabs | Branch: Stock, Recipes, Requests, Deliveries, History. Owner: Stock, Requests, Dispatches, History | Ingredients, Recipes, Purchases, History |
| Units | serving, piece, g, kg, ml, l, stored in the item's own unit; packs | Base units only: **g, ml, piece, serving**. Entered as kg/L and converted |
| Recipes | Multi-line, AI draft (OpenRouter) | Multi-line, local text-parse "draft" |
| Yield % | ✗ | ✓ per ingredient (raw need = recipe ÷ yield) |
| Cost | ✗ | ✓ cost per base unit, set by purchases |
| Food cost per dish | ✗ | ✓ KES and % of price. "Unknown" when an ingredient has no price (never shows 0) |
| Portions possible / limiting ingredient | ✓ (`stock_menu_availability`) | ✓ |
| Hold for open orders | ✓ computed from taken/accepted orders | ✓ simulated |
| Sold out + keep selling | ✓ enforced on order insert | ✓ display only |
| Supplier purchases | ✗ | ✓ invoice: supplier (free text), date, paid by cash, credit or bank, lines with amount + total |
| Main center, requests, dispatch, QR receive | ✓ | ✗ dropped |
| Count / add / waste | ✓ | Partial (via purchase and ingredient edit) |
| Order correction | ✓ | ✗ |
| Ledger / history | ✓ append-only, real | Sample list |
| Batches / expiry / FEFO | ✗ | ✗ |

## What each one is good for

**main** has the right *engine*: ledger, idempotent commands, sold-out enforcement inside the DB, serve-time deduction, and the request → approve → dispatch → receive flow with a QR. Its weakness is the *product model*: a single center, servings-first, no cost and no suppliers.

**v3-dev** has the right *restaurant mental model*: ingredients bought from suppliers, recipes with yield, and food cost per dish, which is the money question owners ask. Its weakness is that none of it is real, and it collapsed owner and branch into one screen while dropping distribution.

## What to carry forward

1. **The engine from main**: ledger, `once()`, triggers, the requests and dispatch flow, and access checks.
2. **These ideas from v3-dev**: base-unit storage (g/ml/piece), which also matches PRD UOM-3; yield %; cost per base unit; purchases as the way stock and cost come in; food cost % with an honest "unknown"; the Purchases tab.
3. **Fix both**: owner and branch keep *different* views. The owner needs multiple warehouses (not one "center") plus suppliers, purchasing and costing across branches. The branch keeps day-to-day stock, receiving and emergency buys.
4. **Unit storage needs a decision before 012 is applied.** 012 stores amounts in the item's own unit (kg with 3 decimals), while v3-dev and the PRD use one base unit with ≥4 decimals. Changing 012 *before* applying it is cheap. Changing it after is a data migration. See question Q-U1.
