import { confirmationTarget } from "../services/commands.ts";
import { Hono } from "hono";
import { bool, oneOf, readJson, str, uuidList, uuidParam } from "../lib/validate.ts";
import { type AppEnv, idempotencyKey, requireRole, requireSession } from "../middleware/auth.ts";
import {
  addDevicesToGroup,
  associateProfiles,
  createGroup,
  deleteGroup,
  disassociateProfiles,
  groupDetail,
  listGroups,
  removeDeviceFromGroup,
  resetPasscodeOnGroup,
} from "../services/groups.ts";
import { blacklistAppsOnGroup, type BlacklistEntry, groupBlacklistSummary, groupInstalledApps, installAppsOnGroup, removeBlacklistFromGroup, uninstallAppsFromGroup } from "../services/apps.ts";
import { kickBackgroundSync } from "../services/sync.ts";
import { eventResponse } from "./helpers.ts";

export function groupRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/", async (c) => {
    const eid = c.get("session").enterpriseId;
    // Proactive freshness: fire a background sync (debounced 30s) so admins see
    // current Zoho state on page load, not only after the 15-min cron.
    kickBackgroundSync(eid, ["groups"]);
    return c.json({ data: await listGroups(eid) });
  });
  r.get("/:id", async (c) => c.json({ data: await groupDetail(c.get("session").enterpriseId, uuidParam(c.req.param("id"))) }));

  r.post("/", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { groupId } = await createGroup(c.get("session"), {
      name: str(b, "name", { max: 100 }),
      kind: oneOf(b, "kind", ["department", "function", "baseline", "other"] as const, "department"),
      description: str(b, "description", { required: false, max: 300 }),
    }, idempotencyKey(c));
    // Zoho-first create: group exists in Zoho and locally by the time we return.
    return c.json({ data: { groupId, events: [] } });
  });

  r.delete("/:id", requireRole("owner"), async (c) => {
    const { event } = await deleteGroup(c.get("session"), uuidParam(c.req.param("id")), idempotencyKey(c));
    return eventResponse(c, event);
  });

  // Devices -> group
  r.post("/:id/devices", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { event } = await addDevicesToGroup(c.get("session"), uuidParam(c.req.param("id")), uuidList(b, "deviceIds", { min: 1, max: 500 }), idempotencyKey(c));
    return eventResponse(c, event);
  });
  r.delete("/:id/devices/:deviceId", requireRole("admin"), async (c) => {
    const { event } = await removeDeviceFromGroup(
      c.get("session"),
      uuidParam(c.req.param("id")),
      uuidParam(c.req.param("deviceId"), "deviceId"),
      idempotencyKey(c),
    );
    return eventResponse(c, event);
  });

  // Profile -> group (and "remove group from profile")
  r.post("/:id/profiles", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { event } = await associateProfiles(c.get("session"), uuidParam(c.req.param("id")), uuidList(b, "profileIds", { min: 1, max: 50 }), idempotencyKey(c));
    return eventResponse(c, event);
  });
  r.post("/:id/profiles/remove", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { event } = await disassociateProfiles(c.get("session"), uuidParam(c.req.param("id")), uuidList(b, "profileIds", { min: 1, max: 50 }), idempotencyKey(c));
    return eventResponse(c, event);
  });

  // Live union of installed apps across all member devices (for pickers).
  r.get("/:id/installed-apps", async (c) => {
    const data = await groupInstalledApps(c.get("session"), uuidParam(c.req.param("id")));
    return c.json({ data });
  });

  // Apps -> group (install / uninstall).
  r.post("/:id/apps", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const apps = Array.isArray(b.apps) ? b.apps : [];
    const normalized = apps
      .map((a: Record<string, unknown>) => ({ appId: String(a.appId ?? a.app_id ?? ""), releaseLabelId: a.releaseLabelId ? String(a.releaseLabelId) : null }))
      .filter((a: { appId: string }) => a.appId);
    if (!normalized.length) return c.json({ error: { code: "VALIDATION_FAILED", message: "apps[] required with appId on each entry" } }, 400);
    const { event } = await installAppsOnGroup(c.get("session"), uuidParam(c.req.param("id")), normalized, idempotencyKey(c));
    return eventResponse(c, event);
  });
  r.post("/:id/apps/remove", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const appIds = Array.isArray(b.appIds) ? b.appIds.map(String) : [];
    if (!appIds.length) return c.json({ error: { code: "VALIDATION_FAILED", message: "appIds[] required" } }, 400);
    const { event } = await uninstallAppsFromGroup(c.get("session"), uuidParam(c.req.param("id")), appIds, idempotencyKey(c));
    return eventResponse(c, event);
  });

  // What's blacklisted via *this* group (per-group running tally from events,
  // joined against the enterprise repo for names). Not the enterprise catalogue.
  r.get("/:id/blacklist", async (c) => {
    const data = await groupBlacklistSummary(c.get("session"), uuidParam(c.req.param("id")));
    return c.json({ data });
  });

  // Blacklist apps on the group's devices.
  r.post("/:id/blacklist", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const raw = Array.isArray(b.apps) ? b.apps : [];
    const entries: BlacklistEntry[] = raw
      .map((a: Record<string, unknown>) => ({
        identifier: String(a.identifier ?? "").trim(),
        platform: Number(a.platform ?? 2),
        appname: String(a.appname ?? a.identifier ?? "App"),
      }))
      .filter((e: BlacklistEntry) => /^[a-zA-Z][\w.]+$/.test(e.identifier));
    if (!entries.length) return c.json({ error: { code: "VALIDATION_FAILED", message: "apps[] required with identifier (valid package name) + platform" } }, 400);
    const { event } = await blacklistAppsOnGroup(c.get("session"), uuidParam(c.req.param("id")), entries, idempotencyKey(c));
    return eventResponse(c, event);
  });
  r.post("/:id/blacklist/remove", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const appGroupIds = Array.isArray(b.appGroupIds) ? b.appGroupIds.map(String) : [];
    if (!appGroupIds.length) return c.json({ error: { code: "VALIDATION_FAILED", message: "appGroupIds[] required" } }, 400);
    const { event } = await removeBlacklistFromGroup(c.get("session"), uuidParam(c.req.param("id")), appGroupIds, idempotencyKey(c));
    return eventResponse(c, event);
  });

  // Fan reset_passcode out to every member device.
  r.post("/:id/actions/reset_passcode", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const events = await resetPasscodeOnGroup(c.get("session"), uuidParam(c.req.param("id")), {
      passcode: str(b, "passcode", { min: 4, max: 16 }),
      emailUser: bool(b, "email_sent_to_user", true),
      emailAdmin: bool(b, "email_sent_to_admin", false),
    }, idempotencyKey(c));
    return eventResponse(c, events, {
      confirmation: { required: true, target: await confirmationTarget(c.get("session").enterpriseId, events) },
    });
  });

  return r;
}
