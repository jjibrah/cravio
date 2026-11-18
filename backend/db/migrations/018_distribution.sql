-- 018 (PROPOSED, NOT APPLIED): distribution upgrade (requests, dispatches, receipts, discrepancies) + stock reservations + a 009 metadata backfill.
-- Requires 009 and 012 (numeric(18,4), stock_balances.reserved, 'warehouse' location kind), 013 (private.branch_committed, only read by ledger.js) and 017 (approval subject 'transfer').
-- Phase 2, ticket P2-19. See docs/inventory-kb/09-phase2-workplan.md (P2-19, D2-1, D2-2, D2-12, D2-15) and docs/inventory-kb/spikes/reservations/ (spike_018.sql is the reservation part, unchanged).
--
-- THE RISKIEST STEP: it alters stock_requests, stock_request_lines, stock_transfers, stock_transfer_lines and stock_balances, tables the live 009 code
-- (backend/src/stock/service.js on `main`) reads and writes. So it is strictly additive for that code:
--   * new columns are nullable or have defaults, and 009's INSERTs and UPDATEs name only the columns they know (`select *` just returns more);
--   * the status checks are SUPERSETS (every 009 value stays valid);
--   * the "one transfer per request" unique index is relaxed (non-cancelled -> OPEN), never tightened, so nothing 009 does can newly violate it;
--   * the only new constraint on an existing table that could ever refuse a 009 write is stock_balances_reserved_within_on_hand (reserved = 0 or on_hand >= reserved).
--     It is satisfied by every existing row (reserved is 0 everywhere) and stays satisfied for as long as nothing reserves stock. Nothing in this
--     file reserves stock. The 009 code never reserves, so it can never trip it. (See the BACKFILL note below for why.)
--
-- BACKFILL (data only, idempotent, no stock moves, NO RESERVATIONS): D2-15 and the plan asked for "approved-but-not-dispatched 009 requests get reservations at
-- the migration". That is deliberately NOT done here: `main`'s 009 dispatch cannot consume a reservation, so reserving stock for a request that `main` is
-- still going to dispatch would make that dispatch fail the check above (on_hand - q < reserved) for a business that has not switched the module on.
-- Reservations for legacy approved requests are created by the NEW engine at the moment a business switches on (ledger.reserve, oldest request first,
-- needs_attention = true when stock is short). What 018 backfills is only the metadata the new engine needs to adopt them: kind, from/to location,
-- approval metadata, request line dispatched/received, transfer line cost, completed_at. It is re-runnable: `select private.backfill_distribution_018()`
-- (the switch-on code and the P2-31 release run it again to pick up requests `main` created after 018; it only fills what is still empty).
--
-- Idempotent: every statement can be re-run. Down: 018_distribution.down.sql (refuses when new-world data exists).

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- stock_requests
-- ---------------------------------------------------------------------------
alter table public.stock_requests drop constraint if exists stock_requests_status_check;
alter table public.stock_requests add constraint stock_requests_status_check check (status in (
  'draft', 'submitted', 'pending_approval', 'approved', 'partially_approved', 'rejected', 'preparing', 'dispatched',
  'partially_received', 'received', 'completed', 'cancelled'));
alter table public.stock_requests
  add column if not exists kind text not null default 'stock' check (kind in ('stock', 'return', 'branch_transfer')),
  add column if not exists from_location uuid,
  add column if not exists to_location uuid,
  add column if not exists priority text not null default 'normal' check (priority in ('low', 'normal', 'urgent')),
  add column if not exists needed_by date,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists needs_attention boolean not null default false,
  add column if not exists completed_at timestamptz;
-- 009 shape: Warehouse (the business's center) -> the requesting branch. NULL until the backfill (or the new engine) fills them.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_requests'::regclass and conname = 'stock_requests_from_fkey') then
    alter table public.stock_requests add constraint stock_requests_from_fkey foreign key (from_location, business_id) references public.stock_locations (id, business_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_requests'::regclass and conname = 'stock_requests_to_fkey') then
    alter table public.stock_requests add constraint stock_requests_to_fkey foreign key (to_location, business_id) references public.stock_locations (id, business_id);
  end if;
end;
$$;
create index if not exists stock_requests_attention_idx on public.stock_requests (business_id) where needs_attention;

-- ---------------------------------------------------------------------------
-- stock_request_lines (no id in 009: a line is (request_id, item_id), and stays that way)
-- ---------------------------------------------------------------------------
-- `approved` already exists. What is reserved lives ONLY in stock_reservations (one source of truth, no copy to drift), so there is no `reserved` column here.
-- The source location is the request's from_location (always the Warehouse, D2-1), so no per-line source either.
alter table public.stock_request_lines
  add column if not exists dispatched numeric(18, 4) not null default 0 check (dispatched >= 0),
  add column if not exists received numeric(18, 4) not null default 0 check (received >= 0),
  add column if not exists entered_quantity numeric(18, 4) check (entered_quantity > 0),     -- what the person typed (e.g. 2) ...
  add column if not exists entered_unit text check (char_length(entered_unit) <= 40);        -- ... and in which unit (e.g. sack)

-- ---------------------------------------------------------------------------
-- stock_transfers / stock_transfer_lines
-- ---------------------------------------------------------------------------
alter table public.stock_transfers drop constraint if exists stock_transfers_status_check;
alter table public.stock_transfers add constraint stock_transfers_status_check check (status in (
  'pending_approval', 'in_transit', 'partially_received', 'received', 'cancelled'));
alter table public.stock_transfers
  add column if not exists direction text not null default 'out' check (direction in ('out', 'return', 'branch_to_branch')),
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists over_qty numeric(18, 4) not null default 0 check (over_qty >= 0);

-- direction must match the location kinds: out = Warehouse -> branch, return = branch -> Warehouse, branch_to_branch = branch -> branch.
-- (A CHECK cannot look at another table, so a trigger does it; it only runs when a row is inserted or one of the three columns changes,
-- so 009 rows and 009 writes (always center -> branch, default direction 'out') pass untouched.)
create or replace function private.transfer_direction_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  from_kind text;
  to_kind text;
begin
  select kind into from_kind from public.stock_locations where id = new.from_location;
  select kind into to_kind from public.stock_locations where id = new.to_location;
  if not (
    (new.direction = 'out' and from_kind in ('center', 'warehouse') and to_kind = 'branch')
    or (new.direction = 'return' and from_kind = 'branch' and to_kind in ('center', 'warehouse'))
    or (new.direction = 'branch_to_branch' and from_kind = 'branch' and to_kind = 'branch')
  ) then
    raise exception 'A % transfer cannot go from a % to a %.', new.direction, coalesce(from_kind, 'missing location'), coalesce(to_kind, 'missing location')
      using errcode = '23514', constraint = 'stock_transfers_direction_matches_locations';
  end if;
  return new;
end;
$$;
revoke all on function private.transfer_direction_guard() from public, anon, authenticated;
drop trigger if exists stock_transfers_direction_guard on public.stock_transfers;
create trigger stock_transfers_direction_guard before insert or update of direction, from_location, to_location on public.stock_transfers
  for each row execute function private.transfer_direction_guard();

-- 009: one non-cancelled transfer per request. Now: one OPEN transfer per request, so the remainder of a partly dispatched request can be sent
-- (a received or cancelled transfer no longer blocks the next one). Strictly looser than 009's index.
drop index if exists public.stock_transfers_one_per_request;
create unique index if not exists stock_transfers_one_per_request on public.stock_transfers (request_id)
  where request_id is not null and status in ('pending_approval', 'in_transit', 'partially_received');

alter table public.stock_transfer_lines
  add column if not exists damaged numeric(18, 4) not null default 0 check (damaged >= 0),
  add column if not exists over numeric(18, 4) not null default 0 check (over >= 0),
  add column if not exists entered_unit text check (char_length(entered_unit) <= 40),
  add column if not exists unit_cost numeric(18, 6) check (unit_cost >= 0);       -- carried from the dispatch movement so the branch receives at the same cost

-- ---------------------------------------------------------------------------
-- Discrepancies: what did not arrive as sent (one row per transfer line and kind while open)
-- ---------------------------------------------------------------------------
create table if not exists public.transfer_discrepancies (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  kind text not null check (kind in ('short', 'damaged', 'over')),
  qty_base numeric(18, 4) not null check (qty_base > 0),
  value_kes numeric(14, 2) check (value_kes >= 0),
  status text not null default 'open' check (status in ('open', 'resolved')),
  bearer text check (bearer in ('carrier', 'source', 'destination')),      -- who carries the loss; decided on resolution
  resolution text check (resolution in ('write_off', 'returned_to_source', 'arrived_later', 'source_deducts')),
  resolution_movement_id bigint references public.stock_movements(id),
  resolution_note text check (char_length(resolution_note) <= 280),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  note text check (char_length(note) <= 280),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (transfer_id, item_id) references public.stock_transfer_lines (transfer_id, item_id) on delete cascade,
  constraint transfer_discrepancies_resolved check (
    (status = 'open' and resolution is null and resolved_at is null and resolved_by is null and resolution_movement_id is null)
    or (status = 'resolved' and resolution is not null and bearer is not null and resolved_at is not null))
);
create unique index if not exists transfer_discrepancies_one_open on public.transfer_discrepancies (transfer_id, item_id, kind) where status = 'open';
create index if not exists transfer_discrepancies_business_idx on public.transfer_discrepancies (business_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Reservations (exactly spikes/reservations/spike_018.sql)
-- ---------------------------------------------------------------------------
create table if not exists public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,                      -- the Warehouse (ledger.reserve refuses non-center locations, D2-12)
  item_id uuid not null,
  -- 009 request lines have no id (PK is request_id + item_id), so a reservation points at (request, item): one line = one item.
  request_id uuid not null,
  qty_reserved numeric(18, 4) not null check (qty_reserved > 0),
  qty_consumed numeric(18, 4) not null default 0 check (qty_consumed >= 0),
  qty_released numeric(18, 4) not null default 0 check (qty_released >= 0),
  status text not null default 'active' check (status in ('active', 'consumed', 'released')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (item_id) references public.stock_items (id),
  foreign key (request_id, item_id) references public.stock_request_lines (request_id, item_id) on delete cascade,
  check (qty_consumed + qty_released <= qty_reserved),
  -- status always agrees with the remainder: active <=> something is still held; closed as 'consumed' when anything left the shelf.
  check ((status = 'active') = (qty_consumed + qty_released < qty_reserved)),
  check (status <> 'released' or qty_consumed = 0),
  check (status <> 'consumed' or qty_consumed > 0),
  unique (business_id, idempotency_key)
);
-- One active reservation per request line.
create unique index if not exists stock_reservations_one_active on public.stock_reservations (request_id, item_id) where status = 'active';
-- Reconciliation and availability read active rows per (location, item).
create index if not exists stock_reservations_active_idx on public.stock_reservations (location_id, item_id) where status = 'active';

-- Append-only log of what happened to a reservation. Gives release its own idempotency key, links consumption to its movement,
-- and lets a second reconciliation prove qty_consumed / qty_released against the log.
create table if not exists public.stock_reservation_events (
  id bigint generated always as identity primary key,
  reservation_id uuid not null references public.stock_reservations(id) on delete cascade,
  kind text not null check (kind in ('reserve', 'consume', 'release')),
  qty numeric(18, 4) not null check (qty > 0),
  reason text,
  movement_id bigint references public.stock_movements(id),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 120),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (reservation_id, kind, idempotency_key),
  check ((kind = 'consume') = (movement_id is not null))
);

-- Backstop for any writer that does not go through ledger.js (e.g. main's 009 code on the shared database):
-- on-hand can never be pulled below what is held. Rows with nothing reserved (the whole of today's data, and every branch,
-- where keep-selling dishes may overdraw on_hand) are unaffected.
alter table public.stock_balances drop constraint if exists stock_balances_reserved_within_on_hand;
alter table public.stock_balances add constraint stock_balances_reserved_within_on_hand check (reserved = 0 or on_hand >= reserved);

-- ---------------------------------------------------------------------------
-- Backfill of 009 data (metadata only; see the header). Safe to run any number of times.
-- ---------------------------------------------------------------------------
create or replace function private.backfill_distribution_018()
returns void language plpgsql set search_path = '' as $$
begin
  -- 1. Requests: Warehouse -> the requesting branch (when the branch already has its stock location), approval metadata, completion time.
  update public.stock_requests q set from_location = (select l.id from public.stock_locations l where l.business_id = q.business_id and l.kind = 'center')
   where q.from_location is null and q.kind = 'stock';
  update public.stock_requests q set to_location = (select l.id from public.stock_locations l where l.restaurant_id = q.restaurant_id)
   where q.to_location is null and q.kind = 'stock';
  update public.stock_requests q set approved_by = q.reviewed_by, approved_at = q.reviewed_at
   where q.approved_by is null and q.approved_at is null and q.status in ('approved', 'dispatched', 'received') and q.reviewed_at is not null;
  update public.stock_requests q set completed_at = coalesce(
      (select max(t.received_at) from public.stock_transfers t where t.request_id = q.id and t.status = 'received'), q.updated_at)
   where q.completed_at is null and q.status = 'received';

  -- 2. Request lines: what went out and what arrived, from the request's live transfer (in transit or received; a cancelled one sent nothing).
  --    Only lines nobody has touched (dispatched = 0 and received = 0) of requests that hold no reservation, so a re-run never overwrites new-engine progress.
  update public.stock_request_lines rl set dispatched = tl.quantity, received = coalesce(tl.received, 0)
    from public.stock_transfers t
    join public.stock_transfer_lines tl on tl.transfer_id = t.id
   where t.request_id = rl.request_id and tl.item_id = rl.item_id and t.status in ('in_transit', 'received')
     and rl.dispatched = 0 and rl.received = 0
     and not exists (select 1 from public.stock_reservations r where r.request_id = rl.request_id);

  -- 3. Transfer lines: the cost the stock left at. The dispatch movement's cost when it has one; for dispatches still in transit (which the new engine
  --    will receive) the item's current average cost as the best available figure. Received and cancelled legacy lines stay empty.
  update public.stock_transfer_lines tl set unit_cost = m.unit_cost
    from public.stock_movements m
   where tl.unit_cost is null and m.transfer_id = tl.transfer_id and m.item_id = tl.item_id and m.reason in ('dispatched', 'transfer_dispatch') and m.unit_cost is not null;
  update public.stock_transfer_lines tl set unit_cost = i.avg_cost
    from public.stock_transfers t, public.stock_items i
   where tl.unit_cost is null and t.id = tl.transfer_id and t.status = 'in_transit' and i.id = tl.item_id and i.avg_cost is not null;
end;
$$;
revoke all on function private.backfill_distribution_018() from public, anon, authenticated;
select private.backfill_distribution_018();

-- ---------------------------------------------------------------------------
-- RLS: API-only (no policies, nothing granted to browser roles)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['stock_reservations', 'stock_reservation_events', 'transfer_discrepancies'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
