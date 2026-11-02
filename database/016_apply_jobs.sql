-- =============================================================================
-- 016 — Async apply queue for the loan-automation Phase 2 apply path.
--
-- Webhooks compute decisions synchronously (DB-only, fast) and enqueue one
-- apply_jobs row per decision. The worker drains the queue at its own pace,
-- doing the actual Zoho group moves + announcement sends. This decouples
-- ingress from processing so:
--
--   * webhook responds in ~200ms instead of 7-10s
--   * Zoho eventual-consistency lag never races with a verify step
--   * backpressure is natural (jobs sit in queue instead of failing)
--   * Fineract outages don't take the webhook ingress down
--   * horizontal scale: add workers, drain queue faster
--
-- Safe to re-run.
-- =============================================================================

create table if not exists apply_jobs (
  id              uuid primary key default gen_random_uuid(),
  enterprise_id   uuid not null references enterprises(id) on delete cascade,
  device_id       uuid not null references devices(id)     on delete cascade,
  loan_id         text not null,
  trigger         text not null,                            -- webhook:LOAN/DISBURSE etc.
  decision        jsonb not null,                           -- DeviceDecision shape
  state           text not null default 'pending',          -- pending|in_progress|applied|failed|dead
  attempts        int  not null default 0,
  max_attempts    int  not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,                              -- claim-expiry for worker
  outcome         jsonb,                                    -- ApplyOutcome once applied
  error_code      text,
  error_message   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);

-- Draining the queue — all rows a worker should consider.
create index if not exists idx_apply_jobs_drain
  on apply_jobs (enterprise_id, state, next_attempt_at)
  where state in ('pending', 'in_progress');

-- Looking up jobs for a specific loan (useful for the webhook response + status probes).
create index if not exists idx_apply_jobs_loan
  on apply_jobs (enterprise_id, loan_id);

-- RLS: service role only, matching the rest of the automation surface.
alter table apply_jobs enable row level security;

drop policy if exists apply_jobs_service_all on apply_jobs;
create policy apply_jobs_service_all on apply_jobs
  for all to service_role using (true) with check (true);
