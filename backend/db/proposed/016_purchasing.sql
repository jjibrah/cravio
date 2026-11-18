-- 016 (PROPOSED, NOT APPLIED): purchasing. Purchase orders, goods receipts (GRN), supplier invoices, supplier returns and evidence attachments.
-- Requires 009 (stock_locations, stock_movements, private schema), 012 (stock_items unique (id, business_id)) and 015 (suppliers, document numbers).
-- Phase 2, ticket P2-05. See docs/inventory-kb/09-phase2-workplan.md (P2-05/06, D2-8, D2-10) and 03-prd-digest.md (PRC-2, GRN-1..3, GRN-6, PRC-6, EMP-3).
--
-- * purchase_orders / po_lines: number PO-2026-0001 from numbers.js (unique per business). Quantities are kept as ENTERED (qty + unit +
--   the unit's factor at that moment) AND in base units, so a crate resized later never rewrites an old order. received_base is the running
--   total of what goods receipts brought in; a hard cap (150 % of ordered) is the last safety net, the service applies the owner's tolerance.
--   Status path (enforced by a trigger, the service decides who may take a step):
--     draft -> pending_approval | approved | cancelled;  pending_approval -> approved | draft | cancelled;
--     approved -> sent | partially_received | received | closed | cancelled;  sent -> partially_received | received | closed | cancelled;
--     partially_received -> received | closed;  received -> closed;  closed and cancelled are final.
--   Cancel is refused once any line has received stock. Lines can only be added, changed or removed while the order is a draft (only
--   received_base moves afterwards). A PO is created as a draft; only drafts can be deleted.
-- * goods_receipts / grn_lines: number GRN-.... A receipt without a PO is "unplanned" and must say why. Lines keep the entered and base
--   quantity accepted, what was rejected and why, the cost per BASE unit (numeric(18,6)), batch and expiry (stored now, used in Phase 3) and
--   the ledger movement the posting created. Lines change only while the receipt is a draft; draft -> posted -> reversed.
-- * supplier_invoices: the supplier's invoice as typed in (number, date, KRA PIN, eTIMS invoice number as free text, amount, VAT), whether it
--   is an eTIMS invoice, another invoice, or none (then a reason is required), plus payment status stored for later. goods_receipts.invoice_id
--   links a receipt to its invoice (one invoice may cover several receipts); the invoice also names a PO when there is one.
-- * supplier_returns / lines: goods sent back against a receipt line, with a credit amount and the ledger movement that took the stock out.
-- * attachments: evidence files (photos, PDFs) kept in the private storage bucket 'inventory-evidence'; this table is the index. Rows are
--   never changed or deleted by the API, only soft-deleted (deleted_at). location_id is who may view it (null = owner only).
--
-- SHARED DATABASE: ADDITIVE ONLY (eight new tables, a few functions and triggers). Nothing existing is altered, so `main` keeps working.
-- RLS: enabled with NO policies and no grants to browser roles: the API (service role) is the only reader and writer.
-- Idempotent: every statement can be re-run. Rollback: 016_purchasing.down.sql (refuses while any document or attachment exists).

create schema if not exists private;

do $$
begin
  if to_regclass('public.suppliers') is null or to_regclass('public.inventory_number_sequences') is null then
    raise exception '016 needs migration 015 (suppliers) first.';
  end if;
  if to_regclass('public.stock_item_units') is null then
    raise exception '016 needs migration 012 first.';
  end if;
  if to_regclass('public.purchase_orders') is not null and not exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'purchase_orders' and column_name = 'deliver_to_location_id') then
    raise exception 'A table public.purchase_orders already exists with a different shape; rename it or adapt 016 first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  number text not null check (number ~ '^PO-[0-9]{4}-[0-9]{4,}$'),
  supplier_id uuid not null,
  deliver_to_location_id uuid not null,
  expected_date date,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled')),
  subtotal numeric(14, 2) not null default 0 check (subtotal >= 0),
  vat_total numeric(14, 2) not null default 0 check (vat_total >= 0),
  total numeric(14, 2) not null default 0 check (total >= 0),
  notes text check (char_length(notes) <= 500),
  self_approved boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,
  sent_via text check (sent_via in ('pdf', 'whatsapp', 'email', 'phone')),
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text check (char_length(cancel_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  unique (business_id, number),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id),
  foreign key (deliver_to_location_id, business_id) references public.stock_locations (id, business_id),
  check (status not in ('approved', 'sent', 'partially_received', 'received', 'closed') or approved_at is not null),
  check (status <> 'cancelled' or (cancelled_at is not null and char_length(btrim(coalesce(cancel_reason, ''))) > 0)),
  check (status not in ('sent', 'partially_received', 'received') or sent_at is not null or approved_at is not null)
);
create index if not exists purchase_orders_status_idx on public.purchase_orders (business_id, status, created_at desc);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders (supplier_id, created_at desc);
create index if not exists purchase_orders_location_idx on public.purchase_orders (deliver_to_location_id, status);

create table if not exists public.po_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  po_id uuid not null,
  position integer not null default 0 check (position >= 0),
  item_id uuid not null,
  -- As entered: 3 crates at KES 6,500 a crate. unit_factor = base units in one entered unit at that moment (a snapshot).
  entered_qty numeric(18, 4) not null check (entered_qty > 0),
  entered_unit text not null check (char_length(entered_unit) between 1 and 30),
  unit_factor numeric(24, 12) not null check (unit_factor > 0),
  qty_base numeric(18, 4) not null check (qty_base > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  price_per_base numeric(18, 6) not null default 0 check (price_per_base >= 0),
  vat_amount numeric(14, 2) not null default 0 check (vat_amount >= 0),
  line_total numeric(14, 2) not null check (line_total >= 0),
  received_base numeric(18, 4) not null default 0 check (received_base >= 0),
  created_at timestamptz not null default now(),
  unique (id, business_id),
  unique (po_id, position),
  foreign key (po_id, business_id) references public.purchase_orders (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id),
  -- Safety net: never more than 150 % of what was ordered (the owner's own tolerance is applied by the service).
  check (received_base <= qty_base * 1.5)
);
create index if not exists po_lines_item_idx on public.po_lines (business_id, item_id);

-- ---------------------------------------------------------------------------
-- Supplier invoices (created before receipts: a receipt points at its invoice)
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  supplier_id uuid not null,
  po_id uuid,
  invoice_no text check (char_length(btrim(invoice_no)) between 1 and 60),
  invoice_date date,
  supplier_pin text check (supplier_pin ~ '^[AP][0-9]{9}[A-Z]$'),
  etims_invoice_no text check (char_length(etims_invoice_no) <= 60),
  invoice_status text not null default 'other' check (invoice_status in ('etims', 'other', 'none')),
  no_invoice_reason text check (char_length(no_invoice_reason) <= 300),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  vat numeric(14, 2) not null default 0 check (vat >= 0),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'part_paid', 'paid')),
  paid_amount numeric(14, 2) not null default 0 check (paid_amount >= 0),
  due_date date,
  notes text check (char_length(notes) <= 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id),
  foreign key (po_id, business_id) references public.purchase_orders (id, business_id),
  check (vat <= amount),
  check (paid_amount <= amount),
  check (payment_status <> 'unpaid' or paid_amount = 0),
  check (payment_status <> 'paid' or paid_amount = amount),
  check (payment_status <> 'part_paid' or (paid_amount > 0 and paid_amount < amount)),
  check (invoice_status = 'none' or (invoice_no is not null and invoice_date is not null)),
  check (invoice_status <> 'none' or char_length(btrim(coalesce(no_invoice_reason, ''))) > 0),
  check (invoice_status <> 'etims' or char_length(btrim(coalesce(etims_invoice_no, ''))) > 0)
);
-- The same invoice number from the same supplier is entered once.
create unique index if not exists supplier_invoices_number on public.supplier_invoices (supplier_id, lower(btrim(invoice_no))) where invoice_no is not null;
create index if not exists supplier_invoices_supplier_idx on public.supplier_invoices (business_id, supplier_id, invoice_date desc);
create index if not exists supplier_invoices_unpaid_idx on public.supplier_invoices (business_id, due_date) where payment_status <> 'paid';

-- ---------------------------------------------------------------------------
-- Goods receipts
-- ---------------------------------------------------------------------------
create table if not exists public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  number text not null check (number ~ '^GRN-[0-9]{4}-[0-9]{4,}$'),
  location_id uuid not null,
  supplier_id uuid not null,
  po_id uuid,
  unplanned_reason text check (char_length(unplanned_reason) <= 300),
  received_at timestamptz not null default now(),
  received_by uuid references auth.users(id) on delete set null,
  delivery_note_no text check (char_length(delivery_note_no) <= 60),
  status text not null default 'draft' check (status in ('draft', 'posted', 'reversed')),
  invoice_id uuid,
  notes text check (char_length(notes) <= 500),
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  unique (business_id, number),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id),
  foreign key (po_id, business_id) references public.purchase_orders (id, business_id),
  foreign key (invoice_id, business_id) references public.supplier_invoices (id, business_id),
  check (po_id is not null or char_length(btrim(coalesce(unplanned_reason, ''))) > 0),
  check (status = 'draft' or posted_at is not null)
);
create index if not exists goods_receipts_po_idx on public.goods_receipts (po_id) where po_id is not null;
create index if not exists goods_receipts_location_idx on public.goods_receipts (business_id, location_id, received_at desc);
create index if not exists goods_receipts_supplier_idx on public.goods_receipts (business_id, supplier_id, received_at desc);
create index if not exists goods_receipts_invoice_idx on public.goods_receipts (invoice_id) where invoice_id is not null;

create table if not exists public.grn_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  grn_id uuid not null,
  position integer not null default 0 check (position >= 0),
  po_line_id uuid,
  item_id uuid not null,
  entered_qty numeric(18, 4) not null check (entered_qty >= 0),
  entered_unit text not null check (char_length(entered_unit) between 1 and 30),
  unit_factor numeric(24, 12) not null check (unit_factor > 0),
  qty_ordered_base numeric(18, 4) check (qty_ordered_base >= 0),
  qty_received_base numeric(18, 4) not null check (qty_received_base >= 0),
  qty_rejected_base numeric(18, 4) not null default 0 check (qty_rejected_base >= 0),
  reject_reason text check (char_length(reject_reason) <= 300),
  unit_cost numeric(18, 6) not null default 0 check (unit_cost >= 0),
  batch_no text check (char_length(batch_no) <= 60),
  expiry_date date,
  movement_id bigint references public.stock_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  unique (grn_id, position),
  foreign key (grn_id, business_id) references public.goods_receipts (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id),
  foreign key (po_line_id, business_id) references public.po_lines (id, business_id),
  check (qty_received_base > 0 or qty_rejected_base > 0),
  check (qty_rejected_base = 0 or char_length(btrim(coalesce(reject_reason, ''))) > 0)
);
create index if not exists grn_lines_po_line_idx on public.grn_lines (po_line_id) where po_line_id is not null;
create index if not exists grn_lines_item_idx on public.grn_lines (business_id, item_id);
create index if not exists grn_lines_expiry_idx on public.grn_lines (business_id, expiry_date) where expiry_date is not null;

-- ---------------------------------------------------------------------------
-- Supplier returns
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_returns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  number text not null check (number ~ '^RET-[0-9]{4}-[0-9]{4,}$'),
  supplier_id uuid not null,
  location_id uuid not null,
  grn_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'posted')),
  reason text check (char_length(reason) <= 300),
  credit_total numeric(14, 2) not null default 0 check (credit_total >= 0),
  notes text check (char_length(notes) <= 500),
  created_by uuid references auth.users(id) on delete set null,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  unique (business_id, number),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (grn_id, business_id) references public.goods_receipts (id, business_id),
  check (status = 'draft' or posted_at is not null)
);
create index if not exists supplier_returns_grn_idx on public.supplier_returns (grn_id);
create index if not exists supplier_returns_supplier_idx on public.supplier_returns (business_id, supplier_id, created_at desc);

create table if not exists public.supplier_return_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  return_id uuid not null,
  grn_line_id uuid not null,
  item_id uuid not null,
  qty_base numeric(18, 4) not null check (qty_base > 0),
  reason text not null check (char_length(btrim(reason)) between 1 and 300),
  credit_amount numeric(14, 2) not null default 0 check (credit_amount >= 0),
  movement_id bigint references public.stock_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (return_id, grn_line_id),
  foreign key (return_id, business_id) references public.supplier_returns (id, business_id) on delete cascade,
  foreign key (grn_line_id, business_id) references public.grn_lines (id, business_id),
  foreign key (item_id, business_id) references public.stock_items (id, business_id)
);

-- ---------------------------------------------------------------------------
-- Attachments (index of files in the private bucket 'inventory-evidence')
-- ---------------------------------------------------------------------------
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  entity_type text not null check (entity_type in ('po', 'grn', 'invoice', 'return', 'emergency', 'transfer', 'discrepancy')),
  entity_id uuid not null,
  -- Who may view it: people who can view this stock location. Null = owner only (e.g. an invoice not tied to a receipt).
  location_id uuid,
  storage_bucket text not null default 'inventory-evidence' check (storage_bucket = 'inventory-evidence'),
  storage_path text not null check (char_length(storage_path) <= 300),
  original_name text check (char_length(original_name) <= 200),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  unique (id, business_id),
  unique (storage_bucket, storage_path),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  constraint attachments_path_in_business check (storage_path like business_id::text || '/%')
);
create index if not exists attachments_entity_idx on public.attachments (business_id, entity_type, entity_id) where deleted_at is null;
create index if not exists attachments_hash_idx on public.attachments (business_id, sha256);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
-- Purchase order: created as a draft, allowed status steps only, final states are final, no edits (apart from notes and the sent
-- details) once it leaves draft, cancel refused after stock was received, delete only for a draft (or when the whole business goes).
create or replace function private.po_guard()
returns trigger language plpgsql set search_path = '' as $$
declare allowed text[];
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'A purchase order starts as a draft.' using errcode = '23514'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'Only a draft purchase order can be deleted. Cancel it instead.' using errcode = '23514';
    end if;
    return old;
  end if;
  new.updated_at := now();
  if new.status <> old.status then
    allowed := case old.status
      when 'draft' then array['pending_approval', 'approved', 'cancelled']
      when 'pending_approval' then array['approved', 'draft', 'cancelled']
      when 'approved' then array['sent', 'partially_received', 'received', 'closed', 'cancelled']
      when 'sent' then array['partially_received', 'received', 'closed', 'cancelled']
      when 'partially_received' then array['received', 'closed']
      when 'received' then array['closed']
      else array[]::text[] end;
    if not (new.status = any (allowed)) then
      raise exception 'A purchase order can''t go from % to %.', old.status, new.status using errcode = '23514';
    end if;
    if new.status = 'cancelled' and exists (select 1 from public.po_lines l where l.po_id = old.id and l.received_base > 0) then
      raise exception 'This order has received stock, so it can''t be cancelled. Close it instead.' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.status in ('closed', 'cancelled') then
    raise exception 'A % purchase order can''t be changed.', old.status using errcode = '23514';
  end if;
  if old.status <> 'draft' and
     (to_jsonb(new) - array['notes', 'updated_at', 'sent_at', 'sent_via']) is distinct from (to_jsonb(old) - array['notes', 'updated_at', 'sent_at', 'sent_via']) then
    raise exception 'A purchase order can''t be edited once it is submitted. Cancel it and start a new one.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.po_guard() from public, anon, authenticated;
drop trigger if exists purchase_orders_guard on public.purchase_orders;
create trigger purchase_orders_guard before insert or update or delete on public.purchase_orders for each row execute function private.po_guard();

-- PO lines: add, change or remove only while the order is a draft; afterwards only received_base moves (and not on a cancelled order).
create or replace function private.po_line_guard()
returns trigger language plpgsql set search_path = '' as $$
declare po_status text;
begin
  if tg_op = 'DELETE' then
    select status into po_status from public.purchase_orders where id = old.po_id;
    if po_status is not null and po_status <> 'draft' then raise exception 'Lines can only be removed while the order is a draft.' using errcode = '23514'; end if;
    return old;
  end if;
  select status into po_status from public.purchase_orders where id = new.po_id;
  if tg_op = 'INSERT' then
    if po_status <> 'draft' then raise exception 'Lines can only be added while the order is a draft.' using errcode = '23514'; end if;
    return new;
  end if;
  if po_status <> 'draft' and (to_jsonb(new) - 'received_base') is distinct from (to_jsonb(old) - 'received_base') then
    raise exception 'Lines can only be changed while the order is a draft.' using errcode = '23514';
  end if;
  if new.received_base <> old.received_base and po_status in ('draft', 'pending_approval', 'cancelled', 'closed') then
    raise exception 'Stock can''t be received against a % order.', po_status using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.po_line_guard() from public, anon, authenticated;
drop trigger if exists po_lines_guard on public.po_lines;
create trigger po_lines_guard before insert or update or delete on public.po_lines for each row execute function private.po_line_guard();

-- Goods receipt: draft -> posted -> reversed. Once posted only the invoice link and notes can change; reversed is final.
create or replace function private.grn_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'A goods receipt starts as a draft.' using errcode = '23514'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'A posted goods receipt can''t be deleted. Reverse it instead.' using errcode = '23514';
    end if;
    return old;
  end if;
  if new.status <> old.status and not ((old.status = 'draft' and new.status = 'posted') or (old.status = 'posted' and new.status = 'reversed')) then
    raise exception 'A goods receipt can''t go from % to %.', old.status, new.status using errcode = '23514';
  end if;
  if old.status = 'reversed' then raise exception 'A reversed goods receipt can''t be changed.' using errcode = '23514'; end if;
  if old.status = 'posted' and new.status = 'posted' and
     (to_jsonb(new) - array['invoice_id', 'notes']) is distinct from (to_jsonb(old) - array['invoice_id', 'notes']) then
    raise exception 'A posted goods receipt can''t be edited. Reverse it and enter it again.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.grn_guard() from public, anon, authenticated;
drop trigger if exists goods_receipts_guard on public.goods_receipts;
create trigger goods_receipts_guard before insert or update or delete on public.goods_receipts for each row execute function private.grn_guard();

-- Receipt lines: change only while the receipt is a draft.
create or replace function private.grn_line_guard()
returns trigger language plpgsql set search_path = '' as $$
declare grn_status text; gid uuid := case when tg_op = 'DELETE' then old.grn_id else new.grn_id end;
begin
  select status into grn_status from public.goods_receipts where id = gid;
  if grn_status is not null and grn_status <> 'draft' then
    raise exception 'The lines of a posted goods receipt can''t be changed.' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function private.grn_line_guard() from public, anon, authenticated;
drop trigger if exists grn_lines_guard on public.grn_lines;
create trigger grn_lines_guard before insert or update or delete on public.grn_lines for each row execute function private.grn_line_guard();

-- Returns: draft -> posted, a posted return and its lines are final.
create or replace function private.return_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'A supplier return starts as a draft.' using errcode = '23514'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'posted' and exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'A posted supplier return can''t be deleted.' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.status = 'posted' then raise exception 'A posted supplier return can''t be changed.' using errcode = '23514'; end if;
  return new;
end;
$$;
revoke all on function private.return_guard() from public, anon, authenticated;
drop trigger if exists supplier_returns_guard on public.supplier_returns;
create trigger supplier_returns_guard before insert or update or delete on public.supplier_returns for each row execute function private.return_guard();

create or replace function private.return_line_guard()
returns trigger language plpgsql set search_path = '' as $$
declare ret_status text; rid uuid := case when tg_op = 'DELETE' then old.return_id else new.return_id end;
begin
  select status into ret_status from public.supplier_returns where id = rid;
  if ret_status = 'posted' then raise exception 'The lines of a posted supplier return can''t be changed.' using errcode = '23514'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function private.return_line_guard() from public, anon, authenticated;
drop trigger if exists supplier_return_lines_guard on public.supplier_return_lines;
create trigger supplier_return_lines_guard before insert or update or delete on public.supplier_return_lines for each row execute function private.return_line_guard();

-- Attachments: evidence is kept. The only change allowed is a soft delete (deleted_at / deleted_by, once); no hard delete while the business exists.
create or replace function private.attachment_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'Evidence can''t be deleted. It can be hidden (soft delete) only.' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.deleted_at is not null or (to_jsonb(new) - array['deleted_at', 'deleted_by']) is distinct from (to_jsonb(old) - array['deleted_at', 'deleted_by']) then
    raise exception 'Evidence can''t be changed. It can be hidden (soft delete) once.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.attachment_guard() from public, anon, authenticated;
drop trigger if exists attachments_guard on public.attachments;
create trigger attachments_guard before update or delete on public.attachments for each row execute function private.attachment_guard();

-- ---------------------------------------------------------------------------
-- RLS: API-only (no policies, nothing granted to browser roles)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['purchase_orders', 'po_lines', 'supplier_invoices', 'goods_receipts', 'grn_lines', 'supplier_returns', 'supplier_return_lines', 'attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
