-- 004: menu merchandising and richer insights.
-- Pairings ("goes well with"), extras (paid add-ons), featured dishes, deals ("Pairs & deals"),
-- the guest menu design ("Studio"), guest menu events (dish views, video plays, deal views),
-- order lines that carry extras or a deal, and the aggregate functions for the new insights.
-- Builds on 002 and 003. Every statement is idempotent, like 002 and 003.
--
-- Access model (same as 003)
-- * Members read their restaurant's rows through RLS (private.is_restaurant_member).
-- * Only the service role writes the new tables. The API checks that the caller is an owner or manager
--   in code, validates (limits, same-restaurant references, prices) and then writes with the service client.
-- * Composite foreign keys (id, restaurant_id) make it impossible to pair, extend or bundle a dish of
--   another restaurant, even by mistake on the server.
-- * menu_events.visitor_id (a hash) is never readable by browser clients.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Composite keys so child rows can prove they belong to the same restaurant.
-- ---------------------------------------------------------------------------
create unique index if not exists menu_items_id_restaurant on public.menu_items (id, restaurant_id);

-- ---------------------------------------------------------------------------
-- Featured dishes: an ordered carousel at the top of the guest menu (the API allows 10).
-- ---------------------------------------------------------------------------
alter table public.menu_items add column if not exists featured boolean not null default false;
alter table public.menu_items add column if not exists featured_position integer
  check (featured_position between 0 and 1000);
create index if not exists menu_items_featured_idx on public.menu_items (restaurant_id, featured_position) where featured;

-- ---------------------------------------------------------------------------
-- Menu design (the "Studio"): validated and normalised by the API (see docs/API.md, menu_design).
-- Null means the defaults.
-- ---------------------------------------------------------------------------
alter table public.restaurants add column if not exists menu_design jsonb
  check (menu_design is null or (jsonb_typeof(menu_design) = 'object' and pg_column_size(menu_design) <= 32768));

-- ---------------------------------------------------------------------------
-- Pairings: "Chips goes well with Grilled chicken". Directional and ordered (the API allows 6 per dish).
-- ---------------------------------------------------------------------------
create table if not exists public.menu_item_pairings (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  item_id uuid not null,
  paired_item_id uuid not null,
  position integer not null default 0 check (position between 0 and 100),
  created_at timestamptz not null default now(),
  constraint menu_item_pairings_item_fk foreign key (item_id, restaurant_id)
    references public.menu_items (id, restaurant_id) on delete cascade,
  constraint menu_item_pairings_paired_fk foreign key (paired_item_id, restaurant_id)
    references public.menu_items (id, restaurant_id) on delete cascade,
  constraint menu_item_pairings_unique unique (item_id, paired_item_id),
  constraint menu_item_pairings_not_self check (item_id <> paired_item_id)
);
create index if not exists menu_item_pairings_item_idx on public.menu_item_pairings (item_id, position);
create index if not exists menu_item_pairings_paired_idx on public.menu_item_pairings (paired_item_id);
create index if not exists menu_item_pairings_restaurant_idx on public.menu_item_pairings (restaurant_id);

-- ---------------------------------------------------------------------------
-- Extras: "+ Cheese Ksh 150". Belong to one dish. Chosen per cart or order line.
-- ---------------------------------------------------------------------------
create table if not exists public.menu_item_extras (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  item_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  price numeric(10, 2) not null default 0 check (price >= 0),
  position integer not null default 0 check (position between 0 and 1000),
  available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menu_item_extras_item_fk foreign key (item_id, restaurant_id)
    references public.menu_items (id, restaurant_id) on delete cascade
);
create index if not exists menu_item_extras_item_idx on public.menu_item_extras (item_id, position);
create index if not exists menu_item_extras_restaurant_idx on public.menu_item_extras (restaurant_id);
create unique index if not exists menu_item_extras_name on public.menu_item_extras (item_id, lower(name));

-- ---------------------------------------------------------------------------
-- Deals: a fixed-price bundle of dishes ("Burger meal"), optionally limited to a date window.
-- ---------------------------------------------------------------------------
create table if not exists public.menu_deals (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text check (char_length(description) <= 200),
  price numeric(10, 2) not null check (price >= 0),
  currency text not null default 'KES' check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  photo_url text check (char_length(photo_url) <= 1024),
  position integer not null default 0 check (position between 0 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menu_deals_window check (starts_at is null or ends_at is null or ends_at > starts_at)
);
create unique index if not exists menu_deals_id_restaurant on public.menu_deals (id, restaurant_id);
create index if not exists menu_deals_restaurant_idx on public.menu_deals (restaurant_id, position);

create table if not exists public.menu_deal_items (
  deal_id uuid not null,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  item_id uuid not null,
  quantity integer not null default 1 check (quantity between 1 and 20),
  position integer not null default 0 check (position between 0 and 100),
  primary key (deal_id, item_id),
  constraint menu_deal_items_deal_fk foreign key (deal_id, restaurant_id)
    references public.menu_deals (id, restaurant_id) on delete cascade,
  -- Deleting a dish removes it from its deals; the API then flags a deal left with fewer than 2 units.
  constraint menu_deal_items_item_fk foreign key (item_id, restaurant_id)
    references public.menu_items (id, restaurant_id) on delete cascade
);
create index if not exists menu_deal_items_item_idx on public.menu_deal_items (item_id);
create index if not exists menu_deal_items_restaurant_idx on public.menu_deal_items (restaurant_id);

-- ---------------------------------------------------------------------------
-- Guest menu events: a guest opened a dish sheet, played a dish video, or opened a deal.
-- Deduped per visitor, type and dish/deal for 10 minutes by log_menu_events. No personal data.
-- ---------------------------------------------------------------------------
create table if not exists public.menu_events (
  id bigint generated always as identity primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  type text not null check (type in ('dish_view', 'video_play', 'deal_view')),
  item_id uuid references public.menu_items(id) on delete cascade,
  deal_id uuid references public.menu_deals(id) on delete cascade,
  table_id uuid references public.restaurant_tables(id) on delete set null,
  visitor_id text check (char_length(visitor_id) <= 64),
  created_at timestamptz not null default now(),
  constraint menu_events_target check (
    (type = 'deal_view' and deal_id is not null and item_id is null)
    or (type in ('dish_view', 'video_play') and item_id is not null and deal_id is null))
);
create index if not exists menu_events_restaurant_idx on public.menu_events (restaurant_id, created_at);
create index if not exists menu_events_item_idx on public.menu_events (restaurant_id, item_id, created_at) where item_id is not null;
create index if not exists menu_events_deal_idx on public.menu_events (restaurant_id, deal_id, created_at) where deal_id is not null;
create index if not exists menu_events_visitor_idx on public.menu_events (visitor_id, created_at) where visitor_id is not null;

-- ---------------------------------------------------------------------------
-- Order lines: a line is a dish (with chosen extras) or a deal (with a snapshot of its dishes).
--   extras:     [{ "id", "name", "price" }]                       (snapshot; [] when none)
--   components: [{ "itemId", "name", "quantity", "unitPrice" }]   (deal lines only; per one deal)
-- unit_price stays the dish's (or deal's) own price; line_total = (unit_price + extras) * quantity.
-- Guest carts (guest_carts.items) store the request shape: { itemId, quantity, note, extraIds[] }
-- or { dealId, quantity, note }. The API validates and prices them; no schema change is needed there.
-- ---------------------------------------------------------------------------
alter table public.order_items add column if not exists kind text not null default 'item'
  check (kind in ('item', 'deal'));
alter table public.order_items add column if not exists deal_id uuid references public.menu_deals(id) on delete set null;
alter table public.order_items add column if not exists extras jsonb not null default '[]'
  check (jsonb_typeof(extras) = 'array');
alter table public.order_items add column if not exists components jsonb
  check (components is null or jsonb_typeof(components) = 'array');
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_deal_has_components') then
    alter table public.order_items add constraint order_items_deal_has_components
      check (kind = 'item' or components is not null);
  end if;
end;
$$;
create index if not exists order_items_deal_idx on public.order_items (restaurant_id, deal_id) where deal_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at triggers (the function comes from 002).
-- ---------------------------------------------------------------------------
drop trigger if exists menu_item_extras_touch on public.menu_item_extras;
create trigger menu_item_extras_touch before update on public.menu_item_extras
  for each row execute function private.touch_updated_at();
drop trigger if exists menu_deals_touch on public.menu_deals;
create trigger menu_deals_touch before update on public.menu_deals
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security and grants: members read, the service role writes.
-- ---------------------------------------------------------------------------
alter table public.menu_item_pairings enable row level security;
alter table public.menu_item_extras enable row level security;
alter table public.menu_deals enable row level security;
alter table public.menu_deal_items enable row level security;
alter table public.menu_events enable row level security;

revoke all on public.menu_item_pairings, public.menu_item_extras, public.menu_deals, public.menu_deal_items,
  public.menu_events from public, anon, authenticated;
grant all on public.menu_item_pairings, public.menu_item_extras, public.menu_deals, public.menu_deal_items,
  public.menu_events to service_role;

grant select on public.menu_item_pairings, public.menu_item_extras, public.menu_deals, public.menu_deal_items to authenticated;
-- Events: counts only. The visitor hash stays server-side.
grant select (id, restaurant_id, type, item_id, deal_id, table_id, created_at) on public.menu_events to authenticated;

drop policy if exists menu_item_pairings_read on public.menu_item_pairings;
create policy menu_item_pairings_read on public.menu_item_pairings for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists menu_item_extras_read on public.menu_item_extras;
create policy menu_item_extras_read on public.menu_item_extras for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists menu_deals_read on public.menu_deals;
create policy menu_deals_read on public.menu_deals for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists menu_deal_items_read on public.menu_deal_items;
create policy menu_deal_items_read on public.menu_deal_items for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists menu_events_read on public.menu_events;
create policy menu_events_read on public.menu_events for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));

-- ---------------------------------------------------------------------------
-- Functions.
-- ---------------------------------------------------------------------------

-- Records a batch of guest menu events (service role only: POST /api/public/events).
-- p_events: [{ "type", "item_id", "deal_id", "at" }], already validated by the API.
-- Ignores events for restaurants that aren't live and for dishes/deals of another restaurant.
-- Drops an event when the same visitor logged the same type for the same dish/deal within 10 minutes.
-- Returns how many rows were written.
create or replace function public.log_menu_events(p_restaurant uuid, p_table_number integer, p_visitor text, p_events jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_table uuid;
  v_inserted integer;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    return 0;
  end if;
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant and r.status = 'live') then
    return 0;
  end if;
  if p_table_number is not null then
    select t.id into v_table from public.restaurant_tables t where t.restaurant_id = p_restaurant and t.number = p_table_number;
  end if;
  if p_visitor is not null then
    -- Serialise check-then-insert per visitor so two quick batches can't both count.
    perform pg_advisory_xact_lock(hashtextextended(p_visitor, 4));
  end if;

  with ev as (
    select distinct on (x.type, x.item_id, x.deal_id) x.type, x.item_id, x.deal_id, coalesce(x.at, now()) as at
    from jsonb_to_recordset(p_events) as x(type text, item_id uuid, deal_id uuid, at timestamptz)
    order by x.type, x.item_id, x.deal_id, x.at
  ),
  valid as (
    select ev.* from ev
    where (ev.type in ('dish_view', 'video_play') and ev.deal_id is null and exists (
             select 1 from public.menu_items m where m.id = ev.item_id and m.restaurant_id = p_restaurant))
       or (ev.type = 'deal_view' and ev.item_id is null and exists (
             select 1 from public.menu_deals d where d.id = ev.deal_id and d.restaurant_id = p_restaurant))
  ),
  fresh as (
    select v.* from valid v
    where p_visitor is null or not exists (
      select 1 from public.menu_events e
      where e.visitor_id = p_visitor and e.restaurant_id = p_restaurant and e.type = v.type
        and e.item_id is not distinct from v.item_id and e.deal_id is not distinct from v.deal_id
        and e.created_at > v.at - interval '10 minutes' and e.created_at < v.at + interval '10 minutes')
  )
  insert into public.menu_events (restaurant_id, type, item_id, deal_id, table_id, visitor_id, created_at)
  select p_restaurant, f.type, f.item_id, f.deal_id, v_table, p_visitor, f.at from fresh f;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- Engagement totals for [p_from, p_to): dish views, video plays, deal views.
create or replace function public.ops_engagement_totals(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
returns table (dish_views bigint, video_plays bigint, deal_views bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
  select count(*) filter (where e.type = 'dish_view'),
         count(*) filter (where e.type = 'video_play'),
         count(*) filter (where e.type = 'deal_view')
  from public.menu_events e
  where e.restaurant_id = p_restaurant and e.created_at >= p_from and e.created_at < p_to;
end;
$$;

-- Scans and (non-cancelled) orders per hour of the day in p_tz, summed over [p_from, p_to). Always 24 rows.
create or replace function public.ops_busy_hours(p_restaurant uuid, p_from timestamptz, p_to timestamptz, p_tz text)
returns table (hour_of_day integer, scans bigint, orders bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
  with h as (select generate_series(0, 23) as hr),
  s as (
    select extract(hour from m.created_at at time zone p_tz)::integer as hr, count(*) as n
    from public.menu_scans m
    where m.restaurant_id = p_restaurant and m.created_at >= p_from and m.created_at < p_to
    group by 1
  ),
  o as (
    select extract(hour from x.created_at at time zone p_tz)::integer as hr, count(*) as n
    from public.orders x
    where x.restaurant_id = p_restaurant and x.created_at >= p_from and x.created_at < p_to and x.status <> 'cancelled'
    group by 1
  )
  select h.hr, coalesce(s.n, 0)::bigint, coalesce(o.n, 0)::bigint
  from h left join s on s.hr = h.hr left join o on o.hr = h.hr
  order by h.hr;
end;
$$;

-- Every current dish and deal with its views, video plays, quantities and sales in non-cancelled orders
-- taken in [p_from, p_to).
-- * Dish rows: direct_* come from dish lines (sales include their extras); deal_* come from deals that
--   contain the dish: quantity = units inside sold deals, sales = the deal line's revenue allocated to its
--   dishes in proportion to their regular prices at the time of the order (equal split if all were free).
-- * Deal rows: direct_* are the deal lines themselves; deal_* are 0; plays are 0.
create or replace function public.ops_dish_performance(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
returns table (kind text, ref_id uuid, name text, views bigint, plays bigint,
  direct_quantity bigint, deal_quantity bigint, direct_sales numeric, deal_sales numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
  with lines as (
    select i.kind as k, i.item_id, i.deal_id, i.quantity as qty, i.line_total, i.components
    from public.order_items i
    join public.orders o on o.id = i.order_id
    where o.restaurant_id = p_restaurant and o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to
  ),
  direct as (
    select l.item_id as ref, sum(l.qty) as q, sum(l.line_total) as s
    from lines l where l.k = 'item' and l.item_id is not null group by l.item_id
  ),
  parts as (
    select case when c->>'itemId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (c->>'itemId')::uuid end as ref,
           (case when c->>'quantity' ~ '^[0-9]{1,3}$' then (c->>'quantity')::integer else 1 end) * l.qty as q,
           l.line_total * case
             when w.total > 0 then (case when c->>'unitPrice' ~ '^[0-9]+(\.[0-9]+)?$' then (c->>'unitPrice')::numeric else 0 end)
                                   * (case when c->>'quantity' ~ '^[0-9]{1,3}$' then (c->>'quantity')::integer else 1 end) / w.total
             else 1.0 / greatest(w.n, 1) end as s
    from lines l
    cross join lateral (
      select coalesce(sum((case when e->>'unitPrice' ~ '^[0-9]+(\.[0-9]+)?$' then (e->>'unitPrice')::numeric else 0 end)
                          * (case when e->>'quantity' ~ '^[0-9]{1,3}$' then (e->>'quantity')::integer else 1 end)), 0) as total,
             count(*) as n
      from jsonb_array_elements(l.components) e
    ) w
    cross join lateral jsonb_array_elements(l.components) c
    where l.k = 'deal' and l.components is not null and jsonb_typeof(l.components) = 'array'
  ),
  via_deals as (
    select p.ref, sum(p.q) as q, sum(p.s) as s from parts p where p.ref is not null group by p.ref
  ),
  deal_lines as (
    select l.deal_id as ref, sum(l.qty) as q, sum(l.line_total) as s
    from lines l where l.k = 'deal' and l.deal_id is not null group by l.deal_id
  ),
  ev as (
    select coalesce(e.item_id, e.deal_id) as ref,
           count(*) filter (where e.type in ('dish_view', 'deal_view')) as v,
           count(*) filter (where e.type = 'video_play') as p
    from public.menu_events e
    where e.restaurant_id = p_restaurant and e.created_at >= p_from and e.created_at < p_to
    group by 1
  )
  select 'item'::text, m.id, m.name,
         coalesce(ev.v, 0)::bigint, coalesce(ev.p, 0)::bigint,
         coalesce(d.q, 0)::bigint, coalesce(vd.q, 0)::bigint,
         round(coalesce(d.s, 0), 2)::numeric, round(coalesce(vd.s, 0), 2)::numeric
  from public.menu_items m
  left join direct d on d.ref = m.id
  left join via_deals vd on vd.ref = m.id
  left join ev on ev.ref = m.id
  where m.restaurant_id = p_restaurant
  union all
  select 'deal'::text, x.id, x.name,
         coalesce(ev.v, 0)::bigint, 0::bigint,
         coalesce(dl.q, 0)::bigint, 0::bigint,
         round(coalesce(dl.s, 0), 2)::numeric, 0::numeric
  from public.menu_deals x
  left join deal_lines dl on dl.ref = x.id
  left join ev on ev.ref = x.id
  where x.restaurant_id = p_restaurant;
end;
$$;

revoke all on function public.log_menu_events(uuid, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.log_menu_events(uuid, integer, text, jsonb) to service_role;

revoke all on function public.ops_engagement_totals(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.ops_busy_hours(uuid, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.ops_dish_performance(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.ops_engagement_totals(uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.ops_busy_hours(uuid, timestamptz, timestamptz, text) to authenticated, service_role;
grant execute on function public.ops_dish_performance(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage: objects must live in a known folder of the restaurant: '<restaurant id>/<folder>/<file>'.
-- Deal photos go under '<restaurant id>/deals/'. 'design/' is reserved for Studio assets.
-- ---------------------------------------------------------------------------
create or replace function private.can_manage_media(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  head text := split_part(object_name, '/', 1);
  folder text := split_part(object_name, '/', 2);
begin
  if head !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  if folder not in ('logo', 'cover', 'items', 'videos', 'posters', 'deals', 'design') then return false; end if;
  if split_part(object_name, '/', 3) = '' then return false; end if;
  return private.can_manage_restaurant(head::uuid);
end;
$$;
revoke all on function private.can_manage_media(text) from public, anon;
grant execute on function private.can_manage_media(text) to authenticated;

notify pgrst, 'reload schema';
