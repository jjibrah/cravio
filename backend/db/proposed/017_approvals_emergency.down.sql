-- Rollback for 017_approvals_emergency.sql: drops approval rules, approvals, emergency purchases (and lines) and their guard functions.
-- Refuses (and changes nothing) while any rule, approval or emergency purchase exists: export and clear them deliberately first.
-- Apply the down files of anything that builds on 017 (018 distribution, Phase 3) BEFORE this one.
do $$
declare
  t text;
  n bigint;
  problems text[] := '{}';
  names text[] := array['approval_rules', 'approvals', 'emergency_purchases'];
begin
  if to_regclass('public.approvals') is null and to_regclass('public.emergency_purchases') is null and to_regclass('public.approval_rules') is null then return; end if;  -- 017 isn't applied
  foreach t in array names loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then problems := problems || format('%s %s', n, replace(t, '_', ' ')); end if;
    end if;
  end loop;
  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 017: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

drop table if exists public.emergency_purchase_lines;
drop table if exists public.emergency_purchases;
drop table if exists public.approvals;
drop table if exists public.approval_rules;
drop function if exists private.approval_guard();
drop function if exists private.emergency_guard();
drop function if exists private.emergency_line_guard();

notify pgrst, 'reload schema';
