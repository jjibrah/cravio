// Spike service for P3-27: DB-backed queue polled in the API process. Every function takes `db` (a pool or a PGlite handle) and runs
// each statement on its own (autocommit): claims and heartbeats are single atomic statements, never long transactions.
import { createHash } from 'node:crypto';

const q = async (db, sql, p) => (await db.query(sql, p)).rows;
const one = async (db, sql, p) => (await q(db, sql, p))[0] || null;
export class LostLease extends Error { constructor() { super('This worker no longer owns the job.'); this.name = 'LostLease'; } }

export const LEASE_SECONDS = 120;       // locked_until = now + 2 min, pushed forward by every heartbeat
export const KEEP_DAYS = 30;            // D3-10: files kept 30 days
export const plainFailure = 'We couldn’t prepare this report. Try a shorter date range, or ask again in a few minutes.';

export async function enqueue(db, { businessId, userId, reportKey, params = {}, maxAttempts = 3 }) {
  const dedupeKey = createHash('sha256').update(JSON.stringify([reportKey, params])).digest('hex').slice(0, 32);
  const row = await one(db, `insert into public.report_jobs (business_id, requested_by, report_key, params, dedupe_key, max_attempts) values ($1, $2, $3, $4::jsonb, $5, $6)
    on conflict (business_id, requested_by, dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing returning id`,
    [businessId, userId, reportKey, JSON.stringify(params), dedupeKey, maxAttempts]);
  if (row) return { id: row.id, existing: false };
  const existing = await one(db, `select id from public.report_jobs where business_id = $1 and requested_by = $2 and dedupe_key = $3 and status in ('queued', 'running')`, [businessId, userId, dedupeKey]);
  return { id: existing.id, existing: true };
}

/**
 * Housekeeping before every poll (cheap, idempotent, safe to run on every instance):
 *   * a RUNNING job whose lease ran out (worker crashed or hung) goes back to queued, or to failed when it has used all its attempts;
 *   * a DONE job past expires_at becomes expired and its file reference is cleared (the real code also deletes the bucket object).
 */
export async function sweep(db) {
  const stuck = await q(db, `update public.report_jobs set
      status = case when attempts >= max_attempts then 'failed' else 'queued' end,
      error = case when attempts >= max_attempts then $1 else error end,
      error_detail = 'lease expired (worker stopped answering)',
      finished_at = case when attempts >= max_attempts then now() else null end,
      locked_by = null, locked_until = null
    where status = 'running' and locked_until < now() returning id, status, requested_by, business_id`, [plainFailure]);
  const expired = await q(db, `update public.report_jobs set status = 'expired', storage_path = null, result_text = null
    where status = 'done' and expires_at < now() returning id`);
  return { requeued: stuck.filter((r) => r.status === 'queued').length, failed: stuck.filter((r) => r.status === 'failed'), expired: expired.length };
}

/**
 * claim: ONE statement. The inner select takes the oldest due queued job and locks it with FOR UPDATE SKIP LOCKED, so a second poller
 * running the same statement at the same moment skips that row instead of waiting or taking it too. The outer UPDATE flips it to
 * running and stamps the lease. The partial unique index report_jobs_one_running is the backstop for "one running job per business":
 * if another poller won that business a moment earlier, the UPDATE fails with 23505 and this poller simply reports "nothing to do".
 */
export async function claim(db, workerId) {
  try {
    return await one(db, `update public.report_jobs j set status = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $2),
        attempts = j.attempts + 1, started_at = coalesce(j.started_at, now()), error = null, error_detail = null
      where j.id = (
        select c.id from public.report_jobs c
         where c.status = 'queued' and c.run_after <= now()
           and not exists (select 1 from public.report_jobs r where r.business_id = c.business_id and r.status = 'running')
         order by c.created_at, c.id
         for update skip locked limit 1)
      returning j.*`, [workerId, LEASE_SECONDS]);
  } catch (e) {
    if (e.code === '23505' && /report_jobs_one_running/.test(`${e.constraint} ${e.message}`)) return null;
    throw e;
  }
}

/** Progress + lease extension. Zero rows updated = this worker lost the job (it was swept and given to another): stop at once. */
export async function heartbeat(db, job, done, total = null) {
  const row = await one(db, `update public.report_jobs set progress_done = $3, progress_total = coalesce($4, progress_total), locked_until = now() + make_interval(secs => $5)
    where id = $1 and locked_by = $2 and status = 'running' returning id`, [job.id, job.locked_by, done, total, LEASE_SECONDS]);
  if (!row) throw new LostLease();
}

/** Stores the result and flips to done, only if this worker still owns the lease (fencing). The requester is told once. */
export async function finish(db, job, { text, rowCount, notify }) {
  const row = await one(db, `update public.report_jobs set status = 'done', result_text = $3, storage_path = $4, row_count = $5, byte_size = $6, progress_done = $5,
      finished_at = now(), expires_at = now() + make_interval(days => $7), locked_by = null, locked_until = null
    where id = $1 and locked_by = $2 and status = 'running' returning id, requested_by, business_id`,
    [job.id, job.locked_by, text, `inventory-reports/${job.business_id}/${job.id}.csv`, rowCount, Buffer.byteLength(text), KEEP_DAYS]);
  if (!row) throw new LostLease();
  if (notify) await notify({ kind: 'report_ready', userId: row.requested_by, businessId: row.business_id, jobId: row.id });
  return row;
}

/** A failed attempt: retry with back-off while attempts remain, else failed with plain words (and the person is told once). */
export async function fail(db, job, error, { retryDelaySeconds = 30, notify } = {}) {
  const row = await one(db, `update public.report_jobs set
      status = case when attempts >= max_attempts then 'failed' else 'queued' end,
      run_after = case when attempts >= max_attempts then run_after else now() + make_interval(secs => $3 * power(2, attempts - 1)) end,
      error = case when attempts >= max_attempts then $4 else null end, error_detail = $5,
      finished_at = case when attempts >= max_attempts then now() else null end,
      locked_by = null, locked_until = null
    where id = $1 and locked_by = $2 and status = 'running' returning id, status, requested_by, business_id`,
    [job.id, job.locked_by, retryDelaySeconds, plainFailure, String(error?.message || error).slice(0, 500)]);
  if (!row) throw new LostLease();
  if (row.status === 'failed' && notify) await notify({ kind: 'report_failed', userId: row.requested_by, businessId: row.business_id, jobId: row.id });
  return row.status;
}

/** Runs one claimed job with a report function `fn({ db, params, businessId, progress(done, total) }) -> { text, rowCount }`. */
export async function run(db, job, fn, hooks = {}) {
  try {
    const out = await fn({ db, params: job.params, businessId: job.business_id, progress: (done, total) => heartbeat(db, job, done, total) });
    await finish(db, job, { ...out, notify: hooks.notify });
    return 'done';
  } catch (e) {
    if (e instanceof LostLease) return 'lost';
    return fail(db, job, e, hooks);
  }
}

/** Download check. `ownerIds` = the business's owners (anyone else may only fetch their own file). Returns the stored text (the real code returns a 5-minute signed URL). */
export async function download(db, { userId, businessId, isOwner }, jobId) {
  const job = await one(db, `select * from public.report_jobs where id = $1 and business_id = $2`, [jobId, businessId]);
  const refuse = (code) => Object.assign(new Error(code), { code });
  if (!job) throw refuse('not_found');                                    // another business's job looks exactly like a missing one
  if (job.requested_by !== userId && !isOwner) throw refuse('not_found');
  if (job.status === 'expired' || (job.status === 'done' && new Date(job.expires_at) < new Date())) throw refuse('expired');
  if (job.status !== 'done') throw refuse('not_ready');
  return job.result_text;
}
