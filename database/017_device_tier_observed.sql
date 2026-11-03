-- =============================================================================
-- 017 — device_tier_state: observed-from-Zoho fields.
--
-- Before this, device_tier_state only recorded our *intent* (applied_tier set
-- after a verified move). When a job dead-lettered (APPLY_MOVE_NOT_VISIBLE,
-- rate limit, auth), nothing updated the row — so the frontend would keep
-- reading the stale applied_tier indefinitely while reality in Zoho differed.
--
-- These columns record what Zoho actually says the device's tier membership is,
-- stamped on every terminal transition (applied OR dead) by apply_queue.ts.
-- When Zoho itself is unreachable on the re-read, observed_state='unknown' +
-- last_error carry the uncertainty forward instead of silently skipping.
--
-- Safe to re-run.
-- =============================================================================

alter table device_tier_state
  add column if not exists observed_state text,              -- the tier Zoho says the device is in, or 'unknown'
  add column if not exists observed_at    timestamptz,       -- when we last asked Zoho
  add column if not exists last_error     text;              -- if the Zoho re-read failed on terminal
