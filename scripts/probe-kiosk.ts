// Probe both Android and iOS kiosk payloads end-to-end against live Zoho.
//
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/probe-kiosk.ts <enterpriseId>
//
// For Android: creates androidkioskpolicy with a manually-entered package name
// (bundle only, no Zoho app_id needed). Zoho's Android kiosk evaluates by IDENTIFIER.
//
// For iOS: creates applockpolicy with a Zoho-registered app_id from the repo.
// Skips iOS if the only app in the repo is ME MDM Self Service (which Zoho forbids).
import { addPayload, createProfile, deleteProfiles, getAppDetail, getAppLabelDetail, listApps } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";

const [eid] = Deno.args;
if (!eid) {
  console.error("usage: probe-kiosk.ts <enterpriseId>");
  Deno.exit(2);
}

const section = (t: string) => console.log(`\n────────────────────────── ${t} ──────────────────────────`);

type Result = { platform: string; shape: string; ok: boolean; message: string };
const results: Result[] = [];

async function tryPayload(platform: 1 | 2, payloadName: string, body: Record<string, unknown>): Promise<void> {
  const label = `${platform === 1 ? "iOS" : "Android"} · ${payloadName}`;
  section(label);
  const name = `mdm-probe-kiosk-${platform === 1 ? "ios" : "android"}-${Date.now()}`;
  let zid: string | null = null;
  try {
    const created = await createProfile(eid, { name, description: "probe", platformType: platform, scope: 0 });
    zid = String((created as { profile_id?: string | number }).profile_id ?? "");
    console.log(`profile_id=${zid}`);
    console.log("body:", JSON.stringify(body, null, 2));
    const resp = await addPayload(eid, zid, payloadName, body);
    console.log("✅ accepted:", JSON.stringify(resp).slice(0, 300));
    results.push({ platform: label, shape: "guide shape", ok: true, message: "accepted" });
  } catch (e) {
    const err = toAppError(e);
    const detail = err.details ? ` · ${JSON.stringify(err.details).slice(0, 250)}` : "";
    console.log(`❌ ${err.code}: ${err.message}${detail}`);
    results.push({ platform: label, shape: "guide shape", ok: false, message: `${err.code}: ${err.message}` });
  } finally {
    if (zid) {
      try { await deleteProfiles(eid, [zid]); } catch { /* cleanup errors are OK — first DELETE moves to trash */ }
    }
  }
}

// ───────────────────────────────── Android kiosk ─────────────────────────────────
// Mirrors backend/zoho/payloads.ts::buildKioskPayload: allowed_apps is a JSON STRING
// of an OBJECT keyed by appId. UPPERCASE fields. No Zoho app_id needed — Android kiosk
// uses IDENTIFIER (package name) as the real match.
// Guide sample uses a numeric string key (resembles a Zoho app_id). Try that
// instead of the "manual-<ts>" shape — Zoho's parser may reject non-numeric keys.
const androidAppId = String(Date.now()); // just digits
const androidAllowed = {
  [androidAppId]: {
    SHOW_APP_ICON: true,
    APP_GROUP_ID: androidAppId,
    GROUP_DISPLAY_NAME: "Chrome",
    IDENTIFIER: "com.android.chrome",
    APP_TYPE: 1,
    DISPLAY_IMAGE_LOC: "",
  },
};
await tryPayload(2, "androidkioskpolicy", {
  kiosk_mode: 0,
  allowed_apps: JSON.stringify(androidAllowed),
  launcher_type: 2,
});

// Guide uses the uppercase form `ANDROID_KIOSK_POLICY`. Try both to see which Zoho actually accepts.
await tryPayload(2, "ANDROID_KIOSK_POLICY", {
  kiosk_mode: 0,
  allowed_apps: JSON.stringify(androidAllowed),
  launcher_type: 2,
});

// Also try sending allowed_apps as a plain object, not stringified.
await tryPayload(2, "androidkioskpolicy", {
  kiosk_mode: 0,
  allowed_apps: androidAllowed, // not stringified
  launcher_type: 2,
});

// ───────────────────────────────── iOS kiosk ─────────────────────────────────
section("Find iOS app for kiosk probe");
const apps = (await listApps(eid)) as { app_id: string | number; app_name?: string; platform_type?: number | string }[];
const iosApps = apps.filter((a) => Number(a.platform_type) === 1);
console.log(`iOS apps in repo: ${iosApps.length}`);
for (const a of iosApps) console.log(`  app_id=${a.app_id}  ${a.app_name ?? "(no name)"}`);

const mdmIds = new Set(["247008000000147028"]); // the ME MDM Self Service app Zoho seeds
const kioskable = iosApps.find((a) => !mdmIds.has(String(a.app_id)));
if (!kioskable) {
  console.log("⚠️  Only the ME MDM app is in the repo. Zoho blocks kiosking its own agent.");
  console.log("    Upload any App Store app (e.g. com.google.chrome.ios) via ME MDM console → App Repository → Add App → Apple.");
  console.log("    Skipping iOS kiosk probe.");
  results.push({ platform: "iOS · applockpolicy", shape: "guide shape", ok: false, message: "no non-MDM iOS app in Zoho repo" });
} else {
  // applockpolicy wants app_group_id (from label-level endpoint), NOT the top-level app_id.
  // See 32c5794 and [[zoho-guide-vs-reality-field-gaps]].
  console.log(`Resolving app_group_id for ${kioskable.app_name ?? kioskable.app_id}…`);
  const detail = await getAppDetail(eid, kioskable.app_id) as { release_labels?: { release_label_id?: string | number }[] };
  const rl = detail.release_labels?.[0]?.release_label_id;
  if (!rl) { console.warn("No release_labels. Skipping iOS kiosk probe."); Deno.exit(1); }
  const labelDetail = await getAppLabelDetail(eid, kioskable.app_id, rl) as { app_group_id?: string | number };
  const appGroupId = labelDetail.app_group_id;
  if (!appGroupId) { console.warn("No app_group_id. Skipping iOS kiosk probe."); Deno.exit(1); }
  console.log(`  app_id=${kioskable.app_id}  →  app_group_id=${appGroupId}`);
  const allowedApps = `[{"app_id":${appGroupId},"group_display_name":${JSON.stringify(kioskable.app_name ?? "probe")}}]`;
  await tryPayload(1, "applockpolicy", {
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
  });
}

section("Result matrix");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"}  ${r.platform.padEnd(28)} ${r.message}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} failed.` : "\nAll kiosk payloads accepted by Zoho.");
Deno.exit(bad.length ? 1 : 0);
