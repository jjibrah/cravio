// The shared server-side Postgres pool (used by lib/db.js and the inventory routes). Moved here from src/inventory/database.js
// on 18 Nov 2026 when that folder became the new inventory module.
import pg from 'pg';
import { readFileSync } from 'node:fs';
let pool;

/** How long the near-static units table is kept in memory (real pool only). */
export const UNITS_TTL_MS = 60_000;

/** Connections the pool may open (env DB_POOL_MAX, default 10). Reads that don't depend on each other run on separate connections. */
export const poolMax = () => {
  const n = Number.parseInt(process.env.DB_POOL_MAX || '', 10);
  return Number.isInteger(n) && n >= 1 ? n : 10;
};

/**
 * True when db.query() may be called concurrently: a pg Pool (each query takes its own connection) or a test double that says so
 * (parallelSafe). A single client or a transaction is NOT: pg queues the second query on the same connection and warns
 * ("Calling client.query() when the client is already executing a query"), so those must stay sequential.
 */
export const canParallel = (db) => Boolean(db) && (db.parallelSafe === true || typeof db.totalCount === 'number');

/** Runs the reads together when the db is a pool, one after another otherwise. Same result either way: an array in the order given. */
export async function together(db, ...reads) {
  if (canParallel(db)) return Promise.all(reads.map((read) => read()));
  const out = [];
  for (const read of reads) out.push(await read());
  return out;
}

export function database() {
  if (!pool) {
    if (!process.env.SUPABASE_DB_URL) throw new Error('The server needs SUPABASE_DB_URL to reach the database.');
    const url = new URL(process.env.SUPABASE_DB_URL);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    pool = new pg.Pool({ connectionString: url.toString(), max: poolMax(), connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: true, ca: readFileSync(new URL('../../db/supabase-ca.crt', import.meta.url), 'utf8') } });
  }
  return pool;
}
