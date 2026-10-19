// Profiles: one purpose per profile (restrictions, kiosk, passcode/wipe, FRP, custom).
// Flow from the guide: create profile -> add payload(s) -> publish -> associate to groups.
import { db, run } from "../lib/db.ts";
import { fail, toAppError } from "../lib/errors.ts";
import * as zoho from "../zoho/api.ts";
import {
  ANDROID_RESTRICTIONS,
  type AppProfileEntry,
  type BlacklistProfileEntry,
  buildAppBlacklistPayload,
  buildAppsPayload,
  buildFrpPayload,
  buildKioskPayload,
  buildPasscodePayload,
  buildIosPasscodePayload,
  buildRestrictionsPayload,
  IOS_AUTO_LOCK_MINUTES,
  IOS_RESTRICTIONS,
  type KioskApp,
  payloadNameFor,
  type Purpose,
} from "../zoho/payloads.ts";
import type { Session } from "./auth.ts";
import { raiseIfFailed, registerExecutor, submitOperation } from "./events.ts";
import { getProfile, requireZohoId } from "./lookup.ts";

export const PURPOSES: Purpose[] = ["restrictions", "kiosk", "passcode", "frp", "custom"];

export function profileCatalog() {
  return {
    purposes: [
      { id: "restrictions", label: "Restrictions", platforms: ["android", "ios"] },
      { id: "kiosk", label: "Kiosk mode", platforms: ["android"] },
      { id: "passcode", label: "Passcode + wipe after failed attempts", platforms: ["android", "ios"] },
      { id: "frp", label: "Factory Reset Protection accounts", platforms: ["android"] },
      { id: "custom", label: "Custom payload (raw JSON from the guide)", platforms: ["android", "ios"] },
    ],
    restrictions: ANDROID_RESTRICTIONS,
    ios: { restrictions: IOS_RESTRICTIONS, autoLockMinutes: IOS_AUTO_LOCK_MINUTES },
  };
}

/** Turn the dashboard form into { payloadName: body }. */
export function buildPayload(platform: "android" | "ios", purpose: Purpose, config: Record<string, unknown>) {
  if (platform === "ios" && !["restrictions", "passcode", "custom"].includes(purpose)) {
    fail("VALIDATION_FAILED", "For Apple devices choose Restrictions, Passcode or Custom");
  }
  if (platform === "ios" && purpose === "passcode") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosPasscodePayload({
        allowSimple: config.allowSimple as boolean | undefined,
        requireAlphanumeric: config.requireAlphanumeric as boolean | undefined,
        minLength: config.minLength as number | undefined,
        minComplexChars: config.minComplexChars as number | undefined,
        autoLockMinutes: config.autoLockMinutes as number | undefined,
        maxAgeDays: config.maxAgeDays as number | undefined,
        history: config.history as number | undefined,
        gracePeriodMinutes: config.gracePeriodMinutes as number | undefined,
        maxFailedAttempts: config.maxFailedAttempts as number | undefined,
      }),
    };
  }
  switch (purpose) {
    case "restrictions":
      return { name: payloadNameFor(platform, purpose)!, body: buildRestrictionsPayload((config.restrictions ?? {}) as Record<string, unknown>, platform) };
    case "kiosk":
      return {
        name: payloadNameFor(platform, purpose)!,
        body: buildKioskPayload({
          mode: config.mode === "multi" ? "multi" : "single",
          apps: (config.apps ?? []) as KioskApp[],
          allowStatusBar: config.allowStatusBar as boolean | undefined,
          allowStatusBarExpansion: config.allowStatusBarExpansion as boolean | undefined,
          allowHomeButton: config.allowHomeButton as boolean | undefined,
          allowBackButton: config.allowBackButton as boolean | undefined,
          allowPowerButton: config.allowPowerButton as boolean | undefined,
          allowVolumeButton: config.allowVolumeButton as boolean | undefined,
          allowShutdown: config.allowShutdown as boolean | undefined,
          allowKeyGuard: config.allowKeyGuard as boolean | undefined,
          allowNotification: config.allowNotification as boolean | undefined,
          allowRecentApps: config.allowRecentApps as boolean | undefined,
          allowTaskManager: config.allowTaskManager as boolean | undefined,
          allowSystemErrorDialog: config.allowSystemErrorDialog as boolean | undefined,
          allowCustomSettings: config.allowCustomSettings as boolean | undefined,
          showMeMdmApp: config.showMeMdmApp as boolean | undefined,
          launcherType: config.launcherType as 1 | 2 | undefined,
          screenOrientation: config.screenOrientation as 1 | 2 | 3 | 4 | undefined,
          screenTimeout: config.screenTimeout as number | undefined,
          extra: (config.extra ?? {}) as Record<string, unknown>,
        }),
      };
    case "passcode":
      return {
        name: payloadNameFor(platform, purpose)!,
        body: buildPasscodePayload({
          passcodeType: config.passcodeType as number | undefined,
          minLength: config.minLength as number | undefined,
          maxFailedAttempts: config.maxFailedAttempts as number | undefined,
          autoLockSeconds: config.autoLockSeconds as number | undefined,
          maxAgeDays: config.maxAgeDays as number | undefined,
          scope: config.scope as number | undefined,
          gracePeriodMinutes: config.gracePeriodMinutes as number | undefined,
          allowFingerprint: config.allowFingerprint as number | undefined,
          allowFaceUnlock: config.allowFaceUnlock as boolean | undefined,
          allowIrisScan: config.allowIrisScan as boolean | undefined,
          allowOneLock: config.allowOneLock as boolean | undefined,
        }),
      };
    case "frp":
      return { name: payloadNameFor(platform, purpose)!, body: buildFrpPayload((config.accounts ?? []) as { emailUserId: string; email: string }[]) };
    case "custom": {
      const name = String(config.payloadName ?? "");
      if (!/^[A-Za-z_]{3,60}$/.test(name)) fail("VALIDATION_FAILED", "payloadName must be a payload name from the guide");
      const body = config.payload;
      if (!body || typeof body !== "object" || Array.isArray(body)) fail("VALIDATION_FAILED", "payload must be a JSON object");
      return { name, body: body as Record<string, unknown> };
    }
    default:
      fail("VALIDATION_FAILED", "Unknown purpose");
  }
}

export async function listProfiles(eid: string) {
  return await run(
    db().from("profiles")
      .select("id, name, description, platform, purpose, state, payload_names, zoho_profile_id, last_synced_at, updated_at, profile_groups(group_id, groups(id, name, kind))")
      .eq("enterprise_id", eid).neq("state", "deleted").order("updated_at", { ascending: false }),
  );
}

const op = (s: Session, action: string, profileId: string, params: Record<string, unknown>, idem: string | null) =>
  submitOperation({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "profile", action, profileId, params, idempotencyKey: idem })
    .then((r) => ({ ...r, event: raiseIfFailed(r.event) }));

export async function createProfile(s: Session, input: {
  name: string;
  description: string;
  platform: "android" | "ios";
  purpose: Purpose;
  config: Record<string, unknown>;
}, idem: string | null) {
  const payload = buildPayload(input.platform, input.purpose, input.config);
  const row = await run<{ id: string }>(
    db().from("profiles").insert({
      enterprise_id: s.enterpriseId,
      name: input.name,
      description: input.description || null,
      platform: input.platform,
      purpose: input.purpose,
      state: "draft",
      payload_names: [payload.name],
      payload_config: { [payload.name]: payload.body },
      created_by: s.adminId,
    }).select("id").single(),
  );
  const { event } = await op(s, "profile.create", row.id, {}, idem);
  return { profileId: row.id, event };
}

/** Add another policy to an existing profile (e.g. passcode + restrictions together). */
export async function addPolicy(s: Session, profileId: string, purpose: Purpose, config: Record<string, unknown>, idem: string | null) {
  const p = await getProfile(s.enterpriseId, profileId);
  if (p.state === "deleted") fail("CONFLICT", "Profile is deleted");
  let payload;
  try {
    payload = buildPayload(p.platform, purpose, config);
  } catch (e) {
    // Surface *what* the client sent so a VALIDATION_FAILED is debuggable from logs.
    const { log } = await import("../lib/log.ts");
    log("warn", "profile.add_policy_validation_failed", { profile_id: profileId, purpose, config, error: String(e) });
    throw e;
  }
  await run(
    db().from("profiles").update({
      payload_names: [...new Set([...p.payload_names, payload.name])],
      payload_config: { ...p.payload_config, [payload.name]: payload.body },
      state: p.state === "published" ? "modified" : p.state,
    }).eq("id", p.id),
  );
  return await op(s, "profile.add_payload", p.id, { payload_name: payload.name }, idem);
}

export const publishProfile = (s: Session, profileId: string, idem: string | null) =>
  getProfile(s.enterpriseId, profileId).then((p) => {
    // Zoho rejects it anyway ("Empty Profile cannot be published"); say so before queueing.
    if (!(p as { payload_names?: string[] | null }).payload_names?.length) {
      fail("VALIDATION_FAILED", `"${p.name}" has no policies yet. Add at least one policy before publishing.`);
    }
    return op(s, "profile.publish", profileId, {}, idem);
  });

export const deleteProfile = (s: Session, profileId: string, idem: string | null) =>
  getProfile(s.enterpriseId, profileId).then(() => op(s, "profile.delete", profileId, {}, idem));

// ------------------------------------------------------------- executors
async function ensureZohoProfile(eid: string, profileId: string, attempts: number): Promise<string> {
  const p = await getProfile(eid, profileId);
  if (p.zoho_profile_id) return p.zoho_profile_id;
  if (attempts > 1) {
    const existing = (await zoho.listProfiles(eid)).find((x) => x.profile_name === p.name);
    if (existing?.profile_id) {
      const zid = String(existing.profile_id);
      await run(db().from("profiles").update({ zoho_profile_id: zid }).eq("id", p.id));
      return zid;
    }
  }
  const created = await zoho.createProfile(eid, {
    name: p.name,
    description: p.description ?? "",
    platformType: p.platform === "ios" ? 1 : 2,
    scope: 0,
  });
  const rawZid = (created as { profile_id?: string | number }).profile_id;
  if (!rawZid) fail("ZOHO_BAD_REQUEST", "Zoho did not return a profile_id");
  const zid = String(rawZid);
  await run(db().from("profiles").update({ zoho_profile_id: zid }).eq("id", p.id));
  return zid;
}

registerExecutor("profile.create", async (ev) => {
  const zid = await ensureZohoProfile(ev.enterprise_id, ev.profile_id!, ev.attempts);
  const p = await getProfile(ev.enterprise_id, ev.profile_id!);
  const done = new Set<string>(((ev.response as { payloads_added?: string[] } | null)?.payloads_added) ?? []);
  for (const name of p.payload_names) {
    if (done.has(name)) continue;
    await zoho.addPayload(ev.enterprise_id, zid, name, p.payload_config[name] ?? {});
    done.add(name);
    // Persist progress so a retry does not add the same payload twice.
    await db().from("events").update({ response: { ...(ev.response ?? {}), payloads_added: [...done] } }).eq("id", ev.id);
  }
  await run(db().from("profiles").update({ last_synced_at: new Date().toISOString() }).eq("id", p.id));
  return { state: "succeeded", response: { zoho_profile_id: zid, payloads_added: [...done] } };
});

registerExecutor("profile.add_payload", async (ev) => {
  const p = await getProfile(ev.enterprise_id, ev.profile_id!);
  const zid = requireZohoId(p.zoho_profile_id, `Profile "${p.name}"`);
  const name = ev.params.payload_name as string;
  await zoho.addPayload(ev.enterprise_id, zid, name, p.payload_config[name] ?? {});
  return { state: "succeeded", response: { payload: name, note: "Publish the profile to apply the change" } };
});

registerExecutor("profile.publish", async (ev) => {
  const p = await getProfile(ev.enterprise_id, ev.profile_id!);
  const zid = requireZohoId(p.zoho_profile_id, `Profile "${p.name}"`);
  await zoho.publishProfile(ev.enterprise_id, zid);
  const { count } = await db().from("profile_groups").select("group_id", { count: "exact", head: true }).eq("profile_id", p.id);
  // Re-publishing creates a new version; push it to groups that already have the profile.
  if ((count ?? 0) > 0) await zoho.pushProfileUpdate(ev.enterprise_id, zid);
  await run(db().from("profiles").update({ state: "published", last_synced_at: new Date().toISOString() }).eq("id", p.id));
  return { state: "succeeded", response: { pushed_to_groups: count ?? 0 } };
});

registerExecutor("profile.delete", async (ev) => {
  const p = await getProfile(ev.enterprise_id, ev.profile_id!);
  let zohoDeleted = false;
  if (p.zoho_profile_id) {
    // Take it off its groups first so devices stop receiving it cleanly.
    const links = await run<{ groups: { zoho_group_id: string | null } | { zoho_group_id: string | null }[] | null }[]>(
      db().from("profile_groups").select("groups(zoho_group_id)").eq("profile_id", p.id),
    );
    for (const l of links) {
      for (const g of Array.isArray(l.groups) ? l.groups : l.groups ? [l.groups] : []) {
        if (g.zoho_group_id) await zoho.disassociateProfilesFromGroup(ev.enterprise_id, g.zoho_group_id, [p.zoho_profile_id]).catch(() => {});
      }
    }
    try {
      await zoho.deleteProfiles(ev.enterprise_id, [p.zoho_profile_id]);
      zohoDeleted = true;
    } catch (e) {
      const err = toAppError(e);
      // Zoho's public API refuses permanent-delete unless the profile is already
      // in Zoho's Trash — and there's no public endpoint to trash. Soft-delete
      // locally so the UI hides it immediately; the row stays `state='deleted'`
      // and syncProfiles preserves that even when Zoho still reports Published.
      if (!/COM0015|moved to trash/i.test(`${err.message} ${JSON.stringify(err.details ?? "")}`)) throw e;
    }
  }
  await run(db().from("profile_groups").delete().eq("profile_id", p.id));
  await run(db().from("profiles").update({ state: "deleted" }).eq("id", p.id));
  return {
    state: "succeeded",
    response: zohoDeleted
      ? { deleted_in_zoho: true }
      : { deleted_in_zoho: false, note: "Hidden locally. Still exists in Zoho — move to Trash in Zoho console to delete permanently." },
  };
});
