-- =============================================================================
-- 019 — group_sync_hints: reactive hot-group sync (PR 5).
--
-- ME MDM Cloud exposes no outbound webhook / event API (confirmed by scanning
-- MDM_Dev_Guide.pdf — 513 pages, zero push surface). "Near real-time" has to
-- come from tightening *our* reads, not Zoho pushing to us.
--
-- apply_queue marks every group it touches as hot for 15 min. The worker's
-- sync pass, in addition to the 15-min full-tenant sweep, re-reads any hot
-- group every ~60s via syncGroupMembership. This covers the "user triggered
-- a loan event and is watching the UI" window without burning Zoho API quota
-- on groups nobody cares about.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists group_sync_hints (
  enterprise_id    uuid not null references enterprises(id) on delete cascade,
  group_id         uuid not null references groups(id)      on delete cascade,
  hot_until        timestamptz not null,                     -- after this, drop back to the 15-min cadence
  last_synced_at   timestamptz,                              -- updated by the hot-drain pass; NULL means "sync me now"
  updated_at       timestamptz not null default now(),
  primary key (enterprise_id, group_id)
);

-- Drain index: ordered by expiry (hot first) + stalest-first within that. No
-- partial predicate on hot_until — Postgres rejects now() in index predicates
-- because it isn't IMMUTABLE. The table stays small (bounded by #tier groups
-- × #active enterprises), so a full-index scan is fine.
create index if not exists idx_group_sync_hints_due
  on group_sync_hints (hot_until desc, last_synced_at nulls first);
