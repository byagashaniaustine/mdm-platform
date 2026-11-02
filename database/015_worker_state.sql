-- =============================================================================
-- 015 — Durable worker state (survives Deno Deploy cold starts).
-- Module-level `let lastSync = 0;` in worker.ts resets on every cold start,
-- which on a lightly-trafficked backend fires the full enterprise sync every
-- ~60 s instead of every SYNC_INTERVAL_MINUTES. Persisting it means intended
-- cadence is honoured regardless of how often the instance restarts.
-- Safe to re-run.
-- =============================================================================

create table if not exists worker_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table worker_state enable row level security;

drop policy if exists worker_state_service_all on worker_state;
create policy worker_state_service_all on worker_state
  for all to service_role using (true) with check (true);

-- Known keys worker.ts reads/writes:
--   last_sync_at         { ts: <epoch_ms> }   enterprise-wide sync debounce
--   last_automation_tick { ts: <epoch_ms> }   automation dailyTick debounce
--   last_purge           { ts: <epoch_ms> }   old-location purge debounce
