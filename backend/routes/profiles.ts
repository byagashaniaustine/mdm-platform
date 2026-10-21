import { Hono } from "hono";
import { db, run } from "../lib/db.ts";
import { obj, oneOf, readJson, str, uuidParam } from "../lib/validate.ts";
import { type AppEnv, idempotencyKey, requireRole, requireSession } from "../middleware/auth.ts";
import {
  addPolicy,
  createProfile,
  deleteProfile,
  listProfiles,
  profileCatalog,
  publishProfile,
  PURPOSES,
} from "../services/profiles.ts";
import { listApps } from "../zoho/api.ts";
import { deleteFromBlacklistRepo, enterpriseInstalledApps, listBlacklistApps } from "../services/apps.ts";
import { eventResponse } from "./helpers.ts";

export function profileRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/catalog", (c) => c.json({ data: profileCatalog() }));
  r.get("/", async (c) => c.json({ data: await listProfiles(c.get("session").enterpriseId) }));
  r.get("/:id", async (c) => {
    const s = c.get("session");
    const data = await run(
      db().from("profiles").select("*, profile_groups(associated_at, groups(id, name, kind))")
        .eq("enterprise_id", s.enterpriseId).eq("id", uuidParam(c.req.param("id"))).single(),
    );
    return c.json({ data });
  });

  r.post("/", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { profileId, event } = await createProfile(c.get("session"), {
      name: str(b, "name", { max: 100 }),
      description: str(b, "description", { required: false, max: 300 }),
      platform: oneOf(b, "platform", ["android", "ios"] as const, "android"),
      purpose: oneOf(b, "purpose", PURPOSES),
      config: obj(b, "config", true),
    }, idempotencyKey(c));
    return eventResponse(c, event, { profileId });
  });

  r.post("/:id/policies", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { event } = await addPolicy(
      c.get("session"),
      uuidParam(c.req.param("id")),
      oneOf(b, "purpose", PURPOSES),
      obj(b, "config", true),
      idempotencyKey(c),
    );
    return eventResponse(c, event);
  });

  r.post("/:id/publish", requireRole("admin"), async (c) => {
    const { event } = await publishProfile(c.get("session"), uuidParam(c.req.param("id")), idempotencyKey(c));
    return eventResponse(c, event);
  });

  r.delete("/:id", requireRole("owner"), async (c) => {
    const { event } = await deleteProfile(c.get("session"), uuidParam(c.req.param("id")), idempotencyKey(c));
    return eventResponse(c, event);
  });

  return r;
}

export function appRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);
  // Live from Zoho: used by the kiosk builder to pick apps (app_id + package name).
  r.get("/", async (c) => c.json({ data: await listApps(c.get("session").enterpriseId) }));
  // Fallback source when the Zoho app repo is empty — union of apps actually installed
  // on enrolled devices. Optional ?platform=1 (iOS) / 2 (Android) filters the result.
  r.get("/installed", async (c) => {
    const raw = c.req.query("platform");
    const platform = raw ? Number(raw) : undefined;
    if (raw !== undefined && !Number.isInteger(platform)) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "platform must be a number" } }, 400);
    }
    return c.json({ data: await enterpriseInstalledApps(c.get("session"), platform) });
  });
  r.get("/blacklist", async (c) => c.json({ data: await listBlacklistApps(c.get("session")) }));
  // Nuke apps from the enterprise blacklist repo entirely. Owner-only since
  // this affects every group that has those apps blacklisted.
  r.delete("/blacklist", requireRole("owner"), async (c) => {
    const b = await readJson(c.req.raw);
    const ids = Array.isArray(b.appGroupIds) ? b.appGroupIds.map(String) : [];
    const data = await deleteFromBlacklistRepo(c.get("session"), ids);
    return c.json({ data });
  });
  return r;
}
