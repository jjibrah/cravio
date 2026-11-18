-- Rollback for 018_distribution.sql: puts the 009/012 shape of requests, request lines, transfers, transfer lines and balances back and drops
-- the reservation and discrepancy tables.
-- Refuses (and changes nothing) while any NEW-WORLD data exists, i.e. anything 009 could not have produced:
--   reservations or their events, stock held in stock_balances.reserved, discrepancies, requests with a new status / kind / priority / needed-by date /
--   needs-attention flag, request lines with a typed unit, transfers with a new status / direction / over quantity / approval, transfer lines with
--   damaged or over quantities or a typed unit, and more than one non-cancelled transfer for a request (the old unique index could not be restored).
-- What the backfill derived from 009 data (from/to location, approval metadata, completed_at, line dispatched/received, line unit_cost) is simply dropped;
-- applying 018 again derives it again.
-- Apply the down files of anything that builds on 018 (019 wastage, Phase 3) BEFORE this one.
do $$
declare
  n bigint;
  problems text[] := '{}';
begin
  if to_regclass('public.stock_reservations') is null and to_regclass('public.transfer_discrepancies') is null then return; end if;  -- 018 isn't applied

  select count(*) into n from public.stock_reservations;                                      if n > 0 then problems := problems || format('%s reservations', n); end if;
  select count(*) into n from public.stock_reservation_events;                                if n > 0 then problems := problems || format('%s reservation events', n); end if;
  select count(*) into n from public.stock_balances where reserved <> 0;                       if n > 0 then problems := problems || format('%s balances with stock held', n); end if;
  select count(*) into n from public.transfer_discrepancies;                                  if n > 0 then problems := problems || format('%s transfer discrepancies', n); end if;
  select count(*) into n from public.stock_requests
   where status not in ('submitted', 'approved', 'rejected', 'cancelled', 'dispatched', 'received')
      or kind <> 'stock' or priority <> 'normal' or needed_by is not null or needs_attention;
  if n > 0 then problems := problems || format('%s requests using the new statuses or fields', n); end if;
  select count(*) into n from public.stock_request_lines where entered_unit is not null or entered_quantity is not null;
  if n > 0 then problems := problems || format('%s request lines with a typed unit', n); end if;
  select count(*) into n from public.stock_transfers
   where status not in ('in_transit', 'received', 'cancelled') or direction <> 'out' or over_qty <> 0 or approved_by is not null or approved_at is not null;
  if n > 0 then problems := problems || format('%s transfers using the new statuses or fields', n); end if;
  select count(*) into n from public.stock_transfer_lines where damaged <> 0 or over <> 0 or entered_unit is not null;
  if n > 0 then problems := problems || format('%s transfer lines with damaged, extra or typed-unit quantities', n); end if;
  select count(*) into n from (select request_id from public.stock_transfers where request_id is not null and status <> 'cancelled' group by request_id having count(*) > 1) d;
  if n > 0 then problems := problems || format('%s requests with more than one non-cancelled transfer', n); end if;

  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 018: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

alter table public.stock_balances drop constraint if exists stock_balances_reserved_within_on_hand;
drop table if exists public.stock_reservation_events;
drop table if exists public.stock_reservations;
drop table if exists public.transfer_discrepancies;
drop function if exists private.backfill_distribution_018();

-- Transfers: the 009 "one non-cancelled transfer per request" index, the 009 statuses, and no direction guard.
drop trigger if exists stock_transfers_direction_guard on public.stock_transfers;
drop function if exists private.transfer_direction_guard();
drop index if exists public.stock_transfers_one_per_request;
create unique index if not exists stock_transfers_one_per_request on public.stock_transfers (request_id) where request_id is not null and status <> 'cancelled';
alter table public.stock_transfers drop constraint if exists stock_transfers_status_check;
alter table public.stock_transfers add constraint stock_transfers_status_check check (status in ('in_transit', 'received', 'cancelled'));
alter table public.stock_transfers drop column if exists direction, drop column if exists approved_by, drop column if exists approved_at, drop column if exists over_qty;
alter table public.stock_transfer_lines drop column if exists damaged, drop column if exists over, drop column if exists entered_unit, drop column if exists unit_cost;

-- Requests.
drop index if exists public.stock_requests_attention_idx;
alter table public.stock_requests drop constraint if exists stock_requests_from_fkey, drop constraint if exists stock_requests_to_fkey;
alter table public.stock_requests drop constraint if exists stock_requests_status_check;
alter table public.stock_requests add constraint stock_requests_status_check check (status in ('submitted', 'approved', 'rejected', 'cancelled', 'dispatched', 'received'));
alter table public.stock_requests
  drop column if exists kind, drop column if exists from_location, drop column if exists to_location, drop column if exists priority,
  drop column if exists needed_by, drop column if exists approved_by, drop column if exists approved_at,
  drop column if exists needs_attention, drop column if exists completed_at;
alter table public.stock_request_lines
  drop column if exists dispatched, drop column if exists received, drop column if exists entered_quantity, drop column if exists entered_unit;

notify pgrst, 'reload schema';
