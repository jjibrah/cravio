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
| R7 | Inherited inventory/management/AI preview pages stay reachable only under the owner interface's “Preview” group; their data and API are untouched. | `config/dashboards.js` |

## Answer log

| Decision | Answer | Approved by/date | Evidence or example | Affected work packages |
| --- | --- | --- | --- | --- |
| D01–D13 | Open; fill individually when answered | | | |

Record answers here and revise the implementation plan before implementing affected behavior. Preserve the original question and evidence trail when a decision changes.
