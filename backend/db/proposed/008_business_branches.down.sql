-- Rollback for 008_business_branches.sql. Restores the 007 shape.
--
-- Safety: refuses to run when it would lose information the 007 shape cannot hold —
--   * any owner with more than one restaurant (the old one-per-owner index could not be rebuilt), or
--   * any business-level grant or access event (export them first; see docs/v2/MIGRATION-008.md).
-- Restaurants, menus, tables, orders and memberships are never touched.

do $$
begin
  if to_regclass('public.business_members') is null then return; end if;
  if exists (select 1 from public.business_members) or exists (select 1 from public.access_events) then
    raise exception 'Refusing rollback: business grants or access events exist. Export and clear them deliberately first.';
  end if;
  if exists (select owner_id from public.restaurants group by owner_id having count(*) > 1) then
    raise exception 'Refusing rollback: an owner has several restaurants; the one-per-owner index cannot be restored.';
  end if;
end;
$$;

drop table if exists public.business_member_branches;
drop table if exists public.business_members;
drop table if exists public.access_events;

drop trigger if exists restaurants_default_business on public.restaurants;
drop function if exists private.restaurant_default_business();
create unique index if not exists restaurants_one_per_owner on public.restaurants (owner_id);
drop index if exists public.restaurants_one_primary_per_owner;
drop index if exists public.restaurants_id_business;
drop index if exists public.restaurants_business_idx;
alter table public.restaurants drop column if exists owner_primary;
alter table public.restaurants drop column if exists business_id;
drop table if exists public.businesses;
drop function if exists private.access_events_append_only();
drop function if exists private.oversees_branch(uuid);
drop function if exists private.business_role(uuid);

notify pgrst, 'reload schema';
