-- =============================================================================
-- 013 — Tier→announcement registry + current group tracking on device_tier_state
-- Phase 2 companion to 012. Apply via Supabase SQL Editor; safe to re-run.
-- =============================================================================

-- Which announcement fires when a device enters a given tier. One per tier max.
create table if not exists tier_announcements (
  enterprise_id   uuid not null references enterprises(id)   on delete cascade,
  tier            text not null,
  announcement_id uuid not null references announcements(id) on delete cascade,
  updated_at      timestamptz not null default now(),
  primary key (enterprise_id, tier)
);
alter table tier_announcements enable row level security;

drop policy if exists tier_announcements_service_all on tier_announcements;
create policy tier_announcements_service_all on tier_announcements
  for all to service_role using (true) with check (true);

-- Where the device is right now, so the apply path knows what group to move FROM
-- without an extra Zoho round-trip. Nullable: first move after enrollment uses
-- addGroupMembers() instead of moveDevices().
alter table device_tier_state
  add column if not exists current_group_id uuid references groups(id) on delete set null;
