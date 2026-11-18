-- SPIKE for P3-07 / P3-08 (migration 020): count snapshot fairness. Not a real migration. Applied on 009 + proposed 012..017.
-- Differences from the plan text (see README):
--   * every line stores a LEDGER WATERMARK at snapshot (snapshot_movement_id = highest stock_movements.id for that location+item)
--     and every counter ENTRY stores its own watermark (ledger_watermark): movements are compared by id, never by timestamp
--     (occurred_at can be back-dated; clocks skew; the balance row lock makes ids monotone per location+item);
--   * variance = counted - (expected at snapshot + movements with  snapshot_movement_id < id <= entry.ledger_watermark),
--     i.e. against what the system said AT THE MOMENT THE COUNTER COUNTED, not at posting time.

create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id),
  number text not null,
  type text not null default 'full' check (type in ('full', 'cycle', 'spot')),
  blind boolean not null default false,
  status text not null default 'open' check (status in ('open', 'counting', 'under_review', 'approved', 'posted', 'cancelled')),
  snapshot_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, number)
);
create unique index if not exists stock_counts_one_open_full on public.stock_counts (location_id)
  where type = 'full' and status in ('open', 'counting', 'under_review', 'approved');

create table if not exists public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  item_id uuid not null references public.stock_items(id),
  expected_base numeric(18, 4) not null,
  snapshot_movement_id bigint not null default 0,
  unit_cost numeric(18, 6),
  status text not null default 'uncounted' check (status in ('uncounted', 'counted', 'recount', 'settled')),
  chosen_entry_id uuid,
  final_counted_base numeric(18, 4),
  movements_since_base numeric(18, 4),
  variance_base numeric(18, 4),
  variance_value numeric(14, 2),
  movement_id bigint,
  unique (count_id, item_id)
);

create table if not exists public.stock_count_entries (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.stock_count_lines(id) on delete cascade,
  counter_id uuid references auth.users(id) on delete set null,
  qty_base numeric(18, 4) not null check (qty_base >= 0),
  counted_at timestamptz not null default now(),
  ledger_watermark bigint not null,
  is_recount boolean not null default false,
  note text check (char_length(note) <= 280)
);
create index if not exists stock_count_entries_line_idx on public.stock_count_entries (line_id, counted_at);

-- expected_base / snapshot_movement_id are frozen once the session leaves 'open'; entries are append-only.
create or replace function private.count_line_frozen() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.expected_base is distinct from old.expected_base or new.snapshot_movement_id is distinct from old.snapshot_movement_id)
     and (select status from public.stock_counts where id = old.count_id) <> 'open' then
    raise exception 'The expected quantity is frozen once the count has started.' using errcode = '23000', hint = 'count_snapshot_frozen';
  end if;
  return new;
end $$;
drop trigger if exists stock_count_lines_frozen on public.stock_count_lines;
create trigger stock_count_lines_frozen before update on public.stock_count_lines for each row execute function private.count_line_frozen();

create or replace function private.count_entries_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Count entries cannot be changed or deleted.' using errcode = '23000', hint = 'count_entry_append_only'; end $$;
drop trigger if exists stock_count_entries_append_only on public.stock_count_entries;
create trigger stock_count_entries_append_only before update or delete on public.stock_count_entries for each row execute function private.count_entries_append_only();
