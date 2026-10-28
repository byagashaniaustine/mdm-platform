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
  buildIosEmailPayload,
  buildIosKioskPayload,
  buildIosLockscreenMessagePayload,
  buildIosPasscodePayload,
  buildIosProxyPayload,
  buildIosVpnPayload,
  buildIosWebFilterPayload,
  buildIosWifiPayload,
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

export const PURPOSES: Purpose[] = [
  "restrictions",
  "kiosk",
  "passcode",
  "frp",
  "wifi",
  "webfilter",
  "vpn",
  "email",
  "proxy",
  "lockscreen_message",
  "custom",
];

export function profileCatalog() {
  return {
    purposes: [
      { id: "restrictions", label: "Restrictions", platforms: ["android", "ios"] },
      { id: "kiosk", label: "Kiosk mode", platforms: ["android", "ios"] },
      { id: "passcode", label: "Passcode + wipe after failed attempts", platforms: ["android", "ios"] },
      { id: "frp", label: "Factory Reset Protection accounts", platforms: ["android"] },
      { id: "lockscreen_message", label: "Lock-screen message (iOS supervised)", platforms: ["ios"] },
      // iOS Wi-Fi, Web content filter, VPN, Email, Proxy are temporarily hidden from
      // the UI: the builders I wrote had wrong Zoho field names (singleappmodepolicy,
      // bundle_identifier, EmailType*, filter_type strings, etc.) and the guide shows
      // completely different shapes. Rewriting each one properly needs a per-payload
      // audit. In the meantime admins can use `custom` with the exact JSON from
      // MDM_Dev_Guide.pdf for these payload types.
      { id: "custom", label: "Custom payload (raw JSON from the guide)", platforms: ["android", "ios"] },
    ],
    restrictions: ANDROID_RESTRICTIONS,
    ios: { restrictions: IOS_RESTRICTIONS, autoLockMinutes: IOS_AUTO_LOCK_MINUTES },
  };
}

/** Turn the dashboard form into { payloadName: body }. */
export function buildPayload(platform: "android" | "ios", purpose: Purpose, config: Record<string, unknown>) {
  const IOS_ALLOWED = ["restrictions", "passcode", "kiosk", "wifi", "webfilter", "vpn", "email", "proxy", "lockscreen_message", "custom"];
  if (platform === "ios" && !IOS_ALLOWED.includes(purpose)) {
    fail("VALIDATION_FAILED", `For Apple devices choose one of: ${IOS_ALLOWED.join(", ")}`);
  }
  if (platform === "ios" && purpose === "kiosk") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosKioskPayload({
        mode: config.mode === "multi" ? "multi" : "single",
        apps: (config.apps ?? []) as { appId: string | number; isSystemApp?: boolean; displayName?: string }[],
        disableTouch: config.disableTouch as boolean | undefined,
        disableDeviceRotation: config.disableDeviceRotation as boolean | undefined,
        disableVolumeButtons: config.disableVolumeButtons as boolean | undefined,
        disableRingerSwitch: config.disableRingerSwitch as boolean | undefined,
        disableSleepButton: (config.disableSleepButton ?? config.disableSleepWakeButton) as boolean | undefined,
        disableAutoLock: config.disableAutoLock as boolean | undefined,
        voiceOver: (config.voiceOver ?? config.enableVoiceOver) as boolean | undefined,
        zoom: (config.zoom ?? config.enableZoom) as boolean | undefined,
        invertColors: (config.invertColors ?? config.enableInvertColors) as boolean | undefined,
        asstTouch: (config.asstTouch ?? config.enableAssistiveTouch) as boolean | undefined,
        enableSpeakSelection: config.enableSpeakSelection as boolean | undefined,
        enableMonoAudio: config.enableMonoAudio as boolean | undefined,
      }),
    };
  }
  if (platform === "ios" && purpose === "wifi") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosWifiPayload({
        ssid: config.ssid as string,
        encryption: config.encryption as "WEP" | "WPA" | "WPA2" | "Any" | "None" | undefined,
        password: config.password as string | undefined,
        hiddenNetwork: config.hiddenNetwork as boolean | undefined,
        autoJoin: config.autoJoin as boolean | undefined,
        proxyType: config.proxyType as "None" | "Manual" | "Auto" | undefined,
        proxyServer: config.proxyServer as string | undefined,
        proxyPort: config.proxyPort as number | undefined,
        proxyUser: config.proxyUser as string | undefined,
        proxyPassword: config.proxyPassword as string | undefined,
      }),
    };
  }
  if (platform === "ios" && purpose === "webfilter") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosWebFilterPayload({
        mode: config.mode === "allow-only" ? "allow-only" : "limit-adult",
        allowedUrls: config.allowedUrls as { title: string; url: string }[] | undefined,
        permittedUrls: config.permittedUrls as string[] | undefined,
        blacklistedUrls: config.blacklistedUrls as string[] | undefined,
      }),
    };
  }
  if (platform === "ios" && purpose === "vpn") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosVpnPayload({
        connectionName: config.connectionName as string,
        type: config.type as "L2TP" | "PPTP" | "IPSec" | "IKEv2" | "AlwaysOn" | undefined,
        server: config.server as string,
        account: config.account as string | undefined,
        password: config.password as string | undefined,
        sharedSecret: config.sharedSecret as string | undefined,
        authentication: config.authentication as "Password" | "RSA" | "Certificate" | undefined,
        sendAllTraffic: config.sendAllTraffic as boolean | undefined,
        disconnectOnIdle: config.disconnectOnIdle as boolean | undefined,
        proxyServer: config.proxyServer as string | undefined,
        proxyPort: config.proxyPort as number | undefined,
      }),
    };
  }
  if (platform === "ios" && purpose === "email") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosEmailPayload({
        accountDescription: config.accountDescription as string,
        accountType: config.accountType as "IMAP" | "POP" | undefined,
        userDisplayName: config.userDisplayName as string | undefined,
        emailAddress: config.emailAddress as string,
        incomingMailServer: config.incomingMailServer as string,
        incomingMailPort: config.incomingMailPort as number | undefined,
        incomingUseSsl: config.incomingUseSsl as boolean | undefined,
        incomingAuthentication: config.incomingAuthentication as "Password" | "None" | undefined,
        incomingUsername: config.incomingUsername as string | undefined,
        outgoingMailServer: config.outgoingMailServer as string,
        outgoingMailPort: config.outgoingMailPort as number | undefined,
        outgoingUseSsl: config.outgoingUseSsl as boolean | undefined,
        outgoingAuthentication: config.outgoingAuthentication as "Password" | "None" | undefined,
        outgoingUsername: config.outgoingUsername as string | undefined,
        preventMove: config.preventMove as boolean | undefined,
        preventAppSheet: config.preventAppSheet as boolean | undefined,
        disableMailDrop: config.disableMailDrop as boolean | undefined,
      }),
    };
  }
  if (platform === "ios" && purpose === "proxy") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosProxyPayload({
        proxyType: config.proxyType === "auto" ? "auto" : "manual",
        server: config.server as string | undefined,
        port: config.port as number | undefined,
        username: config.username as string | undefined,
        password: config.password as string | undefined,
        pacUrl: config.pacUrl as string | undefined,
        allowBypass: config.allowBypass as boolean | undefined,
      }),
    };
  }
  if (platform === "ios" && purpose === "lockscreen_message") {
    return {
      name: payloadNameFor(platform, purpose)!,
      body: buildIosLockscreenMessagePayload({
        bgColour: String(config.bgColour ?? "#1F3A5F"),
        orientation: config.orientation as 1 | 2 | undefined,
        messages: (config.messages ?? []) as { message: string; textColour: string; offsetPosition?: number }[],
      }),
    };
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

/**
 * Create a profile. Zoho-first invariant: we call Zoho to create the shell and
 * add the payload BEFORE touching our DB. The `profiles` row only gets inserted
 * once Zoho has confirmed everything. If Zoho rejects anything, we clean up the
 * Zoho shell (if we just created it) and no local row ever exists — our DB
 * stays an accurate mirror of Zoho's state.
 */
/**
 * Both `applockpolicy` (iOS kiosk) and `androidkioskpolicy` want `app_group_id`
 * from the per-release endpoint, NOT the `app_id` returned by `GET /apps`. The
 * frontend picker only knows the top-level app_id, so we translate here. For
 * each picked app:
 *   1. GET /apps/{app_id}             → read release_labels[0].release_label_id
 *   2. GET /apps/{app_id}/labels/{rl} → read app_group_id
 * Then feed app_group_id to the kiosk payload builder as `appId`.
 */
async function resolveKioskAppIds(eid: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apps = (config.apps ?? []) as { appId: string | number; displayName?: string; isSystemApp?: boolean }[];
  if (!apps.length) return config;
  const resolved = await Promise.all(apps.map(async (a) => {
    // Frontend emits synthetic ids like "installed-com.foo" / "common-com.foo" / "manual-…"
    // for apps that aren't in Zoho's repo. Those can't become a Zoho app_group_id.
    if (typeof a.appId === "string" && /^(installed|common|manual)-/.test(a.appId)) {
      fail("VALIDATION_FAILED", `App "${a.appId}" is not in Zoho's app repo. Upload it in the ME MDM console (Device Mgmt → Apps) and pick it from the repo list.`);
    }
    const detail = await zoho.getAppDetail(eid, a.appId) as { release_labels?: { release_label_id?: string | number }[] };
    const releaseLabelId = detail.release_labels?.[0]?.release_label_id;
    if (!releaseLabelId) fail("ZOHO_BAD_REQUEST", `App ${a.appId} has no release labels — approve it in the Zoho console first.`);
    const labelDetail = await zoho.getAppLabelDetail(eid, a.appId, releaseLabelId) as { app_group_id?: string | number };
    const appGroupId = labelDetail.app_group_id;
    if (!appGroupId) fail("ZOHO_BAD_REQUEST", `Zoho did not return an app_group_id for ${a.appId}; the kiosk payload requires it.`);
    return { ...a, appId: String(appGroupId) };
  }));
  return { ...config, apps: resolved };
}

export async function createProfile(s: Session, input: {
  name: string;
  description: string;
  platform: "android" | "ios";
  purpose: Purpose;
  config: Record<string, unknown>;
}, _idem: string | null) {
  // Resolve kiosk apps' app_group_id BEFORE building the payload (iOS and Android both need it).
  const config = input.purpose === "kiosk"
    ? await resolveKioskAppIds(s.enterpriseId, input.config)
    : input.config;
  const payload = buildPayload(input.platform, input.purpose, config);

  // --- Zoho side ---
  // Reuse an existing Zoho profile with the same name if one is sitting there from
  // a prior failed attempt — avoids 409 Resource Already Exists.
  const existing = (await zoho.listProfiles(s.enterpriseId)).find((x) => x.profile_name === input.name);
  let zid: string;
  let shellJustCreated = false;
  if (existing?.profile_id) {
    zid = String(existing.profile_id);
  } else {
    try {
      const created = await zoho.createProfile(s.enterpriseId, {
        name: input.name,
        description: input.description ?? "",
        platformType: input.platform === "ios" ? 1 : 2,
        scope: 0,
      });
      const rawZid = (created as { profile_id?: string | number }).profile_id;
      if (!rawZid) fail("ZOHO_BAD_REQUEST", "Zoho did not return a profile_id");
      zid = String(rawZid);
      shellJustCreated = true;
    } catch (e) {
      // Zoho's listProfiles doesn't surface trashed profiles, but Zoho's name-
      // uniqueness check does — so a prior failed attempt or a manually-trashed
      // profile with the same name causes 409 "Resource Already Exists" that
      // we can't adopt. Give a clearer error so the admin knows what to do.
      const err = String((e as { message?: string }).message ?? e);
      if (/already exists/i.test(err)) {
        fail("CONFLICT", `A Zoho profile named "${input.name}" already exists (likely in Zoho's Trash). Pick a different name, or empty the Trash in the ME MDM console under Device Mgmt → Profiles → Trash.`);
      }
      throw e;
    }
  }

  try {
    await zoho.addPayload(s.enterpriseId, zid, payload.name, payload.body);
  } catch (err) {
    // Payload rejected. If we just created the Zoho shell for this call, delete
    // it so Zoho doesn't accumulate empty shells. If we adopted an existing
    // shell, leave it alone — it was there before us.
    if (shellJustCreated) {
      await zoho.deleteProfiles(s.enterpriseId, [zid]).catch(() => {});
    }
    throw err;
  }

  // --- DB side (mirror Zoho's confirmed state) ---
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
      zoho_profile_id: zid,
      created_by: s.adminId,
      last_synced_at: new Date().toISOString(),
    }).select("id").single(),
  );
  return { profileId: row.id, event: null as unknown };
}

/** Add another policy to an existing profile (e.g. passcode + restrictions together). */
export async function addPolicy(s: Session, profileId: string, purpose: Purpose, config: Record<string, unknown>, idem: string | null) {
  const p = await getProfile(s.enterpriseId, profileId);
  if (p.state === "deleted") fail("CONFLICT", "Profile is deleted");
  // Translate kiosk's app_id → app_group_id before validation (iOS and Android both need it).
  const resolved = purpose === "kiosk"
    ? await resolveKioskAppIds(s.enterpriseId, config)
    : config;
  let payload;
  try {
    payload = buildPayload(p.platform, purpose, resolved);
  } catch (e) {
    const { log } = await import("../lib/log.ts");
    log("warn", "profile.add_policy_validation_failed", { profile_id: profileId, purpose, config: resolved, error: String(e) });
    throw e;
  }
  // Zoho first — require the profile to actually exist in Zoho (created via createProfile) and
  // make the payload-add stick there before mirroring to our DB.
  const zid = requireZohoId(p.zoho_profile_id, `Profile "${p.name}"`);
  await zoho.addPayload(s.enterpriseId, zid, payload.name, payload.body);
  await run(
    db().from("profiles").update({
      payload_names: [...new Set([...p.payload_names, payload.name])],
      payload_config: { ...p.payload_config, [payload.name]: payload.body },
      state: p.state === "published" ? "modified" : p.state,
      last_synced_at: new Date().toISOString(),
    }).eq("id", p.id),
  );
  return { profileId: p.id, event: null };
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
  // Always look for an existing Zoho profile with this name BEFORE creating. A
  // previous failed attempt (payload-add rejected after the shell was created)
  // leaves the shell behind — recreating same-name hits Zoho's 409
  // "Resource Already Exists". Was `attempts > 1`; now always.
  const existing = (await zoho.listProfiles(eid)).find((x) => x.profile_name === p.name);
  if (existing?.profile_id) {
    const zid = String(existing.profile_id);
    await run(db().from("profiles").update({ zoho_profile_id: zid }).eq("id", p.id));
    return zid;
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
    const zpid = String(p.zoho_profile_id);

    // iOS lock-screen message rewrites the device wallpaper. Apple's MDM has no
    // "restore previous wallpaper" primitive, so plain removal leaves the branded
    // banner stuck as the lock-screen until the user manually picks a new one.
    // Before deleting, overwrite the payload with a neutral black wallpaper +
    // blank text and re-publish, so the device transitions to a plain black lock
    // screen on next check-in. Then the delete runs and nothing proprietary
    // lingers.
    if (p.purpose === "lockscreen_message" && (p.payload_names ?? []).includes("ioslockscreenmessage")) {
      try {
        await zoho.addPayload(ev.enterprise_id, zpid, "ioslockscreenmessage", {
          wallpaper_type: 1,
          bg_colour: "#000000",
          orientation: 1,
          // Single invisible glyph so Zoho's "message required" check passes
          // while the device shows effectively no text on a black background.
          messages: [{ message: " ", text_colour: "#000000", offset_position: 50 }],
        });
        await zoho.publishProfile(ev.enterprise_id, zpid);
        const { log } = await import("../lib/log.ts");
        log("info", "profile.delete_wallpaper_reset", { enterprise_id: ev.enterprise_id, profile_id: p.id, zoho_profile_id: zpid });
        // Give iOS a few seconds to pick up the new wallpaper via APNs before
        // we yank the profile out from under it. 10s is a compromise between
        // deletion latency and leaving enough window for the device to see the
        // push. Devices offline during this window still show the neutral
        // wallpaper on next check-in.
        await new Promise((r) => setTimeout(r, 10_000));
      } catch (e) {
        // Best-effort — if Zoho rejects the neutral payload or publish fails
        // we still proceed with delete. The warning stays on the create form.
        const { log } = await import("../lib/log.ts");
        log("warn", "profile.delete_wallpaper_reset_failed", { enterprise_id: ev.enterprise_id, profile_id: p.id, error: String(e) });
      }
    }

    // Disassociate from EVERY Zoho group that still has this profile — not just
    // the ones our local DB knows about. Our profile_groups mirror can be
    // stale (sync lag, or a profile pushed outside the group model) and if we
    // only disassociate from DB-known groups, devices keep showing the profile
    // because Zoho never pushes a RemoveProfile command for the ones we missed.
    // Scanning all groups costs N listGroupProfiles calls but makes delete
    // actually take effect on the device.
    try {
      const groups = (await zoho.listGroups(ev.enterprise_id)) as { group_id?: string | number }[];
      for (const g of groups) {
        if (!g.group_id) continue;
        const zgid = String(g.group_id);
        try {
          const resp = await zoho.listGroupProfiles(ev.enterprise_id, zgid);
          const list = Array.isArray(resp) ? resp : (resp as { profiles?: { profile_id?: string | number }[] } | null)?.profiles ?? [];
          const hasIt = list.some((x) => String((x as { profile_id?: string | number }).profile_id ?? "") === zpid);
          if (hasIt) {
            await zoho.disassociateProfilesFromGroup(ev.enterprise_id, zgid, [zpid]).catch(() => {});
          }
        } catch {
          // listGroupProfiles isn't documented; some tenants return 404/400.
          // Best-effort: fall through to deleteProfiles. iOS still removes the
          // profile when it detects the parent profile is gone on next check-in.
        }
      }
    } catch (e) {
      const { log } = await import("../lib/log.ts");
      log("warn", "profile.delete_group_sweep_failed", { enterprise_id: ev.enterprise_id, profile_id: p.id, error: String(e) });
    }
    try {
      await zoho.deleteProfiles(ev.enterprise_id, [zpid]);
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
