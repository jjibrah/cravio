// Unit tests for v2 branch selection and landing rules (no database).
// Usage: node backend/tests/access.js
import assert from 'node:assert/strict';
import { homePath, requestedBranch, selectMembership } from '../src/lib/access.js';

let checks = 0;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const row = (id, role, created = '2026-01-01') => ({ role, created_at: created, restaurant: { id, name: id.slice(0, 4), status: 'live' } });
const status = (fn) => { try { fn(); return 'ok'; } catch (error) { return `${error.status}:${error.details?.code}`; } };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const header = (value) => ({ headers: value === undefined ? {} : { 'x-cravio-branch': value } });

// Header parsing
eq(requestedBranch(header()), null, 'no header');
eq(requestedBranch(header(A.toUpperCase())), A, 'header normalised');
eq(status(() => requestedBranch(header('../etc'))), '400:branch_invalid', 'malformed header rejected');

// Single branch: implicit selection keeps today’s behaviour
eq(selectMembership([row(A, 'owner')], null).restaurant.id, A, 'single membership used implicitly');
eq(selectMembership([], null), null, 'no membership → null');

// Several branches: must choose; never guess
const multi = [row(A, 'manager'), row(B, 'owner'), row(C, 'waiter')];
eq(status(() => selectMembership(multi, null)), '409:branch_required', 'several branches require a choice');
eq(selectMembership(multi, A).role, 'manager', 'explicit branch honoured');
eq(status(() => selectMembership(multi, '44444444-4444-4444-8444-444444444444')), '403:branch_forbidden', 'unknown branch refused (ID substitution)');
eq(status(() => selectMembership(multi, C, ['owner', 'manager'])), '403:role_forbidden', 'waiter branch refused for manager action');
eq(selectMembership(multi, null, ['waiter']).restaurant.id, C, 'only one eligible branch for the role → implicit');
eq(status(() => selectMembership(multi, null, ['owner', 'manager'])), '409:branch_required', 'two managed branches require a choice');

// Landing
eq(homePath({ profileRole: 'admin', memberships: [], grants: [] }), '/admin', 'admin');
eq(homePath({ profileRole: 'owner', memberships: [row(A, 'owner')], grants: [] }), `/branch/${A}`, 'legacy owner → branch manager area');
eq(homePath({ profileRole: 'owner', memberships: [row(A, 'owner')], grants: undefined }), `/branch/${A}`, 'before migration 008 → branch manager area');
eq(homePath({ profileRole: 'owner', memberships: [row(A, 'owner')], grants: [{ businessId: 'x', role: 'owner' }] }), '/owner', 'reviewed business owner → owner interface');
eq(homePath({ profileRole: null, memberships: [], grants: [{ businessId: 'x', role: 'operations', branchIds: [A] }] }), '/owner', 'operations manager without branch role');
eq(homePath({ profileRole: 'owner', memberships: [row(A, 'manager'), row(B, 'owner')], grants: [] }), '/branch', 'several managed branches → chooser');
eq(homePath({ profileRole: 'waiter', memberships: [row(A, 'waiter')], grants: [] }), '/waiter', 'waiter');
eq(homePath({ profileRole: 'owner', memberships: [], grants: [], onboardingRequired: true }), '/onboarding', 'onboarding first');
eq(homePath({ profileRole: null, memberships: [], grants: [] }), '/account', 'no access');

console.log(`Access rules: ${checks} checks passed.`);
