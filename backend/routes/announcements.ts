import { Hono } from "hono";
import { bool, readJson, str, uuidList, uuidParam } from "../lib/validate.ts";
import { type AppEnv, idempotencyKey, requireRole, requireSession } from "../middleware/auth.ts";
import {
  announcementStatus,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  sendAnnouncement,
} from "../services/announcements.ts";
import { eventResponse } from "./helpers.ts";

export function announcementRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/", async (c) => c.json({ data: await listAnnouncements(c.get("session").enterpriseId) }));
  r.get("/:id/status", async (c) =>
    c.json({ data: await announcementStatus(c.get("session").enterpriseId, uuidParam(c.req.param("id"))) }));

  r.post("/", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { announcementId } = await createAnnouncement(c.get("session"), {
      name: str(b, "name", { max: 100 }),
      title: str(b, "title", { max: 120 }),
      message: str(b, "message", { max: 4000 }),
      needsAck: bool(b, "needsAck", false),
      ackButton: str(b, "ackButton", { required: false, max: 30 }),
      titleColor: str(b, "titleColor", { required: false, max: 7 }) || "#1F3A5F",
    }, idempotencyKey(c));
    // Zoho-first create: announcement exists in Zoho and locally by the time we return.
    return c.json({ data: { announcementId, events: [] } });
  });

  r.post("/:id/send", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const groupIds = Array.isArray(b.groupIds) && b.groupIds.length ? uuidList(b, "groupIds", { max: 100 }) : [];
    const deviceIds = Array.isArray(b.deviceIds) && b.deviceIds.length ? uuidList(b, "deviceIds", { max: 500 }) : [];
    const { event } = await sendAnnouncement(c.get("session"), uuidParam(c.req.param("id")), groupIds, deviceIds, idempotencyKey(c));
    return eventResponse(c, event);
  });

  r.delete("/:id", requireRole("admin"), async (c) => {
    const { event } = await deleteAnnouncement(c.get("session"), uuidParam(c.req.param("id")), idempotencyKey(c));
    return eventResponse(c, event);
  });

  return r;
}
