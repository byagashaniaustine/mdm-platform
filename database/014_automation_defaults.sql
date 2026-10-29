-- =============================================================================
-- 014 — Production defaults for loan-automation blast-radius guards.
-- Raises the Phase 0 conservative dev caps (25 / 20%) to fleet-ready numbers
-- (100 / 50%). See LOAN_DEVICE_AUTOMATION.md §11 and plan 2026-10-29.
-- Safe to re-run.
-- =============================================================================

alter table automation_settings
  alter column max_changes_per_run set default 100,
  alter column max_pct_per_run     set default 50;

-- Upgrade existing rows that are still at the dev defaults. `greatest(...)` means
-- an operator who already raised the cap manually keeps their value.
update automation_settings
  set max_changes_per_run = greatest(max_changes_per_run, 100),
      max_pct_per_run     = greatest(max_pct_per_run, 50),
      updated_at          = now()
  where max_changes_per_run <= 25
     or max_pct_per_run     <= 20;
