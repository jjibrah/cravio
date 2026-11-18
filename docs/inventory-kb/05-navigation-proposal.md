# 05 · Navigation proposal: an "Operations" group (DRAFT, for discussion)

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
  Approvals                  one inbox: emergency buys, wastage/adjustments over limit, count variances
  Counts & wastage           count sessions across locations, wastage log
Reports                      food cost, variance, valuation, spend (central vs emergency)
Settings                     thresholds, approval limits, reason codes, units (org-level config)
```

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
  Insights · Food cost & variance
```

## Platform admin (`/admin`)

```
Platform
  Businesses                 + "Inventory module: on/off" per business (entitlement)
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
- Warehouse staff: if a Warehouse Manager / Storekeeper role is added, they need their **own** workspace (warehouse = location, not a restaurant). Options: (a) reuse the owner area with a scoped role, (b) a 6th "warehouse" interface.
