-- Rollback for 013_inventory_recipes.sql: restores the exact 009 bodies of order_stock_needs, branch_committed,
-- stock_check_new_lines, stock_menu_availability and stock_on_serve, drops the snapshot trigger and the tables 013 added.
-- Refuses (and changes nothing) while recipes, extra recipe lines or notifications exist: export and clear those deliberately first.
-- What is lost on purpose: order snapshots (open orders go back to being worked out from the 009 links, live) and recipe versions.
-- Stock exceptions (a 012 table) and movements written by 013 are kept. Apply this BEFORE 012's down.
do $$
declare
  n bigint;
  problems text[] := '{}';
begin
  if to_regclass('public.recipes') is null then return; end if;  -- 013 isn't applied

  select count(*) into n from public.recipes; if n > 0 then problems := problems || format('%s recipe(s)', n); end if;
  select count(*) into n from public.menu_extra_recipe_lines; if n > 0 then problems := problems || format('%s extra recipe line(s)', n); end if;
  select count(*) into n from public.notifications; if n > 0 then problems := problems || format('%s notification(s)', n); end if;
  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 013: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

drop trigger if exists order_items_a_snapshot on public.order_items;
drop trigger if exists stock_balances_stock_out on public.stock_balances;
do $$
begin
  if to_regclass('public.stock_exceptions') is not null then
    drop trigger if exists stock_exceptions_notify on public.stock_exceptions;
  end if;
end;
$$;

-- 009 bodies, restored exactly (see backend/db/migrations/009_inventory.sql).
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

create or replace function private.branch_committed(p_restaurant uuid)
returns table (item_id uuid, quantity numeric)
language sql stable security definer set search_path = '' as $$
  select n.item_id, sum(n.quantity)
    from public.orders o cross join lateral private.order_stock_needs(o.id) n
   where o.restaurant_id = p_restaurant and o.status in ('taken', 'accepted')
   group by n.item_id
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

revoke all on function private.order_stock_needs(uuid), private.branch_committed(uuid),
  private.stock_check_new_lines(), private.stock_on_serve() from public, anon, authenticated;
revoke all on function public.stock_menu_availability(uuid) from public, anon;
grant execute on function public.stock_menu_availability(uuid) to authenticated, service_role;

-- 013's own objects.
drop function if exists private.order_items_snapshot();
drop function if exists private.snapshot_order_line(uuid, uuid, text, text, numeric, jsonb, jsonb);
drop function if exists private.dish_stock_lines(uuid, numeric);
drop function if exists private.stock_out_notify();
drop function if exists private.stock_exception_notify();
drop function if exists private.stock_notify(uuid, uuid, uuid, text, text, text, text, uuid, text);
drop function if exists private.stock_alert_recipients(uuid, uuid);
drop function if exists private.stock_fmt_qty(uuid, numeric);

drop table if exists public.notifications;
drop table if exists public.order_stock_lines;
drop table if exists public.menu_extra_recipe_lines;
alter table if exists public.recipes drop constraint if exists recipes_current_version_fk;
drop table if exists public.recipe_lines;
drop table if exists public.recipe_versions;
drop table if exists public.recipes;
drop function if exists private.recipe_line_guard();
drop function if exists private.recipe_version_guard();
drop function if exists private.recipe_delete_guard();
drop function if exists private.recipe_version_used(uuid);
drop function if exists private.safe_uuid(text);
drop function if exists private.safe_numeric(text);
drop index if exists public.menu_item_extras_id_restaurant;

notify pgrst, 'reload schema';
