-- =============================================================================
-- 024 — Customer email on platform-initiated loans.
--
-- When an admin creates a loan from the Loans page, they supply a customer
-- email that will receive payment reminders when the loan hits Due-2D /
-- Overdue-2D tiers (see backend/services/bridge/apply.ts § fireReminderEmail,
-- which reads loan_links.client_email).
--
-- The draft row carries the email through to loan_links on
-- linkAndDisburse, after which the reminder path finds it on
-- loan_links.client_email exactly like a Fineract-stamped email would.
--
-- Apply via Supabase SQL Editor.
-- =============================================================================

alter table loan_drafts
  add column if not exists client_email text;
