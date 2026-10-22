// List iOS apps in the Zoho repo for the given enterprise.
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/list-ios-apps.ts <enterpriseId>
import { listApps } from "../backend/zoho/api.ts";

const [eid] = Deno.args;
if (!eid) { console.error("usage: list-ios-apps.ts <enterpriseId>"); Deno.exit(2); }

const apps = (await listApps(eid)) as { app_id: string | number; app_name?: string; platform_type?: number | string; bundle_identifier?: string }[];
const ios = apps.filter((a) => Number(a.platform_type) === 1);
console.log(`${ios.length} iOS app(s) in repo:`);
for (const a of ios) console.log(`  app_id=${a.app_id}  ·  ${a.app_name ?? "?"}  ·  bundle=${a.bundle_identifier ?? "?"}`);
