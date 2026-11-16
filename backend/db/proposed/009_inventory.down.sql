-- Rollback for 009_inventory.sql. Removes inventory triggers, functions and tables.
-- Refuses while any stock history exists (export it first; see docs/v2/INVENTORY.md). Orders, menus and
-- restaurants are never touched: dropping the triggers only stops stock checks/deductions.
do $$
begin
  if to_regclass('public.stock_movements') is null then return; end if;
  if exists (select 1 from public.stock_movements) or exists (select 1 from public.stock_requests) then
    raise exception 'Refusing rollback: stock history or requests exist. Export and clear them deliberately first.';
  end if;
end;
$$;
drop trigger if exists order_items_stock_check on public.order_items;
drop trigger if exists orders_stock_on_serve on public.orders;
drop function if exists public.stock_menu_availability(uuid);
drop table if exists public.order_stock_effects, public.stock_commands, public.stock_movements, public.stock_transfer_lines,
  public.stock_transfers, public.stock_request_lines, public.stock_requests, public.menu_item_stock, public.stock_balances,
  public.stock_locations, public.stock_items;
drop function if exists private.stock_on_serve();
drop function if exists private.stock_check_new_lines();
drop function if exists private.branch_committed(uuid);
drop function if exists private.order_stock_needs(uuid);
drop function if exists private.branch_location(uuid);
drop function if exists private.stock_append_only();
notify pgrst, 'reload schema';
