-- SPIKE (throwaway) for migration 013: order snapshot of ingredient needs. Applied after 001-010.
create schema if not exists private;

-- 012 stand-in: widen quantities to 4 dp (009 used numeric(12,3), which would round 285.7143 to 285.714).
alter table public.stock_balances alter column on_hand type numeric(18,4);
alter table public.stock_movements alter column delta type numeric(18,4);
alter table public.stock_movements alter column balance_after type numeric(18,4);
alter table public.order_stock_effects alter column quantity type numeric(18,4);

alter table public.stock_items add column if not exists yield_pct numeric(5,2) not null default 100
  check (yield_pct > 0 and yield_pct <= 100);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null unique references public.menu_items(id) on delete cascade,
  current_version_id uuid,
  allow_when_out boolean not null default false
);
create table if not exists public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  version int not null,
  unique (recipe_id, version)
);
alter table public.recipes drop constraint if exists recipes_current_fk;
alter table public.recipes add constraint recipes_current_fk foreign key (current_version_id)
  references public.recipe_versions(id) deferrable initially deferred;
create table if not exists public.recipe_lines (
  version_id uuid not null references public.recipe_versions(id) on delete cascade,
  item_id uuid not null references public.stock_items(id),
  qty_base numeric(18,4) not null check (qty_base > 0),
  primary key (version_id, item_id)
);
create table if not exists public.menu_extra_recipe_lines (
  extra_id uuid not null references public.menu_item_extras(id) on delete cascade,
  item_id uuid not null references public.stock_items(id),
  qty_base numeric(18,4) not null check (qty_base > 0),
  primary key (extra_id, item_id)
);

-- Snapshot. One row per (line, ingredient, source, origin): origin = dish id (dish / deal_component) or extra id.
-- Not collapsed further so recipe_version_id stays exact per origin (a deal's components have different versions).
create table if not exists public.order_stock_lines (
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  item_id uuid not null references public.stock_items(id),
  source text not null check (source in ('dish', 'extra', 'deal_component')),
  ref_id uuid not null,
  qty_base numeric(18,4) not null check (qty_base > 0),
  recipe_version_id uuid references public.recipe_versions(id),
  menu_name text,
  primary key (order_item_id, item_id, source, ref_id)
);
create index if not exists order_stock_lines_item_idx on public.order_stock_lines (item_id);

-- What one `factor` of a dish uses: its current recipe, else the 009 link as a one-line recipe (servings).
create or replace function private.dish_stock_lines(p_menu_item uuid, p_factor numeric)
returns table (item_id uuid, qty_base numeric, recipe_version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  select r.current_version_id into v from public.recipes r where r.menu_item_id = p_menu_item and r.current_version_id is not null;
  if v is not null then
    return query select rl.item_id, round(rl.qty_base * p_factor / (si.yield_pct / 100), 4), v
      from public.recipe_lines rl join public.stock_items si on si.id = rl.item_id where rl.version_id = v;
  else
    return query select mis.item_id, round(mis.servings * p_factor / (si.yield_pct / 100), 4), null::uuid
      from public.menu_item_stock mis join public.stock_items si on si.id = mis.item_id where mis.menu_item_id = p_menu_item;
  end if;
end;
$$;

-- Row-level AFTER INSERT. PG fires all row-level AFTER triggers of a statement before its statement-level ones,
-- so this runs before order_items_stock_check regardless of name; the a_ prefix is belt and braces.
create or replace function private.order_items_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c jsonb; x jsonb;
begin
  if new.item_id is not null and coalesce(new.kind, 'item') = 'item' then
    insert into public.order_stock_lines (order_item_id, item_id, source, ref_id, qty_base, recipe_version_id, menu_name)
      select new.id, d.item_id, 'dish', new.item_id, d.qty_base, d.recipe_version_id, new.name
        from private.dish_stock_lines(new.item_id, new.quantity) d;
  elsif new.kind = 'deal' then
    for c in select * from jsonb_array_elements(coalesce(new.components, '[]'::jsonb)) loop
      insert into public.order_stock_lines (order_item_id, item_id, source, ref_id, qty_base, recipe_version_id, menu_name)
        select new.id, d.item_id, 'deal_component', (c ->> 'itemId')::uuid, d.qty_base, d.recipe_version_id, c ->> 'name'
          from private.dish_stock_lines((c ->> 'itemId')::uuid, new.quantity * coalesce((c ->> 'quantity')::numeric, 1)) d
        on conflict (order_item_id, item_id, source, ref_id)
          do update set qty_base = public.order_stock_lines.qty_base + excluded.qty_base;
    end loop;
  end if;
  for x in select * from jsonb_array_elements(coalesce(new.extras, '[]'::jsonb)) loop
    insert into public.order_stock_lines (order_item_id, item_id, source, ref_id, qty_base, menu_name)
      select new.id, e.item_id, 'extra', (x ->> 'id')::uuid, round(e.qty_base * new.quantity / (si.yield_pct / 100), 4), x ->> 'name'
        from public.menu_extra_recipe_lines e join public.stock_items si on si.id = e.item_id
       where e.extra_id = (x ->> 'id')::uuid
      on conflict (order_item_id, item_id, source, ref_id)
        do update set qty_base = public.order_stock_lines.qty_base + excluded.qty_base;
  end loop;
  return null;
end;
$$;
revoke all on function private.dish_stock_lines(uuid, numeric), private.order_items_snapshot() from public, anon, authenticated;
drop trigger if exists order_items_a_snapshot on public.order_items;
create trigger order_items_a_snapshot after insert on public.order_items
  for each row execute function private.order_items_snapshot();

-- Same signature as 009; now reads the snapshot.
create or replace function private.order_stock_needs(p_order uuid)
returns table (order_item_id uuid, item_id uuid, quantity numeric, menu_name text)
language sql stable security definer set search_path = '' as $$
  select s.order_item_id, s.item_id, sum(s.qty_base), min(s.menu_name)
    from public.order_items oi join public.order_stock_lines s on s.order_item_id = oi.id
   where oi.order_id = p_order
   group by s.order_item_id, s.item_id
$$;

-- Same signature; set-based instead of one function call per order.
create or replace function private.branch_committed(p_restaurant uuid)
returns table (item_id uuid, quantity numeric)
language sql stable security definer set search_path = '' as $$
  select s.item_id, sum(s.qty_base)
    from public.orders o join public.order_items oi on oi.order_id = o.id join public.order_stock_lines s on s.order_item_id = oi.id
   where o.restaurant_id = p_restaurant and o.status in ('taken', 'accepted')
   group by s.item_id
$$;

-- Same trigger, same error contract; keep-selling now also honours recipes.allow_when_out (per snapshot origin).
create or replace function private.stock_check_new_lines()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  o record; need record; available numeric; location uuid;
begin
  for o in select distinct a.order_id, x.restaurant_id from added a join public.orders x on x.id = a.order_id
           where x.status in ('taken', 'accepted') loop
    location := (select id from public.stock_locations where restaurant_id = o.restaurant_id);
    for need in
      select s.item_id, sum(s.qty_base) as quantity, min(s.menu_name) as menu_name,
             bool_or(coalesce(r.allow_when_out, mis.allow_when_out, false)) as keep_selling
        from public.order_items oi
        join public.order_stock_lines s on s.order_item_id = oi.id
        left join public.recipes r on r.menu_item_id = s.ref_id
        left join public.menu_item_stock mis on mis.menu_item_id = s.ref_id
       where oi.order_id = o.order_id
       group by s.item_id order by s.item_id
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
revoke all on function private.order_stock_needs(uuid), private.branch_committed(uuid), private.stock_check_new_lines() from public, anon, authenticated;
-- stock_on_serve (009) is unchanged: it already calls private.order_stock_needs, which now reads the snapshot.
