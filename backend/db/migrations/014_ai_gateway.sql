-- 014 (PROPOSED, NOT APPLIED): AI gateway metering, per-business allowance and switches.
-- Design: docs/inventory-kb/12-ai-insights.md §2.1; ticket P2-32 in 09-phase2-workplan.md.
--
-- What changes (all NEW tables; nothing `main` reads is touched, so `main`'s code is unaffected):
-- * ai_usage             one row per AI provider attempt (and per cached answer / refused call). Tokens, estimated cost, status. NEVER the
--                        prompt or the answer. Insert-only: a row can't be deleted, and the only update allowed is settling a
--                        'reserved' row (the gateway reserves the worst-case cost before calling the provider, then fills in the truth).
-- * ai_limits            the monthly allowance in KES set by the platform admin, an optional LOWER figure set by the owner, warn %.
--                        No row = AI is off for that business.
-- * ai_business_settings on/off for the business, per-feature switches (admin), features the owner switched off, model overrides.
-- RLS is on with no policies and no grants for anon/authenticated: the API (service role) is the only reader and writer.
-- Independent of 015-018. Needs only `businesses` and `auth.users`. Idempotent. Rollback: 014_ai_gateway.down.sql.

create schema if not exists private;

do $$
begin
  if to_regclass('public.businesses') is null then
    raise exception '014 needs migration 008 (businesses) first.';
  end if;
end;
$$;

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  -- No foreign keys on purpose (same as inventory_events): usage history must outlive people, and the guard below blocks cascades.
  business_id uuid not null,
  feature text not null check (char_length(feature) between 1 and 40),
  user_id uuid,
  model text check (char_length(model) <= 120),
  prompt_tokens integer check (prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  cost_kes numeric(12, 4) not null default 0 check (cost_kes >= 0),
  fx_rate numeric(10, 4) check (fx_rate > 0),
  status text not null check (status in ('reserved', 'ok', 'cached', 'error', 'rejected', 'blocked')),
  error_code text check (char_length(error_code) <= 60),
  request_id text check (char_length(request_id) <= 120),
  latency_ms integer check (latency_ms >= 0),
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_business_idx on public.ai_usage (business_id, created_at);

create or replace function private.ai_usage_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'AI usage records can''t be deleted.' using errcode = '23514', hint = 'ai_usage_append_only';
  end if;
  -- UPDATE: only a reservation may be settled, and only its outcome columns may change.
  if old.status <> 'reserved' or new.status = 'reserved'
     or (new.id, new.business_id, new.feature, new.user_id, new.created_at) is distinct from (old.id, old.business_id, old.feature, old.user_id, old.created_at) then
    raise exception 'AI usage records can''t be changed.' using errcode = '23514', hint = 'ai_usage_append_only';
  end if;
  return new;
end;
$$;
drop trigger if exists ai_usage_no_change on public.ai_usage;
create trigger ai_usage_no_change before update or delete on public.ai_usage
  for each row execute function private.ai_usage_guard();

create table if not exists public.ai_limits (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  monthly_budget_kes numeric(12, 2) not null check (monthly_budget_kes >= 0),
  owner_budget_kes numeric(12, 2) check (owner_budget_kes >= 0),
  warn_pct integer not null default 80 check (warn_pct between 1 and 100),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  -- The owner may lower the allowance, never raise it.
  check (owner_budget_kes is null or owner_budget_kes <= monthly_budget_kes)
);

create table if not exists public.ai_business_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  enabled boolean not null default false,
  -- Per-feature switches set by the admin: { "recipe_draft": false } turns one off; a missing key means on.
  features jsonb not null default '{}'::jsonb check (jsonb_typeof(features) = 'object'),
  -- Features the owner switched off for their own business: ["recipe_draft"].
  features_owner_off jsonb not null default '[]'::jsonb check (jsonb_typeof(features_owner_off) = 'array'),
  model_overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(model_overrides) = 'object'),
  daily_insights_time time not null default '06:00',
  updated_by uuid,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['ai_usage', 'ai_limits', 'ai_business_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;
