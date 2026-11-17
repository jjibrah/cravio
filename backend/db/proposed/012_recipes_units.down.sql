-- Rollback for 012_recipes_units.sql. Restores the 009 order functions (single servings link per dish), drops recipes
-- and pack columns, and narrows units back to 'serving'.
-- Refuses while any stock item is counted in a unit other than servings (their balances and history would be
-- misread as servings). Recipes are configuration, not history: they are dropped (export them first if wanted).
-- Orders, menus, 009 links, balances and history are never touched.
do $$
begin
  if to_regclass('public.stock_items') is null then return; end if;
  if exists (select 1 from public.stock_items where unit <> 'serving') then
    raise exception 'Refusing rollback: some stock items are counted in units other than servings. Change or remove them first.';
  end if;
end;
$$;

-- 009 versions of the order functions.
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

drop function if exists private.order_dish_needs(uuid);
drop view if exists private.dish_ingredients;
drop table if exists public.menu_item_recipe_lines, public.menu_item_recipes;
alter table public.stock_items drop constraint if exists stock_items_pack_check;
alter table public.stock_items drop column if exists pack_name;
alter table public.stock_items drop column if exists pack_size;
alter table public.stock_items drop constraint if exists stock_items_unit_check;
alter table public.stock_items add constraint stock_items_unit_check check (unit in ('serving'));
notify pgrst, 'reload schema';
