// App distribution: install/uninstall Zoho-repository apps on groups + list
// installed apps on a device. Follows the same event-executor pattern as
// profiles — the HTTP route creates an event, the executor calls Zoho.
import { db, run } from "../lib/db.ts";
import { fail } from "../lib/errors.ts";
import * as zoho from "../zoho/api.ts";
import type { Session } from "./auth.ts";
import { raiseIfFailed, registerExecutor, submitOperation } from "./events.ts";
import { getDevice, getGroup, requireZohoId } from "./lookup.ts";

export type AppInstallSpec = { appId: string; releaseLabelId?: string | null };

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

export async function installAppsOnGroup(s: Session, groupId: string, apps: AppInstallSpec[], idem: string | null) {
  if (!apps.length) fail("VALIDATION_FAILED", "Pick at least one app to install");
  await getGroup(s.enterpriseId, groupId);
  return await op(s, "group.install_apps", groupId, { apps }, idem);
}

export async function uninstallAppsFromGroup(s: Session, groupId: string, appIds: string[], idem: string | null) {
  if (!appIds.length) fail("VALIDATION_FAILED", "Pick at least one app to remove");
  await getGroup(s.enterpriseId, groupId);
  return await op(s, "group.uninstall_apps", groupId, { app_ids: appIds }, idem);
}

/** Live from Zoho: what is installed on a specific device right now. */
export async function deviceInstalledApps(s: Session, deviceId: string) {
  const device = await getDevice(s.enterpriseId, deviceId);
  const resp = await zoho.listDeviceApps(s.enterpriseId, device.zoho_device_id);
  const list = (resp as { installed_apps?: unknown[] }).installed_apps ?? [];
  return Array.isArray(list) ? list : [];
}

/**
 * Union of installed apps across every enrolled member of the group. Deduped by
 * package identifier. Each entry carries a `devices` count so the UI can show
 * "installed on 2/3 devices".
 */
export async function groupInstalledApps(s: Session, groupId: string) {
  await getGroup(s.enterpriseId, groupId);
  // Supabase types `!inner(...)` as an array even for 1:1; cast and normalise.
  const rows = await run<{ device_id: string; devices: unknown }[]>(
    db().from("group_devices").select("device_id, devices!inner(id, zoho_device_id, is_removed)")
      .eq("group_id", groupId).eq("devices.is_removed", false),
  );
  const zohoIds: string[] = [];
  for (const r of rows) {
    const d = Array.isArray(r.devices) ? r.devices[0] : r.devices;
    const zid = (d as { zoho_device_id?: string } | undefined)?.zoho_device_id;
    if (zid) zohoIds.push(String(zid));
  }
  if (!zohoIds.length) return [] as { identifier: string; app_name: string; platform_type: string; app_version?: string; devices: number }[];

  type App = { identifier?: string; app_name?: string; platform_type?: string; app_version?: string };
  const seen = new Map<string, { identifier: string; app_name: string; platform_type: string; app_version?: string; devices: number }>();
  // Fetch 3-at-a-time to stay gentle on Zoho rate limits.
  for (let i = 0; i < zohoIds.length; i += 3) {
    const chunk = zohoIds.slice(i, i + 3);
    const batches = await Promise.all(chunk.map(async (zid) => {
      try {
        const resp = await zoho.listDeviceApps(s.enterpriseId, zid);
        const list = (resp as { installed_apps?: App[] }).installed_apps ?? [];
        return Array.isArray(list) ? list : [];
      } catch {
        return [] as App[];
      }
    }));
    for (const apps of batches) {
      for (const a of apps) {
        const id = a.identifier;
        if (!id) continue;
        const existing = seen.get(id);
        if (existing) existing.devices += 1;
        else seen.set(id, {
          identifier: id,
          app_name: a.app_name ?? id,
          platform_type: String(a.platform_type ?? "android"),
          app_version: a.app_version,
          devices: 1,
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.app_name.localeCompare(b.app_name));
}

/**
 * Union of apps installed across every enrolled device in the enterprise.
 * Used by the kiosk picker to offer real options when the Zoho app repo is empty.
 * Dedupes by identifier and carries a `devices` count for UX ("installed on 7
 * devices"). Pass `platformType` (1=iOS, 2=Android) to filter.
 */
export async function enterpriseInstalledApps(s: Session, platformType?: number) {
  type Row = { zoho_device_id: string | null };
  const rows = await run<Row[]>(
    db().from("devices").select("zoho_device_id")
      .eq("enterprise_id", s.enterpriseId).eq("is_removed", false).not("zoho_device_id", "is", null),
  );
  const zohoIds = rows.map((r) => r.zoho_device_id).filter((x): x is string => !!x);
  if (!zohoIds.length) return [] as { identifier: string; app_name: string; platform_type: string; app_version?: string; devices: number }[];

  type App = { identifier?: string; app_name?: string; platform_type?: string | number; app_version?: string };
  const seen = new Map<string, { identifier: string; app_name: string; platform_type: string; app_version?: string; devices: number }>();
  // 3-at-a-time, same rate-limit shape as groupInstalledApps.
  for (let i = 0; i < zohoIds.length; i += 3) {
    const chunk = zohoIds.slice(i, i + 3);
    const batches = await Promise.all(chunk.map(async (zid) => {
      try {
        const resp = await zoho.listDeviceApps(s.enterpriseId, zid);
        const list = (resp as { installed_apps?: App[] }).installed_apps ?? [];
        return Array.isArray(list) ? list : [];
      } catch {
        return [] as App[];
      }
    }));
    for (const apps of batches) {
      for (const a of apps) {
        const id = a.identifier;
        if (!id) continue;
        const pt = String(a.platform_type ?? "");
        if (platformType !== undefined && Number(pt) !== platformType) continue;
        const existing = seen.get(id);
        if (existing) existing.devices += 1;
        else seen.set(id, {
          identifier: id,
          app_name: a.app_name ?? id,
          platform_type: pt,
          app_version: a.app_version,
          devices: 1,
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.app_name.localeCompare(b.app_name));
}

// ---------------------------------------------------------------- executors
async function zohoGroupId(enterpriseId: string, groupId: string): Promise<string> {
  const g = await getGroup(enterpriseId, groupId);
  return requireZohoId(g.zoho_group_id, `Group "${g.name}"`);
}

/**
 * If the caller didn't supply release_label_id, fetch the app detail and pick
 * the first (Stable / Production) label. Avoids making the UI mandatory.
 */
async function resolveReleaseLabel(enterpriseId: string, appId: string, provided?: string | null): Promise<string> {
  if (provided) return String(provided);
  const detail = await zoho.getAppDetail(enterpriseId, appId) as { release_labels?: { release_label_id?: string | number }[] };
  const labels = detail.release_labels ?? [];
  if (!labels.length) fail("VALIDATION_FAILED", `App ${appId} has no release labels in Zoho`);
  return String(labels[0].release_label_id);
}

registerExecutor("group.install_apps", async (ev) => {
  const zgid = await zohoGroupId(ev.enterprise_id, ev.group_id!);
  const apps = ev.params.apps as AppInstallSpec[];
  const resolved: { app_id: string; release_label_id: string }[] = [];
  for (const a of apps) {
    resolved.push({ app_id: String(a.appId), release_label_id: await resolveReleaseLabel(ev.enterprise_id, String(a.appId), a.releaseLabelId) });
  }
  await zoho.installAppsOnGroup(ev.enterprise_id, zgid, resolved, { silent_install: true });
  return { state: "succeeded", response: { installed: resolved.length } };
});

registerExecutor("group.uninstall_apps", async (ev) => {
  const zgid = await zohoGroupId(ev.enterprise_id, ev.group_id!);
  const appIds = (ev.params.app_ids as string[]).map(String);
  await zoho.uninstallAppsFromGroup(ev.enterprise_id, zgid, appIds);
  return { state: "succeeded", response: { removed: appIds.length } };
});

// ------------------------------------------------------------ app blacklist
export type BlacklistEntry = { identifier: string; platform: number; appname: string };

export const listBlacklistApps = (s: Session) => zoho.listBlacklistApps(s.enterpriseId);

export async function blacklistAppsOnGroup(s: Session, groupId: string, entries: BlacklistEntry[], idem: string | null) {
  if (!entries.length) fail("VALIDATION_FAILED", "Pick at least one app to blacklist");
  await getGroup(s.enterpriseId, groupId);
  return await op(s, "group.blacklist_apps", groupId, { entries }, idem);
}

export async function removeBlacklistFromGroup(s: Session, groupId: string, appGroupIds: string[], idem: string | null) {
  if (!appGroupIds.length) fail("VALIDATION_FAILED", "Pick at least one app to unblock");
  await getGroup(s.enterpriseId, groupId);
  return await op(s, "group.remove_blacklist", groupId, { app_group_ids: appGroupIds }, idem);
}

/**
 * Zoho's /blacklist/devices expects device IDs, not group IDs. Resolve the
 * group's current enrolled member device IDs so we can fan the blacklist across
 * them. Returns the Zoho device IDs.
 */
async function groupMemberZohoIds(enterpriseId: string, groupId: string): Promise<string[]> {
  const rows = await run<{ device_id: string; devices: unknown }[]>(
    db().from("group_devices").select("device_id, devices!inner(zoho_device_id, is_removed)")
      .eq("group_id", groupId).eq("devices.is_removed", false),
  );
  const ids: string[] = [];
  for (const r of rows) {
    const d = Array.isArray(r.devices) ? r.devices[0] : r.devices;
    const zid = (d as { zoho_device_id?: string } | undefined)?.zoho_device_id;
    if (zid) ids.push(String(zid));
  }
  return ids;
}

registerExecutor("group.blacklist_apps", async (ev) => {
  await zohoGroupId(ev.enterprise_id, ev.group_id!); // tenant + existence check
  const deviceZids = await groupMemberZohoIds(ev.enterprise_id, ev.group_id!);
  if (!deviceZids.length) fail("CONFLICT", "Group has no enrolled devices to apply the blacklist to");
  const entries = ev.params.entries as BlacklistEntry[];
  // Step 1: register apps in the blacklist repo (idempotent; Zoho dedupes by identifier).
  // The response has { apps: [{ appgroupid, identifier, ... }] }. We also need existing
  // appgroupids for entries that already exist in the repo, so merge with the list.
  const addResp = await zoho.addBlacklistApp(ev.enterprise_id, entries) as { apps?: { appgroupid?: string | number; identifier?: string }[] };
  const added = addResp.apps ?? [];
  const existing = ((await zoho.listBlacklistApps(ev.enterprise_id)) as { apps?: { appgroupid?: string | number; identifier?: string }[] }).apps ?? [];
  const byIdentifier = new Map<string, string>();
  for (const row of [...existing, ...added]) {
    if (row.identifier && row.appgroupid) byIdentifier.set(String(row.identifier), String(row.appgroupid));
  }
  const appGroupIds = entries.map((e) => byIdentifier.get(e.identifier)).filter((x): x is string => !!x);
  if (!appGroupIds.length) fail("ZOHO_BAD_REQUEST", "Could not resolve appgroupids for blacklist entries");
  // Step 2: apply to every member device of the group (Zoho's endpoint is device-scoped).
  await zoho.applyBlacklistToResources(ev.enterprise_id, deviceZids, appGroupIds);
  return { state: "succeeded", response: { blacklisted: appGroupIds.length, devices: deviceZids.length, app_group_ids: appGroupIds } };
});

registerExecutor("group.remove_blacklist", async (ev) => {
  await zohoGroupId(ev.enterprise_id, ev.group_id!);
  const deviceZids = await groupMemberZohoIds(ev.enterprise_id, ev.group_id!);
  const appGroupIds = (ev.params.app_group_ids as string[]).map(String);
  if (!deviceZids.length) return { state: "succeeded", response: { unblocked: 0, note: "Group has no enrolled devices" } };
  try {
    await zoho.removeBlacklistFromResources(ev.enterprise_id, deviceZids, appGroupIds);
  } catch (e) {
    // Zoho returns 404 when the appgroupid wasn't actually applied to these devices.
    if ((e as { code?: string }).code !== "ZOHO_NOT_FOUND") throw e;
    return { state: "succeeded", response: { unblocked: 0, note: "Was not applied to this group's devices" } };
  }
  return { state: "succeeded", response: { unblocked: appGroupIds.length, devices: deviceZids.length } };
});

/**
 * Nuke apps from the enterprise blacklist repo entirely (not just per-group).
 * Direct call — no event wrapper because this is a one-shot admin cleanup with
 * no retry semantics. Returns Zoho's response for the caller to inspect.
 */
export async function deleteFromBlacklistRepo(s: Session, appGroupIds: string[]) {
  if (!appGroupIds.length) fail("VALIDATION_FAILED", "appGroupIds[] required");
  return await zoho.deleteBlacklistApp(s.enterpriseId, appGroupIds);
}

// --------------------------------------------------- device-specific blacklist
// Groups remain the primary way to block apps; this layer is for "block app X
// on just this one phone." Zoho's /blacklist/devices primitive is per-device,
// so this is a direct call with resource_ids = [one device].
//
// Sharp edge: Zoho's pair-table doesn't record origin. If an app is blocked
// both via a group AND directly on a device, Zoho stores one entry; removing
// from the group also removes it from the device. We sidestep this at add
// time by rejecting overlap (see blacklistAppsOnDevice).

const deviceOp = (s: Session, action: string, deviceId: string, params: Record<string, unknown>, idem: string | null) =>
  submitOperation({
    enterpriseId: s.enterpriseId,
    adminId: s.adminId,
    category: "command",
    action,
    deviceId,
    params,
    idempotencyKey: idem,
  }).then((r) => ({ ...r, event: raiseIfFailed(r.event) }));

/** Running tally of appgroupids directly blocked on this device, from this device's events. */
async function directlyBlockedAppGroupIds(enterpriseId: string, deviceId: string): Promise<Set<string>> {
  const rows = await run<{ action: string; response: Record<string, unknown> | null }[]>(
    db().from("events").select("action, response")
      .eq("enterprise_id", enterpriseId).eq("device_id", deviceId)
      .in("action", ["command.blacklist_apps", "command.remove_blacklist"])
      .eq("state", "succeeded")
      .order("action_time", { ascending: true }),
  );
  const blocked = new Set<string>();
  for (const r of rows) {
    const ids = ((r.response ?? {}) as { app_group_ids?: unknown }).app_group_ids;
    const list = Array.isArray(ids) ? ids.map(String) : [];
    if (r.action === "command.blacklist_apps") list.forEach((id) => blocked.add(id));
    else list.forEach((id) => blocked.delete(id));
  }
  return blocked;
}

/** Appgroupids currently blocked via any of this device's groups (running tally per group). */
async function groupBlockedAppGroupIds(enterpriseId: string, deviceId: string): Promise<Map<string, { groupId: string; groupName: string }>> {
  type Row = { action: string; response: Record<string, unknown> | null; group_id: string; groups: { name?: string } | { name?: string }[] | null };
  const memberships = await run<{ group_id: string }[]>(
    db().from("group_devices").select("group_id").eq("device_id", deviceId),
  );
  const groupIds = memberships.map((m) => m.group_id);
  if (!groupIds.length) return new Map();
  const rows = await run<Row[]>(
    db().from("events").select("action, response, group_id, groups(name)")
      .eq("enterprise_id", enterpriseId).in("group_id", groupIds)
      .in("action", ["group.blacklist_apps", "group.remove_blacklist"])
      .eq("state", "succeeded")
      .order("action_time", { ascending: true }),
  );
  // Per-group running set.
  const perGroup = new Map<string, { name: string; blocked: Set<string> }>();
  for (const r of rows) {
    const name = (Array.isArray(r.groups) ? r.groups[0]?.name : r.groups?.name) ?? r.group_id;
    const entry = perGroup.get(r.group_id) ?? { name, blocked: new Set<string>() };
    const ids = ((r.response ?? {}) as { app_group_ids?: unknown }).app_group_ids;
    const list = Array.isArray(ids) ? ids.map(String) : [];
    if (r.action === "group.blacklist_apps") list.forEach((id) => entry.blocked.add(id));
    else list.forEach((id) => entry.blocked.delete(id));
    perGroup.set(r.group_id, entry);
  }
  const byAppGroupId = new Map<string, { groupId: string; groupName: string }>();
  for (const [groupId, { name, blocked }] of perGroup) {
    for (const id of blocked) if (!byAppGroupId.has(id)) byAppGroupId.set(id, { groupId, groupName: name });
  }
  return byAppGroupId;
}

export async function blacklistAppsOnDevice(s: Session, deviceId: string, entries: BlacklistEntry[], idem: string | null) {
  if (!entries.length) fail("VALIDATION_FAILED", "Pick at least one app to blacklist");
  if (entries.length > 100) fail("VALIDATION_FAILED", "Cannot block more than 100 apps in one request");
  for (const e of entries) {
    if (!e || typeof e.identifier !== "string" || !/^[a-zA-Z][\w.]+$/.test(e.identifier)) {
      fail("VALIDATION_FAILED", `Invalid package identifier: ${e?.identifier ?? "(missing)"}`);
    }
    if (![1, 2, 3, 4].includes(Number(e.platform))) {
      fail("VALIDATION_FAILED", `Invalid platform code for ${e.identifier} (expected 1=iOS, 2=Android, 3=Windows, 4=macOS)`);
    }
  }
  await getDevice(s.enterpriseId, deviceId);
  // Prevent overlap with group blocklists on this device (Zoho has no per-origin ledger).
  const groupBlocks = await groupBlockedAppGroupIds(s.enterpriseId, deviceId);
  const repo = ((await zoho.listBlacklistApps(s.enterpriseId)) as { apps?: { appgroupid?: string | number; identifier?: string }[] }).apps ?? [];
  const idByIdentifier = new Map(repo.filter((a) => a.identifier && a.appgroupid).map((a) => [String(a.identifier), String(a.appgroupid!)]));
  const clashes: string[] = [];
  for (const e of entries) {
    const existingId = idByIdentifier.get(e.identifier);
    if (!existingId) continue;
    const g = groupBlocks.get(existingId);
    if (g) clashes.push(`${e.appname || e.identifier} (via group ${g.groupName})`);
  }
  if (clashes.length) {
    fail("CONFLICT", `Already blocked: ${clashes.join(", ")}. Remove from the group first, or move this device to a group that doesn't block it.`);
  }
  return await deviceOp(s, "command.blacklist_apps", deviceId, { entries }, idem);
}

export async function removeDeviceBlacklist(s: Session, deviceId: string, appGroupIds: string[], idem: string | null) {
  if (!appGroupIds.length) fail("VALIDATION_FAILED", "Pick at least one app to unblock");
  await getDevice(s.enterpriseId, deviceId);
  return await deviceOp(s, "command.remove_blacklist", deviceId, { app_group_ids: appGroupIds.map(String) }, idem);
}

/** Summary for the device page: direct blocks (unblockable here) + group-origin blocks (informational). */
export async function deviceBlacklistSummary(s: Session, deviceId: string) {
  await getDevice(s.enterpriseId, deviceId);
  const [direct, viaGroups, repo] = await Promise.all([
    directlyBlockedAppGroupIds(s.enterpriseId, deviceId),
    groupBlockedAppGroupIds(s.enterpriseId, deviceId),
    zoho.listBlacklistApps(s.enterpriseId) as Promise<{ apps?: { appgroupid?: string | number; identifier?: string; appname?: string; platform?: string | number }[] }>,
  ]);
  const byAppGroupId = new Map((repo.apps ?? []).filter((a) => a.appgroupid).map((a) => [String(a.appgroupid!), a]));
  const describe = (id: string) => {
    const a = byAppGroupId.get(id);
    return { app_group_id: id, appname: a?.appname ?? a?.identifier ?? id, identifier: a?.identifier ?? "", platform: a?.platform ?? null };
  };
  return {
    direct: [...direct].map(describe),
    via_groups: [...viaGroups.entries()].map(([id, src]) => ({ ...describe(id), group_id: src.groupId, group_name: src.groupName })),
  };
}

registerExecutor("command.blacklist_apps", async (ev) => {
  const device = await getDevice(ev.enterprise_id, ev.device_id!);
  const entries = ev.params.entries as BlacklistEntry[];
  const addResp = await zoho.addBlacklistApp(ev.enterprise_id, entries) as { apps?: { appgroupid?: string | number; identifier?: string }[] };
  const added = addResp.apps ?? [];
  const existing = ((await zoho.listBlacklistApps(ev.enterprise_id)) as { apps?: { appgroupid?: string | number; identifier?: string }[] }).apps ?? [];
  const byIdentifier = new Map<string, string>();
  for (const row of [...existing, ...added]) {
    if (row.identifier && row.appgroupid) byIdentifier.set(String(row.identifier), String(row.appgroupid));
  }
  const appGroupIds = entries.map((e) => byIdentifier.get(e.identifier)).filter((x): x is string => !!x);
  if (!appGroupIds.length) fail("ZOHO_BAD_REQUEST", "Could not resolve appgroupids for blacklist entries");
  await zoho.applyBlacklistToResources(ev.enterprise_id, [device.zoho_device_id], appGroupIds);
  return { state: "succeeded", response: { blacklisted: appGroupIds.length, app_group_ids: appGroupIds } };
});

registerExecutor("command.remove_blacklist", async (ev) => {
  const device = await getDevice(ev.enterprise_id, ev.device_id!);
  const appGroupIds = (ev.params.app_group_ids as string[]).map(String);
  try {
    await zoho.removeBlacklistFromResources(ev.enterprise_id, [device.zoho_device_id], appGroupIds);
  } catch (e) {
    if ((e as { code?: string }).code !== "ZOHO_NOT_FOUND") throw e;
    return { state: "succeeded", response: { unblocked: 0, app_group_ids: appGroupIds, note: "Was not blocked on this device" } };
  }
  return { state: "succeeded", response: { unblocked: appGroupIds.length, app_group_ids: appGroupIds } };
});

