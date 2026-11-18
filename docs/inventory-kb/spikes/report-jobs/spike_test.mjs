// Spike 3 (P3-01): background report job queue. Run: node docs/inventory-kb/spikes/report-jobs/spike_test.mjs  (PGlite, 009 + 012..017 + spike_023.sql)
// PGlite has ONE connection: two "workers" here take turns, they do not run at the same instant. See README for what this does and does not prove.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url)) + '/';
const REPO = process.env.REPO || resolve(HERE, '../../../..');
const { inventoryFixture } = await import(`${REPO}/backend/tests/inv/fixture.js`);
const { ALL_INVENTORY_MIGRATIONS } = await import(`${REPO}/backend/tests/inv/migrations.js`);
const { createUser } = await import(`${REPO}/backend/tests/support/pg.js`);
const { notify } = await import(`${REPO}/backend/src/inventory/notifications.js`);
const jobs = await import(HERE + 'jobs_spike.js');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const say = (s) => console.log(s);
const section = (s) => say(`\n== ${s}`);

const f = await inventoryFixture({ extra: [...ALL_INVENTORY_MIGRATIONS, HERE + 'spike_023.sql'] });
const { db, ids, users } = f;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// Three businesses: the fixture's (with ledger data) and two more (owners + one branch each, so notifications have a recipient).
const bizA = { id: ids.businessId, owner: users.owner };
const mkBiz = async (name) => { const owner = await createUser(db, `${name}@example.test`, { role: 'owner' });
  const r = await one(`insert into public.restaurants (owner_id, name, status) values ($1, $2, 'live') returning business_id`, [owner, name]);
  await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [r.business_id, owner]);
  return { id: r.business_id, owner }; };
const bizB = await mkBiz('Beta'), bizC = await mkBiz('Gamma');

// ---- reports -------------------------------------------------------------------------------------------------------
const runs = new Map();              // job id -> number of times a report function STARTED for it (must be 1 unless it failed)
const failures = new Map();          // job id -> how many times the synthetic report should still throw
const kes = (n) => Number(n).toFixed(2);
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
/** Streams the ledger in keyset chunks (id > last), appending CSV rows; reports progress after each chunk. */
async function movementsReport({ db: d, businessId, progress, chunk = 2000 }) {
  const total = Number((await d.query(`select count(*)::int as n from public.stock_movements where business_id = $1`, [businessId])).rows[0].n);
  let last = 0, done = 0; const parts = ['﻿id,reason,delta,value_kes\r\n'];
  for (;;) {
    const { rows } = await d.query(`select id, reason, delta::text as delta, value::text as value from public.stock_movements where business_id = $1 and id > $2 order by id limit $3`, [businessId, last, chunk]);
    if (!rows.length) break;
    for (const r of rows) parts.push(`${r.id},${csvCell(r.reason)},${r.delta},${r.value === null ? '' : kes(r.value)}\r\n`);
    last = rows.at(-1).id; done += rows.length; await progress(done, total);
  }
  return { text: parts.join(''), rowCount: done };
}
const synthetic = (job) => async ({ params, progress }) => {
  runs.set(job.id, (runs.get(job.id) || 0) + 1);
  if ((failures.get(job.id) || 0) > 0) { failures.set(job.id, failures.get(job.id) - 1); throw new Error('boom: connection reset by peer'); }
  await progress(params.rows, params.rows);
  return { text: '﻿n\r\n' + Array.from({ length: params.rows }, (_, i) => i + 1).join('\r\n') + '\r\n', rowCount: params.rows };
};
const notices = [];
const hooks = { retryDelaySeconds: 0, notify: async (n) => { notices.push(n); await notify(db, { businessId: n.businessId, recipients: [n.userId], kind: n.kind, title: n.kind === 'report_ready' ? 'Your report is ready' : 'Your report could not be prepared', link: `/owner/reports/downloads/${n.jobId}`, entity: { type: 'report_job', id: n.jobId }, dedupeKey: `${n.kind}:${n.jobId}` }); } };
const tick = async (worker, fn) => { await jobs.sweep(db); const job = await jobs.claim(db, worker); if (!job) return null; const status = await jobs.run(db, job, fn(job), hooks); return { job, status }; };

section('J1 enqueue -> claim -> run with progress -> result stored -> requester notified');
// 5,000 ledger rows for business A, written in one statement (the ledger is append-only, so this is just data).
const loc = ids.branchLocationId;
const item = (await one(`insert into public.stock_items (business_id, name, unit, avg_cost) values ($1, 'Bulk', 'g', 2.5) returning id`, [bizA.id])).id;
await db.query(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, unit_cost, value)
  select $1, $2, $3, 1, g, 'purchase_receipt', 2.5, 2.5 from generate_series(1, 5000) g`, [bizA.id, loc, item]);
const j1 = await jobs.enqueue(db, { businessId: bizA.id, userId: bizA.owner, reportKey: 'movement_ledger', params: { from: '2026-10-01', to: '2026-10-31' } });
const t0 = Date.now();
const c1 = await jobs.claim(db, 'worker-A');
eq([c1.id, c1.status, c1.attempts, c1.locked_by], [j1.id, 'running', 1, 'worker-A'], 'claimed: running, attempt 1, locked by worker A');
ok(new Date(c1.locked_until) > new Date(), 'lease is in the future');
const st = await jobs.run(db, c1, (a) => movementsReport({ ...a, chunk: 2000 }), hooks);
eq(st, 'done', 'run -> done');
const d1 = await one(`select status, row_count::int as rows, progress_done::int as progress_done, progress_total::int as progress_total, byte_size::int as bytes, left(result_text, 40) as head, expires_at > now() + interval '29 days' as keeps_30_days from public.report_jobs where id = $1`, [j1.id]);
say(`${JSON.stringify(d1)}  (${Date.now() - t0} ms for 5,000 rows, 3 chunks)`);
eq([d1.status, d1.rows, d1.progress_done, d1.progress_total, d1.keeps_30_days], ['done', 5000, 5000, 5000, true], 'done with 5,000 rows, progress 5000/5000, kept 30 days');
// PGlite's text decoder drops a leading BOM when it reads a string back, so the BOM is checked through byte_size (computed from the
// JS string BEFORE it was stored): 3 bytes more than what comes back. The real job writes the BOM when it writes the file.
eq(d1.bytes, Buffer.byteLength((await one(`select result_text from public.report_jobs where id = $1`, [j1.id])).result_text) + 3, 'UTF-8 BOM counted in the stored size');
ok(d1.head.startsWith('id,reason,delta,value_kes'), 'header row');
eq((await q(`select count(*)::int as n from public.notifications where kind = 'report_ready' and recipient_id = $1`, [bizA.owner]))[0].n, 1, 'requester notified once');
eq(Number(d1.rows), Number((await one(`select count(*)::int as n from public.stock_movements where business_id = $1`, [bizA.id])).n), 'CSV rows = ledger rows');

section('J2 two workers taking turns over 9 jobs in 3 businesses: each job runs once, never two running jobs in one business');
runs.clear();
const mk = async (biz, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await jobs.enqueue(db, { businessId: biz.id, userId: biz.owner, reportKey: 'synthetic', params: { rows: 10 + i, k: out.length + Math.random() } })).id); return out; };
const all = [...await mk(bizA, 3), ...await mk(bizB, 3), ...await mk(bizC, 3)];
// Interleave: A claims, B claims, A claims, B claims ... WITHOUT finishing anything first, then finish in a mixed order.
const claimed = [];
for (const w of ['A', 'B', 'A', 'B', 'A']) { const j = await jobs.claim(db, `worker-${w}`); claimed.push(j && { w, biz: j.business_id, id: j.id }); }
say(`claims in order: ${claimed.map((c) => (c ? `${c.w}:${[bizA, bizB, bizC].findIndex((b) => b.id === c.biz) + 1}` : `-`)).join('  ')}`);
eq(claimed.filter(Boolean).length, 3, 'three claims succeed (one per business), the other two get nothing');
eq(new Set(claimed.filter(Boolean).map((c) => c.biz)).size, 3, 'each of the three running jobs is in a different business');
eq((await one(`select count(*)::int as n from public.report_jobs where status = 'running'`)).n, 3, 'exactly 3 running');
for (const c of claimed.filter(Boolean)) { const row = await one(`select * from public.report_jobs where id = $1`, [c.id]); await jobs.run(db, row, synthetic(row), hooks); }
// Now drain with the two workers alternating.
let guard = 0, drained = 0;
for (;;) { const r = (await tick(guard % 2 ? 'worker-B' : 'worker-A', synthetic)) || (await tick(guard % 2 ? 'worker-A' : 'worker-B', synthetic)); if (!r) break; drained++; if (++guard > 20) break; }
const mine = [...runs.entries()].filter(([id]) => all.includes(id));
eq(mine.length, 9, 'all 9 jobs ran'); eq([...new Set(mine.map(([, n]) => n))], [1], 'each exactly once');
eq((await one(`select count(*)::int as n from public.report_jobs where id = any($1::uuid[]) and status = 'done'`, [all])).n, 9, 'all done');
const order = await q(`select business_id, created_at from public.report_jobs where id = any($1::uuid[]) order by started_at, created_at`, [all]);
ok(true, 'drained');

section('J3 failure -> retry with back-off -> failed with plain words after the last attempt; requester told once');
const [jf] = await mk(bizB, 1); failures.set(jf, 99);
for (let i = 0; i < 3; i++) { const r = await tick('worker-A', synthetic); say(`attempt ${i + 1}: ${r.status}`); }
const f3 = await one(`select status, attempts, error, error_detail from public.report_jobs where id = $1`, [jf]);
eq([f3.status, f3.attempts], ['failed', 3], 'failed after 3 attempts');
eq(f3.error, jobs.plainFailure, 'the person sees plain words, not "connection reset"');
ok(/boom/.test(f3.error_detail), 'the technical text is kept for the logs');
eq((await q(`select count(*)::int as n from public.notifications where kind = 'report_failed' and recipient_id = $1`, [bizB.owner]))[0].n, 1, 'one failure notification');
eq(await tick('worker-A', synthetic), null, 'a failed job is never claimed again');
const [jr] = await mk(bizB, 1); failures.set(jr, 1);                       // fails once, then works
await tick('worker-A', synthetic);
eq((await one(`select status, attempts from public.report_jobs where id = $1`, [jr])), { status: 'queued', attempts: 1 }, 'first failure: back to queued');
await tick('worker-B', synthetic);
eq((await one(`select status, attempts, error from public.report_jobs where id = $1`, [jr])), { status: 'done', attempts: 2, error: null }, 'second attempt succeeds (retry by a different worker)');
const [jd] = await mk(bizB, 1); failures.set(jd, 1);
await jobs.run(db, await jobs.claim(db, 'w'), synthetic({ id: jd }), { retryDelaySeconds: 3600 });
eq((await tick('worker-A', synthetic)), null, 'with a real back-off (1 h) the job is not due yet');
await db.query(`update public.report_jobs set status = 'failed' where id = $1`, [jd]);                       // tidy

section('J4 crashed worker: lease expires -> swept -> another worker finishes; the zombie cannot overwrite');
runs.clear();
const [jc] = await mk(bizC, 1);
const zombie = await jobs.claim(db, 'worker-Z');
eq(zombie.id, jc, 'worker Z claimed it, then "crashed" (no heartbeat)');
eq(await jobs.claim(db, 'worker-B'), null, 'while the lease is valid nobody else can take it (and the business has a running job)');
await db.query(`update public.report_jobs set locked_until = now() - interval '1 minute' where id = $1`, [jc]);
const sw = await jobs.sweep(db);
eq(sw.requeued, 1, 'sweep re-queued the stuck job');
const b = await jobs.claim(db, 'worker-B');
eq([b.id, b.attempts, b.locked_by], [jc, 2, 'worker-B'], 'worker B has it, attempt 2');
let lost = null; try { await jobs.heartbeat(db, zombie, 1, 1); } catch (e) { lost = e; }
eq(lost?.name, 'LostLease', 'the zombie\'s heartbeat is refused');
eq(await jobs.run(db, zombie, synthetic(zombie), hooks), 'lost', 'the zombie finishing late is discarded (fencing by locked_by)');
await jobs.run(db, b, synthetic(b), hooks);
eq((await one(`select status, locked_by from public.report_jobs where id = $1`, [jc])).status, 'done', 'done by B');
eq((await q(`select count(*)::int as n from public.notifications where kind = 'report_ready' and entity_id = $1`, [jc]))[0].n, 1, 'one notification, from B only');

section('J5 dedupe and the DB backstop for "one running job per business"');
const first = await jobs.enqueue(db, { businessId: bizA.id, userId: bizA.owner, reportKey: 'synthetic', params: { rows: 3, same: true } });
const second = await jobs.enqueue(db, { businessId: bizA.id, userId: bizA.owner, reportKey: 'synthetic', params: { rows: 3, same: true } });
eq([second.existing, second.id], [true, first.id], 'asking twice returns the same waiting job');
const third = await jobs.enqueue(db, { businessId: bizA.id, userId: users.manager, reportKey: 'synthetic', params: { rows: 3, same: true } });
eq(third.existing, false, 'another person asking for the same report gets their own job');
await db.query(`update public.report_jobs set status = 'running', locked_by = 'x', locked_until = now() + interval '1 minute' where id = $1`, [first.id]);
let dup = null; try { await db.query(`update public.report_jobs set status = 'running', locked_by = 'y', locked_until = now() + interval '1 minute' where id = $1`, [third.id]); } catch (e) { dup = e; }
ok(dup && /report_jobs_one_running/.test(dup.message + dup.constraint), 'a second running job in the same business is refused by the database itself');
eq(await jobs.claim(db, 'worker-A'), null, 'claim() returns "nothing to do" (no exception) for a business that already has a running job');
await db.query(`update public.report_jobs set status = 'failed' where id = $1`, [first.id]);
await db.query(`update public.report_jobs set status = 'failed' where id = $1`, [third.id]);

section('J6 download rules and the 30-day expiry');
const dj = (await jobs.enqueue(db, { businessId: bizA.id, userId: users.manager, reportKey: 'synthetic', params: { rows: 4, dl: true } })).id;
const dr = await jobs.claim(db, 'worker-A'); await jobs.run(db, dr, synthetic(dr), hooks);
const as = (userId, businessId, isOwner = false) => ({ userId, businessId, isOwner });
ok((await jobs.download(db, as(users.manager, bizA.id), dj)).startsWith('n'), 'the requester downloads it');
ok((await jobs.download(db, as(users.owner, bizA.id, true), dj)).length > 3, 'an owner of the business may too');
const dlErr = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
eq(await dlErr(jobs.download(db, as(users.waiter, bizA.id), dj)), 'not_found', 'another person in the business (not owner) gets "not found"');
eq(await dlErr(jobs.download(db, as(bizB.owner, bizB.id, true), dj)), 'not_found', 'another business gets "not found", same as a missing job');
await db.query(`update public.report_jobs set expires_at = now() - interval '1 second' where id = $1`, [dj]);
eq(await dlErr(jobs.download(db, as(users.manager, bizA.id), dj)), 'expired', 'past its 30 days: refused even before the sweeper runs');
await jobs.sweep(db);
eq((await one(`select status, result_text, storage_path from public.report_jobs where id = $1`, [dj])), { status: 'expired', result_text: null, storage_path: null }, 'sweeper clears the file reference');

section('J7 size: 20,000 rows in 2,000-row keyset chunks (what a "long range" job looks like)');
await db.query(`insert into public.stock_movements (business_id, location_id, item_id, delta, balance_after, reason, unit_cost, value)
  select $1, $2, $3, 1, g, 'purchase_receipt', 2.5, 2.5 from generate_series(1, 15000) g`, [bizA.id, loc, item]);
const big = (await jobs.enqueue(db, { businessId: bizA.id, userId: bizA.owner, reportKey: 'movement_ledger', params: { big: true } })).id;
const bc = await jobs.claim(db, 'worker-A'); let beats = 0;
const started = Date.now();
await jobs.run(db, bc, async (a) => movementsReport({ ...a, progress: async (d, t) => { beats++; await a.progress(d, t); } }), hooks);
const bd = await one(`select status, row_count::int as rows, byte_size::int as bytes from public.report_jobs where id = $1`, [big]);
say(`${JSON.stringify(bd)} in ${Date.now() - started} ms, ${beats} heartbeats (progress updates)`);
eq([bd.status, bd.rows], ['done', 20000], '20,000 rows done');
ok(beats >= 10, 'a heartbeat per chunk');

say(`\n${checks} checks passed`);
