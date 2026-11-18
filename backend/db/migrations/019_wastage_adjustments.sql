-- 019 (PROPOSED, NOT APPLIED): reason codes, wastage, stock adjustments and allowance usage.
-- Requires 012 (stock_items, stock_locations, stock_movements), 015 (document numbers), 016 (attachments) and 017 (approvals).
-- Phase 3, tickets P3-03 / P3-04 (and the tables P3-05 builds on). See docs/inventory-kb/10-phase3-workplan.md (P3-03..P3-05, D3-4, D3-6) and
-- 03-prd-digest.md (WST-1..5, ADJ-1..3).
--
-- * stock_reason_codes: the owner's list of reasons (kind wastage | adjustment | staff_meal | complimentary). NOT seeded here: the service seeds
--   the defaults per business the first time the list is read (so a business that never uses wastage gets no rows). A used code is deactivated, never
--   deleted (the guard refuses a delete while any wastage record or adjustment points at it; the service never deletes at all).
-- * wastage_records (WST-1..5): a person writes stock off at a location, either ONE stock item (any unit) or ONE dish x portions (menu_item_id; the
--   service expands it through the recipe in force into wastage_record_lines). value_kes is FROZEN at record time from the weighted-average cost
--   (null when some ingredient has no cost yet: cost_unknown). status: recorded (no approval needed, posted at once) | pending_approval (nothing
--   posted yet) | approved (an approver said yes, then posted) | rejected (kept, nothing posted). movement_ids = the ledger movements (reason 'wastage'),
--   which also carry ref_type 'wastage' / ref_id = the record. reason_code_id is null only for legacy free-text reasons (reason_text keeps what was typed).
--   command_id makes a retried request return the same record. The record's number is WST-2026-0001 (numbers.js).
-- * wastage_record_lines: one row per stock item the record moves (a dish expands to several). Frozen with the record.
-- * stock_adjustments (ADJ-1..3): a gain or a loss with a reason, evidence and an approval. Table only here; the service is P3-05.
--   status: pending_approval -> approved | rejected; approved -> posted.
-- * allowance_usage: how much of the day's staff-meal / complimentary allowance a branch has used (day = Africa/Nairobi calendar day). The LIMITS stay in
--   inventory settings (staff_meal_allowance_portions, complimentary_allowance_kes, per business with per-branch overrides) so there is one place to edit
--   them; this table only counts usage. Maintained by the service in the same transaction as the movement (P3-05).
-- * attachments: the entity_type check is widened to accept 'wastage' (photo of what was thrown away) and 'adjustment' (evidence).
--
-- SHARED DATABASE: ADDITIVE ONLY (six new tables, three guard functions, one widened check on attachments). Existing rows and `main`'s code are untouched.
-- RLS: enabled with NO policies and no grants to browser roles: the API (service role) is the only reader and writer.
-- Idempotent: every statement can be re-run. Rollback: 019_wastage_adjustments.down.sql (refuses while any reason code, record, adjustment or usage row exists).

create schema if not exists private;

do $$
begin
  if to_regclass('public.approvals') is null then
    raise exception '019 needs migration 017 (approvals) first.';
  end if;
  if to_regclass('public.attachments') is null or to_regclass('public.inventory_number_sequences') is null then
    raise exception '019 needs migrations 015 and 016 first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reason codes
-- ---------------------------------------------------------------------------
create table if not exists public.stock_reason_codes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind in ('wastage', 'adjustment', 'staff_meal', 'complimentary')),
  code text not null check (code ~ '^[a-z0-9_]{1,40}$'),
  label text not null check (char_length(btrim(label)) between 1 and 60),
  needs_photo boolean not null default false,
  needs_note boolean not null default false,
  active boolean not null default true,
  position integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  unique (business_id, kind, code)
);
create index if not exists stock_reason_codes_list on public.stock_reason_codes (business_id, kind, position, label);

-- ---------------------------------------------------------------------------
-- Wastage
-- ---------------------------------------------------------------------------
create table if not exists public.wastage_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,
  number text not null check (char_length(number) <= 30),
  -- exactly one of the two (WST-5): a stock item, or a dish (no foreign key: a deleted dish must not erase its wastage history; its name is kept)
  item_id uuid,
  menu_item_id uuid,
  menu_item_name text check (char_length(menu_item_name) <= 200),
  -- What the person typed (an item in any of its units, or portions of a dish) and its base-unit value (portions for a dish).
  entered_quantity numeric(18, 4) not null check (entered_quantity > 0),
  entered_unit text not null check (char_length(entered_unit) between 1 and 40),
  qty_base numeric(18, 4) not null check (qty_base > 0),
  reason_code_id uuid,
  reason_text text check (char_length(reason_text) <= 60),      -- the code's label (or the legacy free text) at the time
  note text check (char_length(note) <= 500),
  photo_attachment_ids uuid[] not null default '{}',
  value_kes numeric(14, 2) check (value_kes >= 0),              -- frozen at record time; null when some ingredient had no cost
  cost_unknown boolean not null default false,
  status text not null check (status in ('recorded', 'pending_approval', 'approved', 'rejected')),
  movement_ids bigint[] not null default '{}',
  recorded_by uuid references auth.users(id) on delete set null,
  approval_id uuid,
  command_id uuid,
  occurred_at timestamptz not null default now(),
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  unique (business_id, number),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (item_id, business_id) references public.stock_items (id, business_id),
  foreign key (reason_code_id, business_id) references public.stock_reason_codes (id, business_id),
  foreign key (approval_id, business_id) references public.approvals (id, business_id),
  constraint wastage_records_one_subject check (num_nonnulls(item_id, menu_item_id) = 1),
  constraint wastage_records_dish_has_name check (menu_item_id is null or menu_item_name is not null),
  constraint wastage_records_has_reason check (reason_code_id is not null or char_length(btrim(coalesce(reason_text, ''))) > 0),
  constraint wastage_records_unposted check (status not in ('pending_approval', 'rejected') or movement_ids = '{}'),
  constraint wastage_records_cost_unknown check (cost_unknown = (value_kes is null))
);
create unique index if not exists wastage_records_command on public.wastage_records (business_id, command_id) where command_id is not null;
create index if not exists wastage_records_log on public.wastage_records (business_id, location_id, occurred_at desc);
create index if not exists wastage_records_item on public.wastage_records (business_id, item_id, location_id, occurred_at desc) where item_id is not null;
create index if not exists wastage_records_who on public.wastage_records (recorded_by, occurred_at desc);
create index if not exists wastage_records_reason on public.wastage_records (reason_code_id) where reason_code_id is not null;
create index if not exists wastage_records_pending on public.wastage_records (business_id, status) where status = 'pending_approval';

create table if not exists public.wastage_record_lines (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.wastage_records(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  item_id uuid not null,
  position integer not null default 0,
  qty_base numeric(18, 4) not null check (qty_base > 0),
  unit_cost numeric(14, 6) check (unit_cost >= 0),
  value_kes numeric(14, 2) check (value_kes >= 0),
  unique (record_id, item_id),
  foreign key (item_id, business_id) references public.stock_items (id, business_id)
);
create index if not exists wastage_record_lines_item on public.wastage_record_lines (business_id, item_id);

-- ---------------------------------------------------------------------------
-- Stock adjustments (service in P3-05)
-- ---------------------------------------------------------------------------
create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,
  number text not null check (char_length(number) <= 30),
  direction text not null check (direction in ('gain', 'loss')),
  item_id uuid not null,
  entered_quantity numeric(18, 4) not null check (entered_quantity > 0),
  entered_unit text not null check (char_length(entered_unit) between 1 and 40),
  qty_base numeric(18, 4) not null check (qty_base > 0),
  reason_code_id uuid not null,
  note text check (char_length(note) <= 500),
  evidence_attachment_ids uuid[] not null default '{}',
  value_kes numeric(14, 2) check (value_kes >= 0),
  status text not null check (status in ('pending_approval', 'approved', 'rejected', 'posted')),
  created_by uuid references auth.users(id) on delete set null,
  approval_id uuid,
  movement_id bigint references public.stock_movements(id) on delete set null,
  command_id uuid,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  unique (id, business_id),
  unique (business_id, number),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (item_id, business_id) references public.stock_items (id, business_id),
  foreign key (reason_code_id, business_id) references public.stock_reason_codes (id, business_id),
  foreign key (approval_id, business_id) references public.approvals (id, business_id),
  constraint stock_adjustments_posted check ((status = 'posted') = (posted_at is not null))
);
create unique index if not exists stock_adjustments_command on public.stock_adjustments (business_id, command_id) where command_id is not null;
create index if not exists stock_adjustments_log on public.stock_adjustments (business_id, location_id, created_at desc);
create index if not exists stock_adjustments_pending on public.stock_adjustments (business_id, status) where status in ('pending_approval', 'approved');

-- ---------------------------------------------------------------------------
-- Allowance usage (staff meals and complimentaries, per branch per Nairobi day)
-- ---------------------------------------------------------------------------
create table if not exists public.allowance_usage (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,
  day date not null,
  kind text not null check (kind in ('staff_meal', 'complimentary')),
  portions numeric(12, 2) not null default 0 check (portions >= 0),
  value_kes numeric(14, 2) not null default 0 check (value_kes >= 0),
  updated_at timestamptz not null default now(),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  unique (business_id, location_id, day, kind)
);

-- ---------------------------------------------------------------------------
-- Attachments: accept wastage photos and adjustment evidence (widens 016's check; the old list is still valid)
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.attachments drop constraint if exists attachments_entity_type_check;
  alter table public.attachments add constraint attachments_entity_type_check
    check (entity_type in ('po', 'grn', 'invoice', 'return', 'emergency', 'transfer', 'discrepancy', 'wastage', 'adjustment'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
-- A used reason code can't be deleted (deactivate it); its code and kind never change (history reads them).
create or replace function private.reason_code_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.businesses b where b.id = old.business_id) then return old; end if;
    if exists (select 1 from public.wastage_records w where w.reason_code_id = old.id) or exists (select 1 from public.stock_adjustments a where a.reason_code_id = old.id) then
      raise exception 'A reason code that has been used can''t be deleted. Deactivate it instead.' using errcode = '23514';
    end if;
    return old;
  end if;
  if new.code is distinct from old.code or new.kind is distinct from old.kind or new.business_id is distinct from old.business_id then
    raise exception 'A reason code''s kind and code can''t change. Rename its label, or add a new one.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.reason_code_guard() from public, anon, authenticated;
drop trigger if exists stock_reason_codes_guard on public.stock_reason_codes;
create trigger stock_reason_codes_guard before update or delete on public.stock_reason_codes for each row execute function private.reason_code_guard();

-- Wastage record: what was recorded never changes. Only the decision moves it: pending_approval -> approved | rejected, and the ledger movement ids are
-- written once (empty -> filled) when it is posted. No delete while the business exists.
create or replace function private.wastage_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'Wastage records are part of the stock history and can''t be deleted.' using errcode = '42501';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - array['status', 'movement_ids', 'posted_at', 'approval_id'])
     is distinct from (to_jsonb(old) - array['status', 'movement_ids', 'posted_at', 'approval_id']) then
    raise exception 'A wastage record can''t be edited. Only its approval decision and the stock movements it posted are added.' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (old.status = 'pending_approval' and new.status in ('approved', 'rejected')) then
    raise exception 'A wastage record that is % can''t become %.', old.status, new.status using errcode = '23514';
  end if;
  if new.movement_ids is distinct from old.movement_ids and old.movement_ids <> '{}' then
    raise exception 'The stock movements of a wastage record are written once.' using errcode = '23514';
  end if;
  if new.approval_id is distinct from old.approval_id and old.approval_id is not null then
    raise exception 'A wastage record keeps the approval it was sent with.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.wastage_guard() from public, anon, authenticated;
drop trigger if exists wastage_records_guard on public.wastage_records;
create trigger wastage_records_guard before update or delete on public.wastage_records for each row execute function private.wastage_guard();

create or replace function private.wastage_line_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'The lines of a wastage record can''t be edited.' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.wastage_records w where w.id = old.record_id) then
      raise exception 'The lines of a wastage record can''t be deleted.' using errcode = '23514';
    end if;
    return old;
  end if;
  if exists (select 1 from public.wastage_records w where w.id = new.record_id and (w.status <> 'recorded' and w.status <> 'pending_approval' or w.movement_ids <> '{}')) then
    raise exception 'Lines can only be added while the wastage record is being created.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.wastage_line_guard() from public, anon, authenticated;
drop trigger if exists wastage_record_lines_guard on public.wastage_record_lines;
create trigger wastage_record_lines_guard before insert or update or delete on public.wastage_record_lines for each row execute function private.wastage_line_guard();

-- Adjustment: pending_approval -> approved | rejected; approved -> posted. What was asked for never changes.
create or replace function private.adjustment_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'Stock adjustments are part of the stock history and can''t be deleted.' using errcode = '42501';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - array['status', 'movement_id', 'posted_at', 'approval_id'])
     is distinct from (to_jsonb(old) - array['status', 'movement_id', 'posted_at', 'approval_id']) then
    raise exception 'A stock adjustment can''t be edited. Only its approval decision and the movement it posted are added.' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'pending_approval' and new.status in ('approved', 'rejected')) or (old.status = 'approved' and new.status = 'posted')) then
    raise exception 'A stock adjustment that is % can''t become %.', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.adjustment_guard() from public, anon, authenticated;
drop trigger if exists stock_adjustments_guard on public.stock_adjustments;
create trigger stock_adjustments_guard before update or delete on public.stock_adjustments for each row execute function private.adjustment_guard();

-- ---------------------------------------------------------------------------
-- RLS: API-only (no policies, nothing granted to browser roles)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['stock_reason_codes', 'wastage_records', 'wastage_record_lines', 'stock_adjustments', 'allowance_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
