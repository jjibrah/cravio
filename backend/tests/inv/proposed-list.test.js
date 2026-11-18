// Guards the shared migration lists (migrations.js) against backend/db on disk.
// Usage: node backend/tests/inv/proposed-list.test.js
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import {
  INVENTORY_MIGRATIONS, PROPOSED_MIGRATIONS, ALL_INVENTORY_MIGRATIONS, BASE_MIGRATIONS,
  numberOf, inventoryUpTo, inventoryBefore, resolveProposed, resolvePath,
} from './migrations.js';
import { migrationFiles } from '../support/pg.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const dir = new URL('../../db/', import.meta.url);
const sqlIn = (folder) => readdirSync(new URL(`${folder}/`, dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f) && !f.endsWith('.down.sql'));

// Applied inventory migrations: the file is in migrations/, the rollback stays in proposed/, and nothing is left behind in proposed/.
for (const path of INVENTORY_MIGRATIONS) {
  eq(path.startsWith('migrations/'), true, `${path} is a migrations/ path`);
  eq(existsSync(new URL(path, dir)), true, `${path} exists`);
  eq(existsSync(new URL(path.replace(/^migrations\//, 'proposed/').replace(/\.sql$/, '.down.sql'), dir)), true, `${path} has its .down.sql in proposed/`);
  eq(existsSync(new URL(path.replace(/^migrations\//, 'proposed/'), dir)), false, `${path} is no longer in proposed/`);
}
// Still-proposed inventory migrations (none right now): file in proposed/, a .down.sql beside it, not yet in migrations/.
for (const path of PROPOSED_MIGRATIONS) {
  eq(path.startsWith('proposed/'), true, `${path} is a proposed/ path`);
  eq(existsSync(new URL(path, dir)), true, `${path} exists`);
  eq(existsSync(new URL(path.replace(/\.sql$/, '.down.sql'), dir)), true, `${path} has a .down.sql`);
  eq(existsSync(new URL(path.replace(/^proposed\//, 'migrations/'), dir)), false, `${path} is not applied yet`);
}
// Ascending, no duplicates, applied ones all before proposed ones (014 may land after 015: gaps are fine, order is not).
const numbers = ALL_INVENTORY_MIGRATIONS.map(numberOf);
eq(numbers, [...numbers].sort((a, b) => a - b), 'list is in migration order');
eq(new Set(numbers).size, numbers.length, 'no migration listed twice');
eq(Math.min(...numbers), 12, 'inventory set starts at 012');

// Disk matches the lists: every committed 012+ file is in INVENTORY_MIGRATIONS; every proposed 012+ file is in PROPOSED_MIGRATIONS
// (011_table_sessions in proposed/ is not an inventory migration: it is applied only by table-sessions.js).
eq(sqlIn('migrations').filter((f) => Number(f.slice(0, 3)) >= 12).map((f) => `migrations/${f}`).sort(), [...INVENTORY_MIGRATIONS], 'migrations.js lists every committed inventory migration (012+)');
eq(sqlIn('proposed').filter((f) => Number(f.slice(0, 3)) >= 12).map((f) => `proposed/${f}`).sort(), [...PROPOSED_MIGRATIONS], 'migrations.js lists every still-proposed migration (add new ones there)');

// BASE = committed files that are not inventory ones: 001..010, with 009 present (plain inventory-v2 runs on it).
eq([...BASE_MIGRATIONS], migrationFiles().filter((n) => Number(n.slice(0, 3)) < 12), 'BASE_MIGRATIONS = committed migrations below 012');
eq(BASE_MIGRATIONS.some((n) => n.startsWith('009_')), true, 'base includes 009');
eq(BASE_MIGRATIONS.some((n) => Number(n.slice(0, 3)) >= 12), false, 'base has no inventory migration');

// Helpers.
eq(resolveProposed('all'), [...ALL_INVENTORY_MIGRATIONS], "'all' = the whole inventory set");
eq(resolveProposed(''), [], 'empty = none');
eq(resolveProposed('none'), [], "'none' = none");
eq(resolveProposed('migrations/012_inventory_catalogue.sql, migrations/013_inventory_recipes.sql'), ['migrations/012_inventory_catalogue.sql', 'migrations/013_inventory_recipes.sql'], 'explicit lists still work');
eq(resolveProposed('proposed/012_inventory_catalogue.sql, proposed/013_inventory_recipes.sql'), ['migrations/012_inventory_catalogue.sql', 'migrations/013_inventory_recipes.sql'], 'legacy proposed/ names map to their migrations/ path');
eq(resolveProposed(['proposed/020_counts.sql', '/abs/spike.sql']), ['migrations/020_counts.sql', '/abs/spike.sql'], 'arrays are mapped too; other paths pass through');
eq(resolvePath('proposed/012_inventory_catalogue.down.sql'), 'proposed/012_inventory_catalogue.down.sql', 'down files stay in proposed/');
eq(resolvePath('proposed/011_table_sessions.sql'), 'proposed/011_table_sessions.sql', 'unapplied proposed files are left alone');
eq(inventoryUpTo(12), ['migrations/012_inventory_catalogue.sql'], 'inventoryUpTo');
eq(inventoryBefore(12), [], 'inventoryBefore');
eq(inventoryBefore(14), ['migrations/012_inventory_catalogue.sql', 'migrations/013_inventory_recipes.sql'], 'inventoryBefore(14)');

console.log(`Migration lists: ${checks} checks passed.`);
