-- Add profile_purpose values that were added in TypeScript but never to the
-- Postgres enum. Any insert with purpose in {webfilter, vpn, email, proxy,
-- lockscreen_message} 500s with "invalid input value for enum profile_purpose"
-- until this runs.
--
-- Apply via Supabase SQL Editor (dashboard → SQL Editor → New query → paste → Run)
-- or via Supabase CLI. ALTER TYPE ... ADD VALUE can't run inside a transaction,
-- so each statement is standalone and idempotent via IF NOT EXISTS.

alter type profile_purpose add value if not exists 'webfilter';
alter type profile_purpose add value if not exists 'vpn';
alter type profile_purpose add value if not exists 'email';
alter type profile_purpose add value if not exists 'proxy';
alter type profile_purpose add value if not exists 'lockscreen_message';
