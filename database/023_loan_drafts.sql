-- =============================================================================
-- 023 — Platform-initiated loan creation.
--
-- The Loans page now lets admins create loans directly (POST /loans + approve
-- against Fineract) instead of consuming Fineract's own listPendingDisbursal.
-- Each successful create+approve lands here as a "draft" — the loan exists in
-- Fineract in Approved state, no device bound yet. The admin then clicks
-- Link & disburse, which deletes this row and inserts the authoritative
-- loan_links row (status=active, device_id set, disbursal fired).
--
-- Why a separate table instead of a nullable device_id on loan_links:
--   * Keeps the existing active-loan invariant (loan_links.device_id NOT NULL,
--     partial unique index on (enterprise_id, device_id) WHERE status='active')
--     untouched — no cascading changes to automation / reconcile / detail view.
--   * A failed disburse leaves the draft untouched; the admin retries. A failed
--     linkAndDisburse that already wrote loan_links stays on loan_links.
--   * Delete-on-promote is one statement at the end of linkAndDisburse.
--
-- Apply via Supabase SQL Editor.
-- =============================================================================

create table if not exists loan_drafts (
  enterprise_id    uuid        not null references enterprises(id) on delete cascade,
  fineract_loan_id text        not null,
  created_by       uuid        references admins(id) on delete set null,
  product_id       integer     not null,
  product_name     text,
  client_id        text,
  client_name      text,
  principal        numeric(14,2) not null,
  expected_disbursement_on date,
  created_at       timestamptz not null default now(),
  primary key (enterprise_id, fineract_loan_id)
);

create index if not exists loan_drafts_enterprise_created_idx
  on loan_drafts (enterprise_id, created_at desc);
