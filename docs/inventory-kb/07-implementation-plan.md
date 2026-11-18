# 07 · Inventory module: implementation plan (draft v1, 18 Nov 2026)

Builds on `main`'s engine (ledger, idempotent commands, DB-enforced sold-out, deduct-on-serve, request → dispatch → QR receive) and brings in v3-dev's restaurant model (base units, yield, cost, supplier purchases, food cost %) plus the PRD modules that matter for inventory. Work on `dev`; merge to `main` per work package.

> **Assumptions to confirm** (from 06-open-questions; each is reversible at the point marked):
> A1 Scope = inventory module only. M-Pesa, eTIMS, shifts/KDS, offline are separate later modules.
> A2 Owner acts as head office + procurement + warehouse for now; operations managers are read-mostly; branch managers run the branch. Warehouse staff role arrives in Phase 3 (WP3.9).
> A3 Many warehouses per business; today's "main center" becomes the first warehouse.
> A4 Quantities stored in a **base unit** (g / ml / piece / serving), `numeric(18,4)`. The unapplied 012 is **rewritten**, not applied.
> A5 "Keep selling when out": the sale goes through but stock **floors at zero**; the shortfall is logged as a *stock exception* for review (PRD default). Per-location policy can switch to "allow negative".
> A6 Approving a branch request **reserves** stock at the chosen warehouse.
> A7 Cost method: **weighted average** first; batch/FIFO costing comes with batches (Phase 3).
> A8 Recipes: owner edits in Operations → Items & recipes; branch manager edits its own branch's recipes under Menu (configurable later).

---

## 0. Cross-cutting design (applies to every phase)

### 0.1 Shared-database rule (very important)
`main` and `dev` use **one database**. Every migration must leave `main`'s current code working:
- Additive only: new tables/columns, widened checks (superset of old values), widened numeric precision. Never rename/drop a column `main` reads in the same release.
- Keep `stock_locations.kind = 'center'` valid; new warehouses use `'warehouse'`; code on `dev` treats both as warehouses.
- Triggers that `main`'s orders pass through (sold-out check, serve deduction) must keep their contract: same error code `P0001 / stock_sold_out`, same events.
- Each migration ships with `.down.sql`, a PGlite rehearsal test, and is applied only after review (snapshot → `db:migrate --dry-run` → `db:migrate`), as today.
- Merge `dev` → `main` soon after each migration is applied so the two never drift long.

### 0.2 Module layout (backend)
```
backend/src/inventory2/          (name TBD; replaces src/stock/ gradually, keeps src/stock/ until switched)
  units.js        conversions (config-driven), base-unit maths with exact decimals
  ledger.js       the ONLY writer of stock_movements / stock_balances / reservations
  catalogue.js    items, categories, item units, levels
  recipes.js      recipe versions, expansion (sub-recipes later), costing
  locations.js    warehouses/branches as stock locations
  policies.js     settings + thresholds lookup (org default → location override)
  permissions.js  role → capability map; maker-checker helper
  audit.js        inventory_events writer (before/after)
  purchasing.js   (P2) suppliers, POs, receipts, returns
  emergency.js    (P2) branch purchases
  distribution.js (P2) requests, reservations, transfers, discrepancies
  controls.js     (P3) wastage, adjustments, counts
  production.js   (P3) prep batches
  reports.js      (P3) valuation, variance, food cost, exports
backend/src/routes/inventory-*.js   thin route files per area (branch / owner / admin)
```
Rule (PRD §26): other modules call these services; only `ledger.js` writes quantities.

### 0.3 Ledger contract (`ledger.post`)
Every quantity change = `post(db, { businessId, locationId, itemId, qtyBase (signed), type, ref: {type,id}, unitCost?, counterpartyLocationId?, batchId?, note, actorId, idempotencyKey })` inside the caller's transaction:
1. `SELECT … FOR UPDATE` the balance row (create if missing).
2. Enforce policy: result `on_hand < 0` → refuse (`409 insufficient_stock`) unless type is `pos_consumption` with exception policy (see A5) or policy allows negative.
3. Insert movement (append-only trigger already exists), update balance, update `avg_cost` on inbound with cost.
4. Unique `(idempotency_key, type)` → a replay returns the original row.

Movement types (superset of 009's reasons, so `main` still validates): `opening, purchase_receipt, emergency_receipt, supplier_return, transfer_dispatch, transfer_receipt, transfer_discrepancy, transfer_cancelled, pos_consumption, order_correction, production_input, production_output, wastage, adjustment_gain, adjustment_loss, count_correction, staff_meal, complimentary, reversal` + legacy `count, added, waste, served, dispatched, received, lost_in_transit, dispatch_cancelled`.

### 0.4 Quantities and money
- Stored: `qty numeric(18,4)` in item base unit; `unit_cost numeric(18,6)` KES per base unit; money `numeric(14,2)`.
- JS: never `Number` maths on quantities/money in the ledger path — use a small decimal helper (strings + BigInt scaled by 10⁶) or do arithmetic in SQL. UI may format with Number.
- Display: per item `display_unit` (e.g. kg for a g item) + packs: “38.4 kg · about 3.8 crates”.

### 0.5 Permissions (lightweight RBAC now, PRD-shaped)
`permissions.js` maps roles to capabilities, e.g. `inv.item.edit`, `inv.recipe.edit`, `inv.adjust.create`, `inv.adjust.approve`, `inv.request.create`, `inv.request.approve`, `inv.transfer.dispatch`, `inv.transfer.receive`, `inv.purchase.create`, `inv.purchase.approve`, `inv.emergency.create`, `inv.emergency.approve`, `inv.count.run`, `inv.count.approve`, `inv.report.view`, `inv.settings.edit`.
| Role | Default capabilities |
| --- | --- |
| Business owner | everything for the business |
| Operations manager | view everything in assigned branches; `request.approve`, `adjust.approve` within limits (toggle) |
| Branch manager | branch stock, counts, wastage, requests, receive, emergency purchase (within limit), recipes for own branch |
| Waiter | read availability; (P3) record wastage “limited” |
| Platform admin | none on stock; entitlement + global defaults only |
Every check is server-side and location-scoped. **Maker-checker**: `approver_id ≠ created_by`, enforced in SQL check where possible. Capabilities stored in code in Phase 1; an editable `role_capabilities` table is optional in Phase 3.

### 0.6 Audit
`inventory_events` (append-only): actor, role, location, entity, action, before/after JSON, at. Written for item/recipe/settings edits, approvals, rejections, cancellations. Ledger rows are their own audit for quantities.

### 0.7 UI conventions
Reuse `PageHeader`, `Panel`, `Segmented`, `TaskDrawer`, `SkeletonRows`, `EmptyState`. Unit shown next to every quantity input, defaulting to the item's usual unit; confirmation for unusually large amounts (e.g. > 10× typical). No button without server logic. KES formatting, dd/mm/yyyy, EAT.

---

## Phase 1 — Foundation: catalogue, units, warehouses, recipes & food cost
**Goal:** every location's stock is in real units with cost; dishes take real ingredients off stock with versioned recipes; owner sees food cost per dish. Thin vertical slice: one warehouse, one branch, a few ingredients, one recipe, an order served → stock and cost move.

### WP1.0 Pre-work
- Delete proposed `012_recipes_units.sql` (never applied) — superseded by 012 below.
- Remove legacy 007 preview: route `routes/inventory.js`, `src/inventory/`, tests; leave `private.stock_*` tables (drop later after confirming empty).
- Snapshot counts of existing 009 data (items, balances, links, requests, transfers) for the migration test.

### WP1.1 Migration 012 — catalogue & units
| Table / change | Columns (key) |
| --- | --- |
| `units` (config, seeded) | `code` pk, `dimension` (weight/volume/count), `factor_to_base` numeric(24,12), `label`. Seed: mg, g, kg; ml, l, tsp(5), tbsp(15), cup(240); piece; serving |
| `stock_categories` | business, name, parent_id, position, active. Seed PRD §5.3 list on first use |
| `stock_items` + | `base_unit` (g/ml/piece/serving), `display_unit`, `kind` (raw/prepared/resale/packaging/consumable), `sku` (unique per business, nullable), `category_id`, `storage` (ambient/chilled/frozen/dry), `yield_pct` numeric(5,2) default 100, `avg_cost`, `last_cost` numeric(18,6), `vat_class` (standard/zero/exempt; stored only), `archived_at`. Existing `unit='serving'` items → `base_unit='serving'` |
| `stock_item_units` | item, `name` (crate, sack, tray, bottle…), `factor` (base units per 1), `use_for` (purchase/recipe/count flags). Replaces 012's single pack |
| `stock_item_barcodes` | item, code (unique per business) |
| `stock_item_levels` | location, item, `min`, `reorder`, `par`, `max`. Old `low_level` read as org default |
| `stock_balances` | widen `on_hand` to (18,4); add `reserved` (18,4) default 0 (used from P2) |
| `stock_movements` + | widen `delta`/`balance_after`; add `unit_cost`, `value`, `ref_type`, `ref_id`, `counterparty_location_id`, `batch_id` (null until P3), `idempotency_key`, `occurred_at`; superset reason check; unique `(idempotency_key, reason)` where key not null |
| `stock_locations` | allow `kind='warehouse'`; keep `'center'`; add `code`, `status` (active/suspended/archived), `archived_at` |
| `inventory_settings` | business, location (null = default), `key`, `value jsonb`. Keys: negative_policy, low_alert, cost_method, display defaults |
| `inventory_events` | audit (0.6), append-only trigger |
Rules: base unit immutable once any movement exists (trigger). Conversions across dimensions refused (no density in Phase 1; density = Phase 3 optional).

### WP1.2 Migration 013 — recipes v2 & order snapshots
| Table | Notes |
| --- | --- |
| `recipes` | one per (menu_item) or per (stock_item of kind prepared, P3). `current_version_id`, `allow_when_out` |
| `recipe_versions` | recipe, `version` int, `effective_from`, `created_by`, `note`, `status` (active/superseded). **Immutable once any order line references it** |
| `recipe_lines` | version, item, `qty_base` (per ONE dish, before yield), `entered_qty`, `entered_unit`, `takeaway_only` bool, position |
| `menu_extra_recipe_lines` | extra (menu_item_extras.id), item, `qty_base` — extras like “extra cheese +30 g” (MNU-3 add-ons) |
| `order_stock_lines` (**snapshot**) | order_item_id, item_id, `qty_base` (yield applied), `recipe_version_id`, `source` (dish/extra/deal_component). Filled by trigger **on order_items insert** |
Behaviour changes (DB functions replaced, same contracts):
- `order_dish_needs` now reads the snapshot; holds = Σ snapshot of `taken/accepted` orders (until P2 moves holds into `reserved`).
- Expansion at insert: dish → current recipe version lines; deal → each component's recipe × component qty; extras → extra lines × line qty; `qty_base = line_qty × recipe_qty / (yield_pct/100)`, aggregated per item.
- Sold-out check aggregates needs across the whole order (shared buns summed) under the advisory lock, as today.
- Serve: `pos_consumption` movement per (order line, item) from the snapshot with `unit_cost = avg_cost`; `order_stock_effects` keeps it once-only.
- A5 shortfall: if a keep-selling dish is served with less on hand than needed, deduct to zero and write `stock_exceptions` (order, item, short_qty, status open/resolved).
- Data migration: each 009 `menu_item_stock` link → recipe v1 with one line (servings).

### WP1.3 Backend services & API
- `ledger.js`, `units.js`, `catalogue.js`, `recipes.js`, `locations.js`, `policies.js`, `permissions.js`, `audit.js`.
- Owner API `/api/owner/inventory/:biz/…`: items CRUD/archive, item units, categories, levels, warehouses (create/rename/archive — archive only when stock is zero), recipes (create version, preview cost), CSV import items (dry run → report → commit), opening balances (as `opening` movements, once per item+location unless reversed), stock across locations.
- Branch API `/api/inventory/…`: stock at branch, count/add/waste (Phase-1 simple forms, now unit-aware with cost), recipes for own dishes, exceptions list/resolve, availability for waiter/guest (unchanged shape).
- Keep `/api/stock/*` working until the UI switches (feature flag), then remove.

### WP1.4 UI
Sidebar (Operations group):
- **Owner**: Stock · Items & recipes · Warehouses (inside Locations if preferred) · History.
- **Branch**: Stock · History; Menu → Recipes.
- Pages: Item editor (base unit chooser with plain words: “Weighed (kg/g)”, “Measured (L/ml)”, “Counted (pieces)”, “Servings”), purchase/recipe units table, levels per location; Recipe editor (v3-dev layout: lines, entered units, yield shown, **food cost + %**, “unknown” when an ingredient has no cost, version history); Stock table (on hand, held, available, value, low badge); opening-stock wizard (per location, counts → opening movements); CSV import with dry run.
- Admin: Businesses → “Inventory” toggle (entitlement flag on business) + counts only.

### WP1.5 Cases Phase 1 must handle
| Case | Expected |
| --- | --- |
| Receive/count 5 kg of a g item | +5000 g; entered “5 kg” kept on the movement |
| Recipe 200 g chicken, yield 70% | 285.7143 g taken per dish |
| Order 3 burgers + 2 sliders sharing buns | Buns aggregated before check |
| Deal with 2 dishes + extra cheese | Components × qty + extra lines expanded |
| Recipe edited after an order was placed | Open order keeps old version; new orders use new version; past consumption unchanged (T-POS-5) |
| Dish without recipe | Untracked; never sold out by stock |
| Ingredient archived while in a recipe | Archive refused (or recipe must be changed first) |
| Base unit change after history | Refused with clear message |
| kg ↔ L without density | Refused (T-INV-4) |
| Repeated kg→g→kg | No drift (T-INV-5) |
| Order cancelled before serve | Hold released, nothing deducted |
| Same serve replayed 5× | One deduction (T-POS-4) |
| 150 g on hand, 100 g/burger | 1 available; 2nd refused; keep-selling → served, stock 0, exception logged (T-POS-6) |
| Two waiters race for the last portion | One succeeds (advisory lock) (T-INV-7 on real PG before release) |
| Branch user calls another branch's stock | 403 + audit (T-SEC-1) |
| UPDATE/DELETE a movement | Denied by trigger (T-SEC-3) |
| Ingredient with no cost | Food cost “unknown”, never 0 |
| Main's old pages after migration | Still load; servings items unchanged |

### WP1.6 Tests & exit criteria
PGlite: `tests/inv-units.js`, `inv-ledger.js`, `inv-recipes.js`, `inv-orders.js` (+ migration rehearsal incl. rollback and 009 data carry-over). Playwright: item → recipe → order → serve → stock. Exit: T-INV-1..6, T-POS-1..7, T-SEC-1,3 pass; reconciliation query (Σ movements = balance) returns zero rows.

---

## Phase 2 — Purchasing & distribution
**Goal:** stock and cost enter through suppliers; branches get stock from warehouses with reservations; branches can buy in an emergency within limits; owner approves from one inbox.

### WP2.1 Migration 014 — suppliers & purchasing
| Table | Key columns |
| --- | --- |
| `suppliers` | business, name, contact, phone (254 format), email, kra_pin, `type` (formal/informal/one_off), payment_terms_days, mpesa/bank details, status, `incomplete` flag (on-the-spot) |
| `supplier_items` | supplier, item, supplier_sku, purchase unit, rank |
| `supplier_prices` | supplier, item, unit, price, `effective_from`; history kept |
| `purchase_orders` + `po_lines` | number (per business/year), supplier, deliver_to location, expected_date, status `draft → pending_approval → approved → sent → partially_received → received → closed / cancelled`, totals |
| `goods_receipts` + `grn_lines` | po_id (nullable = unplanned with reason), location, per line: ordered, received, rejected, unit + factor snapshot, unit_cost, batch/expiry (stored, used in P3) |
| `supplier_invoices` | supplier, number, date, supplier PIN, eTIMS invoice no. (free text, VERIFY), amounts, VAT, attachment, status unpaid/part/paid (P3 aging) |
| `supplier_returns` | grn/line, qty, reason, credit amount |
| `approval_rules` | business, subject (po, emergency, wastage, adjustment, count), band min/max, approver capability, location/category scope, period limits |
| `approvals` | subject_type/id, requested_by, status pending/approved/rejected, decided_by (≠ requested_by), reason, at |
| `attachments` | owner entity, storage path (Supabase Storage bucket `inventory-evidence`, private), mime, size |

### WP2.2 Migration 015 — emergency purchases
`emergency_purchases`: branch, item lines, supplier (or new incomplete supplier), estimated/approved/actual amounts, payment method (cash/M-Pesa/credit) + reference, reason, `invoice_status` (etims/other/none), evidence ids, status `draft → pending_approval → authorised → purchased → received → under_review → closed / rejected`.
Threshold check (EMP-1): per transaction, per branch per day/week cumulative, per category — all from `approval_rules`; below → auto-authorised; above → approval.
No-invoice requires reason + goods photo + payment reference (T-EMP-3).

### WP2.3 Migration 016 — distribution upgrade
- `stock_requests`: statuses → `draft, submitted, approved, partially_approved, rejected, preparing, dispatched, partially_received, received, completed, cancelled` (superset).
- `stock_request_lines` + `source_location_id`, `approved`, `dispatched`, `received`. One request may split across warehouses → one transfer per source.
- `stock_reservations`: location, item, qty, ref (request line / production later), status active/released/consumed. `available = on_hand − reserved − order holds`.
- `stock_transfers`: any location → any location (W→W, W→B, B→W returns, B→B with both-sides approval policy). Lines + `damaged`, `over`.
- `transfer_discrepancies`: line, short/damaged/over qty, status open → resolved, `bearer` (carrier/source/destination), resolution movement.

### WP2.4 Services, API, UI
- **Owner → Operations → Purchasing**: Suppliers (list, profile, price history), Purchase orders (create from **reorder suggestions**: items below reorder/par per location minus open POs), approve (bands), send (PDF + WhatsApp share link), Receive (GRN against PO or unplanned), Returns. GRN posts `purchase_receipt` with cost → updates `avg_cost`/`last_cost`; price variance alert above X% vs PO/last price (GRN-6).
- **Owner → Requests & transfers**: approve/partial/reject per line, choose source warehouse(s) (default: warehouse with most available), reserve on approval, pick list (printable / mobile), dispatch (partial allowed, delivery note + QR as today), transfer between any locations, discrepancy review queue.
- **Owner → Approvals**: one inbox for POs, emergency buys, (P3) wastage/adjustments/count variances; shows who asked, amount, rule triggered.
- **Branch → Requests & deliveries**: create request (suggested quantities from par/reorder and recent use), track status, receive with short/damaged/over per line.
- **Branch → Purchases**: emergency buy form (v3-dev purchase form + threshold indicator “within your KES X limit”), evidence upload (camera), on-the-spot supplier.
- Notifications (in-app, existing NotificationCenter): request submitted/approved/rejected/dispatched, delivery incoming, discrepancy, approval needed, price variance, low stock.

### WP2.5 Cases Phase 2 must handle
| Case | Expected |
| --- | --- |
| Branch asks 20 kg, owner approves 15 | Partially approved; 15 kg reserved at source (T-REQ-1) |
| Dispatch 15, branch receives 14 | Source −15, branch +14, 1 kg discrepancy open + notified (T-REQ-2) |
| Cancel before dispatch | Reservation released (T-REQ-3) |
| Approve more than available | Refused with available shown |
| Split request across 2 warehouses | Two transfers, two notes, request tracks both |
| Damaged on arrival | Recorded; damaged qty not added; discrepancy for review |
| Over-delivery | Allowed only up to policy; extra recorded |
| QR scanned by another branch / waiter | 403 |
| Cancel dispatch after partial receipt | Refused; resolve via discrepancy |
| PO → partial GRN → 2nd GRN → supplier return | Balances, PO status, credit correct (T-PRC-1) |
| GRN price 20% above last | Variance alert |
| Emergency below threshold | Auto-authorised; stock on receipt (T-EMP-1) |
| Emergency above threshold | Blocked until a different user approves (T-EMP-2) |
| Weekly cumulative limit exceeded by small buys | Next one routed to approval |
| No-invoice without photo/ref | Rejected (T-EMP-3) |
| Change threshold in settings | Applies immediately, no code change (T-EMP-4) |
| Same item bought in emergency 3× in a week | Alert to adjust par (EMP-7) |
| Approver tries to approve own PO | Denied (T-SEC-2) |

### WP2.6 Exit criteria
T-REQ-1..3, T-PRC-1, T-EMP-1..4, T-SEC-2 automated; full request→receipt and PO→GRN flows in Playwright; reconciliation zero.

---

## Phase 3 — Controls, production, batches & reporting
**Goal:** prove where stock went (wastage, counts, variance), prep kitchens, expiry, and the reports owners act on.

### WP3.1 Wastage & adjustments (migration 017)
`stock_reason_codes` (configurable: burned, spoiled, expired, prep error, spill, damaged, customer return, over-production, theft suspected); `wastage_records` (item or **menu item expanded via recipe**, qty, reason, cost from avg, photo, status); `stock_adjustments` (gain/loss, reason, evidence, status). Above value/qty threshold → approval (maker-checker). Unusual wastage (vs 4-week rolling average) → alert. Staff meal / complimentary as own types with allowance limits.

### WP3.2 Stock counts (migration 018)
`stock_counts` (location, type full/cycle/spot, category/zone filter, blind flag, status `open → counting → under_review → approved → posted / cancelled`, snapshot_at) + `stock_count_lines` (expected at snapshot, movements since snapshot, counted per counter, recount flag, variance qty/value). Variance = counted − (expected + movements during count). Beyond tolerance → approval; post as `count_correction`. Replaces the single-item “count”.

### WP3.3 Production / prepared items (migration 019)
Prepared stock items get recipes (sub-recipes, cycle detection). `production_orders`: planned qty, inputs reserved, actual output, yield variance; posts `production_input` (−) and `production_output` (+) linked by production id, output cost = Σ input cost / output qty. Dish recipes may use prepared items (consumed as stock, not re-expanded).

### WP3.4 Batches, expiry, FEFO (migration 020)
`batches` (item, number, supplier, received, expiry, unit_cost) + `batch_balances` (location, item, batch). Item `expiry_tracking` off/optional/mandatory. GRN/production create batches; consumption, dispatch and wastage allocate FEFO (FIFO if no expiry); expired batches blocked from POS/transfers/production with manager override + reason; near-expiry alerts; traceability (batch → movements → orders). Batch cost becomes available as cost method.

### WP3.5 Costing, variance & reports
- Valuation by location/category/date (avg cost; batch cost once 3.4 lands).
- Theoretical usage (Σ order_stock_lines served) vs actual (opening + receipts ± transfers − wastage − closing count) by item/branch/period; variance in qty and KES with tolerance highlighting (CST-3/4).
- Menu engineering: food cost %, margin, popularity (from orders) per dish and branch (CST-5); price-change impact list (CST-6).
- Reports (17.2 subset): valuation, movement ledger, consumption, variance, wastage, expiry, procurement spend (central vs emergency), emergency compliance, supplier performance, stock turnover/days on hand. CSV for all; PDF for key ones; background job for long ranges.
- Dashboards: owner Overview tiles (inventory value, low/expiring, pending approvals, in transit, emergency spend, variance alerts) with drill-down to ledger rows; branch Overview tiles.

### WP3.6 Reliability & governance
- Scheduled reconciliation (balances vs ledger) + alert; manual reconcile report (LED-5).
- Period close/lock (LED-8).
- Editable `role_capabilities` per business (RBAC-8) and approval delegation (RBAC-4).
- Platform admin: inventory entitlement, global unit/pack presets, reason-code defaults.

### WP3.7 Cases Phase 3 must handle
| Case | Expected |
| --- | --- |
| Wastage above threshold | Separate ledger type, approval, cost recorded (T-CTL-1) |
| Count variance beyond tolerance | Review + approval before posting (T-CTL-2) |
| Sales during a count | Movements since snapshot included; fair variance |
| Blind count | Counters never see expected qty |
| Two counters disagree | Recount request; reviewer chooses |
| FEFO across 3 batches | Earliest expiry first; expired blocked (T-CTL-3) |
| Prep batch yields less than planned | Variance recorded; output cost higher per unit |
| Recipe cycle (A uses B uses A) | Refused on save |
| Variance report on seeded data | Matches hand calculation (T-RPT-1) |
| CSV/PDF export | Totals match screen (T-RPT-2) |

### WP3.8 Exit criteria
T-CTL-1..3, T-RPT-1..2, T-INV-6/7 on real Postgres, reconciliation job green for 7 days on pilot.

### WP3.9 (optional, end of Phase 3) Warehouse staff role
Location-scoped role for warehouses (warehouse manager, storekeeper) working inside the owner area limited to their warehouse(s): pick, dispatch, receive GRN, counts; no approvals for storekeeper.

---

## Later modules (outside this plan)
M-Pesa (Daraja STK + reconciliation), KRA eTIMS (OSCU/VSCU adapter), shifts/cash-up, KDS stations, offline PWA sync, delivery platforms, accounting exports API, recall workflow, demand forecasting. The inventory ledger is designed so these plug in (e.g. `pos_consumption` is already idempotent per order line; eTIMS item codes can map onto `vat_class`).

## Sequencing summary
| Phase | Migrations | Main deliverable | Rough size |
| --- | --- | --- | --- |
| 1 | 012 catalogue & units, 013 recipes & snapshots | Real units, warehouses, versioned recipes, food cost, sold-out on real ingredients | Largest backend change (touches order triggers) |
| 2 | 014 purchasing, 015 emergency, 016 distribution | Suppliers → POs → GRN, emergency buys with limits, reservations, any-to-any transfers, approvals inbox | Most UI |
| 3 | 017 wastage/adjust, 018 counts, 019 production, 020 batches | Controls, prep, expiry, variance & reports | Most reporting |

Each WP ends with: migration reviewed + rehearsed, tests green, KB updated, PR `dev → main`.
