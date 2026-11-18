-- 015 (PROPOSED, NOT APPLIED): suppliers, what they supply, their price lists (history kept) and gap-free document numbers.
-- Requires 009 (stock_items, private.stock_append_only) and 012 (stock_items has unique (id, business_id)). Phase 2, ticket P2-03.
-- See docs/inventory-kb/09-phase2-workplan.md (P2-03, D2-10, D2-14) and 03-prd-digest.md (SUP-1..3).
--
-- * suppliers: one record per business; the name is unique per business ignoring case and spacing (D2-14). Phone is stored as
--   254XXXXXXXXX (Safaricom 07/01 numbers), KRA PIN is optional but must look like A123456789B when given. `type` is formal /
--   informal / one_off. An "on-the-spot" supplier a branch manager adds during an emergency buy has incomplete = true until the
--   owner completes it.
-- * supplier_items: which items a supplier sells (their code, the unit they sell in, ranking, one preferred supplier per item).
-- * supplier_prices: INSERT-ONLY price history. A price is KES per ONE unit of the item (a crate, a kg, a sack); price_per_base
--   (KES per base unit: g, ml, piece) is stored too so prices in different units compare. The price in force on a date is the row
--   with the greatest effective_from <= that date. Unique per (supplier, item, unit, effective_from).
-- * inventory_number_sequences: one counter row per (business, kind, year) behind numbers.js nextNumber() (PO-2026-0001 ...).
--   Incremented with an upsert inside the caller's transaction, so numbers are gap-free (a rolled-back document gives its number back).
--
-- SHARED DATABASE: ADDITIVE ONLY (four new tables, one trigger). Nothing existing is altered, so `main` keeps working.
-- RLS: enabled with NO policies and no grants to browser roles: the API (service role) is the only reader and writer, which keeps
-- bank and M-Pesa details away from everyone but the API's own owner-only check. Idempotent: every statement can be re-run.
-- Rollback: backend/db/proposed/015_suppliers.down.sql (refuses while any supplier or number counter exists).

create schema if not exists private;

do $$
begin
  if to_regclass('public.stock_items') is null or to_regclass('public.stock_item_units') is null then
    raise exception '015 needs migrations 009 and 012 first.';
  end if;
  if to_regclass('public.suppliers') is not null and not exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'suppliers' and column_name = 'incomplete') then
    raise exception 'A table public.suppliers already exists with a different shape; rename it or adapt 015 first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  type text not null default 'formal' check (type in ('formal', 'informal', 'one_off')),
  contact_name text check (char_length(contact_name) <= 80),
  phone text check (phone ~ '^254[17][0-9]{8}$'),
  email text check (char_length(email) <= 120 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  address text check (char_length(address) <= 200),
  kra_pin text check (kra_pin ~ '^[AP][0-9]{9}[A-Z]$'),
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 180),
  payment_method text not null default 'cash' check (payment_method in ('cash', 'mpesa', 'bank', 'credit')),
  mpesa_till text check (mpesa_till ~ '^[0-9]{5,7}$'),
  mpesa_paybill text check (mpesa_paybill ~ '^[0-9]{5,7}$'),
  mpesa_account text check (char_length(mpesa_account) <= 40),
  bank_details text check (char_length(bank_details) <= 300),
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  incomplete boolean not null default false,
  notes text check (char_length(notes) <= 500),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);
create unique index if not exists suppliers_name on public.suppliers (business_id, lower(btrim(name)));
create index if not exists suppliers_status_idx on public.suppliers (business_id, status);
create index if not exists suppliers_phone_idx on public.suppliers (business_id, phone) where phone is not null;

-- ---------------------------------------------------------------------------
-- What each supplier sells
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  supplier_id uuid not null,
  item_id uuid not null,
  supplier_code text check (char_length(supplier_code) <= 40),
  -- The unit this supplier sells in: a standard unit code (kg, l ...) or the name of one of the item's own units (crate). Null = the item's display unit.
  purchase_unit text check (char_length(purchase_unit) between 1 and 30),
  rank integer not null default 1 check (rank between 1 and 99),
  preferred boolean not null default false,
  lead_time_days integer check (lead_time_days between 0 and 365),
  min_order_base numeric(18, 4) check (min_order_base > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_id, item_id),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);
create index if not exists supplier_items_item_idx on public.supplier_items (item_id);
-- At most one preferred supplier per item.
create unique index if not exists supplier_items_one_preferred on public.supplier_items (business_id, item_id) where preferred;

-- ---------------------------------------------------------------------------
-- Price history (insert-only)
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_prices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  supplier_id uuid not null,
  item_id uuid not null,
  unit text not null check (char_length(unit) between 1 and 30),
  -- Base units in one `unit` when the price was entered (a snapshot: a crate resized later does not rewrite old prices).
  unit_factor numeric(24, 12) not null check (unit_factor > 0),
  price numeric(14, 2) not null check (price > 0),
  price_per_base numeric(18, 6) not null check (price_per_base >= 0),
  effective_from date not null,
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);
create unique index if not exists supplier_prices_unique on public.supplier_prices (supplier_id, item_id, unit, effective_from);
create index if not exists supplier_prices_lookup on public.supplier_prices (supplier_id, item_id, effective_from desc);
create index if not exists supplier_prices_item_idx on public.supplier_prices (business_id, item_id, effective_from desc);

-- History is kept: a price row can never be changed or removed (a correction is a new row with a later date).
-- Deleting a whole supplier or item still cascades, as for every other table; the guard only blocks direct UPDATE/DELETE
-- issued while the parent still exists.
create or replace function private.supplier_price_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (not exists (select 1 from public.suppliers s where s.id = old.supplier_id)
                           or not exists (select 1 from public.stock_items i where i.id = old.item_id)) then
    return old;  -- cascade from a deleted supplier or item
  end if;
  raise exception 'Supplier prices are history and can''t be changed. Add a new price with a later date instead.' using errcode = '42501';
end;
$$;
revoke all on function private.supplier_price_guard() from public, anon, authenticated;
drop trigger if exists supplier_prices_no_change on public.supplier_prices;
create trigger supplier_prices_no_change before update or delete on public.supplier_prices
  for each row execute function private.supplier_price_guard();

-- ---------------------------------------------------------------------------
-- Gap-free document numbers: PO-2026-0001, GRN-2026-0001 ... one counter row per (business, kind, year)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_number_sequences (
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind ~ '^[A-Z]{2,6}$'),
  year integer not null check (year between 2000 and 2999),
  last_number integer not null default 0 check (last_number >= 0),
  updated_at timestamptz not null default now(),
  primary key (business_id, kind, year)
);

-- ---------------------------------------------------------------------------
-- RLS: API-only (no policies, nothing granted to browser roles)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['suppliers', 'supplier_items', 'supplier_prices', 'inventory_number_sequences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
