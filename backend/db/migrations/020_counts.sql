-- 020 (PROPOSED, NOT APPLIED): stock counts (full / cycle / spot), their lines and the counters' entries.
-- Requires 012 (stock_items, stock_locations, stock_movements), 015 (document numbers: CNT-2026-0001) and 017 (approvals; subject 'count').
-- Phase 3, ticket P3-07 (the service is P3-08). See docs/inventory-kb/10-phase3-workplan.md (D3-5, P3-07/08) and the PROVEN design in
-- docs/inventory-kb/spikes/count-snapshot/ (spike_020.sql, 328 checks): variance is judged against the ledger at the moment the counter counted,
-- by LEDGER WATERMARK (movement id), never by time and never at posting time.
--
-- * stock_counts: one session at one location. type full | cycle | spot; blind hides the expected quantities from counters (the service never sends
--   them); status open -> counting -> under_review -> approved -> posted, or cancelled from any state before posted. snapshot_at and
--   snapshot_movement_id (the highest movement id of the business when the snapshot was taken) are written once, by the service's start. Filters:
--   category_ids / item_ids / zone say which items the session covers. At review the service freezes the totals (review_*) and who reviewed; the
--   approver approves THOSE numbers and posting writes exactly them. approval_id points at the approval (subject 'count') when one is needed.
-- * stock_count_lines: one item in a session. expected_base = on hand at the snapshot and snapshot_movement_id = highest movement id of that
--   (location, item) at the snapshot (both frozen once the session leaves 'open'). unit_cost is frozen at the snapshot. At review ("settle") the
--   service stores the chosen entry, final_counted_base, movements_since_base, variance_base and variance_value; they stay unchanged afterwards.
--   decision: what the reviewer did with the line (accepted | recount | skipped; skipped needs skip_reason). movement_id = the count_correction
--   movement posted for the line (written once).
-- * stock_count_entries: what a counter entered, APPEND-ONLY (two counters who disagree keep both numbers; a recount is a new entry). ledger_watermark =
--   the highest stock_movements.id for (location, item) at the moment the number was entered. variance = counted - (expected_base + sum of delta of
--   movements with snapshot_movement_id < id <= ledger_watermark).
-- Movement ids are monotone per (location, item) in commit order because every writer (ledger.post, the serve trigger, main's 009 code) takes the
-- stock_balances row lock before inserting; occurred_at can be back-dated and clocks skew, so time is never used.
-- Guards: no edits once a count is posted or cancelled; the frozen snapshot; entries append-only; the count's status only moves forward; at most one
-- OPEN FULL count per location (cycle and spot counts may overlap different items: the service checks). Nothing here seeds, backfills or touches
-- an existing table. RLS: API-only.
create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,
  number text not null check (char_length(number) <= 30),
  type text not null default 'full' check (type in ('full', 'cycle', 'spot')),
  blind boolean not null default false,
  status text not null default 'open' check (status in ('open', 'counting', 'under_review', 'approved', 'posted', 'cancelled')),
  category_ids uuid[] not null default '{}',
  item_ids uuid[] not null default '{}',
  zone text check (char_length(zone) <= 60),
  note text check (char_length(note) <= 500),
  snapshot_at timestamptz,
  snapshot_movement_id bigint,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_lines integer check (review_lines >= 0),
  review_expected_value numeric(16, 2),
  review_variance_value numeric(16, 2),
  review_variance_pct numeric(9, 2),
  review_unpriced_lines integer check (review_unpriced_lines >= 0),
  approval_id uuid,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  posted_at timestamptz,
  cancelled_at timestamptz,
  command_id uuid,
  unique (id, business_id),
  unique (business_id, number),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (approval_id, business_id) references public.approvals (id, business_id),
  constraint stock_counts_posted check ((status = 'posted') = (posted_at is not null)),
  constraint stock_counts_cancelled check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint stock_counts_snapshot_pair check ((snapshot_at is null) = (snapshot_movement_id is null)),
  constraint stock_counts_started check (status = 'open' or status = 'cancelled' or snapshot_at is not null)
);
create unique index if not exists stock_counts_command on public.stock_counts (business_id, command_id) where command_id is not null;
create unique index if not exists stock_counts_one_open_full on public.stock_counts (location_id) where type = 'full' and status in ('open', 'counting', 'under_review', 'approved');
create index if not exists stock_counts_log on public.stock_counts (business_id, location_id, created_at desc);
create index if not exists stock_counts_active on public.stock_counts (business_id, status) where status in ('open', 'counting', 'under_review', 'approved');

create table if not exists public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  business_id uuid not null,
  item_id uuid not null,
  expected_base numeric(18, 4) not null,
  snapshot_movement_id bigint not null default 0,
  unit_cost numeric(18, 6) check (unit_cost >= 0),
  status text not null default 'uncounted' check (status in ('uncounted', 'counted', 'recount', 'settled')),
  recount_requested_by uuid references auth.users(id) on delete set null,
  decision text check (decision in ('accepted', 'recount', 'skipped')),
  skip_reason text check (char_length(skip_reason) <= 280),
  chosen_entry_id uuid,
  final_counted_base numeric(18, 4) check (final_counted_base >= 0),
  movements_since_base numeric(18, 4),
  variance_base numeric(18, 4),
  variance_value numeric(14, 2),
  movement_id bigint references public.stock_movements(id) on delete set null,
  unique (id, business_id),
  unique (count_id, item_id),
  foreign key (count_id, business_id) references public.stock_counts (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id),
  constraint stock_count_lines_skip check ((decision = 'skipped') = (skip_reason is not null))
);
create index if not exists stock_count_lines_item on public.stock_count_lines (item_id);

create table if not exists public.stock_count_entries (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.stock_count_lines(id) on delete cascade,
  counter_id uuid references auth.users(id) on delete set null,
  qty_base numeric(18, 4) not null check (qty_base >= 0),
  entered_quantity numeric(18, 4) check (entered_quantity >= 0),
  entered_unit text check (char_length(entered_unit) between 1 and 40),
  counted_at timestamptz not null default now(),
  ledger_watermark bigint not null,
  is_recount boolean not null default false,
  note text check (char_length(note) <= 280)
);
create index if not exists stock_count_entries_line_idx on public.stock_count_entries (line_id, counted_at);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_count_lines_chosen_entry_fk') then
    alter table public.stock_count_lines add constraint stock_count_lines_chosen_entry_fk foreign key (chosen_entry_id) references public.stock_count_entries (id) on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
-- A count: nothing changes once it is posted or cancelled; the status only moves forward; the snapshot is written once (while open) and never changes;
-- the frozen review totals are written once, at review, and never change; no delete once the session has started.
create or replace function private.count_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.businesses b where b.id = old.business_id) and old.status <> 'open' then
      raise exception 'A count that has started is part of the stock history and can''t be deleted. Cancel it instead.' using errcode = '42501', hint = 'count_not_deletable';
    end if;
    return old;
  end if;
  if old.status in ('posted', 'cancelled') then
    raise exception 'A % count can''t be changed.', old.status using errcode = '23514', hint = 'count_closed';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'open' and new.status in ('counting', 'cancelled'))
    or (old.status = 'counting' and new.status in ('under_review', 'cancelled'))
    or (old.status = 'under_review' and new.status in ('counting', 'approved', 'posted', 'cancelled'))
    or (old.status = 'approved' and new.status in ('posted', 'cancelled'))) then
    raise exception 'A count that is % can''t become %.', old.status, new.status using errcode = '23514', hint = 'count_status_order';
  end if;
  if old.status <> 'open' and (new.snapshot_at is distinct from old.snapshot_at or new.snapshot_movement_id is distinct from old.snapshot_movement_id
      or new.type is distinct from old.type or new.location_id is distinct from old.location_id or new.blind is distinct from old.blind) then
    raise exception 'The snapshot, type, place and blind setting of a count are fixed once it has started.' using errcode = '23514', hint = 'count_snapshot_frozen';
  end if;
  if old.snapshot_at is not null and (new.snapshot_at is distinct from old.snapshot_at or new.snapshot_movement_id is distinct from old.snapshot_movement_id) then
    raise exception 'The snapshot of a count is written once.' using errcode = '23514', hint = 'count_snapshot_frozen';
  end if;
  if old.status in ('approved') and (new.review_lines is distinct from old.review_lines or new.review_expected_value is distinct from old.review_expected_value
      or new.review_variance_value is distinct from old.review_variance_value or new.review_variance_pct is distinct from old.review_variance_pct
      or new.review_unpriced_lines is distinct from old.review_unpriced_lines or new.approval_id is distinct from old.approval_id) then
    raise exception 'The numbers of an approved count are frozen: what was approved is what posts.' using errcode = '23514', hint = 'count_review_frozen';
  end if;
  return new;
end;
$$;
revoke all on function private.count_guard() from public, anon, authenticated;
drop trigger if exists stock_counts_guard on public.stock_counts;
create trigger stock_counts_guard before update or delete on public.stock_counts for each row execute function private.count_guard();

-- A line: expected_base / snapshot_movement_id / unit_cost freeze once the session leaves 'open'; no lines are added, changed or removed after
-- posting or cancelling; once approved only the posted movement id may be added (and status); a settled line is never un-settled by editing numbers.
create or replace function private.count_line_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  parent text;
  biz uuid;
begin
  if tg_op = 'DELETE' then
    select status into parent from public.stock_counts where id = old.count_id;
    if parent is null then return old; end if;       -- the whole count is going (cascade)
    raise exception 'The lines of a count can''t be deleted.' using errcode = '23514', hint = 'count_line_not_deletable';
  end if;
  select status into parent from public.stock_counts where id = new.count_id;
  if tg_op = 'INSERT' then
    if parent <> 'open' then
      raise exception 'Lines can only be added while the count is still open (before the snapshot is final).' using errcode = '23514', hint = 'count_snapshot_frozen';
    end if;
    return new;
  end if;
  if parent in ('posted', 'cancelled') then
    raise exception 'A % count can''t be changed.', parent using errcode = '23514', hint = 'count_closed';
  end if;
  if parent <> 'open' and (new.expected_base is distinct from old.expected_base or new.snapshot_movement_id is distinct from old.snapshot_movement_id
      or new.unit_cost is distinct from old.unit_cost or new.item_id is distinct from old.item_id) then
    raise exception 'The expected quantity is frozen once the count has started.' using errcode = '23000', hint = 'count_snapshot_frozen';
  end if;
  if parent = 'approved' and (to_jsonb(new) - array['movement_id']) is distinct from (to_jsonb(old) - array['movement_id']) then
    raise exception 'The numbers of an approved count are frozen: what was approved is what posts.' using errcode = '23514', hint = 'count_review_frozen';
  end if;
  if new.movement_id is distinct from old.movement_id and old.movement_id is not null then
    raise exception 'The correction posted for a count line is written once.' using errcode = '23514', hint = 'count_review_frozen';
  end if;
  return new;
end;
$$;
revoke all on function private.count_line_guard() from public, anon, authenticated;
drop trigger if exists stock_count_lines_frozen on public.stock_count_lines;
drop trigger if exists stock_count_lines_guard on public.stock_count_lines;
create trigger stock_count_lines_guard before insert or update or delete on public.stock_count_lines for each row execute function private.count_line_guard();

-- Entries: append-only, and only while the session can still take numbers (open, counting, or under review for a recount).
create or replace function private.count_entries_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  parent text;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.stock_count_lines l where l.id = old.line_id) then return old; end if;   -- the line is going (cascade)
  if tg_op <> 'INSERT' then
    raise exception 'Count entries cannot be changed or deleted.' using errcode = '23000', hint = 'count_entry_append_only';
  end if;
  select c.status into parent from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.id = new.line_id;
  if parent is null or parent not in ('open', 'counting', 'under_review') then
    raise exception 'This count is not taking numbers any more.' using errcode = '23514', hint = 'count_closed';
  end if;
  return new;
end;
$$;
revoke all on function private.count_entries_guard() from public, anon, authenticated;
drop trigger if exists stock_count_entries_append_only on public.stock_count_entries;
drop trigger if exists stock_count_entries_guard on public.stock_count_entries;
create trigger stock_count_entries_guard before insert or update or delete on public.stock_count_entries for each row execute function private.count_entries_guard();

-- ---------------------------------------------------------------------------
-- RLS: API-only (no policies, nothing granted to browser roles)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['stock_counts', 'stock_count_lines', 'stock_count_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
