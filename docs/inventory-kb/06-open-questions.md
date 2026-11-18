# 06 · Open questions before the implementation plan

Each has a **recommended default** so planning can move; confirm or correct in discussion.

**18 Nov 2026 (product owner):** Q-L1 → **one warehouse per business** for now; Q-U1 → base-unit storage **with user-chosen entry/display units**; Q-N1 → **stop at 0, log the shortfall and notify owner + branch manager**; Q-N2/A8 → owner + branch manager edit recipes. See `docs/v2/DECISIONS.md` (INV-A3/A4/A5/A8). **18 Nov 2026 (product owner, second round, INV-P2/P3):** self-approval allowed for a sole owner (flagged); **no built-in limits or thresholds** (emergency-buy limits and wastage/adjustment/count approval thresholds are owner-set, safe defaults until then); AI insights layer with per-business limits; Reports and Receipts tabs; PDFs via browser print first. The rest stay open until Phase 2.

| ID | Question | Recommended default | Why it matters |
| --- | --- | --- | --- |
| Q-S1 | **Scope**: is this the inventory module only (items, units, ledger, warehouses, requests/transfers, suppliers/purchasing, emergency buys, recipes/costing, wastage/counts, reports) — or also the PRD's POS extras, M-Pesa, eTIMS and offline? | Inventory module now; M-Pesa, eTIMS, shifts/KDS and offline as **separate later modules** | The PRD is a whole platform; inventory alone is already large |
| Q-A1 | **Roles**: map PRD's 9 roles onto Cravio's 5 interfaces, or add roles? | Owner ≈ Super Admin + Head Office + Procurement + Finance (with `operations` as read-mostly). Branch manager as is. Add **warehouse staff** later as a location-scoped role. Fine-grained permissions table behind the scenes | Drives schema (permissions) and navigation |
| Q-A2 | Where do warehouse staff work? | Owner area, scoped to their warehouse(s) (no 6th interface yet) | |
| Q-L1 | Warehouses: several per business, replacing the single "main center"? | Yes — `stock_locations.kind` gains `warehouse`; existing center becomes the first warehouse | ORG-1, TRF-1 |
| Q-U1 | Store quantities in a **base unit** (g/ml/pc) with 4 dp, rather than 012's per-item unit with 3 dp? | Yes — rewrite 012 before it's applied (it isn't yet) | Cheap now, data migration later |
| Q-U2 | Several purchase units per item (sack, packet, crate) instead of one pack? | Yes (`item_unit_conversions`) | UOM-2 |
| Q-N1 | Override when out: allow negative (current D06) or block negative and log an exception (PRD)? | PRD: sell, log shortfall exception, stock floors at 0 — *or* keep current; owner decides | Changes the serve trigger |
| Q-N2 | Recipes under Menu or Operations? | Operations → "Items & recipes" for owner; read/edit on branch under Menu | Nav |
| Q-R1 | Does approving a request **reserve** at the source warehouse? | Yes (PRD REQ-3) | Changes request flow and balances |
| Q-R2 | Who approves branch requests: owner only, or warehouse manager? | Owner now; warehouse manager when that role exists | |
| Q-C1 | Cost method | Weighted average first (simple, no batches needed); FIFO/batch cost when batches arrive | Batches are a big chunk; costing shouldn't wait for them |
| Q-B1 | Batches/expiry/FEFO in the first slice? | No — phase after purchasing; add `batch_id` nullable to ledger now | BAT is P0 in PRD but heavy |
| Q-V1 | Recipe versioning in the first slice? | Yes, minimal: order lines snapshot `recipe_version_id` | Needed for correct history and costing |
| Q-P1 | Emergency purchase thresholds: per branch, per category, per period? | **Answered 18 Nov:** owner sets them per branch (per purchase, day, week; optional category) in Settings → Inventory; no built-in amounts; none set = every buy needs approval (D2-6) | EMP-1 |
| Q-P2 | Purchase evidence uploads (invoice photo) — storage? | Supabase Storage bucket (already used for menu media) | EMP-3, GRN-2 |
| Q-M1 | What happens to the v3-dev branch? | Keep as reference only; don't merge (it reverts main's real pages to sample data) | |
| Q-M2 | Remove the legacy 007 preview API (`routes/inventory.js`, `private.stock_*`)? | Yes, in a cleanup step, after confirming its tables are empty | Avoids confusion with 009 |
| Q-T1 | Which business/branches pilot, and with what real items/recipes? | — | Acceptance (PRD T-* suite) |

## Added 18 Nov 2026 (second round)

**Open, with a proposed default recorded (DECISIONS INV-P2D, 18 Nov 2026):** Q2-3 returns to the Warehouse need no approval (D2-12); Q2-4 over-delivery tolerance 5 % and price-variance alert 10 % (D2-11, D2-13); Q2-5 a supplier may deliver straight to a branch (default yes). Work proceeds on these defaults; each is a setting or a one-line change.

**Answered** (see `docs/v2/DECISIONS.md` INV-P2/P3): Q2-1 own-PO approval (yes for a sole owner, flagged `self_approved`); Q2-2 emergency limits (owner-set, none built in); Q3-1 approval thresholds (owner-set, per business with branch override; defaults until set: emergency buys need approval, wastage free, adjustments approved, one approval per count with any variance, D2-16); Q3-3 PDF library (browser Save as PDF first; `pdfkit` only for emailed/scheduled reports, optional P3-39); where Reports and Receipts live (owner sidebar group **Reports**).

**Phase 3 (recorded by P3-01, 18 Nov 2026; DECISIONS `INV-P3` answered, `INV-P3D` proposed):** answered — Q3-1 approval thresholds (owner-set, nothing built in), Q3-3 PDFs (browser Save as PDF first). **Still open, each with a proposed default so work proceeds:** Q3-2 staff-meal / complimentary allowances (per branch per day, portions or KES; **off until the owner sets them**; who may give complimentaries: branch manager and owner); Q3-4 which items carry expiry tracking first and whether any is mandatory (default: none mandatory, owner switches items on; dairy, chicken and sauces suggested first); Q3-5 whether batch costing is offered in Release D (default: yes as an owner-confirmed going-forward switch, weighted average stays the default); Q3-6 pilot business and branch for the 7-day reconciliation soak (06 Q-T1); Q3-7 warehouse-staff role before go-live (default: no, optional P3-36). The Q-AI-* questions below are unchanged.

| ID | Question | Recommended default | Why it matters |
| --- | --- | --- | --- |
| Q-AI-1 | **Who pays for AI?** Cravio absorbs it in the subscription (admin sets a modest allowance per business) or it is a paid add-on / owner buys more? | Absorb at first, small allowance; revisit after the pilot cost soak (P3-44) | Sets the default allowance and whether a "raise my allowance" flow is needed |
| Q-AI-2 | **Which model?** | `openai/gpt-4o-mini` via OpenRouter (cheap, adequate for restating figures); configurable by env and per feature; bake-off on the golden dataset | Cost and wording quality |
| Q-AI-3 | **Default monthly allowance** (KES budget as designed, or a token budget)? | Decide after measuring one pilot business for a week; roughly 2× real use | Prevents surprise bills and unusable "used up" messages |
| Q-AI-4 | Daily insight time and whether the owner can turn the daily run off but keep "Ask" | 06:00 Africa/Nairobi, separate switches | Cost and annoyance |
| Q-AI-5 | Free-text questions to the AI? | Not in v1 (fixed question list) | Validation, abuse and cost |
| Q-AI-6 | Counsel sign-off on sending business aggregates to OpenRouter under the Kenya DPA 2019 (no personal data is sent) and the privacy policy wording | Confirm before the first paying business uses AI | Legal |
| Q-R3 | Should the **Receipts** tab also include **customer bills / sale receipts**? | No: supplier and stock documents only; customer receipts belong to the later POS/eTIMS module | Scope of the Receipts list and storage |
| Q-L2 | Would the owner like Cravio to **suggest** starting limits/thresholds from the first weeks of real spend, wastage and counts? | Maybe after the pilot; for now only a "Set your limits" prompt | Reduces the burden of setting numbers; must stay the owner's decision |

