// READ-ONLY census of the current (009) inventory data, for comparing before/after migrations.
// Everything runs inside `begin; set transaction read only; ... rollback;`. Prints JSON counts only (no names, no PII).
// Usage: node backend/scripts/inventory-census.js   (connects like migrate.js, via SUPABASE_DB_URL)
import { createDatabase } from './clients.js';

const db = createDatabase();
const group = async (sql) => Object.fromEntries((await db.query(sql)).rows.map((r) => [String(r.k), r.n]));
const count = async (sql) => (await db.query(sql)).rows[0].n;
const exists = async (name) => (await db.query('select to_regclass($1) is not null as e', [name])).rows[0].e;

try {
  await db.connect();
  await db.query('begin');
  await db.query('set transaction read only');
  const census = {
    takenAt: new Date().toISOString(),
    stock_items: {
      total: await count('select count(*)::int as n from public.stock_items'),
      byUnit: await group('select unit as k, count(*)::int as n from public.stock_items group by 1 order by 1'),
    },
    stock_locations: { byKind: await group('select kind as k, count(*)::int as n from public.stock_locations group by 1 order by 1') },
    stock_balances: {
      rows: await count('select count(*)::int as n from public.stock_balances'),
      negativeOnHand: await count('select count(*)::int as n from public.stock_balances where on_hand < 0'),
    },
    menu_item_stock: await count('select count(*)::int as n from public.menu_item_stock'),
    stock_requests: { byStatus: await group('select status as k, count(*)::int as n from public.stock_requests group by 1 order by 1') },
    stock_transfers: { byStatus: await group('select status as k, count(*)::int as n from public.stock_transfers group by 1 order by 1') },
    stock_movements: { byReason: await group('select reason as k, count(*)::int as n from public.stock_movements group by 1 order by 1') },
    order_stock_effects: await count('select count(*)::int as n from public.order_stock_effects'),
    stock_commands: await count('select count(*)::int as n from public.stock_commands'),
    tables: {
      menu_item_recipes: await exists('public.menu_item_recipes'),
      'private.stock_businesses': await exists('private.stock_businesses'),
    },
  };
  await db.query('rollback');
  console.log(JSON.stringify(census, null, 2));
} catch (error) {
  await db.query('rollback').catch(() => {});
  console.error('Census failed:', error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
