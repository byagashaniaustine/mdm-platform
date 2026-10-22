// Probe iOS kiosk end-to-end against the live Zoho API.
// Follows MDM_Dev_Guide.pdf line 14237 (APPLOCK_POLICY).
//
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env \
//     scripts/probe-ios-kiosk.ts <enterpriseId> <zohoAppId> [displayName]
//
// What it does:
//   1. Lists iOS apps in the Zoho repo so you can confirm the app_id you pass in.
//   2. Creates a throwaway iOS profile named "mdm-probe-kiosk-<timestamp>".
//   3. Adds an applockpolicy payload with kiosk_mode=1 and the given app.
//   4. Prints exactly what Zoho returned at each step.
//   5. Soft-cleans by moving the profile to trash so you don't leave junk.
//
// If a step fails, the Zoho error body is printed verbatim — that's the
// authoritative truth about what the API accepts right now.
import { listApps, createProfile, addPayload, deleteProfiles } from "../backend/zoho/api.ts";

const [eid, appIdArg, displayNameArg] = Deno.args;
if (!eid || !appIdArg) {
  console.error("usage: probe-ios-kiosk.ts <enterpriseId> <zohoAppId> [displayName]");
  Deno.exit(2);
}
const appId = appIdArg.trim();
if (!/^\d+$/.test(appId)) {
  console.error(`appId must be the numeric Zoho app_id (got: ${appId}). Run with no appId to list candidates.`);
  Deno.exit(2);
}

const step = (label: string) => console.log(`\n=== ${label} ===`);

// -------------- 1. list iOS apps so admin can confirm the ID they chose ------
step("iOS apps in Zoho repo");
try {
  const apps = (await listApps(eid)) as { app_id: string | number; app_name?: string; platform_type?: number | string }[];
  const ios = apps.filter((a) => Number(a.platform_type) === 1);
  for (const a of ios) console.log(`  app_id=${a.app_id}  name=${a.app_name ?? "(no name)"}`);
  const match = ios.find((a) => String(a.app_id) === appId);
  if (!match) {
    console.warn(`\n⚠️  app_id ${appId} not found in the iOS apps list above.`);
    console.warn("    Zoho will reject kiosk unless the app exists in the repo — abort.");
    Deno.exit(1);
  }
} catch (e) {
  console.error("Failed to list apps:", e);
  Deno.exit(1);
}

const name = `mdm-probe-kiosk-${Date.now()}`;
let zohoProfileId: string | null = null;

// -------------- 2. create a bare iOS profile shell ---------------------------
step(`Create iOS profile '${name}'`);
try {
  const created = await createProfile(eid, { name, description: "probe", platformType: 1, scope: 0 });
  console.log(JSON.stringify(created, null, 2));
  const pid = (created as { profile_id?: string | number }).profile_id;
  if (!pid) throw new Error("Zoho didn't return profile_id");
  zohoProfileId = String(pid);
} catch (e) {
  console.error("createProfile failed:", e);
  Deno.exit(1);
}

// -------------- 3. attach the applockpolicy payload --------------------------
step("Add applockpolicy payload (single-app, kiosk_mode=1)");
const displayName = displayNameArg || `probe-${appId}`;
// Build allowed_apps as a JSON STRING (as per the guide samples).
// Keep the app_id digits exact — don't JSON.stringify a Number, since the id
// may exceed 2^53.
// Guide field table lists is_system_app as required, but Zoho's live API rejects
// it ("Invalid parameter is_system_app detected"). Omit it — guide-vs-reality gap.
const allowedApps = `[{"app_id":${appId},"group_display_name":${JSON.stringify(displayName)}}]`;
const body = {
  kiosk_mode: 1,
  allowed_apps: allowedApps,
  disable_auto_lock: true,
  disable_touch: false,
  disable_device_rotation: false,
  disable_volume_buttons: false,
  disable_ringer_switch: false,
  disable_sleep_button: false,
  voice_over: false,
  zoom: false,
  invert_colors: false,
  asst_touch: false,
  enable_speak_selection: false,
  enable_mono_audio: false,
};
console.log("Request body:", JSON.stringify(body, null, 2));
let payloadOk = false;
try {
  const resp = await addPayload(eid, zohoProfileId!, "applockpolicy", body);
  console.log("Zoho accepted:", JSON.stringify(resp, null, 2));
  payloadOk = true;
} catch (e) {
  console.error("addPayload applockpolicy failed:", e);
}

// -------------- 4. cleanup (first DELETE moves to trash) ---------------------
step("Cleanup — move profile to Zoho trash");
try {
  const r = await deleteProfiles(eid, [zohoProfileId!]);
  console.log("Deleted:", JSON.stringify(r, null, 2));
} catch (e) {
  console.error("Cleanup failed (profile may still be in Zoho):", e);
}

step("Result");
console.log(payloadOk ? "✅ applockpolicy payload accepted — iOS kiosk should work for this app" : "❌ applockpolicy payload rejected — see the Zoho error above");
Deno.exit(payloadOk ? 0 : 1);
