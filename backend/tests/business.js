// Owner/operations data layer against a disposable PGlite database with proposed migration 008.
// Covers business isolation, ID substitution, assigned-branch scope and grant rules.
// Usage: node backend/tests/business.js
import assert from 'node:assert/strict';
import { createUser, freshDatabase } from './support/pg.js';
import { addBranchStaff, branchDetail, createBranch, overview, people, requireOverseen, revokeOperations, setOperations } from '../src/lib/business.js';

let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const fails = async (promise, status, message) => {
  await assert.rejects(promise, (error) => { assert.equal(error.status, status, `${message}: got ${error.status} ${error.message}`); return true; }, message);
  checks++;
};

const db = await freshDatabase();
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const owner = await createUser(db, 'owner@example.test', { role: 'owner' });
const ops = await createUser(db, 'ops@example.test');
const manager = await createUser(db, 'manager@example.test', { role: 'owner' });
const otherOwner = await createUser(db, 'other@example.test', { role: 'owner' });
const waiter = await createUser(db, 'waiter@example.test', { role: 'waiter' });

const main = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Main Street', 'live') returning id, business_id`, [owner]);
const other = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Rival Diner', 'live') returning id, business_id`, [otherOwner]);
await db.query(`insert into public.restaurant_members values ($1, $2, 'owner'), ($1, $3, 'waiter'), ($4, $5, 'owner')`, [main.id, owner, waiter, other.id, otherOwner]);
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')`, [main.business_id, owner, other.business_id, otherOwner]);
await db.query(`insert into public.orders (restaurant_id, status, total, accepted_at, served_at, paid_at) values ($1, 'paid', 450, now(), now(), now()), ($1, 'taken', 200, null, null, null)`, [main.id]);

// Owner creates a second branch, managing it themselves
const branch2 = await db.transaction((tx) => createBranch(tx, owner, main.business_id, { name: 'Westlands', area: 'Westlands', manageItMyself: true }));
eq(branch2.status, 'onboarding', 'new branch starts in onboarding');
await fails(db.transaction((tx) => createBranch(tx, otherOwner, main.business_id, { name: 'Hijack' })), 403, 'other business owner cannot add branches here');
await fails(db.transaction((tx) => createBranch(tx, owner, main.business_id, { name: '  ' })), 400, 'branch name required');

// Overview
const home = await overview(db, owner);
eq(home.businesses.length, 1, 'owner sees only their business');
eq(home.businesses[0].branches.map((b) => b.name).sort(), ['Main Street', 'Westlands'], 'owner sees all branches');
const mainStats = home.businesses[0].branches.find((b) => b.id === main.id);
eq([mainStats.today.orders, mainStats.today.paidSales, mainStats.today.openOrders], [2, 450, 1], 'today activity is computed from recorded orders');
eq(mainStats.canOpenWorkspace, true, 'owner with branch membership can open the branch workspace');
eq((await overview(db, otherOwner)).businesses[0].branches.map((b) => b.id), [other.id], 'second business isolated');
eq((await overview(db, manager)).businesses, [], 'legacy owner without grant has no owner overview');
eq((await overview(db, waiter)).businesses, [], 'waiter has no owner overview');

// Operations manager: grant, scope, ID substitution
await fails(db.transaction((tx) => setOperations(tx, ops, main.business_id, ops, [main.id])), 403, 'cannot grant yourself');
await fails(db.transaction((tx) => setOperations(tx, owner, main.business_id, ops, [other.id])), 400, 'cannot assign another business’s branch');
await fails(db.transaction((tx) => setOperations(tx, owner, main.business_id, owner, [main.id])), 400, 'owner cannot change own access');
await db.transaction((tx) => setOperations(tx, owner, main.business_id, ops, [branch2.id]));
const opsHome = await overview(db, ops);
eq(opsHome.businesses[0].branches.map((b) => b.id), [branch2.id], 'operations sees only assigned branch');
eq(opsHome.businesses[0].branches[0].canOpenWorkspace, false, 'operations without branch role cannot open the workspace');
await fails(branchDetail(db, ops, main.id), 404, 'operations cannot read an unassigned branch');
await fails(branchDetail(db, owner, other.id), 404, 'owner cannot read another business’s branch (ID substitution)');
await fails(requireOverseen(db, owner, 'not-a-uuid'), 400, 'malformed id rejected');
eq((await branchDetail(db, ops, branch2.id)).staff.map((s) => s.role), ['manager'], 'branch detail lists staff');
eq((await branchDetail(db, owner, main.id)).last7Days.length, 7, 'seven-day series');
await fails(db.transaction((tx) => setOperations(tx, ops, main.business_id, manager, [branch2.id])), 403, 'operations cannot grant others');
await fails(people(db, ops, other.business_id), 404, 'operations cannot list another business');
const opsPeople = await people(db, ops, main.business_id);
eq([opsPeople.canManageAccess, opsPeople.businessAccess.length, opsPeople.branches.length], [false, 1, 1], 'operations sees only their own grant and branch');
const ownerPeople = await people(db, owner, main.business_id);
eq(ownerPeople.businessAccess.find((p) => p.userId === ops).branchIds, [branch2.id], 'owner sees operations assignments');

// Reassign and revoke, with audit trail
await db.transaction((tx) => setOperations(tx, owner, main.business_id, ops, [main.id]));
eq((await overview(db, ops)).businesses[0].branches.map((b) => b.id), [main.id], 'reassignment replaces branch set');
await db.transaction((tx) => revokeOperations(tx, owner, main.business_id, ops));
eq((await overview(db, ops)).businesses, [], 'revoked operations manager loses access');
await fails(db.transaction((tx) => revokeOperations(tx, owner, main.business_id, otherOwner)), 404, 'cannot revoke someone outside the business');
const actions = (await db.query(`select action from public.access_events where business_id = $1 order by id`, [main.business_id])).rows.map((r) => r.action);
eq(actions, ['branch_member_add', 'branch_create', 'business_grant', 'branch_assign', 'branch_assign', 'branch_unassign', 'business_revoke'], 'every access change is audited');

// Branch staff
await db.transaction((tx) => addBranchStaff(tx, owner, branch2.id, manager, 'manager'));
await fails(db.transaction((tx) => addBranchStaff(tx, owner, branch2.id, manager, 'waiter')), 409, 'existing staff not silently re-roled');
await fails(db.transaction((tx) => addBranchStaff(tx, otherOwner, branch2.id, waiter, 'waiter')), 404, 'other business cannot add staff');
await fails(db.transaction((tx) => addBranchStaff(tx, owner, branch2.id, waiter, 'owner')), 400, 'cannot add branch owners');
eq((await one(`select role from public.restaurant_members where restaurant_id = $1 and user_id = $2`, [branch2.id, manager])).role, 'manager', 'manager added');
eq((await overview(db, manager)).businesses, [], 'branch manager role gives no business access');

console.log(`Owner/operations data layer: ${checks} checks passed (disposable PGlite database).`);
await db.close();
