// Probe which ID field applockpolicy actually wants in allowed_apps[].app_id.
// Try: Zoho's internal app_id, Apple's store_id (iTunes ID), and release_label_id.
import { addPayload, createProfile, deleteProfiles } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";
const [eid] = Deno.args;
if (!eid) { console.error("usage: probe-applock-id-field.ts <enterpriseId>"); Deno.exit(2); }

const candidates = [
  { label: "Zoho app_id (18-digit)",      id: "247008000000154357" },
  { label: "Apple store_id (iTunes)",     id: "284815942" },
  { label: "release_label_id Stable",     id: "247008000000124016" },
];

type R = { label: string; ok: boolean; message: string };
const results: R[] = [];

for (const c of candidates) {
  const name = `probe-${c.label.replace(/\s+/g, "-")}-${Date.now()}`;
  console.log(`\n── trying ${c.label} (${c.id}) ──`);
  let zid: string | null = null;
  try {
    const created = await createProfile(eid, { name, description: "probe", platformType: 1, scope: 0 });
    zid = String((created as { profile_id?: string | number }).profile_id ?? "");
    const allowed = `[{"app_id":${c.id},"group_display_name":"Google"}]`;
    const r = await addPayload(eid, zid, "applockpolicy", {
      kiosk_mode: 1,
      allowed_apps: allowed,
      disable_auto_lock: true,
    });
    console.log("✅ accepted:", JSON.stringify(r).slice(0, 200));
    results.push({ label: c.label, ok: true, message: "accepted" });
  } catch (e) {
    const err = toAppError(e);
    console.log(`❌ ${err.code}: ${err.message}`);
    results.push({ label: c.label, ok: false, message: `${err.code}: ${err.message}` });
  } finally {
    if (zid) { try { await deleteProfiles(eid, [zid]); } catch { /* ignore */ } }
  }
}

console.log("\n── matrix ──");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"}  ${r.label.padEnd(32)} ${r.message}`);
const winner = results.find((r) => r.ok);
if (winner) console.log(`\n🎯 Use ${winner.label} as applockpolicy.allowed_apps[].app_id`);
