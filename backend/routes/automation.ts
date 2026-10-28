// Admin surface for the loan-driven device automation. Session-protected; the
// kill-switch and settings mutations are owner-only. See LOAN_DEVICE_AUTOMATION.md
// §11 (kill-switch) and §12.3 (routes added).
import { Hono } from "hono";
import { db, run } from "../lib/db.ts";
import { bool, obj, readJson } from "../lib/validate.ts";
import { type AppEnv, requireRole, requireSession } from "../middleware/auth.ts";
import { getSettings } from "../services/bridge/reconcile.ts";
import { dailyTick } from "../services/bridge/automation.ts";

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

  return r;
}
