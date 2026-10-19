import { Hono } from "hono";
import { db, run } from "../lib/db.ts";
import { fail } from "../lib/errors.ts";
import { obj, readJson, str, uuidList, uuidParam } from "../lib/validate.ts";
import { type AppEnv, idempotencyKey, requireRole, requireSession } from "../middleware/auth.ts";
import { confirmationTarget, confirmCommand, DEVICE_ACTIONS, deviceHasKiosk, deviceTag, requestCommand } from "../services/commands.ts";
import { deviceInstalledApps } from "../services/apps.ts";
import { clearDeviceCommands, recordAudit } from "../services/events.ts";
import { removeDeviceFromAllGroups } from "../services/groups.ts";
import { getDevice } from "../services/lookup.ts";
import { getCommandHistory } from "../zoho/api.ts";
import { zohoRequest } from "../zoho/client.ts";
import { eventResponse, intQuery, maskDevice } from "./helpers.ts";

const DEVICE_COLUMNS =
  "id, zoho_device_id, platform, device_name, model, product_name, os_version, serial_number, imei, owned_by, is_lost_mode, is_removed, is_supervised, is_profileowner, is_knox, added_at, last_synced_at, last_contact_at, mdm_users(id, user_name, email), group_devices(groups(id, name, kind))";

export function deviceRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/actions", (c) =>
    c.json({
      data: Object.entries(DEVICE_ACTIONS).map(([id, d]) => ({
        id,
        label: d.label,
        minRole: d.minRole,
        confirm: d.confirm,
        params: d.params,
        platforms: d.platforms,
        knoxOnlyAndroid: d.knoxOnlyAndroid ?? false,
        supervisedOnlyIos: d.supervisedOnlyIos ?? false,
      })),
    }));

  r.get("/", async (c) => {
    const s = c.get("session");
    let q = db().from("devices").select(DEVICE_COLUMNS).eq("enterprise_id", s.enterpriseId)
      .eq("is_removed", c.req.query("removed") === "true").order("device_name").limit(intQuery(c.req.query("limit"), 500, 2000));
    const platform = c.req.query("platform");
    if (platform && ["android", "ios", "windows", "chrome", "macos"].includes(platform)) q = q.eq("platform", platform);
    const search = c.req.query("search")?.replace(/[%,()]/g, "").slice(0, 60);
    if (search) q = q.or(`device_name.ilike.%${search}%,model.ilike.%${search}%`);
    const rows = await run<Record<string, unknown>[]>(q);
    return c.json({ data: rows.map((d) => maskDevice(d, s.role)) });
  });

  r.get("/:id", async (c) => {
    const s = c.get("session");
    const id = uuidParam(c.req.param("id"));
    const device = await run<Record<string, unknown>>(
      db().from("devices").select(DEVICE_COLUMNS).eq("enterprise_id", s.enterpriseId).eq("id", id).single(),
    );
    const events = await run(
      db().from("events").select("id, action, state, error_code, error_message, action_time, completed_at, admins(email)")
        .eq("enterprise_id", s.enterpriseId).eq("device_id", id).order("action_time", { ascending: false }).limit(50),
    );
    const { tag, source } = deviceTag(device as Parameters<typeof deviceTag>[0]);
    return c.json({
      data: {
        ...maskDevice(device, s.role),
        events,
        kiosk: await deviceHasKiosk(id),
        // shown in the destructive-action dialog; owners/admins only (viewers can't run them)
        confirm_tag: s.role === "viewer" ? null : { tag, source },
      },
    });
  });

  // Live Zoho command history for the device ("fetch logs & history").
  r.get("/:id/history", async (c) => {
    const s = c.get("session");
    const device = await getDevice(s.enterpriseId, uuidParam(c.req.param("id")));
    const days = intQuery(c.req.query("days"), 7, 90);
    return c.json({ data: await getCommandHistory(s.enterpriseId, device.zoho_device_id, { days, limit: 100 }) });
  });

  // Location is personal data: admins only, fetched live, never stored, every view audited.
  r.get("/:id/location", requireRole("admin"), async (c) => {
    const s = c.get("session");
    const device = await getDevice(s.enterpriseId, uuidParam(c.req.param("id")));
    const data = await zohoRequest(s.enterpriseId, { path: `/devices/${device.zoho_device_id}/locations_with_address` });
    await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "command", action: "device.location_viewed", deviceId: device.id });
    return c.json({ data });
  });

  // Clear pending commands for this device. Only cancels events still in cancellable
  // states (awaiting_confirmation / requested / dead). Events already `sent` to Zoho
  // cannot be recalled — the device will process them on next check-in.
  r.post("/:id/clear-commands", requireRole("admin"), async (c) => {
    const s = c.get("session");
    const device = await getDevice(s.enterpriseId, uuidParam(c.req.param("id")));
    const result = await clearDeviceCommands(s.enterpriseId, device.id);
    await recordAudit({
      enterpriseId: s.enterpriseId,
      adminId: s.adminId,
      category: "command",
      action: "device.commands_cleared",
      deviceId: device.id,
      params: { cancelled: result.cancelled, by_state: result.by_state },
    });
    return c.json({ data: result });
  });

  // Strip the device of every group-based policy by removing it from every group it's in.
  // Fires one group.remove_device event per group so each operation is tracked and retried.
  r.post("/:id/remove-from-all-groups", requireRole("admin"), async (c) => {
    const s = c.get("session");
    const id = uuidParam(c.req.param("id"));
    const { events, groups } = await removeDeviceFromAllGroups(s, id, idempotencyKey(c));
    return c.json({ data: { groups_removed: groups.length, groups, events: events.map((e) => ({ id: e.id, state: e.state, group_id: e.group_id })) } });
  });

  // Design rule: no profile -> device association.
  r.post("/:id/profiles", () => fail("DIRECT_PROFILE_DEVICE_BLOCKED", "Add the device to a group that has the profile instead"));

  // Live list of apps currently installed on this device (fetched from Zoho).
  r.get("/:id/apps", async (c) => {
    const data = await deviceInstalledApps(c.get("session"), uuidParam(c.req.param("id")));
    return c.json({ data });
  });

  return r;
}

export function commandRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession, requireRole("admin"));

  r.post("/", async (c) => {
    const b = await readJson(c.req.raw);
    const events = await requestCommand(c.get("session"), {
      deviceIds: uuidList(b, "deviceIds", { min: 1, max: 200 }),
      action: str(b, "action", { max: 40 }),
      params: obj(b, "params"),
      idempotencyKey: idempotencyKey(c),
    });
    const pending = events.find((e) => e.state === "awaiting_confirmation");
    return eventResponse(c, events, pending
      ? {
        confirmation: {
          required: true,
          target: await confirmationTarget(c.get("session").enterpriseId, pending),
        },
      }
      : {});
  });

  r.post("/:id/confirm", async (c) => {
    const b = await readJson(c.req.raw);
    const ev = await confirmCommand(c.get("session"), uuidParam(c.req.param("id")), {
      // last 4 of the serial (or the group name for a group passcode reset); deviceName kept for old clients
      typed: str(b, b.typed !== undefined ? "typed" : "deviceName", { max: 200 }),
    });
    return eventResponse(c, ev);
  });

  return r;
}
