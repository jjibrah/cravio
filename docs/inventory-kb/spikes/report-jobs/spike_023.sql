-- SPIKE for P3-22 / P3-27 (migration 023, report_jobs only). Not a real migration. Applied on 009 + proposed 012..017.
-- Differences from the plan text (see README):
--   * `attempts`, `max_attempts`, `run_after` (retry back-off), `progress_done/total`, `dedupe_key`, `expires_at`, `byte_size`,
--     `error` (plain words for the person) and `error_detail` (for admins/logs);
--   * one RUNNING job per business is enforced by the DATABASE (partial unique index), not just by the poller's WHERE clause;
--   * `result_text` exists in the spike only: the real column is `storage_path` (the file lives in the private bucket).
create table if not exists public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  report_key text not null check (char_length(report_key) between 1 and 60),
  params jsonb not null default '{}'::jsonb,
  dedupe_key text check (char_length(dedupe_key) <= 200),
  format text not null default 'csv' check (format in ('csv', 'pdf')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'expired')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  run_after timestamptz not null default now(),
  progress_done bigint not null default 0,
  progress_total bigint,
  storage_path text,
  result_text text,
  row_count bigint,
  byte_size bigint,
  error text,
  error_detail text,
  locked_by text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  check (status <> 'running' or (locked_by is not null and locked_until is not null)),
  check (status <> 'done' or (row_count is not null and expires_at is not null))
);
-- The poller's index: only queued rows are ever scanned.
create index if not exists report_jobs_poll_idx on public.report_jobs (run_after, created_at) where status = 'queued';
create index if not exists report_jobs_business_idx on public.report_jobs (business_id, created_at desc);
-- At most one running job per business (fairness enforced by the database: two pollers cannot both win, whatever their snapshots saw).
create unique index if not exists report_jobs_one_running on public.report_jobs (business_id) where status = 'running';
-- The same person asking for the same report with the same parameters while it is waiting or running gets the existing job.
create unique index if not exists report_jobs_dedupe on public.report_jobs (business_id, requested_by, dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');
