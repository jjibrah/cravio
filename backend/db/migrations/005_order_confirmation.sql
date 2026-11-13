-- 005: the agreed order flow (docs/ORDER-FLOW.md). The guest taps "Ready to order", a waiter scans the guest's
-- QR (or types the code) at the table, confirms the order with the guest, and the order is created as `taken`
-- ("Confirmed"). There is no separate accept step: new orders go taken -> served -> paid.
-- Builds on 003 (orders, guest_carts). Every statement is idempotent, like 003 and 004.
--
-- * orders.confirmation: how the order was confirmed. 'qr' (the waiter scanned the guest's QR), 'code' (the
--   waiter typed the 6-character code from the guest's screen) or 'manual' (entered by the waiter without a
--   guest cart, so not confirmed by the guest). Null on orders entered before this migration.
-- * guest_carts.ready_at: when the guest last tapped "Ready to order". Ready, unclaimed, unexpired carts are
--   the "Table 7 is ready to order" items on the staff live screen.
-- * 003 required accepted_at on every served or paid order. Orders now skip `accepted`, so that check is
--   replaced by one that only requires accepted_at on orders that are `accepted` (older orders).

alter table public.orders add column if not exists confirmation text
  check (confirmation in ('qr', 'code', 'manual'));
comment on column public.orders.confirmation is
  'How the order was confirmed: qr (guest QR scanned), code (guest code typed), manual (entered by staff, not confirmed by the guest). Null before migration 005.';

alter table public.guest_carts add column if not exists ready_at timestamptz;
comment on column public.guest_carts.ready_at is
  'When the guest last tapped "Ready to order". Ready, unclaimed, unexpired carts show on the staff live screen.';

-- Served and paid orders no longer need an accepted time. 003 created that check without a name, so find it
-- by its definition.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.orders'::regclass and contype = 'c'
      and conname <> 'orders_accepted_has_time'
      and pg_get_constraintdef(oid) ilike '%accepted_at IS NOT NULL%'
  loop
    execute format('alter table public.orders drop constraint %I', c.conname);
  end loop;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_accepted_has_time'
  ) then
    alter table public.orders add constraint orders_accepted_has_time check (status <> 'accepted' or accepted_at is not null);
  end if;
end;
$$;

-- The live screen reads ready, unclaimed carts per restaurant on every poll.
create index if not exists guest_carts_ready_idx on public.guest_carts (restaurant_id, ready_at)
  where claimed_at is null and ready_at is not null;

-- The aggregate functions (ops_totals, ops_series, ops_best_sellers, ops_table_stats, ops_dish_performance)
-- count orders by `cancelled`/`paid` and treat taken, accepted and served as open. That stays correct: older
-- `accepted` orders are still open until served and paid. ops_live_cursor is unchanged: the API adds a
-- fingerprint of the ready carts to it (carts expire without an update, which no SQL max() would notice).

notify pgrst, 'reload schema';
