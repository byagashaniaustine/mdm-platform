-- =============================================================================
-- 022 — Close sim-prefixed loan_links left over from the pre-Zoho-first era.
--
-- Pre-2026-11-03 the LMS sim was the webhook source; it wrote loan_links rows
-- with fineract_loan_id like 'SIM-<uuid>'. After real Fineract took over as the
-- webhook source, those rows stayed active. Each reconcile tick calls
-- getLoan('SIM-…') against real Fineract, gets a 404, logs loan_fetch_failed
-- and keeps the row active — which also claims the per-device active slot via
-- the partial unique index in migration 012, blocking auto-link on real loans
-- (we saw "Already exists" when loan 10 tried to auto-link on 2026-11-05).
--
-- Reconcile hardening in backend/services/bridge/reconcile.ts now closes rows
-- whose Fineract loan returns 404 on fetch, so this backfill only needs to run
-- once. Safe to re-run — the WHERE clause narrows to rows that are still
-- active AND sim-prefixed, so a second pass hits zero rows.
--
-- Apply via Supabase SQL Editor.
-- =============================================================================

update loan_links
set status    = 'closed',
    closed_on = coalesce(closed_on, current_date)
where status = 'active'
  and fineract_loan_id like 'SIM-%';
