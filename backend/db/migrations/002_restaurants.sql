-- 002: restaurants, membership, floor, menu, staff invites, onboarding progress, media bucket.
-- Owned by the onboarding work. Safe to run once on top of schema.sql (and 001, which it doesn't depend on).
-- Every statement is idempotent so a partial manual run can be repeated.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest.
-- ---------------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.touch_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Restaurants. One per owner for now (a second location is a later feature).
-- ---------------------------------------------------------------------------
create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  kind text check (kind in ('restaurant', 'cafe', 'bar_grill', 'hotel', 'fast_food')),
  area text check (char_length(area) <= 120),
  address text check (char_length(address) <= 240),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  opening_hours jsonb check (opening_hours is null or jsonb_typeof(opening_hours) = 'object'),
  phone text check (char_length(phone) <= 32),
  logo_url text check (char_length(logo_url) <= 1024),
  cover_url text check (char_length(cover_url) <= 1024),
  theme text not null default 'classic' check (theme in ('classic', 'savanna', 'midnight', 'garden')),
  status text not null default 'onboarding' check (status in ('onboarding', 'live')),
  went_live_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists restaurants_one_per_owner on public.restaurants (owner_id);
drop trigger if exists restaurants_touch on public.restaurants;
create trigger restaurants_touch before update on public.restaurants
  for each row execute function private.touch_updated_at();

create table if not exists public.restaurant_members (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'waiter')),
  created_at timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);
create index if not exists restaurant_members_user_idx on public.restaurant_members (user_id);

-- ---------------------------------------------------------------------------
-- Membership helpers. SECURITY DEFINER so policies on restaurant_members (and
-- everything else) can check membership without recursing into their own RLS.
-- They live in the unexposed private schema and only answer for auth.uid().
-- ---------------------------------------------------------------------------
create or replace function private.restaurant_role(target uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.restaurant_members
  where restaurant_id = target and user_id = (select auth.uid())
$$;

create or replace function private.is_restaurant_member(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restaurant_members
    where restaurant_id = target and user_id = (select auth.uid()))
$$;

create or replace function private.can_manage_restaurant(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restaurant_members
    where restaurant_id = target and user_id = (select auth.uid()) and role in ('owner', 'manager'))
$$;

-- Storage object names look like '<restaurant_id>/<kind>/<file>'. Anything else is refused.
create or replace function private.can_manage_media(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  head text := split_part(object_name, '/', 1);
begin
  if head !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return private.can_manage_restaurant(head::uuid);
end;
$$;

revoke all on function private.restaurant_role(uuid) from public, anon;
revoke all on function private.is_restaurant_member(uuid) from public, anon;
revoke all on function private.can_manage_restaurant(uuid) from public, anon;
revoke all on function private.can_manage_media(text) from public, anon;
-- Policies run as the caller, so the caller needs to reach these four functions.
-- The private schema is not exposed through the Data API; nothing else in it is granted.
grant usage on schema private to authenticated;
grant execute on function private.restaurant_role(uuid) to authenticated;
grant execute on function private.is_restaurant_member(uuid) to authenticated;
grant execute on function private.can_manage_restaurant(uuid) to authenticated;
grant execute on function private.can_manage_media(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Floor: sections and tables.
-- ---------------------------------------------------------------------------
create table if not exists public.restaurant_sections (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists restaurant_sections_name on public.restaurant_sections (restaurant_id, lower(name));

create table if not exists public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  number integer not null check (number between 1 and 999),
  label text check (char_length(label) <= 40),
  section_id uuid references public.restaurant_sections(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (restaurant_id, number)
);

-- ---------------------------------------------------------------------------
-- Menu: categories and items.
-- ---------------------------------------------------------------------------
create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists menu_categories_name on public.menu_categories (restaurant_id, lower(name));
drop trigger if exists menu_categories_touch on public.menu_categories;
create trigger menu_categories_touch before update on public.menu_categories
  for each row execute function private.touch_updated_at();

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category_id uuid not null references public.menu_categories(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (char_length(description) <= 280),
  price numeric(10, 2) not null check (price >= 0),
  currency text not null default 'KES' check (currency ~ '^[A-Z]{3}$'),
  photo_url text check (char_length(photo_url) <= 1024),
  position integer not null default 0,
  available boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'template')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists menu_items_restaurant_idx on public.menu_items (restaurant_id, category_id, position);
drop trigger if exists menu_items_touch on public.menu_items;
create trigger menu_items_touch before update on public.menu_items
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Staff invites: queued during onboarding, sent by the server at go-live.
-- ---------------------------------------------------------------------------
create table if not exists public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (char_length(phone) <= 32),
  role text not null check (role in ('waiter', 'manager')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text check (char_length(error) <= 300),
  user_id uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists staff_invites_email on public.staff_invites (restaurant_id, email);
drop trigger if exists staff_invites_touch on public.staff_invites;
create trigger staff_invites_touch before update on public.staff_invites
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Onboarding progress: where the owner is, what they finished or skipped.
-- ---------------------------------------------------------------------------
create table if not exists public.onboarding_progress (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  current_step text check (char_length(current_step) <= 40),
  completed_steps text[] not null default '{}',
  skipped_steps text[] not null default '{}',
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);
drop trigger if exists onboarding_progress_touch on public.onboarding_progress;
create trigger onboarding_progress_touch before update on public.onboarding_progress
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security.
-- Members who are owner or manager read and write their restaurant's rows;
-- waiters read them. Creating restaurants and memberships, changing status,
-- and sending invites happen on the server with the service role.
-- ---------------------------------------------------------------------------
alter table public.restaurants enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.restaurant_sections enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.staff_invites enable row level security;
alter table public.onboarding_progress enable row level security;

revoke all on public.restaurants, public.restaurant_members, public.restaurant_sections, public.restaurant_tables,
  public.menu_categories, public.menu_items, public.staff_invites, public.onboarding_progress
  from public, anon, authenticated;
grant all on public.restaurants, public.restaurant_members, public.restaurant_sections, public.restaurant_tables,
  public.menu_categories, public.menu_items, public.staff_invites, public.onboarding_progress
  to service_role;

-- restaurants: read by members; owners/managers edit details but not owner_id, status or went_live_at.
grant select on public.restaurants to authenticated;
grant update (name, kind, area, address, lat, lng, opening_hours, phone, logo_url, cover_url, theme)
  on public.restaurants to authenticated;
drop policy if exists restaurants_read on public.restaurants;
create policy restaurants_read on public.restaurants for select to authenticated
  using ((select private.is_restaurant_member(id)));
drop policy if exists restaurants_update on public.restaurants;
create policy restaurants_update on public.restaurants for update to authenticated
  using ((select private.can_manage_restaurant(id))) with check ((select private.can_manage_restaurant(id)));

-- restaurant_members: you see your own memberships and your colleagues'. Writes are server-only.
grant select on public.restaurant_members to authenticated;
drop policy if exists restaurant_members_read on public.restaurant_members;
create policy restaurant_members_read on public.restaurant_members for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_restaurant_member(restaurant_id)));

-- Floor and menu: members read, owners/managers write.
grant select, insert, update, delete on public.restaurant_sections, public.restaurant_tables,
  public.menu_categories, public.menu_items to authenticated;

drop policy if exists restaurant_sections_read on public.restaurant_sections;
create policy restaurant_sections_read on public.restaurant_sections for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists restaurant_sections_write on public.restaurant_sections;
create policy restaurant_sections_write on public.restaurant_sections for all to authenticated
  using ((select private.can_manage_restaurant(restaurant_id))) with check ((select private.can_manage_restaurant(restaurant_id)));

drop policy if exists restaurant_tables_read on public.restaurant_tables;
create policy restaurant_tables_read on public.restaurant_tables for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists restaurant_tables_write on public.restaurant_tables;
create policy restaurant_tables_write on public.restaurant_tables for all to authenticated
  using ((select private.can_manage_restaurant(restaurant_id))) with check ((select private.can_manage_restaurant(restaurant_id)));

drop policy if exists menu_categories_read on public.menu_categories;
create policy menu_categories_read on public.menu_categories for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists menu_categories_write on public.menu_categories;
create policy menu_categories_write on public.menu_categories for all to authenticated
  using ((select private.can_manage_restaurant(restaurant_id))) with check ((select private.can_manage_restaurant(restaurant_id)));

drop policy if exists menu_items_read on public.menu_items;
create policy menu_items_read on public.menu_items for select to authenticated
  using ((select private.is_restaurant_member(restaurant_id)));
drop policy if exists menu_items_write on public.menu_items;
create policy menu_items_write on public.menu_items for all to authenticated
  using ((select private.can_manage_restaurant(restaurant_id))) with check ((select private.can_manage_restaurant(restaurant_id)));

-- Staff invites hold colleagues' contact details: owners/managers only.
-- They can queue and edit invites but not mark them sent; delivery status is server-only.
grant select, delete on public.staff_invites to authenticated;
grant insert (restaurant_id, name, email, phone, role) on public.staff_invites to authenticated;
grant update (name, email, phone, role) on public.staff_invites to authenticated;
drop policy if exists staff_invites_manage on public.staff_invites;
create policy staff_invites_manage on public.staff_invites for all to authenticated
  using ((select private.can_manage_restaurant(restaurant_id))) with check ((select private.can_manage_restaurant(restaurant_id)));

grant select, insert, update on public.onboarding_progress to authenticated;
drop policy if exists onboarding_progress_manage on public.onboarding_progress;
create policy onboarding_progress_manage on public.onboarding_progress for all to authenticated
  using ((select private.can_manage_restaurant(restaurant_id))) with check ((select private.can_manage_restaurant(restaurant_id)));

-- ---------------------------------------------------------------------------
-- Storage: public-read bucket for logos, covers and dish photos.
-- Owners/managers write only under '<their restaurant id>/'. Images only, 5 MB.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('restaurant-media', 'restaurant-media', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
on conflict (id) do nothing;

drop policy if exists restaurant_media_read on storage.objects;
create policy restaurant_media_read on storage.objects for select to authenticated
  using (bucket_id = 'restaurant-media' and (select private.can_manage_media(name)));
drop policy if exists restaurant_media_insert on storage.objects;
create policy restaurant_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'restaurant-media' and (select private.can_manage_media(name)));
drop policy if exists restaurant_media_update on storage.objects;
create policy restaurant_media_update on storage.objects for update to authenticated
  using (bucket_id = 'restaurant-media' and (select private.can_manage_media(name)))
  with check (bucket_id = 'restaurant-media' and (select private.can_manage_media(name)));
drop policy if exists restaurant_media_delete on storage.objects;
create policy restaurant_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'restaurant-media' and (select private.can_manage_media(name)));

notify pgrst, 'reload schema';
