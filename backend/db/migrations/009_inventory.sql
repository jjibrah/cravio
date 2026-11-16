-- 009 (PROPOSED, NOT APPLIED): restaurant inventory in servings, linked to Cravio orders, with a main center,
-- branch stock requests and dispatches. Requires 008. See docs/v2/INVENTORY.md for the rules (decisions D03–D07).
--
-- Rules implemented here (confirmed by the product owner, 16 Nov 2026):
-- * Unit: servings. Stock items belong to a business; each location (the business's main center, or a branch) has
--   its own balance. A branch menu item is tracked when linked to a stock item (servings per menu item, default 1).
--   Unlinked menu items and extras are untracked. A deal uses the links of its component dishes.
-- * Stock leaves a branch when an order is SERVED (order trigger below), atomically with the status change.
--   Confirmed-but-unserved orders hold ("commit") servings so the last portion can't be sold twice.
-- * At zero available servings a tracked dish is sold out: ordering it is refused (order_items trigger), unless the
--   branch manager has switched on "keep selling" for that dish.
-- * Corrections (e.g. a served Fanta swapped for a Coke) are branch-manager stock movements tied to the order.
-- * Requests go from a branch to the business owner, who approves (fully, partly) or rejects; approval moves no stock.
--   A dispatch (numbered, with a QR code) takes stock out of the center into transit; the branch confirms receipt line
--   by line; received servings enter the branch, any shortfall is recorded as lost in transit.
--
-- All writes go through the API (service role) or these triggers. Browser clients get read access to their own
-- branch's / business's rows only. Idempotent: every statement can be re-run.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Catalogue, locations, balances
-- ---------------------------------------------------------------------------
create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  unit text not null default 'serving' check (unit in ('serving')),
  low_level numeric(12, 3) check (low_level >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, business_id)
);
create unique index if not exists stock_items_name on public.stock_items (business_id, lower(btrim(name)));

create table if not exists public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind in ('center', 'branch')),
  restaurant_id uuid unique,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (id, business_id),
  check ((kind = 'branch') = (restaurant_id is not null)),
  foreign key (restaurant_id, business_id) references public.restaurants (id, business_id) on delete cascade
);
create unique index if not exists stock_locations_one_center on public.stock_locations (business_id) where kind = 'center';

create table if not exists public.stock_balances (
  location_id uuid not null references public.stock_locations(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  -- May go below zero only through serving (food already left the kitchen); a count fixes it.
  on_hand numeric(12, 3) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (location_id, item_id)
);

-- Menu dish -> stock item. servings: how many servings one dish uses.
create table if not exists public.menu_item_stock (
  menu_item_id uuid primary key references public.menu_items(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  servings numeric(8, 3) not null default 1 check (servings > 0),
  allow_when_out boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists menu_item_stock_item_idx on public.menu_item_stock (restaurant_id, item_id);

-- ---------------------------------------------------------------------------
-- Requests and dispatches
-- ---------------------------------------------------------------------------
create table if not exists public.stock_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  restaurant_id uuid not null,
  number integer not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'cancelled', 'dispatched', 'received')),
  note text check (char_length(note) <= 280),
  requested_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 280),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, number),
  foreign key (restaurant_id, business_id) references public.restaurants (id, business_id) on delete cascade
);
create index if not exists stock_requests_branch_idx on public.stock_requests (restaurant_id, created_at desc);
create index if not exists stock_requests_business_idx on public.stock_requests (business_id, status, created_at desc);

create table if not exists public.stock_request_lines (
  request_id uuid not null references public.stock_requests(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  requested numeric(12, 3) not null check (requested > 0),
  approved numeric(12, 3) check (approved >= 0 and approved <= requested),
  primary key (request_id, item_id)
);

create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  number integer not null,
  -- Printed in the dispatch QR code; scanning it opens the receipt at the destination branch.
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  from_location uuid not null,
  to_location uuid not null,
  request_id uuid references public.stock_requests(id) on delete set null,
  status text not null default 'in_transit' check (status in ('in_transit', 'received', 'cancelled')),
  note text check (char_length(note) <= 280),
  dispatched_by uuid references auth.users(id) on delete set null,
  dispatched_at timestamptz not null default now(),
  received_by uuid references auth.users(id) on delete set null,
  received_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  unique (business_id, number),
  check (from_location <> to_location),
  check (status <> 'received' or received_at is not null),
  foreign key (from_location, business_id) references public.stock_locations (id, business_id),
  foreign key (to_location, business_id) references public.stock_locations (id, business_id)
);
create index if not exists stock_transfers_to_idx on public.stock_transfers (to_location, status);
create unique index if not exists stock_transfers_one_per_request on public.stock_transfers (request_id) where request_id is not null and status <> 'cancelled';

create table if not exists public.stock_transfer_lines (
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  quantity numeric(12, 3) not null check (quantity > 0),
  received numeric(12, 3) check (received >= 0 and received <= quantity),
  primary key (transfer_id, item_id)
);

-- ---------------------------------------------------------------------------
-- Ledger, order effects, idempotent commands
-- ---------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  delta numeric(12, 3) not null check (delta <> 0),
  balance_after numeric(12, 3) not null,
  reason text not null check (reason in ('count', 'added', 'waste', 'served', 'order_correction',
    'dispatched', 'received', 'lost_in_transit', 'dispatch_cancelled')),
  note text check (char_length(note) <= 280),
  actor_id uuid references auth.users(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  transfer_id uuid references public.stock_transfers(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists stock_movements_location_idx on public.stock_movements (location_id, created_at desc);
create index if not exists stock_movements_item_idx on public.stock_movements (location_id, item_id, created_at desc);

create table if not exists public.order_stock_effects (
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id) on delete cascade,
  quantity numeric(12, 3) not null check (quantity > 0),
  movement_id bigint references public.stock_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (order_item_id, item_id)
);

create table if not exists public.stock_commands (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null check (char_length(kind) <= 40),
  result jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create or replace function private.stock_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Stock history is append-only.' using errcode = '42501';
end;
$$;
revoke all on function private.stock_append_only() from public, anon, authenticated;
drop trigger if exists stock_movements_no_change on public.stock_movements;
create trigger stock_movements_no_change before update or delete on public.stock_movements
  for each row execute function private.stock_append_only();

-- ---------------------------------------------------------------------------
-- Order integration
-- ---------------------------------------------------------------------------

-- The branch's stock location, created on first use.
create or replace function private.branch_location(p_restaurant uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  found uuid;
begin
  select id into found from public.stock_locations where restaurant_id = p_restaurant;
  if found is not null then return found; end if;
  insert into public.stock_locations (business_id, kind, restaurant_id, name)
    select business_id, 'branch', id, left(name, 120) from public.restaurants where id = p_restaurant
    on conflict (restaurant_id) do nothing
    returning id into found;
  if found is null then select id into found from public.stock_locations where restaurant_id = p_restaurant; end if;
  return found;
end;
$$;

-- Servings each line of an order uses, per stock item. Dishes use their link; deals use their components' links.
create or replace function private.order_stock_needs(p_order uuid)
returns table (order_item_id uuid, item_id uuid, quantity numeric, menu_name text)
language sql stable security definer set search_path = '' as $$
  select oi.id, mis.item_id, sum(oi.quantity * mis.servings), min(oi.name)
    from public.order_items oi
    join public.menu_item_stock mis on mis.menu_item_id = oi.item_id
   where oi.order_id = p_order and coalesce(oi.kind, 'item') = 'item'
   group by oi.id, mis.item_id
  union all
  select oi.id, mis.item_id, sum(oi.quantity * (c ->> 'quantity')::numeric * mis.servings), min(c ->> 'name')
    from public.order_items oi
    cross join lateral jsonb_array_elements(coalesce(oi.components, '[]'::jsonb)) c
    join public.menu_item_stock mis on mis.menu_item_id = (c ->> 'itemId')::uuid
   where oi.order_id = p_order and oi.kind = 'deal'
   group by oi.id, mis.item_id
$$;

-- Servings held by confirmed orders that haven't been served yet, per stock item, at one branch.
create or replace function private.branch_committed(p_restaurant uuid)
returns table (item_id uuid, quantity numeric)
language sql stable security definer set search_path = '' as $$
  select n.item_id, sum(n.quantity)
    from public.orders o cross join lateral private.order_stock_needs(o.id) n
   where o.restaurant_id = p_restaurant and o.status in ('taken', 'accepted')
   group by n.item_id
$$;

-- Refuse new order lines that need more servings than are available (unless the dish keeps selling when out).
-- Statement-level, after insert: serialises per branch and stock item with advisory locks held to commit.
create or replace function private.stock_check_new_lines()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  o record;
  need record;
  available numeric;
  location uuid;
begin
  for o in select distinct a.order_id, x.restaurant_id from added a join public.orders x on x.id = a.order_id
           where x.status in ('taken', 'accepted') loop
    location := (select id from public.stock_locations where restaurant_id = o.restaurant_id);
    for need in
      select n.item_id, sum(n.quantity) as quantity, min(n.menu_name) as menu_name,
             bool_or(coalesce(mis.allow_when_out, false)) as keep_selling
        from private.order_stock_needs(o.order_id) n
        join public.order_items oi on oi.id = n.order_item_id
        left join public.menu_item_stock mis on mis.menu_item_id = oi.item_id
       group by n.item_id order by n.item_id
    loop
      perform pg_advisory_xact_lock(hashtextextended(o.restaurant_id::text || need.item_id::text, 9));
      if need.keep_selling then continue; end if;
      available := coalesce((select on_hand from public.stock_balances where location_id = location and item_id = need.item_id), 0)
        - coalesce((select c.quantity from private.branch_committed(o.restaurant_id) c where c.item_id = need.item_id), 0);
      if available < 0 then
        raise exception 'Sold out: % (not enough servings left).', need.menu_name
          using errcode = 'P0001', hint = 'stock_sold_out', detail = need.item_id::text;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;
drop trigger if exists order_items_stock_check on public.order_items;
create trigger order_items_stock_check after insert on public.order_items
  referencing new table as added for each statement execute function private.stock_check_new_lines();

-- Deduct when an order is served. Runs once per order (effects are keyed per line and stock item).
create or replace function private.stock_on_serve()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  need record;
  location uuid;
  biz uuid;
  balance numeric;
  movement bigint;
begin
  if not exists (select 1 from private.order_stock_needs(new.id)) then return null; end if;
  location := private.branch_location(new.restaurant_id);
  select business_id into biz from public.stock_locations where id = location;
  for need in select * from private.order_stock_needs(new.id) order by item_id, order_item_id loop
    if exists (select 1 from public.order_stock_effects e where e.order_item_id = need.order_item_id and e.item_id = need.item_id) then continue; end if;
    insert into public.stock_balances (location_id, item_id, on_hand) values (location, need.item_id, 0) on conflict do nothing;
    update public.stock_balances set on_hand = on_hand - need.quantity, updated_at = now()
      where location_id = location and item_id = need.item_id returning on_hand into balance;
    insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, actor_id, order_id)
      values (biz, location, need.item_id, -need.quantity, balance, 'served', new.served_by, new.id) returning id into movement;
    insert into public.order_stock_effects (order_item_id, item_id, location_id, quantity, movement_id)
      values (need.order_item_id, need.item_id, location, need.quantity, movement);
  end loop;
  return null;
end;
$$;
drop trigger if exists orders_stock_on_serve on public.orders;
create trigger orders_stock_on_serve after update of status on public.orders
  for each row when (new.status = 'served' and old.status in ('taken', 'accepted'))
  execute function private.stock_on_serve();

-- Availability of each linked dish at a branch: on hand minus servings held by unserved orders.
-- Members of the branch (and the service role) may ask.
create or replace function public.stock_menu_availability(p_restaurant uuid)
returns table (menu_item_id uuid, item_id uuid, servings numeric, available numeric, allow_when_out boolean, sold_out boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
    select mis.menu_item_id, mis.item_id, mis.servings,
           coalesce(b.on_hand, 0) - coalesce(c.quantity, 0),
           mis.allow_when_out,
           not mis.allow_when_out and coalesce(b.on_hand, 0) - coalesce(c.quantity, 0) < mis.servings
      from public.menu_item_stock mis
      left join public.stock_locations l on l.restaurant_id = mis.restaurant_id
      left join public.stock_balances b on b.location_id = l.id and b.item_id = mis.item_id
      left join private.branch_committed(p_restaurant) c on c.item_id = mis.item_id
     where mis.restaurant_id = p_restaurant;
end;
$$;

revoke all on function private.branch_location(uuid), private.order_stock_needs(uuid), private.branch_committed(uuid),
  private.stock_check_new_lines(), private.stock_on_serve() from public, anon, authenticated;
revoke all on function public.stock_menu_availability(uuid) from public, anon;
grant execute on function public.stock_menu_availability(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: reads only. Branch members read their branch's rows; business owners/operations read their business's.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['stock_items', 'stock_locations', 'stock_balances', 'menu_item_stock', 'stock_requests',
    'stock_request_lines', 'stock_transfers', 'stock_transfer_lines', 'stock_movements', 'order_stock_effects', 'stock_commands'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;
grant select on public.stock_items, public.menu_item_stock to authenticated;
drop policy if exists stock_items_read on public.stock_items;
create policy stock_items_read on public.stock_items for select to authenticated
  using ((select private.business_role(business_id)) is not null
    or exists (select 1 from public.restaurants r where r.business_id = stock_items.business_id and private.is_restaurant_member(r.id)));
drop policy if exists menu_item_stock_read on public.menu_item_stock;
create policy menu_item_stock_read on public.menu_item_stock for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)) or (select private.oversees_branch(restaurant_id)));
-- Balances, movements, requests and transfers are read through the API, which checks branch/business access.

notify pgrst, 'reload schema';
