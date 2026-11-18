# Spike: order stock snapshot (18 Nov 2026) — reference for P1-09 / migration 013

Proved on PGlite (18/18 checks): each order line's ingredient needs are snapshotted at insert time for dishes,
deal components and extras (yield applied, 4 dp); the 009 sold-out check and serve deduction read the snapshot
with unchanged signatures and error contract (`P0001` / `stock_sold_out`).

Findings to carry into 013:
- Snapshot trigger must be **row-level** AFTER INSERT (`order_items_a_snapshot`): Postgres fires all row-level AFTER
  triggers before any statement-level one, so it always precedes `order_items_stock_check` (proved by `probe_order.mjs`).
  Keep an ordering test in the suite.
- Snapshot PK `(order_item_id, item_id, source, ref_id)` (ref = dish id or extra id); aggregate per (line, item) at read time.
- Widen 009 quantities `numeric(12,3)` → `numeric(18,4)` (balances, movements, order_stock_effects) — do it in 012.
- Back-fill snapshots for orders already `taken/accepted` when 013 is applied.
- Still to build in 013: recipe-version immutability, stop-at-0 + `stock_exceptions` + notifications, `unit_cost` on serve,
  rewrite `stock_menu_availability`, RLS on new tables, safe uuid casts in jsonb, 013 down migration before 009's.
Files here are spike code (paths point at the scratchpad and repo test support); not wired into the app.
