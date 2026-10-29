// Tier → Zoho group + optional announcement registry. Pure DB reads; no I/O to
// Zoho. apply.ts consults this to know (a) which group to move the device into
// and (b) which announcement to fire on entry.
//
// Rows come from `tier_groups` (migration 012) and `tier_announcements`
// (migration 013). An admin populates both via the one-shot bootstrap route;
// nothing is created lazily.

import { db, run } from "../../lib/db.ts";
import type { Tier } from "./tiers.ts";

export type Platform = "android" | "ios";

export interface TierPlan {
  tier: Tier;
  platform: Platform;
  /** `groups.id` — our DB row, used for FK stamping on device_tier_state.current_group_id. */
  targetGroupRowId: string;
  /** `groups.zoho_group_id` — what we pass to Zoho's moveDevices / sendAnnouncementToGroups. */
  targetGroupZohoId: string;
  targetGroupName: string;
  /** `announcements.id`, or null when no announcement should fire on entry to this tier. */
  announcementRowId: string | null;
  /** `announcements.zoho_announcement_id`. */
  announcementZohoId: string | null;
  announcementName: string | null;
}

type PlanKey = `${Tier}:${Platform}`;

interface TierGroupRow {
  tier: string;
  platform: string;
  group_id: string;
  groups: { id: string; name: string; zoho_group_id: string | null } | Array<{ id: string; name: string; zoho_group_id: string | null }>;
}

interface TierAnnRow {
  tier: string;
  announcement_id: string;
  announcements: { id: string; name: string; zoho_announcement_id: string | null } | Array<{ id: string; name: string; zoho_announcement_id: string | null }>;
}

/** Flatten PostgREST embed (either object or 1-elt array) into the first element. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Load the entire tier plan for one enterprise. Call once per reconcile batch. */
export async function loadPlan(enterpriseId: string): Promise<Map<PlanKey, TierPlan>> {
  const [groupRows, annRows] = await Promise.all([
    run<TierGroupRow[]>(
      db().from("tier_groups")
        .select("tier, platform, group_id, groups(id, name, zoho_group_id)")
        .eq("enterprise_id", enterpriseId),
    ),
    run<TierAnnRow[]>(
      db().from("tier_announcements")
        .select("tier, announcement_id, announcements(id, name, zoho_announcement_id)")
        .eq("enterprise_id", enterpriseId),
    ),
  ]);

  const annByTier = new Map<string, { rowId: string; zohoId: string | null; name: string }>();
  for (const r of annRows) {
    const a = one(r.announcements);
    if (!a) continue;
    annByTier.set(r.tier, { rowId: a.id, zohoId: a.zoho_announcement_id, name: a.name });
  }

  const plan = new Map<PlanKey, TierPlan>();
  for (const r of groupRows) {
    const g = one(r.groups);
    if (!g) continue;
    const platform = r.platform === "ios" ? "ios" : r.platform === "android" ? "android" : null;
    if (!platform) continue;
    const ann = annByTier.get(r.tier) ?? null;
    plan.set(`${r.tier as Tier}:${platform}`, {
      tier: r.tier as Tier,
      platform,
      targetGroupRowId: g.id,
      targetGroupZohoId: g.zoho_group_id ?? "",
      targetGroupName: g.name,
      announcementRowId: ann?.rowId ?? null,
      announcementZohoId: ann?.zohoId ?? null,
      announcementName: ann?.name ?? null,
    });
  }
  return plan;
}
