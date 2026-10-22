// Dump everything Zoho knows about a given iOS app so we can see which ID field
// applockpolicy actually wants.
//
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/inspect-ios-app.ts <enterpriseId> <appId>
import { getAppDetail } from "../backend/zoho/api.ts";

const [eid, appId] = Deno.args;
if (!eid || !appId) { console.error("usage: inspect-ios-app.ts <eid> <appId>"); Deno.exit(2); }

const detail = await getAppDetail(eid, appId);
console.log(JSON.stringify(detail, null, 2));
