// Reactive hot-group sync (migration 019, PR 5).
//
// ME MDM Cloud has no outbound event API, so we can't react to Zoho pushes.
// Instead we track "groups the automation just touched" and re-poll them at
// 60s instead of the 15-min full-tenant cadence. Covers the "user just
// triggered a loan event and is watching the UI" window without wasting
// Zoho API quota on groups nobody cares about.
import { db, run } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import { syncGroupMembership } from "./sync.ts";

const HOT_WINDOW_MS = 15 * 60 * 1000;
const HOT_RESYNC_THRESHOLD_MS = 60 * 1000;
const MAX_HOT_SYNCS_PER_TICK = 10;

/**
 * Mark a group as hot — extend its hot_until to now+15min and leave
 * last_synced_at alone so the next hot-drain picks it up. Called from
 * apply_queue after enqueue + terminal transition.
 */
export async function markGroupHot(enterpriseId: string, groupRowId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const hotUntil = new Date(Date.now() + HOT_WINDOW_MS).toISOString();
  await run(db().from("group_sync_hints").upsert({
    enterprise_id: enterpriseId,
    group_id: groupRowId,
    hot_until: hotUntil,
    updated_at: nowIso,
  }, { onConflict: "enterprise_id,group_id" }));
}

interface Hint {
  enterprise_id: string;
  group_id: string;
  hot_until: string;
  last_synced_at: string | null;
}

/**
 * Pick hot groups that are stale beyond HOT_RESYNC_THRESHOLD_MS and sync their
 * membership from Zoho via listGroupMembers. Expired hot_until rows are left
 * alone (the 15-min full-tenant sweep handles them). Returns summary stats.
 */
export async function drainHotGroupSyncs(): Promise<{ synced: number; skipped: number }> {
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - HOT_RESYNC_THRESHOLD_MS).toISOString();
  const hints = await run<Hint[]>(
    db().from("group_sync_hints")
      .select("enterprise_id, group_id, hot_until, last_synced_at")
      .gt("hot_until", nowIso)
      .or(`last_synced_at.is.null,last_synced_at.lt.${staleBefore}`)
      .order("last_synced_at", { ascending: true, nullsFirst: true })
      .limit(MAX_HOT_SYNCS_PER_TICK),
  );
  if (!hints.length) return { synced: 0, skipped: 0 };

  let synced = 0, skipped = 0;
  for (const h of hints) {
    try {
      await syncGroupMembership(h.enterprise_id, h.group_id);
      await run(db().from("group_sync_hints").update({
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("enterprise_id", h.enterprise_id).eq("group_id", h.group_id));
      synced++;
    } catch (e) {
      skipped++;
      log("warn", "group_sync_hints.sync_failed", { enterprise_id: h.enterprise_id, group_id: h.group_id, error: String(e) });
    }
  }
  return { synced, skipped };
}

/** Daily purge — drop hints that expired more than 7 days ago. */
export async function purgeExpiredHints(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { count } = await db().from("group_sync_hints").delete({ count: "exact" }).lt("hot_until", cutoff);
  return count ?? 0;
}
