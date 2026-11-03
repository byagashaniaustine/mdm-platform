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
//   2. Each device is in exactly ONE tier group at a time (plus any admin
//      "home" groups like ITdept/sales — those coexist and we never touch
//      them). Zoho allows multi-group membership; the loan automation owns
//      ONLY tier-group placement.
//   3. Devices live permanently in some tier group — bootstrapped by the admin
//      into Undisbursed before any loan. The automation moves them between
//      tier groups and NEVER removes them from the tier-group set entirely.
//   4. Post-move re-sync against Zoho; `applied_tier` is only stamped if the
//      device is observed in the target tier group AFTER the sync.
//   5. All work is idempotent via `events.idempotency_key = auto:<loan>:<tier>:<op>`.
//
// Guard order (short-circuits at the first match):
//   1. settings.dry_run                → outcome.skipped = 'dry_run'
//   2. no plan for (tier, platform)    → outcome.skipped = 'no_mapping'
//   3. device already in target group  → outcome.skipped = 'same_tier'
//
// See LOAN_DEVICE_AUTOMATION.md §10 (apply path) and §11 (idempotency).

import { db, run, runMaybe } from "../../lib/db.ts";
import { log } from "../../lib/log.ts";
import * as zoho from "../../zoho/api.ts";
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

  // Process decisions in concurrent chunks of 4 — mirrors the pattern proven
  // safe in sync.ts::syncGroups. Per-device contention is already serialised
  // by events.idempotency_key, so cross-decision concurrency is fine.
  const BATCH_SIZE = 4;
  for (let i = 0; i < decisions.length; i += BATCH_SIZE) {
    const batch = decisions.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((d) => applyOneDecision(enterpriseId, d, plan, tierGroupRowIds, groupNames)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const d = batch[j];
      if (r.status === "fulfilled") {
        const o = r.value;
        outcomes.push(o);
        if (o.moved) moved++;
        if (o.announcementSent) announced++;
        if (o.skipped) skipped[o.skipped]++;
        if (o.error) errors++;
      } else {
        // Promise.allSettled never rejects, but TS wants us to narrow.
        errors++;
        const err = r.reason as { code?: string; message?: string };
        const o: ApplyOutcome = {
          deviceId: d.deviceId, from: d.from, to: d.to,
          moved: false, announcementSent: false,
          error: { code: err?.code ?? "APPLY_FAILED", message: err?.message ?? String(r.reason) },
        };
        outcomes.push(o);
        log("warn", "automation.apply_failed", { enterprise_id: enterpriseId, device_id: d.deviceId, to: d.to, error: o.error });
      }
    }
  }

  return { attempted: decisions.length, moved, announced, skipped, errors, outcomes };
}

/**
 * Single-device apply. Returns a fully-populated ApplyOutcome so the caller
 * can merge batch tallies without mutating shared state. Never throws for
 * expected skips (no_platform / no_loan_id / no_mapping / same_tier) — it
 * returns an outcome with the right `skipped` field. Does throw for anything
 * genuinely unexpected (Zoho error, DB error) — the batch loop catches it.
 *
 * Exported so apply_queue.ts can call it per-job without going through
 * applyBatch's pre-sync (the queue version pre-syncs once per claim batch).
 */
export async function applyOneDecision(
  enterpriseId: string,
  d: DeviceDecision,
  plan: Awaited<ReturnType<typeof loadPlan>>,
  tierGroupRowIds: string[],
  groupNames: Map<string, string>,
): Promise<ApplyOutcome> {
  const o: ApplyOutcome = { deviceId: d.deviceId, from: d.from, to: d.to, moved: false, announcementSent: false };
  if (!d.platform) { o.skipped = "no_platform"; return o; }
  if (!d.loanId)   { o.skipped = "no_loan_id";  return o; }
  const tp = plan.get(`${d.to}:${d.platform}`);
  if (!tp) { o.skipped = "no_mapping"; return o; }

  o.targetGroup = tp.targetGroupName;
  o.announcement = tp.announcementName;

  // STEP B — Compute removals from Zoho-synced DB state. Scope: tier groups
  // ONLY. Home groups (ITdept, sales, …) coexist with tier membership and we
  // never touch them. Devices live permanently in some tier group (Undisbursed
  // by default, bootstrapped by the admin before any loan).
  const memberships = await run<{ group_id: string }[]>(
    db().from("group_devices").select("group_id").eq("device_id", d.deviceId).in("group_id", tierGroupRowIds),
  );
  const alreadyInTarget = memberships.some((m) => m.group_id === tp.targetGroupRowId);
  const toRemove = memberships.filter((m) => m.group_id !== tp.targetGroupRowId).map((m) => m.group_id);

  if (alreadyInTarget && !toRemove.length) {
    o.skipped = "same_tier";
    await stampApplied(enterpriseId, d.deviceId, d.to, tp.targetGroupRowId, d.dpd);
    return o;
  }

  const key = `auto:${d.loanId}:${d.to}`;

  // STEP C — Enqueue remove(s). The executor tolerates ZOHO_NOT_FOUND gracefully.
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
      if (err.code !== "ZOHO_NOT_FOUND") throw e;
    }
  }

  // STEP D — Enqueue add to target.
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

  // STEP E — Post-sync (fire-and-forget) so the mirror catches up for the UI
  // between apply and the next Supabase Realtime tick. Not awaited — verify
  // below reads from Zoho directly, so apply correctness no longer depends on
  // the mirror reflecting reality.
  const affected = new Set<string>(toRemove);
  affected.add(tp.targetGroupRowId);
  for (const gid of affected) {
    syncGroupMembership(enterpriseId, gid).catch((e) =>
      log("warn", "automation.apply_postsync_failed", { enterprise_id: enterpriseId, group_id: gid, error: String(e) })
    );
  }

  // STEP F — Verify directly against Zoho (not the mirror). Short internal
  // retry absorbs Zoho's typical 3-15s group-membership propagation; the outer
  // apply_queue backoff still handles anything that outlasts it.
  const { nowInTarget, stillStuckIn, failedTargetRead } = await verifyAddFromZoho(
    enterpriseId, d.deviceId, tp.targetGroupRowId, tierGroupRowIds,
  );

  if (failedTargetRead) {
    o.error = { code: "APPLY_VERIFY_UNREACHABLE", message: `Could not read "${tp.targetGroupName}" members from Zoho after add.` };
    return o;
  }
  if (!nowInTarget) {
    o.error = { code: "APPLY_MOVE_NOT_VISIBLE", message: `Zoho acked the add to "${tp.targetGroupName}" but Zoho still does not list the device as a member after ${VERIFY_DELAYS_MS.reduce((a, b) => a + b, 0) / 1000}s.` };
    return o;
  }
  if (stillStuckIn.length) {
    o.error = { code: "APPLY_DRIFT", message: `Device also still in: ${stillStuckIn.map((g) => groupNames.get(g) ?? g).join(", ")}` };
  }

  o.moved = true;
  o.removedFrom = toRemove.map((g) => groupNames.get(g) ?? g);

  // STEP G — Announcement to the specific device.
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
  }

  // STEP H — Stamp applied_tier only after verified success.
  await stampApplied(enterpriseId, d.deviceId, d.to, tp.targetGroupRowId, d.dpd);
  return o;
}

/**
 * Verify-step retry cadence (ms). Zoho's group-membership propagation runs
 * ~3-15s per their status-page history; these three delays total ~17s, long
 * enough to catch the usual tail while staying well under the apply_queue
 * claim-lock (120s).
 */
const VERIFY_DELAYS_MS = [2_000, 5_000, 10_000];

/** Direct-from-Zoho verify of a group.add_devices action, with internal retries. */
async function verifyAddFromZoho(
  enterpriseId: string,
  deviceRowId: string,
  targetGroupRowId: string,
  tierGroupRowIds: string[],
): Promise<{ nowInTarget: boolean; stillStuckIn: string[]; failedTargetRead: boolean }> {
  let last: Awaited<ReturnType<typeof queryZohoMemberships>> | null = null;
  for (let i = 0; i <= VERIFY_DELAYS_MS.length; i++) {
    last = await queryZohoMemberships(enterpriseId, deviceRowId, tierGroupRowIds);
    if (last.membership.get(targetGroupRowId)) break;
    if (last.failed.has(targetGroupRowId)) break; // network/auth error — don't burn more retries
    if (i < VERIFY_DELAYS_MS.length) await new Promise((r) => setTimeout(r, VERIFY_DELAYS_MS[i]));
  }
  const membership = last?.membership ?? new Map<string, boolean>();
  const failed = last?.failed ?? new Set<string>();
  const nowInTarget = !!membership.get(targetGroupRowId);
  const stillStuckIn = [...membership.entries()]
    .filter(([gid, inGroup]) => gid !== targetGroupRowId && inGroup)
    .map(([gid]) => gid);
  return { nowInTarget, stillStuckIn, failedTargetRead: failed.has(targetGroupRowId) };
}

/** Upsert device_tier_state.applied_tier + current_group_id after verified move. */
async function stampApplied(enterpriseId: string, deviceId: string, tier: Tier, groupRowId: string, dpd: number): Promise<void> {
  const nowIso = new Date().toISOString();
  await run(db().from("device_tier_state").upsert({
    enterprise_id: enterpriseId,
    device_id: deviceId,
    desired_tier: tier,
    applied_tier: tier,
    current_group_id: groupRowId,
    last_loan_dpd: dpd >= 0 ? dpd : null,
    observed_state: tier,
    observed_at: nowIso,
    last_error: null,
    updated_at: nowIso,
  }, { onConflict: "enterprise_id,device_id" }));
}

/**
 * Ask Zoho directly which of `groupRowIds` the device actually belongs to.
 * Returns a per-group boolean. Groups whose read failed are in `failed` and
 * get no entry in `membership` — callers must treat them as "unknown".
 *
 * This is the verify + observed-state source of truth. Reads from the
 * group_devices mirror are intentionally avoided here: that mirror lags Zoho
 * (eventual-consistency + add-only reconcile in syncGroupMembership), which
 * was the APPLY_MOVE_NOT_VISIBLE root cause.
 */
export async function queryZohoMemberships(
  enterpriseId: string,
  deviceRowId: string,
  groupRowIds: string[],
): Promise<{ membership: Map<string, boolean>; failed: Set<string> }> {
  const membership = new Map<string, boolean>();
  const failed = new Set<string>();
  if (!groupRowIds.length) return { membership, failed };

  const dev = await runMaybe<{ zoho_device_id: number | null }>(
    db().from("devices").select("zoho_device_id").eq("id", deviceRowId).eq("enterprise_id", enterpriseId).maybeSingle(),
  );
  const zohoDeviceId = String(dev?.zoho_device_id ?? "");
  if (!zohoDeviceId) {
    for (const gid of groupRowIds) failed.add(gid);
    return { membership, failed };
  }

  const groups = await run<{ id: string; zoho_group_id: string | null }[]>(
    db().from("groups").select("id, zoho_group_id").in("id", groupRowIds).eq("enterprise_id", enterpriseId),
  );

  for (const g of groups) {
    if (!g.zoho_group_id) { failed.add(g.id); continue; }
    try {
      const members = await zoho.listGroupMembers(enterpriseId, g.zoho_group_id);
      const memberZohoIds = new Set<string>();
      for (const m of members) {
        const id = typeof m === "string" || typeof m === "number"
          ? String(m)
          : String((m as Record<string, unknown>).device_id ?? (m as Record<string, unknown>).member_id ?? (m as Record<string, unknown>).resource_id ?? "");
        if (id) memberZohoIds.add(id);
      }
      membership.set(g.id, memberZohoIds.has(zohoDeviceId));
    } catch (e) {
      log("warn", "automation.zoho_members_read_failed", { enterprise_id: enterpriseId, group_id: g.id, error: String(e) });
      failed.add(g.id);
    }
  }
  return { membership, failed };
}

/**
 * Re-read Zoho after a terminal apply_jobs transition and persist the device's
 * actual tier membership to device_tier_state. On Zoho failure, stamps
 * observed_state='unknown' + last_error so the frontend can show "we don't
 * know" instead of a stale applied_tier.
 *
 * Called from apply_queue.ts when a job reaches 'dead' (or 'applied' with
 * residual drift). The happy-path stampApplied() already writes observed_state
 * in-line, so this is purely for terminal-state truthing.
 */
export async function stampObserved(enterpriseId: string, deviceId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const plan = await loadPlan(enterpriseId);
  const tierGroupRowIds = [...new Set([...plan.values()].map((p) => p.targetGroupRowId))];
  const tierByGroupRowId = new Map<string, Tier>();
  for (const [key, p] of plan.entries()) {
    const tier = key.split(":")[0] as Tier;
    tierByGroupRowId.set(p.targetGroupRowId, tier);
  }

  const { membership, failed } = await queryZohoMemberships(enterpriseId, deviceId, tierGroupRowIds);
  const observedGroups = [...membership.entries()].filter(([, inGroup]) => inGroup).map(([gid]) => gid);
  const observedTier = observedGroups.length === 1 ? (tierByGroupRowId.get(observedGroups[0]) ?? null) : null;
  const unknown = failed.has(tierGroupRowIds[0]) && !observedGroups.length; // couldn't read any group
  const multiple = observedGroups.length > 1;

  const observed_state = unknown ? "unknown" : (observedTier ?? (multiple ? "drift" : "none"));
  const last_error = unknown ? "Zoho group-members read failed on terminal re-check" : (multiple ? `In multiple tier groups: ${observedGroups.join(", ")}` : null);

  await run(db().from("device_tier_state").upsert({
    enterprise_id: enterpriseId,
    device_id: deviceId,
    observed_state,
    observed_at: nowIso,
    last_error,
    current_group_id: observedGroups[0] ?? null,
    updated_at: nowIso,
  }, { onConflict: "enterprise_id,device_id" }));
}
