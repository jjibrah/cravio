# 04 · PRD vs code: gap analysis

Legend: ✅ built on main · 🟡 partial, or built differently · ⏳ written but not applied (012) · 🧪 only in the v3-dev mock · ❌ missing

## Inventory core (the module we're adding)

| PRD area | Status | Notes |
| --- | --- | --- |
| Org → locations with type (ORG-1/2) | 🟡 | `stock_locations.kind` = center/branch, **one center per business**. Needs `warehouse` (many) and probably `head_office`. Branches are `restaurants`. |
| Location settings that inherit from the org (ORG-5) | ❌ | No settings table for thresholds or policies |
| Item types, SKU, barcode, category tree (5.1/5.2) | ❌ | `stock_items` = name, unit, low level only |
| Units, base unit, conversions (UOM-1..7) | ⏳🧪 | 012 has fixed units and no density; v3-dev uses base units. Units and factors are **code, not config**, which breaks UOM-6 |
| Per-item packaging conversions (UOM-2) | ⏳ | One pack per item in 012. The PRD wants several purchase units per item |
| Ledger: append-only, typed, idempotent (LED-1..3,6) | 🟡 | Exists. Missing: unit cost, batch, counterparty location, device, `occurred_at`, reversal type, and the typed list (staff meal, comp, production, supplier return…) |
| Balances in the same transaction (LED-4) | ✅ | `lockBalance` + `move` |
| Reserved / available / in-transit (7.1) | 🟡 | "Held" is computed from orders. There's no reserved column and nothing reserves for requests or production. In-transit lives on the transfer lines |
| Reconciliation job (LED-5) | ❌ | `balance_after` makes it possible, but nothing schedules it |
| Negative stock blocked (LED-7) | ❌ **conflict** | Main lets "keep selling" go negative. PRD default: sell, but log the shortfall as an exception |
| Period close (LED-8, P1) | ❌ | |
| Batches, FEFO, expiry, traceability (BAT-1..4) | ❌ | Not started anywhere |
| Location stock views, filters, CSV (7.4) | 🟡 | Owner sees center + branch columns. No consolidated filters, days on hand, value or export |
| Requests: lifecycle & approval (REQ-1..3) | 🟡 | Fewer statuses. **Approval doesn't reserve.** There's no choice of source warehouse and no split |
| Pick / prepare (REQ-4) | ❌ | |
| Dispatch → in-transit, delivery note (REQ-5) | ✅ | Number, code, QR, printable note |
| Receive with discrepancy (REQ-6/7) | 🟡 | Short only, with a note. No damaged or over-delivery, no notifications, no batch or cost carried |
| Transfer types (TRF-1) | 🟡 | Center → branch only |
| Discrepancy review: who bears the loss (TRF-3) | ❌ | |
| Suppliers (SUP-1..3) | 🧪 | v3-dev uses free-text supplier names only |
| POs, approval bands (PRC-1..4) | ❌ | |
| Goods receipt with batch, expiry, cost, invoice (GRN-1..3,6) | 🧪 | The v3-dev "purchase" is a simplified GRN without a PO |
| Supplier returns (PRC-6) | ❌ | |
| Emergency branch procurement (EMP-1..4,6) | ❌ | v3-dev's purchases tab is the closest thing |
| Recipes, multi-line (RCP-1) | ⏳🧪 | |
| Recipe versions (RCP-2) | ❌ | 012 overwrites a recipe in place. **Needed before costing history means anything** |
| Sub-recipes / prepared items (RCP-3) | ❌ | |
| Yield (RCP-4) | 🧪 | |
| Recipe cost, food cost % (RCP-5, CST-5) | 🧪 | |
| Modifiers/variants with ingredient effect (MNU-2/3, RCP-6) | ❌ | Extras exist (004) but are untracked |
| Combos sum their components (MNU-4) | ✅ | Deals use component recipes |
| Production batches (PRD-1/2) | ❌ | |
| Reserve on accept, commit on serve, idempotent (12.2) | ✅ | Implemented with DB triggers. Not batch-aware |
| Live availability, greyed-out items, override (POS-10) | ✅ | Sold out on guest and waiter menus. Override = keep selling |
| Refund doesn't restore stock (12.2) | ✅ | Order correction is a separate, explicit action |
| Wastage with reason codes, approval, alert (WST-1..4) | 🟡 | Waste needs a free-text reason. No codes, approval, cost or alert |
| Adjustments with maker-checker (ADJ-1..3) | 🟡 | Count/add exist. No approval, evidence, staff meal or comp types |
| Count sessions, blind, multi-counter, variance approval (CNT-1..5) | 🟡 | Single-item "count" only |
| Costing, valuation, variance (CST-1..4) | ❌ | |
| Inventory dashboards and reports (17) | ❌ | The owner Overview briefing exists but has no stock KPIs |
| Notifications (NTF) | 🟡 | In-app low/out banner only |
| Audit log with before/after (AUD) | 🟡 | `stock_movements` + `access_events` are append-only. There's no general audit of item and recipe edits |
| Fine-grained RBAC, maker-checker (RBAC-1..3,8) | ❌ | Coarse roles only |

## Outside "inventory" but in the PRD

These belong to the PRD's platform scope, not the inventory module itself. They need an explicit in/out decision (see Q-S1):

| Area | Status |
| --- | --- |
| POS extras: KDS stations, discounts, service charge, shifts (float, X/Z), receipts | ❌ (Cravio has orders, tables, waiter and guest menus) |
| Offline PWA with event sync (OFF-1..6) | ❌. Large, and touches everything |
| M-Pesa Daraja STK, reconciliation (MPE) | ❌ (`payments` table only) |
| KRA eTIMS (TAX) | ❌. Needs KRA sandbox and certification, with a long lead time |
| 2FA, PIN login, device registry (RBAC-6/7) | ❌ |
| Accounting exports | ❌ |

## Conflicts with decisions already made (docs/v2/DECISIONS.md)

| Decision on record | PRD says | Needs |
| --- | --- | --- |
| D03: unit = servings, one main center | Base units (g/ml/pcs), multiple warehouses | Confirm the PRD supersedes D03 |
| D06: override, so the balance can go negative | Override sells, but stock never goes negative; log an exception | Choose one (Q-N1) |
| D07: approval moves no stock | Approval **reserves** at the source | Choose one (Q-R1) |
| Five interfaces; owner = operations manager | Nine roles, incl. warehouse, storekeeper, procurement, finance | Mapping decision (Q-A1) |
| R7 / PRD-CONTEXT: procurement, payments, tax and offline were "not committed" | All P0 | Scope decision (Q-S1) |
| Main stores 012 amounts in the item's own unit | Base unit, `numeric(18,4)` | Decide before 012 is applied (Q-U1) |
