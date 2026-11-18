# 05 · Navigation proposal: an "Operations" group (DRAFT; Reports/Receipts and Settings → Inventory added 18 Nov)

Idea: promote today's in-page tabs (Stock, Recipes, Requests, Deliveries, History) to **sidebar entries under an "Operations" group**, and add the new PRD areas as further entries. Each page keeps a narrow job. Config lives in `frontend/src/config/dashboards.js`: consecutive sections with the same `group` render together, so this is mostly config + pages.

Principle: **the owner (head office) plans, buys, distributes and approves. The branch manager runs the day and asks.** The platform admin configures Cravio-wide defaults and switches the module on, and never sees stock records.

## Owner / head office (`/owner`)

```
Overview                     daily briefing + stock KPIs (value, low, expiring, pending approvals)
Business
  Locations                  branches + warehouses (add "warehouse" type here)
  People & access            + inventory roles/permissions
Operations
  Stock                      every location: on hand / reserved / available / in transit, filters, CSV
  Items & recipes            catalogue, units & packs, recipes (versions, yield, cost), prepared items
  Requests & transfers       branch requests to approve, dispatches, transfers between locations
  Purchasing                 suppliers, price lists, purchase orders, goods receiving
  Approvals                  one inbox: POs, emergency buys, wastage/adjustments over your limit, count variances; "Self-approved" chip when you approved your own
  Counts & wastage           count sessions across locations, wastage log
Reports                      (sidebar group, answered 18 Nov)
  Reports                    catalogue of ALL reports: list -> open -> filters -> table/chart -> Download CSV -> Save as PDF (browser print layout)
                             themes: Stock, Money, People & places, Safety; plus Insights (AI findings, Ask about my numbers, AI usage meter)
  Receipts                   every receipt in one place: supplier invoices/receipts uploaded with purchases and emergency buys, goods received
                             notes, delivery/dispatch notes (with QR), supplier return/credit notes. Search/filter by supplier, branch, date,
                             type, invoice status (eTIMS / other / none). View the attached image/PDF, download.
Settings                     Inventory: emergency-buy limits per branch (per purchase / day / week, optional per category), approval thresholds
                             (wastage, adjustments, count variance; business default + per-branch override), PO bands, reason codes, AI usage
                             and allowance (owner may lower). Everything editable any time; no built-in amounts.
```
Customer sale receipts are **not** in Receipts (they belong to the later POS/eTIMS module). Open question Q-R3: should "all receipts" also list customer bills/orders? PDF = the browser's "Save as PDF" (print stylesheet) first; a server PDF library only if emailed/scheduled reports are needed.
Placement: Receipts and Settings → Inventory arrive in Phase 2 (P2-35/36/37); the Reports catalogue in Phase 3 (P3-26/28); Insights in Phase 3 Release G (P3-43).

## Branch manager (`/branch/:id`)

```
Overview / Orders / Tables              (unchanged)
Menu
  Products · Menu configuration
  Recipes                    ← could live here instead (it's per dish); see Q-N2
Operations
  Stock                      this branch: on hand, held, available, low/expiring, count/add/waste
  Requests & deliveries      ask the warehouse; receive deliveries (QR)
  Purchases                  emergency buys with evidence (from v3-dev idea + PRD §10)
  Prep                       production batches (prepared items)          [later phase]
  Counts & wastage           count sessions, wastage with reason codes
  History                    branch ledger
Analytics
  Insights · Food cost & variance     (Insights = AI findings for THIS branch only)
  Reports                    this branch's reports (same catalogue, own branch only)
  Receipts                   this branch's receipts: emergency-buy invoices, deliveries received, delivery notes, returns
```

## Platform admin (`/admin`)

```
Platform
  Businesses                 + "Inventory module: on/off" per business (entitlement); + "AI: on/off, monthly allowance, usage this month and last 6 months" in the business detail (usage numbers only, never content)
Configuration (new group)
  Units & defaults           default unit families, Kenya pack presets (tray 30, crate 24, sack 90 kg)
  Tax rates                  VAT classes with effective dates (only if tax is in scope)
```
No stock, order or cost records for admins (consistent with existing rule).

## Waiter / guest
No new pages. They keep sold-out / low-stock signals. Later: "report shortage" from the kitchen.

## Things to settle (also in 06)
- Should Recipes sit under **Menu** (dish-centric) or **Operations** (stock-centric)?
- Sidebar entries vs. one Inventory page with tabs: with 5–7 inventory pages per role, separate entries scale better; but the branch sidebar gets long. Option: collapsible "Operations" group.
- ~~Where do Reports and Receipts live?~~ Answered 18 Nov: owner sidebar group **Reports** with **Reports** and **Receipts**; branch managers see their own branch.
- Warehouse staff: if a Warehouse Manager / Storekeeper role is added, they need their **own** workspace (warehouse = location, not a restaurant). Options: (a) reuse the owner area with a scoped role, (b) a 6th "warehouse" interface.
