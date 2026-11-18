# 09 · Phase 2 work plan: purchasing & distribution

> **Applied 18 Nov 2026:** migrations 012–020 are on the shared database (see DECISIONS INV-MIG). **Dry-run warning:** never run `npm run db:migrate -- --dry-run` from the repo root — npm swallows the flag and the migrations APPLY. Dry-run only with `cd backend && node --env-file=.env scripts/migrate.js --dry-run`.

> **Migration numbering (18 Nov 2026):** the runner (`backend/scripts/migrate.js`) only applies files named `NNN_name.sql` (three digits). Phase 2 migrations are 014 AI gateway, 015 suppliers, 016 purchasing, 017 emergency + approvals, 018 distribution; Phase 3 continues at 019–023. Never use suffixes like `016a`.

Turns Phase 2 of `07-implementation-plan.md` into tickets you can pick up one at a time, in the same format as `08-phase1-workplan.md`. Estimates assume one developer working with Claude; **≈ 70 working days (about 14 weeks)** (57 for the original purchasing/distribution scope + 13 for the owner Settings → Inventory screen, Receipts, and the AI gateway with metering and limits added on 18 Nov), shipped in **two releases** (A: purchasing + emergency buying, B: distribution). Each ticket is small enough for one PR into `dev`. Written 18 Nov 2026.

**Scope in one line:** stock and cost enter through suppliers (price lists → purchase orders → goods receipts → invoices → returns); branches can buy in an emergency within limits; the owner approves from one inbox; branches request stock from the **one Warehouse**, approval **reserves** it, dispatch/receive/discrepancy run on the new ledger; the old 009 request/dispatch/QR flow moves onto the new engine and its pages are retired.

**Added 18 Nov 2026 (product owner answers, INV-P2/P3):** self-approved purchase orders for a sole owner (D2-5); **no built-in emergency-buy amounts** — the owner sets limits in a new Settings → Inventory screen (D2-6, P2-35); owner-configurable approval thresholds (D2-16); owner **Reports → Receipts** tab (P2-36/37); and the **AI gateway with per-business metering and limits** (P2-32…P2-34, design in `12-ai-insights.md`).

**What is NOT in Phase 2** (final decisions, 18 Nov): several warehouses, choosing a source warehouse, splitting a request, warehouse → warehouse transfers (schema allows them later; no UI, no logic); M-Pesa/eTIMS integrations (the invoice screen only *stores* an eTIMS number and PIN as text; M-Pesa reference is a typed text field); offline; 3-way match and supplier payments/AP (invoice `payment_status` is stored, not driven — Phase 3 reports/AP later); batches and expiry (stored on the receipt line, used in Phase 3).

## What Phase 1 gave us (what Phase 2 builds on)

| Piece | Where | What Phase 2 does with it |
| --- | --- | --- |
| `ledger.post(db, {businessId, locationId, itemId, reason, qty (signed base string), unitCost, ref:{type,id}, counterpartyLocationId, entered:{quantity,unit}, idempotencyKey, actorId, occurredAt, reversesMovementId, note})` — returns `{movement, balance:{onHand, reserved, available}, replayed}`; `postMany` (stable lock order), `reverse`, `reconcile`, `RECONCILE_SQL` | `backend/src/inventory/ledger.js` | Reasons already exist: `purchase_receipt, emergency_receipt, supplier_return, transfer_dispatch, transfer_receipt, transfer_cancelled, transfer_discrepancy, lost_in_transit`. Inbound with `unitCost` re-averages `avg_cost`. Outbound is refused into `reserved` stock unless the reason is in the `CONSUMES_RESERVATION` hook (empty today) — **P2-20 fills it** |
| `permissions.js`: `inventoryScope(db, context, businessId)`, `can/requireCan/authorize`, `assertDifferentPeople`, `locationsWith`; capabilities already declared: `inv.request.create/approve`, `inv.transfer.dispatch/receive`, `inv.purchase.create/approve`, `inv.emergency.create/approve` | `permissions.js` | Reused as is. Additions: operations manager may get `inv.purchase.create` behind a setting; branch manager gets `inv.transfer.dispatch` for *returns and branch → branch from their own branch only* |
| `policies.js` `SETTINGS` (typed, location override) | `policies.js` | New keys (list in P2-02) |
| `audit.record`, `commands.once` (idempotent HTTP commands) | `audit.js`, `commands.js` | Every write: one transaction + `once()` + audit event, authorize **before** opening the write transaction (so `denied` rows survive) |
| `notifications` table (013) + readers (`list`, `markRead`) + `private.stock_notify` (trigger-side) | `notifications.js`, 013 | P2-02 adds an app-side **writer** `notify()` with recipient resolution and `dedupe_key` |
| `stock_balances.reserved`, `inventory_settings`, `inventory_events`, `stock_exceptions`, `stock_movements.batch_id / reverses_movement_id / counterparty_location_id / ref_type / ref_id` | migrations 012/013 | Ready; no change to 012/013 needed |
| Operations navigation behind `inventory_enabled`; owner screens (Stock, Items, Recipes, History) and branch screens (Stock, Recipes, History); `RecipeSheet`, `ItemDrawer`, `parts.jsx`, `inventory.css`, `branch.css` | `frontend/src/pages/inventory/*`, `frontend/src/config/dashboards.js` | New entries added to the same groups; same components |
| Legacy 009 flow (still live for businesses with `inventory_enabled = false`) | `backend/src/stock/service.js` (`submitRequest`, `cancelRequest`, `reviewRequest`, `dispatch`, `cancelDispatch`, `findByCode`, `receive`), `routes/stock.js` (`/api/stock/requests`, `/api/stock/transfers/:id/receive`, `/api/stock/receive/:code`, `/api/owner/stock/:biz/requests/:id/review`, `/dispatches`, `/dispatches/:id/cancel`), `pages/stock/OwnerInventoryPage.jsx`, `BranchInventoryPage.jsx`, `ReceiveCodePage.jsx` (`/receive/:code`) | P2-19 → P2-25 migrate it, P2-28 retires it |

## How we work

Same rules as `08-phase1-workplan.md`; the differences are called out.

| Topic | Rule |
| --- | --- |
| Branches | `main` ← `dev` ← short-lived `inv/p2-NN-short-name` per ticket. PR ticket → `dev`; PR `dev` → `main` at **Release A** (after P2-18) and **Release B** (after P2-31). Set your git identity first. |
| Database | New migrations **015–018** in `backend/db/proposed/` until reviewed, each with `.down.sql`. Tested only on disposable PGlite (`freshDatabase({ extra: [...] })`). **Nothing touches the shared database until P2-18 (015–017) and P2-31 (018).** `main` and `dev` share one database: every migration is **additive** (new tables/columns, widened checks that are supersets, widened numerics); `main`'s code must keep working. Never rename or drop a column `main` reads. **Lifecycle (tests):** a new migration and its `.down.sql` start in `backend/db/proposed/` and are appended to `PROPOSED_MIGRATIONS` in `backend/tests/inv/migrations.js` (fixtures apply them by default; `proposed-list.test.js` fails if a file is missing from the list). When it is **applied** to the shared database, `git mv` the `.sql` to `backend/db/migrations/` (the `.down.sql` stays in `proposed/`, like 009's), then repoint: move its line from `PROPOSED_MIGRATIONS` to `INVENTORY_MIGRATIONS` as `migrations/0NN_….sql`, and change test references `proposed/0NN_….sql` -> `migrations/0NN_….sql` (down-migration paths stay `proposed/…down.sql`). Rehearsals start from `BASE_MIGRATIONS` (001-010) + `inventoryBefore(N)`; `inventory-v2.js` plain run uses `BASE_MIGRATIONS` only (main's 009 behaviour), the compat run adds the whole inventory set. |
| Rehearsal | Each migration ticket includes a PGlite rehearsal test (`backend/tests/inv/migration-0NN.test.js`): apply on a seeded database shaped like the census, assert counts, apply the down file, assert restore, assert the down file **refuses** when new-world data exists. P2-19 rehearses the 009 backfill on a copy of the P2-01 census shape. |
| Compatibility | Update `npm run test:inv:compat` so `INV_EXTRA_MIGRATIONS` lists **all** proposed migrations in order (012…018 as they appear) and `backend/tests/inventory-v2.js` still passes. Every migration ticket runs it; a red `inventory-v2.js` blocks the PR. |
| Tests | New suites under `backend/tests/inv/` run by `npm run test:inv` (includes `server-load.test.js`, which loads **every** route module — a new `routes/inventory-*.js` that fails to import breaks the whole API, so it must be green). Name checks after PRD IDs (`T-REQ-1 …`). |
| UI rules | Follow `DESIGN.md` and 07 §0.7: same components (`PageHeader`, `Panel`, `Segmented`, `TaskDrawer`, `SkeletonRows`, `EmptyState`, `OIcon`), plain words (“On hand”, “Held for requests”, “Coming in”, never “reserved/ledger/SKU”), unit picker with live conversion line, one main action per page, forms in the side drawer, phone/tablet first (tables collapse to cards, no horizontal scroll), skeleton rows, confirm before irreversible actions, warn on unusual amounts. |
| UI tests | Mocked Playwright specs per screen ticket (`frontend/tests/inventory-<area>.spec.js`: fake session in storage, `/api/me` and every inventory call answered in the spec, unlisted API paths 404, **no backend, no database, no password**), including a phone-width “no horizontal overflow” check. **Run on a non-5173 port** so other dev servers are not disturbed: `cd frontend && npx vite --port 5191 & npx playwright test tests/inventory-<area>.spec.js` with a one-off config that sets `baseURL: 'http://localhost:5191'` and no `webServer` (copy of `playwright.v2.config.js` with the port; do not edit `playwright.config.js`). |
| Definition of done (each ticket) | Code + tests green: `npm run test:inv` · `npm run test:inv:compat` · `npm run test:v2` · `npm run build` · server-side permission check on every route (authorize before the write transaction) · every state change in one transaction with `once()` idempotency and an `inventory_events` row (quantities are audited by the ledger itself) · no UI without a working API · UI per the rules above · KB touched if behaviour or schema changed. |
| Feature switch | All new UI and endpoints hide behind `businesses.inventory_enabled` (as in Phase 1). Businesses with it off keep the 009 flow untouched until P2-31. |
| Money and quantities | Quantities `numeric(18,4)` in the base unit, unit cost `numeric(18,6)` per base unit, money `numeric(14,2)`; BigInt helper `decimal.js`, never `Number` in a ledger or totals path. PO/invoice totals are computed by one function `totals(lines)` (round each line to 2 dp, then sum) used by server and tested against the screen. |

## Decisions (all decided now; defaults proposed where the product owner has not spoken)

Logged in `docs/v2/DECISIONS.md`: D2-1 → INV-A3, D2-2 → INV-A6, D2-3 → INV-A2, D2-4 → INV-A7, D2-5/D2-6/D2-16/D2-17 → INV-P2/P3 (product owner, 18 Nov); **D2-7…D2-15 → INV-P2D (proposed defaults, awaiting confirmation)**. A change to either table must change the other.

| # | Decision | Source |
| --- | --- | --- |
| D2-1 | **One Warehouse per business** (the 009 center). No source choice, no split, no W→W. Transfers: Warehouse → branch (fulfil requests), branch → Warehouse (returns), branch → branch (owner approval before dispatch). | DECISIONS INV-A3, 18 Nov |
| D2-2 | **Approving a request reserves stock** at the Warehouse; dispatch consumes the reservation; cancel/reject releases it. | INV-A6 |
| D2-3 | The **owner acts as head office, procurement and warehouse**: creates/approves POs, receives goods, dispatches. | INV-A2 |
| D2-4 | **Weighted-average cost**; a goods receipt with cost re-averages (`ledger.post` already does this). Batch/FIFO arrives in Phase 3. | INV-A7 |
| D2-5 | **Approvals and who may approve (answered 18 Nov: a sole owner may approve their own PO).** Rule: when a purchase order (or other approval subject) needs approval, the system looks for **another user who holds the approving capability** (`inv.purchase.approve`: another owner, or an operations manager with `operations_can_approve`) **in that business**. If one exists, approval by someone **other than the requester is required** (maker-checker, DB check `decided_by <> requested_by`). If none exists, the requester **may approve their own** record; it is **logged and flagged `self_approved = true`**, shown with a "Self-approved" chip in the Approvals inbox and history, and listed in a **Self-approved records** report (P3-26). The `owner_self_approve_po` setting is removed: it is the data (is there another approver?), not a switch. Emergency buys are made by branch managers, so the owner is always a different person; a branch manager can never self-approve. T-SEC-2 is tested both ways: another approver exists → own approval denied; sole owner → allowed and flagged. | Product owner, 18 Nov (INV-P2/P3) |
| D2-6 | **Emergency-buy limits are set by the owner, with no built-in amounts (answered 18 Nov).** The owner sets limits **per branch** — per purchase, per day, per week — and optionally **per category**, in **Settings → Inventory** (P2-35) and can change them at any time (T-EMP-4; effective at once, audited with before/after). They live in `approval_rules`; the migration and the code carry **no default amounts**. **Until a limit is set for a branch, every emergency buy goes to the owner for approval** (the safe default), and the branch form says "No limit set — the owner will be asked". A set limit that is not exceeded → auto-authorised; any breach → owner approval. Week = Monday–Sunday, Africa/Nairobi. | Product owner, 18 Nov (INV-P2/P3) |
| D2-7 | **PO approval bands** in `approval_rules` (subject `po`): none until the owner adds one. With no band, a PO is approved by the owner in one click (self-approval flagged when there is no other approver, D2-5); an owner can add a band (e.g. above an amount they choose, a second approver is needed — another owner or an operations manager with `operations_can_approve`; if no second person exists the self-approval rule still applies). No amounts are built in. | Proposed |
| D2-8 | Evidence (invoice/goods photos, delivery notes) lives in a **private Supabase Storage bucket `inventory-evidence`**; the browser uploads straight to a **signed upload URL** issued by the API, viewing uses a **5-minute signed URL** after a permission check on the parent record. Allowed: jpeg/png/webp/pdf, ≤ 8 MB; images downscaled to ≤ 1600 px in the browser. | Q-P2 |
| D2-9 | A **no-invoice** emergency purchase needs a reason, a payment reference (M-Pesa code or receipt no.) and at least one goods photo — enforced in the service **and** by a DB check/trigger (T-EMP-3). | PRD EMP, T-EMP-3 |
| D2-10 | PO number = `PO-<year>-<0001>` per business per year; request, transfer and GRN numbers per business (existing `nextNumber` pattern with advisory lock). | Proposed |
| D2-11 | Over-delivery on a transfer is accepted up to `transfer_over_tolerance_pct` (default **5 %** of dispatched) and recorded as an `over` discrepancy; beyond that the receipt is refused (“count again or ask the owner”). | PRD REQ-6; default proposed |
| D2-12 | Returns (branch → Warehouse) need **no approval** by default (setting `returns_need_approval` = off); branch → branch **always needs owner approval** before the source branch can dispatch. No reservation at branches (the source branch dispatches right after approval; availability is checked at dispatch). | Proposed |
| D2-13 | Price variance alert: a receipt line costing more than `price_variance_alert_pct` (default **10 %**) above the PO price or the last receipt cost notifies the owner. | PRD GRN-6 |
| D2-14 | Suppliers: name unique per business (case-insensitive); phone stored as `2547XXXXXXXX`/`2541XXXXXXXX`; KRA PIN format `A123456789B` validated but optional; bank/M-Pesa details visible to the owner only. An *on-the-spot* supplier created from an emergency purchase is `incomplete = true` and shows a “complete this supplier” prompt. | PRD SUP |
| D2-15 | Business that switches the module on **keeps its open 009 requests and in-transit dispatches** (same tables, no copying). Approved-but-not-dispatched 009 requests get reservations created at the switch (P2-19); if stock is short the request is flagged “needs attention”, never silently shortened. | Proposed |
| D2-16 | **Approval thresholds are owner-configured (answered 18 Nov).** Wastage, stock-loss/gain adjustments and count variance have **no fixed KES or % defaults in code**. The owner sets them per business with an optional **per-branch override** in the same Settings → Inventory screen (built in P2-35 with the emergency limits; the Phase 3 subjects plug into it). **Safe default until the owner sets them (decision 18 Nov):** wastage is **recorded straight away, no approval** (it is routine and a restaurant would drown in approvals; every record has a reason, can need a photo, appears in the owner's wastage log and feeds the unusual-wastage alert); a **manual stock adjustment** (a gain or a loss) **always needs approval** (rare, and a gain is how stock is conjured); a **stock count session with any non-zero variance needs one approval for the whole session** (one approval per count, not per line). Setting a threshold replaces the default for that subject: "approve wastage above KES X", "approve adjustment losses above KES X", "approve count variance above X % or KES Y". See D3-4/D3-5. | Product owner, 18 Nov (INV-P2/P3); default chosen here |
| D2-17 | **AI gateway first.** The server-only AI gateway, per-business metering and limits (design: `12-ai-insights.md`) ship early in Phase 2 because the recipe AI draft already calls OpenRouter unmetered. Every AI call goes through `backend/src/ai/gateway.js` (P2-32); the recipe draft is retrofitted (P2-33); the admin sets each business's monthly allowance (P2-34). Insights built on it come in Phase 3. | Product owner, 18 Nov |

## Milestones

| Milestone | Tickets | Outcome | ~Days |
| --- | --- | --- | --- |
| M0 Ready | P2-01 → P2-02 | Decisions logged, census, reservation spike, harness + shared helpers | 1.5 |
| MA AI gateway | P2-32 → P2-33 | Gateway, metering, limits, switches; recipe draft retrofitted (tested; any time after M0, before Release A) | 4.5 |
| M1 Purchasing engine | P2-03 → P2-08 | Suppliers, price lists, POs, receipts, invoices, returns, evidence storage (tested, no UI) | 12 |
| M2 Approvals & emergency | P2-09 → P2-11 | Rules, approvals with maker-checker, emergency purchases end to end (tested, no UI) | 6.5 |
| M3 Purchasing screens → **Release A** | P2-12 → P2-18, P2-34 → P2-36 | Purchasing, Approvals, branch Purchases screens; **Settings → Inventory** (limits, thresholds, AI usage); **Receipts**; admin AI usage and limits; migrations 015–017 + 014 applied; `dev` → `main` | 21 |
| M4 Distribution engine | P2-19 → P2-25 | Migration 018 + 009 backfill, reservations in the ledger, request → dispatch → receive → discrepancy, returns, branch → branch, 009 flow switched over | 13.5 |
| M5 Distribution screens → **Release B** | P2-26 → P2-31, P2-37 | Requests & transfers (owner), Requests & deliveries (branch), Receipts gain delivery notes, old pages retired, design review, race test, migration 018 applied, `dev` → `main` | 11 |
| **Total** | | | **70** |

**De-risk spike on day 2** (inside P2-01): a throwaway PGlite script proving reservations under concurrency — two approvals racing for the last 10 kg at the Warehouse, one reservation consumed by a dispatch, one released by cancel — and that `stock_balances.reserved` equals Σ active reservation remainders afterwards. It is the riskiest new ledger behaviour; finding a problem in week 8 would be expensive.

---

## Tickets

### M0 — Ready

**P2-01 Record decisions, census, reservation spike** · 0.5 d — **status 18 Nov 2026: decisions logged, spike done, census deferred**
- Decisions: D2-1…D2-17 are in `docs/v2/DECISIONS.md` (INV-A3/A6/A2/A7, INV-P2/P3, and INV-P2D for the proposed defaults D2-7…D2-15); `06-open-questions.md` marks Q2-3…Q2-5 as open with a proposed default. ✔
- Census: `backend/scripts/inventory-census.js` needs the real database, so it is **deferred to release time** (P2-18 / P2-31 runbooks): extend it (read-only) to count 009 *requests by status*, *transfers by status*, approved-not-dispatched requests, in-transit transfers and their lines, and record the numbers here for the P2-19 rehearsal. Until then the P2-19 rehearsal uses a synthetic database of that shape.
- Spike: **done and passing (56/56)** in `docs/inventory-kb/spikes/reservations/` (README has the findings): reserve/release/consume in the ledger, reconciliation `reserved = Σ active remainders`, order holds combine as `available = on_hand − reserved − held`. Design changes it caused are folded into P2-19 and P2-20 below. ✔
- Done when: decisions logged with date ✔; spike passes ✔; census numbers recorded (at release time).

**P2-02 Harness and shared helpers** · 1 d
- **Status 18 Nov 2026 — harness part done:** `backend/tests/inv/migrations.js` (the one ordered list `PROPOSED_MIGRATIONS` + `proposedUpTo/proposedBefore/resolveProposed`; a new migration is one appended line, `proposed-list.test.js` fails if a file in `backend/db/proposed` is missing from it); `inventoryFixture()` now applies **all** proposed migrations by default (`extra: []` = none, `extra: [paths]` = exactly those; the 012 rehearsal tests opt out); `rig()` in `fixture.js` (second owner, second branch + manager, operations manager on branch 1, flour/rice with packs, contexts for `inventoryScope`); `helpers.js` (`makeAsserts`, `keyGen`, `makeItem`, `receive`, `fakeClock`, `fakeStorage` for the evidence bucket); `npm run test:inv:compat` is `INV_EXTRA_MIGRATIONS=all node backend/tests/inventory-v2.js` (explicit comma lists still work). `makeSupplier` arrives with migration 015 (P2-03). **Still to do in this ticket:** `numbers.js` (`nextNumber`), `notify()`, the new `SETTINGS` keys and their smoke tests (listed below).
- `backend/tests/inv/fixture.js`: add a second owner, an operations manager (assigned to the branch, `operations_can_approve` toggle), a second branch with its manager, a supplier, two stock items with packs, and helper `rig({ extra })` that applies every proposed migration as it exists.
- `backend/src/inventory/numbers.js`: `nextNumber(db, table, businessId, { year })` (advisory-lock pattern from `stock/service.js`), used by POs, GRNs, requests, transfers.
- `backend/src/inventory/notifications.js`: add writer `notify(db, { businessId, kind, title, body, link, entityType, entityId, locationId, dedupeKey, to })` where `to` is `{ owners: true, branchManagersOf: locationId, capability, userIds }`; recipients resolved from `business_members` / `restaurant_members` (same source as `inventoryScope`); `dedupe_key` prevents repeats; never throws on a duplicate.
- `policies.js` `SETTINGS`: add `operations_can_purchase` (bool, false), `price_variance_alert_pct` (number, 10), `transfer_over_tolerance_pct` (number, 5), `returns_need_approval` (bool, false), `branch_to_branch_enabled` (bool, true), `emergency_repeat_alert_count` (3) and `emergency_repeat_alert_days` (7), `ai_usd_to_kes` (number, set by admin). **No amount defaults** for emergency, wastage, adjustment or count thresholds (D2-6, D2-16); `wastage_approval_value_kes` and `count_tolerance_pct` stay as legacy keys defaulting to `null` (Phase 3 migrates them to rules; the 3 % default is removed).
- `package.json`: `test:inv:compat` reads the list from one place (`backend/tests/inv/migrations.js`) so adding a migration is a one-line change (done).
- Done when: smoke tests for `notify` (recipients, dedupe), `nextNumber` (concurrent callers get distinct numbers) and the settings validators pass.

### MA — AI gateway (design in `12-ai-insights.md`; can run in parallel with M1, must finish before Release A)

**P2-32 AI gateway, metering, limits, migration 014** · 3.5 d
- `backend/db/proposed/014_ai_gateway.sql` + down (additive, independent of 015–018): `ai_usage` (insert-only), `ai_limits`, `ai_business_settings` (columns in `12-ai-insights.md` §2.1). Down refuses when usage rows exist.
- `backend/src/ai/gateway.js` wrapping `lib/ai.js`: `call({ db, businessId, userId, feature, system, user, maxTokens, cacheKey })` with switch check, limit check under an advisory lock (reserve worst-case cost, settle after), cache, timeout and one retry, **one `ai_usage` row per provider attempt** (tokens from the provider `usage` block, cost USD → KES with `ai_usd_to_kes`), failed provider calls not counted against the allowance, rejected answers counted. Plain messages: **“Your AI allowance for this month is used up. It resets on 1 December.”** (date computed), 80 % warning notification to owner and admin once per month. `lib/ai.js` gains token/cost extraction and keeps its env config (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`); per-feature model override read from `ai_business_settings`.
- `usage(db, businessId, month)` and `limits(db, businessId)` helpers for the screens (P2-34/35). Owner may lower the allowance, never raise it (`owner_budget_kes ≤ monthly_budget_kes`).
- Tests (**stubbed fetch only, no network**): metering exactness (tokens and cost on three scripted calls sum to the hand-calculated month total), limit enforcement (call n+1 refused when budget reached; concurrent calls cannot overshoot), 80 % warning once, failed call not counted, cached call costs zero, feature switch off → 403, no row → AI off, owner cannot raise the admin figure, `usage` rows cannot be updated or deleted, **a grep test fails if any file other than the gateway imports `lib/ai.js`**, message text and reset date correct on 31 Dec/1 Jan.

**P2-33 Retrofit the recipe AI draft through the gateway** · 1 d (0.5 + tests)
- `inventory/recipes.js` `suggest` and the old `stock/recipes.js` suggest route call `gateway.call({ feature: 'recipe_draft', … })`; the payload stays menu text and stock item names only (unchanged privacy); a business with no `ai_limits` row has AI **off** (not unmetered) — the admin must set an allowance (P2-34), and the “Suggest” button shows “AI suggestions are off for this business” until then. (Existing pilots get a default allowance row at the P2-18 runbook step.)
- Tests: draft is metered with the right feature and model, blocked at the limit with the allowance message, recipe still saved by hand when AI is off.

### M1 — Purchasing engine

**P2-03 Migration 015 — suppliers & price lists** · 1.5 d
- `backend/db/proposed/015_inventory_suppliers.sql` + `.down.sql`:
  - `suppliers` (business_id, name — unique per business on `lower(name)`, `type` formal/informal/one_off, contact_name, phone with 254 check, email, kra_pin with format check, payment_terms_days 0–180, payment_method cash/mpesa/bank/credit, mpesa_number, bank_details, status active/inactive/archived, `incomplete` bool, created_by, timestamps).
  - `supplier_items` (supplier, item, supplier_sku, pack_name, pack_factor snapshot, rank, lead_time_days, min_order_qty, unique (supplier, item)).
  - `supplier_prices` (supplier, item, pack_name, pack_factor, `price` numeric(14,2) per pack, `price_per_base` numeric(18,6), effective_from date, created_by) — **insert-only** (trigger refuses UPDATE/DELETE) so history is kept; the price in force on a date is the row with the greatest `effective_from ≤ date`.
  - RLS enabled with no policies, same as 012/013 (the API is the only reader).
- Down: refuses when any supplier exists.
- Tests: rehearsal; duplicate name (case-insensitive) refused; phone/PIN checks; price rows immutable; `test:inv:compat` green.
- Done when: migration reviewed, rehearsed, compat green.

**P2-04 Suppliers service + owner API** · 2 d
- `backend/src/inventory/suppliers.js`: create/edit/archive (archive refused while open POs exist), list with search/filter, profile (items supplied, last prices, open POs, last receipts), `setPreferred`, `addPrice(item, pack, price, effectiveFrom)` (derives `price_per_base` with `units.toBase`), `priceFor(supplierId, itemId, date)`, `priceHistory`, on-the-spot create (`incomplete = true`, name only), `complete()`.
- `backend/src/routes/inventory-purchasing.js` (new module; **must be added to `routes/index.js` and pass `server-load.test.js`**): `/api/owner/inventory/:biz/suppliers…`, `/suppliers/:id/prices`, `/suppliers/:id/items`.
- Capabilities: `inv.purchase.create` for edits; reading prices needs `inv.cost.view`. Operations manager read-only. Branch managers cannot list suppliers except the *emergency picker* (name + id, no bank data) in P2-11.
- Tests: validators, owner isolation between businesses, price in force on a date, history order, archive rule, bank details hidden from non-owners.

**P2-05 Migration 016 — purchase orders, goods receipts, invoices, returns, attachments** · 2 d
- `016_inventory_purchasing.sql` + down:
  - `purchase_orders` (business, `year`, `number` — unique (business, year, number), supplier, `deliver_to_location` (the Warehouse by default; a branch is allowed for direct delivery), expected_date, status `draft → pending_approval → approved → sent → partially_received → received → closed | cancelled`, subtotal, vat_total, total, notes, created_by, approved_by, approved_at, sent_at, sent_via, cancelled_by/at/reason).
  - `po_lines` (po, item, pack_name, pack_factor snapshot, qty_packs, qty_base, price_per_pack, price_per_base, vat_class snapshot, vat_amount, line_total, position).
  - `goods_receipts` (business, number, po_id null, `unplanned_reason` required when po_id is null, supplier_id, location_id, received_at, received_by, delivery_note_no, status `posted | reversed`) + `grn_lines` (grn, po_line_id null, item, pack snapshot, qty_ordered_base, qty_received_base, qty_rejected_base, reject_reason, unit_cost per base, movement_id, `batch_no`, `expiry_date` — stored, unused until Phase 3).
  - `supplier_invoices` (business, supplier, grn_id/po_id null, invoice_no — unique per supplier, invoice_date, supplier_pin, `etims_invoice_no` free text, subtotal, vat, total, attachment_id, `payment_status` unpaid/part/paid, paid_amount).
  - `supplier_returns` + `supplier_return_lines` (grn, grn_line, item, qty_base, reason, credit_amount, status draft/posted, movement_id).
  - `attachments` (business, entity_type, entity_id, storage_path unique, mime, size_bytes, uploaded_by, created_at; `entity_type` in po/grn/invoice/return/emergency/transfer/discrepancy).
  - Trigger: a PO line's received total across posted GRN lines may not exceed ordered × (1 + over-receive tolerance) — tolerance read from setting by the service, trigger only enforces the hard cap (ordered × 1.5) as a safety net.
- Down: refuses when any PO or receipt exists.
- Tests: rehearsal; PO number uniqueness per year; GRN without PO needs a reason; deleting a supplier with POs blocked; `compat` green.

**P2-06 Evidence storage (private bucket) + attachments API** · 1.5 d
- `backend/src/inventory/evidence.js`: `createUploadUrl(db, scope, { entityType, entityId, mime, size })` (validates mime/size, builds path `<business>/<entityType>/<entityId>/<uuid>.<ext>`, calls the service-role Supabase client `storage.from('inventory-evidence').createSignedUploadUrl(path)`), `confirm()` (checks the object exists and its size/mime match, inserts `attachments`), `signedUrl(attachmentId)` (5 minutes, after `can(...)` on the parent entity's location), `remove()` (only before the parent is finalised).
- Bucket creation is a documented one-time step in the P2-18 runbook (private, 8 MB limit, allowed mime types); tests use a **storage double** injected through the service (`evidence.setStorage(fake)`), so no network.
- Routes: `POST /api/inventory/attachments/upload-url`, `POST /api/inventory/attachments`, `GET /api/inventory/attachments/:id/url` (owner and branch variants share the service; branch can only touch its own location’s records).
- Frontend helper `frontend/src/lib/evidence.js`: pick/camera (`<input accept="image/*" capture="environment">`), downscale to ≤ 1600 px, PUT to the signed URL, confirm.
- Tests: wrong mime/size refused, other business’s entity refused, branch cannot sign a URL for another branch’s attachment (T-SEC-1 shape), expired URL not cached by the API.

**P2-07 Purchasing service: price → PO → send** · 2.5 d
- `backend/src/inventory/purchasing.js`:
  - `reorderSuggestions(db, scope, { locationId })`: items where `available + on-order < reorder` (levels from `stock_item_levels`, org default fallback), suggested qty up to `par`/`max` rounded to the preferred pack, minus open PO quantities (`approved|sent|partially_received`), preferred supplier and price in force; explains each line (“Chicken: 12 kg on hand, reorder at 20 kg, 15 kg already on order → order 25 kg = 3 crates”).
  - `createPo` (from suggestions or blank; lines in packs; prices prefilled from the supplier’s price in force; manual price override recorded), `updatePo` (only `draft`), `submit` (→ `pending_approval`, or straight to `approved` when no rule applies and self-approval is on), `cancelPo`, `markSent` (stores `sent_via` pdf/whatsapp/email/phone), `closePo` (remaining open qty dropped, requires reason).
  - `totals(lines)` exact (VAT by item `vat_class`; standard 16 % read from `inventory_settings` key `vat_standard_pct`, default 16, never hardcoded in code paths).
  - `poDocument(po)` → printable HTML for PDF/print and a WhatsApp text (`https://wa.me/<supplier phone>?text=…`, no third-party API). PDF made by the browser print stylesheet (no new dependency).
- Approval wiring arrives in P2-10; until then `submit` goes to `approved` in tests via the setting.
- Routes in `inventory-purchasing.js`: `/api/owner/inventory/:biz/purchase-orders…`, `/reorder-suggestions`.
- Tests: suggestions maths (on-order subtracted, pack rounding), totals match hand calc, edit refused after submit, cancel allowed until first receipt, numbering per year.

**P2-08 Receiving service: GRN, invoice, price variance, returns** · 2.5 d
- `backend/src/inventory/receiving.js`:
  - `receive(db, scope, { poId | unplanned+reason, supplierId, locationId, lines:[{poLineId, item, receivedQty+unit, rejectedQty, rejectReason, unitCost, batchNo, expiryDate}], invoice?:{…}, deliveryNoteNo, commandId })` → one transaction: insert GRN, one `ledger.post` **`purchase_receipt`** per line (`ref: {type:'grn', id}`, `unitCost` per base, `entered` kept, idempotency key `grn:<id>:<line>`), rejected quantity recorded but **not** posted, PO status moves to `partially_received`/`received` from the posted totals, `last_cost` updated by the ledger.
  - Receiving at a **branch** (direct delivery) allowed with `inv.purchase.create` + location scope; the Warehouse needs the owner (D2-3).
  - Price variance: compare the line cost with the PO line price and the previous `last_cost`; above `price_variance_alert_pct` → `notify(kind:'price_variance')` to the owner (dedupe per grn line). Never blocks the receipt.
  - `recordInvoice` (links to GRN/PO; PIN format check; duplicate number per supplier refused; attachment optional) and `reverseReceipt(grnId, reason)` via `ledger.reverse` (refused when later movements would take stock negative).
  - `returnToSupplier(db, scope, { grnId, lines, reason, creditAmount })` → `ledger.post` **`supplier_return`** at the receiving location at the *receipt cost*; refused beyond what that receipt added or what is on hand (“Only 2 kg of this delivery is still here”); credit amount recorded; weighted average is not re-computed on outbound (ledger rule).
- Routes: `/api/owner/inventory/:biz/receipts…`, `/purchase-orders/:id/receive`, `/invoices…`, `/returns…`.
- Tests: **T-PRC-1** (PO 100 kg → GRN 60 kg → balance +60, PO partially received → GRN 40 → received → return 5 kg → balance, credit, PO totals correct), unplanned receipt needs reason, over-receipt beyond tolerance refused, replay of the same command does not double-post, variance alert at 20 % and not at 5 %, avg cost maths across two receipts, reverse refused when stock already used.

### M2 — Approvals & emergency

**P2-09 Migration 017 — emergency purchases, approval rules, approvals** · 2 d
- `017_inventory_approvals_emergency.sql` + down:
  - `approval_rules` (business, `subject` po/emergency (extended in Phase 3 with wastage/adjustment/count), `metric` per_transaction/per_day/per_week/per_month/band/variance_pct, `location_id` null = every branch (the owner's default) or one branch (override), `category_id` null, `band_min`/`band_max`/`amount_kes`/`threshold_pct`, `approver_capability`, active, created_by, updated_at; unique active rule per (subject, metric, location, category)).
  - `approvals` (business, `subject_type`, `subject_id`, location_id, requested_by, amount_kes, `rule_id`, `reason`, status `pending|approved|rejected|withdrawn`, decided_by, decided_at, decision_note, `self_approved` bool). **Checks:** `decided_by is null or decided_by <> requested_by or self_approved`; `status = 'approved'` requires `decided_by`; `self_approved` may be true only when `decided_by = requested_by` (the service sets it only when no other approver exists, D2-5). Polymorphic (no FK to the subject) so Phase 3 reuses it.
  - `emergency_purchases` (business, branch location, number, supplier_id null, `supplier_name` text for on-the-spot, status `draft → pending_approval → authorised → purchased → received → under_review → closed | rejected | cancelled`, estimated/approved/actual amount, payment_method cash/mpesa/credit, payment_reference, reason, `invoice_status` etims/other/none, invoice_no, `no_invoice_reason`, created_by, timestamps; check: `invoice_status <> 'none' or (no_invoice_reason is not null and payment_reference is not null)`) + `emergency_purchase_lines` (item, qty_base, entered qty/unit, estimated and actual unit cost).
  - Trigger on `emergency_purchases`: moving to `received` requires `invoice_status` and, for `none`, at least one `attachments` row with `entity_type = 'emergency'` (T-EMP-3 at the DB level).
  - **No seed rows and no default amounts**: rules exist only when the owner creates them in Settings → Inventory (D2-6, D2-16). The migration stays data-free.
- Tests: rehearsal; maker-checker check; no-invoice constraints; `compat` green.

**P2-10 Approvals engine + PO approval wiring** · 2 d
- `backend/src/inventory/approvals.js`:
  - `evaluate(db, scope, { subject, locationId, amount, categoryId })` → `{ decision: 'auto' | 'needs_approval', rule, usage }`; **no rule for the branch and subject `emergency` → `needs_approval` with reason `no_limit_set`** (D2-6); for `wastage` no rule → `auto`; `adjustment` and `count` with no rule → `needs_approval` (D2-16); cumulative metrics computed from authorised emergency purchases in the current day/week/month in Africa/Nairobi, in the same transaction under an advisory lock per (business, location) so two simultaneous small buys cannot both slip under the weekly limit.
  - `request`, `decide(approve|reject, note)` (**`approverAvailable(db, businessId, requesterId, subject)`** looks for another holder of the approving capability: if one exists `assertDifferentPeople` applies; if none, the requester's own approval is allowed and stored with `self_approved = true` — D2-5), `withdraw`, `inbox(scope)` (pending for everyone the caller can approve, with who asked, amount, rule triggered, how much of the limit is used), `history`.
  - Rules CRUD (`inv.settings.edit`), **no default seed**; per-branch limits (per purchase/day/week, optional category) and per-business thresholds with optional branch override; changes audited with before/after; effective at once. Self-approved decisions emit an audit event `self_approved`.
  - Wiring: `purchasing.submit` calls `evaluate('po')`; PO approve/reject goes through `decide`; emergency `submit` uses `evaluate('emergency')` (P2-11).
  - Events: `approval_needed` (to approvers), `approval_decided` (to requester).
- Routes: `/api/owner/inventory/:biz/approvals`, `/approvals/:id/decide`, `/approval-rules`.
- Tests: **T-SEC-2** (another approver exists → requester cannot approve own; sole owner → allowed and the row is flagged `self_approved`; adding a second owner or approving operations manager switches the rule back; operations manager without `operations_can_approve` cannot decide; a branch manager can never self-approve), band logic, cumulative weekly limit exceeded by small buys routes the next one to approval, **no limit set → every emergency buy routes to approval**, concurrency (two parallel evaluations, one auto, one routed).

**P2-11 Emergency purchase service + branch API** · 2.5 d
- `backend/src/inventory/emergency.js`: `create` (draft with lines in entered units, estimated cost, reason, supplier from list or on-the-spot name → `suppliers` row `incomplete = true`), `submit` (evaluate → `authorised` or `pending_approval`), `markPurchased` (payment method + reference + actual amount), `receive` (posts **`emergency_receipt`** per line at the branch, `unitCost` = actual ÷ qty; needs invoice status + evidence rules: eTIMS/other → invoice no.; none → reason + reference + ≥ 1 goods photo), `review` (owner closes or flags `under_review`), `cancel`.
- Repeat purchase alert (EMP-7): ≥ `emergency_repeat_alert_count` receipts of the same item within `emergency_repeat_alert_days` → `notify('emergency_repeat', “You bought cooking oil in an emergency 3 times this week. Raise its par level?”)` with link to the item levels.
- Routes: branch `/api/inventory/emergency…` (list mine, create, submit, purchased, receive, cancel, `limits` = “within your KES X limit” numbers for the form), owner `/api/owner/inventory/:biz/emergency` (all branches, review).
- Tests: **T-EMP-1** (below threshold → authorised, stock on receipt, avg cost), **T-EMP-2** (above → blocked until a different user approves; branch manager cannot approve own), **T-EMP-3** (no invoice without reason/reference/photo → 400 and DB check), **T-EMP-4** (the owner sets and then changes a branch's weekly limit via rules, applies to the next submit with no deploy; before any limit is set every buy needs approval), branch isolation (T-SEC-1), on-the-spot supplier flagged incomplete, repeat alert.

### M3 — Purchasing screens → Release A

**P2-12 Navigation & plumbing for Phase 2** · 0.5 d
- `frontend/src/config/dashboards.js` (all `feature: 'inventory'`): owner Operations adds **Requests & transfers** (`inventory/requests`), **Purchasing** (`inventory/purchasing`, one page with `Segmented` tabs Suppliers · Purchase orders · Receive goods), **Approvals** (`inventory/approvals`, count badge); branch Operations adds **Requests & deliveries** (`inventory/requests`) and **Purchases** (`inventory/purchases`). Order, owner: Stock, Items, Recipes, Requests & transfers, Purchasing, Approvals, History; plus the owner **Reports** group (**Reports**, **Receipts**; see 05) and Settings → Inventory (P2-35). Branch: Stock, Requests & deliveries, Purchases, History; plus **Reports** and **Receipts** for the branch's own records.
- Routes in `App.jsx` (lazy, as the Phase 1 pages), API helpers in `frontend/src/lib/inventory.js`; the badge reads pending-approvals count from the existing notification poll (add a `badge` field to the section config only if absent).
- Pages added in later tickets; until then entries render an `EmptyState`.
- Done when: sidebar shows the new entries only with the switch on; `npm run build` green.

**P2-13 Owner screen: Suppliers** · 2 d
- Purchasing → Suppliers: list (search, type, “incomplete” filter), supplier drawer (contact, PIN, terms, payment details owner-only), items supplied with pack + price + effective date, price history list with “changed +12 % since last time”, add price (drawer), archive.
- Mocked Playwright `inventory-purchasing.spec.js` (part 1): add supplier, add two prices for one item (history order), phone-width check.

**P2-14 Owner screen: Purchase orders** · 2.5 d
- Purchase orders tab: list by status with counts on chips (Draft, Waiting for approval, Sent, Partly received, Received), **“Items to reorder”** panel from `reorder-suggestions` (“Order from Karibu Poultry: 3 items, KES 18,400”) → creates draft POs grouped by preferred supplier; PO editor in a drawer (lines in packs with live “= 75 kg”, price prefilled from price list and flagged when edited, VAT and total line, expected date, deliver to Warehouse/branch), submit, approve/reject (when allowed), **Send** (print/PDF, copy WhatsApp message, “Open WhatsApp”), cancel with reason.
- Plain words: “Waiting for approval”, “Sent to supplier”, “Delivered in part”.
- Mocked Playwright (part 2): suggestions → draft PO → send; unit conversion line; owner without permission sees read-only.

**P2-15 Owner screen: Receive goods and returns** · 2.5 d
- Receive goods tab: “Expected deliveries” (sent POs, due soonest first) + “Receive without an order” (requires a reason); receive drawer: per line ordered / delivered / rejected with unit picker, cost per pack prefilled from the PO, price-variance chip (“+20 % on last time”), delivery note number, invoice capture (number, date, PIN, eTIMS number as text, photo of the invoice via camera), submit; after posting show the stock effect (“Chicken +60 kg, new average cost KES 412/kg”).
- Returns: from a posted receipt, “Return to supplier” drawer (qty up to what is still here, reason, credit amount, photo).
- Receipt history list with “reverse” (confirm dialog; refused message when stock already used).
- Mocked Playwright (part 3): receive partial, second receive closes PO, return; phone width.

**P2-16 Owner screen: Approvals inbox** · 1.5 d
- Approvals page: tabs **Waiting for you** / **Decided**; each card says who asked, what, how much, which rule (“Weekly emergency limit set by you: KES X — KES Y already used”, or “No limit set for this branch”), a **Self-approved** chip when the owner approved their own record, photos attached; **Approve** / **Reject with a reason** (reason required on reject). Empty state: “Nothing needs your approval.”
- A **History** tab shows decided items including who decided and the self-approved flag. **Limits moved to Settings → Inventory (P2-35)**; this page links to it (“Set emergency limits”).
- Mocked Playwright (part 4): approve an emergency buy; reject needs a reason; self-approved chip; phone width.

**P2-17 Branch screen: Purchases (emergency)** · 2.5 d
- Purchases page: my emergency purchases by status; **“Buy something now”** drawer: items (existing or on-the-spot name), quantity with unit picker, estimated cost, reason, supplier (pick or type a name), live **“Within your KES X limit”** / **“Above your limit — the owner will be asked”** / **“No limit set — the owner will be asked”** indicator from the `limits` endpoint (X is whatever the owner set for this branch; nothing is built in), submit.
- After buying: mark purchased (payment method, reference, actual amount), invoice status (eTIMS / other / none); **none** reveals reason + reference + required goods photo (camera); then **Received** posts stock. Status chips follow the lifecycle in words (“Waiting for the owner”, “Go ahead and buy”, “Bought — receive the goods”).
- Mocked Playwright (part 5): auto-authorised path (limit set in the mock), no-limit-set path, over-limit path, no-invoice blocked until photo added; phone width (this is the screen used at the till, check thumb reach).

**P2-18 Release A: e2e, apply 015–017 and 014, merge** · 1.5 d (runs after P2-34, P2-35 and P2-36 are merged to `dev`)
- Playwright (real backend on a throwaway seeded database, not the shared one; stubbed AI fetch): supplier → price → PO → send → receive 60% → receive rest → invoice → return; branch emergency buy under limit → stock appears; over limit → owner approves → stock appears.
- Runbook: snapshot shared DB → create Storage bucket `inventory-evidence` (private; 8 MB; jpeg/png/webp/pdf) → move 015–017 **and `014_ai_gateway.sql`** to `migrations/` → `npm run db:migrate -- --dry-run` (only those four) → `npm run db:migrate` → census again → switch `inventory_enabled` on for the test business only → smoke test → PR `dev` → `main`.
- Rollback: down files in reverse order; each refuses once data exists (export first).
- Update KB 01/04 (gap statuses for SUP, PRC, GRN, EMP).

**P2-34 Admin screen: AI usage and limits** · 2 d
- `routes/admin` (existing admin module): `GET/PUT /api/admin/businesses/:id/ai` (on/off, monthly allowance KES, warn %, model overrides, per-feature switches) and `GET …/ai/usage?months=6`; audited like the inventory switch.
- `frontend/src/pages/admin/BusinessDetailPage.jsx`: an **AI** section beside the inventory switch: switch, allowance, usage this month (calls, tokens, KES, % of allowance, reset date) and last 6 months by feature. **Usage figures only; no prompt or answer text, no stock data** (admin rule).
- Mocked Playwright: set an allowance, switch on, usage table; phone width.

**P2-35 Owner screen: Settings → Inventory (limits, thresholds, AI usage)** · 3 d
- New owner Settings entry **Inventory** (the owner interface has no Settings page today, so this adds the entry with `feature: 'inventory'`). Sections: **Emergency buying limits** — per branch: per purchase, per day, per week, optional per category, with the plain note “Until you set a limit, every emergency buy needs your approval” and the usage so far this week; **Approval thresholds** — wastage, stock adjustments, count variance (Phase 3 subjects appear when their features ship; today the screen explains the safe defaults of D2-16) with a business default and per-branch override; **Purchase order approval** — optional bands, and a read-only line “You are the only approver, so you approve your own orders. These are marked self-approved” (shows who else could approve); **AI** — usage this month, allowance (owner may lower), per-feature switches.
- Every change confirms, shows “applies from now”, is audited with before/after, and is effective at once (T-EMP-4). Owner only (`inv.settings.edit`); branch managers see their own branch's limits read-only on the Purchases screen.
- Mocked Playwright: set a limit for one branch, override a threshold, lower the AI allowance; phone width.

**P2-36 Reports group and Receipts (supplier documents)** · 3 d
- Owner sidebar group **Reports** with **Reports** (placeholder until Phase 3, P3-28; entry hidden until then) and **Receipts** (`reports/receipts`). Branch sidebar gets **Receipts** (own branch only).
- `backend/src/inventory/receipts.js` + route: one list over **supplier invoices, goods receipts (GRN), emergency-buy receipts/invoices, supplier returns/credit notes** (delivery/dispatch notes are added by P2-37) with `type`, supplier, branch, date, number, amount, **invoice status (eTIMS / other / none)**, attachment count; filters by supplier, branch, date range, type, invoice status; search by number/supplier; open the **attached image or PDF** (5-minute signed URL after the permission check in `evidence.js`), **download**, link to the parent record. Branch managers: own branch only (T-SEC-1 shape). Customer sale receipts are **not** in this list (Q2-7).
- Screen: filter bar, table that collapses to cards, preview drawer with the image/PDF and the record's key facts; empty state “No receipts yet. They appear when you receive goods or record an emergency purchase.”
- Tests: each document type appears once; filters; branch isolation; signed URL refused outside the business; mocked Playwright (list, filter, open, phone width).

### M4 — Distribution engine

**P2-19 Migration 018 — distribution upgrade + 009 backfill** · 3 d (riskiest schema step: touches tables `main` uses live)
- `018_inventory_distribution.sql` + down, strictly additive:
  - `stock_requests`: widen `status` check to the superset `draft, submitted, approved, partially_approved, rejected, preparing, dispatched, partially_received, received, completed, cancelled`; add `kind` (`stock | return | branch_transfer`, default `stock`), `from_location`, `to_location` (null for old rows; the 009 shape implies Warehouse → branch), `priority`, `needed_by`, `approved_by`, `approved_at`, `needs_attention` bool, `completed_at`.
  - `stock_request_lines`: add `dispatched`, `received` (numeric(18,4) default 0), `entered_unit`; the existing `requested/approved` stay.
  - `stock_reservations` + `stock_reservation_events`, **exactly as `spikes/reservations/spike_018.sql`**: reservation keyed by `(request_id, item_id)` (009 `stock_request_lines` has no id, so no `request_line_id` and no new column on that table), `qty_reserved/consumed/released`, status `active|consumed|released` kept in step with the remainder by a CHECK, unique `(business_id, idempotency_key)`, one active row per request line (partial unique index); append-only events (reserve/consume/release, movement id on consume). Plus the backstop `check (reserved = 0 or on_hand >= reserved)` on `stock_balances` so `main`'s 009 code cannot pull held stock out from under a reservation.
  - `stock_transfers`: add `direction` (`out | return | branch_to_branch`; default `out`), widen `status` to `pending_approval, in_transit, partially_received, received, cancelled`, `approved_by/approved_at`, `over_qty`; check that `direction` matches the location kinds (`out`: center → branch; `return`: branch → center; `branch_to_branch`: branch → branch). `stock_transfer_lines`: add `damaged`, `over`, `entered_unit`, `unit_cost` (carried from the dispatch movement).
  - `transfer_discrepancies` (business, transfer_id, line_id, item, kind `short|damaged|over`, qty_base, value_kes, status `open|resolved`, `bearer` carrier/source/destination, `resolution` write_off/returned_to_source/arrived_later/source_deducts, resolution_movement_id, resolved_by/at, note, created_by).
  - Unique index `stock_transfers_one_per_request` (009: one non-cancelled transfer per request) becomes **one open transfer per request**, so partial dispatch of the remainder is possible (drop and recreate as a partial index on `status in ('pending_approval','in_transit','partially_received')`).
  - **Backfill step (data, idempotent, in the same migration):** every existing request gets `kind = 'stock'`, `from_location` = the business’s center, `to_location` = the branch’s location; existing transfers get `direction = 'out'`; lines `dispatched = quantity`; **018 creates NO reservations (decided in P2-19):** `main`’s 009 dispatch cannot consume a reservation, so reserving at apply time would make `main`’s own dispatch fail the `stock_balances` backstop whenever free stock is short. The backfill is metadata only (kind, from/to, approval metadata, line dispatched/received, in-transit line cost; re-runnable as `select private.backfill_distribution_018()`). Reservations for legacy approved requests are created by the new engine when a business switches on (`ledger.reserve`, oldest first; `needs_attention = true` when short, D2-15). `stock_request_lines` gets no `reserved` column (`stock_reservations` is the one source) and no per-line source (the request’s `from_location` is the Warehouse). **Built:** `backend/db/proposed/018_distribution.sql` + down, `tests/inv/migration-018.test.js`, `reservations.test.js`, ledger reservations in `ledger.js` (P2-20).
- Down: refuses when any non-default row exists (new statuses, kinds, reservations, discrepancies); otherwise drops the new columns/tables and restores the old checks.
- Tests: rehearsal on a database seeded from the P2-01 census (counts identical before/after, old `inventory-v2.js` passes with 018 applied — **this is the check that `main`'s 009 code still works**), backfill idempotent when run twice, partial-index behaviour, down refuses and restores.

**P2-20 Ledger reservations** · 1.5 d — **design proved by the spike; port `spikes/reservations/ledger_spike.js` (diff in `ledger.diff`)**
- `ledger.js` additions (the only writer of `stock_balances.reserved`): `reserve(db, { businessId, locationId, itemId, qty, requestId, actorId, idempotencyKey })` → locks the balance row, refuses with `409 insufficient_available` and **how much is available** when `on_hand − reserved < qty`, inserts the reservation, `reserved += qty`; refuses any location that is not the Warehouse (D2-12: branch sales ignore `reserved`); `release(db, reservationId, { qty?, reason, idempotencyKey })`; `consume` is done **inside `post()`** via a new input `reservationId` for reason `transfer_dispatch` (`CONSUMES_RESERVATION = {'transfer_dispatch'}`): one UPDATE lowers `on_hand` and `reserved` together and bumps `qty_consumed`; the "never dip into reserved" guard is unconditional, so a dispatch may use **its own reservation remainder plus free stock, never another request's hold**; partial dispatch leaves the remainder reserved, cancel releases only the remainder. `availability(db, locationId, itemId)` = `on_hand − reserved − held` (held = 013 `branch_committed`); `post(..., { respectHeld: true })` for branch → branch and return dispatches takes the 013 order-check advisory lock first. Lock order: advisory → balance row → reservation row.
- `RECONCILE_SQL` gets a second query (`RECONCILE_RESERVED_SQL`): `stock_balances.reserved` must equal Σ (qty_reserved − qty_consumed − qty_released) of active reservations per (location, item) → returned as disagreements, same shape as today.
- Tests: port the spike scenarios (S1–S10) into `backend/tests/inv/reservations.test.js`; **T-INV-6 extended** (the seeded random test, zero diffs on both on-hand and reserved after every step), two parallel reserves for the last 10 kg (one wins), release restores availability, replay with the same idempotency key returns the same reservation, over-release refused, dispatch of more than reservation-remaining + free stock refused. **The two-connection race on real Postgres is P2-30** (PGlite cannot run two connections).

**P2-21 Distribution service: request → approve → dispatch → receive** · 3.5 d
- `backend/src/inventory/distribution.js` (the Warehouse is always `scope.centerLocationId`; no source choice):
  - `suggestRequest(db, scope, branchLocationId)`: lines from branch `par/reorder` minus (on hand + incoming) with recent daily use (7-day average of `pos_consumption`), rounded to the item’s main pack.
  - `createRequest` (`draft`/`submitted`; branch manager), `editDraft`, `cancel` (any state before dispatch; releases reservations; after a partial dispatch only the undispatched remainder), `review` (owner: approve/partial/reject **per line**, optional note; approving **reserves** each approved line at the Warehouse via `ledger.reserve` — if a line has less available than asked the owner sees the available figure and can approve that amount; status `approved` or `partially_approved`; reject needs a reason), `startPreparing` (→ `preparing`, produces the **pick list**: lines sorted by storage zone/category, quantity in the item’s pack and base).
  - `dispatch(db, scope, { requestId, lines? })`: per line `ledger.post` **`transfer_dispatch`** consuming the reservation (partial allowed: remainder stays reserved), transfer row `in_transit`, `code` + number as today (same 10-char alphabet, delivery note + QR page data), `unit_cost` = the movement’s cost so the branch receives at the same cost.
  - `cancelDispatch` (owner, before any receipt): `transfer_cancelled` returns stock to the Warehouse and **re-reserves** it for the request; refused after any receipt (“resolve it as a discrepancy instead”).
  - `findByCode(db, scope, code)` (QR landing; **403/404 for a user who manages none of the destination branches**, T-SEC-1).
  - `receive(db, scope, transferId, { lines:[{itemId, received, damaged, over}], note })`: good qty → `ledger.post` **`transfer_receipt`** at the branch with the carried cost; damaged is **not** added; short = dispatched − received − damaged; over accepted only up to `transfer_over_tolerance_pct` (extra posted as `transfer_discrepancy` in, flagged `over`); every difference creates a `transfer_discrepancies` row and a notification; status `received` or `partially_received` (rest still expected, e.g. second delivery) and the request moves to `received`/`completed` when every line is settled.
- Routes: new `backend/src/routes/inventory-distribution.js` — owner `/api/owner/inventory/:biz/requests…`, `/dispatches…`, branch `/api/inventory/requests…`, `/transfers/:id/receive`, `/receive/:code`. **Add to `routes/index.js` and keep `server-load.test.js` green.**
- Tests: **T-REQ-1** (asks 20 kg, owner approves 15 → `partially_approved`, 15 kg reserved at the Warehouse, available drops by 15), **T-REQ-2** (dispatch 15, branch receives 14 → Warehouse −15, branch +14, 1 kg short discrepancy open, owner and branch notified), **T-REQ-3** (cancel before dispatch → reservation released, available restored), approve more than available → refused with the available figure, partial dispatch then second dispatch, over-delivery within and beyond tolerance, damaged not added, QR scanned by another branch/waiter → 403, cancel dispatch after partial receipt refused, idempotent replays (approve ×2 reserves once, dispatch ×2 posts once).

**P2-22 Returns and branch → branch transfers** · 1.5 d
- `distribution.js`: `startReturn` (branch manager of the source branch; lines + reason; no approval unless `returns_need_approval`; **dispatches at once**: `transfer_dispatch` out of the branch, direction `return`, code + note, owner/warehouse receives with the same receive form), `requestBranchTransfer` (source or destination branch manager asks; `kind='branch_transfer'`, `pending_approval`; needs `branch_to_branch_enabled`), `approveBranchTransfer` (owner; **approval does not reserve** (D2-12) — the source branch dispatches next, availability checked then), dispatch by the source branch manager, receive by the destination.
- Source-branch dispatch checks `available = on_hand − held for open orders − reserved`; it cannot take stock a waiter could sell (uses the 013 availability numbers).
- Tests: return 3 kg (branch −3, in transit, Warehouse +3 on receipt), return refused beyond branch availability, branch → branch needs owner approval (maker ≠ checker), unapproved dispatch refused, destination QR works only for the destination manager, both branches’ histories show it.

**P2-23 Discrepancy review** · 1.5 d
- `distribution.js` `discrepancies(scope)`, `resolve(db, scope, id, { bearer, resolution, note })`:
  - `write_off` — stock already left both balances; records `value_kes` and bearer (carrier/source/destination) on the discrepancy, **no quantity movement** (the loss is reported, not re-deducted);
  - `returned_to_source` — the source over-picked or the goods were sent back: `transfer_discrepancy` **in** at the source;
  - `arrived_later` — `transfer_receipt`/`transfer_discrepancy` **in** at the destination (the goods turned up);
  - `source_deducts` (for `over`) — `transfer_discrepancy` **out** at the source for the extra the branch received (refused if it would go below zero or into reserved stock — resolve after recounting).
  - Every resolution posts at most one movement (`ref: {type:'discrepancy', id}`), is audited, notifies both sides, and closes the row.
- Owner permission `inv.transfer.dispatch`; branch managers see discrepancies on their own transfers (read only).
- Tests: each resolution maths, value computed at the carried unit cost, cannot resolve twice, reconciliation zero after every path, notification on open and on resolve.

**P2-24 Notification events and request suggestions** · 1.5 d
- Event catalogue (all via `notify()`, in-app through the existing NotificationCenter; recipients in brackets): `request_submitted` (owners), `request_approved` / `request_partially_approved` / `request_rejected` (branch managers of that branch), `delivery_incoming` on dispatch (destination branch managers; includes the code only to managers), `delivery_received` (owners), `discrepancy_opened` / `discrepancy_resolved` (owners + both branches), `branch_transfer_requested` (owners), `approval_needed` / `approval_decided` (P2-10), `price_variance` (P2-08), `emergency_repeat` (P2-11), `low_stock` — when a movement takes an item below its `reorder` level at the Warehouse or a branch (owners; branch managers for their branch; `dedupe_key = item:day`), `reservation_attention` (owners, from the 009 backfill).
- `notifications.js`: `eventKinds` table (kind → icon, default link, label) so the frontend renders titles consistently; verify `NotificationCenter` can show the new kinds (link targets exist after P2-26/27).
- Tests: each event fires once per cause (replay does not duplicate), low-stock dedupe per day, recipients correct per role.

**P2-25 Switch-over of the 009 flow onto the new engine (backend, parity)** · 1 d
- For a business with `inventory_enabled = true`, the old endpoints (`/api/stock/requests`, `/api/stock/requests/:id/cancel`, `/api/stock/transfers/:id/receive`, `/api/stock/receive/:code`, `/api/owner/stock/:biz/requests/:id/review`, `/dispatches`, `/dispatches/:id/cancel`) **delegate to `distribution.js`** with the same request/response shapes (status names mapped back where the old UI needs them); for `inventory_enabled = false` they run the old `stock/service.js` unchanged. This keeps `main` and the old pages working during the transition.
- **Parity test** `backend/tests/inv/distribution-parity.test.js`: replay the scenario sequences from `backend/tests/inventory-v2.js` (submit → review partial → dispatch → receive short with note → cancel dispatch → QR code lookup) against both engines and assert the same visible outcomes (balances in servings, statuses mapped, error messages for the same mistakes).
- The existing `/receive/:code` page route keeps working (it redirects to `/branch/:id/inventory/requests?receive=<id>` once the new screen exists, P2-27).
- Done when: parity test green; `test:v2` green; no old test deleted.

### M5 — Distribution screens → Release B

**P2-26 Owner screen: Requests & transfers** · 3 d
- Requests & transfers page (tabs with counts): **Requests** (waiting first), **To send** (approved/preparing), **On the way**, **Returns & branch transfers**, **Problems** (open discrepancies).
- Request drawer: branch, who asked, lines with asked / **available in the Warehouse** / approve box (unit picker, prefilled with asked or available whichever is less), per-line note, **Approve (reserves the stock)** / reject (reason). Wording: “Held for this request” instead of reserved. Banner “KES 12,300 worth of stock is held for 3 requests”.
- Pick list: printable and phone-friendly view; **Dispatch** (all or part) opens the delivery note with number and QR (reuse the existing print layout from `pages/stock/parts.jsx`), cancel dispatch.
- Branch → branch approvals appear in the same page and in the Approvals badge count; Problems tab: discrepancy cards with the three bearers and the four resolutions in plain words (“The branch lost it”, “It never left the Warehouse”, “Found later”, “Take the extra back”).
- Mocked Playwright `inventory-distribution.spec.js` (owner part): approve 15 of 20, pick list, dispatch, resolve a short discrepancy; phone width.

**P2-27 Branch screen: Requests & deliveries** · 3 d
- Requests & deliveries page: **New request** (suggested quantities from par/reorder and recent use, editable, unit picker, note), my requests with status chips and what was approved (“15 of 20 kg approved”), **Deliveries** (incoming with delivery number; “Receive” form per line: arrived / damaged, over only within the allowed tolerance shown as a hint; a note is required when something is short), **QR receive** (`/receive/:code` lands here, opens the receive form), **Send back to the Warehouse** (return drawer), **Move to another branch** (request drawer, shows “waiting for the owner”).
- History rows link to the request/transfer.
- Mocked Playwright (branch part): request → approved partly → receive short → discrepancy chip; QR link opens the receive form; return; phone width (receiving happens at the back door on a tablet or phone).

**P2-28 Retire the old 009 pages and code** · 1 d
- Remove `frontend/src/pages/stock/OwnerInventoryPage.jsx`, `BranchInventoryPage.jsx`, `parts.jsx` and `stock.css` pieces no longer used (keep `ReceiveCodePage.jsx`, now redirecting to the new route), the “old Inventory” entries (`featureOff: 'inventory'`) in `dashboards.js`, `App.jsx` `InventoryRoute` switching, and `src/stock/service.js` request/dispatch functions and their `routes/stock.js` routes. **Keep** whatever `main` still needs for businesses with the module off *until P2-31 is merged and the switch is on for everyone who uses stock*: so this ticket ends by **hiding** (not deleting) the old pages behind `inventory_enabled = false` and deleting only code that nothing references; the full delete is a checklist item in P2-31 after confirming no business has the module off and stock data.
- Tests: `npm run build`, `test:v2`, old specs updated (`v2-inventory.spec.js` and friends point at new pages or are removed with a note in the PR).

**P2-29 Design review of all Phase 2 screens** · 1 d
- Review Purchasing (3 tabs), Approvals, Requests & transfers, branch Requests & deliveries, Purchases against `DESIGN.md` and 07 §0.7 (consistency with Orders/Locations/Phase 1 inventory, plain words, touch targets, contrast, phone/tablet widths, empty and error states, camera flow). Compare with findings already recorded in `11-design-review.md` for Phase 1 so the same issues are not repeated. Fix before M5 closes.

**P2-30 End-to-end + concurrency on real Postgres** · 1 d
- Playwright on a seeded throwaway database: branch asks → owner approves part → pick → dispatch → branch receives short → discrepancy → owner resolves → stock correct everywhere; return; branch → branch.
- **Real Postgres (local Docker, not the shared DB):** 30 parallel approvals competing for one Warehouse item (total reserved ≤ on hand; no deadlock); 20 parallel dispatches/receives; reconciliation (on hand **and** reserved) returns zero rows.

**P2-31 Release B: apply 018 and merge** · 1 d
- Runbook: snapshot → census (record) → move 018 to `migrations/` → `db:migrate --dry-run` → `db:migrate` → census again (request/transfer counts identical; `needs_attention` count reported) → with the module on for the test business: walk the full request flow and a QR receive → PR `dev` → `main`.
- Checklist after merge: confirm no business uses the old flow with data, then delete the hidden old pages and `src/stock` request/dispatch code in a follow-up PR.
- Rollback: `018` down (refuses once new-world rows exist; export first).
- Update KB 01 (current system), 04 (gap statuses for REQ, TRF, SUP, PRC, GRN, EMP).

**P2-37 Receipts: delivery notes, dispatch notes with QR, transfer documents** · 1 d
- Extend `receipts.js` with transfer **delivery/dispatch notes** (number, from/to, QR code link, status, discrepancy flag) and return notes; preview shows the printable note; filters include type “Delivery note”. Branch managers see notes for their own branch (sent or received).
- Tests: a dispatch appears once, a branch that is neither source nor destination cannot see it, QR link matches the transfer code only for the destination manager. Mocked Playwright: filter to delivery notes; phone width.

---

## Cases Phase 2 must handle

(Adapted from 07 WP2.5 for one Warehouse; new rows marked **new**.)

| Case | Expected | Ticket / test |
| --- | --- | --- |
| Branch asks 20 kg, owner approves 15 | Partially approved; 15 kg reserved at the Warehouse; available −15 | P2-21 · T-REQ-1 |
| Dispatch 15, branch receives 14 | Warehouse −15, branch +14, 1 kg discrepancy open, both sides notified | P2-21/23 · T-REQ-2 |
| Cancel before dispatch | Reservation released, available restored | P2-21 · T-REQ-3 |
| Approve more than available | Refused with the available figure | P2-20/21 |
| Two approvals race for the last 10 kg | One reserves, the other is refused (no over-reservation) | P2-20, P2-30 |
| Partial dispatch of an approved request | Dispatched part leaves; remainder stays reserved until dispatched or cancelled | P2-21 |
| Cancel a request after a partial dispatch | Only the undispatched remainder is released | P2-21 |
| Damaged on arrival | Recorded; damaged qty **not** added; discrepancy for review | P2-21/23 |
| Over-delivery | Accepted within `transfer_over_tolerance_pct`, extra recorded as `over`; beyond it refused | P2-21 |
| QR scanned by another branch / waiter | 403 | P2-21 · T-SEC-1 |
| Cancel dispatch after partial receipt | Refused; resolve via discrepancy | P2-21 |
| **new** Branch returns 3 kg to the Warehouse | Branch −3 at dispatch, Warehouse +3 on receipt; cost carried | P2-22 |
| **new** Return more than the branch has available | Refused (open orders hold stock too) | P2-22 |
| **new** Branch → branch transfer | Owner approval first; source dispatches; destination receives with the same QR flow; maker ≠ checker | P2-22 |
| **new** Dispatch from a branch with no approval | Refused | P2-22 |
| **new** Discrepancy: bearer and resolution | Each of the four resolutions posts at most one movement or a recorded write-off; reconciliation zero | P2-23 |
| **new** 009 request approved before the switch | After the switch it holds a reservation (or is flagged “needs attention” if stock is short) | P2-19 |
| **new** In-transit 009 dispatch received after the switch | Receives through the new engine; balances and cost correct; same QR code works | P2-19/25 |
| **new** Old page / old API call after the switch | Same visible result as before (parity) | P2-25 |
| PO → partial GRN → 2nd GRN → supplier return | Balances, PO status, credit correct | P2-08 · T-PRC-1 |
| **new** GRN without a PO | Needs an unplanned reason; owner notified | P2-08 |
| **new** Same invoice number entered twice for a supplier | Refused | P2-08 |
| GRN price 20% above last | Variance alert to the owner (not at 5 %) | P2-08 |
| **new** Supplier return beyond what that delivery added or what is left | Refused with the figure | P2-08 |
| **new** Supplier archived with open POs | Refused | P2-04 |
| **new** Emergency buy, no limit set for the branch | Goes to the owner for approval (safe default); form says “No limit set” | P2-10/11 |
| Emergency below the owner-set limit | Auto-authorised; stock on receipt | P2-11 · T-EMP-1 |
| Emergency above the owner-set limit | Blocked until a different user approves | P2-11 · T-EMP-2 |
| Weekly cumulative limit exceeded by small buys | The next one routes to approval (also under concurrency) | P2-10 |
| No invoice without reason, reference and photo | Rejected (service and DB) | P2-11 · T-EMP-3 |
| Owner sets / changes a limit in Settings → Inventory | Applies to the next submit, no code change | P2-10/35 · T-EMP-4 |
| Same item bought in an emergency 3× in a week | Alert to raise par | P2-11 |
| Requester tries to approve own PO while another approver exists | Denied | P2-10 · T-SEC-2 |
| **new** Sole owner approves own PO | Allowed, logged, flagged `self_approved`, shown in inbox history and the Self-approved report | P2-10/16 · T-SEC-2 |
| **new** Any AI call (recipe draft) | Metered in `ai_usage` (tokens, cost); blocked with the plain allowance message at the limit; 80 % warning; a failed provider call is not counted | P2-32/33 |
| **new** Receipts list | Supplier invoices, GRNs, delivery notes, supplier returns in one place; filter by supplier/branch/date/type/invoice status; open the image/PDF; branch manager sees own branch only | P2-36/37 |
| Branch manager calls another branch’s emergency purchase or attachment | 403 + audit | P2-06/11 · T-SEC-1 |
| **new** Invoice/goods photo opened by someone outside the business | Signed URL refused | P2-06 |
| Anything above, replayed (double tap, retry) | One effect (`once()` + idempotency keys) | all |

## Exit criteria for Phase 2

**T-REQ-1..3, T-PRC-1, T-EMP-1..4, T-SEC-2** automated and green; T-SEC-1/3 re-run on every new endpoint; T-INV-6 extended (on hand and reserved) and the T-INV-7 style race on real Postgres for reservations; full request → receipt and PO → GRN flows in Playwright; reconciliation zero; `inventory-v2.js` green with 012–018 applied; 009 parity test green; old pages retired (or hidden with the delete checklist open).

## First week, day by day

| Day | Work |
| --- | --- |
| 1 | P2-01 decisions + census + **reservation spike** · start P2-02 |
| 2 | P2-02 harness, `notify()`, `nextNumber`, settings · start P2-03 migration 015 |
| 3 | P2-03 rehearsal + compat · start P2-04 suppliers service |
| 4 | P2-04 routes + tests (server-load green) |
| 5 | P2-05 migration 016 draft + rehearsal |

## Risks to watch in Phase 2

| Risk | Mitigation |
| --- | --- |
| Reservations put `stock_balances.reserved` out of step with the ledger | Only `ledger.js` writes it; reconciliation checks it; spike on day 1–2; real-Postgres race in P2-30 |
| Widening `stock_requests`/`stock_transfers` breaks `main`’s live 009 code on the shared DB | Strictly additive migration; `inventory-v2.js` runs with 018 applied; old statuses keep working; businesses with the module off never see new statuses |
| 009 data carry-over: approved requests that moved no stock, in-transit dispatches | Backfill rehearsed on census-shaped data; “needs attention” instead of silent shortening; same tables, no copy |
| Approval rules too strict or too loose for a real kitchen | Defaults are editable immediately (T-EMP-4); show usage against the limit on every screen; revisit after the first pilot week |
| Sole owner blocked by maker-checker, or self-approval abused | D2-5: self-approval only when no other approver exists, always flagged `self_approved` and reported; emergency buys always have a different approver |
| Owner never sets limits, so every emergency buy waits for approval | Deliberate safe default; the Settings → Inventory screen shows a “Set your limits” prompt and the Approvals inbox links to it; after the pilot week review whether a suggested starting point is wanted (Q2-2) |
| AI cost or unmetered calls | Gateway is the only door (grep test), usage row per call, hard monthly limit, 80 % warning; see `12-ai-insights.md` §5 |
| Evidence uploads on poor mobile data | Downscale client-side, retry the upload with the same signed URL, keep the form state; photo is required only for no-invoice buys |
| Storage bucket misconfigured (public by mistake) | Runbook step creates it private; a test asserts signed URLs expire and the API never returns a public URL |
| Scope creep into Phase 3 (counts, wastage approvals, batches) | Anything not in this list goes to the Phase 3 backlog; `batch_no`/`expiry_date` are stored, not used |
| Several warehouses requested again | Schema already allows `warehouse` kind and generic `from/to_location`; adding source choice and W→W is a later, separate plan |
| Screen volume (5 big pages) slips the schedule | Release A ships before distribution work begins; each screen ticket has its own mocked spec so they can merge independently |

## Open questions (proposed defaults are in place; answer when convenient)

- ~~**Q2-1** May the owner approve their own purchase orders?~~ **Answered 18 Nov: yes for a sole owner, logged and flagged (D2-5).**
- ~~**Q2-2** Starting emergency limits?~~ **Answered 18 Nov: no built-in amounts; the owner sets them per branch; until then everything needs approval (D2-6).** Still open: would the owner like Cravio to *suggest* a starting limit from the first weeks of spend?
- **Q2-3** Do returns to the Warehouse need approval? (default no; D2-12)
- **Q2-4** Over-delivery tolerance 5 %? Price-variance alert at 10 %? (D2-11, D2-13)
- **Q2-5** Should a supplier be able to deliver straight to a branch (PO “deliver to” = a branch)? (default yes)
- **Q2-6** AI (see `12-ai-insights.md` §6): who pays for it, which model, and the default monthly allowance per business (Q-AI-1…3).
- **Q2-7** Should “all receipts” in the Receipts tab also include **customer bills / order receipts**? (Default no: customer sale receipts belong to the later POS/eTIMS module; supplier and stock receipts only.)
