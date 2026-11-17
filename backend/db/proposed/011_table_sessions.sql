-- 011 (PROPOSED, NOT APPLIED): table sessions, so everyone at a table orders from one shared cart.
-- See docs/v2/TABLE-SESSIONS.md.
--
-- Rules implemented here and in src/lib/table-sessions.js (confirmed by the product owner, 17 Nov 2026):
-- * The first guest to scan a table's QR opens its session; at most one open session per table.
-- * Others join with the session's 4-digit join code, shown on members' phones and in the waiter app.
--   Wrong codes are counted per session; too many lock joining for 10 minutes (staff can rotate the code).
-- * The cart is a jsonb list of lines, changed by operations with optimistic concurrency (cart_version).
-- * "Ready to order" saves the cart as one guest_carts row (guest_carts.session_id); the waiter's scan stays the gate.
-- * A session starts unverified; it is verified when a waiter confirms an order from it or staff confirm the guests
--   are at the table. Unverified sessions idle out after 15 minutes, verified ones after 45; hard cap 6 hours.
--
-- All access goes through the API (server role). No grants for anon/authenticated. Idempotent: can be re-run.

create table if not exists public.table_sessions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_id uuid not null references public.restaurant_tables(id) on delete cascade,
  join_code text not null check (join_code ~ '^[0-9]{4}$'),
  status text not null default 'open' check (status in ('open', 'closed')),
  cart jsonb not null default '[]' check (jsonb_typeof(cart) = 'array' and jsonb_array_length(cart) <= 30),
  cart_version integer not null default 0,
  cart_code text check (cart_code is null or cart_code ~ '^[ACDEFHJKMNPRTUVWXY34679]{6}$'),
  ready_lines jsonb,
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  failed_joins integer not null default 0,
  failed_since timestamptz,
  locked_until timestamptz,
  opened_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '6 hours',
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  closed_reason text check (closed_reason is null or closed_reason in ('staff', 'idle', 'expired', 'paid', 'replaced', 'empty')),
  check ((status = 'closed') = (closed_at is not null))
);
create unique index if not exists table_sessions_one_open on public.table_sessions (table_id) where status = 'open';
create index if not exists table_sessions_restaurant_open on public.table_sessions (restaurant_id) where status = 'open';

create table if not exists public.table_session_members (
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  name text check (name is null or char_length(name) between 1 and 24),
  guest_number integer not null check (guest_number >= 1),
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (session_id, visitor_id)
);

alter table public.guest_carts add column if not exists session_id uuid references public.table_sessions(id) on delete set null;
create index if not exists guest_carts_session_idx on public.guest_carts (session_id) where session_id is not null;

alter table public.table_sessions enable row level security;
alter table public.table_session_members enable row level security;
revoke all on public.table_sessions, public.table_session_members from public, anon, authenticated;
grant all on public.table_sessions, public.table_session_members to service_role;
