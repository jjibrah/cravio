# Inventory and management preview

Implemented on dev for review. Main retains its existing application code. The shared database has additive migration `007_inventory_preview.sql`; existing restaurant rows and policies were not modified.

## Access

Open http://localhost:5174/owner/inventory with an existing owner account, then create an inventory workspace. The sidebar also includes Management and AI assistant. Inventory setup does not require restaurant onboarding to be complete.

This release uses an account-owned workspace. It does **not** yet share inventory between staff accounts or connect the new locations to restaurant service locations. The business/location grant and module-entitlement architecture in the implementation plan remains future work. Do not use shared account passwords as a substitute for staff permissions.

## Working features

- Create bakery, outlet and warehouse locations.
- Create finished-product SKUs with explicit base units and low-stock thresholds.
- Record opening stock (before other movements), finished production, manual sales and waste with a required reference/reason.
- Dispatch goods to another location; stock leaves the source and remains outstanding until received or explicitly recorded as transit loss.
- Receive partial deliveries without overwriting dispatched quantities. Record a reason to resolve a transit loss.
- Post an explicitly approved physical count and preserve its adjustment in history. A changed balance rejects a stale count; pause physical movements while counting in this preview.
- Review balances and the most recent 200 movements with actor IDs, timestamps, reasons and optional production batch/expiry provenance.
- Add dated location-specific daily tasks and record completion.
- View an explicitly labelled AI placeholder with factual counts from the current inventory snapshot. No OpenRouter request is made.

## Deliberate boundaries

Quantities are in the SKU's base unit. Conversions, cake cutting, batch-specific balances/expiry depletion, returns/quarantine, draft-transfer approvals, location staff grants, recurring checklist templates and reversal workflows are not implemented yet. Do not use production entries to disguise returns or adjust posted history silently; investigate and agree the missing procedure before pilot use.

POS ingestion/order injection, verified payments, kitchen queues, menu modifiers/schedules, document extraction, generated AI answers, ingredients/costing and forecasts remain later work. Manual sales here do not alter service orders or payment status. Checklist tasks are timestamped records, not a complete shift-management system.

These boundaries are explicit so this preview can inform the Fayaz meeting without pretending their SOPs are known. It is not the completed enterprise product or a live pilot rollout.

## API

`GET /api/inventory` requires an authenticated owner-profile account. It returns that account's workspace (or null), locations, products, balances, transfers, recent movements, tasks, as-of timestamp and current preview policy.

`POST /api/inventory` accepts `action`:

- `setup`: `name`.
- `location`: `name`, `kind` (`bakery`, `outlet`, `warehouse`).
- `product`: `sku`, `name`, `unit`, `lowStock`.
- `opening`, `output`, `sale`, `waste`: `locationId`, `productId`, `quantity`, `reason`; output may include `batch` and `expiresOn`.
- `dispatch`: the stock fields above plus `destinationId`.
- `receive`, `transit_loss`: `transferId`, `quantity`, `reason`.
- `count`: `locationId`, `productId`, `quantity` (physical), `expectedBalance` (last observed), `reason`.
- `task`: `title`, `day`, optional `locationId`.
- `complete_task`: `taskId`.

All commands except initial setup require a UUID `commandId`. Repeating the same key/payload returns the original result without posting again. Reusing a key with a different payload is a 409. Quantities support at most three decimal places; negative balances and over-receipt are blocked. References from another workspace return 404. There is no unauthenticated inventory access.

All writes and their audit entries run inside a database transaction. Owner-level advisory locks serialize competing commands. Tables reside in the private schema, have RLS enabled and deny direct anon/authenticated access. Backend authorization checks the account before acquiring a scoped transaction. Database credentials remain server-only with verified TLS.

## Verification

- `node backend/tests/inventory.js`: rollback-only database rehearsal covering idempotency, overselling, partial receipt, transit loss, stale counts, cross-business references and table privileges. Requires two existing users with no inventory workspace; refuses claimed accounts rather than changing real inventory.
- `node backend/tests/inventory-ui.js`: authenticated owner UI with intercepted inventory fixtures; no inventory POST reaches the database. Exercises navigation, posting/receiving forms, management, placeholder labelling and mobile overflow. Uses the documented demo owner account and signs out only its own test session.
- `npm run build`: production build.

The broad existing mutation suites are not run against the shared database. Before multi-user pilot testing and schema expansion, resolve the isolated environment requirement and the outstanding discovery questions in the plan.

## Page structure and first use

The workspace is visible before business setup. Inventory opens with an overview, four setup steps, stock attention items, the daily workflow, location positions and recent activity. Stock has product/SKU search, location filtering and a low-stock filter. Management has dated task counts, location/date/status filters, a checklist and a separate task-entry section. The assistant has an evidence-based owner briefing, curated factual questions with source links, and an honest description of the planned menu-import flow.

Use **Explore example** on any of these pages to inspect fictional populated records without creating a workspace. This sets `example=1` in the URL. All posting buttons and submission handlers are disabled in example mode; no example record is sent to the API. **Use my workspace** returns to the real account data.

Direct example links: http://localhost:5174/owner/inventory?example=1, http://localhost:5174/owner/management?example=1 and http://localhost:5174/owner/assistant?example=1.

`npm run test:workspace-ui` verifies first-use structure and input dimensions, example-mode isolation, stock search/location filters, management filters, factual question selection and mobile overflow on all three pages. Tests intercept inventory responses and perform no inventory database writes.
