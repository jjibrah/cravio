-- Rollback for 016_purchasing.sql: drops the eight purchasing tables and their guard functions.
-- Refuses (and changes nothing) while any purchase order, receipt, invoice, return or attachment exists: export and clear them deliberately first.
-- Apply the down files of anything that builds on 016 (017 emergency + approvals, 018 distribution, Phase 3) BEFORE this one.
do $$
declare
  t text;
  n bigint;
  problems text[] := '{}';
  names text[] := array['purchase_orders', 'goods_receipts', 'supplier_invoices', 'supplier_returns', 'attachments'];
begin
  if to_regclass('public.purchase_orders') is null and to_regclass('public.attachments') is null then return; end if;  -- 016 isn't applied
  foreach t in array names loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then problems := problems || format('%s %s', n, replace(t, '_', ' ')); end if;
    end if;
  end loop;
  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 016: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

drop table if exists public.supplier_return_lines;
drop table if exists public.supplier_returns;
drop table if exists public.grn_lines;
drop table if exists public.goods_receipts;
drop table if exists public.supplier_invoices;
drop table if exists public.po_lines;
drop table if exists public.purchase_orders;
drop table if exists public.attachments;
drop function if exists private.po_guard();
drop function if exists private.po_line_guard();
drop function if exists private.grn_guard();
drop function if exists private.grn_line_guard();
drop function if exists private.return_guard();
drop function if exists private.return_line_guard();
drop function if exists private.attachment_guard();

notify pgrst, 'reload schema';
