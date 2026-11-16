// Reviewed access mapping on a disposable PGlite database with proposed migration 008.
// Usage: node backend/tests/access-mapping.js
import assert from 'node:assert/strict';
import { createUser, freshDatabase } from './support/pg.js';
import { applyAccessMapping } from '../src/lib/access-mapping.js';
import { overview } from '../src/lib/business.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const db = await freshDatabase();
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const owner = await createUser(db, 'owner@example.test', { role: 'owner' });
const second = await createUser(db, 'second@example.test', { role: 'owner' });
const ops = await createUser(db, 'ops@example.test');
const a = (await one(`insert into public.restaurants (owner_id, name) values ($1, 'Alpha') returning id`, [owner])).id;
const b = (await one(`insert into public.restaurants (owner_id, name) values ($1, 'Beta') returning id`, [second])).id;
await db.query(`insert into public.restaurant_members values ($1, $2, 'owner'), ($3, $4, 'owner')`, [a, owner, b, second]);
const run = (mapping) => db.transaction((tx) => applyAccessMapping(tx, mapping));
const refuses = async (mapping, pattern, m) => { await assert.rejects(run(mapping), pattern, m); checks++; };

await refuses({ businesses: [{ restaurantIds: [a], owners: ['nobody@example.test'] }] }, /No Cravio account/, 'unknown email aborts');
await refuses({ businesses: [{ restaurantIds: [a], operations: [{ email: 'ops@example.test', branchIds: [b] }] }] }, /not in this business entry/, 'branch outside entry aborts');
await refuses({ businesses: [{ restaurantIds: [a] }, { restaurantIds: [a] }] }, /appears twice/, 'duplicate restaurant aborts');
eq((await one('select count(*)::int as n from public.business_members')).n, 0, 'aborted runs leave nothing behind');

const changes = await run({ businesses: [{ name: 'Alpha Group', restaurantIds: [a, b], owners: ['owner@example.test'], operations: [{ email: 'ops@example.test', branchIds: [b] }] }] });
eq(changes.length, 4, 'move, rename, owner, operations reported');
eq((await one('select count(distinct business_id)::int as n from public.restaurants')).n, 1, 'restaurants grouped as mapped');
eq((await one('select count(*)::int as n from public.businesses')).n, 1, 'empty auto-business removed');
eq((await overview(db, owner)).businesses[0].branches.length, 2, 'mapped owner oversees both branches');
eq((await overview(db, ops)).businesses[0].branches.map((x) => x.id), [b], 'mapped operations manager sees assigned branch');
eq((await overview(db, second)).businesses, [], 'legacy owner of Beta gets no business access unless mapped');
eq((await one(`select role from public.restaurant_members where restaurant_id = $1 and user_id = $2`, [b, second])).role, 'owner', 'branch membership unchanged');
eq((await run({ businesses: [{ restaurantIds: [a], owners: ['owner@example.test'] }] }))[0], 'Confirmed business owner: owner@example.test', 're-run is idempotent');
eq((await one(`select count(*)::int as n from public.access_events where action = 'mapping_applied'`)).n, 2, 'mapping runs are audited');
console.log(`Access mapping: ${checks} checks passed (disposable PGlite database).`);
await db.close();
