// The ONE ordered list of proposed (not yet applied to the shared database) inventory migrations, oldest first.
// Adding a migration (014, 015 ... 018) = append one line here. Everything below reads this list:
//   * fixture.js        inventoryFixture() applies ALL of them by default (a test may pass `extra` to choose, `extra: []` for none);
//   * npm run test:inv:compat   INV_EXTRA_MIGRATIONS=all makes backend/tests/inventory-v2.js apply them on top of 009
//                               (proof that `main`'s 009 code still works against the widened schema);
//   * proposed-list.test.js     fails when a file in backend/db/proposed is missing here (or is listed twice / out of order / without a .down.sql).
// Paths are relative to backend/db/, exactly what freshDatabase({ extra }) takes.
export const PROPOSED_MIGRATIONS = Object.freeze([
  'proposed/012_inventory_catalogue.sql',
  'proposed/013_inventory_recipes.sql',
  'proposed/014_ai_gateway.sql',
  'proposed/015_suppliers.sql',
  'proposed/016_purchasing.sql',
]);

/** Migration number of a proposed path ('proposed/013_x.sql' -> 13). */
export const numberOf = (path) => Number(/\/(\d{3})_/.exec(path)?.[1]);

/** The proposed migrations up to and including `n` (a number like 13, or a path): for rehearsing "everything before this one". */
export function proposedUpTo(n) {
  const limit = typeof n === 'number' ? n : numberOf(n);
  return PROPOSED_MIGRATIONS.filter((p) => numberOf(p) <= limit);
}

/** The proposed migrations strictly before `n`. */
export function proposedBefore(n) {
  const limit = typeof n === 'number' ? n : numberOf(n);
  return PROPOSED_MIGRATIONS.filter((p) => numberOf(p) < limit);
}

/**
 * Turns a user-facing spec into a list of paths:  'all' (or '*') -> every proposed migration;  'none' or '' -> [];
 * 'proposed/012_a.sql,proposed/013_b.sql' -> exactly those (explicit lists keep working);  an array passes through.
 */
export function resolveProposed(spec) {
  if (Array.isArray(spec)) return [...spec];
  const text = String(spec ?? '').trim();
  if (text === 'all' || text === '*') return [...PROPOSED_MIGRATIONS];
  if (text === '' || text === 'none') return [];
  return text.split(',').map((name) => name.trim()).filter(Boolean);
}
