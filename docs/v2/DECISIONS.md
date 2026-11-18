# Cravio v2 — decisions before implementation

16 November 2026. Planning register, not a client questionnaire already answered or distributed. Source question references are from the supplied PRD; the prompts here are our development-focused summaries.

## Settled by the user

- Five interfaces: owner/operations manager, branch manager, waiter, guest menu and platform admin.
- Existing owner operational screens move to branch managers. New owner oversight covers multiple assigned branches.
- Track product quantities by branch, not batches or individually serialized products.
- General Cravio product; Fayaz custom bakery software is excluded. Liwaza is a prospective adopter, not a signed deployment.
- Use `v2-dev` for the new work; this delivery is documents only. Do not merge into main.
- Preserve the current visual design. OpenRouter remains a placeholder.
- Existing main/dev comparison uses the same database. A second machine does not isolate that data.

## Open decisions

| ID | Question to resolve | Who decides | Blocks | PRD reference |
| --- | --- | --- | --- | --- |
| D01 | Which requirements belong to the first release? In particular, are full branch requests and multi-device shared tables included? | Product owner, adopter reviewer for acceptance | Release checklist and phase boundaries | Q-001, Q-002 |
| D02 | Which accounts are actual business owners, delegated operations managers, branch managers and platform admins? What can each grant, edit, suspend and view? Supply a reviewed mapping, including staff assigned to several branches. | Product owner and authorized business representative | Role migration, invitations, location administration and admin support access | Q-008; latest user role correction |
| D03 | For each tracked product, what unit is counted? Does opening quantity mean a counted balance or added portions? How do menu variants, extras/deals and untracked items map to stock? Are direct stock additions needed? | Product owner and restaurant operator | Product mapping, opening entry and stock arithmetic | Q-003; branch quantity depth already confirmed |
| D04 | At which event is stock reserved/deducted: guest submission, waiter confirmation, serving or another event? If reserved, when is it released? | Product owner and restaurant operator | Order-stock integration | Q-004 |
| D05 | What happens to stock on cancellation, reduced quantities, substitutions and food already prepared/served? Who may correct stock and with what evidence? | Restaurant operator and product owner | Restock/waste/correction implementation | Q-005 |
| D06 | At zero quantity, block ordering, hide the item or show sold out? Are overrides allowed? How does manual sold-out interact with positive quantity? Who receives a notification and through which channel? | Product owner and restaurant operator | Guest/waiter availability and notifications | Q-006 |
| D07 | Who receives branch stock requests? Can they partially approve, reject or revise them? Where does fulfillment come from, who confirms it and what event changes stock? | Product owner and enterprise operator | Request state machine and fulfillment | Q-007 |
| D08 | For several devices at one table, are carts separate or shared; who sees/confirms which orders; what happens on table change, revisit or closure? Is this in the first release? | Product owner and service reviewer | Shared-table scope and session acceptance | Q-002, Q-013 |
| D09 | What media formats, dimensions and sizes are allowed; how are invalid files handled before publication? Who validates menu content? | Product/content owner | Final media rules and content acceptance | Q-009 |
| D10 | Confirm the release boundary around bill requests and existing manually recorded payments. Is any new invoice, payment or external POS capability required? If yes, scope it separately with a named system. | Product owner | Prevents invented integration/checkout scope | Q-010 |
| D11 | Which staff/guest devices and network conditions must be supported? Is offline operation requested? Do not imply an offline guarantee without design work. | Product owner and pilot operator | Device acceptance and any offline design | Q-011 |
| D12 | Who accepts the pilot, which branches/products are included, and which stock/service examples and thresholds prove acceptance? | Product owner and named adopter reviewer | Rollout acceptance | Q-012 |
| D13 | What refresh, performance, language, support, recovery and retention targets are required? What constitutes a table visit? | Product owner and technical/operational reviewers | Non-functional tests and session lifecycle | Q-013, U-10 |

D02–D06 are the most immediate design inputs. The existing app's behavior is evidence to inspect, not an automatic answer. No silence or preselected option constitutes agreement.

Commercial U-07 and scheduling U-08 remain open. This branch does not infer prices/currency, enterprise tier boundaries, calendar deadlines or support commitments from the draft PRD.

## Recommendations implemented on v2-dev (NOT confirmed decisions)

Added 16 Nov 2026 with the first implementation slice (V2-02/03/04). Each is reversible and marked in code; confirm or correct under D02.

| Ref | Recommendation in code | Where |
| --- | --- | --- |
| R1 | Branch access comes only from `restaurant_members`; a legacy `owner` membership means branch manager. Profile role `owner` never implies business access. | `backend/src/lib/access.js` |
| R2 | Business access comes only from explicit `business_members` grants (owner = all branches, operations = assigned branches). Migration 008 grants nobody. | `db/proposed/008_business_branches.sql` |
| R3 | Business owners create branches, grant/revoke operations access, assign branches and add branch staff. Operations managers only view assigned branches (overview, branch detail, staff); they cannot grant anything. Nobody changes their own access. Owner grants come only from the reviewed mapping (or a future platform-admin action). | `backend/src/lib/business.js` |
| R4 | Business owners/operations open a branch's workspace only with a branch manager role there (no impersonation). | `WorkspaceLink`, `DashboardLayout` |
| R5 | A request with several eligible branches must name one (`X-Cravio-Branch`); the server never guesses. | `selectMembership` |
| R6 | Admin “invite owner” keeps today's behaviour (creates one restaurant, owner membership → branch manager); it does not create a business-owner grant. | unchanged `admin-users.js` |
| R7 | ~~Preview pages kept under “Preview”.~~ Superseded 16 Nov 2026 by the product owner: Preview removed. Inventory is the real Inventory page; Management preview removed; the AI assistant became the Overview → Briefing tab. The old preview API and its (empty) data are untouched. | `config/dashboards.js` |

## Answer log

| Decision | Answer | Approved by/date | Evidence or example | Affected work packages |
| --- | --- | --- | --- | --- |
| D02 | owner@gmail.com is the **business owner** of Abdis Test Restaurant; manager@gmail.com its **branch manager**. Business owners see and manage their branches' managers. Business owners act as operations managers for now (R1–R7 accepted). Migration 008 approved and applied. | Product owner, 16 Nov 2026 | MIGRATION-008.md | V2-02, V2-04 |
| D03 | Unit is **servings**. Main center dispatches to branches; branches request from the center and track their own stock. | Product owner, 16 Nov 2026 | INVENTORY.md | V2-05 |
| D04 | Stock leaves **on serving**. Plan for changes (e.g. Fanta → Coke). | Product owner, 16 Nov 2026 | INVENTORY.md | V2-06 |
| D05 | The **branch manager** corrects stock. | Product owner, 16 Nov 2026 | INVENTORY.md | V2-06 |
| D06 | At zero: **show sold out**; branch manager can override. | Product owner, 16 Nov 2026 | INVENTORY.md | V2-06 |
| D07 | Requests go to the **owner**, who can approve partly or reject; follow common practice; receipt verified with a **dispatch number / QR**. | Product owner, 16 Nov 2026 | INVENTORY.md | V2-07 |
| UX | Owner sidebar: Overview (Briefing, Branches), Locations, Inventory, People & access. Assistant = a PA-style daily briefing with questions, not a separate page. No live AI yet; it answers from records and says so. | Product owner, 16 Nov 2026 | Apple HIG review (generative-ai.md › Transparency) | V2-04 |
| Admin | Platform admin revamp (product owner asked for it, 16 Nov 2026): admins see businesses → branches → staff, give or remove business-owner access, add branches and rename businesses, all audited in access_events (shown on Activity). Inviting an owner from the admin now makes them owner of the new business. Admins see counts only for inventory and no order/stock records. Recommendation to confirm: admins may grant owner access. | Product owner request; powers to confirm | INVENTORY / HANDOFF | V2-08 |
| D08 | Shared-table multi-device ordering **on hold**. | Product owner, 16 Nov 2026 | — | — |
| INV-A3/A4/A5/A8 | Inventory module (PRD v1.0), product owner answers 18 Nov 2026: **one warehouse per business** (today's main center, shown as "Warehouse"; schema keeps the door open for more later). Quantities **stored in a base unit** (g/ml/piece/serving, 4 dp) but **users choose the units they enter and see** (kg, L, crate, sack, tray… per item); unapplied 012 is rewritten. Selling past zero: **stock stops at 0**, the shortfall is logged as a stock exception **and the owner and the branch manager are notified**. Recipes edited by the **owner (all branches) and branch manager (own branch)**. Supersedes D03 (servings only) and D06 (negative balance). | Product owner, 18 Nov 2026 | docs/inventory-kb/07, 08 | Phase 1 (P1-05, P1-09, P1-14/16) |
| INV-A1/A2/A6/A7 | Accepted as defaults by the product owner ("proceed", 18 Nov 2026): **inventory module only** (M-Pesa, eTIMS, shifts/KDS, offline = later separate modules); the **owner acts as head office, procurement and warehouse** (warehouse staff role optional at end of Phase 3); **approving a branch request reserves stock** at the warehouse; cost method starts as **weighted average** (batch/FIFO with batches in Phase 3). | Product owner, 18 Nov 2026 | docs/inventory-kb/09, 10 | Phase 2/3 |
| D01, D09–D13 | Open | | | |

Record answers here and revise the implementation plan before implementing affected behavior. Preserve the original question and evidence trail when a decision changes.
