-- 012 (PROPOSED, NOT APPLIED): inventory catalogue, units, locations and the richer stock ledger. Requires 008 and 009.
-- Rewrite of the earlier 012 draft after the product owner's answers of 18 Nov 2026 (docs/v2/DECISIONS.md INV-A3/A4/A5/A8).
-- See docs/inventory-kb/07-implementation-plan.md (WP1.1) and 08-phase1-workplan.md (P1-05).
--
-- Rules implemented here:
-- * ONE warehouse per business: it is the existing 009 'center' location (the UI labels it "Warehouse"). The kind check also
--   allows 'warehouse' so more can be added later; the one-center unique index is kept.
-- * Quantities are STORED in one base unit per item. The existing stock_items.unit column IS that base unit; its check is
--   widened from ('serving') to ('serving','piece','g','ml'). People choose the units they type and read: stock_items.display_unit
--   (a units.code, or the name of one of the item's own units) and the item's own units (stock_item_units: crate, sack, tray...).
-- * The ledger (stock_movements) gains cost, value, reference, idempotency and entered-quantity columns and a wider set of reasons.
--   It stays append-only. Quantities have 4 decimal places (numeric(18,4)).
-- * An item's base unit cannot change once any movement exists; an archived item takes no new stock except corrections
--   and what keeps service and in-flight transfers working (see private.stock_movement_guard).
--
-- SHARED DATABASE: `main`'s code (src/stock/service.js, routes/stock.js) and the 009 triggers keep running against the same
-- database. So this migration is ADDITIVE ONLY: no column is renamed or dropped, checks are widened to supersets, every new
-- column is nullable or defaulted, 009 function signatures are untouched, and nothing named menu_item_recipes is created
-- (main treats that table as "the old 012 is applied"). Existing rows are not changed in meaning; low_level stays the
-- organisation-wide low-stock level (per-location levels live in stock_item_levels and are empty until set).
--
-- Costs: stock_items.avg_cost / last_cost are not readable by browser clients (column-level grant below); the API decides who sees cost.
-- All writes go through the API (service role) or triggers. Idempotent: every statement can be re-run.
--
-- Rollback: backend/db/proposed/012_inventory_catalogue.down.sql (refuses while any data that only exists after 012 is present).
-- Lock note: widening numerics rewrites stock_balances, stock_movements and the line tables; they are small, but run in a quiet window.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Guard: ALTER COLUMN TYPE fails (or silently breaks) when a view or materialized view reads these columns.
-- 009 has none; refuse early with a clear message if someone added one since.
-- ---------------------------------------------------------------------------
do $$
declare dependents text;
begin
  select string_agg(distinct c.relname, ', ') into dependents
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid and d.classid = 'pg_rewrite'::regclass
    join pg_class c on c.oid = r.ev_class and c.relkind in ('v', 'm')
    join pg_class t on t.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname in ('stock_balances', 'stock_movements', 'order_stock_effects', 'stock_request_lines', 'stock_transfer_lines', 'stock_items')
     and c.oid <> t.oid;
  if dependents is not null then
    raise exception '012 cannot widen stock quantities: these views depend on stock tables: %. Drop and recreate them around this migration.', dependents;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Units (configuration data) and categories
-- ---------------------------------------------------------------------------
create table if not exists public.units (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{0,15}$'),
  dimension text not null check (dimension in ('weight', 'volume', 'count', 'serving')),
  -- How many of the dimension's base unit (g, ml, piece, serving) one of this unit holds.
  to_base numeric(24, 12) not null check (to_base > 0),
  label text not null check (char_length(btrim(label)) between 1 and 20),
  plural text not null check (char_length(btrim(plural)) between 1 and 20),
  position integer not null default 0,
  active boolean not null default true
);

-- Same rows as DEFAULT_UNITS in backend/src/inventory/units.js (a test keeps the two equal).
insert into public.units (code, dimension, to_base, label, plural, position) values
  ('mg',      'weight',  0.001, 'mg',      'mg',      10),
  ('g',       'weight',  1,     'g',       'g',       20),
  ('kg',      'weight',  1000,  'kg',      'kg',      30),
  ('ml',      'volume',  1,     'ml',      'ml',      40),
  ('l',       'volume',  1000,  'L',       'L',       50),
  ('tsp',     'volume',  5,     'tsp',     'tsp',     60),
  ('tbsp',    'volume',  15,    'tbsp',    'tbsp',    70),
  ('cup',     'volume',  240,   'cup',     'cups',    80),
  ('piece',   'count',   1,     'piece',   'pieces',  90),
  ('serving', 'serving', 1,     'serving', 'servings', 100)
on conflict (code) do nothing;

create table if not exists public.stock_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  parent_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  -- Same business as the parent. Categories are archived (active = false), not deleted, while items use them.
  foreign key (parent_id, business_id) references public.stock_categories (id, business_id)
);
create unique index if not exists stock_categories_name
  on public.stock_categories (business_id, lower(btrim(name)), coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists stock_categories_business_idx on public.stock_categories (business_id, position);

-- ---------------------------------------------------------------------------
-- stock_items: catalogue columns, and the base-unit check widened
-- ---------------------------------------------------------------------------
alter table public.stock_items
  add column if not exists sku text check (sku is null or char_length(btrim(sku)) between 1 and 40),
  add column if not exists category_id uuid,
  add column if not exists kind text not null default 'raw' check (kind in ('raw', 'prepared', 'resale', 'packaging', 'consumable')),
  add column if not exists storage text check (storage in ('ambient', 'chilled', 'frozen', 'dry')),
  add column if not exists yield_pct numeric(5, 2) not null default 100 check (yield_pct > 0 and yield_pct <= 100),
  -- A units.code, or the name of one of this item's own units (stock_item_units). Null = show in the base unit.
  add column if not exists display_unit text check (display_unit is null or char_length(btrim(display_unit)) between 1 and 30),
  add column if not exists avg_cost numeric(18, 6) check (avg_cost >= 0),
  add column if not exists last_cost numeric(18, 6),
  add column if not exists vat_class text not null default 'standard' check (vat_class in ('standard', 'zero', 'exempt')),
  add column if not exists notes text check (char_length(notes) <= 280),
  add column if not exists archived_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_items_category_fk' and conrelid = 'public.stock_items'::regclass) then
    alter table public.stock_items add constraint stock_items_category_fk
      foreign key (category_id, business_id) references public.stock_categories (id, business_id);
  end if;
end;
$$;
create unique index if not exists stock_items_sku on public.stock_items (business_id, lower(btrim(sku))) where sku is not null;
create index if not exists stock_items_category_idx on public.stock_items (category_id) where category_id is not null;

-- 'unit' is the base unit: widen the 009 check (serving) to a superset.
alter table public.stock_items drop constraint if exists stock_items_unit_check;
alter table public.stock_items add constraint stock_items_unit_check check (unit in ('serving', 'piece', 'g', 'ml'));

-- The item's own units: 1 crate = 10000 g. factor is in BASE units.
create table if not exists public.stock_item_units (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.stock_items(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  factor numeric(18, 4) not null check (factor > 0),
  for_purchase boolean not null default true,
  for_recipe boolean not null default false,
  for_count boolean not null default true,
  position integer not null default 0
);
create unique index if not exists stock_item_units_name on public.stock_item_units (item_id, lower(btrim(name)));

create table if not exists public.stock_item_barcodes (
  item_id uuid not null,
  business_id uuid not null references public.businesses(id) on delete cascade,
  code text not null check (char_length(btrim(code)) between 1 and 64),
  created_at timestamptz not null default now(),
  primary key (item_id, code),
  unique (business_id, code),
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);

-- Low-stock and reorder levels per location. stock_items.low_level stays the organisation-wide default
-- (this table starts empty; a level here overrides it at that location).
create table if not exists public.stock_item_levels (
  location_id uuid not null,
  item_id uuid not null,
  business_id uuid not null references public.businesses(id) on delete cascade,
  min numeric(18, 4) check (min >= 0),
  reorder numeric(18, 4) check (reorder >= 0),
  par numeric(18, 4) check (par >= 0),
  max numeric(18, 4) check (max >= 0),
  updated_at timestamptz not null default now(),
  primary key (location_id, item_id),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Locations: 'warehouse' allowed for later, code, status
-- ---------------------------------------------------------------------------
alter table public.stock_locations drop constraint if exists stock_locations_kind_check;
alter table public.stock_locations add constraint stock_locations_kind_check check (kind in ('center', 'branch', 'warehouse'));
alter table public.stock_locations
  add column if not exists code text check (code is null or char_length(btrim(code)) between 1 and 20),
  add column if not exists status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  add column if not exists archived_at timestamptz;
create unique index if not exists stock_locations_code on public.stock_locations (business_id, lower(btrim(code))) where code is not null;
-- 009's check ((kind = 'branch') = (restaurant_id is not null)) already keeps warehouses free of a branch.

-- ---------------------------------------------------------------------------
-- Widen quantities to numeric(18,4); reserved stock (unused until Phase 2)
-- ---------------------------------------------------------------------------
alter table public.stock_items alter column low_level type numeric(18, 4);
alter table public.stock_balances alter column on_hand type numeric(18, 4);
alter table public.stock_movements alter column delta type numeric(18, 4), alter column balance_after type numeric(18, 4);
alter table public.order_stock_effects alter column quantity type numeric(18, 4);
alter table public.stock_request_lines alter column requested type numeric(18, 4), alter column approved type numeric(18, 4);
alter table public.stock_transfer_lines alter column quantity type numeric(18, 4), alter column received type numeric(18, 4);
alter table public.stock_balances add column if not exists reserved numeric(18, 4) not null default 0 check (reserved >= 0);

-- ---------------------------------------------------------------------------
-- Ledger additions
-- ---------------------------------------------------------------------------
alter table public.stock_movements
  add column if not exists unit_cost numeric(18, 6),
  add column if not exists value numeric(14, 2),
  add column if not exists ref_type text check (char_length(ref_type) <= 40),
  add column if not exists ref_id uuid,
  add column if not exists counterparty_location_id uuid references public.stock_locations(id),
  add column if not exists batch_id uuid,
  add column if not exists idempotency_key text check (char_length(idempotency_key) <= 120),
  add column if not exists entered_quantity numeric(18, 4),
  add column if not exists entered_unit text check (char_length(entered_unit) <= 30),
  -- Set only on a 'reversal': the movement it undoes. The unique index below means a movement can be reversed once.
  add column if not exists reverses_movement_id bigint references public.stock_movements(id);

-- occurred_at: when it happened (back-dated counts). Existing rows take their created_at, not the migration time.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stock_movements' and column_name = 'occurred_at') then
    alter table public.stock_movements add column occurred_at timestamptz;
    alter table public.stock_movements disable trigger stock_movements_no_change;
    update public.stock_movements set occurred_at = created_at;
    alter table public.stock_movements enable trigger stock_movements_no_change;
    alter table public.stock_movements alter column occurred_at set default now(), alter column occurred_at set not null;
  end if;
end;
$$;

-- Reasons: every 009 reason plus the new ones (a superset, so 009 code keeps working).
alter table public.stock_movements drop constraint if exists stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check check (reason in (
  'count', 'added', 'waste', 'served', 'order_correction', 'dispatched', 'received', 'lost_in_transit', 'dispatch_cancelled',
  'opening', 'purchase_receipt', 'emergency_receipt', 'supplier_return', 'transfer_dispatch', 'transfer_receipt',
  'transfer_discrepancy', 'transfer_cancelled', 'pos_consumption', 'production_input', 'production_output', 'wastage',
  'adjustment_gain', 'adjustment_loss', 'count_correction', 'staff_meal', 'complimentary', 'reversal'));
create unique index if not exists stock_movements_idempotency on public.stock_movements (idempotency_key, reason) where idempotency_key is not null;
create unique index if not exists stock_movements_reversed_once on public.stock_movements (reverses_movement_id) where reverses_movement_id is not null;
create index if not exists stock_movements_ref_idx on public.stock_movements (ref_type, ref_id) where ref_id is not null;
create index if not exists stock_movements_occurred_idx on public.stock_movements (location_id, occurred_at desc);
-- The 009 append-only trigger (stock_movements_no_change) is untouched.

-- ---------------------------------------------------------------------------
-- Settings, audit trail, stock exceptions, switch
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_settings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid,
  key text not null check (char_length(btrim(key)) between 1 and 60),
  value jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id) on delete cascade
);
-- One value per business and key (location_id null = the business default) or per location and key.
create unique index if not exists inventory_settings_key
  on public.inventory_settings (business_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- Audit trail. No foreign keys on purpose: history must outlive the people and places it mentions, and the append-only
-- trigger would block the cascade/set-null updates a foreign key needs.
create table if not exists public.inventory_events (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  location_id uuid,
  actor_id uuid,
  actor_role text check (char_length(actor_role) <= 40),
  entity text not null check (char_length(entity) <= 60),
  entity_id uuid,
  action text not null check (char_length(action) <= 60),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists inventory_events_business_idx on public.inventory_events (business_id, created_at desc);
create index if not exists inventory_events_entity_idx on public.inventory_events (entity, entity_id);
drop trigger if exists inventory_events_no_change on public.inventory_events;
create trigger inventory_events_no_change before update or delete on public.inventory_events
  for each row execute function private.stock_append_only();

-- Shortfalls when a dish was served with less stock than it needed (written by 013).
create table if not exists public.stock_exceptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,
  item_id uuid not null,
  order_id uuid references public.orders(id) on delete set null,
  order_item_id uuid references public.order_items(id) on delete set null,
  kind text not null default 'unfulfilled_consumption' check (char_length(kind) <= 40),
  short_qty numeric(18, 4) not null check (short_qty > 0),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  note text check (char_length(note) <= 280),
  created_at timestamptz not null default now(),
  check (status <> 'resolved' or resolved_at is not null),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);
create index if not exists stock_exceptions_open_idx on public.stock_exceptions (business_id, location_id, created_at desc) where status = 'open';

-- Off until the owner turns inventory on; main ignores the column.
alter table public.businesses add column if not exists inventory_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- (a) The base unit cannot change once any movement exists: quantities already stored are in that unit.
create or replace function private.stock_item_unit_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.unit is distinct from old.unit and exists (select 1 from public.stock_movements where item_id = old.id) then
    raise exception 'The unit of % can’t change because it already has stock history. Add a new item instead.', old.name
      using errcode = '23514', hint = 'stock_unit_locked';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists stock_items_unit_guard on public.stock_items;
create trigger stock_items_unit_guard before update on public.stock_items
  for each row execute function private.stock_item_unit_guard();

-- (b) An archived item takes no NEW stock movements, except:
--   * corrections and write-offs: count, count_correction, reversal, adjustment_loss, wastage (and 009's 'waste');
--   * service: served, pos_consumption, order_correction. A dish may still be linked to an item someone archived; refusing
--     here would make serving that order fail, so service always wins and the shortfall shows up in the counts;
--   * in-flight transfers finishing: dispatch_cancelled, received, lost_in_transit, transfer_receipt, transfer_discrepancy,
--     transfer_cancelled (a dispatch made before archiving must still be able to land or return).
-- Everything that adds stock (opening, purchase_receipt, added, adjustment_gain, production_output...) or sends it out
-- (dispatched, transfer_dispatch, supplier_return, production_input, staff_meal, complimentary) is refused.
create or replace function private.stock_movement_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.stock_items where id = new.item_id and archived_at is not null)
     and new.reason not in ('count', 'count_correction', 'reversal', 'adjustment_loss', 'wastage', 'waste',
       'served', 'pos_consumption', 'order_correction',
       'dispatch_cancelled', 'received', 'lost_in_transit', 'transfer_receipt', 'transfer_discrepancy', 'transfer_cancelled') then
    raise exception 'This item is archived, so stock can’t be recorded for it (%). Restore it first.', new.reason
      using errcode = '23514', hint = 'stock_item_archived';
  end if;
  return new;
end;
$$;
drop trigger if exists stock_movements_guard on public.stock_movements;
create trigger stock_movements_guard before insert on public.stock_movements
  for each row execute function private.stock_movement_guard();

revoke all on function private.stock_item_unit_guard(), private.stock_movement_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS: reads only, like 009. Writes go through the API (service role).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['units', 'stock_categories', 'stock_item_units', 'stock_item_barcodes', 'stock_item_levels',
    'inventory_settings', 'inventory_events', 'stock_exceptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- Units: reference data, readable by any signed-in user.
grant select on public.units to authenticated;
drop policy if exists units_read on public.units;
create policy units_read on public.units for select to authenticated using (true);

-- Catalogue reads follow stock_items: members of the business, or of any of its branches.
grant select on public.stock_categories, public.stock_item_units, public.stock_item_barcodes to authenticated;
drop policy if exists stock_categories_read on public.stock_categories;
create policy stock_categories_read on public.stock_categories for select to authenticated
  using ((select private.business_role(business_id)) is not null
    or exists (select 1 from public.restaurants r where r.business_id = stock_categories.business_id and private.is_restaurant_member(r.id)));
drop policy if exists stock_item_barcodes_read on public.stock_item_barcodes;
create policy stock_item_barcodes_read on public.stock_item_barcodes for select to authenticated
  using ((select private.business_role(business_id)) is not null
    or exists (select 1 from public.restaurants r where r.business_id = stock_item_barcodes.business_id and private.is_restaurant_member(r.id)));
drop policy if exists stock_item_units_read on public.stock_item_units;
create policy stock_item_units_read on public.stock_item_units for select to authenticated
  using (exists (select 1 from public.stock_items i where i.id = stock_item_units.item_id));

-- stock_items: 009 granted table-wide select. Keep every 009 column and the new catalogue columns readable, but NOT the
-- cost columns (avg_cost, last_cost): browser clients never see costs; the API shows them to roles allowed to.
revoke select on public.stock_items from authenticated;
grant select (id, business_id, name, unit, low_level, active, created_by, created_at, sku, category_id, kind, storage,
  yield_pct, display_unit, vat_class, notes, archived_at, updated_at) on public.stock_items to authenticated;

notify pgrst, 'reload schema';
