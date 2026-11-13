// Applies backend/db/migrations/*.sql in filename order, once each, inside a transaction.
// Usage: npm run db:migrate [-- --dry-run]
import { readdirSync, readFileSync } from 'node:fs';
import { createDatabase } from './clients.js';

const dir = new URL('../db/migrations/', import.meta.url);
const files = readdirSync(dir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
const dryRun = process.argv.includes('--dry-run');
const db = createDatabase();

try {
  await db.connect();
  await db.query('create schema if not exists private');
  await db.query(`create table if not exists private.schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const { rows } = await db.query('select name from private.schema_migrations');
  const applied = new Set(rows.map((row) => row.name));
  const pending = files.filter((name) => !applied.has(name));
  if (!pending.length) console.log('No pending migrations.');
  for (const name of pending) {
    if (dryRun) { console.log(`Pending: ${name}`); continue; }
    await db.query('begin');
    try {
      await db.query(readFileSync(new URL(name, dir), 'utf8'));
      await db.query('insert into private.schema_migrations (name) values ($1)', [name]);
      await db.query('commit');
      console.log(`Applied: ${name}`);
    } catch (error) {
      await db.query('rollback').catch(() => {});
      throw new Error(`${name} failed: ${error.message}`);
    }
  }
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
