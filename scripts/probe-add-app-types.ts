// Probe each app_type value against POST /apps to find the one Zoho accepts
// for Apple built-in system apps (Calculator, Messages, Safari, etc.).
//
// Dev guide only documents 1=Free Store, 2=Paid Store, 3=Enterprise. The Zoho
// console shows an "Apple System App" option though — so there's likely a 4
// (or 5, 6…) the public API also supports.
//
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env \
//     scripts/probe-add-app-types.ts <enterpriseId>
import { getAppDetail, listApps } from "../backend/zoho/api.ts";
import { zohoRequest } from "../backend/zoho/client.ts";
import { toAppError } from "../backend/lib/errors.ts";

const [eid] = Deno.args;
if (!eid) { console.error("usage: probe-add-app-types.ts <enterpriseId>"); Deno.exit(2); }

const apps = (await listApps(eid)) as { app_id: string | number; platform_type?: number | string }[];
const ios = apps.filter((a) => Number(a.platform_type) === 1);
if (!ios.length) { console.error("No iOS apps to borrow category_id from"); Deno.exit(1); }
const detail = await getAppDetail(eid, ios[0].app_id) as { app_category_id?: string | number };
const categoryId = detail.app_category_id;
if (!categoryId) { console.error("Could not resolve category_id"); Deno.exit(1); }
console.log(`Using category_id=${categoryId}\n`);

const section = (t: string) => console.log(`\n────────────────────────── ${t} ──────────────────────────`);

type Result = { label: string; ok: boolean; message: string; appId?: string };
const results: Result[] = [];

async function tryIt(label: string, body: Record<string, unknown>): Promise<void> {
  section(label);
  console.log("body:", JSON.stringify(body, null, 2));
  try {
    const resp = await zohoRequest<Record<string, unknown>>(eid, { method: "POST", path: "/apps", body });
    const id = String(resp.app_id ?? "");
    console.log(`✅ accepted · app_id=${id}`);
    console.log("  full response:", JSON.stringify(resp).slice(0, 400));
    results.push({ label, ok: true, message: `app_id=${id}`, appId: id });
  } catch (e) {
    const err = toAppError(e);
    console.log(`❌ ${err.code}: ${err.message}`);
    results.push({ label, ok: false, message: `${err.code}: ${err.message}` });
  }
}

const baseBody = (extra: Record<string, unknown>) => ({
  app_name: "Calculator",
  platform_type: 1,
  bundle_identifier: "com.apple.calculator",
  app_category_id: categoryId,
  supported_devices: 3,
  app_store_country_code: "US",
  ...extra,
});

// Dev-guide-documented types
await tryIt("app_type=1 Free Store App", baseBody({ app_type: 1 }));
await tryIt("app_type=2 Paid Store App", baseBody({ app_type: 2 }));
await tryIt("app_type=3 Enterprise App (no app_file)", baseBody({ app_type: 3 }));

// Experimental — Zoho console shows an "Apple System App" radio button
await tryIt("app_type=4 (experimental)", baseBody({ app_type: 4 }));
await tryIt("app_type=5 (experimental)", baseBody({ app_type: 5 }));
await tryIt("app_type=6 (experimental)", baseBody({ app_type: 6 }));

// Alternative: with an is_system_app flag
await tryIt("app_type=1 + is_system_app=true", baseBody({ app_type: 1, is_system_app: true }));

// Alternative: hyphen vs dot in bundle, and shorter known bundles Zoho might recognize
await tryIt("app_type=1 bundle=com.apple.mobilesafari", { ...baseBody({ app_type: 1 }), bundle_identifier: "com.apple.mobilesafari" });

section("Matrix");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"}  ${r.label.padEnd(50)} ${r.message}`);

const winner = results.find((r) => r.ok);
if (winner) {
  console.log(`\n🎯 Winning body: ${winner.label}. Use this app_type going forward.`);
}
