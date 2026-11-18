# 07 · Inventory module: implementation plan (draft v1, 18 Nov 2026; updated 18 Nov with product owner answers INV-P2/P3)

Builds on `main`'s engine (ledger, idempotent commands, DB-enforced sold-out, deduct-on-serve, request → dispatch → QR receive) and brings in v3-dev's restaurant model (base units, yield, cost, supplier purchases, food cost %) plus the PRD modules that matter for inventory. Work on `dev`; merge to `main` per work package.

> **Assumptions to confirm** (from 06-open-questions; each is reversible at the point marked):
> A1 Scope = inventory module only. M-Pesa, eTIMS, shifts/KDS, offline are separate later modules.
> A2 Owner acts as head office + procurement + warehouse for now; operations managers are read-mostly; branch managers run the branch. Warehouse staff role arrives in Phase 3 (WP3.9).
> A3 **One warehouse per business** (confirmed 18 Nov): today's "main center", labelled *Warehouse* in the UI. Schema keeps `kind` open so more warehouses can be added later without redesign; no multi-warehouse UI, source-warehouse choice or W→W transfers in this plan.
> A4 Quantities stored in a **base unit** (g / ml / piece / serving), `numeric(18,4)`, **but users pick the units they enter and see** per item (kg, L, crate, sack, tray…; confirmed 18 Nov). The unapplied 012 is **rewritten**, not applied.
> A5 "Keep selling when out": the sale goes through but stock **stops at zero**; the shortfall is logged as a *stock exception* **and the owner and branch manager are notified** (confirmed 18 Nov). No "allow negative" option.
> A6 Approving a branch request **reserves** stock at the Warehouse (accepted 18 Nov).
> A7 Cost method: **weighted average** first; batch/FIFO costing comes with batches (Phase 3).
> A8 Recipes: owner edits for all branches (Operations → Items & recipes); branch manager edits own branch's recipes (confirmed 18 Nov).
> A9 **Self-approval (answered 18 Nov):** if the business has another user who can approve, approval by a different person is required (maker-checker). If the requester is the **only** possible approver (a sole owner), they may approve their own record; it is **logged and flagged `self_approved`**, shown in the Approvals inbox/history and in a Self-approved report. Emergency buys come from branch managers, so the owner is always a different person.
> A10 **Limits are the owner's (answered 18 Nov):** no built-in KES amounts or percentages anywhere. Emergency-buy limits (per purchase, per day, per week, per branch, optional per category) and approval thresholds (wastage, adjustments, count variance; business default with per-branch override) are set in **Settings → Inventory** and changeable any time. **Safe defaults until set** (decision 18 Nov): every emergency buy needs approval; wastage posts without approval; every manual stock adjustment needs approval; a count session with any variance needs one approval for the session.
> A11 **AI insights layer (answered 18 Nov):** server-only gateway through OpenRouter, every call metered per business, monthly allowance set by the platform admin (owner may lower), figures always computed by Cravio and validated against the AI text. Gateway and metering early in Phase 2; insights after the Phase 3 reports. Design: `12-ai-insights.md`.
> A12 **Reports and Receipts tabs (answered 18 Nov):** owner group **Reports** → *Reports* (catalogue of every report, CSV, Save as PDF through the browser) and *Receipts* (supplier invoices, goods received notes, delivery/dispatch notes with QR, supplier returns). Branch managers see their own branch. Server-generated PDFs only if emailed/scheduled reports are needed. Customer sale receipts are out of this module (open question).

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
Every check is server-side and location-scoped. **Maker-checker**: `approver_id ≠ created_by`, enforced in SQL check where possible, **except** when the business has no other holder of the approving capability: then the requester may approve their own record and it is stored `self_approved = true` (A9). Branch managers can never self-approve. Capabilities stored in code in Phase 1; an editable `role_capabilities` table is optional in Phase 3.

### 0.6 Audit
`inventory_events` (append-only): actor, role, location, entity, action, before/after JSON, at. Written for item/recipe/settings edits, approvals, rejections, cancellations. Ledger rows are their own audit for quantities.

### 0.6a AI gateway (A11; `12-ai-insights.md`)
`backend/src/ai/gateway.js` is the only module that may call `lib/ai.js` (OpenRouter). It checks the per-business switch and monthly limit, caches, times out and retries once, and writes one `ai_usage` row per provider call (tokens, cost in USD and KES, status; no prompt text). Tables `ai_usage`, `ai_limits`, `ai_business_settings` (migration 014, applied with Release A); insight tables in 023. The existing recipe draft is retrofitted first (P2-32/33). Insights use only deterministic Cravio figures, a number validator and a template fallback (Phase 3, P3-40…P3-44).

### 0.7 UI: same look, easy to use (product owner requirement, 18 Nov 2026)
**Look the same as the rest of Cravio.** Follow `DESIGN.md` (v2 white). Reuse the existing pieces instead of new styles: `PageHeader`, `Panel`, `Segmented`, `TaskDrawer`, `SkeletonRows`, `EmptyState`, `OIcon`, `stock.css`/`business.css` tokens. A new inventory page should be indistinguishable in style from Orders or Locations. No new colour, font or component unless an existing one can't do the job (then add it to the shared set).

**Easy to use:**
- Plain words, no jargon: "On hand", "Held for open orders", "Available", "Coming in"; never "reserved/ledger/base unit/SKU" on screen (SKU shown as "Code (optional)").
- One clear main action per page (e.g. Stock → "Record stock"; Items → "Add item"). Forms open in the side drawer, like today.
- Units the way people think: the user picks the unit to type in (kg, g, crate of 10 kg, tray of 30…), with a live line showing what it means ("40 crates = 400 kg"). The item's usual unit is preselected; a unit is shown next to every quantity box.
- Guided start: an empty inventory shows a short checklist (add items → set opening stock → add recipes → done), as the current "How stock works" guide does.
- Show state at a glance: low / out / count needed badges, counts on tabs, and the one thing that needs attention at the top (exceptions, items at zero).
- Food cost readable: "KES 186 · 31% of the price"; "Unknown — no price for cheese" instead of 0.
- Forgiving: confirm before anything that can't be undone; warn on unusually large amounts ("4,000 kg? Did you mean 4 kg?"); clear error messages that say how to fix it.
- Tablet and phone first (branch managers use tablets at the pass): large touch targets, tables that collapse to cards on narrow screens, no horizontal scrolling.
- Fast: skeleton rows while loading, no full-page spinners.

**Checks:** each screen ticket includes a mobile-width Playwright check (no overflow) and, at milestone M3, a design review of all inventory screens against DESIGN.md (usability, consistency, accessibility) before merging to `main`.

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
| `stock_locations` | keep the single `'center'` as the business's warehouse (UI label "Warehouse"); widen check to allow `'warehouse'` for later; add `code`, `status`, `archived_at` |
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
- A5 shortfall: if a keep-selling dish is served with less on hand than needed, deduct to zero, write `stock_exceptions` (order, item, short_qty, status open/resolved) and **notify the business owner(s) and the branch's managers** (in-app notification; also when an item first reaches zero / sold out).
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
> **Updated 18 Nov 2026 (final decisions: ONE warehouse per business).** Everything multi-warehouse is removed from this phase and listed under "Later": choosing a source warehouse, splitting a request across warehouses, warehouse → warehouse transfers, "warehouse with most available". Transfers in Phase 2 are exactly three: **Warehouse → branch** (fulfilling requests), **branch → Warehouse** (returns) and **branch → branch** (needs owner approval). The schema still allows more locations of kind `warehouse` later (`stock_locations.kind`, `from/to_location` on transfers), so nothing here blocks that. The ticket-level plan is in `09-phase2-workplan.md`; migrations are re-split as 015–018 (see the table at the end).
**Goal:** stock and cost enter through suppliers; branches get stock from warehouses with reservations; branches can buy in an emergency within limits; owner approves from one inbox.

### WP2.1 Migrations 015 (suppliers & price lists) and 016 (purchase orders, receipts, invoices, returns, attachments)
| Table | Key columns |
| --- | --- |
| `suppliers` | business, name, contact, phone (254 format), email, kra_pin, `type` (formal/informal/one_off), payment_terms_days, mpesa/bank details, status, `incomplete` flag (on-the-spot) |
| `supplier_items` | supplier, item, supplier_sku, purchase unit, rank |
| `supplier_prices` | supplier, item, unit, price, `effective_from`; history kept |
| `purchase_orders` + `po_lines` | number (per business/year), supplier, deliver_to location, expected_date, status `draft → pending_approval → approved → sent → partially_received → received → closed / cancelled`, totals |
| `goods_receipts` + `grn_lines` | po_id (nullable = unplanned with reason), location, per line: ordered, received, rejected, unit + factor snapshot, unit_cost, batch/expiry (stored, used in P3) |
| `supplier_invoices` | supplier, number, date, supplier PIN, eTIMS invoice no. (free text, VERIFY), amounts, VAT, attachment, status unpaid/part/paid (P3 aging) |
| `supplier_returns` | grn/line, qty, reason, credit amount |
| `approval_rules` | business, subject (po, emergency, wastage, adjustment, count), band min/max or %, approver capability, location/category scope, period limits. **Rows exist only when the owner creates them; no seeded amounts** (A10) |
| `approvals` | subject_type/id, requested_by, status pending/approved/rejected, decided_by (≠ requested_by unless `self_approved`, A9), `self_approved`, reason, at |
| `attachments` | owner entity, storage path (Supabase Storage bucket `inventory-evidence`, private), mime, size |

### WP2.2 Migration 017 — emergency purchases, approval rules and approvals (the `approval_rules` / `approvals` tables listed under WP2.1 are created here, since emergency buys are their first user)
`emergency_purchases`: branch, item lines, supplier (or new incomplete supplier), estimated/approved/actual amounts, payment method (cash/M-Pesa/credit) + reference, reason, `invoice_status` (etims/other/none), evidence ids, status `draft → pending_approval → authorised → purchased → received → under_review → closed / rejected`.
Threshold check (EMP-1): per purchase, per branch per day/week cumulative, per category — all from `approval_rules` **set by the owner**; within the limit → auto-authorised; above → approval; **no limit set → approval** (A10).
No-invoice requires reason + goods photo + payment reference (T-EMP-3).

### WP2.3 Migration 018 — distribution upgrade
- `stock_requests`: statuses → `draft, submitted, approved, partially_approved, rejected, preparing, dispatched, partially_received, received, completed, cancelled` (superset).
- `stock_request_lines` + `approved`, `dispatched`, `received`. The source is always the business's Warehouse (no source choice, no split); one request → at most one open transfer at a time, further dispatches for the remainder allowed (partial dispatch).
- `stock_reservations`: location (the Warehouse), item, qty, ref (request line; production later), status active/released/consumed. `available = on_hand − reserved − order holds`. `stock_balances.reserved` (from 012) is the cached sum; the ledger keeps them in step.
- `stock_transfers`: three directions only — Warehouse → branch, branch → Warehouse (return), branch → branch (owner approval before dispatch). A `direction` column (`out`/`return`/`branch_to_branch`) checked against the location kinds; the generic `from_location`/`to_location` columns stay so more kinds can be allowed later. Lines + `damaged`, `over`.
- `transfer_discrepancies`: line, short/damaged/over qty, status open → resolved, `bearer` (carrier/source/destination), resolution movement.
- *Later (not Phase 2):* warehouse → warehouse transfers, choosing a source warehouse, splitting one request across warehouses.

### WP2.4 Services, API, UI
- **Owner → Operations → Purchasing**: Suppliers (list, profile, price history), Purchase orders (create from **reorder suggestions**: items below reorder/par per location minus open POs), approve (bands), send (PDF + WhatsApp share link), Receive (GRN against PO or unplanned), Returns. GRN posts `purchase_receipt` with cost → updates `avg_cost`/`last_cost`; price variance alert above X% vs PO/last price (GRN-6).
- **Owner → Requests & transfers**: approve/partial/reject per line, reserve at the Warehouse on approval, pick list (printable / mobile), dispatch (partial allowed, delivery note + QR as today), start a return (branch → Warehouse) or approve a branch → branch transfer, discrepancy review queue. (Single Warehouse: no source picker.)
- **Owner → Approvals**: one inbox for POs, emergency buys, (P3) wastage/adjustments/count variances; shows who asked, amount, rule triggered and a "Self-approved" chip where the owner approved their own record. **Owner → Settings → Inventory**: emergency limits per branch, approval thresholds, PO bands, AI usage and allowance (P2-35). **Owner → Reports → Receipts** (P2-36/37).
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
| Branch returns 3 kg unused stock to the Warehouse | Branch −3, Warehouse +3 on receipt; receipt confirmed by the owner side; discrepancy path same as deliveries |
| Branch → branch transfer | Needs owner approval before dispatch; both branches see it; QR works for the receiving branch only |
| Partial dispatch of an approved request | Remainder stays reserved until dispatched or cancelled |
| Damaged on arrival | Recorded; damaged qty not added; discrepancy for review |
| Over-delivery | Allowed only up to policy; extra recorded |
| QR scanned by another branch / waiter | 403 |
| Cancel dispatch after partial receipt | Refused; resolve via discrepancy |
| PO → partial GRN → 2nd GRN → supplier return | Balances, PO status, credit correct (T-PRC-1) |
| GRN price 20% above last | Variance alert |
| Emergency within the owner-set limit | Auto-authorised; stock on receipt (T-EMP-1) |
| Emergency buy, no limit set | Goes to approval (safe default) |
| Emergency above the owner-set limit | Blocked until a different user approves (T-EMP-2) |
| Weekly cumulative limit exceeded by small buys | Next one routed to approval |
| No-invoice without photo/ref | Rejected (T-EMP-3) |
| Owner changes a limit in Settings → Inventory | Applies immediately, no code change (T-EMP-4) |
| Same item bought in emergency 3× in a week | Alert to adjust par (EMP-7) |
| Approver tries to approve own PO while another approver exists | Denied (T-SEC-2) |
| Sole owner approves own PO | Allowed, flagged `self_approved`, reported |
| Recipe AI draft | Metered per business; blocked at the allowance with a plain message |

### WP2.6 Exit criteria
T-REQ-1..3, T-PRC-1, T-EMP-1..4, T-SEC-2 automated; full request→receipt and PO→GRN flows in Playwright; reconciliation zero.

---

## Phase 3 — Controls, production, batches & reporting
**Goal:** prove where stock went (wastage, counts, variance), prep kitchens, expiry, and the reports owners act on.

> **Updated 18 Nov 2026:** migrations are renumbered **019–023** because Phase 2 now uses 015–018 (see the sequencing table); Phase 3 stays single-warehouse (location-scoped features apply to the Warehouse and branches). The ticket-level plan is in `10-phase3-workplan.md`.

### WP3.1 Wastage & adjustments (migration 019)
`stock_reason_codes` (configurable: burned, spoiled, expired, prep error, spill, damaged, customer return, over-production, theft suspected); `wastage_records` (item or **menu item expanded via recipe**, qty, reason, cost from avg, photo, status); `stock_adjustments` (gain/loss, reason, evidence, status). Above the **owner-set** value/qty threshold → approval (maker-checker, A9/A10); defaults until set: wastage free, adjustments approved. Unusual wastage (vs 4-week rolling average) → alert. Staff meal / complimentary as own types with allowance limits.

### WP3.2 Stock counts (migration 020)
`stock_counts` (location, type full/cycle/spot, category/zone filter, blind flag, status `open → counting → under_review → approved → posted / cancelled`, snapshot_at) + `stock_count_lines` (expected at snapshot, movements since snapshot, counted per counter, recount flag, variance qty/value). Variance = counted − (expected + movements during count). Beyond the **owner-set** tolerance (until set: any variance, one approval per session) → approval; post as `count_correction`. Replaces the single-item “count”.

### WP3.3 Production / prepared items (migration 021)
Prepared stock items get recipes (sub-recipes, cycle detection). `production_orders`: planned qty, inputs reserved, actual output, yield variance; posts `production_input` (−) and `production_output` (+) linked by production id, output cost = Σ input cost / output qty. Dish recipes may use prepared items (consumed as stock, not re-expanded).

### WP3.4 Batches, expiry, FEFO (migration 022)
`batches` (item, number, supplier, received, expiry, unit_cost) + `batch_balances` (location, item, batch). Item `expiry_tracking` off/optional/mandatory. GRN/production create batches; consumption, dispatch and wastage allocate FEFO (FIFO if no expiry); expired batches blocked from POS/transfers/production with manager override + reason; near-expiry alerts; traceability (batch → movements → orders). Batch cost becomes available as cost method.

### WP3.5 Costing, variance & reports
- Valuation by location/category/date (avg cost; batch cost once 3.4 lands).
- Theoretical usage (Σ order_stock_lines served) vs actual (opening + receipts ± transfers − wastage − closing count) by item/branch/period; variance in qty and KES with tolerance highlighting (CST-3/4).
- Menu engineering: food cost %, margin, popularity (from orders) per dish and branch (CST-5); price-change impact list (CST-6).
- Reports (17.2 subset): valuation, movement ledger, consumption, variance, wastage, expiry, procurement spend (central vs emergency), emergency compliance, supplier performance, stock turnover/days on hand. Owner **Reports** catalogue (list → open → filters → table/chart → CSV → Save as PDF via print layout); background CSV job for long ranges; server PDF only if emailed/scheduled reports are wanted (optional).
- Dashboards: owner Overview tiles (inventory value, low/expiring, pending approvals, in transit, emergency spend, variance alerts) with drill-down to ledger rows; branch Overview tiles.

### WP3.5a AI insights (migrations: tables in 023; gateway tables 014 in Phase 2)
Fact builders over the reports above (branch profitability as *gross profit after food cost*, loss-making branch, dish food-cost spikes, wastage, emergency spend, variance hotspots, reorder suggestions) → validated plain-language findings → daily job and a fixed "Ask about my numbers" list → owner Overview briefing and Reports → Insights; branch managers see their own branch. Tickets P3-40…P3-44; design in `12-ai-insights.md`.

### WP3.6 Reliability & governance (migration 023: reconciliation runs, report jobs, period locks, role capabilities, delegations)
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
Location-scoped role for the Warehouse (warehouse manager, storekeeper) working inside the owner area limited to the Warehouse location: pick, dispatch, receive GRN, counts; no approvals for storekeeper.

---

## Later modules (outside this plan)
M-Pesa (Daraja STK + reconciliation), KRA eTIMS (OSCU/VSCU adapter), shifts/cash-up, KDS stations, offline PWA sync, delivery platforms, accounting exports API, recall workflow, demand forecasting, **multi-warehouse features** (several warehouses, choosing a source, splitting a request, warehouse → warehouse transfers; the schema allows it, no UI or logic is planned). The inventory ledger is designed so these plug in (e.g. `pos_consumption` is already idempotent per order line; eTIMS item codes can map onto `vat_class`).

## Reports and Receipts in the navigation and phases
Owner sidebar group **Reports**: **Receipts** arrives in Phase 2 (P2-36 supplier documents at Release A, P2-37 delivery notes at Release B); **Reports** (catalogue) arrives in Phase 3 (P3-26/28, Release E) and **Reports → Insights** in Release G. Branch managers see **Receipts** and **Reports** for their own branch. See `05-navigation-proposal.md`.

## Sequencing summary
| Phase | Migrations | Main deliverable | Rough size |
| --- | --- | --- | --- |
| 1 | 012 catalogue & units, 013 recipes & snapshots | Real units, warehouses, versioned recipes, food cost, sold-out on real ingredients | Largest backend change (touches order triggers) |
| 2 | 015 suppliers & price lists, 016 purchase orders / receipts / invoices / returns / attachments, 017 emergency purchases + approval rules + approvals, **014 AI gateway (usage, limits, switches)**, 018 distribution upgrade | Suppliers → POs → GRN, emergency buys with owner-set limits, self-approval flag, reservations, Warehouse ↔ branch and branch → branch transfers, approvals inbox, Settings → Inventory, Receipts, AI gateway with metering | Most UI (≈ 70 days, `09`) |
| 3 | 019 wastage/adjust/allowances, 020 counts, 021 production, 022 batches, 023 governance, reporting support & AI insight tables | Controls, prep, expiry, variance, **Reports catalogue**, **AI insights** | Most reporting (≈ 115 days, `10`) |

Each WP ends with: migration reviewed + rehearsed, tests green, KB updated, PR `dev → main`.
