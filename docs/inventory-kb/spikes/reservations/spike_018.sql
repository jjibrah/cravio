-- Spike for migration 018 (reservation part only): stock_reservations + stock_reservation_events + a backstop on stock_balances.
-- Applied on top of 009 + proposed 012 + 013 on PGlite. Strictly additive (new tables, one new CHECK that is satisfied by
-- every existing row because 012 created stock_balances.reserved with default 0).

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

alter table public.stock_reservations enable row level security;
alter table public.stock_reservation_events enable row level security;
