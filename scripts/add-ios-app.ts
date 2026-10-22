// Adds an iOS Free Store App to the Zoho app repo so it becomes kiosk-eligible.
//
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env \
//     scripts/add-ios-app.ts <enterpriseId> <bundleId> <appName>
//
// Finds a reusable category_id + release_label_id by inspecting the ME MDM app
// (which every tenant has), then POSTs /apps.
import { getAppDetail, listApps } from "../backend/zoho/api.ts";
import { zohoRequest } from "../backend/zoho/client.ts";
import { toAppError } from "../backend/lib/errors.ts";

const [eid, bundleId, appNameArg] = Deno.args;
if (!eid || !bundleId) {
  console.error("usage: add-ios-app.ts <enterpriseId> <bundleId> [appName]");
  Deno.exit(2);
}
const appName = appNameArg || bundleId;

const section = (t: string) => console.log(`\n────────────────────────── ${t} ──────────────────────────`);

// Discover category_id + release_label_id by borrowing them from an existing app.
section("Discover category_id + release_label_id from existing apps");
const apps = await listApps(eid) as { app_id: string | number; app_name?: string; platform_type?: number | string }[];
const ios = apps.filter((a) => Number(a.platform_type) === 1);
if (!ios.length) {
  console.error("No iOS apps in repo to borrow from — can't auto-discover category/release-label.");
  Deno.exit(1);
}
console.log(`Looking at ${ios[0].app_name ?? ios[0].app_id} to borrow ids…`);
const detail = await getAppDetail(eid, ios[0].app_id) as {
  app_category_id?: string | number;
  release_labels?: { release_label_id?: string | number }[];
};
const categoryId = detail.app_category_id;
const releaseLabelId = detail.release_labels?.[0]?.release_label_id;
console.log(`category_id=${categoryId}  release_label_id=${releaseLabelId}`);
if (!categoryId || !releaseLabelId) {
  console.error("Could not resolve category_id or release_label_id.");
  Deno.exit(1);
}

section(`POST /apps  —  ${appName}  (${bundleId})`);
// Guide lists release_label_id as required but the live API rejects it
// ("Invalid parameter release_label_id detected"). Omit — Zoho picks a default
// release label for Free Store apps. [[zoho-guide-vs-reality-field-gaps]]
void releaseLabelId;
// Guide shows the GET /apps response has `store_id` (Apple's iTunes ID). The
// third arg of this script accepts it as `appName|storeId` so we can test both.
const parts = appName.split("|");
const name = parts[0];
const storeId = parts[1];
const body: Record<string, unknown> = {
  app_name: name,
  app_type: 1,
  platform_type: 1,
  bundle_identifier: bundleId,
  app_category_id: categoryId,
  supported_devices: 3,
  app_store_country_code: "US",
};
if (storeId) body.store_id = storeId;
console.log("body:", JSON.stringify(body, null, 2));
try {
  const resp = await zohoRequest(eid, { method: "POST", path: "/apps", body });
  console.log("✅ added:", JSON.stringify(resp, null, 2));
} catch (e) {
  const err = toAppError(e);
  console.error(`❌ ${err.code}: ${err.message}`, err.details ? `\n   details: ${JSON.stringify(err.details).slice(0, 500)}` : "");
  Deno.exit(1);
}
