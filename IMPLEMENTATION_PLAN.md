# Cravio: inventory, management and AI implementation plan

Status: implementation in progress. A first owner-scoped inventory/management preview is available on dev; the full roadmap is not complete. See [preview scope and verification](docs/INVENTORY-PREVIEW.md).

Prepared 14 November 2026. Read alongside [question.md](question.md), the Fayaz discovery questionnaire.

## 1. Confirmed instructions and boundaries

- Preserve the current system on `main`. Implement future features on `dev`, after approval of this plan.
- This delivery includes this plan, the Fayaz questionnaire and a working comparison environment. It does not implement the new product features.
- Both branches retain Cravio's existing design, components, typography and navigation conventions. Differences should be capabilities, not a redesign.
- Run the branches in separate checkouts, on adjacent frontend ports, with separate backend processes.
- Latest environment decision: use the same existing database for this baseline comparison. This supersedes the earlier Docker/test-database request. Do not migrate, seed or run mutation tests against it for this work. Record edits made through either application are shared.
- Before inventory migrations or mutation tests begin, establish an isolated development environment. The current shared-data comparison is not an isolated feature-testing environment.
- Initially work alongside restaurants' existing POS systems. Replacing their POS is a later, separately scoped milestone.
- Fayaz's first inventory scope is finished cakes/pastries and branch stock. Ingredients, recipes and production costing are later work.
- AI provider: OpenRouter. Use a clearly labelled placeholder initially; do not make paid API calls or pretend placeholder output is generated analysis.
- Do not invent Fayaz's SOPs, product units, POS capabilities, approval rules, scale, budget or delivery dates. Open decisions below must be answered before dependent implementation.

## 2. Verified starting point

At inspection, `origin/main` was `5b5879e7e56a70f06ce0d6eef492c09c5ae62752`, the merge of PR #1. `origin/dev` was `9842725`, already an ancestor of main. Their file trees were identical. Local dev was fast-forwarded to main; no additional feature merge into main was needed.

| Area | Existing implementation | Consequence for the plan |
| --- | --- | --- |
| Stack | React/Vite frontend, Node HTTP API, Supabase Auth/Postgres/Storage | Extend the current application; no framework rewrite is proposed. |
| Restaurant ownership | `backend/db/migrations/002_restaurants.sql` enforces one restaurant per owner | Introduce business/location structure before multi-branch stock. |
| Membership | `backend/src/lib/restaurants.js` chooses one primary membership | Add explicit authorized location selection; do not infer the active branch from the first membership. |
| Permissions | Owner/manager/waiter membership plus platform admins; some APIs use a service client after access checks | New organization, location and module permissions must be checked in both APIs and database policies. |
| Menu | Products, availability, extras, pairings, deals, media and design studio | Reuse the catalogue UI patterns. A menu item and a stock SKU must be linked explicitly, not assumed to be identical. |
| Orders | Confirmed → served → paid, with cancellation rules | Kitchen preparation is a separate proposed workflow. Preserve waiter confirmation. |
| Payments | `backend/src/routes/operations.js` records a manual succeeded payment | Label manual vs provider-verified records. Existing records do not prove bank settlement. |
| Analytics | Sales, orders, views, busy hours and dish reporting | Build trusted reporting functions before AI narration. Units ordered / views is not visitor conversion. |
| Inventory | Manual sold-out status, no stock-movement ledger | Introduce auditable stock movements and quantity balances. |
| Tests | Playwright suites use configured Supabase and include writes, seeding and Auth administration | Run mutation tests only against isolated test data. |
| Migrations | `backend/scripts/migrate.js` applies three-digit SQL migrations and records `private.schema_migrations` | Preserve the existing migration history; do not introduce a competing migration runner silently. |
| Local setup | Existing DB clients expect hosted TLS; Vite and Playwright assume fixed ports | Use separate app/backend ports now. Plan test-target configuration and local DB support when isolated development is approved. |

Code references: [order flow](docs/ORDER-FLOW.md), [API contract](docs/API.md), [membership helpers](backend/src/lib/restaurants.js), [authorization](backend/src/lib/auth.js), [frontend cache](frontend/src/lib/cache.js).

## 3. Product structure and scope register

Proposed product structure: one Cravio business account, multiple locations, optional Service and Inventory modules. Inventory-only onboarding must work without creating dining tables, a guest menu or restaurant service orders. Package names, prices and commercial entitlements remain product decisions.

| ID | Capability | Proposed delivery | Dependencies |
| --- | --- | --- | --- |
| F01 | Businesses, locations, memberships and module access | Foundation | D01, D04 |
| F02 | Shared stock catalogue, units, batches and opening balances | Finished-goods pilot | D02, D03 |
| F03 | Production output, dispatch, transit, receiving and discrepancy resolution | Finished-goods pilot | F02; D04, D05 |
| F04 | Sales deductions, returns, waste, counts and stock history | Finished-goods pilot | F03; D06–D08 |
| F05 | HQ dashboard, branch stock, low-stock rules and replenishment requests | Finished-goods pilot | F04; agreed thresholds |
| F06 | POS adapter framework and one real customer connector or import path | Pilot integration | Vendor evidence, credentials/sandbox, F02 |
| F07 | POS order delivery and payment-status reconciliation | Service integration | F06; checkout authority agreed |
| F08 | Kitchen/bar preparation and waiter pickup | Service management | D09; F07 when POS owns kitchen routing |
| F09 | Table assignment, service escalation and handovers | Service management | Location permissions and SOPs |
| F10 | Opening/closing checklists | Service management | Named tasks, recurrence and supervisors |
| F11 | Required modifiers, timed menus, dietary/allergen fields, translations | Menu management | D02, D09; approved product information |
| F12 | Daily close and exception reconciliation | Pilot/service management | Sales coverage and F04/F07 |
| F13 | Owner briefing and question answering | AI phase 1 | Trusted metrics, scope control, OpenRouter configuration |
| F14 | Photo/PDF menu import and editing drafts | AI phase 1 | Private uploads, review/approval UI |
| F15 | Menu-performance suggestions | AI phase 2 | F13; evidence and experiment measurement |
| F16 | Ingredients, purchasing, suppliers, recipes and costing | Later expansion | Separate Fayaz discovery; stock ledger proven |
| F17 | Supplier invoice extraction | Later AI | F16; units/vendor matching and human review |
| F18 | Prep, allocation and purchasing forecasts | Later AI | Sufficient complete historical data and validation |
| F19 | Restaurant subscriptions, module billing and integration-health monitoring | Platform operations | Commercial decisions; monitoring begins with F06 |
| F20 | POS replacement: checkout, split bills, partial payments, refunds, cash shifts, receipts, offline operation, eTIMS | Separate future release | Payment/hardware/tax requirements; migration and recovery rehearsals |
| F21 | Reservations, loyalty, delivery channels and staff scheduling | Discovery backlog | Demand demonstrated; not implicit pilot scope |

Fayaz's confirmed finished-goods priority takes precedence over earlier suggestions to begin with ingredient costing. F08–F15 can follow the shared foundation without making Fayaz adopt restaurant service.

## 4. Decisions that must not be guessed

Question IDs refer to [question.md](question.md). Proposed technical defaults are reviewable proposals, not claims about Fayaz.

| ID | Decision / missing evidence | Owner | Blocks | Meeting questions |
| --- | --- | --- | --- | --- |
| D01 | Locations, legal ownership, central kitchen structure and pilot sites | Fayaz | Account/location model and rollout | Q01–Q06 |
| D02 | Product IDs, variants, trays/pieces, whole cakes/slices, bundles and conversions | Fayaz | Stock catalogue and sales mapping | Q07–Q12 |
| D03 | Batch labels, shelf life, opening-stock source and traceability expectations | Fayaz | Output/stock import and expiry | Q13–Q17, Q39 |
| D04 | Who records, checks, approves, edits and sees each action | Fayaz | Roles and approval paths | Q18, Q24, Q40–Q43 |
| D05 | Partial deliveries, shortages, damaged receipt, returns and proof of handover | Fayaz | Transfer state machine | Q19–Q25 |
| D06 | POS vendor/version, export samples, API access, identifiers and update frequency | Fayaz + POS vendor | Reliable sales deductions and live connector | Q26–Q33 |
| D07 | Sales deduction event, refunds, cancellations, custom orders and saleable returns | Fayaz | Stock correctness | Q29–Q35 |
| D08 | Count procedure, concurrent sales, backdating, variance approvals and period close | Fayaz | Count/close workflow | Q36–Q43 |
| D09 | Kitchen routing, service procedures, menu choices and existing devices | Fayaz / other pilot restaurants | Service-management work | Q44–Q49 |
| D10 | Offline needs, devices, printers, connectivity and acceptable delays | Fayaz | Pilot operating model | Q50–Q53 |
| D11 | AI model(s), spend cap, retention, permitted data and evaluation acceptance | Product owner + Fayaz | Real OpenRouter calls | Q54–Q57 |
| D12 | Pilot acceptance thresholds, training, migration, support and cutover ownership | Product owner + Fayaz | Launch and rollout | Q58–Q63 |
| D13 | Package names, billing basis, pricing, trial rules and support commitments | Product owner | Commercial billing | Q62–Q63 inform, but do not decide |

Confirmed current environment decision: shared existing database, separate code/processes. Docker isolation was proposed and then deferred by the user. Before P1 database changes, confirm the isolated feature-testing environment. Confirmed AI provider: OpenRouter; API key/model/budget remain unset. Do not substitute another provider if OpenRouter is unavailable.

## 5. Branches and side-by-side comparison

- `main`: unchanged application baseline at the verified merge commit, in `/home/jjibrah/confidential/cravio-main-baseline`.
- `dev`: this working directory, `/home/jjibrah/confidential/cravio`; planning/setup changes now and approved features later.
- Intended frontend addresses: main `http://localhost:5173`, dev `http://localhost:5174`.
- Intended backend addresses: main `http://localhost:3003`, dev `http://localhost:3004`.
- Both branches use the existing Supabase project, Auth users and Storage for this approved baseline comparison. The launcher verifies that each frontend matches its own backend's Supabase target and requires explicit shared-database mode when both targets match.
- Before implementing data/schema-changing features, give dev an isolated Supabase environment and test accounts. Update both its backend and frontend together; test/migration clients must also target dev. A different port alone does not protect main data.
- Ports must be strict: fail with an actionable message rather than silently choosing another port. Check process ownership before stopping a listener.
- Keep secrets in ignored files. Do not put service credentials into Vite variables, source files, logs or this plan.
- Auth recovery/invite callbacks must target the matching frontend. Existing hosted redirect settings were not modified by this setup; verify that the dev origin is allowed before testing those flows. No invitations or recovery emails are sent during this task.
- Existing baseline and dev use the same design. New features later reuse current sidebar, sheets, tables, notifications, forms and mobile patterns. No new visual identity.
- The original planning task started both apps with identical capabilities. Dev now includes the first inventory/management preview described in `docs/INVENTORY-PREVIEW.md`; main retains its previous feature set.

### Approval and promotion workflow

1. Build and validate the agreed work on `dev`; keep `main` on port 5173 unchanged.
2. Report the dev commit, completed features, test evidence and known limitations, and ask the user to review `http://localhost:5174`.
3. Apply requested fixes on dev and repeat the relevant validation. A preview is not approval to merge.
4. Once the user explicitly approves that release, update dev with any intervening main changes, resolve conflicts and verify the final merged candidate. Show material changes for review again.
5. Back up main data and rehearse the exact migrations. Promote code plus versioned migrations; never copy test users, demo orders or the development database over main data.
6. Merge the approved release into main, push the authorized branch updates, apply the approved migrations to main's database, restart its application on 5173 and run release smoke checks.
7. Keep dev on 5174 for the next development cycle. Database rollback requires a rehearsed recovery plan; reversing a Git merge alone does not reverse posted business data.

Ports are process addresses, not branches. Separate checkouts prevent dev edits from changing the files served by main. Git promotion changes the code main runs; restarting/redeploying activates it.

### Comparison acceptance

1. Both frontends return successfully on the agreed adjacent ports; both backend health checks pass.
2. Each frontend reaches its own backend; both intentionally resolve to the same existing Supabase project in this baseline-only configuration.
3. Do not create/change records or run mutation suites to validate the shared configuration. Use read-only HTTP/proxy/configuration checks. Once isolated dev is introduced, add a cross-environment write-isolation test before feature development.
4. Both versions serve the same existing application code. New features remain absent until implementation. Authenticated user journeys must be verified separately against isolated fixtures before a feature release.
5. Record branch SHAs, commands, test credentials location, and how to stop/restart the stacks in the setup runbook.
6. After introducing isolated dev, compare matched synthetic fixtures for feature demonstrations. Do not attribute differences in independently seeded data to product functionality.

## 6. Proposed architecture

### 6.1 Extend the existing application

Keep the React application and Node API. Add domain modules inside the repository; separate services are not required for the pilot. Background imports, connector retries and AI requests need durable job records so API restarts do not lose work.

Proposed domain records (final names and migrations are implementation work):

- Business, location, business membership, location grant and enabled module.
- Inventory product/SKU, unit/conversion, menu-to-SKU mapping and POS-to-SKU mapping.
- Batch, stock account/status, movement, balance projection, output entry and opening-balance session.
- Transfer, transfer line, shipment, receipt and discrepancy resolution.
- Waste/return record, count session, counted line and approved adjustment.
- Connector configuration, imported event, import job, outbox task and reconciliation exception.
- Checklist template/run, shift handover and kitchen ticket where those modules are enabled.
- AI request/run, evidence reference, draft/proposal, approval and usage record.

Every inventory record belongs to a business; location-bound records also identify the location. Cross-business movement is not a pilot transfer. Confirm whether any Fayaz outlets are separate legal businesses before modelling transfers as internal movement.

### 6.2 Compatibility and migration

1. Add the business/location structures without deleting existing restaurant records.
2. Backfill each existing restaurant to its own business and service location. Preserve existing restaurant IDs, public QR links, users, orders, menu media and historical totals.
3. Link service restaurants to locations; a production-only location need not have a service restaurant.
4. Replace implicit primary-membership selection with explicit validated business/location context. Existing single-location users retain their current landing route.
5. Scope browser caches, server caches, polling, notifications and saved filters by user + business + location. Cancel pending requests on a scope switch so stale responses cannot render another branch's data.
6. Update RLS and Storage policies, then exercise cross-business and cross-location denial tests through both the API and Supabase Data API. Platform-admin access remains deliberate and audited.
7. Remove the one-restaurant-per-owner restriction only when ownership and migration tests pass. Do not infer a chain by grouping similar names/emails.
8. Rehearse migrations and backup/restore on disposable dev data before any future main promotion. Retain old columns/routes until the compatibility window closes.

The repository's existing migration runner is authoritative today. If adopting CLI-generated timestamp migrations, first design and test a history-preserving transition. Do not copy migrations into a second runner and apply them twice. The current `--dry-run` creates migration bookkeeping objects, so it is not a strictly read-only database inspection command.

### 6.3 Inventory correctness rules

- Store stock as an auditable sequence of posted movements. Never expose an unrestricted "set quantity" write.
- Each posting records business, product, location/status, batch if applicable, quantity/unit, source document, actor, recorded time and effective business time.
- Use exact numeric quantities and explicit unit conversions. Freeze conversion factors on historical postings; never recalculate old transfers from an edited pack size.
- Post all related movements, workflow state and balance updates atomically in a database transaction. Use row locking or equivalent concurrency control for stock checks and competing dispatches.
- Every command/import event has a scoped idempotency key. A retry cannot post stock twice. Reject reuse of a key with a different payload.
- Corrections are linked reversing/compensating entries with reasons; posted history is not deleted or silently overwritten.
- Distinguish on-hand, reserved (if reservations are approved), available, in-transit and quarantined stock. Do not count transit stock at both branches.
- Decide negative-stock policy, allowable backdating and approval thresholds with Fayaz. Enforce the selected policy in the posting layer, not only in the UI.
- Internal transfers conserve company quantity until a separately recorded loss/waste disposition. Cost/value reporting waits for an agreed costing method; quantity visibility does not imply profit calculation.

### 6.4 Transfer lifecycle proposal

Draft/request → approved if required → dispatched → partially received / received → resolved/closed.

Dispatch moves stock from the source to transit. Receiving moves only the acknowledged quantity into the destination's accepted stock. Damaged goods go to an agreed quarantine/waste path. Remaining quantities stay unresolved/in transit until an authorized disposition; a short receipt must not silently destroy stock. Multiple receipts cannot exceed the dispatched quantity without a separately approved correction.

Example for acceptance testing, not a claim about Fayaz: send 50; receive 47; show three unresolved. Recording two damaged in transit and one returned to the bakery must account for all 50 with a full history. Receiving the same receipt twice must have no second stock effect.

Drafts can be cancelled before dispatch. After dispatch, cancellation needs a return/reversal workflow, not deletion. Partial receipts, mixed batches and returns must preserve their individual actors and timestamps.

### 6.5 Sales, counts and data freshness

Choose one authoritative sales-depletion path per location/channel. A Cravio order mirrored to a POS must not deplete stock once in each system. Keep shared external IDs and reconciliation links.

Support the selected POS integration or a reviewed CSV import first; do not promise an API connector without vendor evidence. Import flow: upload → parse → map → preview → validate → approve/post → reconcile. Unmapped products, missing branches, duplicate events and invalid units go to explicit exceptions. CSV totals must reconcile to source quantities; a repeated or corrected export needs deterministic duplicate/reversal handling.

Separate sales quantity, cash received and stock returned. Refunding money does not automatically make food saleable. Decide the deduction timing for sales, prepared orders, cancellations and returns in discovery.

Counts need a defined cut-off. Either temporarily freeze relevant movements or reconcile movements after the count snapshot. Closing counts become adjustments only after the agreed review. Never compare a morning physical count with an end-of-day theoretical balance.

Every stock/report screen shows its as-of time, sales coverage and last successful import/sync. A daily import is not live stock. Expected closing stock = opening + output + receipts + approved returns in − sales − dispatches − waste + signed adjustments, for the same location, period and status.

## 7. Implementation phases and acceptance gates

Each phase ends with a reviewable dev release and a demonstration against the stable main baseline. Dates and effort estimates are intentionally unset until discovery, POS access and acceptance targets are known.

### P0 — Baseline and comparison environment (this task)

Deliver this plan, questionnaire, synchronized branch baseline and separate app runtimes using the approved shared database. Do not seed or migrate that database. Do not request OpenRouter credentials yet; no feature routes or mock business analysis are shipped in this task.

Exit: comparison acceptance in section 5 passes; main's code remains unchanged; dev's setup is reproducible and documented.

### P1 — Discovery and foundations

Dependencies: approved plan, isolated development data before any schema changes, and D01–D04. Complete the Fayaz meeting, collect real sample documents, record decisions by question ID, and finalize pilot boundaries.

Work packages:

1. Map current SOPs and exceptions; agree product units, roles, sales authority, update frequency and pilot success criteria.
2. Implement additive business/location migration and compatibility backfill.
3. Implement scoped authorization, active-location selection, module entitlements and cache isolation.
4. Add inventory-only onboarding, location directory and shared SKU catalogue/import preview.
5. Add an audit-record foundation and durable job infrastructure only where required by subsequent phases.

Exit: existing single-location flows still pass; a user permitted at one outlet cannot read/write another; HQ sees only its business; inventory-only setup requires no guest menu; module restrictions are enforced server-side.

### P2 — Finished stock and branch movement

Dependencies: P1; D02–D05 and agreed negative-stock/backdating policy.

Work packages:

1. Implement transactional posting and balances with exact units, duplicate protection and history.
2. Import reviewed opening balances; record output batches with production date and the agreed expiry fields.
3. Build replenishment requests where required, dispatch notes and receiver confirmation with partial/short/damaged receipts.
4. Build returns, quarantine/waste disposition and correction approvals.
5. Deliver mobile-friendly dispatch/receive screens, stock by location and an HQ unresolved-transfer view using existing Cravio components.

Exit: duplicate and concurrent posting tests pass; source/transit/destination quantities reconcile; a wrong-branch receiver is denied; the 50/47 example is traceable; user-visible errors retain drafts without double submission.

### P3 — Sales integration, counts and daily control

Dependencies: P2; actual POS/export evidence and D06–D08, D10.

Work packages:

1. Implement exactly one agreed pilot sales path: vendor adapter, CSV import or controlled manual batch. Preserve a common connector contract for later adapters.
2. Map external product/location IDs, deduplicate events and reconcile refunds/corrections without double depletion.
3. Implement count sessions, approved variances and daily-close exceptions with a defined cut-off.
4. Add branch/HQ stock views, configurable low-stock thresholds, expiry attention and source freshness.
5. Add connector health, failed-job review and safe replay, plus downloadable stock/movement reports.

Exit: imported sales reconcile to source records; re-import has no duplicate effect; offline/retry scenarios match the agreed operating procedure; stale data is visibly labelled; counts reconcile correctly during concurrent movement; staff can complete a full test day.

This is the first candidate Fayaz pilot. Real order injection is not a prerequisite if Fayaz's approved scope only needs sales imports.

### P4 — Restaurant service and management

Dependencies: P1 and discovery for service workflows; P3/F06 for real POS connectivity. These features are optional for inventory-only locations.

1. Order connector: confirmed Cravio orders create a durable outbox task, map products/modifiers/taxes, transmit once logically, receive acknowledgements, and expose retry/failed states. External acceptance must never be faked by a local success response.
2. Checkout reconciliation: ingest provider/POS payment states; distinguish manual, pending, verified, failed and refunded records. Match orders to payments and show unresolved differences at close.
3. Kitchen/bar: either integrate existing routing or implement authorized station queues, preparation/ready states, item-level partial readiness, timing and pickup notification. Do not send tickets to two kitchen systems. Preserve the guest/waiter confirmation flow.
4. Service control: table assignments, request acknowledgement/escalation, handovers and reasoned sensitive actions according to SOPs.
5. Checklists: recurring opening/closing runs, assigned staff, required checks and supervisor review; keep an immutable completion history.
6. Menu controls: modifier groups and constraints, location/daypart availability, verified dietary/allergen fields and reviewed translations. Snapshot selected choices and prices on orders. Test timezone boundaries and sold-out behaviour.

Exit: existing menu/order flows regress cleanly; duplicate POS delivery is prevented; payment mismatches remain visible; prepared/ready does not imply served/paid; disabled modules cannot be reached through direct API calls.

### P5 — AI assistance, starting with placeholders

Dependencies: P1 and trusted reporting; P3 for inventory briefings. OpenRouter is selected, but real calls wait for an API key, model choice, spend limits and data-policy decisions.

1. Add a server-side provider interface with `placeholder` and `openrouter` modes. Placeholder mode is explicitly labelled, deterministic, makes no external requests and never claims invented facts are restaurant results. Sample import files/outputs must be visibly marked as examples.
2. Build deterministic evidence APIs for sales, stock, transfers, waste and service timing. Attach business/location, period, timezone, source coverage, timestamps and record links. Correct the units-per-view labelling before feeding the metric to AI.
3. Add an owner briefing and scoped question interface using a small allowlist of reporting tools. Compute numbers in application/database code; the model explains results. No model-generated arbitrary SQL or direct privileged database access.
4. Add menu extraction as a draft workflow: private upload, bounded file/page sizes, extraction, field confidence/uncertainty, side-by-side source review, validation and explicit publication. Do not infer allergens or dietary suitability from names/images.
5. Add reviewed description/translation drafts and menu-performance suggestions with supporting evidence. Margin advice stays unavailable until costs exist. Suggested experiments must distinguish correlations from proven causes.
6. Implement OpenRouter as a backend-only adapter once configured. Keep keys out of browser bundles; validate structured output; set timeouts and bounded retries; meter usage and enforce configured quotas. Record model/provider version for reproducibility. Provider/model fallback requires the agreed policy rather than silent substitution.
7. Treat uploaded menus, notes and retrieved text as untrusted data. They cannot change tool permissions or override business/location scope. Do not send unnecessary customer or staff identifiers to the model. Agree retention/deletion and allowed routing providers before real data is sent.
8. Persist proposed actions with their evidence version. Apply only through ordinary authorized APIs after explicit approval; recheck permissions and data freshness at execution. Log approver and result.

Exit: no cross-business/branch disclosure; numbers match reporting fixtures; empty/partial/stale data is acknowledged; prompt injection cannot perform writes; missing configuration and budget/provider failures degrade gracefully; no stock or menu changes occur from an unapproved suggestion. Evaluate factuality, extraction accuracy, latency and per-task cost against owner-approved targets rather than inventing thresholds.

### P6 — Pilot, operational hardening and measured rollout

Dependencies: P3 for inventory; optional P4/P5 features only if explicitly included in pilot acceptance.

1. Confirm pilot locations and named operators; train dispatch, receipt, counting and HQ staff on their actual devices.
2. Reconcile starting counts and run an agreed parallel period against the existing records. Do not add both systems' deductions together.
3. Exercise realistic failures: interrupted receipt, repeated import, late sales, partial delivery, invalid SKU, expired batch, access revocation and reconnect.
4. Measure unresolved transfers, expected-vs-counted differences, time to reconcile, job failures and actual completion of daily workflows. Set target values with Fayaz.
5. Rehearse backup/restore, incident response, corrections and rollback/cutover. Roll back code compatibly; do not undo posted stock by deleting migrations/data.
6. Obtain recorded user acceptance from bakery, outlet and owner representatives before expanding to additional locations.

Exit: agreed acceptance evidence, reconciled stock and named support ownership. A future merge of features into main is a separate release decision; this task does not authorize it.

### P7 — Subsequent modules, each with separate scope approval

- Ingredients/recipes: suppliers, purchases/receiving, units/yields, recipe consumption, waste and an agreed inventory valuation method. Add theoretical versus actual usage and ingredient contribution margins; do not call these net profit.
- Invoice AI: extract supplier bills, match units/SKUs, flag price changes, and review before receiving stock or changing costs.
- Forecasting: begin with a seasonal/simple historical baseline, backtest against held-out history, account for stockouts and missing sales, show uncertainty, and compare recommendations with actual outcomes before automating purchasing/allocation. Generative AI is not the quantity calculator.
- Commercial operations: business subscriptions, entitlements and billing events separate from restaurant customer payments; choose provider/pricing after product decisions. Keep support/integration dashboards scoped and audited.
- POS replacement: checkout/payment state machine, split/partial payments, refunds, discounts/approvals, tax/service charges, cash shifts, receipts/printers, card/mobile-money integration, eTIMS path and tested offline/recovery operation. Inventory depletion must survive migration from external POS authority to Cravio authority without duplication.
- Demand-led modules: reservations, loyalty, delivery platforms and scheduling remain explicit backlog items, not promised features of the Fayaz pilot.

## 8. Implementation map

Paths under "new" are proposed, not existing files or implemented APIs.

| Concern | Existing files to extend | Proposed additions |
| --- | --- | --- |
| Business/location context | `backend/src/lib/auth.js`, `restaurants.js`, `operations.js`; `frontend/src/lib/auth.jsx`, `cache.js`, `prefetch.js` | Business/location context module and permission checks |
| Navigation/access | `frontend/src/App.jsx`, `config/dashboards.js`, dashboard components | Location selector and module-aware navigation using current design |
| Inventory | `backend/src/routes/index.js`; existing migration/test infrastructure | `backend/src/routes/inventory.js`, inventory domain/posting code, `frontend/src/pages/inventory/` |
| Integrations | Order operations and existing API client | `backend/src/integrations/`, durable jobs/outbox, import/exception pages |
| Service management | Existing order drawer, waiter services, owner overview and menu editors | Kitchen queues, checklists and handover components |
| AI | Insights and menu editing pages | `backend/src/ai/`, AI routes, draft/evidence UI and evaluation fixtures |
| Tests | `frontend/tests/`; current backend utilities | Posting/concurrency tests, authorization tests, connector contract tests and AI evaluation cases |

Proposed API groups: authorized business/location selection; inventory products/batches/output/transfers/receipts/counts/movements; imports/reconciliation; service tasks/kitchen; AI briefings/questions/drafts/approvals. Publish method/path/body/error/idempotency contracts before implementing each group and keep `docs/API.md` current. No API route in this paragraph is claimed to exist today.

## 9. Validation and release discipline

| Layer | Required evidence |
| --- | --- |
| Existing behaviour | Build plus current auth, guest, waiter, owner, menu, settings and admin tests against isolated fixtures |
| Isolation | Cross-business and unauthorized-location reads/writes denied through API, direct Data API, Storage and AI tools; no stale cache leaks after switching |
| Ledger | Exact conversions, conservation, concurrent dispatch, atomic failure rollback, idempotency and reversible corrections |
| Transfer | Partial/multiple receipts, shortage, damage, cancellation after dispatch, returns and wrong-branch receiver |
| Sales/import | Duplicate/corrected export, unmatched products, cancelled/refunded sales, missing branch, interrupted posting and Cravio/POS deduplication |
| Counts | Cut-off/timezone, in-flight movements, recount, approvals, backdating and expected/actual variance |
| Connectors | Timeouts, rate limits, invalid callbacks, replay, acknowledgement loss and recovery; provider contracts verified against sandbox |
| AI | Placeholder honesty, evidence fidelity, scope enforcement, prompt injection, no-action-without-approval, budget exhaustion and malformed outputs |
| UX | Existing design retained; mobile receiver flows, keyboard access, clear pending/error states and no duplicate submission |
| Operations | Migration replay on disposable DB, backup/restore rehearsal, log redaction, failed-job alerts and documented rollback |

Do not run the existing end-to-end suite against the main project. Add a target-identity guard before mutation tests/migrations. CI should build and run deterministic tests plus an isolated database suite; do not depend on production accounts or real emails. Any failures must be resolved or documented as explicit release blockers, not hidden by broad retries.

## 10. Evidence, decisions and next handoff

Before coding P1–P3, capture answers in `question.md`, identify the respondent and attach redacted source documents. Convert answers into approved workflow rules and update D01–D12 with owner/date/evidence. Unanswered items remain open; do not infer agreement from a blank field.

The next implementation brief should name the phase/work package, approved decisions, relevant files, API/database contracts, acceptance cases and explicit exclusions. Estimate effort only after the brief has a known POS path, usable sample data and measurable acceptance targets.

Sources used for planning (capability/context evidence; not Fayaz-specific requirements):

- [MarketMan central-kitchen and multi-location inventory](https://www.marketman.com/platform/multi-unit-restaurant-commissary-kitchen-inventory-software).
- [Foodics transfer workflow](https://help.foodics.com/hc/en-us/articles/7055867451164-How-Does-Transfer-Order-Work) and [transfer variance report](https://help.foodics.com/hc/en-us/articles/4408266395794-Transfers-Report).
- [Supabase local development](https://supabase.com/docs/guides/local-development) and [configuration/secrets](https://supabase.com/docs/guides/local-development/managing-config). Verify the installed CLI's help before use; local tooling is version-dependent.
- [KRA system-to-system eTIMS integration](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration), for the later checkout discovery phase.

## 11. Setup delivery record

Implemented as development tooling only:

- Main checkout: `/home/jjibrah/confidential/cravio-main-baseline`, branch `main`, unchanged application baseline `5b5879e7e56a70f06ce0d6eef492c09c5ae62752`.
- Dev checkout: `/home/jjibrah/confidential/cravio`, branch `dev`, baseline plus these documents and the comparison launcher. The document/setup commit is recorded by Git rather than embedding a self-referential commit hash here.
- Main frontend: `http://localhost:5173`; backend: `http://localhost:3003`.
- Dev frontend: `http://localhost:5174`; backend: `http://localhost:3004`.
- Database/Auth/Storage: the same pre-existing Supabase project by the user's latest instruction. No new Docker stack was created; no schema, seed or hosted settings were changed.
- Credentials: each checkout uses its ignored `frontend/.env` and `backend/.env`. Existing accounts are shared; no new test users/passwords were created.
- OpenRouter: selected for the future AI phase; no API key requested, API call made or AI feature implemented. Placeholder behaviour is specified in P5 for later implementation.

Start both applications from the dev checkout:

```sh
cd /home/jjibrah/confidential/cravio
npm run compare
```

The command explicitly enables the approved shared-database mode. It launches two Vite servers and two Node backends, checks branch names and port availability, and forwards each frontend to its own backend. Stop it with Ctrl+C in its terminal (or SIGTERM to the comparison parent process); all four app processes stop together. Run the same command to restart. A server/session restart can stop these processes; the URLs are available only while the launcher runs.

To use another main checkout, set `CRAVIO_MAIN_DIR` to its absolute path. On a fresh machine, first create a worktree on main, run `npm ci` in both checkouts, and configure each checkout's ignored environment files. Do not run a second comparison launcher while the first owns these ports.

After isolated dev data is configured for future feature development, use `node scripts/compare.js` without `--shared-db` and update the npm command accordingly. It refuses a shared project unless that flag is explicit. Hosted Auth redirect allow-lists still need verification before testing links on the dev origin.

Verification completed on 14 November 2026:

- Main and dev production frontend builds passed; no frontend source/style changes were made.
- Both frontends served HTML and transformed entry modules with HTTP 200.
- Both backend health endpoints returned `{ "status": "ok" }`.
- Each frontend's `/api/me` proxy returned the expected unauthenticated 401 and its own origin's CORS header, verifying separate backend routing.
- The launcher rejected implicit shared-database use and rejected occupied ports before spawning another copy.
- SIGTERM to the comparison parent stopped all four listeners; the launcher was then restarted.
- Local Markdown links, question IDs Q01–Q63 and Git whitespace checks passed.
- Authenticated mutation tests, seeds, migrations, user invitations and provider API calls were intentionally not run against the shared database. Login/recovery and full end-to-end regression coverage are not claimed by these startup checks.

## 12. First implementation milestone

The user authorized implementation after the planning delivery. Dev now has an account-owned finished-goods workspace, locations, products, transactional postings, partial receiving, transit-loss accounting, counts, history, dated checklists and a factual AI placeholder. Migration 007 is additive and private. No existing restaurant data is backfilled or restructured in this milestone.

This is a subset of P1–P5, not their completion. Business/location staff grants, service-location integration, module entitlements, conversions, batch depletion, returns/reversals, POS integration, kitchen/menu enhancements and real AI remain open. The earlier environment gate remains necessary for broad mutation tests and pilot deployment; transaction-rollback rehearsals and intercepted UI fixtures were used for the initial shared-database preview. See the linked preview document for exact capabilities and limitations.
