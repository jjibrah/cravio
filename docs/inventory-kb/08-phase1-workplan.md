# 08 · Phase 1 work plan (how we actually start)

Turns Phase 1 of `07-implementation-plan.md` into tickets you can pick up one at a time. Estimates assume one developer working with Claude; **≈ 27 working days (5–6 weeks)**. Each ticket is small enough for one PR into `dev`.

## How we work

| Topic | Rule |
| --- | --- |
| Branches | `main` (stable) ← `dev` (integration) ← short-lived `inv/p1-NN-short-name` per ticket. PR ticket → `dev`; PR `dev` → `main` at each milestone. |
| Commits | One ticket = one PR; PR description lists what was tested. Set your git identity first (`git config user.name/user.email`). |
| Database | Migrations live in `backend/db/proposed/` until reviewed. Tested only on disposable PGlite (`backend/tests/support/pg.js` → `freshDatabase({ extra: ['proposed/012_…sql'] })`). **Nothing touches the shared database until P1-19.** |
| Compatibility | Every migration ticket re-runs the existing suites (`npm run test:v2`, esp. `inventory-v2.js`) with the new migration applied, to prove `main`'s code still works on the shared DB. |
| Tests | New suites under `backend/tests/inv/` run by `npm run test:inv`. Name checks after PRD IDs (`T-INV-1 …`) so coverage is traceable. |
| Definition of done (each ticket) | Code + tests green (`test:inv` — includes `server-load.test.js`, which loads every route module — `test:inv:compat`, `test:v2`, `npm run build`) · UI follows `DESIGN.md` and 07 §0.7 (same components, plain words, unit picker, mobile check) · no UI without working API · server-side permission checks · audit/ledger entries for state changes · KB doc touched if behaviour or schema changed. |
| Feature switch | New UI sits behind `businesses.inventory_enabled` (and a dev env flag) until P1-19, so `main` users see no change. |

## Decisions needed before coding the schema

| Blocks | Decision | Default in this plan |
| --- | --- | --- |
| P1-05 | A3 warehouses | **Decided 18 Nov: one per business** (the center, labelled Warehouse) |
| P1-05 | A4 units | **Decided: base-unit storage, user-chosen entry/display units per item** |
| P1-09 | A5 selling past zero | **Decided: stop at 0, log exception, notify owner + branch manager** |
| P1-14/16 | A8 who edits recipes | **Decided: owner (all branches) + branch manager (own branch)** |
A1, A2, A6, A7 only affect Phase 2/3 and can be confirmed later.

## Milestones

| Milestone | Tickets | Outcome | ~Days |
| --- | --- | --- | --- |
| M0 Ready | P1-01 → P1-03 | Decisions recorded, repo clean, test harness | 1.5 |
| M1 Engine | P1-04 → P1-08 | Units, schema, ledger, permissions, catalogue API (tested, no UI) | 8 |
| M2 Orders use recipes | P1-09 → P1-12 | Versioned recipes, order snapshots, serve deducts real ingredients with cost; branch API | 7.5 |
| M3 Screens | P1-13 → P1-17 | Operations sidebar, owner + branch + admin screens | 8 |
| M4 Release | P1-18 → P1-19 | E2E + real-Postgres race test, migrations applied, `dev` → `main` | 1.5 |

Suggested **de-risk spike on day 2**: a throwaway PGlite script proving the order-snapshot trigger (P1-09) works for dishes, deals (`order_items.components` JSON) and extras (`order_items.extras` JSON). It's the riskiest piece; finding a problem in week 3 would be costly.

---

## Tickets

### M0 — Ready

**P1-01 Record decisions, commit the KB** · 0.5 d
- Confirm A3/A4/A5/A8 (table above); write answers into `docs/v2/DECISIONS.md` answer log and `06-open-questions.md`.
- Commit `docs/inventory-kb/` to `dev`.
- Done when: decisions logged with date; KB on `dev`.

**P1-02 Clean up superseded inventory code** · 0.5 d
- Delete `backend/db/proposed/012_recipes_units.sql` + `.down.sql` (never applied; replaced by new 012).
- Remove the legacy 007 preview API: `backend/src/routes/inventory.js` (and its entry in `routes/index.js`), `backend/src/inventory/`, `backend/tests/inventory.js`, `test:inventory` script. Frontend does not call `/api/inventory` (checked). Leave `private.stock_*` tables; note a later drop.
- Keep `backend/src/stock/` running until P1-12/P1-15 switch over.
- Done when: `npm run test:v2` + `npm run build` pass.

**P1-03 Test harness for the new module** · 0.5 d
- `backend/tests/inv/` + `npm run test:inv` (runs every file there).
- Helper `inv/fixture.js`: fresh DB with committed migrations + proposed 012/013, seeded business, one warehouse, one branch, owner, branch manager, waiter, two menu items, one deal, one extra.
- Read-only script `backend/scripts/inventory-census.js`: counts current 009 rows on the shared DB (items, balances, links, open requests/transfers) → saved for the migration rehearsal. **Read-only, no writes.**
- Done when: an empty smoke test passes; census numbers recorded in the PR.

### M1 — Engine

**P1-04 Decimal + units library** · 1 d
- `backend/src/inventory2/decimal.js`: parse/format/add/mul/div with fixed scale (qty 4 dp, cost 6 dp, money 2 dp) using BigInt; no float in ledger paths.
- `backend/src/inventory2/units.js`: config-driven (reads `units` table / passed rows), `toBase(qty, unit, item)`, `fromBase`, `display(qtyBase, item)` (“38.4 kg · about 3.8 crates”), cross-dimension refusal, per-item units (crate=10 kg). Port the alias table from `src/lib/units.js`.
- Tests: T-INV-3 (L→ml; carton 24 vs 12 per item), T-INV-4 (kg→L refused), T-INV-5 (kg→g→kg ×1000 no drift), precision refusal.

**P1-05 Migration 012 — catalogue, units, locations, ledger columns** · 2 d
- File `backend/db/proposed/012_inventory_catalogue.sql` + `.down.sql`, contents per 07 §WP1.1: `units` (seeded), `stock_categories`, new `stock_items` columns, `stock_item_units`, `stock_item_barcodes`, `stock_item_levels`, widened numerics, `stock_balances.reserved`, ledger columns + superset reason check + unique idempotency, `stock_locations` `warehouse` kind / code / status, `inventory_settings`, `inventory_events` (append-only), `businesses.inventory_enabled`.
- Triggers: base unit immutable after first movement; archived items can't receive new movements.
- Data step: existing items → `base_unit='serving'`; `low_level` → org-default level; existing center keeps `kind='center'`.
- Tests: rehearsal on PGlite with seeded 009 data (from census shape) → counts identical; `inventory-v2.js` still passes with 012 applied; down migration restores and refuses when new data exists.

**P1-06 Ledger service** · 2 d
- `inventory2/ledger.js` `post()` per 07 §0.3 (lock, policy, insert, balance, avg cost on inbound), `reverse(movementId)`, `reconcile(db, scope)` query.
- Tests: T-INV-1 (+5,000 g, entered 5 kg kept), T-INV-2 (−300 g → 4,700), T-INV-6 (random ops → zero diffs), idempotent replay returns first row, negative refused, UPDATE/DELETE denied (T-SEC-3), weighted average cost maths.

**P1-07 Policies, permissions, audit** · 1 d
- `policies.js` (org default → location override lookup, typed keys), `permissions.js` (capability map 07 §0.5, `require(ctx, cap, locationId)`, maker-checker helper), `audit.js` (before/after writer).
- Tests: each role × capability matrix; operations manager limited to assigned branches; admin denied; T-SEC-1 shape (403 + event).

**P1-08 Catalogue & locations service + owner API** · 2 d
- `catalogue.js`, `locations.js`; routes `backend/src/routes/inventory-owner.js` under `/api/owner/inventory/:biz/…`: items (list/create/edit/archive), item units, barcodes, categories (seed defaults on first use), levels per location, warehouses (create/rename/suspend/archive — archive only at zero stock, ORG-4).
- Every write: one transaction + `once()` idempotency (reuse pattern from `routes/stock.js`) + audit event.
- **Authorize before opening the write transaction** (`inventoryScope` + `authorize` on the pool), so a refused attempt's `denied` audit row is not rolled back. A DB guard error aborts the transaction: map it to HttpError and let the route roll back (no savepoints needed).
- Tests: duplicate SKU/barcode refused, base-unit change after history refused, archive rules, operations manager read-only.

### M2 — Orders use recipes

**P1-09 Migration 013 — recipes & order snapshots** · 3 d (riskiest; spike already done on day 2)
- File `013_inventory_recipes.sql` + down, per 07 §WP1.2: `recipes`, `recipe_versions` (immutable once used), `recipe_lines`, `menu_extra_recipe_lines`, `order_stock_lines`, `stock_exceptions`.
- Replace (same names/contracts) `order_dish_needs`, `order_stock_needs`, `stock_check_new_lines`, `stock_on_serve`, `stock_menu_availability` to read the snapshot; new trigger fills `order_stock_lines` on `order_items` insert (dish + deal components + extras, yield applied, aggregated per item).
- Serve writes `pos_consumption` with `unit_cost = avg_cost`; keep-selling shortfall → stop at 0 + `stock_exceptions` row + in-app notification to owner(s) and branch managers (also when an item first hits zero).
- Data step: each `menu_item_stock` link → recipe v1 with one line.
- Tests: T-POS-1 (reserve 300 g, serve → 1,700 g, consumption references order), T-POS-2 (shared buns aggregated), T-POS-3 (cancel releases; orders are insert-only so “modify” = cancel + new order — documented), T-POS-4 (replay serve ×5 → one deduction), T-POS-5 (edit recipe after sale → old order unchanged), T-POS-6 (150 g / 100 g → 1 available, override → exception), T-POS-7 (yield 70%), deal + extra expansion, untracked dish unaffected, `inventory-v2.js` still green.

**P1-10 Recipe service + API** · 1.5 d
- `recipes.js`: save = new version (old superseded, never edited when used), preview (“1 Chicken burger uses 285.7 g chicken (200 g at 70% usable) · KES 186”), food cost & % with “unknown” list, version history, port AI suggest from `src/stock/recipes.js` + `lib/ai.js` (draft only).
- Routes: owner `/api/owner/inventory/:biz/recipes/:menuItemId` (any branch), branch `/api/inventory/recipes/:menuItemId` (own branch, capability-checked).
- Tests: version immutability, cost maths, unknown cost never 0, branch manager can't edit another branch.

**P1-11 Opening balances + CSV import** · 1.5 d
- Opening stock per location: posts `opening` movements; second opening for the same item/location refused unless reversed (CNT-5).
- CSV import (items, units, levels, opening qty): dry-run returns row-by-row report (errors, warnings, creates/updates); commit applies in one transaction. Template CSV in `docs/inventory-kb/templates/`.
- Tests: bad unit, duplicate SKU, unknown category, dry-run writes nothing, commit idempotent.

**P1-12 Branch API on the new engine** · 1.5 d
- `backend/src/routes/inventory-branch.js` `/api/inventory/…`: stock snapshot (on hand, held, available, value, low), count/add/waste via ledger (unit-aware, cost), history, exceptions list/resolve, availability (same response shape as today for waiter/guest).
- Switch waiter/guest availability calls; keep `/api/stock/*` until the UI switch in P1-15, then delete `src/stock/` + old routes in that PR.
- Tests: branch isolation (T-SEC-1), waiter read-only, availability shape unchanged.

### M3 — Screens

**P1-13 Navigation & plumbing** · 0.5 d
- `frontend/src/config/dashboards.js`: owner `Operations` group (Stock, Items & recipes, History); branch `Operations` (Stock, History) + `Menu → Recipes`. Routes in `App.jsx`; API client helpers in `frontend/src/lib/inventory.js`.
- Hidden unless `inventory_enabled` (old Inventory page shown otherwise).

**P1-14 Owner screens** · 3 d
- Stock across locations (filters: location, category, low, search; CSV export), Items list + item editor (plain-word base unit picker, units/packs table, levels per location, archive), Warehouse name (in Locations page; one per business), Opening stock wizard, CSV import (upload → dry-run report → confirm).
- Playwright: create item in kg with a crate unit, set levels, opening stock 40 crates → shows 400 kg.

**P1-15 Branch screens** · 2 d
- Stock (on hand / held / available / low, count/add/waste drawers with unit dropdown + converted total), History, Exceptions banner + resolve. Remove old `pages/stock/*` and `src/stock/` once parity is reached.

**P1-16 Recipe editor with food cost** · 1.5 d
- Port the v3-dev layout (`docs/inventory-kb/v3-prototype/`) onto the real API: lines with entered units, yield note, live preview, food cost + % / “unknown”, keep-selling switch, version history, ✨ AI draft. Used by owner (choose branch) and branch manager.

**P1-17a Design review of all inventory screens** · 0.5 d
- Review owner, branch and admin inventory screens against `DESIGN.md` and 07 §0.7 (consistency with Orders/Locations, plain words, touch targets, contrast, phone/tablet widths). Fix findings before M4.

**P1-17 Admin entitlement** · 0.5 d
- Admin → Businesses → business detail: “Inventory module” on/off (audited in `access_events`); counts only, no stock records.

### M4 — Release

**P1-18 End-to-end + real Postgres race** · 1 d
- Playwright: owner creates items/recipe → branch opening stock → waiter orders → serve → stock and food cost update; sold out appears on guest menu; cancel releases hold.
- T-INV-7: 50 parallel deductions against a **local real Postgres** (Docker), not the shared DB.

**P1-19 Apply and merge** · 0.5 d
- Runbook: snapshot shared DB → move 012/013 to `migrations/` → `npm run db:migrate -- --dry-run` (only 012, 013) → `npm run db:migrate` → run census again (counts match) → switch on `inventory_enabled` for the test business only → smoke test → PR `dev` → `main`.
- Rollback: down files, in reverse order; refuse if new-unit data exists (export first).
- Update KB 01 (current system) and 04 (gap statuses).

---

## First week, day by day

| Day | Work |
| --- | --- |
| 1 | P1-01 decisions + commit KB · P1-02 cleanup · P1-03 harness + census |
| 2 | **Spike**: order snapshot trigger on PGlite (dish, deal, extra) · start P1-04 |
| 3 | P1-04 units/decimal done · start P1-05 migration 012 |
| 4 | P1-05 rehearsal + compatibility with `inventory-v2.js` |
| 5 | P1-06 ledger service + tests |

## Risks to watch in Phase 1

| Risk | Mitigation |
| --- | --- |
| Changing order triggers on the shared DB affects `main`'s live orders | Same function names/error codes; run `test:v2` + `order-flow.spec.js` against 013; apply in a quiet window with snapshot |
| Snapshot trigger misses a line type (deal/extra) | Day-2 spike; tests per line type |
| Decimal mistakes in JS | Ledger maths in SQL or BigInt helper; no `Number` in ledger path |
| Scope creep into Phase 2 (suppliers, POs) | Anything not in this list goes to Phase 2 backlog |
| Existing 009 data on shared DB | Census before/after; data steps tested with seeded copies |
