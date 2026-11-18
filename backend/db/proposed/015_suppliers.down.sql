-- Rollback for 015_suppliers.sql: drops the four tables 015 added.
-- Refuses (and changes nothing) while any supplier or document-number counter exists: export and clear them deliberately first.
-- Apply the down files of anything that references suppliers (016 purchasing and later) BEFORE this one; dropping a table that
-- another table still points at fails with a plain Postgres error and changes nothing.
do $$
declare
  n bigint;
  problems text[] := '{}';
begin
  if to_regclass('public.suppliers') is null and to_regclass('public.inventory_number_sequences') is null then return; end if;  -- 015 isn't applied

  if to_regclass('public.suppliers') is not null then
    execute 'select count(*) from public.suppliers' into n;
    if n > 0 then problems := problems || format('%s supplier(s)', n); end if;
  end if;
  if to_regclass('public.inventory_number_sequences') is not null then
    execute 'select count(*) from public.inventory_number_sequences' into n;
    if n > 0 then problems := problems || format('%s document number counter(s)', n); end if;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 015: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

drop trigger if exists supplier_prices_no_change on public.supplier_prices;
drop table if exists public.supplier_prices;
drop table if exists public.supplier_items;
drop table if exists public.suppliers;
drop table if exists public.inventory_number_sequences;
drop function if exists private.supplier_price_guard();

notify pgrst, 'reload schema';
