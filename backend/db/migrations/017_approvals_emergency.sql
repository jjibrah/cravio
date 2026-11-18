-- 017 (PROPOSED, NOT APPLIED): approval rules, approvals and emergency purchases.
-- Requires 012 (stock_categories, stock_items unique (id, business_id)), 015 (suppliers, document numbers) and 016 (attachments).
-- Phase 2, ticket P2-09. See docs/inventory-kb/09-phase2-workplan.md (P2-09/10/11, D2-5, D2-6, D2-9, D2-16) and 03-prd-digest.md (EMP-1..7, PRC-3, RBAC-3/4/5).
--
-- * approval_rules: the OWNER's limits. One row per (subject, branch or business default, optional category). A branch row replaces the business
--   default for that branch (row-level override); a category row adds to the general row. The rows carry amounts only because the owner typed them
--   in Settings -> Inventory: NOTHING is seeded and no amount is built in anywhere (D2-6, D2-16). Subjects: purchase_order, emergency_purchase,
--   wastage, adjustment, count. Limits: per_transaction_kes (a purchase / a wastage record / an adjustment), per_day_kes and per_week_kes
--   (emergency purchases only: running totals in Africa/Nairobi, the week runs Monday to Sunday), variance_pct and variance_kes (counts only).
--   approver_capability says which capability may decide (inv.emergency.approve ...). A rule must set at least one limit; a smaller window can't
--   exceed a longer one (transaction <= day <= week).
-- * approvals: one row per request for approval, polymorphic (subject_type + subject_id, no FK to the subject) so purchase orders, emergency
--   purchases and the Phase 3 subjects share it. rule_snapshot keeps which rule and what reasons applied at the time, so a later rule change never
--   rewrites history. Maker-checker is enforced HERE as well as in the service: decided_by may not equal requested_by unless self_approved is true,
--   and self_approved is true only for an approval by the requester themself (the service allows that only when nobody else in the business can approve, D2-5).
--   pending -> approved | rejected | cancelled; a decided row can't change. Escalation columns are reserved for P1 and stay empty.
-- * emergency_purchases (EP-2026-0001) + emergency_purchase_lines: a branch buys in an emergency. Quantities are kept as entered and in base units
--   (as in purchase orders). Status path (trigger): draft -> pending_approval | authorised | cancelled; pending_approval -> authorised | rejected | draft | cancelled;
--   authorised -> purchased | cancelled; purchased -> received | under_review; received -> under_review | closed; under_review -> closed.
--   A purchase with no invoice needs a reason, a payment reference (checks) and, to be received, at least one photo of the goods (trigger, T-EMP-3).
--   M-Pesa references are checked for format. Lines freeze once the purchase leaves draft; only the actual price, received quantity and the
--   ledger movement move afterwards.
--
-- SHARED DATABASE: ADDITIVE ONLY (four new tables, three guard functions). Nothing existing is altered, so `main` keeps working.
-- RLS: enabled with NO policies and no grants to browser roles: the API (service role) is the only reader and writer.
-- Idempotent: every statement can be re-run. Rollback: 017_approvals_emergency.down.sql (refuses while any rule, approval or emergency purchase exists).

create schema if not exists private;

do $$
begin
  if to_regclass('public.attachments') is null then
    raise exception '017 needs migration 016 (purchasing and attachments) first.';
  end if;
  if to_regclass('public.suppliers') is null or to_regclass('public.stock_categories') is null then
    raise exception '017 needs migrations 012 and 015 first.';
  end if;
  if to_regclass('public.approvals') is not null and not exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'approvals' and column_name = 'rule_snapshot') then
    raise exception 'A table public.approvals already exists with a different shape; rename it or adapt 017 first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Approval rules (owner-set; no seed rows)
-- ---------------------------------------------------------------------------
create table if not exists public.approval_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  subject text not null check (subject in ('purchase_order', 'emergency_purchase', 'wastage', 'adjustment', 'count')),
  -- Null = the business default (every branch without its own rule). A branch's stock location = that branch's override.
  location_id uuid,
  -- Null = the whole purchase / record. A category (and its sub-categories) = an extra limit for lines of that category.
  category_id uuid,
  per_transaction_kes numeric(14, 2) check (per_transaction_kes >= 0),
  per_day_kes numeric(14, 2) check (per_day_kes >= 0),
  per_week_kes numeric(14, 2) check (per_week_kes >= 0),
  variance_pct numeric(5, 2) check (variance_pct >= 0 and variance_pct <= 100),
  variance_kes numeric(14, 2) check (variance_kes >= 0),
  approver_capability text not null check (approver_capability in ('inv.purchase.approve', 'inv.emergency.approve', 'inv.adjust.approve', 'inv.count.approve')),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (category_id, business_id) references public.stock_categories (id, business_id),
  constraint approval_rules_one_limit check (num_nonnulls(per_transaction_kes, per_day_kes, per_week_kes, variance_pct, variance_kes) >= 1),
  constraint approval_rules_windows check (
    (per_day_kes is null or per_transaction_kes is null or per_day_kes >= per_transaction_kes)
    and (per_week_kes is null or per_day_kes is null or per_week_kes >= per_day_kes)
    and (per_week_kes is null or per_transaction_kes is null or per_week_kes >= per_transaction_kes)),
  constraint approval_rules_windows_emergency_only check (subject = 'emergency_purchase' or (per_day_kes is null and per_week_kes is null)),
  constraint approval_rules_variance_counts_only check (subject = 'count' or (variance_pct is null and variance_kes is null)),
  constraint approval_rules_counts_use_variance check (subject <> 'count' or per_transaction_kes is null)
);
-- One rule per (subject, place, category): the "place" and "category" parts treat null as "everywhere" / "all".
create unique index if not exists approval_rules_scope
  on public.approval_rules (business_id, subject, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists approval_rules_lookup on public.approval_rules (business_id, subject) where active;

-- ---------------------------------------------------------------------------
-- Approvals (polymorphic; Phase 3 reuses it)
-- ---------------------------------------------------------------------------
create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  subject_type text not null check (subject_type in ('purchase_order', 'emergency_purchase', 'wastage', 'adjustment', 'count', 'transfer')),
  subject_id uuid not null,
  location_id uuid,
  approver_capability text not null check (approver_capability in ('inv.purchase.approve', 'inv.emergency.approve', 'inv.adjust.approve', 'inv.count.approve', 'inv.request.approve')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  amount_kes numeric(14, 2) check (amount_kes >= 0),
  -- Which rule applied and why: { ruleId, rule: {...limits}, reasons: ["Over your KES 5,000 limit ..."], safeDefault, usage }. A copy, so edits to the rule don't rewrite history.
  rule_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  self_approved boolean not null default false,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  -- Reserved for P1 (escalation when nobody answers). Stay empty in Phase 2.
  escalate_after timestamptz,
  escalated_at timestamptz,
  escalated_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  -- Maker-checker (T-SEC-2): another person decides, unless the requester is the only possible approver (D2-5, flagged self_approved).
  constraint approvals_maker_checker check (decided_by is null or requested_by is null or decided_by <> requested_by or self_approved),
  constraint approvals_self_approved_is_own check (not self_approved or (status = 'approved' and decided_by is not null and decided_by = requested_by)),
  constraint approvals_decided check (
    (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null)
    or (status in ('pending', 'cancelled') and decided_by is null and decided_at is null)),
  constraint approvals_cancelled check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint approvals_rejection_has_reason check (status <> 'rejected' or char_length(btrim(coalesce(decision_note, ''))) > 0)
);
create index if not exists approvals_inbox on public.approvals (business_id, status, requested_at desc);
create index if not exists approvals_subject on public.approvals (business_id, subject_type, subject_id);
create index if not exists approvals_requester on public.approvals (requested_by, requested_at desc);
-- A subject has at most one open request at a time (a rejected one can be asked again).
create unique index if not exists approvals_one_pending on public.approvals (business_id, subject_type, subject_id) where status = 'pending';

create or replace function private.approval_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'Approvals are part of the audit trail and can''t be deleted.' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status <> 'pending' then
    raise exception 'This approval is already % and can''t change.', old.status using errcode = '23514';
  end if;
  if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_note', 'self_approved', 'cancelled_by', 'cancelled_at', 'escalate_after', 'escalated_at', 'escalated_to'])
     is distinct from (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_note', 'self_approved', 'cancelled_by', 'cancelled_at', 'escalate_after', 'escalated_at', 'escalated_to']) then
    raise exception 'What was asked for can''t be edited. Withdraw the request and ask again.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.approval_guard() from public, anon, authenticated;
drop trigger if exists approvals_guard on public.approvals;
create trigger approvals_guard before update or delete on public.approvals for each row execute function private.approval_guard();

-- ---------------------------------------------------------------------------
-- Emergency purchases
-- ---------------------------------------------------------------------------
create table if not exists public.emergency_purchases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  number text not null check (number ~ '^EP-[0-9]{4}-[0-9]{4,}$'),
  location_id uuid not null,
  requested_by uuid references auth.users(id) on delete set null,
  supplier_id uuid,
  supplier_name text check (char_length(btrim(supplier_name)) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'authorised', 'purchased', 'received', 'under_review', 'closed', 'rejected', 'cancelled')),
  estimated_total numeric(14, 2) not null default 0 check (estimated_total >= 0),
  approved_total numeric(14, 2) check (approved_total >= 0),
  actual_total numeric(14, 2) check (actual_total >= 0),
  payment_method text check (payment_method in ('cash', 'mpesa', 'supplier_credit')),
  payment_reference text check (char_length(btrim(payment_reference)) between 1 and 60),
  reason text not null check (char_length(btrim(reason)) between 1 and 300),
  invoice_status text check (invoice_status in ('etims', 'other', 'none')),
  invoice_no text check (char_length(btrim(invoice_no)) between 1 and 60),
  no_invoice_reason text check (char_length(btrim(no_invoice_reason)) between 1 and 300),
  approval_id uuid references public.approvals(id) on delete set null,
  auto_authorised boolean not null default false,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 500),
  clawback_note text check (char_length(clawback_note) <= 500),
  submitted_at timestamptz,
  authorised_at timestamptz,
  purchased_at timestamptz,
  received_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  unique (business_id, number),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id),
  -- No invoice: a reason and a payment reference (M-Pesa code or receipt number) are mandatory. The photo is checked when the goods are received (trigger below).
  constraint emergency_no_invoice check (invoice_status is distinct from 'none'
    or (char_length(btrim(coalesce(no_invoice_reason, ''))) > 0 and char_length(btrim(coalesce(payment_reference, ''))) > 0)),
  constraint emergency_invoice_no check (invoice_status not in ('etims', 'other') or status in ('draft', 'pending_approval', 'authorised', 'purchased', 'rejected', 'cancelled') or invoice_no is not null),
  constraint emergency_mpesa_code check (payment_method is distinct from 'mpesa' or payment_reference is null or payment_reference ~ '^[A-Z][A-Z0-9]{9}$'),
  constraint emergency_authorised_at check (status not in ('authorised', 'purchased', 'received', 'under_review', 'closed') or authorised_at is not null),
  constraint emergency_purchased check (status not in ('purchased', 'received', 'under_review', 'closed') or (payment_method is not null and actual_total is not null and purchased_at is not null)),
  constraint emergency_received check (status not in ('received', 'under_review', 'closed') or (invoice_status is not null and received_at is not null)),
  constraint emergency_review check (status <> 'under_review' or char_length(btrim(coalesce(review_note, ''))) > 0),
  constraint emergency_closed check (status <> 'closed' or (closed_at is not null and reviewed_by is not null)),
  constraint emergency_cancelled check (status <> 'cancelled' or cancelled_at is not null)
);
create index if not exists emergency_status_idx on public.emergency_purchases (business_id, status, created_at desc);
create index if not exists emergency_window_idx on public.emergency_purchases (business_id, location_id, authorised_at) where authorised_at is not null;
create index if not exists emergency_requester_idx on public.emergency_purchases (requested_by, created_at desc);

create table if not exists public.emergency_purchase_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  emergency_id uuid not null,
  position integer not null default 0 check (position >= 0),
  item_id uuid not null,
  -- As entered: 2 sacks at KES 3,250 a sack. unit_factor = base units in one entered unit at that moment (a snapshot).
  entered_qty numeric(18, 4) not null check (entered_qty > 0),
  entered_unit text not null check (char_length(entered_unit) between 1 and 30),
  unit_factor numeric(24, 12) not null check (unit_factor > 0),
  qty_base numeric(18, 4) not null check (qty_base > 0),
  est_unit_price numeric(14, 2) not null default 0 check (est_unit_price >= 0),
  est_total numeric(14, 2) not null default 0 check (est_total >= 0),
  actual_unit_price numeric(14, 2) check (actual_unit_price >= 0),
  actual_total numeric(14, 2) check (actual_total >= 0),
  received_base numeric(18, 4) check (received_base >= 0),
  movement_id bigint references public.stock_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  unique (emergency_id, position),
  foreign key (emergency_id, business_id) references public.emergency_purchases (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id)
);
create index if not exists emergency_lines_item_idx on public.emergency_purchase_lines (business_id, item_id);

create or replace function private.emergency_guard()
returns trigger language plpgsql set search_path = '' as $$
declare allowed text[];
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'An emergency purchase starts as a draft.' using errcode = '23514'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.businesses b where b.id = old.business_id) then
      raise exception 'Only a draft emergency purchase can be deleted. Cancel it instead.' using errcode = '23514';
    end if;
    return old;
  end if;
  new.updated_at := now();
  if new.status <> old.status then
    allowed := case old.status
      when 'draft' then array['pending_approval', 'authorised', 'cancelled']
      when 'pending_approval' then array['authorised', 'rejected', 'draft', 'cancelled']
      when 'authorised' then array['purchased', 'cancelled']
      when 'purchased' then array['received', 'under_review']
      when 'received' then array['under_review', 'closed']
      when 'under_review' then array['closed']
      else array[]::text[] end;
    if not (new.status = any (allowed)) then
      raise exception 'An emergency purchase can''t go from % to %.', old.status, new.status using errcode = '23514';
    end if;
    -- T-EMP-3: no invoice means a photo of the goods before the stock is booked in.
    if new.status = 'received' and new.invoice_status = 'none' and not exists (
      select 1 from public.attachments a where a.business_id = new.business_id and a.entity_type = 'emergency' and a.entity_id = new.id
        and a.deleted_at is null and a.mime like 'image/%') then
      raise exception 'A purchase with no invoice needs a photo of the goods before it can be received.' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.status in ('closed', 'cancelled', 'rejected') then
    raise exception 'A % emergency purchase can''t be changed.', old.status using errcode = '23514';
  end if;
  if old.status in ('received', 'under_review') and
     (to_jsonb(new) - array['review_note', 'clawback_note', 'reviewed_by', 'reviewed_at', 'updated_at']) is distinct from (to_jsonb(old) - array['review_note', 'clawback_note', 'reviewed_by', 'reviewed_at', 'updated_at']) then
    raise exception 'Once the goods are received only the owner''s review notes can change.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.emergency_guard() from public, anon, authenticated;
drop trigger if exists emergency_purchases_guard on public.emergency_purchases;
create trigger emergency_purchases_guard before insert or update or delete on public.emergency_purchases for each row execute function private.emergency_guard();

create or replace function private.emergency_line_guard()
returns trigger language plpgsql set search_path = '' as $$
declare parent_status text; parent_id uuid;
begin
  parent_id := case when tg_op = 'DELETE' then old.emergency_id else new.emergency_id end;
  select status into parent_status from public.emergency_purchases where id = parent_id;
  if parent_status is null then return case when tg_op = 'DELETE' then old else new end; end if;   -- the purchase is being deleted too
  if tg_op = 'UPDATE' and parent_status in ('authorised', 'purchased') then
    -- Only what happens after authorising may move: the real price, what arrived, and the ledger movement.
    if (to_jsonb(new) - array['actual_unit_price', 'actual_total', 'received_base', 'movement_id']) is distinct from (to_jsonb(old) - array['actual_unit_price', 'actual_total', 'received_base', 'movement_id']) then
      raise exception 'The lines of an authorised emergency purchase can''t be edited. Only the real price and what arrived can be filled in.' using errcode = '23514';
    end if;
    return new;
  end if;
  if parent_status <> 'draft' then
    raise exception 'The lines of an emergency purchase can only change while it is a draft.' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function private.emergency_line_guard() from public, anon, authenticated;
drop trigger if exists emergency_lines_guard on public.emergency_purchase_lines;
create trigger emergency_lines_guard before insert or update or delete on public.emergency_purchase_lines for each row execute function private.emergency_line_guard();

-- ---------------------------------------------------------------------------
-- RLS: API-only (no policies, nothing granted to browser roles)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['approval_rules', 'approvals', 'emergency_purchases', 'emergency_purchase_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
