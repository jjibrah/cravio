# Golden dataset: one week, two branches and the Warehouse

Written 18 Nov 2026 for P3-02 (`10-phase3-workplan.md`). A deterministic scenario whose every figure was **worked out independently of the code** (a separate decimal calculation following the rules in section 3, not the ledger and not the SQL triggers) and is then compared with what the real ledger, the real order triggers and the real recipe snapshot produce. **Later tickets assert against this document**: valuation (P3-23), variance (P3-24), menu engineering and price changes (P3-25), the report catalogue and CSV totals (P3-26, T-RPT-1/2), the AI fact builders (P3-40). If a figure here changes, change `backend/tests/inv/golden-data.js` and this file together: `backend/tests/inv/golden.test.js` fails when a headline figure is missing from this document.

| File | What it is |
| --- | --- |
| `backend/tests/inv/golden-data.js` | `SPEC` (what is built) and `EXPECTED` (the hand-worked figures), pure data |
| `backend/tests/inv/golden.js` | `loadGolden()`: builds the week on a fresh PGlite database (all proposed migrations) through `ledger.post`, the order snapshot and the serve trigger; returns ids, contexts, the fake clock and `counts` |
| `backend/tests/inv/golden.test.js` | builds it (about 0.4 s after the schema), asserts every ledger-level figure below, determinism, harness helpers and that this document shows the headline numbers |

```js
import { loadGolden, EXPECTED } from './golden.js';
const g = await loadGolden();   // g.db, g.ids, g.itemIds.chicken, g.locIds.A, g.dishIds.B.CB, g.counts.closing['A.chicken'], g.clock ...
```

## 1. The scenario

**Golden Eats**: the Warehouse (the business's one stock centre), **Westlands** (branch A) and **Karen** (branch B). Week **Mon 2 – Sun 8 Nov 2026**, Africa/Nairobi (+03:00). Stock opens on Sun 1 Nov 23:30 (the *opening count*), the week's trading and deliveries follow, and a *closing count* is taken on Sun 8 Nov 23:00 at all three places. Prices are KES per portion; costs are KES per base unit (g, ml or piece); quantities are base units.

### Items (10)

| Item | Base unit | Usable after prep (yield) | Opening cost per unit |
| --- | --- | --- | --- |
| Chicken | g | 70 % | 0.40 |
| Beef mince | g | 100 % | 0.60 |
| Burger bun | piece | 100 % | 15 |
| Cheese | g | 100 % | 0.80 |
| Potatoes | g | 80 % | 0.08 |
| Cooking oil | ml | 100 % | 0.30 |
| Rice | g | 100 % | 0.15 |
| Tomatoes | g | 90 % | 0.10 |
| Lettuce | g | 100 % | 0.20 |
| Soda | piece | 100 % | 40 |

### Dishes and recipes (6 dishes, the same menu at both branches)

A recipe line is the quantity *before* yield. One portion therefore takes `quantity ÷ yield` of the item from stock, rounded to 4 decimals per order line (013 `dish_stock_lines`).

| Dish | Price | Recipe (before yield) | What one portion takes from stock |
| --- | --- | --- | --- |
| Chicken burger (`CB`) | 650 | 200 g chicken, 1 piece burger bun, 20 g cheese, 15 g lettuce | 285.7143 g, 1 piece, 20 g, 15 g |
| Beef burger (`BB`) | 700 | 180 g beef mince, 1 piece burger bun, 20 g cheese, 15 g lettuce | 180 g, 1 piece, 20 g, 15 g |
| Fries (`FR`) | 250 | 250 g potatoes, 30 ml cooking oil | 312.5 g, 30 ml |
| Chicken & rice (`CR`) | 550 | 250 g chicken, 150 g rice, 80 g tomatoes, 15 ml cooking oil | 357.1429 g, 150 g, 88.8889 g, 15 ml |
| Beef stew & rice (`BS`) | 600 | 200 g beef mince, 150 g rice, 100 g tomatoes, 15 ml cooking oil | 200 g, 150 g, 111.1111 g, 15 ml |
| Soda (`SO`) | 100 | 1 piece soda | 1 piece |

### Opening count (Sun 1 Nov 23:30)

| Item | Warehouse | Westlands | Karen |
| --- | --- | --- | --- |
| Chicken | 20,000 | 12,000 | 10,000 |
| Beef mince | 15,000 | 6,000 | 5,000 |
| Burger bun | 300 | 100 | 80 |
| Cheese | 5,000 | 1,500 | 1,200 |
| Potatoes | 60,000 | 15,000 | 12,000 |
| Cooking oil | 20,000 | 4,000 | 3,000 |
| Rice | 40,000 | 8,000 | 6,000 |
| Tomatoes | 15,000 | 3,000 | 2,500 |
| Lettuce | 3,000 | 900 | 800 |
| Soda | 200 | 80 | 60 |

### What happens in the week

| When | What |
| --- | --- |
| Tue 3 Nov 08:00 | **Purchase received at Warehouse**: 30,000 g chicken at 0.44; 200 piece burger bun at 16; 20,000 g potatoes at 0.09; 10,000 ml cooking oil at 0.32 |
| Tue 3 Nov 15:00 | **Staff meal** at Westlands: 2 × Chicken burger (recipe expanded, yield applied) |
| Wed 4 Nov 09:00 | **Transfer Warehouse → Westlands** (dispatched, received 30 min later, in full): 8,000 g chicken; 100 piece burger bun; 1,500 g cheese; 10,000 g potatoes; 3,000 ml cooking oil; 600 g lettuce; 2,000 g tomatoes; 5,000 g rice; 3,000 g beef mince; 40 piece soda |
| Wed 4 Nov 09:05 | **Transfer Warehouse → Karen** (dispatched, received 30 min later, in full): 6,000 g chicken; 80 piece burger bun; 1,200 g cheese; 8,000 g potatoes; 2,500 ml cooking oil; 500 g lettuce; 1,500 g tomatoes; 4,000 g rice; 2,500 g beef mince; 30 piece soda |
| Wed 4 Nov 10:00 | **Purchase received at Karen**: 5,000 g tomatoes at 0.12; 1,500 g lettuce at 0.22 |
| Wed 4 Nov 16:00 | **Wastage** at Warehouse: 300 g lettuce |
| Thu 5 Nov 08:00 | **Purchase received at Warehouse**: 10,000 g beef mince at 0.65; 20,000 g rice at 0.16; 4,000 g cheese at 0.85; 120 piece soda at 42 |
| Thu 5 Nov 17:00 | **Wastage** at Westlands: 500 g chicken |
| Fri 6 Nov 09:00 | **Transfer Warehouse → Westlands** (dispatched, received 30 min later, in full): 11,000 g chicken; 4,500 g beef mince; 3,000 g rice; 6,000 g potatoes; 60 piece burger bun; 800 g cheese; 1,500 ml cooking oil; 2,500 g tomatoes; 400 g lettuce |
| Fri 6 Nov 09:05 | **Transfer Warehouse → Karen** (dispatched, received 30 min later, in full): 8,000 g chicken; 2,000 g beef mince; 3,000 g rice; 5,000 g potatoes; 50 piece burger bun; 600 g cheese; 1,200 ml cooking oil; 1,000 g tomatoes; 300 g lettuce |
| Fri 6 Nov 17:00 | **Wastage** at Karen: 400 g tomatoes |
| Sat 7 Nov 13:30 | **Staff meal** at Karen: 1 × Fries (recipe expanded, yield applied) |
| Sat 7 Nov 19:00 | **Complimentary** at Karen: 1 × Soda |
| every day 14:00 | One order per branch, all lines served at once (quantities below) |
| Sun 8 Nov 23:00 | **Closing count** at all three places. The people count whole units and find the shortfalls listed in section 4 |

### Portions served (one order per branch per day)

**Westlands**

| Day | Chicken burger | Beef burger | Fries | Chicken & rice | Beef stew & rice | Soda | Sales (KES) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mon 2 Nov | 6 | 4 | 8 | 5 | 3 | 10 | 14,250.00 |
| Tue 3 Nov | 5 | 4 | 7 | 4 | 3 | 9 | 12,700.00 |
| Wed 4 Nov | 6 | 5 | 8 | 6 | 4 | 11 | 16,200.00 |
| Thu 5 Nov | 5 | 3 | 7 | 4 | 3 | 8 | 11,900.00 |
| Fri 6 Nov | 9 | 7 | 12 | 8 | 5 | 17 | 22,850.00 |
| Sat 7 Nov | 11 | 8 | 15 | 9 | 6 | 20 | 27,050.00 |
| Sun 8 Nov | 8 | 6 | 10 | 7 | 4 | 14 | 19,550.00 |
| **Week** | **50** | **37** | **67** | **43** | **28** | **89** | **124,500.00** |

**Karen**

| Day | Chicken burger | Beef burger | Fries | Chicken & rice | Beef stew & rice | Soda | Sales (KES) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mon 2 Nov | 4 | 3 | 5 | 4 | 2 | 6 | 9,950.00 |
| Tue 3 Nov | 4 | 3 | 5 | 3 | 2 | 5 | 9,300.00 |
| Wed 4 Nov | 5 | 3 | 6 | 4 | 3 | 7 | 11,550.00 |
| Thu 5 Nov | 3 | 3 | 4 | 3 | 2 | 5 | 8,400.00 |
| Fri 6 Nov | 7 | 5 | 9 | 6 | 4 | 12 | 17,200.00 |
| Sat 7 Nov | 9 | 7 | 11 | 8 | 5 | 15 | 22,400.00 |
| Sun 8 Nov | 6 | 4 | 8 | 5 | 3 | 10 | 14,250.00 |
| **Week** | **38** | **28** | **48** | **33** | **21** | **60** | **93,050.00** |

## 2. Counting the scenario

404 stock movements in all (30 opening, purchases, 2 × transfers as dispatch + receipt, 3 wastage, staff meals and a complimentary, 266 served, 12 count corrections), **0 without a cost**, 14 orders, no stock exception (nothing was ever short).

## 3. The rules the figures follow

- **Quantities** have 4 decimals, **costs** 6, **money** 2. Rounding is half away from zero, applied once where a digit is lost.
- **Weighted average cost** is per item across all places: when stock arrives with a cost, `new = (units on hand everywhere × old average + units in × their cost) ÷ (units on hand everywhere + units in)`, to 6 decimals. Stock leaving (sales, wastage, staff meals, transfers, count losses) leaves at the average of that moment. A transfer receipt carries the dispatch cost, so it does not move the average. A count *surplus* also carries the average cost (so valuation never sees a movement without a cost; the count service in P3-08 must do the same).
- **A movement's value** is `quantity × cost`, rounded to 2 decimals, per movement (so a valuation built from movement values can differ from `on hand × average cost` by a few cents; section 8).
- **An order line needs** `round(recipe quantity × portions ÷ (yield ÷ 100), 4)` of each ingredient. The serve trigger takes that from stock at the average cost of that moment.
- **Theoretical use** = what the served orders' recipes needed. **Actual use** (D3-9) = opening count + purchases + transfers in − transfers out − wastage − staff meals − complimentaries − closing count. **Variance** = actual − theoretical; a positive number means more went than the recipes explain. Because the count posts `closing − expected` as a correction, **variance = −correction** (checked in the test).
- **Food cost** of a branch is the value of its serve movements (consumption at the average cost of the day); **gross profit after food cost** is sales minus that. It does not include rent, salaries or utilities.

### Worked by hand: the average cost of chicken

Chicken opens at KES 0.40 a gram: 20,000 g (Warehouse) + 12,000 g (Westlands) + 10,000 g (Karen) = 42,000 g.

1. **Monday's orders** use chicken: Westlands 6 chicken burgers = round(200 × 6 ÷ 0.70, 4) = 1,714.2857 g and 5 chicken & rice = round(250 × 5 ÷ 0.70, 4) = 1,785.7143 g; Karen 4 burgers = 1,142.8571 g and 4 chicken & rice = 1,428.5714 g. Total 6,071.4285 g, all at 0.40. On hand: 42,000 − 6,071.4285 = 35,928.5715 g.
2. **Tuesday 08:00**: 30,000 g arrive at 0.44. New average = (35,928.5715 × 0.40 + 30,000 × 0.44) ÷ (35,928.5715 + 30,000) = (14,371.4286 + 13,200) ÷ 65,928.5715 = **0.418202** (to 6 decimals).
3. Everything chicken served from Tuesday on costs 0.418202 a gram (no other chicken purchase): that is the cost per day in section 7.
4. A Tuesday chicken burger at Westlands (5 portions) uses round(200 × 5 ÷ 0.70, 4) = 1,428.5714 g, worth round(1,428.5714 × 0.418202, 2) = **597.43**.

### Worked by hand: one dish's food cost at the end-of-week averages

Chicken burger = 200 g chicken at 70 % + 1 bun + 20 g cheese + 15 g lettuce:

| Ingredient | Per portion from stock | End average | Cost |
| --- | --- | --- | --- |
| Chicken | 285.7143 g | 0.418202 | 119.486286 |
| Burger bun | 1 piece | 15.301659 | 15.301659 |
| Cheese | 20 g | 0.818832 | 16.376640 |
| Lettuce | 15 g | 0.205286 | 3.079290 |
| **Sum** | | | **154.24** = 154.243875 rounded once → 23.7 % of the price 650 |

## 4. Branch tables: theoretical use, actual use, variance

*Theoretical* = what the served orders' recipes needed. *Wastage*, *staff meals/comps* are recorded explanations. *Expected* = opening + purchases + transfers in − theoretical − wastage − staff meals/comps. *Counted* = closing count. *Difference* = counted − expected (the count correction). *Actual use* and *variance* as in section 3. KES at the end-of-week average cost. Counts are whole units, so a recipe item with a fractional expectation shows rounding noise (for example Westlands potatoes +0.5 g).

### Westlands

| Item | Opening | In (purchase + transfers) | Theoretical use | Wastage | Staff meals / comps | Expected | Counted | Difference | Actual use | Variance | Variance % | Variance KES |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chicken (g) | 12,000 | 19,000 | 29,642.857 | 500 | 571.4286 | 285.7144 | 186 | -99.7144 | 29,742.5714 | 99.7144 | 0.3 | 41.70 |
| Beef mince (g) | 6,000 | 7,500 | 12,260 | 0 | 0 | 1,240 | 1,240 | 0 | 12,260 | 0 | 0 | 0.00 |
| Burger bun (piece) | 100 | 160 | 87 | 0 | 2 | 171 | 171 | 0 | 87 | 0 | 0 | 0.00 |
| Cheese (g) | 1,500 | 2,300 | 1,740 | 0 | 40 | 2,020 | 1,980 | -40 | 1,780 | 40 | 2.3 | 32.75 |
| Potatoes (g) | 15,000 | 16,000 | 20,937.5 | 0 | 0 | 10,062.5 | 10,063 | 0.5 | 20,937 | -0.5 | -0 | -0.04 |
| Cooking oil (ml) | 4,000 | 4,500 | 3,075 | 0 | 0 | 5,425 | 5,325 | -100 | 3,175 | 100 | 3.3 | 30.55 |
| Rice (g) | 8,000 | 8,000 | 10,650 | 0 | 0 | 5,350 | 5,350 | 0 | 10,650 | 0 | 0 | 0.00 |
| Tomatoes (g) | 3,000 | 4,500 | 6,933.3332 | 0 | 0 | 566.6668 | 417 | -149.6668 | 7,083 | 149.6668 | 2.2 | 15.62 |
| Lettuce (g) | 900 | 1,000 | 1,305 | 0 | 30 | 565 | 565 | 0 | 1,305 | 0 | 0 | 0.00 |
| Soda (piece) | 80 | 40 | 89 | 0 | 0 | 31 | 31 | 0 | 89 | 0 | 0 | 0.00 |
| **Total variance KES** | | | | | | | | | | | | **120.58** |

### Karen

| Item | Opening | In (purchase + transfers) | Theoretical use | Wastage | Staff meals / comps | Expected | Counted | Difference | Actual use | Variance | Variance % | Variance KES |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chicken (g) | 10,000 | 14,000 | 22,642.8571 | 0 | 0 | 1,357.1429 | 1,107 | -250.1429 | 22,893 | 250.1429 | 1.1 | 104.61 |
| Beef mince (g) | 5,000 | 4,500 | 9,240 | 0 | 0 | 260 | 140 | -120 | 9,360 | 120 | 1.3 | 74.09 |
| Burger bun (piece) | 80 | 130 | 66 | 0 | 0 | 144 | 144 | 0 | 66 | 0 | 0 | 0.00 |
| Cheese (g) | 1,200 | 1,800 | 1,320 | 0 | 0 | 1,680 | 1,680 | 0 | 1,320 | 0 | 0 | 0.00 |
| Potatoes (g) | 12,000 | 13,000 | 15,000 | 0 | 312.5 | 9,687.5 | 9,188 | -499.5 | 15,499.5 | 499.5 | 3.3 | 40.93 |
| Cooking oil (ml) | 3,000 | 3,700 | 2,250 | 0 | 30 | 4,420 | 4,420 | 0 | 2,250 | 0 | 0 | 0.00 |
| Rice (g) | 6,000 | 7,000 | 8,100 | 0 | 0 | 4,900 | 4,900 | 0 | 8,100 | 0 | 0 | 0.00 |
| Tomatoes (g) | 2,500 | 7,500 | 5,266.6666 | 400 | 0 | 4,333.3334 | 4,333 | -0.3334 | 5,267 | 0.3334 | 0 | 0.03 |
| Lettuce (g) | 800 | 2,300 | 990 | 0 | 0 | 2,110 | 2,050 | -60 | 1,050 | 60 | 6.1 | 12.32 |
| Soda (piece) | 60 | 30 | 60 | 0 | 1 | 29 | 28 | -1 | 61 | 1 | 1.7 | 40.58 |
| **Total variance KES** | | | | | | | | | | | | **272.56** |

### Warehouse

| Item | Opening | Purchases | Transferred out | Wastage | Expected | Counted | Difference |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chicken (g) | 20,000 | 30,000 | 33,000 | 0 | 17,000 | 17,000 | 0 |
| Beef mince (g) | 15,000 | 10,000 | 12,000 | 0 | 13,000 | 13,000 | 0 |
| Burger bun (piece) | 300 | 200 | 290 | 0 | 210 | 210 | 0 |
| Cheese (g) | 5,000 | 4,000 | 4,100 | 0 | 4,900 | 4,900 | 0 |
| Potatoes (g) | 60,000 | 20,000 | 29,000 | 0 | 51,000 | 51,000 | 0 |
| Cooking oil (ml) | 20,000 | 10,000 | 8,200 | 0 | 21,800 | 21,800 | 0 |
| Rice (g) | 40,000 | 20,000 | 15,000 | 0 | 45,000 | 45,000 | 0 |
| Tomatoes (g) | 15,000 | 0 | 7,000 | 0 | 8,000 | 8,000 | 0 |
| Lettuce (g) | 3,000 | 0 | 1,800 | 300 | 900 | 800 | -100 |
| Soda (piece) | 200 | 120 | 70 | 0 | 250 | 250 | 0 |

Items with no row in the 'Difference' column of a branch counted exactly what the system expected. Items **not** counted twice would be listed as *Needs a count* by P3-24; every item here has an opening and a closing count.

## 5. Money: sales, food cost, gross profit after food cost

| | Westlands | Karen |
| --- | --- | --- |
| Sales (served orders) | 124,500.00 | 93,050.00 |
| Food cost (served consumption at the average cost of the day) | 31,413.01 | 23,470.12 |
| **Gross profit after food cost** | **93,086.99** | **69,579.88** |
| Gross profit after food cost, % of sales | 74.8 % | 74.8 % |
| Food cost % of sales | 25.2 % | 25.2 % |
| Value of the closing count corrections (shortfalls found) | -120.58 | -272.56 |

Sales per day:

| Day | Westlands | Karen |
| --- | --- | --- |
| Mon 2 Nov | 14,250.00 | 9,950.00 |
| Tue 3 Nov | 12,700.00 | 9,300.00 |
| Wed 4 Nov | 16,200.00 | 11,550.00 |
| Thu 5 Nov | 11,900.00 | 8,400.00 |
| Fri 6 Nov | 22,850.00 | 17,200.00 |
| Sat 7 Nov | 27,050.00 | 22,400.00 |
| Sun 8 Nov | 19,550.00 | 14,250.00 |

Both branches earn about the same share (74.8 %), so **neither branch is loss-making in this dataset**. P3-40 builds the 'loss-making week' case by adding a controlled event on top of a fresh load (for example a large wastage or a price rise posted before the week), not by changing this dataset.

## 6. Dish food cost at the end-of-week averages (food cost %)

| Dish | Price | Food cost | Food cost % | Units sold: Westlands | Units sold: Karen |
| --- | --- | --- | --- | --- | --- |
| Chicken burger | 650 | 154.24 | 23.7 % | 50 | 38 |
| Beef burger | 700 | 145.90 | 20.8 % | 37 | 28 |
| Fries | 250 | 34.77 | 13.9 % | 67 | 48 |
| Chicken & rice | 550 | 186.16 | 33.8 % | 43 | 33 |
| Beef stew & rice | 600 | 162.61 | 27.1 % | 28 | 21 |
| Soda | 100 | 40.58 | 40.6 % | 89 | 60 |

The same figures with the average cost *at the time of serving* are what the branch food cost in section 5 is made of.

## 7. Costs: the weighted average over the week

| Item | Opening | End of week average | Cost used on the days it changed |
| --- | --- | --- | --- |
| Chicken | 0.40 | 0.418202 | 11-02: 0.400000; 11-03: 0.418202 |
| Beef mince | 0.60 | 0.617458 | 11-02: 0.600000; 11-05: 0.617458 |
| Burger bun | 15 | 15.301659 | 11-02: 15.000000; 11-03: 15.301659 |
| Cheese | 0.80 | 0.818832 | 11-02: 0.800000; 11-05: 0.818832 |
| Potatoes | 0.08 | 0.081943 | 11-02: 0.080000; 11-03: 0.081943 |
| Cooking oil | 0.30 | 0.305495 | 11-02: 0.300000; 11-03: 0.305495 |
| Rice | 0.15 | 0.152961 | 11-02: 0.150000; 11-05: 0.152961 |
| Tomatoes | 0.10 | 0.104354 | 11-02: 0.100000; 11-04: 0.104354 |
| Lettuce | 0.20 | 0.205286 | 11-02: 0.200000; 11-04: 0.205286 |
| Soda | 40 | 40.582524 | 11-02: 40.000000; 11-05: 40.582524 |

## 8. Inventory valuation

*Valuation as of a date* = the sum of the signed movement values up to the end of that day (Nairobi) (D3-8).

| As of | Value (KES) | Note |
| --- | --- | --- |
| End of Mon 2 Nov | 79,551.88 | opening stock + Monday's purchases (none) − Monday's consumption |
| End of Wed 4 Nov | 89,060.67 | after Tuesday's purchases, Wednesday's transfers (value-neutral) and wastage |
| End of Sun 8 Nov, before the closing count | 70,401.52 | what the system believed |
| **End of Sun 8 Nov, after the count** | **69,987.85** | after the count corrections |

By place at the end of the week (sum of movement values): Warehouse **51,971.77**, Westlands **9,315.18**, Karen **8,700.90**.

**Cross-check and the documented difference.** `on hand × end-of-week average cost`: Warehouse 51,228.83, Westlands 9,768.56, Karen 8,990.47; total **69,987.87** against 69,987.85 from movement values. Per place the two methods differ by more than cents because each place's stock was costed at the average of the day it arrived or left, while `on hand × average` re-prices everything at the final average; in total they agree to **0.02**, the sum of per-movement rounding to cents. P3-23 must show this as an explained difference, never as an error.

## 9. Notes for the tickets that use this dataset

- **`served`, not `pos_consumption`.** The serve trigger writes reason `served`; theoretical-use queries must count both (spike `fefo-serve`).
- **Count corrections here are posted straight to the ledger** (the count service arrives in P3-08). A found surplus carries the average cost.
- **Orders are dated by `served_at`** and their serve movements are back-dated to it (`golden.js` explains the one trick). Variance and valuation tickets must query by `occurred_at`, never `created_at`.
- The fixture's own dishes (the burger, fries, extra and deal that `inventoryFixture()` creates at Westlands) exist but are not used; the golden dishes live in a separate 'Golden menu' category at each branch.
- **Privacy test data for P3-40**: this dataset has no personal data. The AI payload test adds names, phones and e-mails to free-text fields on top of a fresh load.
