# Cravio v2 — supplied PRD context

Recorded 16 November 2026. Internal to Amanah Devs. This is a structured extraction of the PRD pasted by the user, not a verbatim replacement for its original document or an independently verified client agreement.

## Source and precedence

The supplied source is **CRAVIO — Internal Product Requirements Document — Draft v0.1**, dated 14 November 2026, prepared by Alice. It reports one generated meeting digest (M01) and team corrections (d2), with 25 functional requirements: 17 confirmed, 3 proposed and 5 to confirm. “Confirmed” means discovery evidence, not implementation, tests, contractual acceptance or release membership.

The original M01, d1, d2, PROPOSAL.md and QUESTIONS.md files were not supplied here. Their reference IDs remain source references; this repository does not claim to contain or have verified those originals. The original Q-001–Q-013 question wording is not reconstructed as a quotation.

Latest user instructions govern this development handoff:

- Plan exactly five interfaces: owner, branch manager, waiter, guest menu and platform admin.
- Existing owner dashboard functionality becomes branch-manager functionality; the new owner is the operations manager overseeing multiple assigned branches.
- Inventory tracks product quantities by branch. This resolves tracking depth, not every unit, stock timing or order exception rule.
- Plan only. Push the plan and current code base to a separate `v2-dev` branch for development on another device. Do not implement the plan or merge into main.
- OpenRouter remains a placeholder; no live AI feature is authorized in this task.

The PRD's older U-09/D-05 instruction to leave the repository unlinked applied to its documentation exercise. The current explicit request authorizes this repository branch handoff; it does not establish a client contract or approval to contact Liwaza.

## Business and release boundaries

- Cravio is the general restaurant platform; Amanah Devs is supplied project-owner metadata, not verified legal/contracting information.
- Liwaza is a prospective adopter, conditional on suitable restaurant inventory. Restaurant count, sites, decision maker, SOP and acceptance criteria are not verified.
- Fayaz's custom bakery software belongs to a separate project (PRJ-0002). Do not import its warehouse dispatch approvals, retail POS adaptation, cross-business inventory or invoicing into Cravio.
- The digital menu is the core selling point. Existing owner/menu/waiter flows were reported as demonstrated. This handoff supplements those reports with a limited code review, not a claim of production readiness.
- Release membership remains Q-001. Shared-table multi-device behavior remains undecided under Q-002; do not silently include or defer it.
- Ingredient recipes, procurement, payment processing, tax invoicing, offline operation and physical POS hardware are not committed. Neither advanced sessions/timeouts nor WebP optimization is a launch promise.
- Internal pricing figures, currency/tax, tier boundaries, revenue target basis/year and relative Tuesday/Wednesday deadlines are unconfirmed. This plan sets no price or delivery date and does not implement billing entitlements from those figures.

## Functional requirement register

Priority and status are retained from the supplied PRD. “Must” does not itself place an item in the first release.

| ID | Requirement summary | Role | Priority | Evidence status | Source |
| --- | --- | --- | --- | --- | --- |
| FR-001 | Configure menu categories | Branch manager | Must | Confirmed | M01 |
| FR-002 | Create/edit menu items | Branch manager | Must | Confirmed | M01 |
| FR-003 | Select menu layouts/themes | Branch manager | Should | Confirmed | M01 |
| FR-004 | Attach photos/videos to items | Branch manager | Must | Confirmed | M01 |
| FR-005 | Validate image/logo dimensions/formats against agreed policy | Branch manager | Must | To confirm | M01, Q-009 |
| FR-006 | Change item prices | Branch manager | Must | Confirmed | M01 |
| FR-007 | Mark items sold out | Branch manager | Must | Confirmed | M01 |
| FR-008 | Display configured suggestions/pairings | Guest | Must | Confirmed | M01 |
| FR-009 | Generate table-specific QR codes | Branch manager | Must | Confirmed | M01 |
| FR-010 | Display menu after table QR scan | Guest | Must | Confirmed | M01 |
| FR-011 | Associate table-menu order with table in waiter view | Guest/waiter | Must | Confirmed | M01 |
| FR-012 | Request waiter assistance | Guest | Must | Confirmed | M01 |
| FR-013 | Request bill | Guest | Must | Confirmed | M01 |
| FR-014 | Support several guest devices at a table if selected for launch | Guest/waiter | Must | To confirm | U-03, Q-002 |
| FR-015 | Authorized staff enter available portion-based product quantity | Branch manager | Must | Confirmed | M01 |
| FR-016 | Reduce availability at agreed order lifecycle event | Restaurant staff | Must | To confirm | M01, Q-004 |
| FR-017 | Restore/adjust stock for cancellations and changes under agreed rules | Restaurant staff | Must | To confirm | P-01, Q-005 |
| FR-018 | Apply agreed ordering/notification rule at zero stock | Guest/manager | Must | To confirm | M01, Q-006 |
| FR-019 | Manager inventory tab shows restaurant product availability | Branch manager | Must | Confirmed | M01 |
| FR-020 | Enterprise branch managers submit stock requests | Branch manager | Should | Confirmed | M01 |
| FR-021 | Operations view across assigned enterprise branches | Owner/operations manager | Should | Confirmed | M01 |
| FR-022 | Authorize every protected request against branch permissions | All staff | Must | Proposed | P-01, RS-01 |
| FR-023 | Record adjustment actor, change, time and reason | Manager | Should | Proposed | P-01 |
| FR-024 | Provide locally runnable inventory demonstration | Team/evaluator | Must | Confirmed | M01, U-02 |
| FR-025 | Check media type/size before guest publication | Menu manager | Must | Proposed | P-01, RS-02 |

## Open decisions carried forward

| Source reference | Topic, summarized from the supplied PRD |
| --- | --- |
| Q-001 | Which features are included in the first release? |
| Q-002 | Shared table: devices, ownership/visibility of orders and supported group behavior |
| Q-003 | Inventory units/model; quantities by branch are confirmed, portion/unit semantics remain open |
| Q-004 | Order event that reserves/deducts stock |
| Q-005 | Cancellation, edits, shortage, waste and correction behavior |
| Q-006 | Behavior and notification when stock reaches zero |
| Q-007 | Branch request recipients, lifecycle and fulfillment rules |
| Q-008 | Admin and staff authority, assignment and branch visibility |
| Q-009 | Media dimensions, formats, sizes and publication policy |
| Q-010 | Bill requests versus payments, invoicing and integrations |
| Q-011 | Devices, connectivity and offline expectations |
| Q-012 | Named adopter reviewer, pilot and acceptance criteria |
| Q-013 | Refresh behavior and table/visit lifecycle |

Team clarifications still open: U-07 commercial currency/tier/tax/target details; U-08 exact action dates, timezone, completion and inventory input ownership; U-10 languages, measurable performance/support/recovery targets and supplier identity.

Original research references describe OWASP authorization/file upload guidance, ODPC principles and KRA eTIMS scoping. This handoff does not extend those into a legal determination, a payment integration requirement or a fresh external research review.

## Relationship to repository evidence

The supplied PRD did not audit this repository. The inherited `dev` base has working service code and an account-owner inventory preview, documented in `docs/INVENTORY-PREVIEW.md`. That preview is separate from the order lifecycle and is not proof FR-016/FR-017 or the five-interface model are delivered. The implementation plan records reuse and gaps separately from source status.
