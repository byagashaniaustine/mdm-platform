// Announcements pushed to devices through the MDM agent (guide section 8).
import { db, run } from "../lib/db.ts";
import { fail } from "../lib/errors.ts";
import * as zoho from "../zoho/api.ts";
import type { Session } from "./auth.ts";
import { raiseIfFailed, registerExecutor, submitOperation } from "./events.ts";
import { getAnnouncement, getDevices, getGroup, requireZohoId } from "./lookup.ts";

/** The device renders detail_message as HTML; we only ever send escaped text + line breaks. */
export function toSafeHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

export async function listAnnouncements(eid: string) {
  return await run(
    db().from("announcements")
      .select("id, name, title, detail_message, needs_ack, created_at, zoho_announcement_id, announcement_targets(id, sent_at, group_id, device_id, groups(name), devices(device_name))")
      .eq("enterprise_id", eid).order("created_at", { ascending: false }),
  );
}

const op = (s: Session, action: string, announcementId: string, params: Record<string, unknown>, idem: string | null) =>
  submitOperation({
    enterpriseId: s.enterpriseId,
    adminId: s.adminId,
    category: "announcement",
    action,
    announcementId,
    params,
    idempotencyKey: idem,
  }).then((r) => ({ ...r, event: raiseIfFailed(r.event) }));

export async function createAnnouncement(s: Session, input: {
  name: string;
  title: string;
  message: string;
  needsAck: boolean;
  ackButton: string;
  titleColor: string;
}, _idem: string | null) {
  if (!/^#[0-9a-fA-F]{6}$/.test(input.titleColor)) fail("VALIDATION_FAILED", "titleColor must look like #1F3A5F");
  const titleColor = input.titleColor;
  const ackButton = input.ackButton || "Got it";
  const nbarMessage = input.title;

  // Zoho-first: find an existing same-name announcement, or create one. Zoho's
  // POST /announcements returns 204 No Content, so we have to look up the id by
  // name after creation — same pattern the executor was using.
  const findByName = async () =>
    (await zoho.listAnnouncements(s.enterpriseId))
      .filter((x) => x.announcement_name === input.name)
      .sort((x, y) => Number(y.creation_time ?? 0) - Number(x.creation_time ?? 0))[0];

  let found = await findByName();
  if (!found) {
    await zoho.createAnnouncement(s.enterpriseId, {
      name: input.name,
      format: 1,
      title: input.title,
      detailMessage: toSafeHtml(input.message),
      nbarMessage,
      titleColor,
      needsAck: input.needsAck,
      ackButton,
    });
    found = await findByName();
  }
  if (!found?.announcement_id) fail("ZOHO_UNAVAILABLE", "Announcement created in Zoho but not visible yet — try again in a moment.");
  const zid = String(found.announcement_id);

  const row = await run<{ id: string }>(
    db().from("announcements").insert({
      enterprise_id: s.enterpriseId,
      name: input.name,
      title: input.title,
      detail_message: input.message,
      nbar_message: nbarMessage,
      needs_ack: input.needsAck,
      ack_button: ackButton,
      title_color: titleColor,
      zoho_announcement_id: zid,
      last_synced_at: new Date().toISOString(),
      created_by: s.adminId,
    }).select("id").single(),
  );
  return { announcementId: row.id, event: null };
}

export async function sendAnnouncement(s: Session, id: string, groupIds: string[], deviceIds: string[], idem: string | null) {
  if (!groupIds.length && !deviceIds.length) fail("VALIDATION_FAILED", "Pick at least one group or device");
  await getAnnouncement(s.enterpriseId, id);
  for (const g of groupIds) await getGroup(s.enterpriseId, g);
  if (deviceIds.length) await getDevices(s.enterpriseId, deviceIds);
  return await op(s, "announcement.send", id, { group_ids: groupIds, device_ids: deviceIds }, idem);
}

export async function deleteAnnouncement(s: Session, id: string, idem: string | null) {
  await getAnnouncement(s.enterpriseId, id);
  return await op(s, "announcement.delete", id, {}, idem);
}

export async function announcementStatus(eid: string, id: string) {
  const a = await getAnnouncement(eid, id);
  if (!a.zoho_announcement_id) return { devices: [] };
  return await zoho.getAnnouncementDeviceStatus(eid, a.zoho_announcement_id);
}

// ------------------------------------------------------------- executors
registerExecutor("announcement.create", async (ev) => {
  const a = await getAnnouncement(ev.enterprise_id, ev.announcement_id!);
  if (a.zoho_announcement_id) return { state: "succeeded", response: { zoho_announcement_id: a.zoho_announcement_id } };

  const findByName = async () =>
    (await zoho.listAnnouncements(ev.enterprise_id))
      .filter((x) => x.announcement_name === a.name)
      .sort((x, y) => Number(y.creation_time ?? 0) - Number(x.creation_time ?? 0))[0];

  let found = ev.attempts > 1 ? await findByName() : undefined;
  if (!found) {
    // POST returns 204 No Content, so the id is looked up by name afterwards.
    await zoho.createAnnouncement(ev.enterprise_id, {
      name: a.name,
      format: a.format,
      title: a.title,
      detailMessage: toSafeHtml(a.detail_message),
      nbarMessage: a.nbar_message ?? a.title,
      titleColor: a.title_color ?? "#1F3A5F",
      needsAck: a.needs_ack,
      ackButton: a.ack_button ?? "Got it",
    });
    found = await findByName();
  }
  if (!found?.announcement_id) fail("ZOHO_UNAVAILABLE", "Announcement created but not visible yet; will retry lookup");
  const zid = String(found.announcement_id);
  await run(db().from("announcements").update({ zoho_announcement_id: zid }).eq("id", a.id));
  return { state: "succeeded", response: { zoho_announcement_id: zid } };
});

registerExecutor("announcement.send", async (ev) => {
  const a = await getAnnouncement(ev.enterprise_id, ev.announcement_id!);
  const zid = requireZohoId(a.zoho_announcement_id, `Announcement "${a.name}"`);
  const groupIds = (ev.params.group_ids ?? []) as string[];
  const deviceIds = (ev.params.device_ids ?? []) as string[];
  const targets: { announcement_id: string; group_id?: string; device_id?: string }[] = [];

  if (groupIds.length) {
    const groups = await Promise.all(groupIds.map((g) => getGroup(ev.enterprise_id, g)));
    await zoho.sendAnnouncementToGroups(ev.enterprise_id, zid, groups.map((g) => requireZohoId(g.zoho_group_id, g.name)));
    targets.push(...groups.map((g) => ({ announcement_id: a.id, group_id: g.id })));
  }
  if (deviceIds.length) {
    const devices = await getDevices(ev.enterprise_id, deviceIds);
    await zoho.sendAnnouncementToDevices(ev.enterprise_id, zid, devices.map((d) => d.zoho_device_id));
    targets.push(...devices.map((d) => ({ announcement_id: a.id, device_id: d.id })));
  }
  await run(db().from("announcement_targets").insert(targets));
  return { state: "succeeded", response: { groups: groupIds.length, devices: deviceIds.length } };
});

registerExecutor("announcement.delete", async (ev) => {
  const a = await getAnnouncement(ev.enterprise_id, ev.announcement_id!);
  if (a.zoho_announcement_id) await zoho.deleteAnnouncement(ev.enterprise_id, a.zoho_announcement_id);
  await run(db().from("announcements").delete().eq("id", a.id));
  return { state: "succeeded", response: { deleted: a.name } };
});
