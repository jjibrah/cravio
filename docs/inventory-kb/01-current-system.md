# 01 · Cravio today (main @ d3e9033)

## Stack

| Layer | What's there | Note against the PRD |
| --- | --- | --- |
| Backend | Plain Node.js (ES modules) with its own small router (`backend/src/routes/*.js` export `routes` arrays). `pg` for SQL. No framework. | The PRD recommends NestJS/TypeScript, but section 28.1 says to extend working code rather than restructure it. Keep the current stack. |
| Database | Supabase Postgres + Supabase Auth. RLS on. Browsers read a few tables directly; all writes go through the API using the service role. | Matches the PRD's requirements: Postgres, `numeric`, row locks, RLS. |
| Migrations | `backend/db/migrations/NNN_*.sql` (applied). `backend/db/proposed/` holds files waiting for review, each with a `.down.sql`. Applied with `npm run db:migrate`. | The PRD asks for reversible migrations, and this repo already does that. |
| Frontend | React + Vite, **JavaScript (not TS)**. Pages under `frontend/src/pages/<area>/`. The sidebar is config-driven from `frontend/src/config/dashboards.js`. | |
| Tests | Node scripts run against disposable **PGlite** (`backend/tests/*.js`, `npm run test:v2`). Playwright for the UI. | Good for ledger and concurrency unit tests. A true parallel race test needs real Postgres. |
| AI | `backend/src/lib/ai.js` calls OpenRouter (optional; `OPENROUTER_API_KEY`). | |
| Shared DB | dev, main and v2 all point at **the same database**. A migration affects every branch. | This matters for rollout order. |

## The five interfaces and roles

| Interface | Route | Who | Scope |
| --- | --- | --- | --- |
| Platform admin | `/admin` | Cravio staff (`profiles.role = admin`) | Every business. Sees inventory **counts only**, never stock records. |
| Owner / operations manager | `/owner` | `business_members.role` = `owner` (all branches) or `operations` (assigned branches, read-only) | One business |
| Branch manager | `/branch/:branchId` | `restaurant_members.role` = `manager` or legacy `owner` | One branch |
| Waiter | `/waiter` | `restaurant_members.role = waiter` | One branch; reads availability |
| Guest menu | `/guest-menu?r=` | Public | Sees sold out |

Access code: `backend/src/lib/access.js` and `backend/src/lib/business.js`. The `X-Cravio-Branch` header picks the branch, and the server never guesses. Grants are audited in `access_events`, which is append-only.

**The role model is coarse.** There are no fine-grained permissions (the PRD's `inventory.adjust.approve`-style permissions, RBAC-1/8), no warehouse, storekeeper, procurement or finance roles, and no delegation.

## Organisation model (migration 008)

`businesses` → `restaurants` (branches, `business_id`) → `restaurant_members`. `business_members` + `business_member_branches` hold the owner and operations grants. In the PRD's terms, a **business is the organisation** and **a restaurant is a branch**. The only warehouse-like thing is the inventory **main center** (one per business).

## Order lifecycle (migration 003/005)

`orders.status`: `taken → accepted → served → paid`, or `cancelled`. Payments are recorded in the `payments` table (`pending/succeeded/failed`). There is no M-Pesa, card, eTIMS, shifts, KDS or offline mode. Guests can raise service requests for a waiter, the bill or payment.

## Inventory on main: three layers

### a) 007 "inventory preview" (legacy, still wired)
A `private.stock_*` bakery workspace per owner account, with routes in `backend/src/routes/inventory.js` and the domain in `backend/src/inventory/`. Its UI was removed under decision R7, but the **API route is still registered** in `routes/index.js`. It is unrelated to the 009 tables, despite the similar names. It's a candidate for removal.

### b) 009 inventory (APPLIED 16 Nov 2026)

| Concept | Implementation |
| --- | --- |
| Items | `public.stock_items` per business; `unit` is **`serving` only**, plus `low_level` |
| Locations | `stock_locations`, `kind in ('center','branch')`, with **exactly one center per business** |
| Balances | `stock_balances(location, item, on_hand numeric(12,3))`. No reserved column: "held" is **computed** from `taken/accepted` orders (`private.branch_committed`) |
| Dish → stock | `menu_item_stock` (servings per dish, `allow_when_out`) |
| Ledger | `stock_movements`: append-only (trigger blocks update/delete). Has `delta`, `balance_after` and reason ∈ count, added, waste, served, order_correction, dispatched, received, lost_in_transit, dispatch_cancelled. **No unit cost, no batch.** |
| Idempotency | `stock_commands` (the `commandId` on every write) and `order_stock_effects` (serve deducts once per order line and item) |
| Sold out | Trigger `order_items_stock_check` refuses a new line when available < need (409 `stock_sold_out`), with an advisory lock per branch × item |
| Deduction | Trigger `orders_stock_on_serve` deducts on `taken/accepted → served` |
| Override | "Keep selling when out" per dish. **The balance may go negative**, and the item then shows "Count needed" |
| Requests | `stock_requests` + lines: submitted → approved / rejected / cancelled → dispatched → received. The owner approves per line (full, partial or 0). **Approval reserves nothing.** |
| Dispatches | `stock_transfers` (center → branch only): `in_transit / received / cancelled`, a 10-character code + QR, and a printable note. Stock leaves the center at dispatch. Receive ≤ sent, and a shortfall needs a note |
| Corrections | An order correction after serving (e.g. Fanta returned, Coke given instead). The bill is unchanged |

### c) 012 recipes, units and packs (PROPOSED, **not applied**; the code is on main)
- Units: `serving, piece, g, kg, ml, l`, stored **in the item's own unit** with 3 decimals (not a single base unit). Conversion works within a dimension only.
- Packs: one optional `pack_name` + `pack_size` per item ("crate = 10 kg").
- `menu_item_recipes` + `menu_item_recipe_lines`: several ingredients per dish, with the entered unit kept for display. View `private.dish_ingredients` = links ∪ recipes.
- AI recipe draft: `POST /api/stock/recipes/suggest`. It never saves.
- The code checks whether 012 is applied (`hasRecipes`) and falls back to servings when it isn't.
- Not included: yield, cost, sub-recipes, modifiers, purchasing, packs on requests.

### API (`backend/src/routes/stock.js`)
- Branch: `GET /api/stock`, `GET /api/stock/availability`, `POST items`, `PATCH items/:id`, `POST adjust` (count/add/waste), `PUT recipes/:menuItemId`, `POST recipes/suggest`, `PUT links/:id`, `POST orders/:id/correction`, `POST requests`, `POST requests/:id/cancel`, `POST transfers/:id/receive`, `GET receive/:code`
- Owner: `GET /api/owner/stock/:biz` (operations managers see only their branches), `POST items`, `PATCH items/:id`, `POST adjust` (center), `POST requests/:id/review`, `POST dispatches`, `POST dispatches/:id/cancel`
- Pattern: `branchWrite` / `ownerWrite` → one transaction → `once()` (idempotent command) → service function → `invalidateMenu`.

### UI
- **Branch** `/branch/:id/inventory` (`pages/stock/BranchInventoryPage.jsx`): segmented tabs **Stock · Recipes (or "Dish links") · Requests · Deliveries · History**, and task drawers for count, add, waste, edit item, recipe editor, request, receive and correction.
- **Owner** `/owner/inventory` (`OwnerInventoryPage.jsx`): tabs **Stock** (center + a column per branch) **· Requests · Dispatches · History**. It also handles dispatch notes with QR.
- `ReceiveCodePage.jsx`: the landing page for a scanned QR.
- Sidebar today: the branch has `Operations → Inventory` (the only item in that group). The owner has `Business → Locations, People & access, Inventory`. The admin has nothing for inventory.
