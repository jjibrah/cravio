# 06 · Open questions before the implementation plan

Each has a **recommended default** so planning can move; confirm or correct in discussion.

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
| Q-P1 | Emergency purchase thresholds: per branch, per category, per period? | Per branch per transaction + per week to start; config table | EMP-1 |
| Q-P2 | Purchase evidence uploads (invoice photo) — storage? | Supabase Storage bucket (already used for menu media) | EMP-3, GRN-2 |
| Q-M1 | What happens to the v3-dev branch? | Keep as reference only; don't merge (it reverts main's real pages to sample data) | |
| Q-M2 | Remove the legacy 007 preview API (`routes/inventory.js`, `private.stock_*`)? | Yes, in a cleanup step, after confirming its tables are empty | Avoids confusion with 009 |
| Q-T1 | Which business/branches pilot, and with what real items/recipes? | — | Acceptance (PRD T-* suite) |
