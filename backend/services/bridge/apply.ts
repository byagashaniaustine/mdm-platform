// Phase 2 apply path. Takes reconcile's per-device decisions and turns them
// into real Zoho moves + announcement sends by submitting events through the
// existing executor pipeline. Zero direct Zoho fetch here — the executors in
// services/groups.ts and services/announcements.ts own the API calls, retries,
// dedup, and backoff.
//
// Invariants this path enforces:
//   1. Zoho is source of truth. Pre-sync all tier groups from Zoho into DB
//      before computing removes, so decisions are made against Zoho's reality
//      rather than our possibly-stale mirror.
//   2. Each device is in exactly ONE tier group at a time. Any membership in
//      another mapped tier group gets removed before the add.
//   3. Legacy / non-tier groups (ITdept, sales, etc.) are untouched.
//   4. Post-move re-sync against Zoho; `applied_tier` is only stamped if the
//      device is observed in the target group AFTER the sync.
//   5. All work is idempotent via `events.idempotency_key = auto:<loan>:<tier>:<op>`.
//
// Guard order (short-circuits at the first match):
//   1. settings.dry_run                → outcome.skipped = 'dry_run'
//   2. no plan for (tier, platform)    → outcome.skipped = 'no_mapping'
//   3. device already in target group  → outcome.skipped = 'same_tier'
//
// See LOAN_DEVICE_AUTOMATION.md §10 (apply path) and §11 (idempotency).

import { db, run } from "../../lib/db.ts";
import { log } from "../../lib/log.ts";
import { submitOperation } from "../events.ts";
import { syncGroupMembership } from "../sync.ts";
import type { DeviceDecision } from "./reconcile.ts";
import { loadPlan } from "./policy.ts";
import type { Tier } from "./tiers.ts";

export interface AutomationSettings {
  enterprise_id: string;
  enabled: boolean;
  dry_run: boolean;
  max_changes_per_run: number;
  max_pct_per_run: number;
}

export type ApplySkipReason = "dry_run" | "same_tier" | "no_mapping" | "no_platform" | "no_loan_id";

export interface ApplyOutcome {
  deviceId: string;
  from: Tier | null;
  to: Tier;
  moved: boolean;
  announcementSent: boolean;
  skipped?: ApplySkipReason;
  targetGroup?: string;
  announcement?: string | null;
  removedFrom?: string[];      // group names actually removed from, post-verification
  error?: { code: string; message: string };
}

export interface ApplyBatchResult {
  attempted: number;
  moved: number;
  announced: number;
  skipped: Record<ApplySkipReason, number>;
  errors: number;
  outcomes: ApplyOutcome[];
}

/**
 * Walk every decision; for the ones that need a tier change, pre-sync affected
 * groups from Zoho, then enqueue remove(s) + add + announcement + post-sync.
 * applied_tier is only stamped if post-sync confirms the device is in target.
 */
export async function applyBatch(
  enterpriseId: string,
  decisions: DeviceDecision[],
  settings: AutomationSettings,
): Promise<ApplyBatchResult> {
  const outcomes: ApplyOutcome[] = [];
  const skipped: Record<ApplySkipReason, number> = { dry_run: 0, same_tier: 0, no_mapping: 0, no_platform: 0, no_loan_id: 0 };
  let moved = 0, announced = 0, errors = 0;

  if (settings.dry_run) {
    for (const d of decisions) {
      outcomes.push({ deviceId: d.deviceId, from: d.from, to: d.to, moved: false, announcementSent: false, skipped: "dry_run" });
      skipped.dry_run++;
    }
    return { attempted: decisions.length, moved: 0, announced: 0, skipped, errors: 0, outcomes };
  }

  const plan = await loadPlan(enterpriseId);
  const tierGroupRowIds = [...new Set([...plan.values()].map((p) => p.targetGroupRowId))];

  // STEP A — Pre-sync every mapped tier group from Zoho. One listGroupMembers per
  // group (6-12 calls for the typical mapping). After this, our group_devices
  // table reflects Zoho's actual state and we can trust it for compute.
  for (const gid of tierGroupRowIds) {
    try {
      await syncGroupMembership(enterpriseId, gid);
    } catch (e) {
      log("warn", "automation.apply_presync_failed", { enterprise_id: enterpriseId, group_id: gid, error: String(e) });
    }
  }

  // Group row id → human name for outcome display.
  const groupNames = new Map<string, string>();
  for (const p of plan.values()) groupNames.set(p.targetGroupRowId, p.targetGroupName);

  for (const d of decisions) {
    const o: ApplyOutcome = { deviceId: d.deviceId, from: d.from, to: d.to, moved: false, announcementSent: false };
    try {
      if (!d.platform) { o.skipped = "no_platform"; skipped.no_platform++; outcomes.push(o); continue; }
      if (!d.loanId)   { o.skipped = "no_loan_id";  skipped.no_loan_id++;  outcomes.push(o); continue; }
      const tp = plan.get(`${d.to}:${d.platform}`);
      if (!tp) { o.skipped = "no_mapping"; skipped.no_mapping++; outcomes.push(o); continue; }

      o.targetGroup = tp.targetGroupName;
      o.announcement = tp.announcementName;

      // STEP B — Compute removals from Zoho-synced DB state. The device must leave
      // every mapped tier group that isn't the target.
      const memberships = await run<{ group_id: string }[]>(
        db().from("group_devices")
          .select("group_id")
          .eq("device_id", d.deviceId)
          .in("group_id", tierGroupRowIds),
      );
      const alreadyInTarget = memberships.some((m) => m.group_id === tp.targetGroupRowId);
      const toRemove = memberships.filter((m) => m.group_id !== tp.targetGroupRowId).map((m) => m.group_id);

      if (alreadyInTarget && !toRemove.length) {
        o.skipped = "same_tier";
        skipped.same_tier++;
        await stampApplied(enterpriseId, d.deviceId, d.to, tp.targetGroupRowId, d.dpd);
        outcomes.push(o);
        continue;
      }

      const key = `auto:${d.loanId}:${d.to}`;

      // STEP C — Enqueue remove(s). Each gets its own idempotency key so a
      // single-device move leaves a clean per-group trail. The executor
      // tolerates ZOHO_NOT_FOUND (already removed) gracefully.
      for (const gid of toRemove) {
        try {
          await submitOperation({
            enterpriseId,
            category: "group",
            action: "group.remove_device",
            groupId: gid,
            deviceId: d.deviceId,
            params: { device_id: d.deviceId },
            idempotencyKey: `${key}:rm:${gid}`,
          });
        } catch (e) {
          const err = e as { code?: string };
          if (err.code !== "ZOHO_NOT_FOUND") throw e; // already removed is fine
        }
      }

      // STEP D — Enqueue add to target. The executor dedupes against Zoho's
      // live membership, so it's safe even if Zoho already has us there.
      if (!alreadyInTarget) {
        await submitOperation({
          enterpriseId,
          category: "group",
          action: "group.add_devices",
          groupId: tp.targetGroupRowId,
          params: { device_ids: [d.deviceId] },
          idempotencyKey: `${key}:add`,
        });
      }

      // STEP E — Post-sync affected groups from Zoho. This mirrors Zoho's
      // actual (not acked) state back into our DB.
      const affected = new Set<string>(toRemove);
      affected.add(tp.targetGroupRowId);
      for (const gid of affected) {
        try { await syncGroupMembership(enterpriseId, gid); }
        catch (e) { log("warn", "automation.apply_postsync_failed", { enterprise_id: enterpriseId, group_id: gid, error: String(e) }); }
      }

      // STEP F — Verify. Read the device's actual membership from the post-synced DB.
      const verifiedMemberships = await run<{ group_id: string }[]>(
        db().from("group_devices")
          .select("group_id")
          .eq("device_id", d.deviceId)
          .in("group_id", tierGroupRowIds),
      );
      const nowInTarget = verifiedMemberships.some((m) => m.group_id === tp.targetGroupRowId);
      const stillStuckIn = verifiedMemberships.filter((m) => m.group_id !== tp.targetGroupRowId).map((m) => m.group_id);

      if (!nowInTarget) {
        o.error = { code: "APPLY_MOVE_NOT_VISIBLE", message: `Zoho acked the add to "${tp.targetGroupName}" but post-sync shows the device is not a member.` };
        errors++;
        outcomes.push(o);
        continue;
      }
      if (stillStuckIn.length) {
        // We ARE in the target but ALSO stuck in another tier group. Record it
        // as a soft error so operators see it, but still mark moved=true since
        // the primary intent (reach target) succeeded.
        o.error = { code: "APPLY_DRIFT", message: `Device also still in: ${stillStuckIn.map((g) => groupNames.get(g) ?? g).join(", ")}` };
      }

      o.moved = true;
      o.removedFrom = toRemove.map((g) => groupNames.get(g) ?? g);
      moved++;

      // STEP G — Fire tier-entry announcement to the specific device (not the
      // group) so repeat-moves don't spam the whole group.
      if (tp.announcementRowId) {
        await submitOperation({
          enterpriseId,
          category: "announcement",
          action: "announcement.send",
          announcementId: tp.announcementRowId,
          deviceId: d.deviceId,
          params: { group_ids: [], device_ids: [d.deviceId] },
          idempotencyKey: `${key}:ann`,
        });
        o.announcementSent = true;
        announced++;
      }

      // STEP H — Stamp applied_tier only after verified success.
      await stampApplied(enterpriseId, d.deviceId, d.to, tp.targetGroupRowId, d.dpd);
    } catch (e) {
      errors++;
      const err = e as { code?: string; message?: string };
      o.error = { code: err.code ?? "APPLY_FAILED", message: err.message ?? String(e) };
      log("warn", "automation.apply_failed", { enterprise_id: enterpriseId, device_id: d.deviceId, to: d.to, error: o.error });
    }
    outcomes.push(o);
  }

  return { attempted: decisions.length, moved, announced, skipped, errors, outcomes };
}

/** Upsert device_tier_state.applied_tier + current_group_id after verified move. */
async function stampApplied(enterpriseId: string, deviceId: string, tier: Tier, groupRowId: string, dpd: number): Promise<void> {
  await run(db().from("device_tier_state").upsert({
    enterprise_id: enterpriseId,
    device_id: deviceId,
    desired_tier: tier,
    applied_tier: tier,
    current_group_id: groupRowId,
    last_loan_dpd: dpd >= 0 ? dpd : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "enterprise_id,device_id" }));
}
