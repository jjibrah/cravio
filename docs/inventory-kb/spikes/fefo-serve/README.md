# Spike: FEFO allocation inside the order-serve trigger (18 Nov 2026) — de-risks P3-16 / P3-18

Run it: `node docs/inventory-kb/spikes/fefo-serve/spike_test.mjs` (PGlite, 009 + proposed 012…017 + `spike_022.sql`; **35/35 checks pass**; real output in `output.txt`). Nothing touches the shared database.

| File | What it is |
| --- | --- |
| `spike_022.sql` | The batch part of migration 022 (`batches`, `batch_balances`, `stock_items.expiry_tracking`, the `stock_movements.batch_id` FK) and the three replaced/new functions: `private.allocate_fefo`, `private.sellable_qty`, and **replacements of `private.stock_on_serve`, `private.stock_check_new_lines` and `public.stock_menu_availability`** (same names, signatures, error codes) |
| `spike_test.mjs` | Scenarios S1–S10 below |
| `output.txt` | Output of the last run |

## Verdict

**P3-18 works as planned, and untracked items run the 013 code path unchanged.** One serve allocates across batches oldest-expiry-first, writes one movement per batch with that batch's id and cost, decrements `batch_balances`, stops at zero and logs the exception, and replays deduct once. Four things the plan did not say are now settled (below).

## What was proved

| # | Scenario | Result |
| --- | --- | --- |
| S1 | Batches A (+3 d), B (+5 d), C (+9 d), 5 each; serve 12 | A 5, B 5, C 2 (three `served` movements, `batch_id` set, same `ref` = the order line); batch balances 0/0/3; `on_hand` 3; ledger = `on_hand`; Σ batches = movements per batch; **one** `order_stock_effects` row linked to the first movement |
| S2 | C (3 left) expires; order for 1 | Refused at order time, `P0001 / stock_sold_out` ("Sold out: Wing"); `sellable_qty` 0 while `on_hand` is 3. A manager override (`override_until = now()+24h`) makes C sellable and it is used; when the override lapses the item is blocked again |
| S3 | Keep-selling dish needs 7, only 4 sellable (plus 1 expired g) | Takes the 4, logs a `stock_exceptions` row with `short_qty 3`; the expired gram stays on hand untouched; no negative batch balance |
| S4 | Serve fired 5 times (status bounced back each time) | One deduction, one movement, one effect row (the 013 `order_stock_effects` key still guards replays) |
| S5 | Existing unbatched stock + an undated batch + a dated batch | Order: dated batch, undated batch, **"no batch" bucket last** |
| S6 | Quarantined batch | Never sold; not counted as sellable |
| S7 | Cost method | `weighted_average` (default): every movement at the item's average, 5 × 420 = 2,100. `cost_method = 'batch'`: each movement at its batch's cost (BB at 450 → 1,350 for 3). Earlier movements are **not** re-costed |
| S8 | Tracked + untracked ingredient in one dish | 6 g chicken = 3 from P + 3 from Q; buns plain (no batch) |
| S9 | One order, two lines of the same tracked item | Allocated line by line, no batch unit used twice, batches end exactly empty |
| S9b | `stock_menu_availability` for an expired-only dish | `available 0`, `sold_out true`, while `on_hand` is still 6 |
| S10 | **Regression drill**: 60 seeded random orders on untracked items, 013 functions vs the spike functions | Identical movement-by-movement (deltas, balance_after, unit_cost, value), same refusals (35 of 60 refused as sold out), same end balances |

## Decisions the spike settles (carry into 10 → P3-16/P3-17/P3-18/P3-19)

1. **The serve trigger writes reason `served`, not `pos_consumption`** (that is what 013 does; `pos_consumption` is reserved for later POS paths). The plan text in P3-18/P3-24 says `pos_consumption`: every report, variance and valuation query must count **both** `served` and `pos_consumption` as theoretical-use movements, and the FEFO function keeps writing `served`.
2. **Sellable ≠ on hand.** `sellable = on_hand − Σ batch_balances of unusable batches` (expired and not overridden, or quarantined). **Three** places must use it, not two: the order check (`stock_check_new_lines`), the availability function (`stock_menu_availability`) **and** serve. The plan names the first and last; the middle one was missing and is in the spike.
3. **Allocation order:** usable batches by `expiry_date` (soonest first, **undated batches after dated ones**), then `received_at`, then id; the no-batch bucket last. Expiry date is the last usable day (`expiry_date >= today in Africa/Nairobi`).
4. **`order_stock_effects` stays one row per (order line, item)**; its `movement_id` is the *first* movement only. Anything that needs every batch an order consumed (backward trace, P3-19) must go through `stock_movements.ref_type='order_item', ref_id=<order item>`, not through `order_stock_effects.movement_id`.
5. **Lock order** (must be copied into `ledger.allocate`/`postAllocated`): advisory lock (order check only) → `stock_balances` row → `batch_balances` rows in allocation order (`for update of bb`). Serve processes needs ordered by `item_id`, so two serves cannot deadlock on each other.
6. **The expired override reads `batches.override_until` directly**, so there is no state to clear when it lapses.

## Recommendation for P3-16 / P3-18

- Ship `spike_022.sql`'s function bodies in migration 022 (or `022b`), with `022_functions.down.sql` holding the exact 013 bodies. Keep the **three-function replacement together in one file** so one rehearsal covers it.
- Keep the `tracked` branch in `stock_on_serve` (`expiry_tracking <> 'off'`): untracked items take the 013 branch, proven identical by S10. Re-run S10 in the real test suite as **T-POS-FEFO-0** (compat drill) — it is cheap (~1 s) and is the best guard against breaking live orders.
- The plan's P3-18 estimate (4 d) stands. The spike removes the "can PGlite even do it" risk; what remains is real-Postgres concurrency (P3-21).
- Add `batch_id` to the `served` movement index only if reports need it (`stock_movements_batch_idx` is already partial).

## Limits of this spike (read before trusting it)

- **PGlite is single-connection.** Locking order, `for update` waits and the advisory lock are *written* the way real Postgres needs them but not *exercised*: S9 only proves line-by-line allocation inside one transaction. **P3-21 must still run 50 parallel serves of a tracked item on a disposable real Postgres** (no negative `batch_balances`, Σ batches = on-hand, reconciliation clean, no deadlock).
- The spike does not touch `order_correction` (an order edited after serving), cancelling a served order, or transfers/wastage of batches (P3-17 ledger side). Those are service-level and are covered by P3-17's own tests.
- Dates are relative to the real `now()`; tests expire a batch by moving its `expiry_date` to yesterday.
