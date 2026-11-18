-- SPIKE for P3-16 / P3-18 (migration 022): FEFO allocation inside the order-serve DB function. Not a real migration.
-- Applied on top of 009 + proposed 012..017. Everything is additive except the two CREATE OR REPLACE FUNCTIONs at the end,
-- which keep their names, signatures and error codes (private.stock_on_serve(), private.stock_check_new_lines()).
--
-- Rules proved here (D3-1, D3-2, D3-3):
--   * only items with stock_items.expiry_tracking <> 'off' take the new path; every other item runs the 013 code unchanged;
--   * a batch is USABLE when it is not quarantined and (it has no expiry date, or expiry_date >= today in Africa/Nairobi,
--     or an override is still running: override_until > now());
--   * allocation order: usable batches by expiry_date (soonest first, no-date batches after dated ones), then received_at, then id;
--     the "no batch" bucket (on_hand minus the sum of ALL batch balances) is used LAST;
--   * SELLABLE = on_hand - Σ balances of unusable batches. The order check and serve stop at SELLABLE, not at on_hand;
--   * one stock_movements row per batch (reason 'served', batch_id set, ref = the order item); order_stock_effects keeps its
--     one-row-per-(order line, item) key, so a replayed serve changes nothing; effect.movement_id = the FIRST movement;
--   * cost of a movement = the batch's unit_cost when inventory_settings cost_method = 'batch', else the item's avg_cost
--     (the bucket always uses avg_cost);
--   * lock order everywhere: advisory (order check) / stock_balances row -> batch_balances rows (in allocation order).

alter table public.stock_items
  add column if not exists expiry_tracking text not null default 'off' check (expiry_tracking in ('off', 'optional', 'mandatory'));

create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  item_id uuid not null,
  batch_no text not null check (char_length(batch_no) between 1 and 60),
  received_at timestamptz not null default now(),
  expiry_date date,
  unit_cost numeric(18, 6),
  status text not null default 'active' check (status in ('active', 'depleted', 'quarantined')),
  override_by uuid references auth.users(id) on delete set null,
  override_reason text,
  override_until timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, item_id, batch_no),
  unique (id, item_id),
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);

create table if not exists public.batch_balances (
  location_id uuid not null references public.stock_locations(id) on delete cascade,
  item_id uuid not null,
  batch_id uuid not null,
  on_hand numeric(18, 4) not null default 0 check (on_hand >= 0),
  updated_at timestamptz not null default now(),
  primary key (location_id, batch_id),
  foreign key (batch_id, item_id) references public.batches (id, item_id) on delete cascade
);
create index if not exists batch_balances_item_idx on public.batch_balances (location_id, item_id);

alter table public.stock_movements
  add constraint stock_movements_batch_fk foreign key (batch_id) references public.batches(id);
create index if not exists stock_movements_batch_idx on public.stock_movements (batch_id) where batch_id is not null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function private.batch_usable(p_status text, p_expiry date, p_override timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select p_status <> 'quarantined'
     and (p_expiry is null or p_expiry >= (now() at time zone 'Africa/Nairobi')::date or coalesce(p_override > now(), false))
$$;

create or replace function private.cost_method(p_business uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select value #>> '{}' from public.inventory_settings
                    where business_id = p_business and location_id is null and key = 'cost_method'), 'weighted_average')
$$;

-- What can be sold now: on hand minus what sits in unusable (expired, not overridden, or quarantined) batches.
create or replace function private.sellable_qty(p_location uuid, p_item uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce((select on_hand from public.stock_balances where location_id = p_location and item_id = p_item), 0)
       - coalesce((select sum(bb.on_hand) from public.batch_balances bb join public.batches b on b.id = bb.batch_id
                    where bb.location_id = p_location and bb.item_id = p_item
                      and not private.batch_usable(b.status, b.expiry_date, b.override_until)), 0)
$$;

-- Splits p_qty across usable batches (soonest expiry first), then the no-batch bucket. Locks the batch rows it reads.
-- The caller must hold the stock_balances row lock and must not ask for more than sellable_qty().
-- Returns (batch_id, qty, unit_cost); batch_id is null for the bucket.
create or replace function private.allocate_fefo(p_location uuid, p_item uuid, p_qty numeric)
returns table (batch_id uuid, qty numeric, unit_cost numeric)
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  remaining numeric := p_qty;
  take numeric;
begin
  for r in
    select bb.batch_id as id, bb.on_hand, b.unit_cost
      from public.batch_balances bb join public.batches b on b.id = bb.batch_id
     where bb.location_id = p_location and bb.item_id = p_item and bb.on_hand > 0
       and private.batch_usable(b.status, b.expiry_date, b.override_until)
     order by b.expiry_date nulls last, b.received_at, b.id
       for update of bb
  loop
    exit when remaining <= 0;
    take := least(r.on_hand, remaining);
    batch_id := r.id; qty := take; unit_cost := r.unit_cost;
    return next;
    remaining := remaining - take;
  end loop;
  if remaining > 0 then
    batch_id := null; qty := remaining; unit_cost := null;
    return next;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- stock_check_new_lines: same as 013 except "available" counts SELLABLE stock for tracked items.
-- ---------------------------------------------------------------------------
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
      select s.item_id, sum(s.qty_base) as quantity, min(s.menu_name) as menu_name,
             bool_or(coalesce(r.allow_when_out, false) or coalesce(mis.allow_when_out, false)) as keep_selling,
             bool_or(si.expiry_tracking <> 'off') as tracked
        from public.order_items oi
        join public.order_stock_lines s on s.order_item_id = oi.id
        join public.stock_items si on si.id = s.item_id
        left join public.recipes r on r.menu_item_id = case when s.source = 'extra' then oi.item_id else s.ref_id end
        left join public.menu_item_stock mis on mis.menu_item_id = case when s.source = 'extra' then oi.item_id else s.ref_id end
       where oi.order_id = o.order_id
       group by s.item_id order by s.item_id
    loop
      perform pg_advisory_xact_lock(hashtextextended(o.restaurant_id::text || need.item_id::text, 9));
      if need.keep_selling then continue; end if;
      available := case when need.tracked then private.sellable_qty(location, need.item_id)
                        else coalesce((select on_hand from public.stock_balances where location_id = location and item_id = need.item_id), 0) end
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

-- ---------------------------------------------------------------------------
-- stock_on_serve: 013's body for untracked items; FEFO for tracked ones.
-- ---------------------------------------------------------------------------
create or replace function private.stock_on_serve()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  need record;
  alloc record;
  location uuid;
  biz uuid;
  balance numeric;
  sellable numeric;
  deducted numeric;
  after_qty numeric;
  cost numeric;
  line_cost numeric;
  movement bigint;
  first_movement bigint;
  tracked boolean;
  by_batch boolean;
begin
  if not exists (select 1 from private.order_stock_needs(new.id)) then return null; end if;
  location := private.branch_location(new.restaurant_id);
  select business_id into biz from public.stock_locations where id = location;
  by_batch := private.cost_method(biz) = 'batch';
  for need in select * from private.order_stock_needs(new.id) order by item_id, order_item_id loop
    if exists (select 1 from public.order_stock_effects e where e.order_item_id = need.order_item_id and e.item_id = need.item_id) then continue; end if;
    insert into public.stock_balances (location_id, item_id, on_hand) values (location, need.item_id, 0) on conflict do nothing;
    select b.on_hand into balance from public.stock_balances b where b.location_id = location and b.item_id = need.item_id for update;
    select (expiry_tracking <> 'off'), avg_cost into tracked, cost from public.stock_items where id = need.item_id;
    first_movement := null;

    if not tracked then
      ---------------- untracked: exactly the 013 behaviour ----------------
      deducted := least(need.quantity, greatest(balance, 0));
      if deducted > 0 then
        update public.stock_balances set on_hand = on_hand - deducted, updated_at = now()
          where location_id = location and item_id = need.item_id returning on_hand into after_qty;
        insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, actor_id, order_id, unit_cost, value, ref_type, ref_id)
          values (biz, location, need.item_id, -deducted, after_qty, 'served', new.served_by, new.id,
            cost, case when cost is null then null else round(-deducted * cost, 2) end, 'order_item', need.order_item_id)
          returning id into first_movement;
      end if;
    else
      ---------------- tracked: stop at SELLABLE, take oldest batch first ----------------
      sellable := private.sellable_qty(location, need.item_id);
      deducted := least(need.quantity, greatest(sellable, 0));
      if deducted > 0 then
        for alloc in select * from private.allocate_fefo(location, need.item_id, deducted) loop
          line_cost := case when by_batch and alloc.batch_id is not null and alloc.unit_cost is not null then alloc.unit_cost else cost end;
          update public.stock_balances set on_hand = on_hand - alloc.qty, updated_at = now()
            where location_id = location and item_id = need.item_id returning on_hand into after_qty;
          if alloc.batch_id is not null then
            update public.batch_balances set on_hand = on_hand - alloc.qty, updated_at = now()
              where location_id = location and batch_id = alloc.batch_id;
          end if;
          insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, actor_id, order_id, unit_cost, value, ref_type, ref_id, batch_id)
            values (biz, location, need.item_id, -alloc.qty, after_qty, 'served', new.served_by, new.id,
              line_cost, case when line_cost is null then null else round(-alloc.qty * line_cost, 2) end, 'order_item', need.order_item_id, alloc.batch_id)
            returning id into movement;
          first_movement := coalesce(first_movement, movement);
        end loop;
      end if;
    end if;

    insert into public.order_stock_effects (order_item_id, item_id, location_id, quantity, movement_id)
      values (need.order_item_id, need.item_id, location, need.quantity, first_movement);
    if deducted < need.quantity then
      insert into public.stock_exceptions (business_id, location_id, item_id, order_id, order_item_id, kind, short_qty)
        values (biz, location, need.item_id, new.id, need.order_item_id, 'unfulfilled_consumption', need.quantity - deducted);
    end if;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- stock_menu_availability: same as 013 except "avail" uses SELLABLE stock for tracked items (an expired-only dish shows sold out).
-- ---------------------------------------------------------------------------
create or replace function public.stock_menu_availability(p_restaurant uuid)
returns table (menu_item_id uuid, item_id uuid, servings numeric, available numeric, allow_when_out boolean, sold_out boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
    with dish as (
      select m.id as menu_item_id, r.current_version_id as version_id,
             coalesce(r.allow_when_out, false) or coalesce(mis.allow_when_out, false) as keep_selling
        from public.menu_items m
        left join public.recipes r on r.menu_item_id = m.id and r.current_version_id is not null
        left join public.menu_item_stock mis on mis.menu_item_id = m.id
       where m.restaurant_id = p_restaurant and (r.id is not null or mis.menu_item_id is not null)
    ), need as (
      select d.menu_item_id, d.keep_selling, rl.item_id, round(sum(rl.qty_base) / (si.yield_pct / 100), 4) as per_dish
        from dish d
        join public.recipe_lines rl on rl.version_id = d.version_id and not rl.takeaway_only
        join public.stock_items si on si.id = rl.item_id
       where d.version_id is not null
       group by d.menu_item_id, d.keep_selling, rl.item_id, si.yield_pct
      union all
      select d.menu_item_id, d.keep_selling, mis.item_id, round(mis.servings / (si.yield_pct / 100), 4)
        from dish d
        join public.menu_item_stock mis on mis.menu_item_id = d.menu_item_id
        join public.stock_items si on si.id = mis.item_id
       where d.version_id is null
    ), held as (
      select c.item_id, c.quantity from private.branch_committed(p_restaurant) c
    ), calc as (
      select n.menu_item_id, n.item_id, n.per_dish, n.keep_selling,
             case when ti.expiry_tracking <> 'off' then private.sellable_qty(l.id, n.item_id) else coalesce(b.on_hand, 0) end
               - coalesce(h.quantity, 0) as avail
        from need n
        join public.stock_items ti on ti.id = n.item_id
        left join public.stock_locations l on l.restaurant_id = p_restaurant
        left join public.stock_balances b on b.location_id = l.id and b.item_id = n.item_id
        left join held h on h.item_id = n.item_id
    )
    select distinct on (cc.menu_item_id) cc.menu_item_id, cc.item_id, cc.per_dish, cc.avail, cc.keep_selling,
           not cc.keep_selling and cc.avail < cc.per_dish
      from calc cc
     order by cc.menu_item_id, cc.avail / cc.per_dish, cc.item_id;
end;
$$;

revoke all on function private.batch_usable(text, date, timestamptz), private.cost_method(uuid), private.sellable_qty(uuid, uuid),
  private.allocate_fefo(uuid, uuid, numeric) from public, anon, authenticated;
