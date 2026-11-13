import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

export const env = { ...parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8')), ...process.env };

export function createAdmin() {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) throw new Error('Backend Supabase URL and service key are required.');
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createDatabase() {
  if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is required.');
  const url = new URL(env.SUPABASE_DB_URL);
  // Do not allow URL options to disable certificate verification.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  return new pg.Client({
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(new URL('../db/supabase-ca.crt', import.meta.url), 'utf8'),
    },
    connectionTimeoutMillis: 10000,
  });
}
