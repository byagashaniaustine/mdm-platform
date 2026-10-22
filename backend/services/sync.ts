// Pull Zoho state into Supabase. Zoho is the source of truth for device state;
// our tables add business data (department/function kind, events, announcements).
import { db, run } from "../lib/db.ts";
import { getConfig } from "../config.ts";
import { fail, toAppError } from "../lib/errors.ts";
import { acquireLease, releaseLease } from "../lib/lease.ts";
import { log } from "../lib/log.ts";
import * as zoho from "../zoho/api.ts";
import { recordAudit } from "./events.ts";
import { onDevicesUnenrolled, scanEnterprise } from "./security-scan.ts";

type Json = Record<string, unknown>;

// Zoho returns booleans inconsistently: real booleans sometimes, the strings
// "true"/"false" other times. Plain Boolean("false") is true, which silently
// marked every device is_removed on every sync. Coerce explicitly.
function zbool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  if (typeof v === "number") return v !== 0;
  return false;
}

export type Resource =
  | "users"
  | "devices"
  | "groups"
  | "profiles"
  | "apps"
  | "announcements"
  | "compliance"
  | "device_details";
// Order matters: user/device/group/profile first (schema parents); the catalogs after.
// device_details is opt-in: it fans out 2 Zoho HTTP calls per enrolled device, so a
// default sync omits it. Callers that want it pass it explicitly:
//   syncEnterprise(eid, [...DEFAULT_RESOURCES, "device_details"])
// or the background scan worker runs it on its own cadence.
const ALL: Resource[] = [
  "users",
  "devices",
  "groups",
  "profiles",
  "apps",
  "announcements",
  "compliance",
];
export const OPTIONAL: Resource[] = ["device_details"];

const PLATFORM: Record<string, string> = { "1": "ios", "2": "android", "3": "windows", "4": "chrome", "6": "macos" };

function platformOf(d: Json): string {
  const byId = PLATFORM[String(d.platform_type_id ?? d.platform_type ?? "")];
  if (byId) return byId;
  const s = String(d.platform_type ?? "").toLowerCase();
  if (s.includes("android")) return "android";
  if (s.includes("ios") || s.includes("iphone") || s.includes("ipad")) return "ios";
  if (s.includes("windows")) return "windows";
  if (s.includes("mac")) return "macos";
  return "unknown";
}

const nowIso = () => new Date().toISOString();

async function syncUsers(eid: string): Promise<number> {
  const users = await zoho.listUsers(eid);
  const rows = users.filter((u) => u.user_id).map((u) => ({
    enterprise_id: eid,
    zoho_user_id: u.user_id,
    user_name: (u.user_name ?? u.name ?? null) as string | null,
    email: (u.email_address ?? u.user_email ?? u.email ?? null) as string | null,
    synced_at: nowIso(),
  }));
  if (rows.length) await run(db().from("mdm_users").upsert(rows, { onConflict: "enterprise_id,zoho_user_id" }));
  return rows.length;
}

async function syncDevices(eid: string): Promise<number> {
  const devices = await zoho.listDevices(eid);
  const users = await run<{ id: string; zoho_user_id: number }[]>(
    db().from("mdm_users").select("id, zoho_user_id").eq("enterprise_id", eid),
  );
  const userByZoho = new Map(users.map((u) => [String(u.zoho_user_id), u.id]));

  // Make sure device owners exist even if /users was not synced.
  const missing = devices
    .map((d) => d.user as Json | undefined)
    .filter((u): u is Json => !!u?.user_id && !userByZoho.has(String(u.user_id)));
  if (missing.length) {
    const created = await run<{ id: string; zoho_user_id: number }[]>(
      db().from("mdm_users").upsert(
        missing.map((u) => ({ enterprise_id: eid, zoho_user_id: u.user_id, user_name: u.user_name ?? null, email: u.user_email ?? null, synced_at: nowIso() })),
        { onConflict: "enterprise_id,zoho_user_id" },
      ).select("id, zoho_user_id"),
    );
    for (const u of created) userByZoho.set(String(u.zoho_user_id), u.id);
  }

  const cfg = getConfig();
  const now = Date.now();
  const zombieMs = cfg.deviceZombieDays * 86400_000;

  // Zoho returns last_contact_time as a ms-epoch STRING ("1791364641029") on
  // both the list and detail endpoints; coerce to ISO. "-1" or missing → null.
  // unregistered_time: Zoho's explicit "device was unenrolled" marker. "-1" means
  // still enrolled; any positive timestamp means unenrolled at that moment.
  const toContactIso = (v: unknown): string | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
  };
  const isUnregistered = (v: unknown): boolean => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
  };

  const rows = devices.filter((d) => d.device_id).map((d) => {
    const user = d.user as Json | undefined;
    const contactMs = Number(d.last_contact_time);
    const stale = Number.isFinite(contactMs) && contactMs > 0 && (now - contactMs) > zombieMs;
    const unregistered = isUnregistered(d.unregistered_time);
    return {
      enterprise_id: eid,
      zoho_device_id: d.device_id,
      assigned_user_id: user?.user_id ? userByZoho.get(String(user.user_id)) ?? null : null,
      platform: platformOf(d),
      device_name: (d.device_name ?? null) as string | null,
      model: (d.model ?? null) as string | null,
      product_name: (d.product_name ?? null) as string | null,
      os_version: (d.os_version ?? null) as string | null,
      serial_number: d.serial_number ? String(d.serial_number) : null,
      imei: d.imei ? String(d.imei) : null,
      owned_by: (d.owned_by ?? null) as number | null,
      is_lost_mode: zbool(d.is_lost_mode_enabled),
      // Zoho list carries is_supervised; is_profileowner only on /devices/{id} detail
      // (populated opportunistically by the device_details sync).
      is_supervised: d.is_supervised === undefined ? null : zbool(d.is_supervised),
      is_profileowner: d.is_profileowner === undefined ? null : zbool(d.is_profileowner),
      // Samsung Knox devices get shutdown/restart via /knox_actions/. Positive knox_version → Knox-capable.
      is_knox: Number((d.knox_details as { knox_version?: unknown } | undefined)?.knox_version ?? 0) > 0,
      // Zoho-explicit unenrollment OR silence beyond ZOMBIE_DAYS auto-marks removed.
      is_removed: zbool(d.is_removed) || unregistered || stale,
      last_contact_at: toContactIso(d.last_contact_time),
      last_synced_at: nowIso(),
    };
  });
  if (rows.length) await run(db().from("devices").upsert(rows, { onConflict: "enterprise_id,zoho_device_id" }));

  // Devices no longer returned by Zoho are marked removed (kept for history).
  // Diff in JS instead of a PostgREST `not in` filter: zoho_device_id is text
  // but the 18-digit values look numeric, and the inline-list quoting flipped
  // every freshly-synced device back to is_removed=true on the next line.
  const seen = new Set(rows.map((r) => String(r.zoho_device_id)));
  const localActive = await run<{ id: string; zoho_device_id: string; device_name: string | null }[]>(
    db().from("devices").select("id, zoho_device_id, device_name").eq("enterprise_id", eid).eq("is_removed", false),
  );
  const toRemove = localActive.filter((d) => !seen.has(String(d.zoho_device_id)));
  // Union with zombies we just marked removed above (not in `localActive` after upsert).
  const zombiesJustMarked = rows.filter((r) => r.is_removed).map((r) => String(r.zoho_device_id));
  const zombieLocalIds = localActive.filter((d) => zombiesJustMarked.includes(String(d.zoho_device_id)));
  const retireNow = [...toRemove, ...zombieLocalIds];
  if (toRemove.length) {
    await run(db().from("devices").update({ is_removed: true }).in("id", toRemove.map((d) => d.id)));
  }
  if (retireNow.length) {
    await onDevicesUnenrolled(eid, retireNow.map((d) => ({ id: d.id, device_name: d.device_name })));
  }
  return rows.length;
}

async function syncGroups(eid: string): Promise<number> {
  const groups = await zoho.listGroups(eid);
  // kind is ours: not included, so upsert keeps it for existing groups.
  const rows = groups.filter((g) => g.group_id).map((g) => ({
    enterprise_id: eid,
    zoho_group_id: g.group_id,
    name: String(g.name ?? g.group_name ?? "Unnamed group"),
    group_type: Number(g.group_type ?? 6),
    description: (g.description ?? null) as string | null,
    last_synced_at: nowIso(),
  }));
  if (!rows.length) return 0;
  const saved = await run<{ id: string; zoho_group_id: number }[]>(
    db().from("groups").upsert(rows, { onConflict: "enterprise_id,zoho_group_id" }).select("id, zoho_group_id"),
  );

  const devices = await run<{ id: string; zoho_device_id: number }[]>(
    db().from("devices").select("id, zoho_device_id").eq("enterprise_id", eid),
  );
  const deviceByZoho = new Map(devices.map((d) => [String(d.zoho_device_id), d.id]));

  // Rebuild memberships, a few groups at a time to stay gentle on rate limits.
  for (let i = 0; i < saved.length; i += 4) {
    await Promise.all(saved.slice(i, i + 4).map(async (g) => {
      const members = await zoho.listGroupMembers(eid, g.zoho_group_id);
      // Zoho returns members two ways depending on endpoint quirks:
      //   - flat array of id strings:  ["247008000000130084", ...]
      //   - array of objects:          [{device_id: "...", ...}]
      // Treat both; otherwise all memberships silently drop and member_count=0.
      const ids = members
        .map((m) => {
          const zohoId = typeof m === "string" || typeof m === "number"
            ? String(m)
            : String((m as Record<string, unknown>).device_id ?? (m as Record<string, unknown>).member_id ?? (m as Record<string, unknown>).resource_id ?? "");
          return zohoId ? deviceByZoho.get(zohoId) : undefined;
        })
        .filter((x): x is string => !!x);
      await run(db().from("group_devices").delete().eq("group_id", g.id));
      if (ids.length) await run(db().from("group_devices").insert(ids.map((device_id) => ({ group_id: g.id, device_id }))));
      await db().from("groups").update({ member_count: ids.length }).eq("id", g.id);
    }));
  }

  // Groups no longer in Zoho — hard-delete (unlike profiles there's no soft-delete
  // state on groups). Clean up profile/device links too so the FK constraints hold.
  const seen = new Set(rows.map((r) => String(r.zoho_group_id)));
  const localAll = await run<{ id: string; zoho_group_id: string | null }[]>(
    db().from("groups").select("id, zoho_group_id").eq("enterprise_id", eid).not("zoho_group_id", "is", null),
  );
  const vanished = localAll.filter((g) => !seen.has(String(g.zoho_group_id))).map((g) => g.id);
  if (vanished.length) {
    await run(db().from("group_devices").delete().in("group_id", vanished));
    await run(db().from("profile_groups").delete().in("group_id", vanished));
    await run(db().from("groups").delete().in("id", vanished));
    log("info", "sync.groups_vanished_from_zoho", { enterprise_id: eid, count: vanished.length });
  }

  return saved.length;
}

async function fetchPayloadConfig(eid: string, zpid: string, payloadNames: string[]): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const name of payloadNames) {
    try {
      const summary = await zoho.getPayloadSummary(eid, zpid, name);
      const itemIds = (summary.payloaditems ?? []).map(String);
      if (!itemIds.length) continue;
      // Usually one item per payload; if multiple, merge in order (later wins).
      const items = await Promise.all(itemIds.map((id) => zoho.getPayloadItem(eid, zpid, name, id)));
      out[name] = items.length === 1 ? items[0] : Object.assign({}, ...items);
    } catch (e) {
      log("warn", "sync.payload_item_failed", { enterprise_id: eid, zoho_profile_id: zpid, payload_name: name, error: String(e) });
    }
  }
  return out;
}

async function syncProfiles(eid: string): Promise<number> {
  const profiles = await zoho.listProfiles(eid);
  const local = await run<{ zoho_profile_id: number; state: string; payload_names: string[] | null; payload_config: Record<string, Json> | null }[]>(
    db().from("profiles").select("zoho_profile_id, state, payload_names, payload_config").eq("enterprise_id", eid).not("zoho_profile_id", "is", null),
  );
  const localState = new Map(local.map((p) => [String(p.zoho_profile_id), p.state]));
  const localPayloads = new Map(local.map((p) => [String(p.zoho_profile_id), p.payload_names ?? []]));
  const localConfig = new Map(local.map((p) => [String(p.zoho_profile_id), p.payload_config ?? {}]));

  // Zoho's /profiles list omits payload info. For each non-trashed profile fetch
  // detail (payload names) and then every payload item's actual field values, so
  // payload_names + payload_config mirror Zoho — even for profiles created in the
  // Zoho console. Keep local values on error so a transient failure doesn't wipe.
  const detailById = new Map<string, string[]>();
  const configById = new Map<string, Record<string, Json>>();
  const needDetail = profiles.filter((p) => p.profile_id && !zbool(p.is_moved_to_trash));
  await inBatches(needDetail, 4, async (p) => {
    const zpid = String(p.profile_id);
    try {
      const detail = await zoho.getProfile(eid, p.profile_id as string | number);
      const names = Array.isArray((detail as Json).payloads)
        ? ((detail as Json).payloads as unknown[]).map(String)
        : [];
      detailById.set(zpid, names);
      if (names.length) configById.set(zpid, await fetchPayloadConfig(eid, zpid, names));
    } catch (e) {
      log("warn", "sync.profile_detail_failed", { enterprise_id: eid, zoho_profile_id: zpid, error: String(e) });
    }
  });

  const rows = profiles.filter((p) => p.profile_id).map((p) => {
    // zbool: Zoho sends is_moved_to_trash as the STRING "false", which is truthy
    // in JS — bare `p.is_moved_to_trash ?` marked every profile as deleted.
    const remote = zbool(p.is_moved_to_trash)
      ? "deleted"
      : (/yet to deploy|draft/i.test(String(p.profile_status ?? "")) ? "draft" : "published");
    // Preserve local overrides:
    //   "modified"  = edited here but not re-published → keep unless Zoho trashed it
    //   "deleted"   = user clicked Delete here but Zoho refused the permanent delete
    //                 (no public trash endpoint). Keep hidden locally; sync won't
    //                 flip it back to Published just because Zoho still has it.
    const local = localState.get(String(p.profile_id));
    const keep = (local === "modified" || local === "deleted") && remote !== "deleted";
    const zid = String(p.profile_id);
    const payload_names = detailById.get(zid) ?? localPayloads.get(zid) ?? [];
    const payload_config = configById.get(zid) ?? localConfig.get(zid) ?? {};
    return {
      enterprise_id: eid,
      zoho_profile_id: p.profile_id,
      name: String(p.profile_name ?? "Profile"),
      description: (p.profile_description ?? null) as string | null,
      platform: Number(p.platform_type) === 1 ? "ios" : "android",
      state: keep ? local! : remote,
      payload_names,
      payload_config,
      last_synced_at: nowIso(),
    };
  });
  if (rows.length) await run(db().from("profiles").upsert(rows, { onConflict: "enterprise_id,zoho_profile_id" }));

  // Profiles no longer in Zoho (permanently deleted via console, or never there in
  // the first place) get soft-deleted locally. Same pattern as devices sync — keep
  // the row for history, hide it with state='deleted' so listProfiles ignores it.
  const seen = new Set(rows.map((r) => String(r.zoho_profile_id)));
  const localActive = await run<{ id: string; zoho_profile_id: string; name: string | null }[]>(
    db().from("profiles").select("id, zoho_profile_id, name").eq("enterprise_id", eid).neq("state", "deleted").not("zoho_profile_id", "is", null),
  );
  const toRemove = localActive.filter((p) => !seen.has(String(p.zoho_profile_id)));
  if (toRemove.length) {
    await run(db().from("profiles").update({ state: "deleted" }).in("id", toRemove.map((p) => p.id)));
    await run(db().from("profile_groups").delete().in("profile_id", toRemove.map((p) => p.id)));
    log("info", "sync.profiles_vanished_from_zoho", { enterprise_id: eid, count: toRemove.length, names: toRemove.slice(0, 10).map((p) => p.name) });
  }

  await syncProfileGroups(eid);
  return rows.length;
}

// ------------------------------------------------------- profile ↔ group links
// Zoho documents no "list a group's profiles" call, so links made in the Zoho
// console were invisible here. Try the undocumented GET first; if Zoho rejects
// it, infer the links from what each member device reports.

/** Per enterprise: GET /groups/{id}/profiles unavailable since <ms>. Re-tried after a day. */
const groupProfilesUnavailable = new Map<string, number>();
const RECHECK_MS = 24 * 3600_000;
const UNSUPPORTED = new Set(["ZOHO_NOT_FOUND", "ZOHO_BAD_REQUEST"]);
const INACTIVE_STATUS = /remov|delet|trash/i;

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export async function syncProfileGroups(eid: string): Promise<{ mode: "zoho" | "inferred"; links: number }> {
  const [groups, profiles, devices] = await Promise.all([
    run<{ id: string; zoho_group_id: number | null }[]>(db().from("groups").select("id, zoho_group_id").eq("enterprise_id", eid)),
    run<{ id: string; zoho_profile_id: number }[]>(
      db().from("profiles").select("id, zoho_profile_id").eq("enterprise_id", eid).neq("state", "deleted").not("zoho_profile_id", "is", null),
    ),
    run<{ id: string; zoho_device_id: number }[]>(
      db().from("devices").select("id, zoho_device_id").eq("enterprise_id", eid).eq("is_removed", false),
    ),
  ]);
  const members = groups.length
    ? await run<{ group_id: string; device_id: string }[]>(
      db().from("group_devices").select("group_id, device_id").in("group_id", groups.map((g) => g.id)),
    )
    : [];
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const profileByZoho = new Map(profiles.map((p) => [String(p.zoho_profile_id), p.id]));
  const zohoGroups = groups.filter((g) => g.zoho_group_id);
  const now = nowIso();

  // 1) Direct read, when the endpoint exists.
  if (Date.now() - (groupProfilesUnavailable.get(eid) ?? 0) > RECHECK_MS && zohoGroups.length) {
    const found = new Map<string, string[]>();
    try {
      await inBatches(zohoGroups, 4, async (g) => {
        const list = await zoho.listGroupProfiles(eid, g.zoho_group_id!);
        if (list === null) throw Object.assign(new Error("no profile list"), { code: "ZOHO_BAD_REQUEST" });
        // Zoho may return the list as objects ({profile_id}) OR as bare id strings.
        found.set(g.id, list.map((x) => {
          const zohoId = typeof x === "string" || typeof x === "number"
            ? String(x)
            : String((x as Record<string, unknown>).profile_id ?? (x as Record<string, unknown>).id ?? "");
          return zohoId ? profileByZoho.get(zohoId) : undefined;
        }).filter((x): x is string => !!x));
      });
      groupProfilesUnavailable.delete(eid);
      let links = 0;
      for (const g of zohoGroups) {
        const ids = found.get(g.id) ?? [];
        links += ids.length;
        // Zoho is the source of truth here: replace the group's links.
        let del = db().from("profile_groups").delete().eq("group_id", g.id);
        if (ids.length) del = del.not("profile_id", "in", `(${ids.join(",")})`);
        await run(del);
        if (ids.length) {
          await run(db().from("profile_groups").upsert(ids.map((profile_id) => ({ profile_id, group_id: g.id, source: "zoho", last_seen_at: now })), { onConflict: "profile_id,group_id", ignoreDuplicates: true }));
          await run(db().from("profile_groups").update({ last_seen_at: now }).eq("group_id", g.id).in("profile_id", ids));
          await run(db().from("profile_groups").update({ source: "zoho" }).eq("group_id", g.id).in("profile_id", ids).neq("source", "platform"));
        }
      }
      return { mode: "zoho", links };
    } catch (e) {
      const err = toAppError(e);
      if (!UNSUPPORTED.has(err.code)) throw e;
      groupProfilesUnavailable.set(eid, Date.now());
      log("info", "sync.group_profiles_endpoint_unavailable", { enterprise_id: eid, code: err.code });
    }
  }

  // 2) Infer: a profile belongs to a group when every enrolled member device has it.
  const membersByGroup = new Map<string, { id: string; zoho_device_id: number }[]>();
  for (const m of members) {
    const d = deviceById.get(m.device_id);
    if (!d) continue; // removed from Zoho
    const list = membersByGroup.get(m.group_id) ?? [];
    list.push(d);
    membersByGroup.set(m.group_id, list);
  }
  const deviceIds = [...new Map([...membersByGroup.values()].flat().map((d) => [d.id, d])).values()];
  const profilesOnDevice = new Map<string, Set<string>>();
  await inBatches(deviceIds, 4, async (d) => {
    try {
      const list = await zoho.listDeviceProfiles(eid, d.zoho_device_id);
      profilesOnDevice.set(d.id, new Set(
        list.filter((x) => !INACTIVE_STATUS.test(String(x.status ?? x.localized_remarks ?? "")))
          .map((x) => profileByZoho.get(String(x.profile_id ?? "")))
          .filter((x): x is string => !!x),
      ));
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "ZOHO_NOT_CONNECTED" || err.code === "ZOHO_TOKEN_REFRESH_FAILED") throw e;
      log("warn", "sync.device_profiles_failed", { enterprise_id: eid, device_id: d.id, code: err.code });
    }
  });

  let links = 0;
  for (const [groupId, devs] of membersByGroup) {
    const known = devs.map((d) => profilesOnDevice.get(d.id)).filter((x): x is Set<string> => !!x);
    if (!known.length) continue; // couldn't read any member: leave this group's links alone
    const common = [...known[0]].filter((pid) => known.every((set) => set.has(pid)));
    links += common.length;
    // Only links this process created are removed; links assigned here stay.
    let del = db().from("profile_groups").delete().eq("group_id", groupId).eq("source", "inferred");
    if (common.length) del = del.not("profile_id", "in", `(${common.join(",")})`);
    await run(del);
    if (common.length) {
      await run(db().from("profile_groups").upsert(common.map((profile_id) => ({ profile_id, group_id: groupId, source: "inferred", last_seen_at: now })), { onConflict: "profile_id,group_id", ignoreDuplicates: true }));
      await run(db().from("profile_groups").update({ last_seen_at: now }).eq("group_id", groupId).in("profile_id", common));
    }
  }
  return { mode: "inferred", links };
}

// ---------------------------------------------------------------- apps catalog
// Zoho /apps lists both store apps and enterprise apps the admin uploaded.
// We mirror just the metadata — the app binary itself stays with Zoho.
const PLATFORM_FOR_APP: Record<string, string> = {
  "1": "ios",
  "2": "android",
  "3": "windows",
  "4": "chrome",
  "6": "macos",
};
async function syncApps(eid: string): Promise<number> {
  const apps = await zoho.listApps(eid);
  const rows = apps
    .filter((a) => a.app_id ?? a.id)
    .map((a) => ({
      enterprise_id: eid,
      zoho_app_id: String(a.app_id ?? a.id),
      name: String(a.app_name ?? a.name ?? "App"),
      package_name: (a.package_name ?? a.bundle_id ?? null) as string | null,
      platform: PLATFORM_FOR_APP[String(a.platform_type ?? "")] ?? null,
      app_type: (a.app_type ?? a.type ?? null) as string | null,
      version: a.version ? String(a.version) : (a.app_version ? String(a.app_version) : null),
      description: (a.description ?? null) as string | null,
      last_synced_at: nowIso(),
    }));
  if (rows.length) await run(db().from("apps").upsert(rows, { onConflict: "enterprise_id,zoho_app_id" }));
  return rows.length;
}

// --------------------------------------------------------------- announcements
// Pull announcements created from the Zoho console. Platform-created rows are
// not touched (source='platform').
async function syncAnnouncements(eid: string): Promise<number> {
  const list = await zoho.listAnnouncements(eid);
  const rows = list
    .filter((a) => a.announcement_id ?? a.id)
    .map((a) => {
      const detail = (a.announcement_detail ?? {}) as Json;
      return {
        enterprise_id: eid,
        zoho_announcement_id: String(a.announcement_id ?? a.id),
        name: String(a.announcement_name ?? a.name ?? "Announcement"),
        title: String(detail.title ?? a.title ?? "Announcement"),
        detail_message: String(detail.detail_message ?? a.detail_message ?? ""),
        nbar_message: (detail.nbar_message ?? null) as string | null,
        title_color: (detail.title_color ?? "#1F3A5F") as string,
        format: Number(a.announcement_format ?? 1),
        needs_ack: Boolean(detail.needs_acknowledgement ?? false),
        ack_button: (detail.ack_button ?? "Got it") as string,
        source: "zoho",
        last_synced_at: nowIso(),
      };
    });
  if (rows.length) {
    await run(db().from("announcements").upsert(rows, { onConflict: "enterprise_id,zoho_announcement_id" }));
  }
  return rows.length;
}

// -------------------------------------------------------- compliance policies
async function syncCompliance(eid: string): Promise<number> {
  const policies = await zoho.listCompliancePolicies(eid);
  const rows = policies
    .filter((p) => p.policy_id ?? p.id ?? p.compliance_id)
    .map((p) => ({
      enterprise_id: eid,
      zoho_policy_id: String(p.policy_id ?? p.id ?? p.compliance_id),
      name: String(p.policy_name ?? p.name ?? "Policy"),
      policy_type: (p.policy_type ?? p.type ?? null) as string | null,
      platform: PLATFORM_FOR_APP[String(p.platform_type ?? "")] ?? null,
      description: (p.description ?? p.policy_description ?? null) as string | null,
      raw: p as Json,
      last_synced_at: nowIso(),
    }));
  if (rows.length) {
    await run(db().from("compliance_policies").upsert(rows, { onConflict: "enterprise_id,zoho_policy_id" }));
  }
  return rows.length;
}

// -------------------------------------------------------- per-device details
// Delegates to scanEnterprise (security-scan) which already pulls GET /devices/{id}
// + /summary per device and writes device_snapshots. Returns the number scanned.
async function syncDeviceDetails(eid: string): Promise<number> {
  const r = await scanEnterprise(eid);
  if (r.failed) log("warn", "sync.device_details_partial", { enterprise_id: eid, failed: r.failed });
  return r.scanned;
}

const SYNCERS: Record<Resource, (eid: string) => Promise<number>> = {
  users: syncUsers,
  devices: syncDevices,
  groups: syncGroups,
  profiles: syncProfiles,
  apps: syncApps,
  announcements: syncAnnouncements,
  compliance: syncCompliance,
  device_details: syncDeviceDetails,
};

/** Run the requested resources in dependency order; record one sync_runs row per resource.
 *  Default resources omit `device_details` (opt-in because it fans out per device). */
const SYNC_LEASE_SECONDS = 20 * 60;
/** Compliance often returns Zoho 500 for accounts without the feature: after a failure, the
 *  scheduled sync leaves it alone for a while (a manual sync still tries). */
const COMPLIANCE_BACKOFF_MS = 6 * 3600_000;
const complianceFailedAt = new Map<string, number>();
/** Zoho answered 4xx (e.g. 405: the compliance API isn't on this account): skip it for a day, even on manual sync. */
const complianceUnavailableAt = new Map<string, number>();
const COMPLIANCE_UNAVAILABLE_MS = 24 * 3600_000;

/**
 * One sync per enterprise at a time, across every process (lease "sync:<eid>").
 * opts.quietIfBusy (scheduled runs) skips quietly when another sync holds the lease;
 * a manual sync gets SYNC_IN_PROGRESS instead.
 */
export async function syncEnterprise(
  eid: string,
  resources: Resource[] = ALL,
  adminId: string | null = null,
  opts: { quietIfBusy?: boolean } = {},
) {
  const lease = `sync:${eid}`;
  if (!(await acquireLease(lease, SYNC_LEASE_SECONDS))) {
    if (opts.quietIfBusy) {
      log("info", "sync.skipped_busy", { enterprise_id: eid });
      return { skipped: "another sync is running" } as Record<string, number | string>;
    }
    fail("SYNC_IN_PROGRESS");
  }
  try {
    // We hold the lease, so any "running" row for this enterprise belongs to a sync that died.
    await db().from("sync_runs")
      .update({ status: "failed", error: "Interrupted: the server stopped or restarted during this sync", finished_at: nowIso() })
      .eq("enterprise_id", eid).eq("status", "running");
    return await syncEnterpriseLocked(eid, resources, adminId, () => acquireLease(lease, SYNC_LEASE_SECONDS, true));
  } finally {
    await releaseLease(lease);
  }
}

async function syncEnterpriseLocked(eid: string, resources: Resource[], adminId: string | null, renew: () => Promise<boolean>) {
  const ordered = [...ALL, ...OPTIONAL].filter((r) => resources.includes(r));
  const result: Record<string, number | string> = {};
  for (const resource of ordered) {
    await renew();
    if (resource === "compliance" && Date.now() - (complianceUnavailableAt.get(eid) ?? 0) < COMPLIANCE_UNAVAILABLE_MS) {
      result[resource] = "skipped: not available on this Zoho account";
      continue;
    }
    if (resource === "compliance" && !adminId && Date.now() - (complianceFailedAt.get(eid) ?? 0) < COMPLIANCE_BACKOFF_MS) {
      result[resource] = "skipped: failed recently";
      continue;
    }
    // sync_runs is bookkeeping — if its CHECK constraint rejects a new resource key
    // (migration not yet applied), log and still run the syncer so data flows.
    let runId: string | null = null;
    try {
      const row = await run<{ id: string }>(
        db().from("sync_runs").insert({ enterprise_id: eid, resource }).select("id").single(),
      );
      runId = row.id;
    } catch (e) {
      log("warn", "sync.run_insert_failed", { enterprise_id: eid, resource, code: toAppError(e).code });
    }
    try {
      const items = await SYNCERS[resource](eid);
      result[resource] = items;
      if (resource === "compliance") complianceFailedAt.delete(eid);
      if (runId) {
        await db().from("sync_runs").update({ status: "succeeded", items, finished_at: nowIso() }).eq("id", runId);
      }
    } catch (e) {
      const err = toAppError(e);
      result[resource] = `error: ${err.code}`;
      if (resource === "compliance") {
        complianceFailedAt.set(eid, Date.now());
        if (err.code === "ZOHO_BAD_REQUEST" || err.code === "ZOHO_NOT_FOUND") complianceUnavailableAt.set(eid, Date.now());
      }
      if (runId) {
        await db().from("sync_runs").update({ status: "failed", error: `${err.code}: ${err.message}`.slice(0, 500), finished_at: nowIso() })
          .eq("id", runId);
      }
      log("warn", "sync.failed", { enterprise_id: eid, resource, code: err.code });
      if (err.code === "ZOHO_NOT_CONNECTED" || err.code === "ZOHO_TOKEN_REFRESH_FAILED") break;
    }
  }
  await recordAudit({ enterpriseId: eid, adminId, category: "sync", action: "sync.run", params: result });
  return result;
}
