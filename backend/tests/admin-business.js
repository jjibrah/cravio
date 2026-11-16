// Platform admin business layer on a disposable PGlite database (migrations through 009).
// Usage: node backend/tests/admin-business.js
import assert from 'node:assert/strict';
import { createUser, freshDatabase } from './support/pg.js';
import { accessByUser, activity, addBranch, businessDetail, grantOwner, listBusinesses, renameBusiness, revokeAccess } from '../src/lib/admin-business.js';
import { overview } from '../src/lib/business.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fails = async (promise, status, m) => { await assert.rejects(promise, (e) => { assert.equal(e.status, status, `${m}: ${e.status} ${e.message}`); return true; }); checks++; };

const db = await freshDatabase();
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const adminId = await createUser(db, 'admin@example.test', { role: 'admin' });
const legacy = await createUser(db, 'legacy@example.test', { role: 'owner' });
const newOwner = await createUser(db, 'new-owner@example.test');
const waiter = await createUser(db, 'waiter@example.test', { role: 'waiter' });
const r1 = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Kilimani Grill', 'live') returning id, business_id`, [legacy]);
await db.query(`insert into public.restaurant_members values ($1, $2, 'owner'), ($1, $3, 'waiter')`, [r1.id, legacy, waiter]);
await db.query(`insert into public.orders (restaurant_id, status, total, accepted_at, served_at, paid_at) values ($1, 'paid', 800, now(), now(), now())`, [r1.id]);
const biz = r1.business_id;

// List
let list = await listBusinesses(db);
eq([list.counts.all, list.counts.live, list.counts.noOwner], [1, 1, 1], 'business without an owner is flagged');
eq([list.businesses[0].branches.length, list.businesses[0].orders30d, list.businesses[0].paid30d, list.businesses[0].staff], [1, 1, 800, 2], 'branch figures roll up');
eq(list.stockAvailable, true, 'inventory counts available after 009');

// Branch needs an owner; grant; idempotency and refusals
await fails(db.transaction((t) => addBranch(t, adminId, biz, { name: 'Westlands' })), 409, 'a branch needs a business owner first');
await fails(db.transaction((t) => grantOwner(t, adminId, biz, adminId)), 400, 'platform admin cannot own a business');
await db.transaction((t) => grantOwner(t, adminId, biz, newOwner));
await fails(db.transaction((t) => grantOwner(t, adminId, biz, newOwner)), 409, 'already an owner');
await fails(db.transaction((t) => grantOwner(t, adminId, '00000000-0000-4000-8000-000000000000', newOwner)), 404, 'unknown business');
eq((await overview(db, newOwner)).businesses[0].branches.length, 1, 'granted owner sees the business in the owner platform');
const branch = await db.transaction((t) => addBranch(t, adminId, biz, { name: 'Westlands', area: 'Westlands' }));
eq([branch.status, (await one('select owner_id from public.restaurants where id = $1', [branch.id])).owner_id], ['onboarding', newOwner], 'new branch belongs to the business owner');

// Detail, rename, access map
const detail = await businessDetail(db, biz);
eq([detail.branches.length, detail.access.map((a) => a.role), detail.stock.items], [2, ['owner'], 0], 'detail: branches, access, inventory counts');
eq(detail.branches.find((b) => b.id === r1.id).staff.map((s) => s.role).sort(), ['manager', 'waiter'], 'branch staff with v2 roles');
eq((await db.transaction((t) => renameBusiness(t, biz, '  Kilimani   Group '))).name, 'Kilimani Group', 'rename trims');
await fails(db.transaction((t) => renameBusiness(t, biz, '')), 400, 'empty name refused');
const map = await accessByUser(db);
eq(map.get(newOwner).businesses[0].role, 'owner', 'access map has business grants');
eq(map.get(legacy).branches[0].role, 'manager', 'legacy owner membership reads as branch manager');

// Revoke and the audit trail
await db.transaction((t) => revokeAccess(t, adminId, biz, newOwner));
eq((await overview(db, newOwner)).businesses, [], 'revoked owner loses the owner platform');
await fails(db.transaction((t) => revokeAccess(t, adminId, biz, newOwner)), 404, 'nothing to revoke');
const log = await activity(db, { businessId: biz });
eq(log.map((e) => e.action), ['business_revoke', 'branch_create', 'business_grant'], 'every admin change is in the activity log');
eq([log[0].viaAdmin, log[0].actor.email, log[0].subject.email], [true, 'admin@example.test', 'new-owner@example.test'], 'log names the admin and the person');
eq((await activity(db, { before: log[1].id })).map((e) => e.id), [log[2].id], 'activity pages backwards');
list = await listBusinesses(db);
eq(list.counts.noOwner, 1, 'no owner again after revoke');

console.log(`Admin business layer: ${checks} checks passed (disposable PGlite database).`);
await db.close();
