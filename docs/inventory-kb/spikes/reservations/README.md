# Spike: reservations (18 Nov 2026) — reference for P2-19 (migration 018) and P2-20 (ledger reservations)

Run it: `node docs/inventory-kb/spikes/reservations/spike_test.mjs` (PGlite, 009 + proposed 012 + 013 + `spike_018.sql`; **56/56 checks pass**; real output in `output.txt`). Nothing touches the shared database. Same layout as `spikes/order-snapshot`.

| File | What it is |
| --- | --- |
| `spike_018.sql` | The reservation part of migration 018: `stock_reservations`, `stock_reservation_events`, and a backstop CHECK on `stock_balances` |
| `ledger_spike.js` | A copy of `backend/src/inventory/ledger.js` with `reserve`, `release`, `availability`, `reconcileReserved`, `reservationId` consumption inside `post()` and the `respectHeld` option (diff against the real file: `ledger.diff`) |
| `spike_test.mjs` | Scenarios S1–S10 below |
| `output.txt` | Output of the last run |

## Verdict

**The design in P2-20 works, with six refinements** (below). Every scenario in the plan passes and reservations never drifted from `stock_balances.reserved`, including after 400 random operations with the invariants re-checked after every step.

## What was proved (scenario → result)

| # | Scenario | Result |
| --- | --- | --- |
| S1 | Two approvals for the last 10 kg: A reserves, B is refused `409 insufficient_available` with `available: 0.0000`; B leaves **no** reservation row and its request stays `submitted` (the whole approval transaction rolled back); `Promise.allSettled([approve A, approve B])` → exactly one fulfils | pass |
| S2 | Asks 20 kg, 15 kg free: approving 20 is refused with "Only 15 kg … is free"; approving 15 works; available drops to 0 | pass |
| S3 | Dispatch **consumes** its reservation in one `post()`: `on_hand` and `reserved` both fall 15 kg, reservation → `consumed`; replaying the dispatch key returns the same movement and takes nothing twice | pass |
| S4 | While 8 kg of 10 is held: wastage of 3 kg → `stock_reserved`; a `transfer_dispatch` **without** the reservation id → `stock_reserved`; a reservation id on a non-consuming reason → `400 reservation_not_applicable`; a reservation of another item → `409 reservation_mismatch`; the 2 kg that is free can still be wasted; reserving at a branch → refused; a raw `UPDATE stock_balances set on_hand = on_hand - 1000` (what `main`'s 009 code would do) → refused by the DB check | pass |
| S5 | Cancel releases (reserved 0, available restored, reservation `released`); retrying the cancel changes nothing; releasing more than is held → `release_too_much` | pass |
| S6 | **Partial dispatch**: 5 of 8 kg leave, 3 kg **stay reserved** (reservation still `active`); a dispatch may use its own remainder **plus free stock** (3 reserved + 1 free = 4 kg ok) but never another request's hold (X's 7 kg with Y holding 4 refused; 6 kg allowed); dispatch 2 of 6 then **cancel** → only the undispatched 4 kg is released and the row closes as `consumed` | pass |
| S7 | Reserve is idempotent (same key → same reservation, held once); same key with another quantity → `idempotency_conflict`; a second active hold on the same request line → `already_reserved`; changing an approval = release + reserve in one transaction | pass |
| S8 | **Order holds combine**: branch 10 kg with an open order for 6 burgers (3 kg) → `available = 10 − 0 − 3 = 7 kg`; Warehouse 20 kg with a 12 kg reservation → `20 − 12 − 0 = 8 kg`. A branch dispatch with `respectHeld` of 8 kg is refused (`stock_held`), 7 kg allowed; afterwards the 013 order check refuses a new burger ("Sold out") because on-hand dropped | pass |
| S9 | 400 seeded random operations (reserve / release / dispatch / waste / receive): after **every** step `reserved = Σ active remainders`, `on_hand = Σ movements`, `reserved ≤ on_hand` (307 applied, 93 refused) | pass |
| S10 | Table checks: `consumed > reserved` and `status` out of step with the remainder are refused by the DB | pass |

## Decisions the spike settles (carry into 09 → P2-19/P2-20)

1. **Partial dispatch keeps the remainder reserved** until dispatched or cancelled (as the plan said). Cancel after a partial dispatch releases only the remainder (`qty_released`), and the row ends `consumed`; a reservation with nothing consumed ends `released`. `status = 'active'` exactly while `qty_consumed + qty_released < qty_reserved` (a CHECK, so it cannot drift).
2. **Dispatch rule**: `dispatch qty ≤ reservation remaining + free stock`, consumed reservation first. Implemented as: `consume = min(|qty|, remaining)`, then the existing guard `on_hand − |qty| ≥ reserved − consume` (so it can never touch **another** request's hold). `CONSUMES_RESERVATION` now only says which reasons may carry a `reservationId` (`transfer_dispatch`); the "never dip into reserved" guard became unconditional.
3. **Reservations exist only at the Warehouse** (`ledger.reserve` refuses `kind <> 'center'`, D2-12). Reason: sales at a branch (013 `stock_on_serve`, the order check, `stock_menu_availability`) read `on_hand` and the order snapshot and know nothing about `reserved`; a branch reservation would be silently oversold. The Warehouse has no orders, so `held = 0` there.
4. **Available = on_hand − reserved − held**, one function `availability()`: `reserved` is only ever non-zero at the Warehouse, `held` (013 `private.branch_committed`) only at branches. Branch → branch and return dispatches pass **`respectHeld: true`** to `post()`, which takes the **same advisory lock the 013 order check takes** (`hashtextextended(restaurant || item, 9)`) before the balance row, so a new order and a dispatch serialise instead of racing (no lock cycle: orders take only the advisory lock; serve takes only the row lock). A plain `post()` still ignores `held`, so POS/serve paths are unchanged.
5. **No `request_line_id`**: 009 `stock_request_lines` has PK `(request_id, item_id)` and no id. The reservation points at `(request_id, item_id)` with a composite FK; "one active per request line" is a partial unique index on that pair. This saves 018 a column on a table `main` writes (P2-19 text should say so).
6. **`stock_reservation_events`** (append-only: reserve / consume / release, with the movement id on consume) gives release its own idempotency key, links consumption to its ledger movement and lets reconciliation compare columns with the log. Reserve is idempotent on `(business_id, idempotency_key)`; consume is idempotent because the movement is (replay is detected **before** any lock-protected change).

## Recommendation for migration 018 and the ledger (P2-19 / P2-20)

**Migration 018 (reservation part)** — exactly `spike_018.sql`:
- `stock_reservations` (columns, checks and the partial unique/active indexes as in the spike) and `stock_reservation_events`; RLS on, no policies (API only), like 012/013.
- `alter table stock_balances add constraint stock_balances_reserved_within_on_hand check (reserved = 0 or on_hand >= reserved)`. This is the **backstop against any writer that bypasses `ledger.js`** — notably `main`'s 009 `dispatch`/`adjust` on the shared database. It is additive and satisfied by every existing row (all have `reserved = 0`); branches that overdraw with keep-selling dishes (`on_hand < 0`, `reserved = 0`) are exempt on purpose.
- Down: refuse while any reservation row exists; drop the constraint and the two tables.
- The 009 backfill reserves for approved-not-dispatched requests by calling the same logic in SQL (`reserved` raised and a reservation row written per line, in one statement per line, under the balance row lock); where free stock is short it reserves what is free and sets `needs_attention` (D2-15). Reconcile after the backfill.

**Ledger (P2-20)** — port `ledger_spike.js` (diff in `ledger.diff`):
- `post()`: new inputs `reservationId`, `respectHeld`; `CONSUMES_RESERVATION = {'transfer_dispatch'}`; one `UPDATE stock_balances set on_hand = on_hand + qty, reserved = reserved − consume` so the pair moves atomically; reservation + event rows written in the same transaction.
- New `reserve`, `release`, `availability`, `reconcileReserved` / `RECONCILE_RESERVED_SQL` (reserved vs Σ active remainders; `reconcile()` for on-hand stays as is). The scheduled reconciliation job runs both.
- Lock order everywhere: **advisory (branch only) → balance row → reservation row**; `postMany` already sorts by (location, item). Service code that touches several items must go through that order (approve lines sorted by item id, as the spike's `approve` does).
- Messages: `release_too_much` currently prints raw base units; the real one should use `display()` like the others.
- `T-INV-6` extension = S9 (the seeded random test) with the reserved reconciliation after every step; keep the seed fixed and print it on failure.

## Limits of this spike (read before trusting it)

- **PGlite is single-connection**, so the "race" is two transactions that PGlite queues one after the other (and `Promise.allSettled` over that queue). It proves the *outcome and the rollback*, not Postgres lock behaviour. The actual protection is `select … for update` on the balance row: under READ COMMITTED the second reservation re-reads the row after the first commits and sees the new `reserved`. **P2-30 must still run the two-connection race on real Postgres** (a disposable local one, never the shared database).
- The service functions in `spike_test.mjs` (`approve`, `dispatchLine`, `cancelRequest`) are stand-ins for P2-21; the real ones add permissions, `once()`, audit and the transfer rows.
- The legacy 009 flow (businesses with the module off) never reserves, so it cannot conflict; for a business that has just been switched on, 018's backfill creates the reservations and the DB check then protects them from `main`'s code.
