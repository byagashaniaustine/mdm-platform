-- =============================================================================
-- 025 — Customer mobile on platform-initiated loans.
--
-- Mirrors migration 024 (client_email) but for phone. Captured on the Create
-- loan form so we have a stable number regardless of what's currently on the
-- Fineract client record (which an admin may or may not keep up to date).
--
-- SMS reminders aren't wired yet; this column is read by the Loans detail
-- modal and by future SMS/WhatsApp reminder paths. The email reminder path
-- (apply.ts § fireReminderEmail) is unchanged.
--
-- Apply via Supabase SQL Editor.
-- =============================================================================

alter table loan_drafts
  add column if not exists client_mobile text;

alter table loan_links
  add column if not exists client_mobile text;
