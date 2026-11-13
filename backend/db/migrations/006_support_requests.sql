-- 006: support requests. Owners and managers contact Cravio ("Contact Cravio"); the Cravio team works the
-- queue in /admin (Leads & requests, Complaints). Builds on 002 (restaurants, membership helpers,
-- private.touch_updated_at). Every statement is idempotent, like 002–005.
--
-- Access model
-- * Owners and managers INSERT requests for their own restaurant, and SELECT their restaurant's requests,
--   through RLS (private.can_manage_restaurant). They can insert only the columns they fill in, so status,
--   admin_note and resolved_at always start at their defaults. They get no UPDATE or DELETE.
-- * Waiters have no access.
-- * The Cravio team reads and updates every row through the backend's service client, after the API has
--   checked the caller is an admin. Leads (no restaurant yet) are written the same way.

create schema if not exists private;

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  type text not null check (type in ('question', 'problem', 'billing', 'feature', 'complaint', 'lead')),
  subject text not null check (char_length(btrim(subject)) between 1 and 140),
  message text not null check (char_length(btrim(message)) between 1 and 4000),
  urgency text not null default 'normal' check (urgency in ('low', 'normal', 'urgent')),
  contact_name text check (char_length(contact_name) <= 120),
  contact_phone text check (char_length(contact_phone) <= 32),
  contact_email text check (char_length(contact_email) <= 254),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  -- Cravio's reply, shown to the owner on their Contact Cravio page.
  admin_note text check (char_length(admin_note) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists support_requests_restaurant_idx on public.support_requests (restaurant_id, created_at desc);
create index if not exists support_requests_status_idx on public.support_requests (status, created_at desc);
create index if not exists support_requests_type_idx on public.support_requests (type, status);

drop trigger if exists support_requests_touch on public.support_requests;
create trigger support_requests_touch before update on public.support_requests
  for each row execute function private.touch_updated_at();

alter table public.support_requests enable row level security;

revoke all on public.support_requests from public, anon, authenticated;
grant all on public.support_requests to service_role;

grant select on public.support_requests to authenticated;
grant insert (restaurant_id, created_by, type, subject, message, urgency, contact_name, contact_phone, contact_email)
  on public.support_requests to authenticated;

drop policy if exists support_requests_read on public.support_requests;
create policy support_requests_read on public.support_requests for select to authenticated
  using (restaurant_id is not null and (select private.can_manage_restaurant(restaurant_id)));

drop policy if exists support_requests_insert on public.support_requests;
create policy support_requests_insert on public.support_requests for insert to authenticated
  with check (
    restaurant_id is not null
    and (select private.can_manage_restaurant(restaurant_id))
    and created_by = (select auth.uid())
    and type <> 'lead'
  );

notify pgrst, 'reload schema';
