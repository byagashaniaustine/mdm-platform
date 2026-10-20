-- =============================================================================
-- 010 — Admin invite links (run after 001–009). Safe to run more than once.
--   Owner creates a one-time link; Resend emails it. otp_codes stores the link's
--   HMAC with purpose 'invite' (reusing the OTP machinery for expiry + attempts).
-- =============================================================================
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'otp_codes'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%purpose%'
  loop
    execute format('alter table otp_codes drop constraint %I', c);
  end loop;
end $$;
alter table otp_codes add constraint otp_codes_purpose_check check (purpose in ('login', 'register', 'invite'));

insert into error_codes (code, http_status, message, retryable) values
  ('AUTH_INVITE_INVALID', 401, 'This link is invalid, already used, or expired. Ask your enterprise owner for a new one.', false)
on conflict (code) do nothing;
