import pg from 'pg';
import { readFileSync } from 'node:fs';
let pool;
export function database() {
  if (!pool) {
    if (!process.env.SUPABASE_DB_URL) throw new Error('Inventory requires a server database connection.');
    const url = new URL(process.env.SUPABASE_DB_URL);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: true, ca: readFileSync(new URL('../../db/supabase-ca.crt', import.meta.url), 'utf8') } });
  }
  return pool;
}
export async function transaction(userId, fn) {
  const db = await database().connect();
  try {
    await db.query('begin');
    // All commands for one owner serialize, including concurrent retries and stock checks.
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (error) { await db.query('rollback'); throw error; }
  finally { db.release(); }
}
