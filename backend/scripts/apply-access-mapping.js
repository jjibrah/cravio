// Applies a reviewed access mapping (see src/lib/access-mapping.js and docs/v2/MIGRATION-008.md).
// DRY RUN by default: everything runs in a transaction that is rolled back, and the planned changes are printed.
//   node backend/scripts/apply-access-mapping.js path/to/mapping.json            # dry run
//   node backend/scripts/apply-access-mapping.js path/to/mapping.json --apply    # commit
// Keep mapping files outside Git: they name real people.
import { readFileSync } from 'node:fs';
import { createDatabase } from './clients.js';
import { applyAccessMapping } from '../src/lib/access-mapping.js';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file || file.startsWith('--')) { console.error('Usage: node backend/scripts/apply-access-mapping.js <mapping.json> [--apply]'); process.exit(1); }
const mapping = JSON.parse(readFileSync(file, 'utf8'));
const db = createDatabase();
try {
  await db.connect();
  const { rows } = await db.query("select to_regclass('public.business_members') is not null as ok");
  if (!rows[0].ok) throw new Error('Migration 008 is not applied. Apply it first (after review).');
  await db.query('begin');
  const changes = await applyAccessMapping(db, mapping);
  changes.forEach((line) => console.log(`- ${line}`));
  if (apply) { await db.query('commit'); console.log(`Applied ${changes.length} change(s).`); }
  else { await db.query('rollback'); console.log(`Dry run: ${changes.length} change(s) planned, nothing written. Re-run with --apply to commit.`); }
} catch (error) {
  await db.query('rollback').catch(() => {});
  console.error('Mapping not applied:', error.message);
  process.exitCode = 1;
} finally { await db.end().catch(() => {}); }
