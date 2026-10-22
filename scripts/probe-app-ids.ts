// Explore every Zoho endpoint that could return an app-related ID for the Google
// app, trying to find the one applockpolicy actually wants.
import { zohoRequest } from "../backend/zoho/client.ts";
import { toAppError } from "../backend/lib/errors.ts";
const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const APP_ID = "247008000000154357";
const LABEL = "247008000000124016";

const paths = [
  `/apps/${APP_ID}/labels/${LABEL}`,
  `/apps/${APP_ID}/labels/${LABEL}/devices`,
  `/apps/${APP_ID}/labels/${LABEL}/groups`,
];

for (const p of paths) {
  console.log(`\n── GET ${p} ──`);
  try {
    const r = await zohoRequest(EID, { path: p });
    console.log(JSON.stringify(r, null, 2).slice(0, 1500));
  } catch (e) {
    const err = toAppError(e);
    console.log(`❌ ${err.code}: ${err.message}`);
  }
}
