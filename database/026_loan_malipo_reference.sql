-- =============================================================================
-- 026 — Malipopay reference on loan_links.
--
-- Stores the ML… reference returned by POST /api/v2/payment/collection on
-- disburse. The reference is what the borrower types at the bank biller
-- MALIPOPAY (or TCB business 700500); the matching inbound webhook carries
-- this reference AND our customerReference ("LOAN-<id>"), so either side is
-- enough to route an inbound payment back to the correct loan.
--
-- Nullable: old loans + ones where collection creation failed will have NULL
-- and fall back to the walk-up instructions (biller MALIPOPAY ref 863260).
--
-- Apply via Supabase SQL Editor.
-- =============================================================================

alter table loan_links
  add column if not exists malipo_reference    text,
  add column if not exists malipo_amount       numeric,
  -- Snapshot of the most recent payment.confirmed webhook. Read by the Loan
  -- Tracking UI alongside the Fineract totalRepaid; drift between the two is
  -- what the reconciliation check in services/loans.ts surfaces.
  add column if not exists last_malipo_at      timestamptz,
  add column if not exists last_malipo_amount  numeric,
  add column if not exists last_malipo_status  text;

-- Fast lookup from the webhook handler: `WHERE malipo_reference = $1`.
create index if not exists loan_links_malipo_reference_idx
  on loan_links (malipo_reference)
  where malipo_reference is not null;
