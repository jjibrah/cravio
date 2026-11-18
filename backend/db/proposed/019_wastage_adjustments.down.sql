-- Rollback for 019_wastage_adjustments.sql: drops reason codes, wastage (+ lines), stock adjustments, allowance usage and their guards, and puts
-- attachments' entity_type check back to the 016 list.
-- Refuses (and changes nothing) while any reason code, wastage record, adjustment or usage row exists, or any attachment of type wastage / adjustment:
-- export and clear them deliberately first. Apply the down files of anything that builds on 019 (later Phase 3 migrations) BEFORE this one.
do $$
declare
  t text;
  n bigint;
  problems text[] := '{}';
  names text[] := array['stock_reason_codes', 'wastage_records', 'wastage_record_lines', 'stock_adjustments', 'allowance_usage'];
begin
  foreach t in array names loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then problems := problems || format('%s %s', n, replace(t, '_', ' ')); end if;
    end if;
  end loop;
  if to_regclass('public.attachments') is not null then
    select count(*) into n from public.attachments where entity_type in ('wastage', 'adjustment');
    if n > 0 then problems := problems || format('%s wastage/adjustment attachments', n); end if;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 019: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

do $$
begin
  if to_regclass('public.attachments') is not null then
    alter table public.attachments drop constraint if exists attachments_entity_type_check;
    alter table public.attachments add constraint attachments_entity_type_check
      check (entity_type in ('po', 'grn', 'invoice', 'return', 'emergency', 'transfer', 'discrepancy'));
  end if;
end;
$$;

drop table if exists public.allowance_usage;
drop table if exists public.stock_adjustments;
drop table if exists public.wastage_record_lines;
drop table if exists public.wastage_records;
drop table if exists public.stock_reason_codes;
drop function if exists private.adjustment_guard();
drop function if exists private.wastage_line_guard();
drop function if exists private.wastage_guard();
drop function if exists private.reason_code_guard();

notify pgrst, 'reload schema';
