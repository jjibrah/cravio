# 11. Design review of the inventory screens (P1-17a)

Reviewed 18 Nov 2026 against `DESIGN.md` and `07-implementation-plan.md` section 0.7. Every screen was opened at desktop (1280x800), tablet (820x1180) and phone (390x844) with realistic Kenyan data (Chicken in kg with crates, Eggs by tray, Cooking oil in L, Chicken burger, Pilau, Chips masala; branches Westlands and Kilimani), plus a 200-item list and an empty business. Existing Orders, Locations and the old inventory page were the reference for header, spacing, panels, buttons and badges.

Screens: owner Stock, Items (item, import and opening-stock sheets), History, Recipes (recipe sheet); branch Stock (Record stock, shortfalls and item sheets), History, Recipes; stock alerts in the notification bell.

## What already matched Cravio

Page header, panel, count chip, toolbar, badges, side sheet (bottom sheet on phones), colours, type sizes and radii all reuse the shared pieces. No new colour, font or component was found. Plain words were used throughout (On hand, Held for open orders, Available, Code (optional)); no "base unit", "SKU", "ledger" or "version id" on screen. Units sit next to every quantity box and the live line ("= 400 kg") works. Empty, loading and error states exist on every page. No page scrolled sideways at any width, including with 200 items.

## Findings and what was done

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | High | Owner Stock and owner History tables kept their columns on a phone, so they scrolled sideways inside the panel and the Value / Why columns were cut off. Branch Stock already turned into cards. | Fixed: shared `inv-cards` card layout, each value labelled (Warehouse, Westlands, Value, Change...). |
| 2 | High | Shortfalls sheet: the "Note" box was 180px tall and the two buttons were centred under it (a global form rule made the row a column). | Fixed: the row is a row again; note box, Count and Mark as checked sit together. |
| 3 | Medium | Touch targets under 44px on tablet and phone: Show, Review, Edit recipe, Load more, "Low or out only", item-name links, chip buttons. | Fixed: 44px minimum for buttons, fields, links and checkboxes on inventory pages and sheets at 1024px and below, and on touch screens. |
| 4 | Medium | Record stock: the three choices (Count, Add, Waste) were stacked on a phone and filled half the screen before any field. | Fixed: three across on all widths. |
| 5 | Medium | Stock alerts in the bell were centred and had no alignment with the rest of the list. | Fixed: left aligned like other notifications. |
| 6 | Medium | Branch Stock: "Held for open orders" showed "0 g" next to kg items (mixed units); Value wrapped ("Ksh / 2,600"). | Fixed: nothing held shows a dash; value stays on one line. |
| 7 | Medium | Branch Stock on a phone: a long card per item with an empty "0 g" row, and the status badge was far from the name. | Fixed: status under the name, zero-held row hidden. |
| 8 | Medium | Branch History on a phone had no labels (a bare "System" and "-"). | Fixed: "By:" and "Note:" labels, empty note hidden; change amount never breaks across lines. |
| 9 | Medium | Two main buttons on an empty page: Stock (branch) had Record stock in the header and again in the empty state; owner Stock offered Record opening stock with no items yet, next to Add your first item. | Fixed: one main action per page. |
| 10 | Medium | Recipes: the branch picker was cut off ("Westl") in the phone header. | Fixed: full width under the title on phones. |
| 11 | Medium | The attention cards on branch Stock wrapped three plus one on desktop. | Fixed: equal columns, four in a row. |
| 12 | Medium | Count line said "the books say 5 kg" (accounting wording). | Fixed: "the system shows 5 kg". |
| 13 | Low | Opening stock: the cost box only said "Optional". | Fixed: "Cost (optional)". |

## Wording that changed on purpose (test updated)

`frontend/tests/inventory-branch.spec.js`: "You counted 4.8 kg; the books say 5 kg → 0.2 kg less." is now "... the system shows 5 kg → 0.2 kg less." Nothing else in the specs changed.

## Before and after, in short

- Owner Stock on a phone: 4 columns clipped at the right edge, then one card per item with each place as its own labelled line.
- Shortfalls: a 180px empty box with centred buttons, then a one-line note box with Count and Mark as checked beside it.
- Record stock on a phone: three full-width cards (about 250px), then three across (about 80px).

## Left over (low)

- Four attention cards still stack on a phone and push the list down; a compact single summary row would help a busy manager.
- Lists are not paged: 200 items work but make a long page. Add paging or "show more" when real businesses reach that size.
- Times: the bell and owner History use the viewer's local time and short dates; branch screens show "EAT" with full dates. Pick one format.
- The CSV file picker in the import sheet is the browser's own control.
- Rows on branch Stock are tappable but have no arrow to say so.
- Owner Items shows no low/out badge on the Category column; fine, but Items and Stock overlap and a short hint on Items could point to Stock.
- Keyboard and screen reader: labels, roles and focus rings were present on everything checked; no automated contrast tool was run. Re-check after the next colour change.

## Orchestrator follow-up (18 Nov 2026)
- Fixed: stock and food-cost money showed "Ksh 7.8". Inventory screens now use `formatStockMoney` (lib/inventory.js): whole amounts "Ksh 2,600", amounts with cents "Ksh 7.80". The app-wide `formatPrice` (menu prices) is unchanged.
