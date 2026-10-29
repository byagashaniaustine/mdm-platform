-- =============================================================================
-- 012 — Loan-driven device automation (Phase 0: wiring + dry-run)
-- See LOAN_DEVICE_AUTOMATION.md §7. All tables are enterprise-scoped with RLS.
-- Apply via Supabase SQL Editor; safe to re-run.
-- =============================================================================

-- 1) Device ↔ loan link. One active loan per device at a time.
create table if not exists loan_links (
  id                 uuid primary key default gen_random_uuid(),
  enterprise_id      uuid not null references enterprises(id) on delete cascade,
  device_id          uuid not null references devices(id)     on delete cascade,
  fineract_loan_id   text not null,
  fineract_client_id text,
  external_id        text not null,            -- device serial/IMEI stamped on loan.externalId
  product_id         int  not null,            -- 1 = 7-Day, 2 = 14-Day, 3 = 28-Day
  disbursed_on       date,
  due_on             date,
  status             text not null default 'active',   -- active | closed | written_off
  closed_on          date,
  created_at         timestamptz not null default now()
);
-- At most one active link per device (closed/written_off rows accumulate for history).
create unique index if not exists idx_loan_links_one_active
  on loan_links (enterprise_id, device_id)
  where status = 'active';
create index if not exists idx_loan_links_loan
  on loan_links (enterprise_id, fineract_loan_id);
create index if not exists idx_loan_links_ext
  on loan_links (enterprise_id, external_id);
alter table loan_links enable row level security;

-- 2) Tier → Zoho group registry. Admin populates this before enabling automation.
create table if not exists tier_groups (
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  tier          text not null,                 -- undisbursed | disbursed | due_2d | overdue_2d | locked | released
  platform      text not null,                 -- android | ios
  group_id      uuid not null references groups(id) on delete cascade,
  updated_at    timestamptz not null default now(),
  primary key (enterprise_id, tier, platform)
);
alter table tier_groups enable row level security;

-- 3) Desired vs applied tier per device. Reconcile is idempotent against this row.
create table if not exists device_tier_state (
  enterprise_id   uuid not null references enterprises(id) on delete cascade,
  device_id       uuid not null references devices(id)     on delete cascade,
  desired_tier    text,
  desired_group_id uuid references groups(id) on delete set null,
  applied_tier    text,
  last_loan_dpd   int,
  updated_at      timestamptz not null default now(),
  primary key (enterprise_id, device_id)
);
alter table device_tier_state enable row level security;

-- 4) Automation run log. One row per webhook delivery or daily tick.
create table if not exists automation_runs (
  id            uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  trigger       text not null,                 -- webhook:<entity>/<action> | daily_tick | manual
  considered    int  not null default 0,
  changed       int  not null default 0,       -- devices whose desired_tier moved this run
  held          boolean not null default false,
  hold_reason   text,
  detail        jsonb,                         -- per-device {device_id, from, to, group} entries
  created_at    timestamptz not null default now()
);
create index if not exists idx_automation_runs_enterprise_created
  on automation_runs (enterprise_id, created_at desc);
alter table automation_runs enable row level security;

-- 5) Per-enterprise automation config + kill switch.
create table if not exists automation_settings (
  enterprise_id        uuid primary key references enterprises(id) on delete cascade,
  enabled              boolean not null default false,  -- master off by default
  dry_run              boolean not null default true,   -- Phase 0: compute + log only
  max_changes_per_run  int not null default 25,         -- blast-radius absolute cap
  max_pct_per_run      int not null default 20,         -- blast-radius percentage cap
  webhook_secret_enc   text,                            -- HMAC shared secret (encrypted via lib/crypto)
  updated_at           timestamptz not null default now()
);
alter table automation_settings enable row level security;

-- 6) Error codes the backend uses — events.error_code is an FK to this table,
-- so Phase 0 registers the Bridge codes up front even though dry-run does not
-- raise events yet.
insert into error_codes (code, http_status, message, retryable) values
  ('FINERACT_UNCONFIGURED', 412, 'Fineract integration is not configured on this server.', false),
  ('FINERACT_UNAUTHORIZED', 502, 'Fineract rejected the service credentials.',             false),
  ('FINERACT_BAD_REQUEST',  502, 'Fineract rejected the request.',                          false),
  ('FINERACT_NOT_FOUND',    404, 'The item does not exist in Fineract.',                    false),
  ('FINERACT_UNAVAILABLE',  503, 'Fineract is unavailable. Will retry.',                    true),
  ('AUTOMATION_DISABLED',   412, 'Loan-driven automation is disabled for this enterprise.', false),
  ('AUTOMATION_HELD',       409, 'Automation batch exceeded blast-radius caps; held, nothing applied.', false)
on conflict (code) do nothing;

-- 7) RLS policies — service_role full access (project convention: backend uses service key).
drop policy if exists loan_links_service_all          on loan_links;
drop policy if exists tier_groups_service_all         on tier_groups;
drop policy if exists device_tier_state_service_all   on device_tier_state;
drop policy if exists automation_runs_service_all     on automation_runs;
drop policy if exists automation_settings_service_all on automation_settings;

create policy loan_links_service_all          on loan_links          for all to service_role using (true) with check (true);
create policy tier_groups_service_all         on tier_groups         for all to service_role using (true) with check (true);
create policy device_tier_state_service_all   on device_tier_state   for all to service_role using (true) with check (true);
create policy automation_runs_service_all     on automation_runs     for all to service_role using (true) with check (true);
create policy automation_settings_service_all on automation_settings for all to service_role using (true) with check (true);
