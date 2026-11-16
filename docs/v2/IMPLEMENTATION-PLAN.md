# Cravio v2 — five-interface implementation plan

Planning only · 16 November 2026 · branch `v2-dev` · awaiting decisions before affected implementation.

Read [PRD context](PRD-CONTEXT.md), [decisions](DECISIONS.md) and [device handoff](HANDOFF.md). This is the controlling v2 plan; older root plans and the multi-branch bakery-oriented proposal are historical context. No v2 feature is implemented by this document.

## 1. Product structure

Build **one Cravio platform with five interfaces**, sharing authentication, business/branch records, menu/order services and visual components. Five interfaces do not require five deployments, databases or separate copies of the product.

| Interface | Responsibility | Proposed route boundary |
| --- | --- | --- |
| Owner / operations manager | Configure the business and locations; oversee assigned branches, staff access, inventory and stock requests | `/owner` with explicit business/branch context |
| Branch manager | Run the local restaurant: current owner service/menu screens plus branch stock and requests | `/branch/:branchId` |
| Waiter | Assigned-branch table orders and guest assistance/bill requests | Existing `/waiter` area, with authorized branch context |
| Guest menu | Public branch/table menu, cart and service requests | Preserve existing guest URLs/QR identities |
| Platform admin | Cravio platform accounts, businesses and support; exact powers to agree | Existing `/admin` area |

“Owner” is the customer-facing operations-oversight interface. Tenant ownership and delegated operations access are separate grants beneath it: an actual business owner may administer the business, while a delegated operations manager sees only assigned branches and granted settings. No sixth dashboard is needed. Platform admin is not the restaurant business owner.

An existing owner-profile account should land in the new branch-manager area for its current restaurant, as requested. Do not automatically grant every legacy owner-profile account new business-wide access. A real business owner or nominated operations manager gets an explicit reviewed grant and can also enter authorized branch workspaces under their own identity.

Keep the current Cravio design system. Different navigation and scope make the responsibilities clear. A persistent business/branch label and authorized switcher prevent users from editing the wrong restaurant. Staff with one branch skip unnecessary selection; those with several select from permitted branches only.

## 2. Screen contents and main workflows

### Owner / operations manager

- **Overview:** assigned branches, stock exceptions, pending branch requests, recorded service/sales activity and last refresh. Scope every aggregate to permitted branches; open underlying records from each figure.
- **Locations:** create/configure branch records and assign staff where authorized. Creating the enterprise structure belongs here, not in the branch manager's local settings.
- **Branch detail:** local stock, requests and permitted service reports, plus an explicit “Open branch workspace” action. No identity impersonation.
- **Inventory overview:** quantities by product and branch, movement/adjustment history and freshness. Cross-branch product comparison requires an explicit product mapping; never merge identical names automatically.
- **Stock requests:** branches' submitted needs with status, responsible reviewer and history. Exact review/fulfillment states wait for D07.
- **People and access:** invite/assign/remove within the caller's administrative scope. Operations staff cannot grant themselves additional branches or tenant ownership.
- **Settings:** business information and approved operating rules. Subscription pricing, enterprise entitlements and AI remain outside this implementation until separately scoped.

### Branch manager

Move/reuse the current owner **Overview, Orders, Tables, Products, Menu configuration, Insights, Settings and Contact Cravio** pages with branch-scoped data. Existing inventory/management/assistant preview pages are not automatically promoted into v2 requirements.

- **Products/menu:** categories, item prices, photos/videos, themes, sold-out controls, pairings and table QR links. FR-001–FR-009, FR-025.
- **Inventory tab:** item/unit, current quantity, last change, change source and time; enter opening stock or an adjustment with the agreed reasons. Manual sold-out status and quantity-based availability must be shown distinctly. FR-015–FR-019, FR-023.
- **Stock requests:** request product quantities, review status and see the agreed response. A request alone does not change stock. FR-020.
- **Branch team/settings:** only permissions approved in D02; no company-wide ownership, billing or global account suspension powers.

The source PRD explicitly supports branch managers editing local menu prices and items. A central product catalogue can help comparisons, but must not silently remove these capabilities or impose global price synchronization.

### Waiter

Retain the mobile table/service workflow and existing cart confirmation/manual-order screens. Each order, table, request and notification must belong to an assigned branch. Present quantity/availability failures clearly without confirming an order that failed. No unrestricted stock adjustments or cross-branch reports. Determine permitted cancellation behavior through D05 rather than expanding existing privileges accidentally.

### Guest menu

Preserve branch/table-specific QR links, menu presentation, pairings, cart submission, waiter call and bill request. Recheck authoritative prices and availability on the server; browser quantities are not inventory authority. A guest is a public/session actor, not a fifth staff profile role.

Keep shared-table multi-device behavior open (D08). Do not infer shared cart ownership, order visibility across diners, automatic thirty-minute expiration, supported group size or cross-visit session continuity from the current code. Validate whether existing behavior meets the selected release rule.

### Platform admin

Reuse existing platform views for restaurant/business onboarding, accounts and support after reviewing their actual powers. Update terminology and hierarchy to distinguish business → branches → staff. Tenant operational records are not automatically exposed because someone can manage platform accounts. Any support access requires an explicit agreed capability and audit trail; defaulting to impersonation is not part of this plan. D02 governs final authority.

## 3. Repository findings and reuse

Base: `dev` commit `e0de46635182613b9536b122d5aa42e3c9228dcc`. These are static code findings, not new runtime acceptance results.

| Area | Current foundation | Required change |
| --- | --- | --- |
| Dashboard routing | `frontend/src/App.jsx`, `config/dashboards.js`, `DashboardLayout.jsx` route by admin/owner/waiter | Separate owner oversight from branch manager; authorize context instead of global role alone; update links/prefetch |
| Account routing | `frontend/src/lib/auth.jsx` and backend `/api/me` expose a primary restaurant | Return memberships/capabilities and valid landing context; branch switch with scoped caches |
| Restaurant structure | Migration 002 has owner/manager/waiter memberships and a unique restaurant-per-owner index | Introduce business/location relationships without breaking old restaurant/guest IDs |
| Role model | `profiles.role` has admin/owner/waiter; current branch managers also use owner profile role | Resolve tenant ownership, operations grants and branch roles separately; reviewed legacy mapping |
| Authorization | `restaurant.js` ownerContext and `lib/operations.js` select primary memberships | Require explicit authorized branch for reads and writes; cover reports/media/exports too |
| Service | Orders, tables, guest menu, waiter and menu media already have implementations | Reuse and verify against the PRD; do not replace working flows with placeholders |
| Inventory preview | Migration 007 and `routes/inventory.js` use a separate account-owned workspace; manual stock events do not deduct from service orders | Decide explicit reuse/mapping; add agreed order-to-stock atomic behavior; no silent adoption of bakery flows |
| Concurrency | Preview commands serialize by caller user ID | Shared stock must serialize by shared business/branch/product resource or equivalent database locking |
| Payments | Existing code records staff-entered payment status | Preserve accurate wording; no claim of payment verification or new checkout scope |

## 4. Permissions and account migration

Proposed enforcement: authenticate → resolve business membership → validate branch assignment → validate action capability → authorize referenced resources. Hiding a menu entry is not authorization. A user may hold different roles at different branches; do not solve this with five mutually exclusive profile strings.

| Action | Owner/operations interface | Branch manager | Waiter | Guest | Platform admin |
| --- | --- | --- | --- | --- | --- |
| Set up business/branches | Actual owner or explicitly granted operator | No | No | No | Onboarding authority to agree |
| View branch stock/reports | Assigned branches | Assigned branch(es) | Only service-relevant availability | Published availability | Explicit support authority only |
| Change menu/price | If also granted branch management | Assigned branch | No | No | Not implied |
| Enter/adjust stock | Explicit grant within assigned scope | Per agreed stock policy | Not by default | No | Not implied |
| Submit stock request | If granted branch capability | Assigned branch | No | No | No by default |
| Review/fulfill requests | Approved workflow grant | As agreed | No | No | No by default |
| Manage table service | Branch service grant | Assigned branch | Assigned branch tasks | Own permitted table/session actions | Not implied |
| Grant access | Within explicit administrative scope | Branch staff only if agreed | No | No | Platform powers to agree |

Migration design, before writing schema changes:

1. Produce a read-only mapping of existing accounts, profiles, memberships, restaurants and preview inventory. Identify actual business owners and branch managers; profile `owner` is insufficient evidence.
2. Create reviewed business-to-branch and account-to-role assignments. Never group unrelated restaurants by similar names or email domains.
3. Preserve all restaurant/menu/table/order IDs and ownership references needed by the old baseline. Add business and branch links first; do not mass-rename foreign keys or change `owner_id` to mean manager.
4. Map legacy owner-screen users to branch-manager landing pages. Grant new owner/operations access only from the reviewed assignments. Single-site business owners may hold both grants.
5. Preserve admin and waiter access. Existing owner deep links should resolve to the appropriate branch route where unambiguous; otherwise show an authorized branch chooser. Do not redirect branch-only staff into a company-wide owner page.
6. Migrate onboarding, staff invitations, account recovery, suspension/revocation, media policies and report contexts alongside routes. Revoke stale scope and clear cached branch data on switch/sign-out.
7. Validate and rehearse rollback before applying changes. Disabling the new interface must not delete stock or ownership history. Exact cutover and migration files depend on D02 and the current database audit.

Business administration is not being removed from real owners; local operations are being moved to the branch workspace. The migration must preserve ownership while separating it from day-to-day manager access.

## 5. Restaurant inventory design

Confirmed dimension: **product quantity per branch**. No batch/serial tracking, bakery production line or warehouse dashboard is required. The PRD describes portions; define each product's unit under D03, without inventing recipes or cake-slice conversions.

Proposed records:

- Business, branch and user memberships/assignments.
- Existing branch menu item, plus an explicit stock item mapping where needed; allow non-tracked menu items rather than treating missing stock as zero.
- Stock balance by branch/product; if the selected lifecycle reserves stock, distinguish on-hand, reserved and available.
- Append-only stock event: branch, product, signed quantity/unit, reason, actor, occurred/recorded timestamps, source and correction reference.
- Order-stock effect keyed to order line/action/version so retries, guest confirmation and manual waiter orders cannot deduct twice.
- Branch stock request and its event history. Requested, approved and actually fulfilled quantities stay distinct if those steps are selected.

Reconciliation: opening + approved receipts/additions − agreed order consumption − waste ± corrections = expected stock. Reservation affects available quantity without being counted as consumption twice. A daily opening entry must not silently reset or overwrite remaining stock; D03 defines whether this means a counted balance or newly added portions.

### Lifecycle decisions that must precede implementation

| Event | Required decision / implementation invariant |
| --- | --- |
| Guest cart submit or edit | Does this reserve anything? Current cart submission is not equivalent to a waiter-confirmed order. No policy assumed. |
| Waiter confirmation/manual order | Candidate reservation/deduction point; select in D04. Check all lines atomically. |
| Served / paid | Determine whether either changes stock. Never deduct again merely because the order advances. Payment status is not automatically stock authority. |
| Cancellation before/after service | D05 decides restock versus consumed/waste; cancellation is not proof physical food returned. |
| Quantity changes/substitutions | Apply only the net effect with source history and an authorized correction. |
| Stock reaches zero | D06 decides guest display, blocking, notifications and manager override. Define interaction with manual sold-out. |
| Stock request submitted/approved | Neither changes balances unless an explicit agreed stock event happens. Approval is not proof of receipt. |
| Request fulfilled/received | D07 defines source and evidence. Do not invent a warehouse or inter-branch dispatch chain. |

At the chosen stock-affecting event, the order transition, stock changes and audit entries must commit consistently or fail together. Handle retries, two waiters ordering the last portion, stale guest menus and multi-item failure without partial stock corruption. Apply locks/constraints to shared stock resources, not the staff user ID.

Existing extras, deals and bundles need mapping decisions before stock effects; do not deduct both a bundle and its component items by accident. External POS sales import is not required by this PRD and must not become a prerequisite to delivering Cravio-order-linked stock.

## 6. Phases and reviewable deliverables

The five-interface architecture is confirmed; exact first-release feature membership remains open. No dates, budgets or approved client commitments are inferred. All future implementation belongs on `v2-dev` until review.

| Phase | Deliverable | Dependencies | Acceptance evidence |
| --- | --- | --- | --- |
| 0 — Requirements and baseline | Five-interface page map, FR register, decision answers, existing-flow review and account-migration mapping | Supplied PRD; D01–D03, D08 release decisions | Source status separate from tested status; named decisions and concrete menu/order/stock examples |
| 1 — Membership foundation | Business/branch identities, scoped capabilities, account context and migration rehearsal | D02, reviewed mappings | Two unrelated businesses isolated; multiple assigned branches work; legacy owner lands in correct branch; no accidental operations access |
| 2 — Five interfaces | New owner overview, moved branch-manager service pages, retained waiter/guest/admin with scoped navigation | Phase 1; D01, D02 | End-to-end menu setup → table QR → guest request/order → waiter handling; branch switching never leaks data |
| 3 — Restaurant stock | Branch inventory entry/view/history and agreed order lifecycle effects | D03–D06; phase 2 | Stock examples reconcile; retries/concurrent orders and cancellations behave under agreed rules; FR-015–FR-019 and selected FR-023 |
| 4 — Operations oversight and requests | Assigned-branch aggregates, requests and agreed review/fulfillment behavior | D07; phases 1–3 | Request visibility and actions follow assignments; quantities are not changed merely by approval; FR-020/FR-021 |
| 5 — Demonstration and acceptance | Local run instructions, reviewed menu content/media, role walkthrough and release checks | D01, D08–D13 as applicable | Named evaluator accepts selected scenarios; main merge remains a separate explicit user action |

FR-022 authorization accompanies every phase, not a final add-on. Validate FR-005/FR-025 media rules once D09 is answered. Shared-table FR-014 requires an explicit inclusion/exclusion decision and selected behavior before its release test is accepted. Basic owner navigation can ship before advanced branch comparison; complete request fulfillment cannot be claimed while D07 is open.

Suggested work packages:

1. **V2-01:** requirements decisions and existing code acceptance baseline; docs/evidence only.
2. **V2-02:** membership/scoping and compatible migration, including API, policies and tests.
3. **V2-03:** branch-manager routing and legacy landing migration; reuse current owner pages.
4. **V2-04:** owner/operations location management and scoped overview; no fabricated metrics.
5. **V2-05:** product/branch stock entry, ledger and stock mapping.
6. **V2-06:** transactional order-stock effects under selected D04–D06 rules.
7. **V2-07:** stock requests and scoped operations review under D07.
8. **V2-08:** waiter/guest/admin regression, media policy, chosen shared-table behavior and demo handoff.

Do not implement speculative stock lifecycle behavior to make a page appear complete. Independent work may proceed after implementation is separately authorized; unresolved decisions block their dependent packages only.

## 7. Verification and release boundary

- Access matrix: actual owner, assigned operations manager, branch managers at A/B, multi-branch staff, waiter, guest and platform admin. Test direct API access, ID substitution, exports/media and revocation, not only navigation.
- Migration: preserve existing ownership/history and guest QR URLs; managers cannot become owners by editing profiles; old links resolve safely.
- Service: category/item/price/media/pairing changes, manual sold-out, table QR, waiter call, bill request and waiter-confirmed/manual orders.
- Stock: opening versus addition; last-portion race; duplicate request; multi-line rollback; cancellation before/after selected stock event; stale count and authorized correction; unmapped menu item, deal and extras.
- Shared table: test only explicitly selected session/device/visibility rules, including table reuse and malicious or accidental cross-table requests.
- Operations: requests and reports stay within assigned branches; all aggregation periods/units/data coverage are clear.
- UI: existing design, mobile waiter/guest flows, keyboard access and loading/error/empty states. No dummy numbers presented as actual branch performance.
- Main remains unchanged until an explicit merge decision after review. Code ports do not isolate the shared database. Plan compatible migrations and disposable test fixtures; do not seed customer data or run broad mutation suites against the shared environment.

The branch already contains the earlier preview code inherited from dev. This planning commit does not implement the five interfaces, migrate users, change the shared database, or certify the inherited preview for restaurant deployment.

## 8. Deferred or excluded

Fayaz bakery workflows, warehouse dashboard, batch/serial tracking, ingredients/recipes/procurement, mandatory external POS integration, payment processing/eTIMS, offline guarantees, new commercial packages and live AI are outside this plan's implementation scope. Stock requests are included as a requirement; a warehouse dispatch/receipt engine is not thereby approved. Existing inherited preview features may remain until an explicit replacement/migration decision; do not delete their data merely because they are outside the target release.

OpenRouter remains a visibly labelled placeholder. Future assistance must respect the same branch permissions and use actual reporting calculations, but AI is not a dependency for the five-interface work.
