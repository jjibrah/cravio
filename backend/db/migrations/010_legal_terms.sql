-- 010 (PROPOSED, NOT APPLIED): terms and conditions written by Cravio admins, versioned, and accepted by account holders.
--
-- * legal_drafts: the admin's working copy (one per kind). Never shown publicly.
-- * legal_documents: published versions, immutable (append-only). The newest version of a kind is the current one.
--   require_existing: when true, people who accepted an older version (or none) must accept this one at next sign-in;
--   when false, only accounts created after it was published must accept it.
-- * legal_acceptances: who accepted which version, when. Append-only.
-- Reading published documents is public (anon). Writes go through the API (service role) after an admin check;
-- acceptances are recorded by the API for the signed-in user only.
-- Idempotent.

create table if not exists public.legal_drafts (
  kind text primary key check (kind in ('terms')),
  title text not null default 'Terms and conditions' check (char_length(btrim(title)) between 1 and 120),
  body text not null default '' check (char_length(body) <= 100000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('terms')),
  version integer not null check (version > 0),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 100000),
  require_existing boolean not null default true,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (kind, version)
);

create table if not exists public.legal_acceptances (
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.legal_documents(id) on delete cascade,
  accepted_at timestamptz not null default now(),
  primary key (user_id, document_id)
);
create index if not exists legal_acceptances_document_idx on public.legal_acceptances (document_id);

create or replace function private.legal_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Published terms and acceptances can’t be changed.' using errcode = '42501';
end;
$$;
revoke all on function private.legal_append_only() from public, anon, authenticated;
drop trigger if exists legal_documents_no_change on public.legal_documents;
create trigger legal_documents_no_change before update or delete on public.legal_documents
  for each row execute function private.legal_append_only();
drop trigger if exists legal_acceptances_no_change on public.legal_acceptances;
create trigger legal_acceptances_no_change before update or delete on public.legal_acceptances
  for each row execute function private.legal_append_only();

alter table public.legal_drafts enable row level security;
alter table public.legal_documents enable row level security;
alter table public.legal_acceptances enable row level security;
revoke all on public.legal_drafts, public.legal_documents, public.legal_acceptances from public, anon, authenticated;
grant all on public.legal_drafts, public.legal_documents, public.legal_acceptances to service_role;
grant select on public.legal_documents to anon, authenticated;
drop policy if exists legal_documents_read on public.legal_documents;
create policy legal_documents_read on public.legal_documents for select to anon, authenticated using (true);
grant select on public.legal_acceptances to authenticated;
drop policy if exists legal_acceptances_read_own on public.legal_acceptances;
create policy legal_acceptances_read_own on public.legal_acceptances for select to authenticated using (user_id = (select auth.uid()));

notify pgrst, 'reload schema';
