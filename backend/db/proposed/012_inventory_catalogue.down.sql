-- Rollback for 012_inventory_catalogue.sql: returns the schema to exactly what 009 defined.
-- Refuses (and changes nothing) while anything exists that only 012 can hold: items not counted in servings, catalogue
-- data (categories, own units, barcodes, levels, settings, audit events, exceptions), new item/location columns in use,
-- movements using a new reason or new column, inventory switched on, or quantities that would not fit numeric(12,3).
-- Export and clear those deliberately first. Orders, menus and 009 stock rows are never touched.
do $$
declare
  n bigint;
  problems text[] := '{}';
begin
  if to_regclass('public.units') is null then return; end if;  -- 012 isn't applied

  select count(*) into n from public.stock_items where unit <> 'serving';
  if n > 0 then problems := problems || format('%s item(s) are not counted in servings', n); end if;
  select count(*) into n from public.stock_items where sku is not null or category_id is not null or kind <> 'raw' or storage is not null
    or yield_pct <> 100 or display_unit is not null or avg_cost is not null or last_cost is not null or vat_class <> 'standard'
    or notes is not null or archived_at is not null;
  if n > 0 then problems := problems || format('%s item(s) use new catalogue fields (sku, category, kind, cost, archive...)', n); end if;
  select count(*) into n from public.stock_categories; if n > 0 then problems := problems || format('%s stock categories', n); end if;
  select count(*) into n from public.stock_item_units; if n > 0 then problems := problems || format('%s item units', n); end if;
  select count(*) into n from public.stock_item_barcodes; if n > 0 then problems := problems || format('%s barcodes', n); end if;
  select count(*) into n from public.stock_item_levels; if n > 0 then problems := problems || format('%s stock levels', n); end if;
  select count(*) into n from public.inventory_settings; if n > 0 then problems := problems || format('%s inventory settings', n); end if;
  select count(*) into n from public.inventory_events; if n > 0 then problems := problems || format('%s audit events', n); end if;
  select count(*) into n from public.stock_exceptions; if n > 0 then problems := problems || format('%s stock exceptions', n); end if;
  select count(*) into n from public.stock_locations where kind = 'warehouse' or code is not null or status <> 'active' or archived_at is not null;
  if n > 0 then problems := problems || format('%s location(s) use warehouse/code/status', n); end if;
  select count(*) into n from public.businesses where inventory_enabled;
  if n > 0 then problems := problems || format('inventory is switched on for %s business(es)', n); end if;
  select count(*) into n from public.stock_movements
   where reason not in ('count', 'added', 'waste', 'served', 'order_correction', 'dispatched', 'received', 'lost_in_transit', 'dispatch_cancelled')
      or unit_cost is not null or value is not null or ref_type is not null or ref_id is not null or counterparty_location_id is not null
      or batch_id is not null or idempotency_key is not null or entered_quantity is not null or entered_unit is not null or reverses_movement_id is not null;
  if n > 0 then problems := problems || format('%s stock movement(s) use new reasons or columns', n); end if;
  select count(*) into n from public.stock_balances where reserved <> 0; if n > 0 then problems := problems || format('%s reserved balances', n); end if;

  -- Narrowing numeric(18,4) -> numeric(12,3) must lose nothing.
  select
    (select count(*) from public.stock_items where low_level <> round(low_level, 3) or low_level >= 1e9)
    + (select count(*) from public.stock_balances where on_hand <> round(on_hand, 3) or abs(on_hand) >= 1e9)
    + (select count(*) from public.stock_movements where delta <> round(delta, 3) or abs(delta) >= 1e9 or balance_after <> round(balance_after, 3) or abs(balance_after) >= 1e9)
    + (select count(*) from public.order_stock_effects where quantity <> round(quantity, 3) or quantity >= 1e9)
    + (select count(*) from public.stock_request_lines where requested <> round(requested, 3) or requested >= 1e9 or approved <> round(approved, 3) or approved >= 1e9)
    + (select count(*) from public.stock_transfer_lines where quantity <> round(quantity, 3) or quantity >= 1e9 or received <> round(received, 3) or received >= 1e9)
    into n;
  if n > 0 then problems := problems || format('%s quantity value(s) would not fit 3 decimal places', n); end if;

  if cardinality(problems) > 0 then
    raise exception 'Refusing rollback of 012: %. Export and clear them deliberately first.', array_to_string(problems, '; ');
  end if;
end;
$$;

drop trigger if exists stock_items_unit_guard on public.stock_items;
drop trigger if exists stock_movements_guard on public.stock_movements;
drop trigger if exists inventory_events_no_change on public.inventory_events;
drop function if exists private.stock_item_unit_guard();
drop function if exists private.stock_movement_guard();

drop table if exists public.stock_exceptions, public.inventory_events, public.inventory_settings, public.stock_item_levels,
  public.stock_item_barcodes, public.stock_item_units, public.units;

-- Ledger: drop new columns (their indexes and the idempotency index go with them), restore the 009 reason check.
drop index if exists public.stock_movements_idempotency, public.stock_movements_reversed_once, public.stock_movements_ref_idx, public.stock_movements_occurred_idx;
alter table public.stock_movements drop constraint if exists stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check check (reason in ('count', 'added', 'waste', 'served',
  'order_correction', 'dispatched', 'received', 'lost_in_transit', 'dispatch_cancelled'));
alter table public.stock_movements
  drop column if exists unit_cost, drop column if exists value, drop column if exists ref_type, drop column if exists ref_id,
  drop column if exists counterparty_location_id, drop column if exists batch_id, drop column if exists idempotency_key,
  drop column if exists occurred_at, drop column if exists entered_quantity, drop column if exists entered_unit, drop column if exists reverses_movement_id;

alter table public.stock_balances drop column if exists reserved;
alter table public.stock_items alter column low_level type numeric(12, 3);
alter table public.stock_balances alter column on_hand type numeric(12, 3);
alter table public.stock_movements alter column delta type numeric(12, 3), alter column balance_after type numeric(12, 3);
alter table public.order_stock_effects alter column quantity type numeric(12, 3);
alter table public.stock_request_lines alter column requested type numeric(12, 3), alter column approved type numeric(12, 3);
alter table public.stock_transfer_lines alter column quantity type numeric(12, 3), alter column received type numeric(12, 3);

-- Locations: restore the 009 kind check, drop the new columns.
drop index if exists public.stock_locations_code;
alter table public.stock_locations drop constraint if exists stock_locations_kind_check;
alter table public.stock_locations add constraint stock_locations_kind_check check (kind in ('center', 'branch'));
alter table public.stock_locations drop column if exists code, drop column if exists status, drop column if exists archived_at;

-- Items: restore the 009 unit check and table-wide select, drop the catalogue columns.
drop index if exists public.stock_items_sku, public.stock_items_category_idx;
alter table public.stock_items drop constraint if exists stock_items_category_fk;
alter table public.stock_items drop constraint if exists stock_items_unit_check;
alter table public.stock_items add constraint stock_items_unit_check check (unit in ('serving'));
alter table public.stock_items
  drop column if exists sku, drop column if exists category_id, drop column if exists kind, drop column if exists storage,
  drop column if exists yield_pct, drop column if exists display_unit, drop column if exists avg_cost, drop column if exists last_cost,
  drop column if exists vat_class, drop column if exists notes, drop column if exists archived_at, drop column if exists updated_at;
drop table if exists public.stock_categories;
revoke select on public.stock_items from authenticated;
grant select on public.stock_items to authenticated;

alter table public.businesses drop column if exists inventory_enabled;
notify pgrst, 'reload schema';
