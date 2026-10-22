-- =============================================================================
-- MDM Platform — Supabase / PostgreSQL schema
-- -----------------------------------------------------------------------------
-- Derived from the hand-drawn ER notes. Every "zoho key (enterprise)" attribute
-- in the notes becomes a foreign key to enterprises(id); the actual Zoho
-- credentials live once, encrypted, in zoho_connections.
--
-- Node (notes)            -> Table(s)
--   Enterprise Accounts    -> enterprises, admins, otp_codes, sessions,
--                             zoho_connections, oauth_states
--   Users                  -> mdm_users           (users.dev_id flipped to
--                             devices.assigned_user_id: one user, many devices)
--   Devices                -> devices
--   Groups (+ devices_id)  -> groups, group_devices      (many-to-many)
--   Profiles (+ group_id)  -> profiles, profile_groups   (many-to-many)
--   Events                 -> events  (audit log + command/backlog queue)
--   Failure handling       -> error_codes, events.state = 'dead', sync_runs
--   Announcements (new)    -> announcements, announcement_targets
--
-- Run once in the Supabase SQL editor. The backend uses the service-role key;
-- RLS is enabled with no policies so the anon/public key can read nothing.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enum types
create type platform_type    as enum ('android', 'ios', 'windows', 'chrome', 'macos', 'unknown');
create type admin_role       as enum ('owner', 'admin', 'viewer');
create type group_kind       as enum ('department', 'function', 'baseline', 'other');
create type profile_state    as enum ('draft', 'published', 'modified', 'deleted');
create type profile_purpose  as enum ('restrictions', 'kiosk', 'passcode', 'frp', 'wifi', 'webfilter', 'vpn', 'email', 'proxy', 'lockscreen_message', 'custom');
create type zoho_conn_status as enum ('pending', 'connected', 'error', 'revoked');
create type event_state      as enum (
  'awaiting_confirmation',  -- destructive command waiting for step-2 confirmation
  'requested',              -- queued, not yet sent to Zoho (also used for retries)
  'sent',                   -- accepted by Zoho, waiting for the device
  'acknowledged',           -- device picked the command up
  'succeeded',              -- finished OK
  'failed',                 -- finished with a non-retryable error
  'dead',                   -- retries exhausted -> backlog for a human
  'cancelled'               -- confirmation expired or admin cancelled
);

-- ------------------------------------------------------------ helper trigger
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- =========================================================== error catalogue
create table error_codes (
  code        text primary key,
  http_status int  not null,
  message     text not null,
  retryable   boolean not null default false
);

insert into error_codes (code, http_status, message, retryable) values
  ('AUTH_REQUIRED',                 401, 'Sign in to continue.', false),
  ('AUTH_INVALID_OTP',              401, 'The code is incorrect.', false),
  ('AUTH_OTP_EXPIRED',              401, 'The code has expired. Request a new one.', false),
  ('AUTH_TOO_MANY_ATTEMPTS',        429, 'Too many attempts. Try again later.', false),
  ('AUTH_FORBIDDEN',                403, 'Your role does not allow this action.', false),
  ('VALIDATION_FAILED',             400, 'Some fields are missing or invalid.', false),
  ('NOT_FOUND',                     404, 'The item was not found.', false),
  ('CONFLICT',                      409, 'The item already exists or was changed.', false),
  ('ENTERPRISE_EXISTS',             409, 'An enterprise with this email already exists.', false),
  ('RATE_LIMITED',                  429, 'Too many requests. Slow down.', true),
  ('ZOHO_NOT_CONNECTED',            412, 'Connect your Zoho account first.', false),
  ('ZOHO_OAUTH_FAILED',             502, 'Zoho sign-in failed.', false),
  ('ZOHO_TOKEN_REFRESH_FAILED',     502, 'Could not refresh the Zoho access token. Reconnect Zoho.', false),
  ('ZOHO_UNAUTHORIZED',             502, 'Zoho rejected the credentials.', false),
  ('ZOHO_SCOPE_MISMATCH',           502, 'The Zoho token is missing required scopes.', false),
  ('ZOHO_BAD_REQUEST',              422, 'Zoho rejected the request.', false),
  ('ZOHO_NOT_FOUND',                404, 'The item does not exist in Zoho.', false),
  ('ZOHO_RATE_LIMITED',             503, 'Zoho rate limit reached. Will retry.', true),
  ('ZOHO_UNAVAILABLE',              503, 'Zoho is unavailable. Will retry.', true),
  ('ZOHO_NETWORK',                  503, 'Network error talking to Zoho. Will retry.', true),
  ('COMMAND_UNKNOWN',               400, 'Unknown device action.', false),
  ('COMMAND_CONFIRMATION_REQUIRED', 202, 'This action needs a second confirmation.', false),
  ('COMMAND_CONFIRMATION_INVALID',  400, 'Confirmation details do not match.', false),
  ('COMMAND_CONFIRMATION_EXPIRED',  410, 'Confirmation window expired.', false),
  ('DIRECT_PROFILE_DEVICE_BLOCKED', 400, 'Profiles are applied through groups only.', false),
  ('PROFILE_NOT_PUBLISHED',         409, 'Publish the profile before associating it.', false),
  ('MAX_RETRIES_EXCEEDED',          500, 'Gave up after several retries; moved to backlog.', false),
  ('INTERNAL',                      500, 'Unexpected server error.', false);

-- ======================================================= enterprise accounts
create table enterprises (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null unique,                 -- enterprise contact email
  country     text default 'TZ',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint enterprises_email_lower check (email = lower(email))
);
create trigger trg_enterprises_updated before update on enterprises
  for each row execute function set_updated_at();

-- "user_id" in Enterprise Accounts -> dashboard administrators
create table admins (
  id             uuid primary key default gen_random_uuid(),
  enterprise_id  uuid not null references enterprises(id) on delete cascade,
  email          text not null unique,               -- OTP login identity
  full_name      text,
  role           admin_role not null default 'admin',
  is_active      boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  constraint admins_email_lower check (email = lower(email))
);
create index idx_admins_enterprise on admins(enterprise_id);

-- "OTP login" — codes are stored hashed, never in plain text
create table otp_codes (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references admins(id) on delete cascade,
  purpose     text not null default 'login' check (purpose in ('login', 'register')),
  code_hash   text not null,
  attempts    int  not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index idx_otp_admin_active on otp_codes(admin_id, created_at desc) where consumed_at is null;

-- "session keys" — random token in an HttpOnly cookie, SHA-256 hash stored here
create table sessions (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid not null references admins(id) on delete cascade,
  token_hash   text not null unique,
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index idx_sessions_admin on sessions(admin_id);

-- "zoho keys" — one row per enterprise; secrets AES-GCM encrypted by the backend
create table zoho_connections (
  enterprise_id           uuid primary key references enterprises(id) on delete cascade,
  status                  zoho_conn_status not null default 'pending',
  accounts_server         text not null default 'https://accounts.zoho.com',
  api_base                text not null default 'https://mdm.manageengine.com/api/v1/mdm',
  client_id               text,                       -- only for self-client mode
  client_secret_enc       text,                       -- only for self-client mode
  refresh_token_enc       text,
  access_token_enc        text,
  access_token_expires_at timestamptz,
  scopes                  text[] not null default '{}',
  zoho_account_email      text,
  last_error              text,
  connected_by            uuid references admins(id) on delete set null,
  connected_at            timestamptz,
  updated_at              timestamptz not null default now()
);
create trigger trg_zoho_conn_updated before update on zoho_connections
  for each row execute function set_updated_at();

-- CSRF protection for the Zoho OAuth redirect
create table oauth_states (
  state         text primary key,
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  admin_id      uuid not null references admins(id) on delete cascade,
  expires_at    timestamptz not null
);

-- =================================================================== users
-- Managed (device) users mirrored from Zoho. Notes: Users(username, dev_id,
-- zoho key, date added). The device link lives on devices.assigned_user_id
-- because one user can hold several devices.
create table mdm_users (
  id            uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  zoho_user_id  bigint not null,
  user_name     text,
  email         text,
  added_at      timestamptz not null default now(),   -- "date added"
  synced_at     timestamptz,
  unique (enterprise_id, zoho_user_id)
);
create index idx_mdm_users_enterprise on mdm_users(enterprise_id);

-- ================================================================= devices
-- Notes: Devices(dev_id, Apple/Android, device name, model, zoho key, added date)
create table devices (
  id               uuid primary key default gen_random_uuid(),
  enterprise_id    uuid not null references enterprises(id) on delete cascade,
  zoho_device_id   bigint not null,                   -- "dev_id"
  assigned_user_id uuid references mdm_users(id) on delete set null,
  platform         platform_type not null default 'unknown',   -- Apple / Android
  device_name      text,
  model            text,
  product_name     text,
  os_version       text,
  serial_number    text,                              -- personal/asset data: never exposed to viewers
  imei             text,                              -- personal/asset data: masked for viewers
  owned_by         smallint,                          -- 1 corporate, 2 personal (Zoho)
  is_lost_mode     boolean not null default false,
  is_removed       boolean not null default false,
  added_at         timestamptz not null default now(), -- "added date"
  last_synced_at   timestamptz,
  unique (enterprise_id, zoho_device_id)
);
create index idx_devices_enterprise on devices(enterprise_id) where is_removed = false;
create index idx_devices_user on devices(assigned_user_id);

-- ================================================================== groups
-- Notes: Groups(group_id, group name, zoho key, devices_id)
create table groups (
  id             uuid primary key default gen_random_uuid(),
  enterprise_id  uuid not null references enterprises(id) on delete cascade,
  zoho_group_id  bigint,                              -- null until created in Zoho
  name           text not null,
  kind           group_kind not null default 'other', -- department / function / baseline
  group_type     int not null default 6,              -- Zoho: 6 = device group
  description    text,
  member_count   int not null default 0,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (enterprise_id, zoho_group_id)
);
create index idx_groups_enterprise on groups(enterprise_id);

-- "devices_id (what devices belong to group)" -> junction table
create table group_devices (
  group_id  uuid not null references groups(id)  on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (group_id, device_id)
);
create index idx_group_devices_device on group_devices(device_id);

-- ================================================================ profiles
-- Notes: Profiles(profile_id, profile name, zoho key, profile_state, last sync, group_id)
create table profiles (
  id              uuid primary key default gen_random_uuid(),
  enterprise_id   uuid not null references enterprises(id) on delete cascade,
  zoho_profile_id bigint,
  name            text not null,
  description     text,
  platform        platform_type not null default 'android',
  purpose         profile_purpose not null default 'custom',  -- restriction / kiosk / passcode ...
  state           profile_state not null default 'draft',     -- "profile_state (published)"
  payload_names   text[] not null default '{}',
  payload_config  jsonb not null default '{}'::jsonb,         -- what we sent, per payload
  last_synced_at  timestamptz,                                 -- "last sync"
  created_by      uuid references admins(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (enterprise_id, zoho_profile_id)
);
create index idx_profiles_enterprise on profiles(enterprise_id);
create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();

-- "group_id (groups under set profiles)" -> junction table.
-- There is deliberately NO profile_devices table: profiles reach devices only
-- through groups (notes: "profile -> device: no").
create table profile_groups (
  profile_id    uuid not null references profiles(id) on delete cascade,
  group_id      uuid not null references groups(id)   on delete cascade,
  associated_at timestamptz not null default now(),
  associated_by uuid references admins(id) on delete set null,
  source        text not null default 'platform' check (source in ('platform','zoho','inferred')),
  last_seen_at  timestamptz,
  primary key (profile_id, group_id)
);
create index idx_profile_groups_group on profile_groups(group_id);

-- =========================================================== announcements
create table announcements (
  id                   uuid primary key default gen_random_uuid(),
  enterprise_id        uuid not null references enterprises(id) on delete cascade,
  zoho_announcement_id bigint,
  name                 text not null,
  title                text not null,
  detail_message       text not null,
  nbar_message         text,
  title_color          text default '#1F3A5F',
  format               int  not null default 1,
  needs_ack            boolean not null default false,
  ack_button           text default 'Got it',
  created_by           uuid references admins(id) on delete set null,
  created_at           timestamptz not null default now(),
  unique (enterprise_id, zoho_announcement_id)
);
create index idx_announcements_enterprise on announcements(enterprise_id);

create table announcement_targets (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references announcements(id) on delete cascade,
  group_id        uuid references groups(id)  on delete cascade,
  device_id       uuid references devices(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  constraint announcement_target_one check ((group_id is null) <> (device_id is null))
);
create index idx_ann_targets_ann on announcement_targets(announcement_id);

-- ================================================================== events
-- Notes: Events(event_id, zoho keys, action, profile_id, state, action time)
-- One row per action. Doubles as the command queue and the failure backlog:
--   state machine: awaiting_confirmation -> requested -> sent -> acknowledged -> succeeded
--                                                    \-> failed | dead | cancelled
create table events (
  id                 uuid primary key default gen_random_uuid(),
  enterprise_id      uuid not null references enterprises(id) on delete cascade,
  admin_id           uuid references admins(id)        on delete set null,
  category           text not null check (category in ('command','group','profile','announcement','sync','auth','zoho')),
  action             text not null,                    -- e.g. complete_wipe, group.add_devices
  state              event_state not null default 'requested',
  idempotency_key    text,
  device_id          uuid references devices(id)       on delete set null,
  group_id           uuid references groups(id)        on delete set null,
  profile_id         uuid references profiles(id)      on delete set null,
  announcement_id    uuid references announcements(id) on delete set null,
  params             jsonb not null default '{}'::jsonb,
  response           jsonb,
  error_code         text references error_codes(code),
  error_message      text,
  attempts           int not null default 0,
  max_attempts       int not null default 5,
  next_attempt_at    timestamptz not null default now(),
  locked_until       timestamptz,
  confirm_code_hash  text,
  confirm_expires_at timestamptz,
  action_time        timestamptz not null default now(),  -- "action time"
  sent_at            timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz not null default now(),
  unique (enterprise_id, idempotency_key)
);
create index idx_events_enterprise_time on events(enterprise_id, action_time desc);
create index idx_events_queue on events(next_attempt_at) where state in ('requested', 'sent', 'acknowledged');
create index idx_events_device on events(device_id);
create index idx_events_profile on events(profile_id);
create trigger trg_events_updated before update on events
  for each row execute function set_updated_at();

-- ================================================================ sync runs
create table sync_runs (
  id            uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  resource      text not null check (resource in ('devices','groups','profiles','users','all')),
  status        text not null default 'running' check (status in ('running','succeeded','failed')),
  items         int not null default 0,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index idx_sync_runs_enterprise on sync_runs(enterprise_id, started_at desc);

-- ========================================================= worker functions
-- Atomically claim due events so two workers never process the same row.
create or replace function claim_due_events(p_states event_state[], p_limit int default 20)
returns setof events
language sql as $$
  update events e
     set locked_until = now() + interval '2 minutes'
   where e.id in (
     select id from events
      where state = any(p_states)
        and next_attempt_at <= now()
        and (locked_until is null or locked_until < now())
      order by next_attempt_at
      limit p_limit
      for update skip locked
   )
  returning e.*;
$$;

-- Expire unconfirmed destructive commands.
create or replace function expire_unconfirmed_events()
returns int
language sql as $$
  with x as (
    update events
       set state = 'cancelled',
           error_code = 'COMMAND_CONFIRMATION_EXPIRED',
           error_message = 'Confirmation window expired',
           completed_at = now()
     where state = 'awaiting_confirmation'
       and confirm_expires_at < now()
    returning 1
  ) select count(*)::int from x;
$$;

-- Dashboard counters in one round trip.
create or replace function enterprise_overview(p_enterprise uuid)
returns json
language sql stable as $$
  select json_build_object(
    'devices',        (select count(*) from devices  where enterprise_id = p_enterprise and not is_removed),
    'android',        (select count(*) from devices  where enterprise_id = p_enterprise and not is_removed and platform = 'android'),
    'ios',            (select count(*) from devices  where enterprise_id = p_enterprise and not is_removed and platform = 'ios'),
    'lost_mode',      (select count(*) from devices  where enterprise_id = p_enterprise and is_lost_mode),
    'groups',         (select count(*) from groups   where enterprise_id = p_enterprise),
    'profiles',       (select count(*) from profiles where enterprise_id = p_enterprise and state <> 'deleted'),
    'pending_events', (select count(*) from events   where enterprise_id = p_enterprise and state in ('requested','sent','awaiting_confirmation')),
    'backlog',        (select count(*) from events   where enterprise_id = p_enterprise and state = 'dead'),
    'last_sync',      (select max(finished_at) from sync_runs where enterprise_id = p_enterprise and status = 'succeeded')
  );
$$;

-- ===================================================================== RLS
-- Enabled everywhere with no policies: only the service-role key (backend)
-- can read or write. Never ship the service-role key to the browser.
alter table enterprises          enable row level security;
alter table admins               enable row level security;
alter table otp_codes            enable row level security;
alter table sessions             enable row level security;
alter table zoho_connections     enable row level security;
alter table oauth_states         enable row level security;
alter table mdm_users            enable row level security;
alter table devices              enable row level security;
alter table groups               enable row level security;
alter table group_devices        enable row level security;
alter table profiles             enable row level security;
alter table profile_groups       enable row level security;
alter table announcements        enable row level security;
alter table announcement_targets enable row level security;
alter table events               enable row level security;
alter table sync_runs            enable row level security;
alter table error_codes          enable row level security;

revoke execute on function claim_due_events(event_state[], int) from public, anon, authenticated;
revoke execute on function expire_unconfirmed_events()          from public, anon, authenticated;
revoke execute on function enterprise_overview(uuid)            from public, anon, authenticated;
grant  execute on function claim_due_events(event_state[], int) to service_role;
grant  execute on function expire_unconfirmed_events()          to service_role;
grant  execute on function enterprise_overview(uuid)            to service_role;
