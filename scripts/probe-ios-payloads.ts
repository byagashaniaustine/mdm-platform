// Probe every iOS payload type against the live Zoho API using the exact
// shapes documented in MDM_Dev_Guide.pdf. For each payload: create a throwaway
// profile, POST the payload, log Zoho's response, then delete the profile.
//
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/probe-ios-payloads.ts <enterpriseId>
import { addPayload, createProfile, deleteProfiles, listApps } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";

const [eid] = Deno.args;
if (!eid) {
  console.error("usage: probe-ios-payloads.ts <enterpriseId>");
  Deno.exit(2);
}

const section = (t: string) => console.log(`\n────────────────────────── ${t} ──────────────────────────`);

// Find an iOS app so kiosk has something real to lock to.
section("Find an iOS app to use for kiosk probe");
const apps = (await listApps(eid)) as { app_id: string | number; app_name?: string; platform_type?: number | string }[];
const iosApp = apps.find((a) => Number(a.platform_type) === 1);
console.log(`iOS apps in repo: ${apps.filter((a) => Number(a.platform_type) === 1).length}`);
if (!iosApp) {
  console.warn("⚠️  No iOS apps found. Kiosk probe will be skipped.");
} else {
  console.log(`Using: ${iosApp.app_name ?? "(no name)"} · app_id=${iosApp.app_id}`);
}

type Probe = { name: string; payload: Record<string, unknown> };

// Each payload uses the minimum fields the guide marks "Required" (or sensible
// defaults). Field names copied verbatim from MDM_Dev_Guide.pdf.
const probes: Probe[] = [
  {
    name: "restrictionspolicy",
    payload: {
      allow_use_of_camera: true,
      allow_safari: true,
      allow_screen_capture: true,
    },
  },
  {
    name: "passcodepolicy",
    payload: {
      allow_simple_value: false,
      require_alphanumeric: false,
      min_passcode_length: 6,
      max_failed_attempts: 9,
      auto_lock_idle_for: 5,
    },
  },
  {
    name: "wifipolicy",
    payload: {
      service_set_identifier: "ProbeWiFi",
      hidden_network: false,
      auto_join: true,
      security_type: 2, // WPA/WPA2 Personal
      wifi_non_enterprise: { password: "probe-password-12" },
    },
  },
  {
    name: "webcontentfilterpolicy",
    payload: {
      // Guide lists enable_auto_filter, malicious_content_filter, url_filter_type,
      // create_bookmarks — but live API rejects malicious_content_filter. Trying
      // the minimum: just url_details.
      url_filter_type: true,
      url_details: [{ url: "https://example.com" }],
    },
  },
  {
    name: "vpnpolicy",
    payload: {
      connection_name: "ProbeVPN",
      vpn_type: 1,
      connection_type: 1, // L2TP
      send_all_nw_traffic: false,
      // Live API says it needs `server_name`. Guide shows nested l2tp JSONObject.
      l2tp: {
        server_name: "vpn.example.com",
        account_name: "probe",
        password: "probe-pw",
        user_authentication: "password",
      },
    },
  },
  {
    name: "emailpolicy",
    payload: {
      account_name: "Probe Mail",
      account_type: "EmailTypeIMAP",
      mail_address: "probe@example.com",
      incoming_server_hostname: "imap.example.com",
      incoming_server_port: 993,
      incoming_server_username: "probe",
      incoming_server_auth: "password",
      outgoing_server_hostname: "smtp.example.com",
      outgoing_server_port: 587,
      outgoing_server_username: "probe",
      outgoing_server_auth: "password",
    },
  },
  {
    name: "globalhttpproxypolicy",
    payload: {
      proxy_type: 1, // Manual
      proxy_server: "proxy.example.com",
      proxy_server_port: 8080,
    },
  },
];
if (iosApp) {
  const allowedApps = `[{"app_id":${iosApp.app_id},"group_display_name":${JSON.stringify(iosApp.app_name ?? "probe")}}]`;
  probes.push({
    name: "applockpolicy",
    payload: {
      kiosk_mode: 1,
      allowed_apps: allowedApps,
      disable_auto_lock: true,
    },
  });
}

type Result = { payload: string; ok: boolean; message: string };
const results: Result[] = [];

for (const probe of probes) {
  section(probe.name);
  const name = `mdm-probe-${probe.name}-${Date.now()}`;
  let zid: string | null = null;
  try {
    // Fresh profile per probe so each test is isolated.
    const created = await createProfile(eid, { name, description: "probe", platformType: 1, scope: 0 });
    zid = String((created as { profile_id?: string | number }).profile_id ?? "");
    if (!zid) throw new Error("Zoho didn't return profile_id");
    console.log(`profile_id=${zid}`);
    console.log(`POST /profiles/${zid}/payloads/${probe.name}`);
    console.log("body:", JSON.stringify(probe.payload, null, 2));
    const resp = await addPayload(eid, zid, probe.name, probe.payload);
    console.log("✅ Zoho accepted:", JSON.stringify(resp).slice(0, 300));
    results.push({ payload: probe.name, ok: true, message: "accepted" });
  } catch (e) {
    const err = toAppError(e);
    const detail = err.details ? ` · zoho: ${JSON.stringify(err.details).slice(0, 300)}` : "";
    console.log(`❌ ${err.code}: ${err.message}${detail}`);
    results.push({ payload: probe.name, ok: false, message: `${err.code}: ${err.message}` });
  } finally {
    if (zid) {
      try { await deleteProfiles(eid, [zid]); } catch { /* ignore cleanup errors */ }
    }
  }
}

section("Result matrix");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"}  ${r.payload.padEnd(28)} ${r.message}`);

const broken = results.filter((r) => !r.ok);
if (broken.length) {
  console.log(`\n${broken.length} iOS payload(s) rejected by live Zoho. Fix body shape per the error above.`);
  Deno.exit(1);
}
console.log("\nAll iOS payloads accepted by Zoho.");
