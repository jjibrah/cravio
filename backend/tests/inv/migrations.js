// The ONE place that knows which inventory migrations exist. Lifecycle of a migration (012..020 followed this path):
//   1. A new migration (and its .down.sql) is written in backend/db/proposed/ and APPENDED to PROPOSED_MIGRATIONS below
//      ('proposed/021_x.sql'). Until it is applied, fixture.js applies every PROPOSED_MIGRATIONS entry by default and
//      proposed-list.test.js fails if a file in backend/db/proposed is missing from the list.
//   2. When it is APPLIED to the shared database, `git mv` the .sql file to backend/db/migrations/ (the .down.sql stays in
//      proposed/, like 009's) and repoint: remove the line from PROPOSED_MIGRATIONS, add 'migrations/021_x.sql' to
//      INVENTORY_MIGRATIONS, and change the test references from 'proposed/021_x.sql' to 'migrations/021_x.sql'
//      (rehearsal tests use inventoryBefore(21) / inventoryUpTo(21); resolveProposed() also maps old 'proposed/..' names).
//
// Everything reads these lists:
//   * fixture.js        inventoryFixture() = BASE_MIGRATIONS + every inventory migration (INVENTORY + still-proposed) by default;
//                       `extra` picks the inventory migrations to apply on top of the base (`extra: []` = base only, i.e. 009/010 state);
//   * migration-0NN.test.js rehearsals start from BASE_MIGRATIONS + inventoryBefore(N), then apply N;
//   * npm run test:inv:compat   INV_EXTRA_MIGRATIONS=all makes backend/tests/inventory-v2.js apply the inventory set on top of
//                               the base (proof that `main`'s 009 code still works against the widened schema);
//   * proposed-list.test.js     guards these lists against the files on disk.
// Paths are relative to backend/db/, exactly what freshDatabase({ extra }) takes. 011_table_sessions is not an inventory
// migration (table sessions): it is applied only by table-sessions.js and is deliberately in neither list.
import { existsSync } from 'node:fs';
import { migrationFiles } from '../support/pg.js';

const DB_DIR = new URL('../../db/', import.meta.url);

/** Inventory migrations already applied to the shared database (files live in backend/db/migrations), oldest first. */
export const INVENTORY_MIGRATIONS = Object.freeze([
  'migrations/012_inventory_catalogue.sql',
  'migrations/013_inventory_recipes.sql',
  'migrations/014_ai_gateway.sql',
  'migrations/015_suppliers.sql',
  'migrations/016_purchasing.sql',
  'migrations/017_approvals_emergency.sql',
  'migrations/018_distribution.sql',
  'migrations/019_wastage_adjustments.sql',
  'migrations/020_counts.sql',
]);

/** Inventory migrations still proposed (in backend/db/proposed, NOT applied), oldest first. Currently none. */
export const PROPOSED_MIGRATIONS = Object.freeze([]);

/** Every inventory migration the fixture applies by default: applied ones, then still-proposed ones. */
export const ALL_INVENTORY_MIGRATIONS = Object.freeze([...INVENTORY_MIGRATIONS, ...PROPOSED_MIGRATIONS]);

/** Committed migration file NAMES that are not inventory ones (001..010): what `freshDatabase({ migrations })` takes for the "009 only" state. */
export const BASE_MIGRATIONS = Object.freeze(
  migrationFiles().filter((name) => !INVENTORY_MIGRATIONS.includes(`migrations/${name}`)));

/** Migration number of a path ('migrations/013_x.sql' -> 13). */
export const numberOf = (path) => Number(/\/(\d{3})_/.exec(path)?.[1]);

/** The inventory migrations up to and including `n` (a number like 13, or a path): for rehearsing "everything before this one". */
export function inventoryUpTo(n) {
  const limit = typeof n === 'number' ? n : numberOf(n);
  return ALL_INVENTORY_MIGRATIONS.filter((p) => numberOf(p) <= limit);
}

/** The inventory migrations strictly before `n`. */
export function inventoryBefore(n) {
  const limit = typeof n === 'number' ? n : numberOf(n);
  return ALL_INVENTORY_MIGRATIONS.filter((p) => numberOf(p) < limit);
}

// Old names kept so earlier invocations keep working.
export const proposedUpTo = inventoryUpTo;
export const proposedBefore = inventoryBefore;

/** Maps a legacy 'proposed/0NN_x.sql' path to 'migrations/0NN_x.sql' once that file has been applied (moved); anything else passes through. */
export function resolvePath(path) {
  if (typeof path !== 'string' || !path.startsWith('proposed/') || path.endsWith('.down.sql')) return path;
  if (existsSync(new URL(path, DB_DIR))) return path;
  const moved = `migrations/${path.slice('proposed/'.length)}`;
  return existsSync(new URL(moved, DB_DIR)) ? moved : path;
}

/**
 * Turns a user-facing spec into a list of paths:  'all' (or '*') -> every inventory migration;  'none' or '' -> [];
 * 'migrations/012_a.sql,migrations/013_b.sql' -> exactly those (explicit lists keep working, legacy 'proposed/012_a.sql' names
 * map to their migrations/ path);  an array passes through (same mapping).
 */
export function resolveProposed(spec) {
  if (Array.isArray(spec)) return spec.map(resolvePath);
  const text = String(spec ?? '').trim();
  if (text === 'all' || text === '*') return [...ALL_INVENTORY_MIGRATIONS];
  if (text === '' || text === 'none') return [];
  return text.split(',').map((name) => name.trim()).filter(Boolean).map(resolvePath);
}
