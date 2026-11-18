// Migration 014 (proposed): AI gateway tables. Rehearsal on PGlite: apply over a database that already has 012 + 013 data, idempotent re-run,
// constraints, insert-only guard, RLS (API-only), and the down migration (refuses while data exists, then drops cleanly).
// Usage: node backend/tests/inv/migration-014.test.js
import assert from 'node:assert/strict';
import { readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';

const U012 = 'proposed/012_inventory_catalogue.sql';
const U013 = 'proposed/013_inventory_recipes.sql';
const UP = 'proposed/014_ai_gateway.sql';
const DOWN = 'proposed/014_ai_gateway.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fails = async (promise, re, m) => { await assert.rejects(promise, (e) => { assert.match(e.message, re, m); return true; }, m); checks++; };

const { db, ids, users, helpers } = await inventoryFixture({ extra: [U012, U013] });
const { businessId } = ids;
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const counts = async () => (await one(`select (select count(*) from public.stock_items)::int as items, (select count(*) from public.restaurants)::int as branches,
  (select count(*) from public.inventory_events)::int as events`));
await db.query(`insert into public.stock_items (business_id, name) values ($1, 'Flour')`, [businessId]);

// Applies over live data without touching it, and again (idempotent)
const before = await counts();
await db.exec(readSql(UP));
eq(await counts(), before, '014 changes no existing data');
await db.exec(readSql(UP));
eq((await one(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('ai_usage', 'ai_limits', 'ai_business_settings')`)).n, 3, 'three tables, re-run is harmless');
eq((await one(`select count(*)::int as n from pg_trigger where tgname = 'ai_usage_no_change'`)).n, 1, 'one guard trigger after two runs');

// Additive: nothing main reads changed (no existing table gained or lost a column because of 014)
eq((await one(`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'businesses' and column_name like 'ai\\_%'`)).n, 0, 'businesses is untouched');

// Row level security on, no policies, no grants for the browser roles (the API is the only reader/writer)
for (const table of ['ai_usage', 'ai_limits', 'ai_business_settings']) {
  eq((await one(`select relrowsecurity as on from pg_class where oid = ('public.' || $1)::regclass`, [table])).on, true, `${table}: RLS on`);
  eq((await one(`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = $1`, [table])).n, 0, `${table}: no policies`);
  eq((await one(`select count(*)::int as n from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated', 'public')`, [table])).n, 0, `${table}: no browser grants`);
}

// Constraints
await fails(db.query(`insert into public.ai_limits (business_id, monthly_budget_kes, owner_budget_kes) values ($1, 100, 101)`, [businessId]), /check/i, 'owner cap above the admin allowance refused');
await fails(db.query(`insert into public.ai_limits (business_id, monthly_budget_kes) values ($1, -1)`, [businessId]), /check/i, 'negative allowance refused');
await fails(db.query(`insert into public.ai_limits (business_id, monthly_budget_kes, warn_pct) values ($1, 100, 0)`, [businessId]), /check/i, 'warn level 0 refused');
await fails(db.query(`insert into public.ai_limits (business_id, monthly_budget_kes) values ('00000000-0000-4000-8000-000000000000', 5)`), /foreign key|violates/i, 'allowance needs a real business');
await fails(db.query(`insert into public.ai_business_settings (business_id, features) values ($1, '[]')`, [businessId]), /check/i, 'features must be an object');
await fails(db.query(`insert into public.ai_usage (business_id, feature, status, cost_kes) values ($1, 'recipe_draft', 'ok', -1)`, [businessId]), /check/i, 'negative cost refused');
await fails(db.query(`insert into public.ai_usage (business_id, feature, status) values ($1, 'recipe_draft', 'weird')`, [businessId]), /check/i, 'unknown status refused');
eq((await one(`select enabled from (select coalesce((select enabled from public.ai_business_settings where business_id = $1), false) as enabled) s`, [businessId])).enabled, false, 'AI is off until someone switches it on');
await db.query(`insert into public.ai_business_settings (business_id) values ($1)`, [businessId]);
eq((await one(`select enabled, features, features_owner_off, to_char(daily_insights_time, 'HH24:MI') as t from public.ai_business_settings where business_id = $1`, [businessId])), { enabled: false, features: {}, features_owner_off: [], t: '06:00' }, 'defaults: off, no overrides, 06:00');
await db.query(`insert into public.ai_limits (business_id, monthly_budget_kes, owner_budget_kes) values ($1, 100, 60)`, [businessId]);
eq((await one(`select warn_pct from public.ai_limits where business_id = $1`, [businessId])).warn_pct, 80, 'warn level defaults to 80');

// Insert-only
const u = await one(`insert into public.ai_usage (business_id, feature, status, prompt_tokens, completion_tokens, cost_kes) values ($1, 'recipe_draft', 'ok', 10, 5, 1.5) returning id`, [businessId]);
await fails(db.query(`update public.ai_usage set cost_kes = 0 where id = $1`, [u.id]), /can't be changed/, 'settled usage can’t change');
await fails(db.query(`delete from public.ai_usage where id = $1`, [u.id]), /can't be deleted/, 'usage can’t be deleted');

// Down: refuses while anything exists, nothing changes; after a deliberate truncate it drops cleanly
await fails(db.exec(readSql(DOWN)), /Refusing rollback of 014: 1 AI usage record\(s\), 1 AI allowance\(s\), 1 AI setting row\(s\)/, 'down refuses while data exists');
eq((await one(`select count(*)::int as n from public.ai_usage`)).n, 1, 'the refusal changed nothing');
await db.exec('truncate public.ai_usage, public.ai_limits, public.ai_business_settings');
await db.exec(readSql(DOWN));
eq((await one(`select to_regclass('public.ai_usage') is null and to_regclass('public.ai_limits') is null and to_regclass('public.ai_business_settings') is null as gone`)).gone, true, 'down drops the three tables');
eq((await one(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'ai_usage_guard'`)).n, 0, 'and the guard function');
eq(await counts(), before, 'the rest of the database is as it was');
await db.exec(readSql(DOWN));                       // down on a database without 014 is a no-op
await db.exec(readSql(UP));
eq((await one(`select count(*)::int as n from public.ai_usage`)).n, 0, 'up again after down works');
void users; void helpers;
console.log(`migration-014: ${checks} checks passed`);
