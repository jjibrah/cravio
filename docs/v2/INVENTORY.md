# Inventory (V2-05 → V2-07) and migration 009 review pack

Status: **implemented on v2-dev; migration 009 PROPOSED, NOT applied.** Until it is applied, Inventory pages say “isn’t switched on yet” and ordering/serving behave exactly as before. Rehearsed on disposable PGlite (`npm run test:v2`, 58 inventory checks incl. rollback).

## Rules (product owner answers, 16 Nov 2026)

| Topic | Rule implemented |
| --- | --- |
| Unit | **Servings.** Stock items belong to the business; every location (the business's **main center**, each branch) has its own balance. |
| Dishes | A branch dish is tracked when linked to a stock item, with *servings per dish* (e.g. large pilau = 2). Unlinked dishes and extras are untracked. A deal uses its component dishes' links. |
| When stock leaves | **On serving** the order — atomically with the status change, once per line (retry-safe). |
| Before serving | Confirmed orders **hold** servings (on hand − held = available), so the last portion can't be sold twice. Editing/cancelling before serving moves no stock and releases the hold. |
| After serving | Branch manager records an **order correction** (e.g. Fanta returned unopened, Coke given instead). The bill is not changed. |
| Zero stock | Dish shows **Sold out** (guest and waiter menus) and new orders for it are refused, unless the branch manager switches on **Keep selling when out** for that dish (override; the balance may go negative and shows “Count needed”). |
| Who corrects | Branch manager (count, add, waste with reason, order corrections). Business owner at the main center. Waiters: none. |
| Requests | Branch manager → **business owner**. Owner approves per line (full, partial, 0) or rejects with a reason. Approval moves no stock. |
| Fulfilment | Owner **dispatches** from the main center (from an approved request, or directly). Numbered dispatch + 10-character code + **QR** on a printable note. Stock leaves the center at dispatch (in transit). |
| Receipt | Destination branch manager scans the QR (or opens Deliveries), counts each line (≤ sent); received servings enter the branch. A shortfall needs a note and stays recorded on the dispatch for the owner. Owner can cancel an un-received dispatch (servings return to the center). |
| Opening stock | A **count** (sets the balance; the difference is recorded). “Add stock” is for supplier deliveries / own production. |

Comparable systems follow the same request → approve (partial/reject) → dispatch (in transit, numbered document) → receive-with-discrepancy flow (e.g. Supy, Papaya, HotWax, Odoo inter-warehouse transfers). Shortfalls are recorded rather than auto-returned, as in those systems.

Not included: batch/serial tracking, recipes/ingredients, purchasing, warehouse dashboard, POS import, inter-branch transfers (only main center → branch), notifications beyond the in-app low/out banner and counts.

## Migration 009 (`backend/db/proposed/009_inventory.sql`)

- Tables: `stock_items`, `stock_locations` (one center per business + branch locations), `stock_balances`, `menu_item_stock`, `stock_requests(+_lines)`, `stock_transfers(+_lines)`, `stock_movements` (append-only ledger), `order_stock_effects` (idempotency of serving), `stock_commands` (idempotent API retries).
- Triggers: `order_items_stock_check` (statement-level, advisory lock per branch×item, refuses sold-out lines with `P0001 / hint stock_sold_out` → API 409) and `orders_stock_on_serve` (deducts on `taken|accepted → served`).
- RLS: browsers read stock items and dish links only; everything else via the API, which checks branch membership / business grant.
- **Shared database note:** the triggers also apply to orders created/served by the main baseline. Main shows a generic error if a sold-out dish is ordered; nothing is tracked until someone links a dish, so main is unaffected until inventory is set up.

Apply: snapshot, move the file to `db/migrations/`, `npm run db:migrate -- --dry-run` (only 009), `npm run db:migrate`. Check: v2 Inventory pages load (empty); an order for an untracked dish still works in main and v2.

Rollback: `backend/db/proposed/009_inventory.down.sql` — refuses while stock history/requests exist; export `stock_*` tables first, then clear deliberately. Orders, menus and restaurants are never touched; dropping the triggers just stops stock checks.

Known limits: the two-waiter race is guarded by advisory locks inside the order-insert statement, verified sequentially on PGlite; a true parallel test needs a real Postgres instance (not run against the shared DB).
