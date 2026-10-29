// Admin surface for the loan-driven device automation. Session-protected; the
// kill-switch and settings mutations are owner-only. See LOAN_DEVICE_AUTOMATION.md
// §11 (kill-switch) and §12.3 (routes added).
import { Hono } from "hono";
import { db, run, runMaybe } from "../lib/db.ts";
import { bool, obj, readJson } from "../lib/validate.ts";
import { appError, fail } from "../lib/errors.ts";
import { type AppEnv, requireRole, requireSession } from "../middleware/auth.ts";
import { getSettings } from "../services/bridge/reconcile.ts";
import { dailyTick } from "../services/bridge/automation.ts";
import { applyBatch } from "../services/bridge/apply.ts";
import { associateProfiles } from "../services/groups.ts";
import { publishProfile } from "../services/profiles.ts";
import { syncGroupMembership } from "../services/sync.ts";
import { submitOperation } from "../services/events.ts";
import { breakerState } from "../lib/circuit.ts";
import type { Tier } from "../services/bridge/tiers.ts";
import type { DeviceDecision } from "../services/bridge/reconcile.ts";

export function automationRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  // GET /api/automation/settings — read current settings (or defaults when no row exists).
  r.get("/settings", async (c) => {
    const eid = c.get("session").enterpriseId;
    return c.json({ data: await getSettings(eid) });
  });

  // PUT /api/automation/settings — update enabled/dry_run/caps (owner).
  r.put("/settings", requireRole("owner"), async (c) => {
    const eid = c.get("session").enterpriseId;
    const b = await readJson(c.req.raw);
    const patch: Record<string, unknown> = { enterprise_id: eid, updated_at: new Date().toISOString() };
    if (typeof b.enabled !== "undefined")             patch.enabled = bool(b, "enabled");
    if (typeof b.dry_run !== "undefined")             patch.dry_run = bool(b, "dry_run");
    if (typeof b.max_changes_per_run === "number")    patch.max_changes_per_run = Math.max(1, Math.floor(b.max_changes_per_run));
    if (typeof b.max_pct_per_run === "number")        patch.max_pct_per_run     = Math.max(1, Math.min(100, Math.floor(b.max_pct_per_run)));
    await run(db().from("automation_settings").upsert(patch, { onConflict: "enterprise_id" }));
    return c.json({ data: await getSettings(eid) });
  });

  // POST /api/automation/kill-switch — flip enabled=false immediately (owner).
  r.post("/kill-switch", requireRole("owner"), async (c) => {
    const eid = c.get("session").enterpriseId;
    await run(db().from("automation_settings").upsert({ enterprise_id: eid, enabled: false, updated_at: new Date().toISOString() }, { onConflict: "enterprise_id" }));
    return c.json({ data: { enabled: false } });
  });

  // GET /api/automation/runs — recent automation_runs for observability.
  r.get("/runs", async (c) => {
    const eid = c.get("session").enterpriseId;
    const rows = await run(
      db().from("automation_runs").select("*").eq("enterprise_id", eid).order("created_at", { ascending: false }).limit(50),
    );
    return c.json({ data: rows });
  });

  // GET /api/automation/devices — current desired/applied tier per device.
  r.get("/devices", async (c) => {
    const eid = c.get("session").enterpriseId;
    const rows = await run(
      db().from("device_tier_state").select("*").eq("enterprise_id", eid).order("updated_at", { ascending: false }).limit(500),
    );
    return c.json({ data: rows });
  });

  // POST /api/automation/tick — admin-triggered tick (useful during Phase 0 to verify wiring without waiting for cron).
  r.post("/tick", requireRole("admin"), async (c) => {
    const eid = c.get("session").enterpriseId;
    const result = await dailyTick(eid);
    return c.json({ data: result ?? { skipped: true, reason: "lease_held_by_another_worker" } });
  });

  // Payload must be echoed so operators can tie an onEvent-trigger reconcile back to
  // the loan they just manually acted on.
  r.post("/onevent", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const detail = obj(b, "detail", true);
    // Minimal: used to smoke-test the webhook path from the admin UI (no HMAC verify here —
    // this route already requires session + admin role).
    return c.json({ data: { echoed: detail } });
  });

  // POST /api/automation/bootstrap — attach the user's existing profiles to the
  // user's existing tier groups and populate the tier_groups + tier_announcements
  // registries. Idempotent (duplicate rows upsert, duplicate attachments dedupe).
  // Looks resources up by name against the enterprise. No new Zoho resources are
  // created — this endpoint is strictly a wiring step.
  //
  // Policy mapping (operator decision, 2026-10-29):
  //   tier         android target     ios target    attach-to-android   attach-to-ios        on-entry announcement
  //   undisbursed  Undisbursed        Undisbursed   —                   —                    —
  //   disbursed    Disbursed          Disbursed     —                   —                    —
  //   due_2d       Due-2D             Due-2D        —                   —                    Due-2D
  //   overdue_2d   Overdue-2D         Overdue-2D    —                   —                    Overdue-2D
  //   locked       lockedAndroids     Locked        AdroidRestrictions  payfirst             Locked
  //                                                 androidKiosk        reset-cmd
  //   released     ReleasedAndroids   Released      —                   —                    —
  r.post("/bootstrap", requireRole("admin"), async (c) => {
    const session = c.get("session");
    const eid = session.enterpriseId;

    // 1) Resolve every named resource to its row id.
    const groupByName = await resolveGroups(eid, [
      "Undisbursed", "Disbursed", "Due-2D", "Overdue-2D",
      "lockedAndroids", "Locked", "ReleasedAndroids", "Released",
    ]);
    const annByName = await resolveAnnouncements(eid, ["Due-2D", "Overdue-2D", "Locked"]);
    const profByName = await resolveProfiles(eid, [
      "AdroidRestrictions", "androidKiosk",   // Android, Locked tier
      "payfirst", "reset-cmd",                // iOS, Locked tier
    ]);

    // 2) Build the tier_groups upsert set.
    type TGRow = { enterprise_id: string; tier: Tier; platform: "android" | "ios"; group_id: string };
    const tgRows: TGRow[] = [
      { enterprise_id: eid, tier: "undisbursed", platform: "android", group_id: groupByName.Undisbursed },
      { enterprise_id: eid, tier: "undisbursed", platform: "ios",     group_id: groupByName.Undisbursed },
      { enterprise_id: eid, tier: "disbursed",   platform: "android", group_id: groupByName.Disbursed },
      { enterprise_id: eid, tier: "disbursed",   platform: "ios",     group_id: groupByName.Disbursed },
      { enterprise_id: eid, tier: "due_2d",      platform: "android", group_id: groupByName["Due-2D"] },
      { enterprise_id: eid, tier: "due_2d",      platform: "ios",     group_id: groupByName["Due-2D"] },
      { enterprise_id: eid, tier: "overdue_2d",  platform: "android", group_id: groupByName["Overdue-2D"] },
      { enterprise_id: eid, tier: "overdue_2d",  platform: "ios",     group_id: groupByName["Overdue-2D"] },
      { enterprise_id: eid, tier: "locked",      platform: "android", group_id: groupByName.lockedAndroids },
      { enterprise_id: eid, tier: "locked",      platform: "ios",     group_id: groupByName.Locked },
      { enterprise_id: eid, tier: "released",    platform: "android", group_id: groupByName.ReleasedAndroids },
      { enterprise_id: eid, tier: "released",    platform: "ios",     group_id: groupByName.Released },
    ];
    await run(db().from("tier_groups").upsert(
      tgRows.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
      { onConflict: "enterprise_id,tier,platform" },
    ));

    // 3) tier_announcements — only the three loan stages with reminders.
    const taRows = [
      { enterprise_id: eid, tier: "due_2d" as const,     announcement_id: annByName["Due-2D"] },
      { enterprise_id: eid, tier: "overdue_2d" as const, announcement_id: annByName["Overdue-2D"] },
      { enterprise_id: eid, tier: "locked" as const,     announcement_id: annByName.Locked },
    ];
    await run(db().from("tier_announcements").upsert(
      taRows.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
      { onConflict: "enterprise_id,tier" },
    ));

    // 4) Attach loan-tier profiles to the right Locked groups. Idempotent at the
    //    executor level — associateProfilesToGroup is safe to repeat. Any draft
    //    profile is auto-published first so the whole flow is admin-free.
    const warnings: { tag: string; code: string; message: string }[] = [];
    const published: string[] = [];
    const attached: Record<string, string[]> = {};

    const ensurePublished = async (profileIds: string[], tag: string) => {
      const rows = await run<{ id: string; name: string; state: string }[]>(
        db().from("profiles").select("id, name, state").in("id", profileIds),
      );
      for (const p of rows) {
        if (p.state === "published") continue;
        try {
          await publishProfile(session, p.id, `bootstrap:publish:${p.id}`);
          published.push(p.name);
        } catch (e) {
          const err = e as { code?: string; message?: string };
          warnings.push({ tag: `publish:${p.name}`, code: err.code ?? "PUBLISH_FAILED", message: err.message ?? String(e) });
        }
      }
    };

    const attach = async (groupName: string, groupId: string, profileNames: string[], profileIds: string[], tag: string) => {
      await ensurePublished(profileIds, tag);
      // After publish attempt, re-check: only attach profiles that are actually
      // in 'published' state. Anything stuck in draft (empty shell, missing
      // required field) is skipped and logged — partial success beats total.
      const current = await run<{ id: string; name: string; state: string }[]>(
        db().from("profiles").select("id, name, state").in("id", profileIds),
      );
      const okIds = current.filter((p) => p.state === "published").map((p) => p.id);
      const okNames = current.filter((p) => p.state === "published").map((p) => p.name);
      const skipNames = current.filter((p) => p.state !== "published").map((p) => p.name);
      for (const n of skipNames) warnings.push({ tag: `attach:${n}`, code: "PROFILE_NOT_PUBLISHED", message: `${n} is still in draft; attach skipped` });
      if (!okIds.length) { attached[groupName] = []; return; }
      try {
        // Key by the actual sorted profile-id set so adding a newly-published
        // profile forces a fresh attach instead of hitting the previous dedup.
        const idemKey = `bootstrap:${tag}:${[...okIds].sort().join(",")}`;
        await associateProfiles(session, groupId, okIds, idemKey);
        attached[groupName] = okNames;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        warnings.push({ tag, code: err.code ?? "ATTACH_FAILED", message: err.message ?? String(e) });
        attached[groupName] = [];
      }
    };
    await attach("lockedAndroids", groupByName.lockedAndroids,
      ["AdroidRestrictions", "androidKiosk"],
      [profByName.AdroidRestrictions, profByName.androidKiosk], "locked_android");
    await attach("Locked", groupByName.Locked,
      ["payfirst", "reset-cmd"],
      [profByName.payfirst, profByName["reset-cmd"]], "locked_ios");

    return c.json({ data: {
      tier_groups: tgRows.length,
      tier_announcements: taRows.length,
      profiles_published: published,
      profiles_attached: attached,
      warnings,
      groups_resolved: groupByName,
      note: "dry_run is unchanged. Flip via PUT /api/automation/settings when ready.",
    } });
  });

  // POST /api/automation/apply — forces an apply pass over current device_tier_state.
  // Useful for sim-driven demos ("I already have decisions, now actually push them")
  // and for retrying after a Zoho outage. Does not re-reconcile — reads what's already
  // in device_tier_state.
  r.post("/apply", requireRole("admin"), async (c) => {
    const eid = c.get("session").enterpriseId;
    const settings = await getSettings(eid);
    if (!settings.enabled) fail("AUTOMATION_DISABLED");

    const rows = await run<{ device_id: string; desired_tier: string | null; applied_tier: string | null; last_loan_dpd: number | null }[]>(
      db().from("device_tier_state").select("device_id, desired_tier, applied_tier, last_loan_dpd").eq("enterprise_id", eid),
    );
    const pending = rows.filter((r) => r.desired_tier && r.desired_tier !== r.applied_tier);
    if (!pending.length) return c.json({ data: { attempted: 0, moved: 0, announced: 0, outcomes: [] } });

    // Hydrate decisions with device.platform + loan_id (both required by apply.ts).
    const devicePlatforms = await run<{ id: string; platform: string }[]>(
      db().from("devices").select("id, platform").in("id", pending.map((r) => r.device_id)),
    );
    const platMap = new Map(devicePlatforms.map((d) => [d.id, d.platform]));
    const loanRows = await run<{ device_id: string; fineract_loan_id: string; product_id: number }[]>(
      db().from("loan_links").select("device_id, fineract_loan_id, product_id")
        .eq("enterprise_id", eid).eq("status", "active").in("device_id", pending.map((r) => r.device_id)),
    );
    const loanMap = new Map(loanRows.map((l) => [l.device_id, l]));

    const decisions: DeviceDecision[] = pending.map((r) => {
      const link = loanMap.get(r.device_id);
      return {
        deviceId: r.device_id,
        platform: (platMap.get(r.device_id) === "ios" ? "ios" : platMap.get(r.device_id) === "android" ? "android" : null) as "android" | "ios" | null,
        loanId: link?.fineract_loan_id ?? "",
        productId: link?.product_id ?? 0,
        dpd: r.last_loan_dpd ?? 0,
        from: (r.applied_tier ?? null) as Tier | null,
        to: r.desired_tier as Tier,
        changed: true,
        intendedGroupId: null,
        intendedGroupName: null,
      };
    });

    const result = await applyBatch(eid, decisions, settings);
    return c.json({ data: result });
  });

  // GET /api/automation/health — rollup for the overview tile + ops dashboards.
  // Cheap: pure DB aggregates plus the in-memory breaker state. Call it as often
  // as the UI likes.
  r.get("/health", async (c) => {
    const eid = c.get("session").enterpriseId;
    const settings = await getSettings(eid);
    const breaker = breakerState("fineract");
    const now = Date.now();

    const [{ count: activeLinks }, { count: deadEvents24h }, lastRun, tierStates, openAlerts] = await Promise.all([
      db().from("loan_links").select("id", { count: "exact", head: true }).eq("enterprise_id", eid).eq("status", "active"),
      db().from("events").select("id", { count: "exact", head: true })
        .eq("enterprise_id", eid).eq("state", "dead").in("category", ["group", "announcement"])
        .gte("updated_at", new Date(now - 24 * 3600_000).toISOString()),
      runMaybe<{ created_at: string }>(
        db().from("automation_runs").select("created_at").eq("enterprise_id", eid).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ),
      run<{ desired_tier: string | null; applied_tier: string | null; updated_at: string }[]>(
        db().from("device_tier_state").select("desired_tier, applied_tier, updated_at").eq("enterprise_id", eid).not("desired_tier", "is", null),
      ),
      run<{ rule_key: string; severity: string; title: string; created_at: string }[]>(
        db().from("alerts").select("rule_key, severity, title, created_at").eq("enterprise_id", eid).like("rule_key", "automation.%").neq("status", "resolved").order("created_at", { ascending: false }).limit(20),
      ),
    ]);

    const pending = tierStates.filter((s) => s.desired_tier && s.desired_tier !== s.applied_tier);
    const under2h  = pending.filter((s) => now - Date.parse(s.updated_at) <= 2 * 3600_000).length;
    const over2h   = pending.filter((s) => now - Date.parse(s.updated_at) > 2 * 3600_000 && now - Date.parse(s.updated_at) <= 24 * 3600_000).length;
    const over24h  = pending.filter((s) => now - Date.parse(s.updated_at) > 24 * 3600_000).length;

    return c.json({ data: {
      enterprise_id: eid,
      settings: {
        enabled: settings.enabled,
        dry_run: settings.dry_run,
        max_changes_per_run: settings.max_changes_per_run,
        max_pct_per_run: settings.max_pct_per_run,
      },
      fineract_breaker: breaker,
      last_tick_at: lastRun?.created_at ?? null,
      active_loan_links: activeLinks ?? 0,
      devices_stuck: { under_2h: under2h, over_2h: over2h, over_24h: over24h },
      events_dead_24h: deadEvents24h ?? 0,
      open_alerts: openAlerts.map((a) => ({
        rule_key: a.rule_key, severity: a.severity, title: a.title,
        age_minutes: Math.round((now - Date.parse(a.created_at)) / 60_000),
      })),
    } });
  });

  // POST /api/automation/sweep — force the single-tier-group invariant on every
  // device in device_tier_state. For each device, pre-sync tier groups, remove
  // the device from every mapped tier group that isn't its current_group_id,
  // then stamp. Idempotent. Use after a schema change or to clean legacy drift.
  r.post("/sweep", requireRole("admin"), async (c) => {
    const eid = c.get("session").enterpriseId;

    // Mapped tier groups for this enterprise (by DB row id).
    const tgRows = await run<{ group_id: string }[]>(
      db().from("tier_groups").select("group_id").eq("enterprise_id", eid),
    );
    const tierGroupRowIds = [...new Set(tgRows.map((r) => r.group_id))];
    if (!tierGroupRowIds.length) return c.json({ data: { attempted: 0, cleaned: 0, outcomes: [] } });

    // Pre-sync from Zoho so decisions use current reality.
    for (const gid of tierGroupRowIds) {
      try { await syncGroupMembership(eid, gid); } catch { /* best effort */ }
    }

    // State rows to sweep. Only act on devices whose current_group_id is known.
    const states = await run<{ device_id: string; applied_tier: string | null; current_group_id: string | null }[]>(
      db().from("device_tier_state")
        .select("device_id, applied_tier, current_group_id")
        .eq("enterprise_id", eid),
    );

    const outcomes: Array<{ deviceId: string; applied_tier: string | null; keptIn: string | null; removedFrom: string[]; errors: string[] }> = [];
    let cleaned = 0;

    // Group row id → name for human output.
    const groupRows = await run<{ id: string; name: string }[]>(
      db().from("groups").select("id, name").in("id", tierGroupRowIds),
    );
    const nameOf = new Map(groupRows.map((g) => [g.id, g.name]));

    for (const s of states) {
      const errors: string[] = [];
      const keepRowId = s.current_group_id; // may be null → device will be removed from every tier group
      // Which tier groups is this device currently a member of?
      const memberships = await run<{ group_id: string }[]>(
        db().from("group_devices")
          .select("group_id")
          .eq("device_id", s.device_id)
          .in("group_id", tierGroupRowIds),
      );
      const strayGroups = memberships.filter((m) => m.group_id !== keepRowId).map((m) => m.group_id);
      const removedFrom: string[] = [];

      for (const gid of strayGroups) {
        try {
          await submitOperation({
            enterpriseId: eid,
            category: "group",
            action: "group.remove_device",
            groupId: gid,
            deviceId: s.device_id,
            params: { device_id: s.device_id },
            idempotencyKey: `sweep:${s.device_id}:rm:${gid}`,
          });
          removedFrom.push(nameOf.get(gid) ?? gid);
        } catch (e) {
          const err = e as { code?: string; message?: string };
          if (err.code !== "ZOHO_NOT_FOUND") errors.push(`${nameOf.get(gid) ?? gid}: ${err.code ?? "ERR"} ${err.message ?? ""}`);
        }
      }

      // Post-sync the affected groups so our DB mirror reflects Zoho's post-move state.
      for (const gid of strayGroups) {
        try { await syncGroupMembership(eid, gid); } catch { /* best effort */ }
      }
      if (keepRowId) {
        try { await syncGroupMembership(eid, keepRowId); } catch { /* best effort */ }
      }

      if (removedFrom.length) cleaned++;
      outcomes.push({
        deviceId: s.device_id,
        applied_tier: s.applied_tier,
        keptIn: keepRowId ? (nameOf.get(keepRowId) ?? keepRowId) : null,
        removedFrom,
        errors,
      });
    }

    return c.json({ data: { attempted: states.length, cleaned, outcomes } });
  });

  return r;
}

// --- helpers ----------------------------------------------------------

async function resolveGroups(eid: string, names: string[]): Promise<Record<string, string>> {
  const rows = await run<{ id: string; name: string }[]>(
    db().from("groups").select("id, name").eq("enterprise_id", eid).in("name", names),
  );
  return keyedByName(rows, names, "group");
}

async function resolveAnnouncements(eid: string, names: string[]): Promise<Record<string, string>> {
  const rows = await run<{ id: string; name: string }[]>(
    db().from("announcements").select("id, name").eq("enterprise_id", eid).in("name", names),
  );
  return keyedByName(rows, names, "announcement");
}

async function resolveProfiles(eid: string, names: string[]): Promise<Record<string, string>> {
  const rows = await run<{ id: string; name: string }[]>(
    db().from("profiles").select("id, name").eq("enterprise_id", eid).in("name", names),
  );
  return keyedByName(rows, names, "profile");
}

function keyedByName(rows: { id: string; name: string }[], expected: string[], kind: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    // Keep the first match if duplicates — the user's data has only one row per unique name here.
    if (!(r.name in map)) map[r.name] = r.id;
  }
  const missing = expected.filter((n) => !(n in map));
  if (missing.length) throw appError("NOT_FOUND", `Missing ${kind}(s) in this enterprise: ${missing.join(", ")}. Create them in the console first.`);
  return map;
}
// runMaybe is re-exported for the helpers above; keep the import live.
void runMaybe;
