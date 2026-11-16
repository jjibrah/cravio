// Rehearses proposed migration 008 on a disposable in-process Postgres (never the shared database).
// Fixture mirrors the shape of the audited data: two restaurants, a legacy owner per restaurant, waiters, orders.
// Usage: node backend/tests/migration-008.js
import assert from 'node:assert/strict';
import { asUser, createUser, freshDatabase, readSql } from './support/pg.js';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const equal = (a, b, message) => { assert.equal(a, b, message); checks++; };
const rejects = async (promise, pattern, message) => { await assert.rejects(promise, pattern, message); checks++; };
const UP = 'proposed/008_business_branches.sql';
const DOWN = 'proposed/008_business_branches.down.sql';

const db = await freshDatabase();
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

// ---- Pre-migration fixture (007 shape) ----
const ownerA = await createUser(db, 'owner-a@example.test', { role: 'owner' });
const ownerB = await createUser(db, 'owner-b@example.test', { role: 'owner' });
const waiterA = await createUser(db, 'waiter-a@example.test', { role: 'waiter' });
const outsider = await createUser(db, 'outsider@example.test', { role: 'owner' });
const restA = (await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Alpha Grill', 'live') returning id`, [ownerA])).id;
// Same name on purpose: the migration must not group restaurants by name.
const restB = (await one(`insert into public.restaurants (owner_id, name) values ($1, 'Alpha Grill') returning id`, [ownerB])).id;
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'waiter'), ($4, $5, 'owner')`, [restA, ownerA, waiterA, restB, ownerB]);
const table = (await one(`insert into public.restaurant_tables (restaurant_id, number) values ($1, 7) returning id`, [restA])).id;
const order = (await one(`insert into public.orders (restaurant_id, table_id, table_number, taken_by) values ($1, $2, 7, $3) returning id`, [restA, table, waiterA])).id;
const before = await one(`select string_agg(id::text || owner_id::text || name, ',' order by id) as sig from public.restaurants`);

// ---- Apply 008 ----
await db.exec(readSql(UP));
const after = await one(`select string_agg(id::text || owner_id::text || name, ',' order by id) as sig from public.restaurants`);
equal(after.sig, before.sig, 'restaurant ids, owners and names unchanged');
equal((await one(`select count(*)::int as n from public.restaurants where business_id is null`)).n, 0, 'every restaurant has a business');
equal((await one(`select count(distinct business_id)::int as n from public.restaurants`)).n, 2, 'same-named restaurants are NOT grouped');
equal((await one(`select count(*)::int as n from public.business_members`)).n, 0, 'migration grants nobody business access');
equal((await one(`select id from public.orders where id = $1`, [order])).id, order, 'orders untouched');
equal((await one(`select count(*)::int as n from public.restaurant_members`)).n, 3, 'memberships untouched');

// ---- Idempotent ----
await db.exec(readSql(UP));
equal((await one(`select count(*)::int as n from public.businesses`)).n, 2, 're-run creates no extra businesses');

// ---- Compatibility with the main baseline (which knows nothing about businesses) ----
await rejects(db.query(`insert into public.restaurants (owner_id, name) values ($1, 'Second legacy')`, [ownerA]), /restaurants_one_primary_per_owner/, 'main: one legacy restaurant per owner still conflicts (23505)');
const legacy = await one(`insert into public.restaurants (owner_id, name) values ($1, 'Outsider Diner') returning id, business_id, owner_primary`, [outsider]);
ok(legacy.business_id && legacy.owner_primary, 'main-created restaurant gets its own business automatically');
const businessA = (await one(`select business_id from public.restaurants where id = $1`, [restA])).business_id;
const branch2 = (await one(`insert into public.restaurants (owner_id, name, business_id, owner_primary) values ($1, 'Alpha Grill Westlands', $2, false) returning id`, [ownerA, businessA])).id;
ok(branch2, 'a business can add further branches for the same owner');

// ---- Grants ----
const opsManager = await createUser(db, 'ops@example.test');
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'operations')`, [businessA, ownerA, opsManager]);
await db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessA, opsManager, branch2]);
const businessB = (await one(`select business_id from public.restaurants where id = $1`, [restB])).business_id;
await rejects(db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessA, opsManager, restB]), /foreign key/, 'cannot assign a branch of another business');
await rejects(db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessB, opsManager, restB]), /foreign key/, 'cannot assign branches without a business grant');

// ---- Helpers and RLS ----
const oversees = (user, restaurant) => asUser(db, user, async (tx) => (await tx.query(`select private.oversees_branch($1) as v`, [restaurant])).rows[0].v);
equal(await oversees(ownerA, restA), true, 'business owner oversees branch A');
equal(await oversees(ownerA, branch2), true, 'business owner oversees new branch');
equal(await oversees(ownerA, restB), false, 'business owner does not oversee another business');
equal(await oversees(opsManager, branch2), true, 'operations manager oversees assigned branch');
equal(await oversees(opsManager, restA), false, 'operations manager does not oversee unassigned branch');
equal(await oversees(ownerB, restB), false, 'legacy owner without a grant has no business oversight');
equal(await oversees(waiterA, restA), false, 'waiter has no business oversight');

const visible = (user, sql) => asUser(db, user, async (tx) => (await tx.query(sql)).rows);
equal((await visible(ownerB, 'select * from public.businesses')).length, 0, 'no grant: sees no businesses');
equal((await visible(ownerA, 'select * from public.businesses')).length, 1, 'owner sees own business only');
equal((await visible(opsManager, 'select * from public.business_members')).length, 1, 'operations sees only own grant');
equal((await visible(ownerA, 'select * from public.business_members')).length, 2, 'owner sees grants in own business');
equal((await visible(opsManager, 'select * from public.business_member_branches')).length, 1, 'operations sees own branch rows');
await rejects(asUser(db, ownerA, (tx) => tx.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [businessB, ownerA])), /permission denied/, 'browser clients cannot grant themselves access');
await rejects(asUser(db, ownerA, (tx) => tx.query(`update public.restaurants set business_id = $1 where id = $2`, [businessB, restA])), /permission denied/, 'browser clients cannot move a branch between businesses');
await rejects(asUser(db, ownerA, (tx) => tx.query(`select * from public.access_events`)), /permission denied/, 'access events are API-only');
equal((await visible(waiterA, `select id from public.restaurants`)).length, 1, '002 membership RLS still works for waiters');

// ---- Audit log is append-only ----
await db.query(`insert into public.access_events (business_id, actor_id, subject_id, action) values ($1, $2, $3, 'business_grant')`, [businessA, ownerA, opsManager]);
await rejects(db.query(`delete from public.access_events`), /append-only/, 'access events cannot be deleted');
await rejects(db.query(`update public.access_events set action = 'business_revoke'`), /append-only/, 'access events cannot be edited');

// ---- Rollback ----
await rejects(db.exec(readSql(DOWN)), /business grants or access events exist/, 'rollback refuses while grants exist');
// Deliberate clean-up as the rollback runbook describes (triggers bypassed only for this rehearsal).
await db.exec(`alter table public.access_events disable trigger access_events_no_change; delete from public.access_events;
  delete from public.business_member_branches; delete from public.business_members;`);
await rejects(db.exec(readSql(DOWN)), /several restaurants/, 'rollback refuses while an owner has several restaurants');
await db.query(`delete from public.restaurants where id = $1`, [branch2]);
await db.exec(readSql(DOWN));
equal((await one(`select to_regclass('public.businesses') is null as gone`)).gone, true, 'rollback removes businesses');
equal((await one(`select count(*)::int as n from information_schema.columns where table_name = 'restaurants' and column_name in ('business_id', 'owner_primary')`)).n, 0, 'rollback removes new columns');
await rejects(db.query(`insert into public.restaurants (owner_id, name) values ($1, 'Dup')`, [ownerA]), /restaurants_one_per_owner/, 'rollback restores the 007 unique index');
equal((await one(`select count(*)::int as n from public.orders`)).n, 1, 'rollback keeps orders');
await db.exec(readSql(UP));
equal((await one(`select count(*)::int as n from public.restaurants where business_id is null`)).n, 0, 're-apply after rollback works');

console.log(`Migration 008 rehearsal: ${checks} checks passed (disposable PGlite database).`);
await db.close();
