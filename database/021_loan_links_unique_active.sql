-- =============================================================================
-- 021 — loan_links: partial unique on (enterprise, fineract_loan_id) WHERE active.
--
-- PR 1 of the Fineract-integration work needs to upsert loan_links on each
-- loan webhook (automation.ts::upsertLoanLink). The upsert's ON CONFLICT
-- target is (enterprise_id, fineract_loan_id).
--
-- A full unique constraint is wrong: historical rows exist for closed loans
-- that were re-created (sim re-use of SIM-000001 etc. — 28 rows for one id).
-- Closed rows are archival; only one *active* row per (enterprise, loan_id)
-- is a semantic constraint we actually want.
--
-- Partial unique index enforces that + leaves history alone.
--
-- Safe to re-run.
-- =============================================================================

create unique index if not exists loan_links_enterprise_loan_active_uniq
  on loan_links (enterprise_id, fineract_loan_id)
  where status = 'active';
