-- =============================================================================
-- 018 — Sim callback retry queue.
--
-- The LMS sim fires webhooks INTO the MDM backend (loan events → tier moves)
-- but never hears back. Its in-memory `phones` Map and `loan_links` rows show
-- the sim's own view of tier state, which drifts from backend/Zoho reality.
--
-- apply_queue.ts enqueues one sim_callbacks row per terminal transition
-- (applied OR dead). A dedicated worker drain (drainSimCallbacks) signs each
-- payload with HMAC-SHA256 and POSTs to the sim's /api/mdm/callback. On
-- success it stamps delivered_at. On failure it backs off exponentially and
-- gives up after max_attempts, leaving a row the operator can inspect.
--
-- Fire-and-forget on the apply side: callback liveness never blocks a
-- terminal transition. Idempotency on the sim side is keyed on apply_job_id.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists sim_callbacks (
  id              uuid primary key default gen_random_uuid(),
  enterprise_id   uuid not null references enterprises(id) on delete cascade,
  apply_job_id    uuid not null references apply_jobs(id)  on delete cascade,
  payload         jsonb not null,
  attempts        int  not null default 0,
  max_attempts    int  not null default 10,
  next_attempt_at timestamptz not null default now(),
  delivered_at    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Drain index — undelivered rows due to fire now, ordered FIFO.
create index if not exists idx_sim_callbacks_drain
  on sim_callbacks (next_attempt_at)
  where delivered_at is null;

-- One row per terminal transition. A retry of the same apply_job_id would
-- rebuild the row with the same payload — upsert handles that cleanly.
create unique index if not exists idx_sim_callbacks_apply_job
  on sim_callbacks (apply_job_id);

alter table sim_callbacks enable row level security;

-- Service-role-only. The frontend has no business reading or writing this table.
-- (RLS deny-by-default when no policies are defined, so this is just explicit.)
