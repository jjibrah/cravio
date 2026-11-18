# 03 · PRD digest: Restaurant Inventory, Procurement and POS Platform v1.0 (18 Nov 2026)

Kenya, KES only, East Africa Time. P0 = first launch, P1 = first cycle after launch, P2 = later. "[VERIFY]" = depends on KRA, Safaricom or gateway specs.

## Ground rules (apply everywhere)
- Never change a quantity directly: **ledger row inside a DB transaction**, balances as a cached projection that must reconcile (LED-1..8).
- Nothing configurable is hardcoded: units, factors, tax, thresholds, payment methods, alert levels.
- No mock data behind real screens, and no button without server logic.
- Money: integer cents or `numeric(14,2)`. Quantities: `numeric(18,4)` **in the base unit**. Unit cost: `numeric(18,6)` per base unit.
- Maker-checker: whoever creates an adjustment, write-off, PO approval or refund can't approve it.
- Every query is filtered by the user's permitted locations **on the server**.
- Defaults for open decisions (section 1.6): batch cost (FIFO); requests can split across warehouses; expired batches are auto-blocked (manager override with reason); **an override sells but stock never goes negative** (the shortfall is logged as an exception); VSCU for eTIMS; Pesapal/Flutterwave; own riders in v1.

## Roles (section 2)
Super Admin, Head Office Manager, Warehouse Manager, Storekeeper, Procurement Officer, Branch Manager, Cashier/Waiter, Kitchen/Chef, Finance/Auditor. Roles are **collections of fine-grained permissions**, editable in the UI (RBAC-1/8). Users can hold several roles across several locations. Delegation and escalation are P1. 2FA for sensitive roles, and PIN login for POS.

## Modules and key requirement IDs

| # | Module | Core content | Priority highlights |
| --- | --- | --- | --- |
| 4 | Organisation & locations | Org → head office, warehouses, branches; locations share one model with a `type`; per-location settings that inherit from the org | ORG-1..6 P0 |
| 5 | Catalogue | Item types: raw, prepared (sub-recipe), resale, packaging, consumable. SKU, barcodes, category tree, storage type, base/purchase/recipe units, density, yield %, min/reorder/max/par per location, costs, VAT class, expiry tracking, allergens, preferred suppliers, CSV import with dry run | CAT-1,4 P0 |
| 6 | Units | Weight, volume, count, package families. Per-item packaging conversions. Exact decimals. Factor changes affect future transactions only | UOM-1..7 P0 |
| 7 | Ledger, balances, batches | On-hand, reserved, available, in-transit, quarantined. Transaction-type list. Reversal entries. Reconciliation job. Idempotency key + type unique. Period close. Batches with FEFO/FIFO, expiry block, traceability, labels, recall | LED-1..7, BAT-1..4 P0 |
| 8 | Warehouses, requests, transfers | Request statuses: Draft…Completed. Approve, partial or reject, choose source warehouse, split fulfilment. **Approval reserves.** Pick lists. Dispatch → in-transit. Receive with damaged/short/over. Transfers W→W, W→B, B→W, B→B. Discrepancy review (who bears the loss) | REQ-1..7,9, TRF-1..4 P0 |
| 9 | Suppliers & procurement | Supplier record with KRA PIN and type (formal/informal/one-off). Price lists with dates. Replenishment suggestions. PO statuses + value-band approval. PO PDF/WhatsApp. Supplier returns. GRN with batch, expiry, cost; invoice capture (PIN, eTIMS no.); price variance alert. 3-way match and AP are P1 | SUP-1..3, PRC-1..4,6, GRN-1..3,6 P0 |
| 10 | Emergency branch procurement | A branch buys directly. Configurable thresholds (branch, category, per transaction, per period). Auto-authorise below threshold, approver above. Invoice status eTIMS/other/**no-invoice** (needs reason, photo, M-Pesa ref). On-the-spot supplier. Central vs emergency reports | EMP-1..4,6 P0 |
| 11 | Menu, recipes, production | Variants with recipe multipliers. Modifiers with ingredient effects. Combos. **Recipe versions** (orders snapshot the version). Sub-recipes with cycle detection. Yield. Auto recipe cost and food cost %. Production batches (input −, output +) | MNU-1..4, RCP-1..6, PRD-1,2 P0 |
| 12 | POS | Order types, KDS by station, discounts and comps, service charge and levy, voids/refunds, **shifts** (float, X/Z), receipts with eTIMS QR, live availability. Reserve on accept, commit on serve, release on cancel, idempotent events. **Offline PWA mandatory** | POS-1..10, OFF-1..6 P0 |
| 13 | Payments | Cash, **M-Pesa STK Push** + callback + status query + daily reconciliation, split payments (P0). Airtel, card and credit accounts are P1 | MPE-1..4,6,8 P0 |
| 14 | Tax / KRA eTIMS | OSCU/VSCU adapter, per-branch device, item tax mapping, submit on payment, offline queue, credit notes, tax rates with effective dates, tax reports | TAX-1..6,9,10 P0 |
| 15 | Wastage, adjustments, counts | Reason codes. Approval above a threshold. Unusual-wastage alert. Adjustments with maker-checker. Staff meals and comps as their own types. Count sessions (full, cycle, spot) with a snapshot, blind count, multi-counter, variance approval. Opening balances | WST-1..4, ADJ-1..3, CNT-1..5 P0 |
| 16 | Costing & variance | Configurable cost method. Valuation. Theoretical vs actual usage. Variance report. Menu engineering | CST-1..5 P0 |
| 17 | Dashboards & reports | Head office, warehouse and branch dashboards. 19 reports. CSV + PDF, background generation | RPT-1,3 P0 |
| 18 | Notifications | In-app + push, email, SMS. Event list. Role/location targeting | NTF-1..3 P0 |
| 19 | Audit | Every action logged with before/after. Append-only and tamper-evident. Viewer | AUD-1..4 P0 |
| 20 | Security / Kenya DPA | TLS, Argon2/bcrypt, RLS, encrypted credentials, data minimisation | DPA-1,4 P0 |

## Ingredient calculation (section 12.3)
For each order line, take the recipe version in force at acceptance (variant + modifiers), expand sub-recipes, then `required += line_qty × recipe_qty / yield`. Aggregate across lines, check available ≥ required, reserve FEFO batches, and on serve commit `pos_consumption` ledger rows linked to order, line and batch.

## Phasing in the PRD (section 27)
0 Discovery and compliance · 1 Foundation (org, auth, catalogue, units, ledger, audit, import) · 2 Distribution (requests, transfers) · 3 Procurement and emergency · 4 Restaurant ops (menu, recipes, production, POS, offline) · 5 Payments and tax · 6 Controls (wastage, counts, batches, FEFO, variance) · 7 Reporting · 8 Hardening. It recommends a **thin vertical slice** at the end of phase 2: one warehouse, one branch, one recipe, a cash order, and serve deducts stock.

## Acceptance suite (section 29)
T-INV-1..7, T-REQ-1..3, T-PRC-1, T-EMP-1..4, T-POS-1..8, T-OFF-1, T-PAY-1..3, T-TAX-1..3, T-CTL-1..3, T-SEC-1..3, T-RPT-1..2. These are the "done" bar.
