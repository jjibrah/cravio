-- 003: live operations. Guest carts, orders, order items, payments, guest requests, menu scans,
-- dish video columns, the media bucket's video types, and the aggregate functions the API reads.
-- Builds on 002 (restaurants, membership helpers). Every statement is idempotent, like 002.
--
-- Access model
-- * Members (owner, manager, waiter) READ their restaurant's operational rows through RLS, using
--   private.is_restaurant_member. They get SELECT only, and only on the columns they need
--   (payments.raw_payload and menu_scans.visitor_id are never readable by browser clients).
-- * Nobody but the service role WRITES these tables. The API checks the caller's membership and role
--   in code, enforces the order state machine, computes totals from the menu, and then writes with the
--   service client. RLS can't express "accepted only after taken, by a member, with a server-computed
--   total", so a narrow write grant would either be unsafe or duplicate the API in SQL.
-- * guest_carts are touched only by the service role (public endpoints and the staff cart lookup).
-- * The aggregate functions are SECURITY DEFINER, check membership of auth.uid() once up front,
--   and are executable by authenticated only. log_menu_scan is executable by service_role only.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Dish video: an optional short clip (15 seconds or less) beside the photo.
-- ---------------------------------------------------------------------------
alter table public.menu_items add column if not exists video_url text
  check (char_length(video_url) <= 1024);
alter table public.menu_items add column if not exists video_poster_url text
  check (char_length(video_poster_url) <= 1024);
alter table public.menu_items add column if not exists video_duration_seconds numeric(4, 1)
  check (video_duration_seconds > 0 and video_duration_seconds <= 15);

-- ---------------------------------------------------------------------------
-- Guest carts: what a guest shows the waiter. Short code + QR, active for 2 hours.
-- ---------------------------------------------------------------------------
create table if not exists public.guest_carts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_id uuid references public.restaurant_tables(id) on delete set null,
  code text not null check (code ~ '^[ACDEFHJKMNPRTUVWXY34679]{6}$'),
  items jsonb not null default '[]'
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 30),
  -- Opaque hash of the guest's X-Cravio-Visitor id, so only the same phone can edit the cart.
  visitor_id text check (char_length(visitor_id) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours',
  claimed_at timestamptz,
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_order_id uuid
);
-- A code is unique among carts that haven't been claimed. Expired, unclaimed carts are purged by the API
-- before their code is reused (now() can't appear in an index predicate).
create unique index if not exists guest_carts_active_code on public.guest_carts (code) where claimed_at is null;
create index if not exists guest_carts_restaurant_idx on public.guest_carts (restaurant_id, created_at);
create index if not exists guest_carts_expiry_idx on public.guest_carts (expires_at) where claimed_at is null;

-- ---------------------------------------------------------------------------
-- Orders: always entered by staff. taken -> accepted -> served -> paid, or cancelled.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  -- The display id: the first 6 hex characters of the uuid ("#92da2e").
  short_id text generated always as (substr(id::text, 1, 6)) stored,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  -- Null for takeaway. table_number is a snapshot, so history survives a deleted table.
  table_id uuid references public.restaurant_tables(id) on delete set null,
  table_number integer check (table_number between 1 and 999),
  status text not null default 'taken' check (status in ('taken', 'accepted', 'served', 'paid', 'cancelled')),
  taken_by uuid references auth.users(id) on delete set null,
  taken_at timestamptz not null default now(),
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  served_by uuid references auth.users(id) on delete set null,
  served_at timestamptz,
  paid_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text check (char_length(cancel_reason) <= 200),
  note text check (char_length(note) <= 280),
  subtotal numeric(10, 2) not null default 0 check (subtotal >= 0),
  total numeric(10, 2) not null default 0 check (total >= 0),
  currency text not null default 'KES' check (currency ~ '^[A-Z]{3}$'),
  source text not null default 'waiter' check (source in ('waiter', 'guest_cart')),
  guest_cart_id uuid references public.guest_carts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Each stage that has happened has a time.
  check (status not in ('accepted', 'served', 'paid') or accepted_at is not null),
  check (status not in ('served', 'paid') or served_at is not null),
  check (status <> 'paid' or paid_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create index if not exists orders_restaurant_status_idx on public.orders (restaurant_id, status, created_at);
create index if not exists orders_restaurant_created_idx on public.orders (restaurant_id, created_at desc);
create index if not exists orders_restaurant_updated_idx on public.orders (restaurant_id, updated_at desc);
create index if not exists orders_restaurant_paid_idx on public.orders (restaurant_id, paid_at) where status = 'paid';
create index if not exists orders_restaurant_short_idx on public.orders (restaurant_id, short_id);
create index if not exists orders_table_idx on public.orders (table_id, status);

-- guest_carts.claimed_order_id -> orders (added after orders exists; the two tables reference each other).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'guest_carts_claimed_order_fk') then
    alter table public.guest_carts add constraint guest_carts_claimed_order_fk
      foreign key (claimed_order_id) references public.orders(id) on delete set null;
  end if;
end;
$$;

-- Line items are snapshots: name and price as they were when the order was taken.
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  item_id uuid references public.menu_items(id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity between 1 and 99),
  note text check (char_length(note) <= 140),
  line_total numeric(10, 2) not null check (line_total >= 0),
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists order_items_order_idx on public.order_items (order_id, position);
create index if not exists order_items_restaurant_item_idx on public.order_items (restaurant_id, item_id);

-- ---------------------------------------------------------------------------
-- Payments. Today: staff mark an order paid ('manual', succeeded at once).
-- Later: a PayHero POS integration writes 'payhero' rows (pending -> succeeded|failed) with its
-- reference and raw callback payload; the unique index makes webhook retries idempotent.
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  provider text not null default 'manual' check (provider in ('manual', 'payhero')),
  provider_reference text check (char_length(provider_reference) <= 120),
  method text not null check (method in ('cash', 'mpesa', 'card', 'other')),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  amount numeric(10, 2) not null check (amount >= 0),
  currency text not null default 'KES' check (currency ~ '^[A-Z]{3}$'),
  raw_payload jsonb,
  failure_reason text check (char_length(failure_reason) <= 300),
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (status <> 'succeeded' or confirmed_at is not null)
);
create index if not exists payments_order_idx on public.payments (order_id);
create index if not exists payments_restaurant_idx on public.payments (restaurant_id, created_at);
create unique index if not exists payments_provider_reference on public.payments (provider, provider_reference)
  where provider <> 'manual' and provider_reference is not null;

-- ---------------------------------------------------------------------------
-- Guest requests from the phone: call the waiter, ask for the bill, ask to pay.
-- At most one unresolved request per table and type, so a second tap returns the first.
-- ---------------------------------------------------------------------------
create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_id uuid not null references public.restaurant_tables(id) on delete cascade,
  type text not null check (type in ('call_waiter', 'bill', 'payment')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  acknowledged_by uuid references auth.users(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  check (status <> 'acknowledged' or acknowledged_at is not null),
  check (status <> 'resolved' or resolved_at is not null)
);
create unique index if not exists service_requests_one_active on public.service_requests (table_id, type)
  where status in ('open', 'acknowledged');
create index if not exists service_requests_restaurant_idx on public.service_requests (restaurant_id, status, created_at);
create index if not exists service_requests_updated_idx on public.service_requests (restaurant_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Menu scans: one row each time a guest opens the menu (deduped per visitor and table for 30 minutes).
-- No IP address or personal data: visitor_id is a server-side hash of a random id the phone generates.
-- ---------------------------------------------------------------------------
create table if not exists public.menu_scans (
  id bigint generated always as identity primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_id uuid references public.restaurant_tables(id) on delete set null,
  visitor_id text check (char_length(visitor_id) <= 64),
  created_at timestamptz not null default now()
);
create index if not exists menu_scans_restaurant_idx on public.menu_scans (restaurant_id, created_at);
create index if not exists menu_scans_table_idx on public.menu_scans (table_id, created_at);
create index if not exists menu_scans_visitor_idx on public.menu_scans (visitor_id, created_at) where visitor_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at triggers (the function comes from 002).
-- ---------------------------------------------------------------------------
drop trigger if exists guest_carts_touch on public.guest_carts;
create trigger guest_carts_touch before update on public.guest_carts
  for each row execute function private.touch_updated_at();
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function private.touch_updated_at();
drop trigger if exists payments_touch on public.payments;
create trigger payments_touch before update on public.payments
  for each row execute function private.touch_updated_at();
drop trigger if exists service_requests_touch on public.service_requests;
create trigger service_requests_touch before update on public.service_requests
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security and grants.
-- ---------------------------------------------------------------------------
alter table public.guest_carts enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.service_requests enable row level security;
alter table public.menu_scans enable row level security;

revoke all on public.guest_carts, public.orders, public.order_items, public.payments,
  public.service_requests, public.menu_scans from public, anon, authenticated;
grant all on public.guest_carts, public.orders, public.order_items, public.payments,
  public.service_requests, public.menu_scans to service_role;

-- guest_carts: no grants and no policies for anon/authenticated. Service role only.

grant select on public.orders, public.order_items, public.service_requests to authenticated;
-- Payments: everything except the provider's raw payload (it can hold a payer's phone number).
grant select (id, restaurant_id, order_id, provider, provider_reference, method, status, amount, currency,
  failure_reason, created_at, confirmed_at, updated_at) on public.payments to authenticated;
-- Scans: counts only. The visitor hash stays server-side.
grant select (id, restaurant_id, table_id, created_at) on public.menu_scans to authenticated;

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists order_items_read on public.order_items;
create policy order_items_read on public.order_items for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists service_requests_read on public.service_requests;
create policy service_requests_read on public.service_requests for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists menu_scans_read on public.menu_scans;
create policy menu_scans_read on public.menu_scans for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));

-- ---------------------------------------------------------------------------
-- Functions.
-- Aggregates run as definer (so they don't evaluate RLS per row) after checking, once, that the
-- caller is a member of the restaurant. The API decides who may see which report.
-- ---------------------------------------------------------------------------

-- Logs a menu open unless the same visitor opened the same table's menu in the last 30 minutes.
-- Service role only (the public menu endpoint). Returns true when a row was written.
create or replace function public.log_menu_scan(p_restaurant uuid, p_table uuid, p_visitor text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_visitor is not null then
    -- Serialise the check-then-insert for this visitor so two quick loads can't both count.
    perform pg_advisory_xact_lock(hashtextextended(p_visitor, 3));
    if exists (
      select 1 from public.menu_scans
      where visitor_id = p_visitor and restaurant_id = p_restaurant
        and table_id is not distinct from p_table
        and created_at > now() - interval '30 minutes'
    ) then
      return false;
    end if;
  end if;
  insert into public.menu_scans (restaurant_id, table_id, visitor_id) values (p_restaurant, p_table, p_visitor);
  return true;
end;
$$;

-- A cheap fingerprint of everything the live screens show. Unchanged fingerprint = nothing to refetch.
create or replace function public.ops_live_cursor(p_restaurant uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return md5(concat_ws('|',
    (select max(updated_at)::text from public.orders where restaurant_id = p_restaurant),
    (select max(updated_at)::text from public.service_requests where restaurant_id = p_restaurant),
    (select string_agg(id::text || ':' || number || ':' || coalesce(section_id::text, '') || ':' || coalesce(label, ''), ',' order by number)
       from public.restaurant_tables where restaurant_id = p_restaurant),
    (select string_agg(id::text || ':' || name, ',' order by id) from public.restaurant_sections where restaurant_id = p_restaurant)
  ));
end;
$$;

-- Headline numbers for [p_from, p_to). Orders count excludes cancelled; sales are paid totals by paid_at.
create or replace function public.ops_totals(p_restaurant uuid, p_from timestamptz, p_to timestamptz, p_table uuid default null)
returns table (menu_scans bigint, orders bigint, cancelled_orders bigint, paid_orders bigint, sales numeric, tables_served bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query select
    (select count(*) from public.menu_scans s
      where s.restaurant_id = p_restaurant and s.created_at >= p_from and s.created_at < p_to
        and (p_table is null or s.table_id = p_table)),
    (select count(*) from public.orders o
      where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
        and o.status <> 'cancelled' and (p_table is null or o.table_id = p_table)),
    (select count(*) from public.orders o
      where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
        and o.status = 'cancelled' and (p_table is null or o.table_id = p_table)),
    (select count(*) from public.orders o
      where o.restaurant_id = p_restaurant and o.status = 'paid' and o.paid_at >= p_from and o.paid_at < p_to
        and (p_table is null or o.table_id = p_table)),
    (select coalesce(sum(o.total), 0) from public.orders o
      where o.restaurant_id = p_restaurant and o.status = 'paid' and o.paid_at >= p_from and o.paid_at < p_to
        and (p_table is null or o.table_id = p_table)),
    (select count(distinct o.table_id) from public.orders o
      where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
        and o.status <> 'cancelled' and o.table_id is not null and (p_table is null or o.table_id = p_table));
end;
$$;

-- Hourly or daily buckets in the restaurant's time zone, with zero-filled gaps.
create or replace function public.ops_series(p_restaurant uuid, p_from timestamptz, p_to timestamptz,
  p_unit text, p_tz text, p_table uuid default null)
returns table (bucket timestamptz, scans bigint, orders bigint, sales numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  step interval;
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  if p_unit not in ('hour', 'day') then
    raise exception 'Unit must be hour or day.' using errcode = '22023';
  end if;
  step := case p_unit when 'hour' then interval '1 hour' else interval '1 day' end;
  return query
  with buckets as (
    select generate_series(date_trunc(p_unit, p_from at time zone p_tz),
                           date_trunc(p_unit, (p_to - interval '1 microsecond') at time zone p_tz),
                           step) as local_start
  ),
  s as (
    select date_trunc(p_unit, m.created_at at time zone p_tz) as local_start, count(*) as n
    from public.menu_scans m
    where m.restaurant_id = p_restaurant and m.created_at >= p_from and m.created_at < p_to
      and (p_table is null or m.table_id = p_table)
    group by 1
  ),
  o as (
    select date_trunc(p_unit, x.created_at at time zone p_tz) as local_start, count(*) as n
    from public.orders x
    where x.restaurant_id = p_restaurant and x.created_at >= p_from and x.created_at < p_to
      and x.status <> 'cancelled' and (p_table is null or x.table_id = p_table)
    group by 1
  ),
  p as (
    select date_trunc(p_unit, x.paid_at at time zone p_tz) as local_start, sum(x.total) as amount
    from public.orders x
    where x.restaurant_id = p_restaurant and x.status = 'paid' and x.paid_at >= p_from and x.paid_at < p_to
      and (p_table is null or x.table_id = p_table)
    group by 1
  )
  select (b.local_start at time zone p_tz) as bucket,
         coalesce(s.n, 0)::bigint, coalesce(o.n, 0)::bigint, coalesce(p.amount, 0)::numeric
  from buckets b
  left join s on s.local_start = b.local_start
  left join o on o.local_start = b.local_start
  left join p on p.local_start = b.local_start
  order by b.local_start;
end;
$$;

-- Best sellers by quantity in non-cancelled orders taken in [p_from, p_to).
create or replace function public.ops_best_sellers(p_restaurant uuid, p_from timestamptz, p_to timestamptz, p_limit integer default 5)
returns table (item_id uuid, name text, quantity bigint, revenue numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
  select i.item_id, (array_agg(i.name order by o.created_at desc))[1], sum(i.quantity)::bigint, sum(i.line_total)::numeric
  from public.order_items i
  join public.orders o on o.id = i.order_id
  where o.restaurant_id = p_restaurant and o.status <> 'cancelled'
    and o.created_at >= p_from and o.created_at < p_to
  group by i.item_id, case when i.item_id is null then i.name end
  order by 3 desc, 4 desc
  limit greatest(1, least(coalesce(p_limit, 5), 50));
end;
$$;

-- Per-table numbers for every current table: scans since p_scans_since and all time, paid revenue since
-- p_revenue_since and all time, orders since p_revenue_since, unpaid orders now, and the last scan.
create or replace function public.ops_table_stats(p_restaurant uuid, p_scans_since timestamptz, p_revenue_since timestamptz)
returns table (table_id uuid, scans_recent bigint, scans_all bigint, revenue_recent numeric, revenue_all numeric,
  orders_recent bigint, open_orders bigint, last_scan_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
  with s as (
    select m.table_id, count(*) filter (where m.created_at >= p_scans_since) as recent, count(*) as total, max(m.created_at) as last_at
    from public.menu_scans m where m.restaurant_id = p_restaurant and m.table_id is not null group by m.table_id
  ),
  o as (
    select x.table_id,
      coalesce(sum(x.total) filter (where x.status = 'paid' and x.paid_at >= p_revenue_since), 0) as revenue_recent,
      coalesce(sum(x.total) filter (where x.status = 'paid'), 0) as revenue_all,
      count(*) filter (where x.status <> 'cancelled' and x.created_at >= p_revenue_since) as orders_recent,
      count(*) filter (where x.status in ('taken', 'accepted', 'served')) as open_orders
    from public.orders x where x.restaurant_id = p_restaurant and x.table_id is not null group by x.table_id
  )
  select t.id, coalesce(s.recent, 0)::bigint, coalesce(s.total, 0)::bigint,
         coalesce(o.revenue_recent, 0)::numeric, coalesce(o.revenue_all, 0)::numeric,
         coalesce(o.orders_recent, 0)::bigint, coalesce(o.open_orders, 0)::bigint, s.last_at
  from public.restaurant_tables t
  left join s on s.table_id = t.id
  left join o on o.table_id = t.id
  where t.restaurant_id = p_restaurant
  order by t.number;
end;
$$;

revoke all on function public.log_menu_scan(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.log_menu_scan(uuid, uuid, text) to service_role;

revoke all on function public.ops_live_cursor(uuid) from public, anon;
revoke all on function public.ops_totals(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.ops_series(uuid, timestamptz, timestamptz, text, text, uuid) from public, anon;
revoke all on function public.ops_best_sellers(uuid, timestamptz, timestamptz, integer) from public, anon;
revoke all on function public.ops_table_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.ops_live_cursor(uuid) to authenticated, service_role;
grant execute on function public.ops_totals(uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;
grant execute on function public.ops_series(uuid, timestamptz, timestamptz, text, text, uuid) to authenticated, service_role;
grant execute on function public.ops_best_sellers(uuid, timestamptz, timestamptz, integer) to authenticated, service_role;
grant execute on function public.ops_table_stats(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage: the media bucket now also takes short dish videos. 25 MB per file at the bucket level;
-- the app keeps images at 5 MB in the browser. Paths stay '<restaurant id>/<kind>/<file>'
-- (videos under '<id>/videos/', posters under '<id>/posters/'); 002's policies already enforce that.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('restaurant-media', 'restaurant-media', true, 26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

notify pgrst, 'reload schema';
