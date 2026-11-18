# Spike: background report job queue (18 Nov 2026) — de-risks P3-22 / P3-27

Run it: `node docs/inventory-kb/spikes/report-jobs/spike_test.mjs` (PGlite, 009 + proposed 012…017 + `spike_023.sql`; **43/43 checks pass**; output in `output.txt`).

| File | What it is |
| --- | --- |
| `spike_023.sql` | The `report_jobs` table as the plan describes it plus the columns the spike found necessary, and three partial indexes (poll, **one running job per business**, dedupe) |
| `jobs_spike.js` | `enqueue`, `sweep`, `claim` (the `FOR UPDATE SKIP LOCKED` statement), `heartbeat`, `finish`, `fail`, `run`, `download` |
| `spike_test.mjs` | Scenarios J1–J7 |
| `output.txt` | Output of the last run |

## Verdict

**The design works and is simpler than the plan describes, but PGlite cannot prove the one thing the plan asked for ("two workers, no job runs twice") as a true race.** What *is* proved: every state transition is a single atomic statement guarded by `status`/`locked_by`, the exclusivity rules hold when two workers take turns, a crashed worker's job is recovered, and a worker that lost its lease cannot overwrite the result. The real two-connection race stays a **P3-21/P3-37 drill on a disposable real Postgres**.

## What was proved

| # | Scenario | Result |
| --- | --- | --- |
| J1 | Enqueue → claim → run with 3 progress chunks → done | status `done`, 5,000 rows = ledger rows, `progress 5000/5000`, kept 30 days (`expires_at`), requester notified once (`notify()` with a dedupe key), file size counts the 3-byte BOM |
| J2 | 9 jobs in 3 businesses; workers A, B, A, B, A claim without finishing anything | exactly 3 claims succeed (one per business), the other two get nothing; never two running jobs in one business; draining with alternating workers runs **every job exactly once** |
| J3 | Failures | attempt 1 and 2 → back to `queued` with back-off (`run_after`), attempt 3 → `failed` with a **plain** message ("We couldn't prepare this report…"; the technical text goes to `error_detail`), one failure notification; a retry by a different worker succeeds; a 1-hour back-off keeps the job out of the next poll; a failed job is never claimed again |
| J4 | Worker crashes (no heartbeat) | lease expires → `sweep` re-queues → worker B claims (attempt 2) → the **zombie's heartbeat is refused (`LostLease`) and its late finish is discarded**; one notification, from B only |
| J5 | Dedupe and fairness backstop | asking for the same report twice returns the same waiting job; another person gets their own; a second *running* job in the same business is refused **by the database** (`report_jobs_one_running`), and `claim()` turns that refusal into "nothing to do" |
| J6 | Download and expiry | requester and owners can fetch; another person in the business and another business both get `not_found` (indistinguishable from a missing job); past `expires_at` it is refused even before the sweeper runs; the sweeper clears `storage_path`/`result_text` and marks `expired` |
| J7 | 20,000 rows in 2,000-row keyset chunks | done, 10 heartbeats, ~100 ms on PGlite (in-memory; real Postgres adds a network round trip per chunk) |

## Changes to the plan (P3-22 columns, P3-27 behaviour)

1. **Claim is one statement**: `update report_jobs … where id = (select … where status='queued' and run_after <= now() and not exists (a running job of this business) order by created_at for update skip locked limit 1) returning *`. No long transaction, no polling loop holding locks.
2. **One running job per business is a partial unique index** (`report_jobs_one_running`), not only a `WHERE` clause: with two pollers the `NOT EXISTS` check can be stale under READ COMMITTED, the index cannot. The loser catches `23505` and moves on.
3. **Recovery is a separate `sweep` step** that runs before every poll: running jobs whose `locked_until` passed go back to `queued` (or `failed` when `attempts >= max_attempts`). The poller then only ever claims `queued` rows. The plan's "reclaim stuck jobs after 10 min" becomes "lease 2 min, heartbeat per chunk" (shorter and self-extending).
4. **Fencing**: `heartbeat`, `finish` and `fail` all `WHERE id = $1 AND locked_by = $2 AND status = 'running'`; zero rows = the lease was lost, stop and discard. This is what stops a slow worker overwriting a job that was handed to someone else.
5. **New columns** (add to P3-22): `attempts`, `max_attempts`, `run_after`, `progress_done`, `progress_total`, `dedupe_key`, `expires_at`, `byte_size`, `error` (plain words) and `error_detail` (logs/admin only). `result_text` exists in the spike only; the real column is `storage_path` (file in `inventory-reports`).
6. **Dedupe** (same business + requester + report + params while queued/running → the existing job) avoids double-clicks creating two heavy jobs.
7. **Keyset paging** (`id > last order by id limit N`) with a heartbeat per chunk is the way reports stream rows; never `offset`.
8. **The BOM is written when the file is written**, not stored in a text column: PGlite's decoder strips a leading BOM from strings it reads back (a node-pg connection would not), a reminder that the CSV writer should add it to the bytes it uploads.

## Limits of this spike (honest list)

- **No true concurrency.** PGlite is one connection: two "workers" here take turns. `FOR UPDATE SKIP LOCKED` parses and behaves correctly for a single session, but "the second poller skips a row the first is holding" cannot happen. Everything concurrency-sensitive is therefore built from **atomic statements + unique indexes + the `locked_by` guard**, which are correct under real Postgres by construction, and must be confirmed by the **two-connection drill in P3-21** (a disposable local Postgres, never the shared database): 2–4 pollers hammering 200 queued jobs across 5 businesses → each job `attempts = 1`, never two running per business, no deadlock, kill -9 one poller mid-job and check recovery within the lease.
- The report body here is the movement ledger only; real reports come from `reports.js` (P3-26). The file goes to the Storage bucket (not exercised: `fakeStorage` stands in later).
- Notifications use the real `notify()` writer; the in-process scheduler (P3-31) that calls `sweep` + `claim` every 5 s is not part of the spike.
