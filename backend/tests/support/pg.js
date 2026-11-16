// Disposable in-process Postgres (PGlite) with the minimum Supabase surface the migrations need:
// the anon/authenticated/service_role roles, auth.users + auth.uid(), and storage buckets/objects.
// Nothing here connects to the shared database. Every test database lives in memory and is discarded.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const DB_DIR = new URL('../../db/', import.meta.url);

const SUPABASE_STUBS = `
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}',
  banned_until timestamptz,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant usage on schema public to anon, authenticated, service_role;
`;

export const migrationFiles = () => readdirSync(new URL('migrations/', DB_DIR)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
export const readSql = (relative) => readFileSync(new URL(relative, DB_DIR), 'utf8');

/** A fresh database with schema.sql and the given migrations applied (default: every committed migration). */
export async function freshDatabase({ migrations = migrationFiles(), extra = [] } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(readSql('schema.sql'));
  for (const name of migrations) await db.exec(readSql(`migrations/${name}`));
  for (const relative of extra) await db.exec(readSql(relative));
  return db;
}

/** Runs `fn` as an authenticated user (auth.uid() = userId) under RLS, then restores the superuser session. */
export async function asUser(db, userId, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await tx.exec('set local role authenticated');
    return fn(tx);
  });
}

export async function createUser(db, email, { role = null, name } = {}) {
  const { rows } = await db.query(
    `insert into auth.users (email, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3) returning id`,
    [email, JSON.stringify(role ? { role } : {}), JSON.stringify({ name: name || email.split('@')[0] })]);
  return rows[0].id;
}
