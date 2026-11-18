-- Rollback for 020_counts.sql: drops stock counts, their lines and entries and their guards.
-- Refuses (and changes nothing) while any count, line or entry exists: a count is part of the stock history (its corrections are in the ledger).
-- Export and clear them deliberately first. Apply the down files of anything that builds on 020 (later Phase 3 migrations) BEFORE this one.
do $$
declare
  t text;
  n bigint;
  problems text[] := '{}';
  names text[] := array['stock_counts', 'stock_count_lines', 'stock_count_entries'];
begin
  foreach t in array names loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then problems := problems || format('%s %s', n, replace(t, '_', ' ')); end if;
    end if;
  end loop;
  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 020: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

drop table if exists public.stock_count_entries cascade;
drop table if exists public.stock_count_lines cascade;
drop table if exists public.stock_counts cascade;
drop function if exists private.count_entries_guard();
drop function if exists private.count_line_guard();
drop function if exists private.count_guard();

notify pgrst, 'reload schema';
