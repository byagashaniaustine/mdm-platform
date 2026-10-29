// Phase 0 reconcile: compute desired tier per device, resolve the intended Zoho
// group via tier_groups, update device_tier_state (desired only — applied stays
// unchanged), write one automation_runs row per batch. ZERO device-facing side
// effects. See LOAN_DEVICE_AUTOMATION.md §10 and §19 (Phase 0 acceptance).
import { db, run, runMaybe } from "../../lib/db.ts";
import { log } from "../../lib/log.ts";
import { applyBatch, type ApplyBatchResult } from "./apply.ts";
import { getLoan, type FineractLoanSummary } from "./fineract.ts";
import { listActive, type LoanLink } from "./link.ts";
import { tierFor, type Tier } from "./tiers.ts";

export interface AutomationSettings {
  enterprise_id: string;
  enabled: boolean;
  dry_run: boolean;
  max_changes_per_run: number;
  max_pct_per_run: number;
}

export interface DeviceDecision {
  deviceId: string;
  platform: "android" | "ios" | null;
  loanId: string;
  productId: number;
  dpd: number;
  from: Tier | null;        // prior desired_tier
  to: Tier;                 // newly computed desired_tier
  changed: boolean;
  intendedGroupId: string | null;   // tier_groups lookup; null when admin hasn't mapped it yet
  intendedGroupName: string | null;
  note?: string;            // link to spec: why this device was/wasn't counted as changed
}

export interface ReconcileBatchResult {
  trigger: string;
  considered: number;
  changed: number;
  held: boolean;
  holdReason?: string;
  decisions: DeviceDecision[];
  // Populated when settings.enabled and reconcile wasn't held. In dry-run every
  // decision reports skipped='dry_run' and no Zoho call fires.
  applied?: ApplyBatchResult;
}

/** Load (or synthesise defaults for) the enterprise's automation settings row. */
export async function getSettings(enterpriseId: string): Promise<AutomationSettings> {
  const row = await runMaybe<AutomationSettings>(
    db().from("automation_settings").select("*").eq("enterprise_id", enterpriseId).maybeSingle(),
  );
  return row ?? {
    enterprise_id: enterpriseId,
    enabled: false,
    dry_run: true,
    // Prod defaults, matching database migration 014. Dev enterprises without
    // a settings row inherit the fleet-ready caps too — safer than a surprise.
    max_changes_per_run: 100,
    max_pct_per_run: 50,
  };
}

/** Per-device prior state, keyed by device_id. */
async function loadPriorState(enterpriseId: string, deviceIds: string[]): Promise<Map<string, { desired_tier: string | null; applied_tier: string | null }>> {
  if (!deviceIds.length) return new Map();
  const rows = await run<Array<{ device_id: string; desired_tier: string | null; applied_tier: string | null }>>(
    db().from("device_tier_state").select("device_id, desired_tier, applied_tier").eq("enterprise_id", enterpriseId).in("device_id", deviceIds),
  );
  return new Map(rows.map((r) => [r.device_id, { desired_tier: r.desired_tier, applied_tier: r.applied_tier }]));
}

/** Resolve platform per device so we can pick android vs ios tier_groups rows. */
async function loadPlatforms(enterpriseId: string, deviceIds: string[]): Promise<Map<string, "android" | "ios" | null>> {
  if (!deviceIds.length) return new Map();
  // devices.platform is the text enum platform_type ('android'|'ios'|'windows'|'chrome'|'macos'|'unknown').
  // Only android/ios map to tier_groups; the rest collapse to null and skip in policy later.
  const rows = await run<Array<{ id: string; platform: string }>>(
    db().from("devices").select("id, platform").eq("enterprise_id", enterpriseId).in("id", deviceIds),
  );
  const m = new Map<string, "android" | "ios" | null>();
  for (const r of rows) {
    m.set(r.id, r.platform === "ios" ? "ios" : r.platform === "android" ? "android" : null);
  }
  return m;
}

/** tier_groups lookup for the enterprise. Returns a (tier,platform) → {group_id,name} map. */
async function loadTierGroups(enterpriseId: string): Promise<Map<string, { groupId: string; name: string }>> {
  type Row = { tier: string; platform: string; group_id: string; groups: unknown };
  const rows = await run<Row[]>(
    db().from("tier_groups").select("tier, platform, group_id, groups(name)").eq("enterprise_id", enterpriseId),
  );
  const m = new Map<string, { groupId: string; name: string }>();
  for (const r of rows) {
    // Supabase embeds a FK join as either an object or a single-element array
    // depending on PostgREST's inference. Normalise either shape to a name string.
    const g = Array.isArray(r.groups) ? r.groups[0] : r.groups;
    const name = (g && typeof g === "object" && "name" in g ? String((g as { name: unknown }).name) : null) ?? r.group_id;
    m.set(`${r.tier}:${r.platform}`, { groupId: r.group_id, name });
  }
  return m;
}

/**
 * Compute desired tier for every active loan_link, resolve intended group, update
 * device_tier_state.desired_*, log an automation_runs row. Returns the batch
 * result. In Phase 0 (`settings.dry_run=true`) this is purely informational —
 * `applied_tier` is NEVER touched because nothing has actually been applied.
 */
export async function reconcileBatch(
  enterpriseId: string,
  todayISO: string,
  trigger: string,
  loansOverride?: FineractLoanSummary[],
): Promise<ReconcileBatchResult> {
  const settings = await getSettings(enterpriseId);
  if (!settings.enabled) {
    log("info", "automation.disabled_skip", { enterprise_id: enterpriseId, trigger });
    return { trigger, considered: 0, changed: 0, held: false, decisions: [] };
  }

  const links = await listActive(enterpriseId);
  if (!links.length) {
    await writeRun(enterpriseId, trigger, 0, 0, false, undefined, []);
    return { trigger, considered: 0, changed: 0, held: false, decisions: [] };
  }

  // Resolve loan state for each link. Prefer a pre-fetched set (webhook path);
  // else fetch per-loan from Fineract (dailyTick path).
  const loansById = new Map<string, FineractLoanSummary>();
  for (const l of loansOverride ?? []) loansById.set(l.loanId, l);
  const need = links.filter((l) => !loansById.has(l.fineract_loan_id));
  for (const l of need) {
    try {
      const got = await getLoan(l.fineract_loan_id, todayISO);
      loansById.set(l.fineract_loan_id, got);
    } catch (e) {
      // Skip this link — a Fineract fetch failure must not take down the whole batch.
      log("warn", "automation.loan_fetch_failed", { enterprise_id: enterpriseId, loan_id: l.fineract_loan_id, error: String(e) });
    }
  }

  const deviceIds = links.map((l) => l.device_id);
  const [prior, platforms, tierGroups] = await Promise.all([
    loadPriorState(enterpriseId, deviceIds),
    loadPlatforms(enterpriseId, deviceIds),
    loadTierGroups(enterpriseId),
  ]);

  const decisions: DeviceDecision[] = [];
  for (const link of links) {
    const loan = loansById.get(link.fineract_loan_id);
    const platform = platforms.get(link.device_id) ?? null;
    const prev = prior.get(link.device_id)?.desired_tier as Tier | null | undefined;
    if (!loan) {
      decisions.push({
        deviceId: link.device_id, platform, loanId: link.fineract_loan_id, productId: link.product_id,
        dpd: -1, from: prev ?? null, to: prev ?? "disbursed", changed: false,
        intendedGroupId: null, intendedGroupName: null, note: "loan_fetch_failed",
      });
      continue;
    }
    const to = tierFor(
      { status: loan.status === "pending" || loan.status === "approved" || loan.status === "rejected" || loan.status === "unknown" ? "active" : loan.status, dueOn: loan.dueOn, dpd: loan.dpd, productId: loan.productId },
      todayISO,
    );
    const grp = platform ? tierGroups.get(`${to}:${platform}`) ?? null : null;
    decisions.push({
      deviceId: link.device_id,
      platform,
      loanId: link.fineract_loan_id,
      productId: link.product_id,
      dpd: loan.dpd,
      from: prev ?? null,
      to,
      changed: (prev ?? null) !== to,
      intendedGroupId: grp?.groupId ?? null,
      intendedGroupName: grp?.name ?? null,
      note: !platform ? "unknown_platform" : grp ? undefined : "tier_group_unmapped",
    });
  }

  // Blast-radius guard (spec §11). Phase 0 is dry-run so nothing is applied even
  // without this check, but we exercise the guard here so operators can see HOLD
  // decisions in automation_runs before Phase 2 enforcement.
  const changedCount = decisions.filter((d) => d.changed).length;
  const pct = decisions.length ? Math.round((changedCount * 100) / decisions.length) : 0;
  const absExceeded = changedCount > settings.max_changes_per_run;
  const pctExceeded = pct > settings.max_pct_per_run && decisions.length >= 5;
  const held = absExceeded || pctExceeded;
  const holdReason = held
    ? `${absExceeded ? `${changedCount}>${settings.max_changes_per_run} abs cap` : ""}${absExceeded && pctExceeded ? "; " : ""}${pctExceeded ? `${pct}%>${settings.max_pct_per_run}% pct cap` : ""}`
    : undefined;

  let applied: ApplyBatchResult | undefined;
  if (!held) {
    // Persist desired_tier so webhooks later see a prev != new transition correctly.
    // apply.ts stamps applied_tier + current_group_id only on confirmed Zoho success.
    await upsertDesired(enterpriseId, decisions);
    // Phase 2: actually push the moves. Internally no-ops in dry-run.
    applied = await applyBatch(enterpriseId, decisions, settings);
  }

  await writeRun(enterpriseId, trigger, decisions.length, held ? 0 : changedCount, held, holdReason, decisions, applied);
  log(
    held ? "warn" : "info",
    held ? "automation.hold" : "automation.tick",
    { enterprise_id: enterpriseId, trigger, considered: decisions.length, changed: changedCount, held, hold_reason: holdReason, dry_run: settings.dry_run, moved: applied?.moved ?? 0, announced: applied?.announced ?? 0, apply_errors: applied?.errors ?? 0 },
  );
  return { trigger, considered: decisions.length, changed: held ? 0 : changedCount, held, holdReason, decisions, applied };
}

async function upsertDesired(enterpriseId: string, decisions: DeviceDecision[]): Promise<void> {
  if (!decisions.length) return;
  const rows = decisions.map((d) => ({
    enterprise_id: enterpriseId,
    device_id: d.deviceId,
    desired_tier: d.to,
    desired_group_id: d.intendedGroupId,
    last_loan_dpd: d.dpd >= 0 ? d.dpd : null,
    updated_at: new Date().toISOString(),
  }));
  await run(db().from("device_tier_state").upsert(rows, { onConflict: "enterprise_id,device_id" }));
}

async function writeRun(enterpriseId: string, trigger: string, considered: number, changed: number, held: boolean, holdReason: string | undefined, decisions: DeviceDecision[], applied?: ApplyBatchResult): Promise<void> {
  await run(db().from("automation_runs").insert({
    enterprise_id: enterpriseId,
    trigger,
    considered,
    changed,
    held,
    hold_reason: holdReason ?? null,
    detail: {
      // Compact per-device transcript — just enough to debug a tier assignment later
      // without blowing up the row. Loan amounts and PII intentionally omitted (spec §13).
      decisions: decisions.map((d) => ({
        device_id: d.deviceId, platform: d.platform, loan_id: d.loanId, product_id: d.productId,
        dpd: d.dpd, from: d.from, to: d.to, group: d.intendedGroupName, note: d.note,
      })),
      applied: applied
        ? {
            attempted: applied.attempted, moved: applied.moved, announced: applied.announced,
            errors: applied.errors, skipped: applied.skipped,
            outcomes: applied.outcomes.map((o) => ({
              device_id: o.deviceId, from: o.from, to: o.to, moved: o.moved, announced: o.announcementSent,
              target_group: o.targetGroup, announcement: o.announcement,
              skipped: o.skipped, error: o.error,
            })),
          }
        : null,
    },
  }));
}
