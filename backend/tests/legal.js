// Terms and conditions (proposed migration 010) on a disposable PGlite database.
// Usage: node backend/tests/legal.js
import assert from 'node:assert/strict';
import { asUser, createUser, freshDatabase, readSql } from './support/pg.js';
import { accept, adminView, current, publish, saveDraft, status } from '../src/lib/legal.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fails = async (promise, test, m) => { await assert.rejects(promise, (e) => { if (typeof test === 'number') assert.equal(e.status, test, `${m}: ${e.status} ${e.message}`); else assert.match(e.message, test, m); return true; }); checks++; };

const db = await freshDatabase();
await db.exec(readSql('migrations/010_legal_terms.sql')); // idempotent re-run
const admin = await createUser(db, 'admin@example.test', { role: 'admin' });
const oldUser = await createUser(db, 'old@example.test', { role: 'owner' });
const tx = (fn) => db.transaction(fn);

eq(await current(db, 'terms'), null, 'nothing published yet');
eq((await status(db, oldUser, { role: 'owner', createdAt: new Date().toISOString() })).required, false, 'no terms → nothing to accept');
await fails(tx((t) => publish(t, admin, 'terms')), 400, 'publishing needs a draft');
await fails(tx((t) => saveDraft(t, admin, 'terms', { title: '', body: 'x' })), 400, 'title required');
await fails(tx((t) => saveDraft(t, admin, 'privacy', { title: 'x', body: 'x' })), 404, 'unknown document kind');
await tx((t) => saveDraft(t, admin, 'terms', { title: 'Terms and conditions', body: '' }));
await fails(tx((t) => publish(t, admin, 'terms')), 400, 'empty terms cannot be published');

await tx((t) => saveDraft(t, admin, 'terms', { title: 'Terms and conditions', body: '# Using Cravio\nBe kind.' }));
const v1 = await tx((t) => publish(t, admin, 'terms', { requireExisting: false }));
eq(v1.version, 1, 'first version');
await fails(tx((t) => publish(t, admin, 'terms')), 409, 'unchanged draft is not republished');
const before = new Date(Date.now() - 86_400_000).toISOString();
eq((await status(db, oldUser, { role: 'owner', createdAt: before })).required, false, 'v1 without require_existing: existing accounts not asked');
const newUser = await createUser(db, 'new@example.test');
eq((await status(db, newUser, { role: null, createdAt: new Date(Date.now() + 1000).toISOString() })).required, true, 'new accounts must accept');
eq((await status(db, admin, { role: 'admin', createdAt: new Date(Date.now() + 1000).toISOString() })).required, false, 'admins are never asked');

await fails(tx((t) => accept(t, newUser, 'terms', 2)), 409, 'accepting a version that is not current is refused');
await tx((t) => accept(t, newUser, 'terms', 1));
await tx((t) => accept(t, newUser, 'terms', 1));
eq((await status(db, newUser, { role: null, createdAt: new Date().toISOString() })).required, false, 'accepted (idempotent)');

await tx((t) => saveDraft(t, admin, 'terms', { title: 'Terms and conditions', body: '# Using Cravio\nBe kind.\n\n## Payments\nCash or M-Pesa.' }));
const v2 = await tx((t) => publish(t, admin, 'terms', { requireExisting: true }));
eq(v2.version, 2, 'second version');
eq((await status(db, oldUser, { role: 'owner', createdAt: before })).required, true, 'v2 requires existing accounts to accept');
eq((await status(db, newUser, { role: null, createdAt: before })).required, true, 'acceptance of v1 does not cover v2');

const view = await adminView(db, 'terms');
eq(view.versions.map((v) => [v.version, v.accepted]), [[2, 0], [1, 1]], 'admin sees versions with acceptance counts');
eq(view.current.version, 2, 'current version');

// Append-only, public reading, private acceptances
await fails(db.query(`update public.legal_documents set body = 'changed'`), /can’t be changed/, 'published versions are immutable');
await fails(db.query(`delete from public.legal_acceptances`), /can’t be changed/, 'acceptances cannot be deleted');
const anon = await db.transaction(async (t) => { await t.exec('set local role anon'); return (await t.query('select version from public.legal_documents order by version')).rows; });
eq(anon.map((r) => r.version), [1, 2], 'anyone can read published terms');
await fails(db.transaction(async (t) => { await t.exec('set local role anon'); await t.query('select * from public.legal_drafts'); }), /permission denied/, 'drafts are not public');
eq((await asUser(db, oldUser, (t) => t.query('select * from public.legal_acceptances'))).rows.length, 0, 'users see only their own acceptances');

console.log(`Terms and conditions: ${checks} checks passed (disposable PGlite database).`);
await db.close();
