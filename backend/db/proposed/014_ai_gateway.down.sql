-- Rollback for 014_ai_gateway.sql: drops the AI tables and their guard.
-- Refuses (and changes nothing) while any usage row, allowance row or enabled business exists: export them and switch AI off deliberately first.
do $$
declare
  n bigint;
  problems text[] := '{}';
begin
  if to_regclass('public.ai_usage') is null then return; end if;  -- 014 isn't applied
  select count(*) into n from public.ai_usage; if n > 0 then problems := problems || format('%s AI usage record(s)', n); end if;
  select count(*) into n from public.ai_limits; if n > 0 then problems := problems || format('%s AI allowance(s)', n); end if;
  select count(*) into n from public.ai_business_settings; if n > 0 then problems := problems || format('%s AI setting row(s)', n); end if;
  if array_length(problems, 1) > 0 then
    raise exception 'Refusing rollback of 014: % exist. Export and clear them deliberately first.', array_to_string(problems, ', ');
  end if;
end;
$$;

drop table if exists public.ai_business_settings;
drop table if exists public.ai_limits;
drop trigger if exists ai_usage_no_change on public.ai_usage;
drop table if exists public.ai_usage;
drop function if exists private.ai_usage_guard();
