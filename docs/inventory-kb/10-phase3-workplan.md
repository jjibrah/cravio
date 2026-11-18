# 10 · Phase 3 work plan: controls, production, batches & reporting

Turns Phase 3 of `07-implementation-plan.md` into tickets, in the same format as `08-phase1-workplan.md` and `09-phase2-workplan.md`. Estimates assume one developer working with Claude; **≈ 115 working days (about 23 weeks) plus 7.5 days for optional tickets (warehouse-staff role 4.5, server-side PDF 3)** — the original 99 days plus 0.5 added to migration 023 for insight storage and the **AI insights layer** (15.5 days, `12-ai-insights.md`); the Reports/Receipts and PDF changes net to zero here (Receipts is built in Phase 2) — shipped in **five releases** (C controls & counts, D production & batches, E costing/reports/dashboards, F governance, G AI insights). Each ticket is small enough for one PR into `dev`. Written 18 Nov 2026. **Updated 18 Nov 2026 (product owner answers INV-P2/P3):** approval thresholds for wastage, adjustments and count variance are **owner-configured** (no fixed KES or % defaults; D3-4/D3-5/D2-16); PDFs are the browser's **Save as PDF** first (print layout), `pdfkit` only if emailed/scheduled reports are needed (P3-39, optional); the owner **Reports** tab lists every report (P3-26/28) next to **Receipts** (built in Phase 2, P2-36/37); and the AI insights are added after the reports they depend on (P3-40…P3-44). Phase 3 assumes Phase 2 is merged (migrations 015–018 and 014 applied); its migrations are **019–023**.

**Scope in one line:** prove where stock went (wastage with reasons and approvals, adjustments with maker-checker, staff meals and complimentaries, structured counts with variance), prepare in-house items (sub-recipes, production orders, yield), track batches and expiry (FEFO), cost and value stock, compare theoretical with actual use, and give the owner the reports, dashboards and governance (reconciliation, period close, editable roles) to act on it.

**What is NOT in Phase 3** (decided 18 Nov): several warehouses (everything is location-scoped, so it will carry over, but no multi-warehouse features are built); M-Pesa, eTIMS, shifts/KDS, offline (separate modules); supplier payments/AP and 3-way match; demand forecasting; recall *workflow* (traceability lists are built, notifications/holds on suppliers are not); SMS/email/push notifications (in-app only, as in Phase 1–2).

## What Phases 1–2 gave us

| Piece | Where | What Phase 3 does with it |
| --- | --- | --- |
| `ledger.post` (+ `postMany`, `reverse`, `reconcile`, `RECONCILE_SQL`, reserved handling from P2-20); reasons already declared: `wastage, adjustment_gain, adjustment_loss, count_correction, staff_meal, complimentary, production_input, production_output, reversal` | `backend/src/inventory/ledger.js` | Services only *call* it with the right reason; `occurred_at` and `batch_id` columns already exist on `stock_movements` |
| `approval_rules` + `approvals` (maker ≠ checker check), `evaluate/request/decide/inbox` | Phase 2 (`approvals.js`, 017) | Extended with subjects `wastage`, `adjustment`, `count`; the same Approvals inbox |
| `notify()` writer, `inventory_settings`, `inventory_events`, `once()`, `attachments` + evidence bucket, `numbers.js` | Phase 1–2 | Reused; new settings keys listed in P3-02 |
| `settings` already defined: `wastage_approval_value_kes`, `count_tolerance_pct`, `cost_method` (only `weighted_average` allowed), `notify_on_zero/exception` | `policies.js` | `wastage_approval_value_kes` migrates into `approval_rules` (P3-04, read as fallback until then); `cost_method` gains `batch` (P3-19); tolerance is used by counts |
| Branch `record()` kinds `count`/`add`/`waste` with a free-text `reasonCode` | `backend/src/inventory/branch.js`, `BranchRecordDrawer.jsx` | “Waste” becomes the reason-coded wastage flow (P3-04/06); single-item “count” becomes a one-line spot count (P3-08); `add` stays for corrections with a reason |
| Order snapshot `order_stock_lines` (what each order line needed, version-stamped) and DB serve trigger writing `pos_consumption` | 013 | Source of *theoretical* usage (P3-24); the trigger must learn FEFO (P3-18) |
| `recipes`/`recipe_versions`/`recipe_lines` keyed by menu item; `foodCost` / `computeCost` | `recipes.js`, 013 | Prepared-item recipes reuse versions/lines (P3-12/13); food cost rolls up through prepared items |
| `stock_exceptions` (served short), discrepancy review (Phase 2) | 012/018 | Shown in the dashboards and the variance explanation |
| Owner/branch Operations navigation; `inventory.css`, `branch.css`, `parts.jsx`, `RecipeSheet`, drawers | frontend | New pages under the same groups |

## How we work

Same rules as `08`/`09`. Differences:

| Topic | Rule |
| --- | --- |
| Branches | `inv/p3-NN-short-name` per ticket → `dev`; `dev` → `main` at each of **Releases C, D, E, F** (below). |
| Database | Migrations **019–023** in `backend/db/proposed/` with `.down.sql`; PGlite rehearsal each; **nothing touches the shared database until the release ticket** that lists it (019+020 at P3-11, 021+022 at P3-21, 023 at P3-30). Additive only; `main`'s code keeps working. The DB trigger changes in P3-18 are the sensitive ones: same function names and error codes (`P0001 / stock_sold_out`), the existing `inventory-v2.js` plus `order-flow.spec.js` run against the new functions, apply in a quiet window with a snapshot. |
| Compatibility | `backend/tests/inv/migrations.js` (from P2-02) lists 012…023 in order; `npm run test:inv:compat` applies all and runs `inventory-v2.js`. |
| Tests | `backend/tests/inv/` named after PRD IDs (`T-CTL-1 …`). Every ticket with maths ships a **hand-calculated** expected value in the test (not derived from the code under test). The golden dataset from P3-02 backs T-RPT-1/2. |
| UI rules | `DESIGN.md` + 07 §0.7: same components, plain words (“Counted”, “Expected”, “Gain/Loss”, never “variance posting”, “FEFO” is shown as “Use the oldest first”), unit picker with live conversion, one main action per page, drawers, phone/tablet first, skeleton rows, confirm irreversible actions, warn on unusual amounts. |
| UI tests | Mocked Playwright spec per screen ticket (fake session in storage, every API call answered in the spec, unlisted paths 404, no backend) on a **non-5173 port** with a one-off config (as in `09`). Phone-width overflow check in each. |
| Definition of done | Code + tests green: `test:inv` (incl. `server-load.test.js`) · `test:inv:compat` · `test:v2` · `npm run build` · server-side permission check on each route, authorized **before** the write transaction · one transaction + `once()` + `inventory_events` row per state change · no UI without API · KB touched if behaviour or schema changed. |
| Feature switch | Everything stays behind `inventory_enabled`; new areas also check their own capability (below). A business can use Phase 2 without turning on counts/batches: batch tracking is per item (D3-2). |
| Performance budget | Report on 100k movements over a quarter returns the first page in < 3 s or runs as a background job; dashboard endpoint < 500 ms cached. Checked in P3-37. |

## Decisions (all decided now; defaults proposed where the product owner has not spoken)

| # | Decision | Source |
| --- | --- | --- |
| D3-1 | **Cost method:** weighted average stays the default (INV-A7). When batches exist the owner may switch the business to **batch cost** (each consumption costs what *that batch* cost, FIFO by batch/expiry). The switch applies **going forward** only, needs a confirmation naming the effect, and is audited; existing history is never re-costed. | INV-A7 |
| D3-2 | Batch tracking is **per item**: `expiry_tracking` = off / optional / mandatory. Items with it off behave exactly as today (`batch_id` null). Stock already on hand for an item that becomes tracked sits in a “no batch” bucket, used last; a wizard lets the owner/warehouse assign batches and expiry dates to it. | PRD BAT; proposed |
| D3-3 | **Expired batches** are excluded from sellable availability and refused for transfers and production; a manager can **override one batch with a reason** (valid 24 h, audited, owner notified). Near-expiry alert lead time default 3 days, per category override. | PRD §1.6 default |
| D3-4 | **Wastage approval is owner-configured (answered 18 Nov).** Subject `wastage` in `approval_rules`, set in Settings → Inventory (P2-35) per business with an optional per-branch override; **no built-in amount**. **Until the owner sets a limit, wastage is recorded straight away with no approval** (routine, reason-coded, visible in the log; see D2-16). Once set, a record above the limit needs approval; the requester can never approve their own record unless they are the only approver (D2-5, flagged `self_approved`). **Unusual wastage** = this week’s wastage value for an item at a branch is more than `unusual_wastage_factor` (default 2×, a ratio, not money) its 4-week weekly average, with at least 3 weeks of history; an optional owner-set money floor (`unusual_wastage_floor_kes`, default none) hides trivial amounts; owner and branch manager are notified once per item per week. | Product owner, 18 Nov; PRD WST |
| D3-5 | **Counts:** types full / cycle / spot; snapshot when the session starts; **blind** hides expected quantities from counters (server never sends them); several counters per session; a recount can be requested per line. Variance = counted − (expected at snapshot + movements between the snapshot and **the moment that counter entered the number**, measured by ledger watermark, not at posting time; spike P3-01). **Approval limits are owner-configured (answered 18 Nov): a variance % and/or a KES value, per business with optional per-branch override; no built-in numbers.** **Until the owner sets them, any session with a non-zero variance needs one approval for the whole session** (a clean count posts on “Finish”); once set, a session within both limits posts on “Finish” and beyond either needs approval. The approver is not a counter of that line unless they are the only approver (flagged `self_approved`, D2-5). | Product owner, 18 Nov; PRD CNT |
| D3-6 | **Staff meals and complimentaries** are their own ledger reasons (`staff_meal`, `complimentary`), recorded by dish (expanded by the recipe version in force) or by item, against a per-branch **allowance per day** (portions or KES, configurable); over the allowance → approval. | PRD WST-4 |
| D3-7 | **Production:** a prepared item has a recipe (sub-recipe) with a **batch size** (e.g. 10 L stock from the listed lines). Production order: plan → start (inputs `production_input` at current cost) → complete with actual output (`production_output`, **cost per unit = Σ input cost ÷ actual output**) and the **yield variance** (planned − actual, qty and KES). Dish recipes consume prepared items as ordinary stock (no re-expansion at serve). Cycles (A uses B uses A) are refused on save in the service and by a DB trigger. | PRD PRD/RCP |
| D3-8 | **Valuation as of a date** = Σ of signed `stock_movements.value` up to that date (inbound at cost, outbound at the average at the time), by location/category/item. Movements with no cost are **counted and shown** (“12 movements have no cost”), never treated as zero silently. | Proposed |
| D3-9 | **Variance** (theoretical vs actual) is computed **between two posted counts** of the same item and location: actual use = opening count + receipts + transfers in + production output − transfers out − production input − wastage − staff meals/complimentaries − closing count; theoretical = Σ `order_stock_lines` of orders **served** in the period. Items without two counts in the range are listed as “Needs a count”. Tolerance highlight uses `variance_tolerance_pct` (default 5 %). | PRD CST-3/4 |
| D3-10 | **Reports:** a registry of report definitions (columns, parameters, totals) shown in the owner **Reports** catalogue (list → open → filters → table/chart → **CSV export** → **Save as PDF**). **CSV for all** (UTF-8 with BOM so Excel opens it, KES with 2 dp). **PDF = the browser’s print-to-PDF with a print stylesheet** (clean header with filters and generated-at, no sidebar, page breaks between groups, totals row) — no new dependency (answered 18 Nov). A **server PDF library (`pdfkit`)** is built only if emailed or scheduled reports are wanted (optional P3-39). Ranges > 31 days or > 50,000 rows run as a **background job producing CSV** (DB-backed queue polled in the API process with `FOR UPDATE SKIP LOCKED`; no new infrastructure), the file goes to a private bucket `inventory-reports` (kept 30 days) and the requester is notified. | Product owner, 18 Nov; PRD §17 |
| D3-11 | **Period close** is monthly by the owner: closing locks all locations through the chosen date (`period_locks`); a movement dated inside a closed period is refused (`period_locked`); corrections are posted dated today with a reference to the original. A close checklist lists open counts, pending approvals and open discrepancies; the owner can close with them acknowledged. Reopen needs a reason and is audited. | PRD LED-8 |
| D3-12 | **Role capabilities** stay as code defaults; per business the owner can add/remove capabilities per role. **Guardrails:** owner always keeps everything; the last owner cannot lose `inv.settings.edit`; maker-checker invariants cannot be turned off; branch scoping cannot be widened. **Delegation:** the owner can delegate approval capabilities for a date range (and optionally locations) to a named user; shown on every approval the delegate decides. | PRD RBAC-4/8 |
| D3-13 | **Reconciliation** runs hourly in the API process (advisory lock so only one runs): on-hand vs ledger, reserved vs reservations, batch balances vs on-hand; any difference raises an alert to owners and turns the Overview tile red; a manual “Run now” report exists (LED-5). Pilot acceptance = 7 consecutive days green. | PRD LED-5 |
| D3-14 | **Warehouse staff role (optional):** location-scoped warehouse manager / storekeeper in a **new table `inventory_memberships`** (not by widening `business_members`, which `main` reads). They use the owner area limited to the Warehouse: pick, dispatch, receive goods, counts; storekeeper has no approvals. | INV-A2; proposed |
| D3-15 | **Admin defaults:** platform admin screen “Units & defaults” (Kenya pack presets such as tray 30, crate 24, sack 90 kg; reason-code defaults; default alert levels). New businesses **copy** the defaults on first use; later admin edits do not change existing businesses. Admins see no stock records. | PRD §20, 05 |
| D3-16 | **AI insights (answered 18 Nov; design `12-ai-insights.md`).** Insight numbers come only from deterministic Cravio queries; the AI restates them in plain language; a validator rejects any number not in the input; a deterministic template is the fallback; the gateway (Phase 2, P2-32) meters and limits every call. Insights run daily per business and on demand from a fixed question list; owner sees all branches, a branch manager only their own. “Profit” always means **gross profit after food cost** and says that rent and salaries are not included. | Product owner, 18 Nov |
| D3-17 | **Reports tab and Receipts tab (answered 18 Nov).** Owner sidebar group **Reports** has **Reports** (catalogue of all reports) and **Receipts** (all supplier/stock documents, built in Phase 2). Branch managers see their own branch’s reports and receipts. Customer sale receipts are not part of this module (open question Q-R3). | Product owner, 18 Nov |

Logged in `docs/v2/DECISIONS.md` (P3-01, 18 Nov): **D3-1, D3-4, D3-5, D3-10, D3-16, D3-17 → INV-P3** (answered or accepted: INV-A7, INV-P2/P3); **D3-2, D3-3, D3-6…D3-9, D3-11…D3-15 → INV-P3D (proposed defaults, awaiting the product owner)**; open questions Q3-2, Q3-4…Q3-7 are in `06-open-questions.md` with their defaults. A change to either table must change the other. **Nothing money-shaped is built in:** the settings added in P3-02 for approval limits, allowances and the period close all start as *not set*.

## Milestones

| Milestone | Tickets | Outcome | ~Days |
| --- | --- | --- | --- |
| M0 Ready | P3-01 → P3-02 | Decisions logged, spikes (SQL FEFO at serve, count snapshot, report job), harness + golden dataset | 2.5 |
| M1 Wastage & adjustments | P3-03 → P3-06 | Reason codes, wastage with approvals and alerts, adjustments with maker-checker, staff meals/comps, screens | 11 |
| M2 Counts → **Release C** | P3-07 → P3-11 | Count sessions end to end; migrations 019–020 applied; `dev` → `main` | 14 |
| M3 Production | P3-12 → P3-15 | Prepared items, sub-recipes, production orders, screens | 10.5 |
| M4 Batches → **Release D** | P3-16 → P3-21 | Batches, FEFO (incl. at serve), expiry, traceability, batch cost; migrations 021–022 applied | 18.5 |
| M5 Costing & reports → **Release E** | P3-22 → P3-30 | Valuation, variance, menu engineering, reports catalogue (CSV, Save as PDF), background jobs, dashboards; migration 023 applied | 28 |
| M5b AI insights → **Release G** | P3-40 → P3-44 | Fact builders, validated insight generation, daily job, “Ask about my numbers”, Overview and Reports → Insights screens, privacy and cost checks | 15.5 |
| M6 Governance → **Release F** | P3-31 → P3-38 | Reconciliation job, period close, editable roles + delegation, admin defaults, pilot soak, phase close (P3-36 optional, not counted) | 14.5 |
| **Total** | | Optional P3-36 (4.5) and P3-39 (3) not counted | **115** |

**Spikes in P3-01 (day 1–2), because they are the riskiest — done 18 Nov, kept in `docs/inventory-kb/spikes/<name>/` (SQL, test, real output, README):**
1. **`fefo-serve`** — FEFO inside the serve trigger on PGlite: **35/35 pass**. Works as planned; sellable stock must also drive the order check and `stock_menu_availability`; the serve trigger writes reason `served` (not `pos_consumption`).
2. **`count-snapshot`** — count maths with sales during the count: **328/328 pass**. The plan's example holds, but "movements since snapshot at posting time" is wrong when sales continue after the counter counted; **each counter entry carries a ledger watermark** (fix below). 150 random sessions match a physical-stock model.
3. **`report-jobs`** — job queue: **43/43 pass** for claim/lease/retry/fencing/dedupe/expiry/download with workers taking turns. PGlite is one connection, so the true two-connection race (no job runs twice) is **not** proved here and is a P3-21 drill on a disposable real Postgres.

### Spike results (P3-01): changes to the plan

| Ticket | Change |
| --- | --- |
| P3-03 | `approval_rules.subject` / `approvals.subject_type` already allow `wastage`, `adjustment`, `count` (and `transfer`) since **017**: drop that bullet; 019 adds no check changes. |
| P3-07 | Add `stock_count_lines.snapshot_movement_id bigint` and `stock_count_entries.ledger_watermark bigint`; keep `movements_since_base` as the **stored result** at review. |
| P3-08 | Snapshot = one `insert … select` of `on_hand` + highest movement id per line (no lock). `enterCount` records the entry's watermark. Variance per entry = counted − (expected_base + Σ movements with `snapshot_movement_id < id ≤ ledger_watermark`). **`settle` (review) stores the numbers; the approver approves them; `post` writes exactly those** (status gate + key `count:<id>:<line>`), never recomputes. New named test: sales **after the count but before posting** (snapshot 100, 20 sold, counted 70, 5 more sold → variance −10, system ends 65). |
| P3-14/P3-17/P3-18 | The serve trigger writes `served`; reports must count `served` and `pos_consumption` as theoretical use. `order_stock_effects.movement_id` is only the first movement of a split serve: traceability uses `stock_movements.ref_type/ref_id`. Replace **three** functions together (`stock_on_serve`, `stock_check_new_lines`, `stock_menu_availability`) with a shared `private.sellable_qty`; re-run the spike's regression drill (untracked items identical to 013) as a real test. Lock order: advisory → `stock_balances` row → `batch_balances` rows. |
| P3-22 | `report_jobs` gains `attempts, max_attempts, run_after, progress_done, progress_total, dedupe_key, expires_at, byte_size, error` (plain words) and `error_detail`; partial unique index **one running job per business**; poll and dedupe indexes. |
| P3-27 | Claim = one `update … where id = (select … for update skip locked limit 1) returning *`; separate `sweep` re-queues expired leases (lease 2 min, heartbeat per chunk, replaces "reclaim after 10 min"); `heartbeat/finish/fail` are fenced by `locked_by`; keyset paging; BOM written with the file. **P3-21 gains a two-connection poller drill** (4 pollers, 200 jobs, kill one mid-job). |

---

## Tickets

### M0 — Ready

**P3-01 Record decisions and run the spikes** · 1.5 d
- Write D3-1…D3-15 into `docs/v2/DECISIONS.md` answer log and `06-open-questions.md`.
- The three spikes above, run on PGlite with all proposed migrations; **committed** under `docs/inventory-kb/spikes/{fefo-serve,count-snapshot,report-jobs}/` with a README each (the reservations and order-snapshot spikes set that format); results and plan changes are in the section above. Done 18 Nov: decisions logged (`DECISIONS.md` INV-P3 / INV-P3D, `06-open-questions.md`); no spike failed; the count formula and the job-queue design were changed before coding.
- Done when: decisions logged; spikes pass. ✔

**P3-02 Harness, settings keys, golden dataset** · 1 d — **done 18 Nov**
- Harness (`helpers.js`, additive): `makePrepared`, `makeBatch` (needs 022; the spike schema stands in until P3-16), `addStaff` (several counters / waiters per branch with contexts), `postAt` (post at a fake-clock moment), `DEFAULT_REASON_CODES`. `fixture.js` is unchanged. Tables for wastage reasons, counts and production do not exist until 019–021, so their helpers arrive with those tickets.
- **Golden dataset** (`golden-data.js` SPEC + EXPECTED, `golden.js` loader, `golden.test.js`, document `docs/inventory-kb/golden-dataset.md`): **two branches and the Warehouse**, 10 items, 6 dishes with recipes and yields (chicken 70 %, potatoes 80 %, tomatoes 90 %), a week of 14 served orders, purchases at changing costs, 2 rounds of transfers, wastage, staff meals and a complimentary, an opening and a closing count at all three places (404 movements, built in ≈ 0.4 s after the schema). Every figure (balances, average cost day by day, theoretical use, actual use and variance per item and branch, food cost %, branch gross profit after food cost, valuation on three dates and by place, the 0.02 gap between the two valuation methods) was worked out **independently of the code** and is asserted against the real ledger, serve trigger and `computeCost`; the document must show the headline figures (test). It replaces the plan's one-branch/40-order sketch because P3-23, P3-25 and P3-40 need two branches; **a loss-making week is built on top of a fresh load by the test that needs it** (P3-40), not baked in.
- `policies.js` `SETTINGS` additions (validated, audited; test `settings-phase3.test.js`): `count_variance_value_kes`, `count_variance_pct`, `unusual_wastage_floor_kes`, `staff_meal_allowance_portions`, `complimentary_allowance_kes`, `period_close_day` — all **null = not set**; `variance_tolerance_pct` 5, `unusual_wastage_factor` 2, `expiry_alert_days` 3, `expired_override_hours` 24 (as planned) plus `price_change_alert_pct` 10, `food_cost_target_pct` 35 (P3-25) and `vat_standard_pct` 16 (`purchasing.js` already read this key but P2 never registered it, so it could not be set). `count_tolerance_pct` stays (legacy, null); the limits themselves live in approval rules (017 already has `variance_pct` / `variance_kes` for the `count` subject), the two `count_variance_*` settings are the read-as-fallback pair.
- `migrations.js` list extended as each migration lands (019–023 are not written yet, so it is unchanged).
- Done when: golden dataset loads in < 2 s on PGlite and its hand-computed numbers are asserted. ✔ (730 checks)

### M1 — Wastage & adjustments

**P3-03 Migration 019 — reason codes, wastage, adjustments, allowances** · 2 d
- `019_inventory_controls.sql` + down:
  - `stock_reason_codes` (business, `kind` wastage/adjustment/staff_meal/complimentary, `code`, label, `needs_photo` bool, `needs_note` bool, active, position; unique (business, kind, code)); seeded on first use from defaults (burned, spoiled, expired, prep error, spill, damaged, customer return, over-production, theft suspected / gain: found, recount; unit/pack presets later in P3-35).
  - `wastage_records` (business, location, number, `item_id` null, `menu_item_id` null — exactly one of the two, qty entered/unit/base, `reason_code_id`, note, photo attachment ids, `value_kes` frozen at record time, status `recorded | pending_approval | approved | rejected`, requested_by, approval_id, movement ids via ref, occurred_at).
  - `wastage_record_lines` (record, item, qty_base, unit_cost, value) — a menu-item wastage expands through the recipe version in force.
  - `stock_adjustments` (business, location, number, `direction` gain/loss, item, qty entered/base, reason_code_id, note, evidence, value_kes, status `pending_approval | approved | rejected | posted`, requested_by, approval_id, movement_id).
  - `allowance_usage` (business, location, day (Africa/Nairobi), kind staff_meal/complimentary, portions, value_kes) maintained by the service.
  - ~~Widens `approval_rules.subject` and `approvals.subject_type` checks to add `wastage`, `adjustment`, `count`~~ — **already done in 017** (P3-01 spike review); 019 only reads them.
- Down: refuses when any row exists.
- Tests: rehearsal, exactly-one-of check, compat green.

**P3-04 Reason codes + wastage service + unusual-wastage alert** · 3 d
- `backend/src/inventory/reasons.js` (list/create/edit/deactivate; a used code can be deactivated, never deleted) and `wastage.js`:
  - `record(db, scope, { locationId, itemId | menuItemId, quantity, unit, reasonCodeId, note, photoIds })`: value from current avg cost (menu-item wastage = Σ recipe lines at the version in force, yield applied, via `recipes.js` expansion); `approvals.evaluate('wastage', amount)` → below the rule: posts **`wastage`** movement(s) at once; above: status `pending_approval` and **nothing posts until approved**; on approve the service posts with idempotency key `wastage:<id>:<line>`; reject keeps the record, posts nothing. Required photo/note per reason code.
  - Waiters keep read-only (07 §0.5 “limited wastage” stays out); branch managers record; owner records anywhere.
  - Unusual-wastage check after every posted record: compares this week’s (Mon–Sun, Nairobi) value for (item, location) with the 4-week average and the floor (D3-4) → `notify('wastage_unusual')` to owners and branch managers, deduped per item per week.
  - Migrates `wastage_approval_value_kes` setting (default null): on first read per business, if set and no `wastage` rule exists, create the rule from it (then the setting is ignored; audit row). No rule and no setting → wastage posts at once (D3-4).
- Routes: branch `/api/inventory/wastage…`, `/reason-codes`; owner `/api/owner/inventory/:biz/wastage…`, `/reason-codes…`. Replace the free-text `reasonCode` on `branch.record` kind `waste` with a call into this service (keep the route shape; old clients still work).
- Tests: **T-CTL-1** (wastage above threshold → `pending_approval`, no movement; approved by another user → separate `wastage` ledger type, cost recorded at approval-time average (documented: cost frozen at record time, shown on the record)); below threshold posts directly; menu-item wastage expands 1 burger = 285.7 g chicken etc.; maker ≠ checker; reason requires photo when configured; unusual alert fires once; replay does not double-post.

**P3-05 Adjustments (maker-checker) + staff meals and complimentaries** · 2.5 d
- `adjustments.js`: `createAdjustment` (gain/loss with reason, evidence, qty with unit), routed through `approvals`: **until the owner sets an `adjustment` limit every adjustment, gain or loss, needs approval** (D2-16; a gain is how stock can be conjured); once set, losses above the limit and **every gain** still need approval, posts `adjustment_gain` / `adjustment_loss`; approver ≠ creator.
- `allowances.js`: `recordStaffMeal` / `recordComplimentary` (by dish or item, quantity, who/for whom note), updates `allowance_usage`, posts `staff_meal` / `complimentary` movements (recipe expanded); over the day’s allowance (portions or KES per branch) → approval; shows remaining allowance.
- Routes branch + owner (same file families as P3-04); owner can edit allowances and rules (`inv.settings.edit`).
- Tests: gain needs approval; approver ≠ creator (T-SEC-2 family); allowance exactly reached allowed, one more routed; staff meal expands recipe and posts at cost; allowances reset at Nairobi midnight; compat green.

**P3-06 Screens: Wastage, adjustments, allowances** · 3.5 d
- Branch **Wastage & adjustments** page (replaces the old waste drawer in Stock): “Record wastage” drawer — pick an item **or a dish**, quantity with unit picker, reason (chips from the configured list), photo (camera) when required, live “This costs KES 640”; status chips (“Waiting for the owner”); tabs Wastage · Adjustments · Staff meals & comps (shows “3 of 5 staff meals used today”).
- Owner **Counts & wastage** page (first part): wastage log across branches (filters branch/reason/date, totals by reason), pending items appear in **Approvals** with an icon per kind (extend the Phase 2 inbox cards: item, qty, KES, reason, photo); **Settings → Reasons & limits** panel: reason codes (add/rename/needs photo), allowances, unusual-wastage factor and floor. **The approval limits themselves (wastage, adjustments, count variance) are edited in the owner Settings → Inventory screen built in P2-35**; this panel extends it, not a second place.
- Mocked Playwright `inventory-controls.spec.js`: record wastage under/over the limit, reject, add a reason code, allowance reached; phone width.

### M2 — Counts → Release C

**P3-07 Migration 020 — counts** · 2 d
- `020_inventory_counts.sql` + down:
  - `stock_counts` (business, location, number, `type` full/cycle/spot, scope filters (category ids, zone text, item ids), `blind` bool, status `open | counting | under_review | approved | posted | cancelled`, `snapshot_at`, created_by, started_at, finished_at, approved_by/at, approval_id, note).
  - `stock_count_lines` (count, item, `expected_base` frozen at snapshot, **`snapshot_movement_id`** (highest movement id for the item at the snapshot), `final_counted_base`, `movements_since_base` (stored at review), `variance_base`, `variance_value`, `unit_cost` frozen, status `uncounted | counted | recount | settled`, `recount_requested_by`, movement_id).
  - `stock_count_entries` (line, counter_id, qty_base, entered qty/unit, counted_at, **`ledger_watermark`** (highest movement id for the item when the number was entered), `is_recount` bool, note) — append-only per counter so “two counters disagree” keeps both numbers.
  - `stock_count_counters` (count, user, assigned scope) for multi-counter sessions.
  - Trigger: `expected_base` and `snapshot_at` cannot change after the session leaves `open`.
  - One open full count per location at a time (partial unique index); cycle/spot may overlap different items (checked by service).
- Down: refuses when any count exists.
- Tests: rehearsal; compat green.

**P3-08 Count service** · 4.5 d
- `backend/src/inventory/counts.js`:
  - `create` (type, filters, blind, counters; cycle suggestion: items whose last count is oldest or highest value first — `suggestCycle(location, n)`), `start` (**snapshot**: lock-free read of balances into `expected_base`, `snapshot_at = now()`), `sheetFor(counter)` — for blind sessions **expected is never in the response** (T-SEC style test), `enterCount` (idempotent per counter+line, unit picker, large-number warning reused from Phase 1), `requestRecount(line)` (reviewer), `finishCounting` (all lines counted or explicitly skipped with reason), `review` (each line: variance qty/value; when counters disagree shows both and the reviewer chooses or asks for a recount), `approve` (per D3-5; approvals subject `count`; approver ≠ every counter), `settle` at review stores per line the chosen entry and `variance = counted − (expected_base + movements between the snapshot and that entry's watermark)`; `post`: per line `count_correction` of exactly that stored variance — movements recorded around the count (sales, receipts, transfers, before or after the counter counted) are **left in** and the correction is only the unexplained part (spike `count-snapshot`); idempotency `count:<id>:<line>`; `cancel`.
  - Spot count shortcut: one item, one counter, no approval within tolerance (replaces the Phase 1 single-item `count` kind; the old API route stays and calls this).
  - Counts of items with open reservations: reservations are not touched; the sheet shows on-hand only.
- Tests: **T-CTL-2** (count variance beyond tolerance → under review → cannot post until a different user approves; posts `count_correction` after); **sales during a count** (snapshot 100, counter counts 70 after 20 sold → movements since snapshot −20, expected at count 80, variance −10, correction −10, not −30); **sales after the count but before posting** (5 more sold → variance still −10, system ends 65, not 70); back-dated receipt during the count; blind sheet has no expected; two counters 70 vs 72 → both stored, reviewer picks, or recount; opening-balance rule respected (CNT-5: a count is not an opening); full-count uniqueness; cancel posts nothing; replay posts once; branch isolation.

**P3-09 Branch screens: counting** · 3 d
- Branch **Counts** page (new entry under Operations, branch only; owner entry in P3-10): list of sessions (Open, In progress, Waiting for review, Done); **Start a count** drawer (type in plain words: “Everything”, “A few items today”, “One item”; category chips; “Blind count” switch with one-line explanation).
- **Count sheet** (mobile-first): item cards in storage order, big number box with unit dropdown and live conversion (“12 crates = 120 kg”), “Not here / zero” button, search/scan barcode field, progress bar (“41 of 60 counted”), save as you go, finish → review summary (blind: no expected shown; non-blind: expected and difference per line with colour).
- Spot-count entry from Stock rows (“Count this item”).
- Mocked Playwright `inventory-counts.spec.js`: blind sheet shows no expected, enter counts, finish, reviewer sees variance; phone width with 60 lines (no horizontal scroll, sticky progress bar).

**P3-10 Owner screens: counts and variance review** · 2.5 d
- Owner **Counts** entry (Operations): all locations’ sessions, filters, “Schedule a cycle count” (suggestion list by oldest count or highest value), review page: table per line (expected, counted, movements during the count, difference, KES), recount request button, per-line accept/choose-counter, **Approve and post** (disabled with the reason when the user was a counter), summary “Net difference KES −1,240 (−0.6 %)”.
- Approvals inbox rows for count sessions (shared card).
- Mocked Playwright: review, request recount, approve and post.

**P3-11 Release C: e2e, design review, apply 019–020, merge** · 2 d
- Playwright e2e on a seeded database: wastage over limit → owner approves → ledger; full count with a sale in the middle → review → approve → stock corrected.
- Design review of P3-06/09/10 screens against `DESIGN.md` and 07 §0.7 (and `11-design-review.md` findings), fixes.
- Runbook: snapshot → census → move 019, 020 → `db:migrate --dry-run` → `db:migrate` → census → switch on for the test business → smoke → PR `dev` → `main`. Rollback: down files, each refuses once data exists.
- Update KB 01/04 (WST, ADJ, CNT statuses).

### M3 — Production

**P3-12 Migration 021 — prepared items and production** · 1.5 d
- `021_inventory_production.sql` + down:
  - `recipes`: add `stock_item_id` (unique, the prepared item), make `restaurant_id` and `menu_item_id` nullable, check `(menu_item_id is null) <> (stock_item_id is null)`; add `recipe_versions.output_qty_base numeric(18,4)` (the batch size the lines make; null for dishes) and `shelf_life_hours` (nullable; used by batches in 022). Relaxing NOT NULL is additive; `main` does not read recipes.
  - `production_orders` (business, location, number, prepared item, recipe_version_id, `planned_output_base`, `actual_output_base`, status `planned | in_progress | completed | cancelled`, `input_cost_total`, `unit_cost` (output cost per base unit), `yield_variance_base`, `yield_variance_value`, planned_for, created_by, started_at, completed_by/at, note) + `production_inputs` (order, item, planned_base, actual_base, unit_cost, movement_id).
  - Trigger refusing a recipe-line chain that loops: when a `recipe_lines` row is inserted for a prepared recipe, walk the prepared items it uses (recursive CTE, depth ≤ 10) and refuse if the prepared item itself appears; depth > 5 refused (“sub-recipes can go 5 levels deep”).
- Down: refuses when a production order or a prepared recipe exists.
- Tests: rehearsal; cycle A→B→A refused at DB level; compat green.

**P3-13 Prepared items and sub-recipes service** · 2.5 d
- `recipes.js` extension (same versioning rules, same immutability once used by an order **or a production order**): `savePreparedRecipe(itemId, { outputQty+unit, lines, shelfLifeHours, note })`, `getPreparedRecipe`, cost roll-up (`computeCost` for a dish whose line is a prepared item uses that item’s `avg_cost`, and the preview shows “1 portion uses 80 ml bolognese sauce (KES 24)”; unknown when the prepared item has no cost yet), cycle detection in the service **before** the DB trigger (plain message naming the loop: “Bolognese uses Tomato base, which uses Bolognese”), archived-ingredient rule as for dishes.
- `catalogue.js`: items with `kind = 'prepared'` require a recipe before production; `allow selling a prepared item directly` stays as `resale`-like only if the owner sets a menu link (unchanged 013 link behaviour).
- Routes: owner `/api/owner/inventory/:biz/prepared/:itemId/recipe`, branch variant for branch-level prep (managers prepare at their own branch; the recipe is business-wide, edited by the owner and branch managers per A8).
- Tests: cycle refusal (direct, indirect, depth), cost roll-up hand calc (tomato base KES 13/100 ml → sauce → dish), version immutability, dish recipe containing a prepared item serves and deducts the prepared item as stock.

**P3-14 Production orders service** · 3 d
- `backend/src/inventory/production.js`: `plan` (item, planned output, location; scales the recipe lines from the version; shows shortages of inputs — ones that cannot be covered are flagged, not blocked), `start` (checks availability of inputs; **posts `production_input`** per line at the current average cost in one `postMany`, status `in_progress`), `complete` (actual output; posts **`production_output`** at `unit_cost = Σ input cost ÷ actual output`; the prepared item’s `avg_cost` re-averages through the ledger; **yield variance** = planned − actual in qty and KES (input cost × shortfall share) stored on the order), `cancel` (before start; after start only “complete with 0 output” or `reverse` inputs with a reason), `reverse` (owner; refused when produced stock was already used).
- Branch prep at the branch location; owner can produce at the Warehouse (central kitchen is just the Warehouse location).
- Reservations: inputs are not reserved before start (kept simple; start fails with the exact shortage if stock moved).
- Tests: **production** — 10 L planned from 6 kg tomato + 2 L water + …: output 9 L → cost per L = Σ ÷ 9 (higher than planned), variance recorded (−1 L and its KES value), replay posts once, start refused with exact shortage, completion with 0 output posts only inputs and records 100 % variance, concurrency: two orders compete for the last tomatoes, one wins.

**P3-15 Screens: prepared items and Prep** · 3.5 d
- Items & recipes: items of kind “Prepared (made in-house)” get a **Recipe** tab using the Phase 1 recipe editor (batch size line “This recipe makes 10 L”, lines, cost per L, shelf life, version history) — reuse `RecipeSheet`/`LineEditor`; the dish recipe editor’s item picker now includes prepared items with a small “made in-house” tag.
- Branch **Prep** page (05 navigation proposal): today’s plan (suggested from par levels of prepared items), **Start a batch** drawer (quantity or “how many batches”, shows inputs needed and any shortage), in-progress cards with **Finish** (actual output, live “yield 90 %: KES 41/L, planned KES 37/L”), history. Owner sees the same per branch/Warehouse in a **Production** tab on the Prep page.
- Mocked Playwright `inventory-production.spec.js`: create a prepared item recipe, start, finish with low yield, cost shown; cycle refused with the plain message; phone width.

### M4 — Batches → Release D

**P3-16 Migration 022 — batches, expiry** · 2.5 d
- `022_inventory_batches.sql` + down:
  - `stock_items`: add `expiry_tracking` (off/optional/mandatory, default off), `default_shelf_life_days`.
  - `batches` (business, item, `batch_no` (unique per business+item), source (grn/production/opening/transfer), `supplier_id`, `received_at`, `expiry_date`, `unit_cost` per base, `source_ref_type/id`, `status` active/depleted/quarantined, `override_by`, `override_reason`, `override_until`, created_at).
  - `batch_balances` (location, item, batch, `on_hand` ≥ 0, updated_at; PK (location, batch)) and `batch_balance_check` view/constraint helper for reconciliation.
  - `stock_movements.batch_id` (exists in 012) gets its FK to `batches`; index (batch_id).
  - `inventory_settings` key `cost_method` check widened by the service (value `batch` allowed).
  - **Invariant function** `private.batch_sum_ok(location, item)` used by tests/reconciliation: Σ `batch_balances` ≤ `stock_balances.on_hand` (the rest is the “no batch” bucket).
  - Backfill: none (existing stock stays unbatched; D3-2). Items of Phase 2 receipts that stored `batch_no/expiry_date` on `grn_lines` get batches created **lazily** by the P3-17 service the first time the item is tracked.
- Down: refuses when any batch exists.
- Tests: rehearsal, constraints, compat green.

**P3-17 Batch service and FEFO in the ledger (non-serve paths)** · 3.5 d
- `ledger.js`: `post()` learns `batchId`; `allocate(db, { locationId, itemId, qtyBase, policy: 'fefo' | 'fifo', excludeExpired, overrideBatchIds })` returns per-batch splits (earliest expiry first; no expiry → by `received_at`; “no batch” bucket last; expired skipped unless overridden); `postAllocated(db, {..})` posts **one movement per batch** (idempotency key `<key>:<batchId>`), updates `batch_balances` in the same lock, and carries the batch’s cost when `cost_method = 'batch'`.
- `batches.js`: `receiveBatch` (called by `receiving.js` for tracked items: creates/extends the batch from the GRN line’s `batch_no`/`expiry_date`; mandatory-expiry items refuse a receipt without a date), production output creates a batch (expiry = completed_at + `shelf_life_hours`), transfers: dispatch allocates FEFO and **records the batch per line**, receipt creates the same batch (same id, same expiry) in the destination’s `batch_balances` (so traceability is continuous), returns/discrepancies carry the batch, wastage and adjustments allocate FEFO (or a chosen batch), counts correct the **bucket** the reviewer picks (default: no-batch/oldest), supplier returns take from the receipt’s batch.
- `reassign` wizard backend: move quantity from the no-batch bucket into a new batch with an expiry date (posts a zero-sum pair `reversal`-style `adjustment` movements with the same ref — approved by owner).
- Reconcile: extend `RECONCILE_SQL` with batch checks (Σ batch_balances ≤ on_hand per location/item; batch_balances = Σ movements per batch).
- Tests: **T-CTL-3 (ledger part)** FEFO across 3 batches (expiries 3, 5, 9 days): 12 units taken → 5 from batch A, 5 from B, 2 from C in expiry order; expired batch skipped; no-batch bucket last; replay posts once; transfers carry batches; reconciliation zero.

**P3-18 FEFO at serve (order triggers) and expiry blocking** · 4 d (the riskiest change in Phase 3 — it edits the DB functions every order passes through)
- Migration-free *function replacement* shipped inside `022` (or a `022b` file kept next to it) so one rehearsal covers it: `private.allocate_fefo(location, item, qty)` and updated `private.stock_on_serve()` that, for **tracked items**, writes one `pos_consumption` per batch with that batch’s cost (or the average when `cost_method` is average) and decrements `batch_balances`; for untracked items it behaves exactly as today. Same function names, same error codes (`stock_sold_out`), replay-safe through `order_stock_effects`.
- Availability: `stock_menu_availability` and the sold-out check count **sellable** quantity = on hand − expired batches not overridden (− holds), so an expired-only item shows as sold out (“Out of date — manager can override”); the waiter app’s existing override flow gains the batch override (D3-3).
- Compatibility drill: `inventory-v2.js`, `order-flow.spec.js` and the Phase 1 order tests run against the new functions; load test with 50 parallel serves on real Postgres (T-INV-7 shape, in P3-21).
- Tests: serve takes oldest batch first and records the batch on each movement; expired batch never sold unless overridden; untracked item unaffected; order cancel releases holds (no batch change); replay serve ×5 → one deduction; deal + extra expansion with a tracked ingredient; shared ingredient across two lines allocates once across batches.

**P3-19 Batch cost, expiry alerts, traceability, manager override** · 3 d
- `cost_method` setting accepts `batch` (owner, with the D3-1 confirmation text); consumption movements cost what the batch cost; valuation unaffected in structure (sums of signed `value`).
- Expiry alerts: scheduled check (same in-process scheduler as the reconciliation job, P3-31; until then a daily lazy check on dashboard read) creating `notify('expiring_soon')` (owners + branch managers; per batch dedupe, lead time from `expiry_alert_days`, per-category override) and `expired` (still holding stock).
- `traceability(batchId)` → receipts, movements by location, orders that consumed it (via movement `ref_type/ref_id`), wastage; `forward trace` (“Which branches received batch X?”) and `backward trace` (“Which batches went into order Y?”) as read APIs; CSV in P3-26.
- Override: `overrideBatch(batchId, { reason })` (branch manager for their location, owner anywhere) sets `override_until = now() + expired_override_hours`, audited, notifies owners.
- Routes owner/branch.
- Tests: batch costing hand calc (batch A 400/kg, batch B 450/kg → serving 3 kg from A then 2 kg from B costs 3×400 + 2×450), switching method applies going forward only, alerts once per batch, trace output for a transferred batch, override expires, override by another branch manager refused.

**P3-20 Screens: batches and expiry** · 3.5 d
- Items: **Expiry tracking** selector in plain words (“Don’t track”, “Track when known”, “Always ask for an expiry date”) and shelf life; Stock page gains **“By date”** view: each item expands into batches with expiry chips (green / “3 days left” / red “Out of date”); sort/filter “Expiring soon”, “Out of date”.
- Receive goods (Phase 2) enables its stored `batch` and `expiry date` fields for tracked items (mandatory ones required); production **Finish** shows the expiry it will assign; transfer receive shows batch numbers; wastage/adjust drawers pre-pick “oldest first” with an option to choose a batch.
- **Out of date** banner on branch Stock with “Use anyway” (override drawer with reason) and “Record as wastage” shortcut (prefilled reason “expired”).
- **Trace** page: enter a batch number, see where it went (list + map-less timeline), copy as CSV.
- Wizard “Add expiry dates to what you have” (assign no-batch stock to batches).
- Mocked Playwright `inventory-batches.spec.js`: expiry chips, override with reason, mandatory expiry blocks submit, trace list; phone width.

**P3-21 Release D: e2e, race on real Postgres, apply 021–022, merge** · 2 d
- Playwright e2e on a seeded database: receive tracked item with two batches → serve orders → oldest used → expire one → shows out of date → override → trace; production → output batch → dish uses it.
- **T-INV-7 on real Postgres** (local Docker): 50 parallel serves of a tracked item across 3 batches (no negative batch balance, Σ = on hand, reconciliation zero); 20 parallel production completions; two counters posting at once.
- Runbook: snapshot → **order functions are replaced in this release** → quiet window → apply 021, 022 (+ function replacement) → run `order-flow.spec.js` and `inventory-v2.js` against the live schema copy first → census → switch on for the test business → smoke → PR `dev` → `main`. Rollback: down files + restore of the 013 functions (kept as `022_functions.down.sql`).
- Design review of P3-15/P3-20 screens; update KB 01/04 (BAT, PRD, RCP statuses).

### M5 — Costing & reports → Release E

**P3-22 Migration 023 — reporting, governance and insight storage** · 3 d
- `023_inventory_reporting_governance.sql` + down (one migration for everything remaining so it is rehearsed once; later features simply start using tables that already exist):
  - `report_jobs` (business, requested_by, `report_key`, params jsonb, status `queued | running | done | failed | expired`, `storage_path`, `format` csv/pdf, `row_count`, `error`, created_at, started_at, finished_at, `locked_by`, `locked_until`); index for the poller.
  - `reconciliation_runs` (business, started_at, finished_at, `trigger` schedule/manual, `checked_pairs`, `differences` int, `detail` jsonb limited to 200 rows, status ok/diff).
  - `period_locks` (business, `locked_through` date, locked_by, locked_at, note, `reopened_by`, `reopened_at`, `reopen_reason`; one active lock per business).
  - `role_capabilities` (business, role, capability, granted bool; unique) and `approval_delegations` (business, from_user, to_user, `capabilities text[]`, `location_ids uuid[]`, starts_on, ends_on, reason, revoked_at).
  - `inventory_memberships` (business, user, role warehouse_manager/storekeeper, location_id, active) — used only by the optional P3-36.
  - `platform_inventory_defaults` (key, value jsonb, updated_by, updated_at): unit/pack presets, reason-code defaults, alert defaults. Readable only through the admin API.
  - Report-support indexes: `stock_movements (business_id, location_id, occurred_at)`, `(item_id, occurred_at)`, `orders (restaurant_id, served_at)` if missing (check on a copy of the shared database size first; `create index concurrently` is applied by hand in the runbook).
- AI insight tables (D3-16): `ai_insights` (business, branch_id null = business-wide, kind daily/ask, period, `facts` jsonb, `ai_text` jsonb null, `template_text`, status ok/rejected/off/limit, `usage_id` → `ai_usage`, created_at) and `ai_questions` (business, question key, params, insight id, asked_by); retained 90 days.
- Down: refuses when jobs/locks/delegations/runs/insights exist.
- Tests: rehearsal; compat green.

**P3-23 Valuation and cost service** · 2.5 d
- `backend/src/inventory/costing.js`: `valuation(db, scope, { asOf, locationIds, categoryId, groupBy: location|category|item })` = Σ signed `stock_movements.value` up to the end of `asOf` (Nairobi) — plus count of cost-less movements and the list of items with unknown cost (D3-8); `currentValue` fast path from `stock_balances × avg_cost`; `costHistory(item)` (avg cost over time from movements); `recipeCostChange(since)` input for P3-25.
- Permission `inv.cost.view`; branch managers see their own branch; operations manager sees assigned branches.
- Routes: `/api/owner/inventory/:biz/valuation`, branch `/api/inventory/valuation`.
- Tests: hand-calculated valuation on the golden dataset on three dates; the as-of valuation equals current `stock_balances × avg_cost` for “today” when costs are uniform (cross-check) and the difference is explained when not (documented rounding).

**P3-24 Theoretical vs actual usage and variance** · 4 d
- `backend/src/inventory/variance.js`: `usage(db, scope, { locationId, from, to })`:
  - theoretical per item = Σ `order_stock_lines` of orders served in `[from, to)` at the branch (recipe version snapshot, yield applied; extras and deal components included);
  - actual per item between the two posted counts bracketing the range (D3-9): `opening count + receipts + transfers in + production output − transfers out − production input − wastage − staff meals/complimentaries ± adjustments − closing count`;
  - variance qty, variance %, variance KES at average cost, tolerance flag, **explanation columns** (each component, so an owner can see where the gap sits), “Needs a count” list, link to the underlying ledger rows.
  - Ignores `count_correction` movements (they are the *result* of the count) but shows them as a column.
- Routes owner (any branch) and branch (own).
- Tests: **T-RPT-1** variance on the golden dataset equals the hand-calculated figure per ingredient (qty and KES); changing a recipe mid-period uses the version in force per order (T-POS-5 carry-over); wastage and staff meals reduce “unexplained” variance; no count → listed as “Needs a count”; production consumption counted as use of inputs.

**P3-25 Menu engineering and price-change impact** · 2.5 d
- `menu-engineering.js`: per dish and branch food cost %, margin KES, **popularity** (units sold in period from orders) and the classic four groups (Stars / Plowhorses / Puzzles / Dogs, shown as “Sell more of these”, “Check the cost”, “Promote these”, “Review these”) with the thresholds stated on screen; price-change impact list: ingredients whose average cost moved more than `price_change_alert_pct` (default 10 %) since a date → the dishes that use them (through sub-recipes), old vs new food cost %, flagged where food cost % crosses a target (`food_cost_target_pct`, default 35).
- Routes owner/branch.
- Tests: hand-calculated food cost % and quadrant placement on the golden dataset; sub-recipe roll-up; unknown cost shows “Unknown” not 0.

**P3-26 Report engine, catalogue, CSV and print layout** · 3.5 d
- `backend/src/inventory/reports.js`: registry of definitions `{ key, title, theme, description, params, columns, chart?, run(db, scope, params) → rows + totals }`. Catalogue (PRD §17.2 subset): **stock valuation, movement ledger, consumption, variance, wastage, expiry, procurement spend (central vs emergency), emergency compliance, supplier performance (on-time, price changes, rejected qty), stock turnover / days on hand**, plus **traceability**, **count results**, **self-approved records** (every approval flagged `self_approved`, D2-5), **emergency buys by item**, and **AI usage** (owner). Parameters: locations, categories, date range, item.
- CSV writer: streaming, UTF-8 BOM, KES 2 dp, quantities in a **chosen unit** (item display unit by default); totals row; header row names match the screen columns.
- **Print layout (Save as PDF):** a print stylesheet and `?print=1` view per report: title, filters line, table with repeating header, totals, page numbers via `@page`, generated-at in Africa/Nairobi, no sidebar/buttons; the “Save as PDF” button calls `window.print()` (the browser’s own PDF). No PDF dependency. A server PDF writer is optional ticket P3-39.
- `GET /api/owner/inventory/:biz/reports` (catalogue), `…/reports/:key?…` (JSON page for the screen), `…/reports/:key/export?format=csv` (synchronous when small). Branch routes `/api/inventory/reports…` return the branch’s own rows only.
- Tests: **T-RPT-2** (CSV totals equal the JSON totals for the same filters; the print view renders the same totals line, checked in the mocked Playwright spec), each report’s columns on the golden dataset, branch managers cannot request another branch, quantity in chosen unit converts exactly, BOM present.

**P3-27 Background report jobs** · 2.5 d
- `report-jobs.js`: `enqueue` (when range > 31 days or estimated rows > 50,000, or on request), in-process poller (every 5 s; `select … for update skip locked`; heartbeat via `locked_until`; reclaim stuck jobs after 10 min), runs the same registry, writes the file to bucket `inventory-reports` (private; documented in the runbook), `notify('report_ready')` with a link; signed download URL (5 min); expiry sweep after 30 days; one running job per business at a time (fairness).
- Tests: two workers never run one job twice, failure marks `failed` with a plain message and notifies, job for another business’s user refused, expired file not downloadable.

**P3-28 Screens: Reports catalogue, Variance, Food cost** · 5 d
- Owner sidebar group **Reports** → **Reports** (replaces the P2-36 placeholder; per 05): the **catalogue of every report** grouped by theme (Stock · Money · People & places · Safety) with a one-line description; click a report → filters bar → results as a table (collapses to cards on phones) with an optional chart where defined, totals row, **Download CSV** and **Save as PDF** (print layout, P3-26); branch managers get the same page limited to their own branch’s reports; long ranges show “Preparing your report — we’ll tell you when it’s ready” and appear under **My downloads**.
- **Variance** page (owner and branch “Food cost & variance” under Analytics per 05): by branch/period, rows with colour from tolerance, expand a row to see where the gap comes from, “Needs a count” list, link to start a count.
- **Food cost** page: menu engineering quadrants as a simple grid with plain labels; price-change impact list (“Cooking oil +18 % → 6 dishes cost more”).
- Mocked Playwright `inventory-reports.spec.js`: pick report, filters, export click (download triggered), Save as PDF calls print, long range shows the background message, variance row expands; phone width.

**P3-29 Dashboards: tiles and drill-down** · 3 d
- `dashboard.js` API (cached 60 s with `lib/cache.js`, per user and location): owner tiles — **Inventory value**, **Low and out**, **Expiring soon**, **Waiting for your approval**, **In transit**, **Emergency spend this week vs last**, **Variance alerts**, **Reconciliation** (green/red, from P3-31 once live; hidden until then); branch tiles — **Stock value**, **Low and out**, **Expiring**, **Counts due**, **Deliveries coming**, **Open exceptions**, **Today’s wastage**. Every tile returns the number and a `drill` link (e.g. `/owner/inventory/history?reason=wastage&from=…`, `/owner/reports/expiry`).
- Overview page integration (existing briefing component; tiles in a `Panel` row); empty states per tile; skeleton while loading; **drill-down** pages accept the filters in the query string (Stock “low”, History by reason, Reports with prefilled filters, Approvals).
- Mocked Playwright `inventory-dashboard.spec.js`: tiles render, click goes to the filtered page; phone width.

**P3-30 Release E: e2e, design review, apply 023, merge** · 2.5 d
- Playwright e2e on seeded data: run valuation and variance, CSV download totals equal screen, a long range becomes a background job and finishes.
- Design review of Reports, Variance, Food cost, Dashboards (with `11-design-review.md`), fixes.
- Runbook: snapshot → create Storage bucket `inventory-reports` (private; 25 MB; csv/pdf) → apply `023` (+ indexes `concurrently` by hand if the snapshot shows large tables) → census → smoke → PR `dev` → `main`. Rollback: down file (refuses with jobs/locks/delegations).
- Update KB 01/04 (CST, RPT, AUD statuses).

### M5b — AI insights → Release G

Depends on P2-32 (gateway, metering, limits) and on the reports it explains: P3-23 (valuation/cost), P3-24 (variance), P3-25 (menu engineering), P3-26 (report registry) and the Phase 2 purchasing/emergency data. Design: `12-ai-insights.md`.

**P3-40 Fact builders (deterministic, no AI)** · 4 d
- `backend/src/ai/facts.js`: functions returning small typed JSON per scope (business or one branch) and period — **branch profitability** (sales from served orders, food cost = served consumption at average cost, **gross profit after food cost**, food cost %, rank, vs previous period; always `excludes: [rent, salaries, utilities]` unless expenses exist), **loss-making branch** (week/month), **dish food-cost spikes** (with the ingredient that moved most, from P3-25), **wastage** (value, top items, unusual flag), **purchases and emergency spend** (central vs emergency, items bought in an emergency repeatedly, supplier price moves), **variance hotspots** (P3-24), **reorder suggestions** (P2-07). Each carries `period`, `generated_at`, `data_quality` notes (costless movements, items without a count) and a `template` sentence generator for the deterministic fallback.
- Reuses the Phase 3 services, no new maths; a **privacy allow-list** of keys per fact set and a `scrub()` that throws if any value looks like a phone, email or a person's name from a staff/customer table.
- Tests: figures equal the golden-dataset hand calculations (profit after food cost for two branches, a loss-making week); branch scope contains no other branch; **no personal data in the payload** (golden data seeded with names/phones/emails in free-text fields); data-quality notes appear when costs are missing.

**P3-41 Insight generation, validator, daily job** · 4 d
- `backend/src/ai/insights.js` + `validate.js`: build facts → store the **template** insight → call `gateway.call({ feature: 'daily_insight' })` with the strict system prompt (cite given figures only, no new numbers, no invented causes) → **number validator** (every number in title/text/summary/figures must match a fact value at its display precision, dates exempt) → drop failing findings, reject the answer when more than half fail → store `ai_insights`. Statuses `ok | rejected | off | limit`; the UI shows the template whenever the AI text is unavailable.
- Daily job on the single scheduler (P3-31): per business with AI enabled and inside its allowance, at the configured time (default 06:00 Nairobi), one run for the business and one per branch; skips the call when facts equal the last run (cache); never exceeds the limit; failures logged to `ai_usage` and retried next day.
- Tests (**stubbed fetch**): validator accepts exact and rounded figures, rejects invented ones (`+3%`, a total the model computed, a wrong branch figure), adversarial answers (numbers in words, `1.2m` vs `1,200,000`), rejection falls back to template, limit reached → status `limit`, unchanged facts → cached (no usage), usage rows match calls, job runs once under two instances.

**P3-42 “Ask about my numbers” (limited questions)** · 2.5 d
- `ai/ask.js`: a fixed catalogue of ~10 questions (“Which branch made the most gross profit last month?”, “Which dishes got more expensive to make?”, “Where did we lose stock this week?”, “What did we buy in an emergency?”, “What should I order?”), each mapped to a fact builder plus an optional period/branch; free text is out of scope (Q-AI-5). Per-user limit (20/day) on top of the allowance; branch managers' questions are built from their branch only; answers stored in `ai_insights` (kind `ask`) and `ai_questions`.
- Routes owner `/api/owner/inventory/:biz/insights/ask`, branch `/api/inventory/insights/ask`.
- Tests: each question returns template + validated text on stub; unknown question 400; branch manager cannot request another branch; daily cap; allowance message at the limit.

**P3-43 Screens: Overview insights, Reports → Insights, usage meter** · 3.5 d
- Owner Overview: the existing **briefing** gains an Insights block (top 3 findings of today, dated, “Numbers computed by Cravio”, link to the report behind each); branch Overview shows the branch’s own. **Reports → Insights**: history by date, filters (branch, severity), **Ask about my numbers** picker, and the **AI usage this month** meter with the reset date and the 80 %/100 % states (“Your AI allowance for this month is used up. It resets on 1 December.”). AI-off state: template findings with “Switch on AI summaries in Settings”.
- Plain words and DESIGN.md components; “profit” always written as “gross profit after food cost” with the “doesn’t include rent or salaries” note.
- Mocked Playwright `inventory-insights.spec.js`: findings render, link opens the report, ask a question, limit message, AI-off state, branch scope; phone width.

**P3-44 AI e2e, privacy audit and cost soak, Release G** · 1.5 d
- Playwright e2e on seeded data with a stubbed provider: admin sets allowance → daily job → owner sees insight → asks a question → reaches the limit → message.
- **Privacy audit:** capture every outbound payload in a full run and assert it passes the allow-list and no name/phone/email patterns (written into the PR); one reviewed sample prompt per feature saved in the docs.
- **Cost soak on the pilot business** (real model, small allowance): record real tokens and KES per day for a week to propose the default allowance (Q-AI-3); compare `ai_usage` with OpenRouter’s activity page.
- Runbook: no migration (tables are in 023 and 014); switch AI on for the pilot business only; PR `dev` → `main`. Update KB 01/04, `12-ai-insights.md` statuses.

### M6 — Governance → Release F

**P3-31 Reconciliation job, alert and manual report** · 2 d
- `reconcile-job.js`: in-process scheduler (hourly, `pg_try_advisory_lock` so only one API instance runs it) runs `RECONCILE_SQL` + reserved + batch checks per business with inventory enabled, writes `reconciliation_runs`, `notify('reconciliation_failed')` to owners on any difference (dedupe per run), exposes the status for the Overview tile; **manual “Run now”** (owner) returns the difference list with the movements involved (LED-5); never auto-fixes.
- The same scheduler hosts the expiry check (P3-19) and the report sweeper (P3-27) so there is one timer.
- Tests: injected drift (update a balance by hand in a test) is detected and alerted once; clean data → ok; two instances → one run.

**P3-32 Period close and lock** · 2.5 d
- `periods.js`: `closeChecklist(asOf)` (open counts, pending approvals, open discrepancies, unposted production, unreconciled differences), `close(db, scope, { throughDate, acknowledge:[…] })`, `reopen(reason)`; `ledger.post()` refuses a movement whose `occurredAt` falls on or before `locked_through` with `409 period_locked` (reversals and corrections must be dated in the open period); `once()` commands dated inside a lock are refused with a plain message.
- Reports and valuation show “Period closed through 31 Oct”; as-of valuations inside a closed period are stable (they already are: movements are append-only).
- Routes owner; tests: movement dated in a closed month refused, reversal in a closed month posts in the open one with the reference, checklist lists blockers, reopen audited, concurrent post during close is serialised (advisory lock).

**P3-33 Role capabilities and approval delegation (backend)** · 2.5 d
- `permissions.js`: `inventoryScope` merges `role_capabilities` overrides over `ROLE_DEFAULTS` (guardrails in D3-12 enforced on write and on read), merges active `approval_delegations` (date range, capabilities, optional locations; the delegate sees the approvals in their inbox with “on behalf of Wanjiru”); every decision by a delegate records `delegated_from` on the `approvals` row.
- Routes owner (`inv.settings.edit`): list roles + effective capabilities (with plain-words labels per capability), edit, delegations CRUD.
- Tests: removing `inv.recipe.edit` from branch managers works and is enforced server-side, guardrails refuse owner lock-out, delegation outside dates refused, maker-checker still applies to delegates (delegate ≠ requester), a delegate cannot widen scope, audit rows.

**P3-34 Screen: Roles & delegation** · 2 d
- Owner Settings → **Roles & access (inventory)**: role cards with capability switches in plain words (“Can approve wastage”, “Can see costs”), a “Reset to default” action, **Delegate while I’m away** drawer (person, what, which branches, from/to dates), active delegations list with revoke; guardrail messages inline.
- Mocked Playwright: toggle a capability, create a delegation; phone width.

**P3-35 Admin defaults (units/pack presets, reason codes)** · 2.5 d
- `backend/src/routes/inventory-admin.js` (new route module — `server-load.test.js` must stay green): admin-only CRUD on `platform_inventory_defaults` (pack presets: tray 30, crate 24, sack 90 kg…; reason-code defaults; default alert levels/limits; default units list), audited in `access_events` style; **no stock endpoints for admins**.
- Services copy defaults into a new business on first inventory use (units/packs offered as suggestions in the item editor, reason codes seeded into `stock_reason_codes`, limits into `approval_rules`).
- Admin screen **Configuration → Units & defaults** (05 navigation proposal) with the same components as Businesses; counts only.
- Mocked Playwright: add a pack preset, edit a reason-code default.

**P3-36 (optional) Warehouse staff role** · 4.5 d
- Backend: `inventory_memberships` management by the owner (invite existing user by email as warehouse manager or storekeeper for the Warehouse), `inventoryScope` gives them Warehouse-only capabilities (manager: pick, dispatch, receive goods, counts, wastage at the Warehouse; storekeeper: the same without approvals); owner-area route guard accepts them for `/api/owner/inventory/:biz/*` endpoints **filtered to their locations**; they never see other locations, costs (unless allowed), suppliers’ bank data or the Approvals inbox.
- Frontend: a limited owner-area sidebar for them (Stock, Requests & transfers (fulfil only), Receive goods, Counts); `dashboards.js` entries get an optional `requires: capability`.
- Tests: T-SEC-1 shape (403 on any branch), storekeeper cannot approve, `business_members` untouched (compat green), mocked Playwright for the limited sidebar.

**P3-39 (optional) Server-side PDF and emailed/scheduled reports** · 3 d
- Only if the owner asks for reports **emailed or on a schedule** (the browser’s Save as PDF cannot do that): `pdfkit` (pure JS, new dependency, confirm first) tabular layout helper used by the background job (P3-27) to produce PDFs for the key reports; schedule table and email delivery are a further ticket. Not counted in the 115 days.
- Tests: PDF totals line equals the JSON totals (text extraction).

**P3-37 Pilot soak, performance and real-Postgres pass** · 2 d (+ 7 calendar days of soak)
- Seed 100,000 movements over a quarter and check the performance budget (reports first page < 3 s or background, dashboard < 500 ms cached); fix indexes if not.
- Real Postgres (Docker): concurrency drills carried over from P3-21 plus 10 parallel count posts and period close under load; **T-INV-6/7** re-run with all migrations.
- Switch the reconciliation job on for the pilot business; **7 consecutive green days** are the exit criterion; log results in the PR.

**P3-38 Release F: merge governance, close the phase** · 1 d
- PR `dev` → `main` (no migration: 023 already applied in Release E); KB 01/04/07 statuses updated; remove the Phase 1/2 compatibility shims that are no longer needed (old `waste` free-text reason route alias, etc.) only if the pilot business and `main` no longer call them; write the “what’s next” list (multi-warehouse, M-Pesa, eTIMS, offline, recall workflow).

---

## Cases Phase 3 must handle

(07 WP3.7 plus the additions marked **new**.)

| Case | Expected | Ticket / test |
| --- | --- | --- |
| Wastage above threshold | Separate ledger type, approval, cost recorded | P3-04 · T-CTL-1 |
| **new** Wastage of a dish (not an ingredient) | Expands through the recipe version in force; each ingredient posted; yield applied | P3-04 |
| **new** Requester approves own wastage / adjustment / count while another approver exists | Refused (maker ≠ checker) | P3-04/05/08 · T-SEC-2 family |
| **new** Stock gain adjustment | Always needs approval | P3-05 |
| **new** Staff meals over the day’s allowance | Routed to approval; remaining allowance shown | P3-05 |
| **new** Unusual wastage (more than the owner-set factor, default 2×, of the 4-week average) | One alert per item per week to owner and branch manager | P3-04 |
| **new** Wastage before the owner has set any limit | Recorded at once, no approval; after a limit is set, above it needs approval | P3-04 · D3-4 |
| **new** Sole owner approves their own wastage/adjustment/count | Allowed only when no other approver exists; flagged `self_approved`; in the Self-approved report | P3-04/05/08 · D2-5 |
| Count variance beyond the owner’s limit (any variance, until a limit is set) | Review + approval before posting | P3-08 · T-CTL-2 |
| Sales during a count | Movements since snapshot included; fair variance (sold 20 during the count → correction is only the unexplained part) | P3-08 |
| Blind count | Counters never see expected qty (not in the response) | P3-08/09 |
| Two counters disagree | Both entries kept; reviewer recounts or chooses | P3-08 |
| **new** Counter is the only approver available | Owner (not a counter) approves; if the owner is the counter and the only approver, allowed and flagged `self_approved` | P3-08 |
| **new** Count of an item with stock reserved for a request | Reservation untouched; on-hand counted | P3-08 |
| **new** Opening balances vs counts | A count is never an opening (CNT-5) | P3-08 |
| FEFO across 3 batches | Earliest expiry first; expired blocked | P3-17/18 · T-CTL-3 |
| **new** Serve an order for a tracked item | Oldest batch used, batch on each consumption row, cost of that batch when batch costing is on | P3-18/19 |
| **new** Only expired stock left | Shows out of date; manager override with reason (24 h), audited, owner notified | P3-18/19 |
| **new** Stock existing before an item became tracked | “No batch” bucket used last; wizard assigns batches | P3-16/17/20 |
| **new** Transfer of a tracked item | Batch and expiry follow it to the destination; trace works both ways | P3-17/19 |
| **new** Batch cost vs average cost | Switch applies going forward; history not re-costed | P3-19 |
| Prep batch yields less than planned | Variance recorded; output cost higher per unit | P3-14 |
| Recipe cycle (A uses B uses A) | Refused on save (service) and by the database | P3-12/13 |
| **new** Production reversed after the output was used | Refused with what was used | P3-14 |
| **new** Dish with a prepared ingredient served | Prepared item deducted as stock; no re-expansion | P3-13/18 |
| Variance report on seeded data | Matches hand calculation | P3-24 · T-RPT-1 |
| **new** No second count in the range | Item listed under “Needs a count”, not guessed | P3-24 |
| **new** Recipe edited mid-period | Each order uses its own version; variance uses the snapshots | P3-24 |
| **new** Movement without a cost in a valuation | Counted and shown; never silently 0 | P3-23 |
| CSV export / Save as PDF print layout | Totals match screen; print view has filters, generated-at and totals | P3-26 · T-RPT-2 |
| **new** Reports catalogue | Every report listed once; open, filter, table/chart, CSV, Save as PDF; branch manager sees only own branch | P3-26/28 |
| **new** Self-approved records report | Lists every approval flagged `self_approved` with who, what, when | P3-26 |
| **new** AI insight with a number not in the facts | Finding dropped; answer rejected if too many; template shown instead | P3-41 |
| **new** AI at the monthly limit | Plain message with reset date; stored insights still visible | P3-41/43 |
| **new** Branch manager asks about numbers | Payload contains only their branch | P3-40/42 |
| **new** Report over a 6-month range | Runs as a background job; notification and download link | P3-27 |
| **new** Report file link after 30 days or by another business | Refused | P3-27 |
| **new** Hourly reconciliation finds a difference | Owner alert, tile turns red, “Run now” explains the movements | P3-31 |
| **new** Movement dated in a closed period | Refused; correction posts in the open period with a reference | P3-32 |
| **new** Owner removes a capability from branch managers | Enforced server-side at once; guardrails stop owner lock-out | P3-33 |
| **new** Approval delegated while the owner is away | Delegate can approve inside the dates/locations; shown as on behalf of | P3-33 |
| **new** Platform admin | Edits defaults and sees counts only; no stock endpoints | P3-35 |
| Anything above, replayed | One effect (`once()` + idempotency keys) | all |

## Exit criteria for Phase 3

**T-CTL-1..3, T-RPT-1..2** automated and green; AI: metering exactness, limit enforcement, number validator and no-PII payload tests green, stubbed fetch only; **T-INV-6/7 on real Postgres** with all migrations (including FEFO serves); T-SEC-1/2/3 re-run on every new endpoint; reconciliation job green for **7 consecutive days on the pilot business**; `inventory-v2.js` and `order-flow.spec.js` green against the FEFO trigger functions; design reviews done at each release; KB 01/04/07 statuses updated.

## First week, day by day

| Day | Work |
| --- | --- |
| 1 | P3-01 decisions + **spike 1 (FEFO in the serve trigger)** |
| 2 | Spikes 2–3 · start P3-02 (harness, golden dataset with hand-computed numbers) |
| 3 | P3-02 done · P3-03 migration 019 draft |
| 4 | P3-03 rehearsal + compat · start P3-04 reason codes |
| 5 | P3-04 wastage service + tests (T-CTL-1) |

## Risks to watch in Phase 3

| Risk | Mitigation |
| --- | --- |
| FEFO in the serve trigger breaks live orders on the shared database | Spike on day 1; same function names/error codes; `inventory-v2.js` + `order-flow.spec.js` against the new functions; quiet window + snapshot; function down-file kept; batch allocation only for tracked items so untracked items run the old code path |
| Batch balances drift from on-hand | Only the ledger writes `batch_balances`; reconciliation checks it hourly; real-Postgres race test |
| Count variance maths trusted too early | Hand-calculated test with sales mid-count; blind sheet never carries expected; approvals required beyond tolerance |
| Variance report disagrees with owners’ intuition | Explanation columns on every row; “Needs a count” instead of guesses; hand-calculated golden dataset; start with one pilot branch |
| Valuation with missing costs looks wrong | Cost-less movements counted and shown on every valuation; opening-stock import already asks for cost |
| Reports slow on large ledgers | Indexes in 023; background jobs for big ranges; performance budget checked in P3-37 |
| Bucket misconfiguration (reports) | Bucket private by runbook, tested. No PDF dependency (print-to-PDF); `pdfkit` only in optional P3-39 |
| AI cost, hallucinated figures, privacy | See `12-ai-insights.md` §5; validator, deterministic fallback, hard limit, payload privacy tests |
| Approval fatigue, or no approvals at all, because the owner never sets thresholds | Safe defaults chosen to be quiet (D2-16: wastage free, one approval per count, adjustments approved); limits editable in Settings → Inventory with a “Set your limits” prompt; delegation (P3-33); inbox groups by kind; revisit after the pilot |
| Capability editing locks the owner out | Guardrails on write and read; tests; “Reset to default” always available to the owner |
| Warehouse role touches `business_members` which `main` reads | Separate `inventory_memberships` table; compat tests; ticket is optional |
| Scope creep into recall workflow / forecasting / multi-warehouse | Explicitly listed under “not in Phase 3”; traceability lists only |
| 115 days is a long time without a user in the loop | Five releases, each usable on its own; pilot business switched on from Release C; change requests triaged at each release, not mid-ticket |

## Open questions (proposed defaults are in place; answer when convenient)

- ~~**Q3-1** Approval thresholds~~ **Answered 18 Nov: owner-configured, no built-in numbers (D2-16, D3-4, D3-5).** Still open: after the pilot, do owners want Cravio to suggest starting values from their first weeks of data?
- **Q3-2** Staff meal and complimentary allowances: per day portions or KES, and which role may give complimentaries? (D3-6; defaults off until set)
- ~~**Q3-3** `pdfkit`?~~ **Answered 18 Nov: browser Save as PDF first; a server PDF library only if emailed or scheduled reports are needed (optional P3-39).**
- **Q3-4** Which items should carry expiry tracking first (dairy, chicken, sauces)? Mandatory for any? (D3-2)
- **Q3-5** Should batch costing be offered at all in this release, or stay weighted average only until the pilot asks? (D3-1)
- **Q3-6** Pilot business and branch for the 7-day reconciliation soak and the first real counts. (06 Q-T1)
- **Q3-7** Is the warehouse-staff role needed before go-live? (optional P3-36)
- **Q-R3** Should the Receipts tab also include **customer bills / sale receipts**? (default no: that belongs to the later POS/eTIMS module; Receipts holds supplier and stock documents.)
- **Q-AI-1…6** AI: who pays, which model, default monthly allowance, daily run time, free-text questions, DPA sign-off — see `12-ai-insights.md` §6.
