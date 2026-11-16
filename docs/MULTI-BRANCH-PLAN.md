# Cravio: business owner, branch operations and product traceability

**Historical proposal, superseded on 16 November:** [the v2 five-interface plan](v2/IMPLEMENTATION-PLAN.md) governs new work after receipt of the Cravio PRD. This document's separate warehouse workspace, bakery dispatch/traceability workflow and sales-connector dependency are not v2 requirements. Preserve this file as planning history, not an implementation brief.

Status: proposal for discussion, updated 16 November 2026. Planning only; no implementation or database changes authorized by this document.

This revises the dashboard and ownership model in [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md). The implemented account-owner inventory preview is a starting point, not the target architecture. Earlier POS-replacement, ingredient-costing and AI ideas remain a later roadmap.

## 1. Confirmed direction

Latest clarification: this is a general Cravio product, not a bespoke Fayaz implementation. Fayaz is discovery context only. The forthcoming product requirements document (PRD) will be reviewed before further scope decisions or implementation.

- The business owner gets a separate dashboard for the whole business: locations, inventory configuration, product movements and branch performance.
- Existing restaurant operations become the branch manager's workspace. Preserve the current design and reuse working service screens.
- Multiple branches belong to one business. Warehouses and production sites must also be supported, including sites that have no guest menu or tables.
- Track product quantities by branch/location; batch and individual-item traceability are outside the first version. Track finished products from entry/release at the warehouse or bakery through dispatch, receipt and sale. Ingredients and recipe costs remain outside the first release.
- Continue alongside the existing POS before eventual checkout replacement.
- OpenRouter remains a placeholder. No model calls or AI-generated operational actions in this phase.
- Develop on dev; main stays the review baseline until explicit approval to merge. Existing comparison ports remain 5173/main and 5174/dev, with the shared database previously requested. No database work is part of this planning task.

Fayaz uses an unspecified older system; export/API capabilities are unknown. That system is not the integration target for this general product. Target sales sources, approval procedures, staff responsibilities and sale/refund rules remain subject to the forthcoming PRD and discovery. No particular POS integration is assumed.

## 2. Patterns from other systems

| System | Documented pattern | Proposed lesson for Cravio |
| --- | --- | --- |
| MarketMan | HQ oversight across locations; a central kitchen connected to location ordering, production and deliveries. | Business-wide owner workspace with drill-down into each site. |
| Lightspeed Restaurant | Location-specific access; local floor plans and hardware; reporting at local and aggregate levels. | Keep branch work local while letting the owner see the whole business. |
| Foodics | Users assigned to branches; transfer orders can be reviewed and approved, then dispatched and received as separate actions. | Give each handover a responsible person and record both quantities. |
| Odoo | Lots identify batches and connect their stock movements in traceability reports. | Reference for a possible later batch module; batch tracking is outside the confirmed first-version scope. |

Official sources, reviewed for this proposal:

- [MarketMan multi-unit and commissary management](https://www.marketman.com/platform/multi-unit-restaurant-commissary-kitchen-inventory-software).
- [Lightspeed location access](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804647149-Managing-Back-Office-users) and [shared versus local features](https://k-series-support.lightspeedhq.com/hc/en-us/articles/23973504428059-Navigating-business-locations).
- [Foodics branch assignments](https://help.foodics.com/hc/en-us/articles/4406606302482-Adding-Branches-to-Users) and [transfer workflow](https://help.foodics.com/hc/en-us/articles/7055867451164-How-Does-Transfer-Order-Work).
- [Odoo lots and traceability](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/product_management/product_tracking/lots.html).

These sources support workflow choices, not a promise that every vendor edition or integration supports every feature. The proposed Cravio implementation is our own design.

## 3. Workspaces and navigation

One Cravio application and sign-in, with workspaces determined by membership and capabilities. A user may manage several assigned branches. The owner can enter any branch workspace with their own identity, with a clear return to business overview; do not impersonate the branch manager.

### Business owner workspace

| Page | Content and actions |
| --- | --- |
| Business overview | Branch performance table, stock exceptions, outstanding deliveries, sales coverage and last-update times. Filters by period and location. Each figure opens its supporting records. |
| Locations | Create a branch, bakery or warehouse; assign managers; configure enabled modules and operating details; view a site's stock, deliveries and service activity. Archive with history preserved. |
| Products | Shared inventory SKUs, explicit units, variants and location-specific stock targets. Map stock products to existing branch menu items and external POS codes. |
| Inventory | Stock quantities by product and location; distinguish available, held/quarantined, reserved and in-transit quantities. Opening counts, finished-product entry and reviewed adjustments. |
| Transfers | Requests/drafts, dispatches, partial receipts, completed deliveries and unresolved differences. Open a dispatch note, its lines and the receiving records. |
| Product tracking | Search SKU, location or dispatch reference. Show where quantities went, where they remain, associated sales and exceptions, with people, times and source records. |
| Branch performance | Recorded sales, units sold, waste, stock variances, outstanding transfers and daily-close completion. Comparable periods and explicit data coverage; do not call sales or ingredient margin net profit. |
| Team and access | Invite people, assign business/location roles, remove access and review sensitive actions. |
| Operations | Checklist templates, branch completion, handover notes and exception review. Full recurring SOP automation follows the stock pilot. |
| Integrations and settings | POS mapping/import status, business settings, approved inventory rules and audit history. AI briefing remains visibly a placeholder. |

The landing page should lead with exceptions and branch status, not a large inventory setup form. New customers get a compact setup sequence: business → locations and people → catalogue → opening stock → first transfer.

### Branch manager workspace

Reuse the existing Overview, Orders, Tables, Menu products, Menu configuration and Insights screens within an explicitly selected branch. Add:

- Branch stock: on-hand quantities, incoming deliveries and low stock.
- Receiving: check a dispatch, record actual quantities and rejected/damaged items, flag differences.
- Replenishment requests: request products from the supplying site; the actual allocation/approval policy is an SOP decision.
- Waste, returns and counts: submit records with reasons; apply approval rules where agreed.
- Daily close: sales-import coverage, unresolved differences, count and task completion.
- Branch team and tasks, limited by the capabilities the owner grants.

Branch managers do not automatically inherit business ownership, subscription settings, other branches' reports, global product editing or permission to grant themselves access. Decide whether they may edit local prices/menu descriptions or only availability. Moving screens is not equivalent to granting every existing owner permission.

### Warehouse/bakery workspace

Use the same location workspace framework with stock-focused navigation: stock, finished-product entry, requests, picking/dispatch, returns and counts. Hide tables and guest-service features unless that site also sells directly. Allow a combined bakery-and-outlet location through capabilities rather than forcing duplicate stock records for one physical site.

### Single-location customers

One business and one location use the same model. An owner who also runs service can switch directly into that branch. Enable service, inventory or both by subscription/module entitlement, independently of staff permissions. No duplicate inventory-only identity system or separate product fork is needed.

## 4. Proposed permission boundaries

| Capability | Business owner | Branch manager | Warehouse operator | Waiter |
| --- | --- | --- | --- | --- |
| Create locations and grant access | Business-wide | No | No | No |
| View consolidated stock/reports | Yes | Assigned locations only | Assigned locations only | No |
| Maintain shared inventory catalogue | Yes | By explicit grant | By explicit grant | No |
| Run orders, tables and branch service | Any enabled branch | Assigned service branch | Only if separately granted | Existing assigned service tasks |
| Enter finished goods/dispatch | Yes | By explicit location grant | Assigned source locations | No |
| Receive a transfer | Yes | Assigned destination | Assigned destination if granted | No |
| Record waste/counts/returns | Yes | Assigned location | Assigned location | No by default |
| Approve a variance/write-off | Yes | Only if explicitly granted | No by default | No |

This matrix is a proposed default. Product requirements and customer discovery must establish who dispatches, receives and approves. Whether self-approval is prohibited and which quantities require approval remain open. Do not require the owner to approve every routine action unless their SOP calls for it.

## 5. Product journey and accounting rules

Confirmed tracking level: product quantities by branch/location. Record how much of each SKU entered, moved, sold, was wasted or remains. Do not require batch labels, serial numbers or batch-to-sale allocations. A product journey is a quantity and movement history, not proof that a particular physical item or batch supplied a sale.

1. **Enter finished stock.** Record SKU, quantity/base unit, source location, responsible staff member and source reference. Existing stock starts from a verified opening count; do not manufacture historical production records.
2. **Prepare a transfer.** A document contains multiple product lines, source, destination and requested/planned quantities. Picking/reservation reduces availability, not physical stock. Draft/approval behavior depends on the agreed SOP.
3. **Dispatch actual quantities.** Reduce source stock and increase in-transit stock atomically. Preserve the dispatch note, actor, time and any handover evidence. Never reduce the source again at receipt.
4. **Receive actual quantities.** An authorized destination user records what arrived. Transfer the received quantity from transit to destination stock; damaged goods can arrive into quarantine instead of saleable stock. Preserve partial receipts. A difference stays unresolved until an authorized resolution accounts for it.
5. **Record sales.** The agreed POS source or controlled manual/import process deducts the appropriate branch stock exactly once. Keep external sale/line IDs where available. A daily SKU summary can support a dated quantity deduction but cannot produce individual receipt traceability.
6. **Handle exceptions.** Waste, returns, expiry, loss, corrections and counts are explicit events. A refund does not automatically mean physical stock returned. Returned stock enters inspection/quarantine until a disposition is recorded.
7. **Review and reconcile.** Compare expected to counted stock at a defined cutoff; protect against concurrent movements. Posted events remain immutable, with linked reversal/correction events and reasons rather than overwritten history.

Suggested transfer states: draft → awaiting approval (if required) → ready → dispatched → partially received → received. Unresolved discrepancy is separately visible and prevents final reconciliation. Cancel only unshipped quantities; goods already dispatched require a return or resolution event. Track requested, dispatched, received and resolved quantities separately per line. The UI can simplify labels without discarding those facts.

Illustrative example only, not Fayaz data: 100 pastries entered at the bakery; 60 dispatched; 58 received. The bakery retains 40, the outlet has 58, and 2 remain unresolved in transit. After 45 sales and 3 recorded waste, the outlet should have 10. The owner can account for 100 = 40 bakery + 10 outlet + 45 sold + 3 waste + 2 unresolved. The shortage is not silently labelled waste or lost.

### What “track until sold” can truthfully mean

- SKU-level: quantities sold by branch and period, linked to their actual sale source.
- Future extension only: batch identities could be preserved through stock movements and sale allocations. This is not a first-version requirement.
- Future extension only, exact batch-to-sale evidence: requires staff/POS to capture that batch at sale or another verified handoff. Selecting a batch by a first-expiring-first-out rule is an allocation assumption; show it as such, not as a scanned fact.
- Daily summaries: no invented receipt IDs, buyer identity or sale timestamps. Report their covered period and update time.
- Whole cakes converted into slices, packs and bundles need explicit conversion/allocation rules. Do not add these automatically before examples are supplied.

## 6. Required changes to the current code

Read-only code review found:

- `backend/db/migrations/002_restaurants.sql` enforces `restaurants_one_per_owner`; restaurant membership already has owner/manager/waiter roles.
- `backend/db/schema.sql` profile roles are admin/owner/waiter. `backend/src/routes/restaurant.js` explicitly treats a manager as profile role owner, then checks restaurant membership. A new global manager label alone would not solve access scoping.
- `backend/src/lib/restaurants.js` selects one primary membership; `/api/me` and the frontend derive one restaurant context. Multi-branch endpoints need an explicit authorized business/location context.
- `frontend/src/config/dashboards.js` puts service and inventory in one owner sidebar. `DashboardLayout.jsx` and `frontend/src/lib/auth.jsx` route around global profile role.
- `backend/src/routes/inventory.js` finds a stock business by the signed-in owner's ID; managers currently cannot share the same business inventory through membership.
- Migration 007 stores balances by location/product and a free-text batch on movements. Batch balances and sale-to-batch relationships are not required for the confirmed scope. Transfers currently hold one product each.
- `backend/src/inventory/database.js` serializes commands by user ID. With multiple staff acting on the same stock, concurrency must be coordinated by business/stock resources, not caller identity.

### Proposed logical model

- **Business:** the tenant owning its catalogue, locations and memberships. Keep platform administration separate from customer ownership.
- **Location:** branch/warehouse/bakery identity with service/inventory capabilities. Link existing restaurant records to locations so menu, order and guest links can retain their IDs.
- **Business membership and location assignments:** a person may be a business owner or have capabilities at one/many assigned sites. Use memberships for authorization, not a global profile label alone.
- **Inventory product and location settings:** shared SKU/unit identity; location-specific thresholds and availability. Existing menu dishes map explicitly to stock items rather than being merged blindly.
- **Stock position:** product/location/condition; quantities and reservations. Batch identity is a possible later extension, not a required dimension.
- **Transfer header, lines and receipt lines:** preserve multi-product and partial-delivery relationships.
- **Stock event/ledger:** quantity, unit, business, location, product, actor, occurred/recorded timestamps, reason, source document and reversal reference.
- **Sale source and allocations:** source-system identity, branch/product mapping, imported sale lines or daily summaries, deduplication and corrections. No batch-allocation engine in the first version.
- **Counts, exceptions and approvals:** who proposed, who approved, original basis and final resolution.

Prefer evolving the preview into the single business/location model with explicit ID mappings, rather than maintaining parallel restaurant and inventory tenants indefinitely. Exact migrations require an audit of actual existing data first. Keep existing history and mark untraceable opening balances honestly; never assign historic batch identities without evidence.

All API operations must validate business membership, capability and source/destination location access. Use business-scoped constraints to prevent cross-business references, atomic ledger/balance updates and retry keys. Exposed Supabase tables require appropriate grants and row-level policies; private server-only tables still need explicit server authorization because privileged connections bypass row policies. See [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Location switching must scope frontend caches, reports, exports, subscriptions and media access too. Test revocation and direct API requests, not just hidden navigation.

## 7. Implementation sequence and acceptance

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| 0. Agree workflows | Review the forthcoming PRD; agree page map, role matrix, sales-source requirements, units and transfer/return SOP. Product-by-branch tracking is already confirmed. | Unresolved decisions recorded; launch-critical ones answered. No example-customer workflow presented as a universal product requirement. |
| 1. Business/location foundation | Memberships, explicit scope, legacy-to-location mapping and module access. | Two businesses remain isolated; manager sees only assigned branches; an owner can access all their locations; existing guest/service records still work. |
| 2. Separate workspaces | Business-owner shell, branch-manager shell reusing current service pages, stock-focused warehouse shell. | Owner creates locations/assigns staff; manager opens the correct branch; unauthorized URLs and API calls fail; single-site owner can still run service. |
| 3. Finished-stock lifecycle | Catalogue, verified opening stock, output, multi-line dispatch/receipt, immutable product/location ledger. | Product quantities transferred to multiple branches reconcile to their source movements; partial deliveries retain both figures; concurrent users/retries do not duplicate movements or oversell stock. |
| 4. Sale-to-stock connection | One verified sales path, mappings, deduplication, correction/refund rules and sync health. | A completed sale/import deducts once at the right branch; unmatched/late records are visible; missing historical stock creates a reconciliation exception rather than fabricated opening stock. |
| 5. Owner traceability and control | Journey view, branch reports, waste/returns, counts, discrepancy approvals and daily close. | The illustrative stock reconciliation can be reproduced from records; every reported figure drills down; refunds and returns do not double-add stock. |
| 6. Pilot and promotion | Selected pilot business and agreed locations, staff walkthrough, verified opening counts, monitored parallel run and migration rehearsal. | Product acceptance criteria and the selected pilot's measures pass; user reviews dev on 5174 and explicitly authorizes merge to main/5173. |

Implement each phase as a usable vertical slice, not more placeholder pages. The first slice should let an owner establish a business and two locations, assign a manager, dispatch products and have that manager receive them. Full “warehouse to sale” acceptance requires phases 4–5 as well; do not label a transfer-only milestone complete traceability.

### Migration and comparison plan

- Inspect current schema, active customer data and any preview inventory before choosing mappings. Back up and rehearse migration against disposable fixtures before touching shared data.
- Initially add compatible structures and explicit mappings; preserve old restaurant/menu/order identifiers and old main access paths.
- Gate the new business workspaces to the pilot while verifying old main still reads its expected records. Do not merely drop the one-owner index while old code still assumes a single restaurant.
- Backfill only verified relationships; avoid automatically joining an arbitrary inventory preview to a similarly named restaurant.
- Keep rollback of code separate from recovery of new data. Disabling the new feature must not delete posted movements.
- The user chose a shared database for comparison. Ports isolate code, not data. New scoping/backfill changes require a compatibility review and restore plan; do not silently provision or switch to another database. Disposable test fixtures are for testing, not a change to that comparison choice.

### Focused tests

- Two businesses; owner, branch managers, warehouse user and waiter; direct access attempts to another location and tenant; immediate response to revoked access.
- Two users dispatching/receiving/counting concurrently; request retries; a source and destination from different businesses; rejected negative stock.
- Multiple product lines per dispatch; partial and damaged receipts; return after dispatch; corrections preserve original events.
- Duplicate/late/reversed sales imports; product mapping failures; daily summary coverage; product quantities reconcile by branch without implying batch traceability.
- Existing menu/order/table/media and guest links on the main-compatible path; branch-switch cache isolation; desktop and mobile receiving workflow.

## 8. AI placement after the records are reliable

Owner: explain branch differences, unresolved transfers and recorded waste, citing source records and data coverage. Branch manager: summarize their own receiving/count/close tasks. Later, evaluate replenishment and preparation forecasts against actual outcomes.

AI must use the same location permissions and approved reporting calculations as the rest of the application. It does not create stock facts, silently resolve discrepancies or claim inferred batches were observed. OpenRouter remains a placeholder until model, budget, data handling and review rules are settled.

## 9. Decisions for the next discussion

1. **PRD review:** product quantities by branch are confirmed. Review the forthcoming PRD for target users, required workflows and acceptance criteria; flag any conflict with these decisions explicitly.
2. **Sales source:** determine the general product's first supported input path from the PRD (manual, import or a named POS). Fayaz's unspecified legacy system does not select that integration. For a chosen connector, obtain documentation and sample data. Q26–Q33 remain discovery prompts.
3. **Responsibilities:** who records finished output, dispatches, receives, resolves shortages and approves counts? Can one person perform both ends? Q18, Q24, Q40–Q43.
4. **Menu control:** can managers edit prices and product descriptions, or only local availability? Who owns the shared catalogue? Q07–Q12, Q40–Q43.
5. **Physical sites:** does the main bakery also sell, are warehouse and bakery separate, and can branches transfer to each other? Q01–Q06, Q19–Q25.
6. **Units and returns:** trays/pieces, cake slicing, damaged receipts, unsold returns and resale decisions. Q07–Q12, Q19–Q25, Q34–Q39.

Do not estimate a fixed delivery date before reviewing the PRD and resolving the sales-source requirements. Tracking depth is settled: product quantities by branch. The phases remain a proposal; scope and effort follow the PRD review.
