-- 013 (PROPOSED, NOT APPLIED): versioned recipes, order stock snapshots, stop-at-zero serving with exceptions, stored notifications.
-- Requires 009 and 012. See docs/inventory-kb/07-implementation-plan.md (WP1.2), 08-phase1-workplan.md (P1-09) and the proven
-- design in docs/inventory-kb/spikes/order-snapshot/.
--
-- What changes
-- * A dish can have a RECIPE (several ingredients, quantities in each item's base unit, ONE dish before yield). Recipes are versioned:
--   saving changes writes a new version; a version that any order used can never change. Extras get their own ingredient lines.
-- * When an order line is inserted, what it needs is SNAPSHOTTED into order_stock_lines (dish, extras, deal components), with the
--   yield applied: qty = round(recipe_qty * factor / (yield_pct / 100), 4). The sold-out check, the hold on confirmed orders and the
--   deduction on serving all read the snapshot, so editing a recipe later never changes an order that was already taken.
-- * A dish WITHOUT a recipe still works through the 009 link (menu_item_stock) as a one-line recipe. 013 does NOT convert links into
--   recipes: `main` still edits menu_item_stock, and the fallback keeps both working. A dish that HAS a recipe ignores its link
--   (the link's keep-selling switch is still honoured).
-- * Serving never fails and a balance never goes below 0 through serving: it deducts what is on hand and records the shortfall in
--   stock_exceptions (012). Owners and the branch managers get a stored notification (notifications).
-- * takeaway_only recipe lines (packaging) are SKIPPED for now: orders have no dine-in/takeaway type yet. When one exists, snapshot
--   them only for takeaway orders (see private.dish_stock_lines).
--
-- SHARED DATABASE: `main`'s live order code runs the triggers replaced here. Contracts kept: function signatures, the error
-- (P0001, hint stock_sold_out, same message), the trigger names and events, movement reason 'served'. What differs for `main` is
-- listed in the P1-09 report (balances no longer go negative through serving; keep-selling is also honoured from recipes).
-- Idempotent: every statement can be re-run. Rollback: 013_inventory_recipes.down.sql (apply BEFORE 012's down).

create schema if not exists private;

do $$
begin
  if to_regclass('public.units') is null or to_regclass('public.stock_exceptions') is null then
    raise exception '013 needs migration 012 (inventory catalogue) first.';
  end if;
  -- notifications must not be someone else's table.
  if to_regclass('public.notifications') is not null and not exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notifications' and column_name = 'dedupe_key') then
    raise exception 'A table public.notifications already exists with a different shape; rename it or adapt 013 first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------

-- Lets menu_extra_recipe_lines tie an extra to its branch (composite FK, same pattern as 004).
create unique index if not exists menu_item_extras_id_restaurant on public.menu_item_extras (id, restaurant_id);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  restaurant_id uuid not null,
  menu_item_id uuid not null unique,
  current_version_id uuid,
  -- Keep selling this dish when an ingredient runs out (serving then records a stock exception).
  allow_when_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (restaurant_id, business_id) references public.restaurants (id, business_id) on delete cascade,
  foreign key (menu_item_id, restaurant_id) references public.menu_items (id, restaurant_id) on delete cascade
);
create index if not exists recipes_restaurant_idx on public.recipes (restaurant_id);

create table if not exists public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  recipe_id uuid not null,
  version integer not null check (version >= 1),
  note text check (char_length(note) <= 280),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (recipe_id, version),
  unique (id, recipe_id),
  unique (id, business_id),
  foreign key (recipe_id, business_id) references public.recipes (id, business_id) on delete cascade
);

-- recipes.current_version_id must be one of the recipe's own versions. Deferred so a recipe and its first version can be
-- written in one transaction.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recipes_current_version_fk' and conrelid = 'public.recipes'::regclass) then
    alter table public.recipes add constraint recipes_current_version_fk
      foreign key (current_version_id, id) references public.recipe_versions (id, recipe_id) deferrable initially deferred;
  end if;
end;
$$;

create table if not exists public.recipe_lines (
  business_id uuid not null,
  version_id uuid not null,
  item_id uuid not null,
  position integer not null default 0,
  -- Quantity of the item, in its BASE unit, for ONE dish, before yield.
  qty_base numeric(18, 4) not null check (qty_base > 0),
  entered_quantity numeric(18, 4),
  entered_unit text check (char_length(entered_unit) <= 30),
  -- Packaging etc. Not used yet: orders have no dine-in/takeaway type, so these lines are skipped (see header).
  takeaway_only boolean not null default false,
  primary key (version_id, item_id, position),
  foreign key (version_id, business_id) references public.recipe_versions (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);
create index if not exists recipe_lines_item_idx on public.recipe_lines (item_id);

create table if not exists public.menu_extra_recipe_lines (
  business_id uuid not null,
  restaurant_id uuid not null,
  extra_id uuid not null,
  item_id uuid not null,
  qty_base numeric(18, 4) not null check (qty_base > 0),
  entered_quantity numeric(18, 4),
  entered_unit text check (char_length(entered_unit) <= 30),
  primary key (extra_id, item_id),
  foreign key (extra_id, restaurant_id) references public.menu_item_extras (id, restaurant_id) on delete cascade,
  foreign key (restaurant_id, business_id) references public.restaurants (id, business_id) on delete cascade,
  foreign key (item_id, business_id) references public.stock_items (id, business_id) on delete cascade
);
create index if not exists menu_extra_recipe_lines_item_idx on public.menu_extra_recipe_lines (item_id);

-- ---------------------------------------------------------------------------
-- Order snapshot: what each order line needs, frozen when the line is inserted.
-- One row per (line, ingredient, source, origin): origin (ref_id) = dish id (dish, deal_component) or extra id (extra).
-- ---------------------------------------------------------------------------
create table if not exists public.order_stock_lines (
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  source text not null check (source in ('dish', 'extra', 'deal_component')),
  ref_id uuid not null,
  qty_base numeric(18, 4) not null check (qty_base > 0),
  -- Null when the need came from a 009 link. Set null only when a dish is deleted for good (see immutability below).
  recipe_version_id uuid references public.recipe_versions(id) on delete set null,
  menu_name text,
  primary key (order_item_id, item_id, source, ref_id)
);
create index if not exists order_stock_lines_item_idx on public.order_stock_lines (item_id);
create index if not exists order_stock_lines_version_idx on public.order_stock_lines (recipe_version_id) where recipe_version_id is not null;

-- ---------------------------------------------------------------------------
-- Stored notifications (read by the recipient; written by triggers and the API)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  location_id uuid,
  kind text not null check (char_length(kind) <= 40),
  title text not null check (char_length(title) <= 200),
  body text check (char_length(body) <= 1000),
  link text check (char_length(link) <= 300),
  entity_type text check (char_length(entity_type) <= 40),
  entity_id uuid,
  dedupe_key text check (char_length(dedupe_key) <= 200),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (location_id, business_id) references public.stock_locations (id, business_id) on delete cascade
);
create unique index if not exists notifications_dedupe on public.notifications (recipient_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (recipient_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- Recipe version immutability: a version that any order used cannot change (superseded_at may be set when a newer version
-- replaces it) or be deleted, and neither can its lines. Deleting a dish for good (cascade) is allowed: the dish is gone.
-- ---------------------------------------------------------------------------
create or replace function private.recipe_version_used(p_version uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.order_stock_lines where recipe_version_id = p_version)
$$;

create or replace function private.recipe_version_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if private.recipe_version_used(old.id) and (new.id, new.business_id, new.recipe_id, new.version, new.note, new.created_by, new.created_at)
      is distinct from (old.id, old.business_id, old.recipe_id, old.version, old.note, old.created_by, old.created_at) then
      raise exception 'This recipe version has been used by orders; save a new version instead.' using errcode = '23514', hint = 'recipe_version_used';
    end if;
    return new;
  end if;
  -- DELETE: refuse while the dish still exists; a cascade from deleting the dish finds the recipe (or the dish) already gone.
  if private.recipe_version_used(old.id) and exists (
    select 1 from public.recipes r join public.menu_items m on m.id = r.menu_item_id where r.id = old.recipe_id) then
    raise exception 'This recipe version has been used by orders; save a new version instead.' using errcode = '23514', hint = 'recipe_version_used';
  end if;
  return old;
end;
$$;
drop trigger if exists recipe_versions_guard on public.recipe_versions;
create trigger recipe_versions_guard before update or delete on public.recipe_versions
  for each row execute function private.recipe_version_guard();

create or replace function private.recipe_delete_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.recipe_versions v where v.recipe_id = old.id and private.recipe_version_used(v.id))
     and exists (select 1 from public.menu_items m where m.id = old.menu_item_id) then
    raise exception 'This recipe version has been used by orders; save a new version instead.' using errcode = '23514', hint = 'recipe_version_used';
  end if;
  return old;
end;
$$;
drop trigger if exists recipes_delete_guard on public.recipes;
create trigger recipes_delete_guard before delete on public.recipes
  for each row execute function private.recipe_delete_guard();

create or replace function private.recipe_line_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid := coalesce(new.version_id, old.version_id);
begin
  -- A version that is itself being deleted (cascade) has no row any more: nothing to protect.
  if exists (select 1 from public.recipe_versions where id = v) and private.recipe_version_used(v) then
    raise exception 'This recipe version has been used by orders; save a new version instead.' using errcode = '23514', hint = 'recipe_version_used';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists recipe_lines_guard on public.recipe_lines;
create trigger recipe_lines_guard before insert or update or delete on public.recipe_lines
  for each row execute function private.recipe_line_guard();

-- ---------------------------------------------------------------------------
-- Safe casts: bad ids or numbers inside order jsonb are skipped, they never abort an order.
-- ---------------------------------------------------------------------------
create or replace function private.safe_uuid(p text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

create or replace function private.safe_numeric(p text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  v := p::numeric;
  if v = 'NaN'::numeric then return null; end if;
  return v;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Snapshot
-- ---------------------------------------------------------------------------

-- What `p_factor` of a dish uses: its current recipe, else the 009 link as a one-line recipe (servings). Yield applied, 4 dp.
-- takeaway_only recipe lines are skipped (no order type yet).
create or replace function private.dish_stock_lines(p_menu_item uuid, p_factor numeric)
returns table (item_id uuid, qty_base numeric, recipe_version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  select r.current_version_id into v from public.recipes r where r.menu_item_id = p_menu_item and r.current_version_id is not null;
  if v is not null then
    return query select rl.item_id, round(sum(rl.qty_base) * p_factor / (si.yield_pct / 100), 4), v
      from public.recipe_lines rl join public.stock_items si on si.id = rl.item_id
      where rl.version_id = v and not rl.takeaway_only
      group by rl.item_id, si.yield_pct;
  else
    return query select mis.item_id, round(mis.servings * p_factor / (si.yield_pct / 100), 4), null::uuid
      from public.menu_item_stock mis join public.stock_items si on si.id = mis.item_id where mis.menu_item_id = p_menu_item;
  end if;
end;
$$;

-- Writes the snapshot of one order line (used by the trigger and by the back-fill).
create or replace function private.snapshot_order_line(p_line uuid, p_item uuid, p_kind text, p_name text, p_quantity numeric,
  p_extras jsonb, p_components jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c jsonb; x jsonb; cid uuid; cq numeric; eid uuid;
begin
  if p_item is not null and coalesce(p_kind, 'item') = 'item' then
    insert into public.order_stock_lines (order_item_id, item_id, source, ref_id, qty_base, recipe_version_id, menu_name)
      select p_line, d.item_id, 'dish', p_item, d.qty_base, d.recipe_version_id, p_name
        from private.dish_stock_lines(p_item, p_quantity) d where d.qty_base > 0
      on conflict (order_item_id, item_id, source, ref_id) do nothing;
  elsif p_kind = 'deal' and jsonb_typeof(p_components) = 'array' then
    for c in select e.value from jsonb_array_elements(p_components) e loop
      begin
        cid := private.safe_uuid(c ->> 'itemId');
        cq := coalesce(private.safe_numeric(c ->> 'quantity'), 1);
        continue when cid is null or cq <= 0;
        insert into public.order_stock_lines (order_item_id, item_id, source, ref_id, qty_base, recipe_version_id, menu_name)
          select p_line, d.item_id, 'deal_component', cid, d.qty_base, d.recipe_version_id, coalesce(c ->> 'name', p_name)
            from private.dish_stock_lines(cid, p_quantity * cq) d where d.qty_base > 0
          on conflict (order_item_id, item_id, source, ref_id)
            do update set qty_base = public.order_stock_lines.qty_base + excluded.qty_base;
      exception when others then
        null;  -- a malformed component is skipped; the order still goes through
      end;
    end loop;
  end if;
  if jsonb_typeof(p_extras) = 'array' then
    for x in select e.value from jsonb_array_elements(p_extras) e loop
      begin
        eid := private.safe_uuid(x ->> 'id');
        continue when eid is null;
        insert into public.order_stock_lines (order_item_id, item_id, source, ref_id, qty_base, menu_name)
          select p_line, l.item_id, 'extra', eid, round(l.qty_base * p_quantity / (si.yield_pct / 100), 4), coalesce(x ->> 'name', p_name)
            from public.menu_extra_recipe_lines l join public.stock_items si on si.id = l.item_id
           where l.extra_id = eid and p_quantity > 0
          on conflict (order_item_id, item_id, source, ref_id)
            do update set qty_base = public.order_stock_lines.qty_base + excluded.qty_base;
      exception when others then
        null;
      end;
    end loop;
  end if;
end;
$$;

-- Row-level AFTER INSERT. Postgres fires every row-level AFTER trigger of a statement before any statement-level one, so this
-- always runs before order_items_stock_check (009), whatever the names. The a_ prefix is belt and braces. A test proves the order.
create or replace function private.order_items_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.snapshot_order_line(new.id, new.item_id, new.kind, new.name, new.quantity, new.extras, new.components);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Same signatures as 009, now reading the snapshot
-- ---------------------------------------------------------------------------
create or replace function private.order_stock_needs(p_order uuid)
returns table (order_item_id uuid, item_id uuid, quantity numeric, menu_name text)
language sql stable security definer set search_path = '' as $$
  select s.order_item_id, s.item_id, sum(s.qty_base), min(s.menu_name)
    from public.order_items oi join public.order_stock_lines s on s.order_item_id = oi.id
   where oi.order_id = p_order
   group by s.order_item_id, s.item_id
$$;

create or replace function private.branch_committed(p_restaurant uuid)
returns table (item_id uuid, quantity numeric)
language sql stable security definer set search_path = '' as $$
  select s.item_id, sum(s.qty_base)
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.order_stock_lines s on s.order_item_id = oi.id
   where o.restaurant_id = p_restaurant and o.status in ('taken', 'accepted')
   group by s.item_id
$$;

-- Refuse new order lines that need more than is available, unless the dish keeps selling when out (recipe OR 009 link switch).
-- Statement-level, after insert, advisory lock per branch and item held to commit: exactly as 009.
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
             bool_or(coalesce(r.allow_when_out, false) or coalesce(mis.allow_when_out, false)) as keep_selling
        from public.order_items oi
        join public.order_stock_lines s on s.order_item_id = oi.id
        left join public.recipes r on r.menu_item_id = case when s.source = 'extra' then oi.item_id else s.ref_id end
        left join public.menu_item_stock mis on mis.menu_item_id = case when s.source = 'extra' then oi.item_id else s.ref_id end
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

-- Availability of each tracked dish at a branch (recipe, else 009 link): per dish, the LIMITING ingredient (lowest available / need).
-- Columns as 009: servings = what ONE dish needs of that ingredient (yield applied); available = on hand minus held by unserved
-- orders, in the ingredient's base unit (can be negative when keep-selling dishes overdrew); sold_out = available < servings.
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
             coalesce(b.on_hand, 0) - coalesce(h.quantity, 0) as avail
        from need n
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

-- ---------------------------------------------------------------------------
-- Notifications: who gets told, and how quantities read
-- ---------------------------------------------------------------------------
create or replace function private.stock_alert_recipients(p_business uuid, p_restaurant uuid)
returns table (user_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.user_id from public.business_members m where m.business_id = p_business and m.role = 'owner'
  union
  select rm.user_id from public.restaurant_members rm where rm.restaurant_id = p_restaurant and rm.role in ('owner', 'manager')
$$;

-- "0.6 kg", "3 crates", "12 g": in the item's display unit when it has one, else its base unit.
create or replace function private.stock_fmt_qty(p_item uuid, p_qty numeric)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  i record; f numeric; du record; bu record; v numeric;
begin
  select unit, display_unit into i from public.stock_items where id = p_item;
  if not found then return trim_scale(round(p_qty, 2))::text; end if;
  select to_base, label, plural, dimension into bu from public.units where code = i.unit;
  if i.display_unit is not null then
    select u.factor into f from public.stock_item_units u where u.item_id = p_item and lower(btrim(u.name)) = lower(btrim(i.display_unit)) limit 1;
    if f is not null then
      v := round(p_qty / f, 2);
      return trim_scale(v)::text || ' ' || i.display_unit;
    end if;
    select u.to_base, u.label, u.plural into du from public.units u where u.code = i.display_unit and u.dimension = bu.dimension;
    if found then
      v := round(p_qty * bu.to_base / du.to_base, 2);
      return trim_scale(v)::text || ' ' || case when v = 1 then du.label else du.plural end;
    end if;
  end if;
  v := round(p_qty, 2);
  return trim_scale(v)::text || ' ' || coalesce(case when v = 1 then bu.label else bu.plural end, i.unit);
end;
$$;

create or replace function private.stock_notify(p_business uuid, p_location uuid, p_item uuid, p_kind text, p_title text, p_body text,
  p_entity_type text, p_entity_id uuid, p_dedupe text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  branch uuid;
  link text;
begin
  select restaurant_id into branch from public.stock_locations where id = p_location;
  link := case when branch is not null then '/branch/' || branch::text || '/inventory' else '/owner/inventory' end;
  insert into public.notifications (business_id, recipient_id, location_id, kind, title, body, link, entity_type, entity_id, dedupe_key)
    select p_business, r.user_id, p_location, p_kind, p_title, p_body, link, p_entity_type, p_entity_id, p_dedupe
      from private.stock_alert_recipients(p_business, branch) r
    on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

-- An item hit zero at a location: tell owners and the branch's managers, once per recipient, item, location and day (Nairobi).
create or replace function private.stock_out_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  biz uuid; loc_name text; item_name text; day text;
begin
  begin
    select business_id, name into biz, loc_name from public.stock_locations where id = new.location_id;
    select name into item_name from public.stock_items where id = new.item_id;
    day := to_char((now() at time zone 'Africa/Nairobi')::date, 'YYYY-MM-DD');
    perform private.stock_notify(biz, new.location_id, new.item_id, 'stock_out',
      item_name || ' ran out at ' || loc_name,
      'There is none left at ' || loc_name || '. Dishes that use ' || item_name || ' show as sold out until you record a delivery or count it.',
      'stock_item', new.item_id, 'stock_out:' || new.location_id::text || ':' || new.item_id::text || ':' || day);
  exception when others then
    null;  -- a notification problem must never stop an order or a count
  end;
  return null;
end;
$$;
drop trigger if exists stock_balances_stock_out on public.stock_balances;
create trigger stock_balances_stock_out after update of on_hand on public.stock_balances
  for each row when (old.on_hand > 0 and new.on_hand <= 0) execute function private.stock_out_notify();

-- A dish was served without enough stock: tell the same people, once per exception.
create or replace function private.stock_exception_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  loc_name text; item_name text;
begin
  begin
    select name into loc_name from public.stock_locations where id = new.location_id;
    select name into item_name from public.stock_items where id = new.item_id;
    perform private.stock_notify(new.business_id, new.location_id, new.item_id, 'stock_exception',
      item_name || ' was short at ' || loc_name,
      '1 order was served without enough ' || item_name || ' (' || private.stock_fmt_qty(new.item_id, new.short_qty) || ' short). Count it or record a delivery.',
      'stock_exception', new.id, 'stock_exception:' || new.id::text);
  exception when others then
    null;
  end;
  return null;
end;
$$;
drop trigger if exists stock_exceptions_notify on public.stock_exceptions;
create trigger stock_exceptions_notify after insert on public.stock_exceptions
  for each row execute function private.stock_exception_notify();

-- ---------------------------------------------------------------------------
-- Serving: deduct what is there, record what is not. Serving never fails; on_hand never goes below 0 through serving.
-- Runs once per order line and ingredient (order_stock_effects is keyed that way), so a replay changes nothing.
-- The effect row stores what the line NEEDED; the movement holds what was actually deducted (none when stock was 0).
-- ---------------------------------------------------------------------------
create or replace function private.stock_on_serve()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  need record;
  location uuid;
  biz uuid;
  balance numeric;
  deducted numeric;
  after_qty numeric;
  cost numeric;
  movement bigint;
begin
  if not exists (select 1 from private.order_stock_needs(new.id)) then return null; end if;
  location := private.branch_location(new.restaurant_id);
  select business_id into biz from public.stock_locations where id = location;
  for need in select * from private.order_stock_needs(new.id) order by item_id, order_item_id loop
    if exists (select 1 from public.order_stock_effects e where e.order_item_id = need.order_item_id and e.item_id = need.item_id) then continue; end if;
    insert into public.stock_balances (location_id, item_id, on_hand) values (location, need.item_id, 0) on conflict do nothing;
    select b.on_hand into balance from public.stock_balances b where b.location_id = location and b.item_id = need.item_id for update;
    deducted := least(need.quantity, greatest(balance, 0));
    movement := null;
    if deducted > 0 then
      select avg_cost into cost from public.stock_items where id = need.item_id;
      update public.stock_balances set on_hand = on_hand - deducted, updated_at = now()
        where location_id = location and item_id = need.item_id returning on_hand into after_qty;
      insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, actor_id, order_id, unit_cost, value, ref_type, ref_id)
        values (biz, location, need.item_id, -deducted, after_qty, 'served', new.served_by, new.id,
          cost, case when cost is null then null else round(-deducted * cost, 2) end, 'order_item', need.order_item_id)
        returning id into movement;
    end if;
    insert into public.order_stock_effects (order_item_id, item_id, location_id, quantity, movement_id)
      values (need.order_item_id, need.item_id, location, need.quantity, movement);
    if deducted < need.quantity then
      insert into public.stock_exceptions (business_id, location_id, item_id, order_id, order_item_id, kind, short_qty)
        values (biz, location, need.item_id, new.id, need.order_item_id, 'unfulfilled_consumption', need.quantity - deducted);
    end if;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers on order_items, created once. First run only: back-fill snapshots for orders still open (taken/accepted), so
-- confirmed orders keep holding stock and deduct on serving. The trigger is created first so no line is missed in between.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.order_items'::regclass and tgname = 'order_items_a_snapshot') then
    create trigger order_items_a_snapshot after insert on public.order_items
      for each row execute function private.order_items_snapshot();
    perform private.snapshot_order_line(oi.id, oi.item_id, oi.kind, oi.name, oi.quantity, oi.extras, oi.components)
      from public.order_items oi join public.orders o on o.id = oi.order_id
     where o.status in ('taken', 'accepted')
       and not exists (select 1 from public.order_stock_lines s where s.order_item_id = oi.id);
  end if;
end;
$$;

revoke all on function private.recipe_version_used(uuid), private.recipe_version_guard(), private.recipe_delete_guard(), private.recipe_line_guard(),
  private.safe_uuid(text), private.safe_numeric(text), private.dish_stock_lines(uuid, numeric),
  private.snapshot_order_line(uuid, uuid, text, text, numeric, jsonb, jsonb), private.order_items_snapshot(),
  private.order_stock_needs(uuid), private.branch_committed(uuid), private.stock_check_new_lines(), private.stock_on_serve(),
  private.stock_alert_recipients(uuid, uuid), private.stock_fmt_qty(uuid, numeric),
  private.stock_notify(uuid, uuid, uuid, text, text, text, text, uuid, text), private.stock_out_notify(), private.stock_exception_notify()
  from public, anon, authenticated;
revoke all on function public.stock_menu_availability(uuid) from public, anon;
grant execute on function public.stock_menu_availability(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: reads only. Recipes are readable by the branch's members and by the people who oversee the branch; extra lines too.
-- Notifications: only their recipient. Snapshots are API-only.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['recipes', 'recipe_versions', 'recipe_lines', 'menu_extra_recipe_lines', 'order_stock_lines', 'notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;
grant select on public.recipes, public.recipe_versions, public.recipe_lines, public.menu_extra_recipe_lines, public.notifications to authenticated;

drop policy if exists recipes_read on public.recipes;
create policy recipes_read on public.recipes for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)) or (select private.oversees_branch(restaurant_id)));
drop policy if exists recipe_versions_read on public.recipe_versions;
create policy recipe_versions_read on public.recipe_versions for select to authenticated
  using (exists (select 1 from public.recipes r where r.id = recipe_versions.recipe_id));
drop policy if exists recipe_lines_read on public.recipe_lines;
create policy recipe_lines_read on public.recipe_lines for select to authenticated
  using (exists (select 1 from public.recipe_versions v where v.id = recipe_lines.version_id));
drop policy if exists menu_extra_recipe_lines_read on public.menu_extra_recipe_lines;
create policy menu_extra_recipe_lines_read on public.menu_extra_recipe_lines for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)) or (select private.oversees_branch(restaurant_id)));
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));

notify pgrst, 'reload schema';
