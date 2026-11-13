-- 001: allow more than one admin.
--
-- * Drops the one-admin unique index.
-- * Lets the service role grant 'admin' through app_metadata.role (browser
--   clients cannot write app_metadata, so this stays server-controlled).
-- * The reserved email in private.admin_account is always admin: it is the
--   protected primary admin. A guard trigger stops anything, including the
--   service role, from giving that profile another role.
-- * An app_metadata update without a role no longer clears the profile role.
-- * public.primary_admin_email() lets the backend (service role only) find
--   the primary admin without exposing the private schema.
--
-- Idempotent: safe to run on a database that already has these changes.

drop index if exists public.profiles_one_admin;

create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  assigned_role text;
  display_name text;
begin
  if lower(new.email) = (select email from private.admin_account where singleton) then
    assigned_role := 'admin';
  elsif new.raw_app_meta_data ->> 'role' in ('admin', 'owner', 'waiter') then
    assigned_role := new.raw_app_meta_data ->> 'role';
  end if;

  display_name := left(coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    case when assigned_role = 'admin' then 'Super Admin' end,
    nullif(split_part(new.email, '@', 1), ''),
    'User'
  ), 120);

  insert into public.profiles (id, name, role)
    values (new.id, display_name, assigned_role)
    on conflict (id) do update set role = coalesce(excluded.role, public.profiles.role);
  return new;
end;
$$;
revoke all on function private.handle_new_auth_user() from public, anon, authenticated;
drop trigger if exists cravio_auth_user_created on auth.users;
create trigger cravio_auth_user_created after insert or update of raw_app_meta_data on auth.users
  for each row execute function private.handle_new_auth_user();

-- The primary admin's profile always keeps the admin role.
create or replace function private.protect_primary_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role is distinct from 'admin' and exists (
    select 1 from auth.users u
    join private.admin_account a on a.singleton and lower(u.email) = a.email
    where u.id = new.id
  ) then
    raise exception 'The primary admin must keep the admin role.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_primary_admin() from public, anon, authenticated;
drop trigger if exists cravio_protect_primary_admin on public.profiles;
create trigger cravio_protect_primary_admin before insert or update of role on public.profiles
  for each row execute function private.protect_primary_admin();

-- Service-role lookup of the reserved primary admin email.
create or replace function public.primary_admin_email()
returns text language sql stable security definer set search_path = '' as $$
  select email from private.admin_account where singleton
$$;
revoke all on function public.primary_admin_email() from public, anon, authenticated;
grant execute on function public.primary_admin_email() to service_role;

notify pgrst, 'reload schema';
