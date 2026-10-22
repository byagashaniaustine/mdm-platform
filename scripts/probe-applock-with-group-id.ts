// Try applockpolicy with app_group_id (247008000000152227) instead of app_id.
import { addPayload, createProfile, deleteProfiles } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";

const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const APP_GROUP_ID = "247008000000152227"; // from GET /apps/{id}/labels/{release_label_id}

const name = `probe-applock-group-id-${Date.now()}`;
let zid: string | null = null;
try {
  const created = await createProfile(EID, { name, description: "probe", platformType: 1, scope: 0 });
  zid = String((created as { profile_id?: string | number }).profile_id ?? "");
  console.log(`profile_id=${zid}`);
  const allowed = `[{"app_id":${APP_GROUP_ID},"group_display_name":"Google"}]`;
  console.log(`body.allowed_apps=${allowed}`);
  const r = await addPayload(EID, zid, "applockpolicy", {
    kiosk_mode: 1,
    allowed_apps: allowed,
    disable_auto_lock: true,
  });
  console.log("\n✅ ACCEPTED by Zoho!");
  console.log(JSON.stringify(r, null, 2).slice(0, 500));
} catch (e) {
  const err = toAppError(e);
  console.log(`\n❌ ${err.code}: ${err.message}`);
  if (err.details) console.log(`details: ${JSON.stringify(err.details).slice(0, 300)}`);
} finally {
  if (zid) { try { await deleteProfiles(EID, [zid]); } catch { /* ignore */ } }
}
