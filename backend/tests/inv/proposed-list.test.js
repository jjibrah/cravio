// Guards the shared list of proposed migrations (migrations.js): it must match backend/db/proposed exactly.
// Usage: node backend/tests/inv/proposed-list.test.js
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { PROPOSED_MIGRATIONS, numberOf, proposedUpTo, proposedBefore, resolveProposed } from './migrations.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const dir = new URL('../../db/', import.meta.url);

// Every listed file exists, has a down file, and the list is ascending with no duplicates (014 may land after 015: gaps are fine, order is not).
for (const path of PROPOSED_MIGRATIONS) {
  eq(existsSync(new URL(path, dir)), true, `${path} exists`);
  eq(existsSync(new URL(path.replace(/\.sql$/, '.down.sql'), dir)), true, `${path} has a .down.sql`);
}
const numbers = PROPOSED_MIGRATIONS.map(numberOf);
eq(numbers, [...numbers].sort((a, b) => a - b), 'list is in migration order');
eq(new Set(numbers).size, numbers.length, 'no migration listed twice');

// Every proposed 012+ file on disk is listed (008/009/011 in that folder are old rollbacks for committed migrations).
const onDisk = readdirSync(new URL('proposed/', dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f) && !f.endsWith('.down.sql') && Number(f.slice(0, 3)) >= 12).map((f) => `proposed/${f}`).sort();
eq([...PROPOSED_MIGRATIONS], onDisk, 'migrations.js lists every proposed migration (add new ones there)');

// Helpers.
eq(resolveProposed('all'), [...PROPOSED_MIGRATIONS], "'all' = the whole list");
eq(resolveProposed(''), [], 'empty = none');
eq(resolveProposed('proposed/012_inventory_catalogue.sql, proposed/013_inventory_recipes.sql'), ['proposed/012_inventory_catalogue.sql', 'proposed/013_inventory_recipes.sql'], 'explicit lists still work');
eq(proposedUpTo(12), ['proposed/012_inventory_catalogue.sql'], 'proposedUpTo');
eq(proposedBefore(12), [], 'proposedBefore');

console.log(`Proposed migration list: ${checks} checks passed.`);
