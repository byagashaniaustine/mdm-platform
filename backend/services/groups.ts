// Department / function groups: create, membership, and profile association.
// Rule from the design notes: profiles reach devices ONLY through groups.
import { db, run } from "../lib/db.ts";
import { fail, toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import * as zoho from "../zoho/api.ts";
import type { Session } from "./auth.ts";
import { requestGroupPasscodeReset } from "./commands.ts";
import { type EventRow, raiseIfFailed, registerExecutor, submitOperation } from "./events.ts";
import { getDevice, getDevices, getGroup, getProfiles, requireZohoId } from "./lookup.ts";

export type GroupKind = "department" | "function" | "baseline" | "other";

export async function listGroups(eid: string) {
  return await run(
    db().from("groups")
      .select("id, name, kind, description, zoho_group_id, member_count, last_synced_at, created_at, profile_groups(profile_id, source, profiles(id, name, purpose, state))")
      .eq("enterprise_id", eid).order("name"),
  );
}

export async function groupDetail(eid: string, groupId: string) {
  const group = await getGroup(eid, groupId);
  const devices = await run(
    db().from("group_devices").select("added_at, devices(id, device_name, model, platform, is_lost_mode, mdm_users(user_name, email))")
      .eq("group_id", groupId),
  );
  const profiles = await run(
    db().from("profile_groups").select("associated_at, source, last_seen_at, profiles(id, name, purpose, state)").eq("group_id", groupId),
  );
  return { ...group, devices, profiles };
}

const op = (s: Session, action: string, groupId: string, params: Record<string, unknown>, idem: string | null) =>
  submitOperation({
    enterpriseId: s.enterpriseId,
    adminId: s.adminId,
    category: "group",
    action,
    groupId,
    params,
    idempotencyKey: idem,
  }).then((r) => ({ ...r, event: raiseIfFailed(r.event) }));

export async function createGroup(s: Session, input: { name: string; kind: GroupKind; description: string }, idem: string | null) {
  const group = await run<{ id: string }>(
    db().from("groups").insert({
      enterprise_id: s.enterpriseId,
      name: input.name,
      kind: input.kind,
      description: input.description || null,
      group_type: 6,
    }).select("id").single(),
  );
  const { event } = await op(s, "group.create", group.id, {}, idem);
  return { groupId: group.id, event };
}

export async function addDevicesToGroup(s: Session, groupId: string, deviceIds: string[], idem: string | null) {
  await getGroup(s.enterpriseId, groupId);
  await getDevices(s.enterpriseId, deviceIds); // tenant check
  return await op(s, "group.add_devices", groupId, { device_ids: deviceIds }, idem);
}

export async function removeDeviceFromGroup(s: Session, groupId: string, deviceId: string, idem: string | null) {
  await getGroup(s.enterpriseId, groupId);
  await getDevices(s.enterpriseId, [deviceId]);
  return await op(s, "group.remove_device", groupId, { device_id: deviceId }, idem);
}

export async function removeDeviceFromAllGroups(s: Session, deviceId: string, idem: string | null) {
  await getDevice(s.enterpriseId, deviceId); // tenant check
  type G = { id: string; name: string };
  // PostgREST returns a to-one embed as an object; the generated type says array. Accept both.
  const memberships = await run<{ groups: G | G[] }[]>(
    db().from("group_devices").select("groups!inner(id, name, enterprise_id)")
      .eq("device_id", deviceId).eq("groups.enterprise_id", s.enterpriseId),
  );
  const groups = memberships.flatMap((m) => (Array.isArray(m.groups) ? m.groups : [m.groups])).map((g) => ({ id: g.id, name: g.name }));
  // Submit each group's removal independently so one stuck group does not block the others;
  // the HTTP layer reports per-event state. Per-(device,group) idempotency key keeps retries distinct.
  const results = await Promise.all(groups.map((g) =>
    submitOperation({
      enterpriseId: s.enterpriseId,
      adminId: s.adminId,
      category: "group",
      action: "group.remove_device",
      groupId: g.id,
      params: { device_id: deviceId },
      idempotencyKey: idem ? `${idem}:${g.id}` : null,
    })
  ));
  return { events: results.map((r) => r.event), groups };
}

export async function deleteGroup(s: Session, groupId: string, idem: string | null) {
  await getGroup(s.enterpriseId, groupId);
  return await op(s, "group.delete", groupId, {}, idem);
}

export async function associateProfiles(s: Session, groupId: string, profileIds: string[], idem: string | null) {
  await getGroup(s.enterpriseId, groupId);
  const profiles = await getProfiles(s.enterpriseId, profileIds);
  const notReady = profiles.filter((p) => p.state !== "published");
  if (notReady.length) fail("PROFILE_NOT_PUBLISHED", `Publish first: ${notReady.map((p) => p.name).join(", ")}`);
  return await op(s, "group.associate_profiles", groupId, { profile_ids: profileIds }, idem);
}

export async function disassociateProfiles(s: Session, groupId: string, profileIds: string[], idem: string | null) {
  await getGroup(s.enterpriseId, groupId);
  await getProfiles(s.enterpriseId, profileIds);
  return await op(s, "group.disassociate_profiles", groupId, { profile_ids: profileIds }, idem);
}

/** Fan reset_passcode out to every enrolled member device in the group. */
export async function resetPasscodeOnGroup(
  s: Session,
  groupId: string,
  input: { passcode: string; emailUser: boolean; emailAdmin: boolean },
  idem: string | null,
) {
  const g = await getGroup(s.enterpriseId, groupId);
  const rows = await run<{ device_id: string }[]>(
    db().from("group_devices").select("device_id, devices!inner(is_removed)")
      .eq("group_id", groupId).eq("devices.is_removed", false),
  );
  const deviceIds = rows.map((r) => r.device_id);
  if (!deviceIds.length) fail("CONFLICT", `Group "${g.name}" has no enrolled devices`);
  // Two-step: nothing is sent until the admin confirms by typing the group name.
  return await requestGroupPasscodeReset(s, g, deviceIds, {
    passcode: input.passcode,
    email_sent_to_user: input.emailUser,
    email_sent_to_admin: input.emailAdmin,
  }, idem);
}

// ------------------------------------------------------------- executors
async function zohoGroupId(ev: EventRow) {
  const g = await getGroup(ev.enterprise_id, ev.group_id!);
  return requireZohoId(g.zoho_group_id, `Group "${g.name}"`);
}

registerExecutor("group.create", async (ev) => {
  const g = await getGroup(ev.enterprise_id, ev.group_id!);
  if (g.zoho_group_id) return { state: "succeeded", response: { zoho_group_id: g.zoho_group_id, reused: true } };

  // On a retry the first request may have succeeded with a lost response: reuse a same-named group.
  if (ev.attempts > 1) {
    const existing = (await zoho.listGroups(ev.enterprise_id)).find((x) => x.name === g.name);
    if (existing?.group_id) {
      await run(db().from("groups").update({ zoho_group_id: existing.group_id }).eq("id", g.id));
      return { state: "succeeded", response: { zoho_group_id: existing.group_id, reused: true } };
    }
  }
  const created = await zoho.createGroup(ev.enterprise_id, g.name, g.description ?? "");
  const zid = (created as { group_id?: number }).group_id;
  if (!zid) fail("ZOHO_BAD_REQUEST", "Zoho did not return a group_id");
  await run(db().from("groups").update({ zoho_group_id: zid, last_synced_at: new Date().toISOString() }).eq("id", g.id));
  return { state: "succeeded", response: { zoho_group_id: zid } };
});

registerExecutor("group.add_devices", async (ev) => {
  const zgid = await zohoGroupId(ev);
  const ids = ev.params.device_ids as string[];
  const devices = await getDevices(ev.enterprise_id, ids);
  // Zoho answers 409 "already exists in a group" for members it already has, which made
  // harmless repeats land in the backlog. Add only the missing ones.
  const memberKey = (m: Record<string, unknown>) => String(m.device_id ?? m.member_id ?? m.resource_id ?? "");
  const current = new Set((await zoho.listGroupMembers(ev.enterprise_id, zgid)).map(memberKey));
  const missing = devices.filter((d) => !current.has(String(d.zoho_device_id)));
  if (missing.length) {
    try {
      await zoho.addGroupMembers(ev.enterprise_id, zgid, missing.map((d) => d.zoho_device_id));
    } catch (e) {
      // Raced with someone else adding them: fine if they're all members now.
      const err = toAppError(e);
      const now = new Set((await zoho.listGroupMembers(ev.enterprise_id, zgid)).map(memberKey));
      if (!(err.code === "ZOHO_BAD_REQUEST" && missing.every((d) => now.has(String(d.zoho_device_id))))) throw e;
    }
  }
  await run(
    db().from("group_devices").upsert(devices.map((d) => ({ group_id: ev.group_id, device_id: d.id })), {
      onConflict: "group_id,device_id",
      ignoreDuplicates: true,
    }),
  );
  await refreshMemberCount(ev.group_id!);
  return { state: "succeeded", response: { added: devices.length } };
});

registerExecutor("group.remove_device", async (ev) => {
  const zgid = await zohoGroupId(ev);
  const [device] = await getDevices(ev.enterprise_id, [ev.params.device_id as string]);
  await zoho.removeGroupMember(ev.enterprise_id, zgid, device.zoho_device_id);
  await run(db().from("group_devices").delete().eq("group_id", ev.group_id!).eq("device_id", device.id));
  await refreshMemberCount(ev.group_id!);
  return { state: "succeeded" };
});

registerExecutor("group.delete", async (ev) => {
  const g = await getGroup(ev.enterprise_id, ev.group_id!);
  if (g.zoho_group_id) {
    try {
      await zoho.deleteGroup(ev.enterprise_id, g.zoho_group_id);
    } catch (e) {
      if ((e as { code?: string }).code !== "ZOHO_NOT_FOUND") throw e; // already gone is fine
    }
  }
  await run(db().from("groups").delete().eq("id", g.id));
  return { state: "succeeded", response: { deleted_group: g.name } };
});

registerExecutor("group.associate_profiles", async (ev) => {
  const zgid = await zohoGroupId(ev);
  const profiles = await getProfiles(ev.enterprise_id, ev.params.profile_ids as string[]);
  const zpids = profiles.map((p) => requireZohoId(p.zoho_profile_id, p.name));
  await zoho.associateProfilesToGroup(ev.enterprise_id, zgid, zpids);
  await run(
    db().from("profile_groups").upsert(
      profiles.map((p) => ({ profile_id: p.id, group_id: ev.group_id, associated_by: ev.admin_id, source: "platform" })),
      { onConflict: "profile_id,group_id" },
    ),
  );
  // Zoho's associate POST stores the link but devices only receive the policy on
  // their next check-in. pushProfileUpdate forces an immediate push per profile.
  // Non-fatal: on error we log and still return succeeded (link is correct).
  const pushed: string[] = [];
  for (const zpid of zpids) {
    try {
      await zoho.pushProfileUpdate(ev.enterprise_id, zpid);
      pushed.push(zpid);
    } catch (e) {
      log("warn", "group.associate_push_failed", { enterprise_id: ev.enterprise_id, zoho_profile_id: zpid, error: String(e) });
    }
  }
  return { state: "succeeded", response: { associated: profiles.length, pushed: pushed.length } };
});

registerExecutor("group.disassociate_profiles", async (ev) => {
  const zgid = await zohoGroupId(ev);
  const profiles = await getProfiles(ev.enterprise_id, ev.params.profile_ids as string[]);
  await zoho.disassociateProfilesFromGroup(ev.enterprise_id, zgid, profiles.map((p) => requireZohoId(p.zoho_profile_id, p.name)));
  await run(db().from("profile_groups").delete().eq("group_id", ev.group_id!).in("profile_id", profiles.map((p) => p.id)));
  return { state: "succeeded", response: { removed: profiles.length } };
});

async function refreshMemberCount(groupId: string) {
  const { count } = await db().from("group_devices").select("device_id", { count: "exact", head: true }).eq("group_id", groupId);
  await db().from("groups").update({ member_count: count ?? 0 }).eq("id", groupId);
}
