-- 012 (PROPOSED, NOT APPLIED): units, packs and multi-ingredient recipes for inventory. Requires 009.
-- See docs/v2/RECIPES.md for the rules.
--
-- Rules implemented here:
-- * Unit: a stock item is counted in one unit: serving, piece, g, kg, ml or l. Quantities (balances, movements,
--   requests, dispatches) are stored in that unit. Existing items stay 'serving' and behave exactly as before.
-- * Pack (optional, per business SOP): a pack name and size in the item's unit, e.g. "crate" = 10 kg. The API converts
--   "40 crates" to 400 kg before storing; the database only ever sees the item's unit.
-- * Recipe: a dish can have several ingredient lines (stock item + quantity per dish, stored in the item's unit, with
--   the quantity and unit the manager entered kept for display). The 009 single link (menu_item_stock) is a one-line
--   recipe; a dish has either a link or a recipe (a recipe wins if both exist).
-- * Serving deducts every ingredient (once per order line and stock item: order_stock_effects keeps it idempotent);
--   confirmed orders hold every ingredient; a dish is sold out when ANY ingredient is short, unless that dish keeps
--   selling when out. Deals use their component dishes' recipes.
--
-- All writes go through the API (service role). Browsers may read recipes of their own branch only.
-- Idempotent: every statement can be re-run. Rollback: backend/db/proposed/012_recipes_units.down.sql.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Units and packs on stock items
-- ---------------------------------------------------------------------------
alter table public.stock_items drop constraint if exists stock_items_unit_check;
alter table public.stock_items add constraint stock_items_unit_check
  check (unit in ('serving', 'piece', 'g', 'kg', 'ml', 'l'));
alter table public.stock_items add column if not exists pack_name text;
alter table public.stock_items add column if not exists pack_size numeric(12, 3);
alter table public.stock_items drop constraint if exists stock_items_pack_check;
alter table public.stock_items add constraint stock_items_pack_check check (
  (pack_name is null) = (pack_size is null)
  and (pack_size is null or pack_size > 0)
  and (pack_name is null or char_length(btrim(pack_name)) between 1 and 30));

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------
create table if not exists public.menu_item_recipes (
  menu_item_id uuid primary key references public.menu_items(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  allow_when_out boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists menu_item_recipes_branch_idx on public.menu_item_recipes (restaurant_id);

create table if not exists public.menu_item_recipe_lines (
  menu_item_id uuid not null references public.menu_item_recipes(menu_item_id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  -- Per dish, in the stock item's unit (what is deducted).
  quantity numeric(12, 3) not null check (quantity > 0),
  -- What the manager typed, for display ("200 g" of a kg item).
  entered_quantity numeric(12, 3) not null check (entered_quantity > 0),
  entered_unit text not null check (entered_unit in ('serving', 'piece', 'g', 'kg', 'ml', 'l', 'pack')),
  position smallint not null default 0,
  primary key (menu_item_id, item_id)
);
create index if not exists menu_item_recipe_lines_item_idx on public.menu_item_recipe_lines (item_id);

-- Every ingredient of every tracked dish: 009 links (one line) plus recipes. A recipe replaces a link for the same dish.
create or replace view private.dish_ingredients as
  select mis.menu_item_id, mis.restaurant_id, mis.item_id, mis.servings as quantity, mis.allow_when_out
    from public.menu_item_stock mis
   where not exists (select 1 from public.menu_item_recipes r where r.menu_item_id = mis.menu_item_id)
  union all
  select l.menu_item_id, r.restaurant_id, l.item_id, l.quantity, r.allow_when_out
    from public.menu_item_recipe_lines l join public.menu_item_recipes r on r.menu_item_id = l.menu_item_id;
revoke all on private.dish_ingredients from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Order integration (replaces the 009 versions; same signatures)
-- ---------------------------------------------------------------------------

-- Stock each order line needs, per dish (deal components count as their dishes) and ingredient.
create or replace function private.order_dish_needs(p_order uuid)
returns table (order_item_id uuid, menu_item_id uuid, item_id uuid, quantity numeric, menu_name text, allow_when_out boolean)
language sql stable security definer set search_path = '' as $$
  select oi.id, d.menu_item_id, d.item_id, oi.quantity * d.quantity, oi.name, d.allow_when_out
    from public.order_items oi
    join private.dish_ingredients d on d.menu_item_id = oi.item_id
   where oi.order_id = p_order and coalesce(oi.kind, 'item') = 'item'
  union all
  select oi.id, d.menu_item_id, d.item_id, oi.quantity * (c ->> 'quantity')::numeric * d.quantity, c ->> 'name', d.allow_when_out
    from public.order_items oi
    cross join lateral jsonb_array_elements(coalesce(oi.components, '[]'::jsonb)) c
    join private.dish_ingredients d on d.menu_item_id = (c ->> 'itemId')::uuid
   where oi.order_id = p_order and oi.kind = 'deal'
$$;

-- Quantity each line of an order uses, per stock item (in the item's unit). Used by serving and by holds.
create or replace function private.order_stock_needs(p_order uuid)
returns table (order_item_id uuid, item_id uuid, quantity numeric, menu_name text)
language sql stable security definer set search_path = '' as $$
  select n.order_item_id, n.item_id, sum(n.quantity), min(n.menu_name)
    from private.order_dish_needs(p_order) n
   group by n.order_item_id, n.item_id
$$;

-- Refuse new order lines that need more of any ingredient than is available. An ingredient may go short only when
-- every dish in the order that uses it keeps selling when out.
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
      select n.item_id, sum(n.quantity) as quantity,
             min(n.menu_name) filter (where not n.allow_when_out) as menu_name,
             bool_and(n.allow_when_out) as keep_selling
        from private.order_dish_needs(o.order_id) n
       group by n.item_id order by n.item_id
    loop
      perform pg_advisory_xact_lock(hashtextextended(o.restaurant_id::text || need.item_id::text, 9));
      if need.keep_selling then continue; end if;
      available := coalesce((select on_hand from public.stock_balances where location_id = location and item_id = need.item_id), 0)
        - coalesce((select c.quantity from private.branch_committed(o.restaurant_id) c where c.item_id = need.item_id), 0);
      if available < 0 then
        raise exception 'Sold out: % (not enough % left).', need.menu_name,
          (select name from public.stock_items where id = need.item_id)
          using errcode = 'P0001', hint = 'stock_sold_out', detail = need.item_id::text;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

-- Availability of each tracked dish at a branch. One row per dish: the limiting ingredient (fewest dishes left),
-- its quantity per dish and what is available of it. sold_out: any ingredient is short (unless the dish keeps selling).
create or replace function public.stock_menu_availability(p_restaurant uuid)
returns table (menu_item_id uuid, item_id uuid, servings numeric, available numeric, allow_when_out boolean, sold_out boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if auth.uid() is not null and not private.is_restaurant_member(p_restaurant) then
    raise exception 'Not a member of this restaurant.' using errcode = '42501';
  end if;
  return query
    with held as (select * from private.branch_committed(p_restaurant)),
    ing as (
      select d.menu_item_id, d.item_id, d.quantity, d.allow_when_out,
             coalesce(b.on_hand, 0) - coalesce(h.quantity, 0) as available
        from private.dish_ingredients d
        left join public.stock_locations l on l.restaurant_id = d.restaurant_id
        left join public.stock_balances b on b.location_id = l.id and b.item_id = d.item_id
        left join held h on h.item_id = d.item_id
       where d.restaurant_id = p_restaurant),
    ranked as (
      select ing.*, row_number() over (partition by ing.menu_item_id order by ing.available / ing.quantity, ing.item_id) as rn,
             bool_or(ing.available < ing.quantity) over (partition by ing.menu_item_id) as any_short
        from ing)
    select r.menu_item_id, r.item_id, r.quantity, r.available, r.allow_when_out, (not r.allow_when_out and r.any_short)
      from ranked r where r.rn = 1;
end;
$$;

revoke all on function private.order_dish_needs(uuid), private.order_stock_needs(uuid), private.stock_check_new_lines()
  from public, anon, authenticated;
revoke all on function public.stock_menu_availability(uuid) from public, anon;
grant execute on function public.stock_menu_availability(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: reads only, like menu_item_stock.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['menu_item_recipes', 'menu_item_recipe_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;
grant select on public.menu_item_recipes, public.menu_item_recipe_lines to authenticated;
drop policy if exists menu_item_recipes_read on public.menu_item_recipes;
create policy menu_item_recipes_read on public.menu_item_recipes for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)) or (select private.oversees_branch(restaurant_id)));
drop policy if exists menu_item_recipe_lines_read on public.menu_item_recipe_lines;
create policy menu_item_recipe_lines_read on public.menu_item_recipe_lines for select to authenticated
  using (exists (select 1 from public.menu_item_recipes r where r.menu_item_id = menu_item_recipe_lines.menu_item_id
    and ((select private.is_restaurant_member(r.restaurant_id)) or (select private.oversees_branch(r.restaurant_id)))));

notify pgrst, 'reload schema';
