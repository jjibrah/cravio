-- 008 (PROPOSED, NOT APPLIED): businesses, branches and business-level access grants.
--
-- Lives in db/proposed/ so `npm run db:migrate` cannot apply it by accident. After review it moves to
-- db/migrations/ unchanged. See docs/v2/MIGRATION-008.md for the account mapping, compatibility checks
-- and recovery plan, and 008_business_branches.down.sql for the rollback.
--
-- Model
-- * A restaurant row IS a branch. Every restaurant/menu/table/order id, owner_id and guest QR link stays.
-- * public.businesses groups branches. Each existing restaurant gets its own business (named after it).
--   Restaurants are never grouped by name, email domain or owner here: grouping is a reviewed mapping.
-- * restaurant_members keeps branch roles exactly as today (owner | manager | waiter). The v2 app treats
--   a branch 'owner' or 'manager' membership as branch-manager access; it no longer implies business access.
-- * public.business_members is the NEW business-level grant: 'owner' (actual business owner, all branches)
--   or 'operations' (delegated operations manager, only branches listed in business_member_branches).
--   This migration grants nobody anything. Grants come from the reviewed mapping (scripts/apply-access-mapping.js)
--   or from explicit actions in the app.
-- * Compatibility with the main baseline sharing this database: main never sets business_id or owner_primary,
--   so a trigger fills business_id, and owner_primary defaults to true, which keeps main's
--   "one restaurant per owner" conflict (23505) behaviour for every restaurant main creates.
--
-- Idempotent: every statement can be re-run.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Businesses
-- ---------------------------------------------------------------------------
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists businesses_touch on public.businesses;
create trigger businesses_touch before update on public.businesses
  for each row execute function private.touch_updated_at();

alter table public.restaurants add column if not exists business_id uuid references public.businesses(id) on delete restrict;
-- true for a restaurant created through the legacy one-restaurant-per-owner flow (main, onboarding);
-- false for additional branches a business creates. Only owner_primary rows are unique per owner.
alter table public.restaurants add column if not exists owner_primary boolean not null default true;

-- Every restaurant without a business gets its own, named after it. Runs for main-created rows too.
create or replace function private.restaurant_default_business()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.business_id is null then
    insert into public.businesses (name, created_by) values (left(btrim(new.name), 120), new.owner_id)
      returning id into new.business_id;
  end if;
  return new;
end;
$$;
revoke all on function private.restaurant_default_business() from public, anon, authenticated;
drop trigger if exists restaurants_default_business on public.restaurants;
create trigger restaurants_default_business before insert on public.restaurants
  for each row execute function private.restaurant_default_business();

-- Backfill: one business per existing restaurant, created in restaurant order so ids are stable per run.
do $$
declare
  r record;
  b uuid;
begin
  for r in select id, name, owner_id from public.restaurants where business_id is null order by created_at, id loop
    insert into public.businesses (name, created_by) values (left(btrim(r.name), 120), r.owner_id) returning id into b;
    update public.restaurants set business_id = b where id = r.id;
  end loop;
end;
$$;
alter table public.restaurants alter column business_id set not null;
create index if not exists restaurants_business_idx on public.restaurants (business_id);
-- Lets grant rows prove that a branch belongs to the business they name.
create unique index if not exists restaurants_id_business on public.restaurants (id, business_id);

-- One legacy restaurant per owner, as before; additional business branches are exempt.
create unique index if not exists restaurants_one_primary_per_owner on public.restaurants (owner_id) where owner_primary;
drop index if exists public.restaurants_one_per_owner;

-- ---------------------------------------------------------------------------
-- Business-level grants
-- ---------------------------------------------------------------------------
create table if not exists public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'operations')),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index if not exists business_members_user_idx on public.business_members (user_id);

-- Branches an operations manager oversees. Owners see every branch of their business and need no rows.
create table if not exists public.business_member_branches (
  business_id uuid not null,
  user_id uuid not null,
  restaurant_id uuid not null,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, restaurant_id),
  foreign key (business_id, user_id) references public.business_members (business_id, user_id) on delete cascade,
  foreign key (restaurant_id, business_id) references public.restaurants (id, business_id) on delete cascade
);
create index if not exists business_member_branches_business_idx on public.business_member_branches (business_id, user_id);

-- Append-only record of access changes (grants, revocations, branch creation).
create table if not exists public.access_events (
  id bigint generated always as identity primary key,
  business_id uuid references public.businesses(id) on delete set null,
  restaurant_id uuid references public.restaurants(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  subject_id uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'business_grant', 'business_revoke', 'branch_assign', 'branch_unassign',
    'branch_create', 'branch_member_add', 'branch_member_remove', 'mapping_applied')),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists access_events_business_idx on public.access_events (business_id, created_at desc);

create or replace function private.access_events_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Access events are append-only.' using errcode = '42501';
end;
$$;
revoke all on function private.access_events_append_only() from public, anon, authenticated;
drop trigger if exists access_events_no_change on public.access_events;
create trigger access_events_no_change before update or delete on public.access_events
  for each row execute function private.access_events_append_only();

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER, answer only for auth.uid(), like 002's helpers)
-- ---------------------------------------------------------------------------
create or replace function private.business_role(target uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.business_members where business_id = target and user_id = (select auth.uid())
$$;

-- True when the caller oversees this branch at business level (owner of its business, or assigned operations).
create or replace function private.oversees_branch(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.restaurants r
    join public.business_members m on m.business_id = r.business_id and m.user_id = (select auth.uid())
    where r.id = target and (m.role = 'owner' or exists (
      select 1 from public.business_member_branches b where b.user_id = m.user_id and b.restaurant_id = r.id))
  )
$$;
revoke all on function private.business_role(uuid) from public, anon;
revoke all on function private.oversees_branch(uuid) from public, anon;
grant execute on function private.business_role(uuid) to authenticated;
grant execute on function private.oversees_branch(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: browser clients may read their own grants and their businesses. All writes are server-only
-- (the API checks the caller's grant in code, then writes with the service role).
-- ---------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.business_member_branches enable row level security;
alter table public.access_events enable row level security;
revoke all on public.businesses, public.business_members, public.business_member_branches, public.access_events
  from public, anon, authenticated;
grant all on public.businesses, public.business_members, public.business_member_branches, public.access_events to service_role;

grant select on public.businesses, public.business_members, public.business_member_branches to authenticated;
drop policy if exists businesses_read on public.businesses;
create policy businesses_read on public.businesses for select to authenticated
  using ((select private.business_role(id)) is not null);
drop policy if exists business_members_read on public.business_members;
create policy business_members_read on public.business_members for select to authenticated
  using (user_id = (select auth.uid()) or (select private.business_role(business_id)) = 'owner');
drop policy if exists business_member_branches_read on public.business_member_branches;
create policy business_member_branches_read on public.business_member_branches for select to authenticated
  using (user_id = (select auth.uid()) or (select private.business_role(business_id)) = 'owner');
-- access_events: no browser grant; read through the API only.

-- The business_id/owner_primary columns are not browser-writable: 002 granted update on a column list,
-- which does not include them, so nothing to revoke.

notify pgrst, 'reload schema';
