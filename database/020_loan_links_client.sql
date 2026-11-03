-- =============================================================================
-- 020 — loan_links: debtor identity (name + email) for payment-reminder flow.
--
-- fireReminderEmail (apply.ts) today pulls the recipient from mdm_users via
-- devices.assigned_user_id. That fits an admin-managed inventory where every
-- device has an owner on file, but not a loan-driven flow where the lender
-- registers a debtor independently of enrolment: the LMS sim's new "register
-- debtor" dashboard, and (ahead) a real Fineract integration where client
-- email lives in the loan, not the device.
--
-- Store the client identity on loan_links so the reminder path can prefer it
-- when present and fall back to the device-user link otherwise.
--
-- Safe to re-run.
-- =============================================================================

alter table loan_links
  add column if not exists client_name  text,
  add column if not exists client_email text;
