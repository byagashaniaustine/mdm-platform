// Does every app in the Zoho repo have an app_group_id (kiosk-eligible)?
// Query label detail for all iOS apps + try applockpolicy with each app_group_id.
import { addPayload, createProfile, deleteProfiles, getAppDetail, getAppLabelDetail, listApps } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";

const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const apps = (await listApps(EID)) as { app_id: string | number; app_name?: string; platform_type?: number | string }[];
const ios = apps.filter((a) => Number(a.platform_type) === 1);

console.log(`Checking ${ios.length} iOS apps for app_group_id + applockpolicy acceptance:\n`);

for (const a of ios) {
  const detail = await getAppDetail(EID, a.app_id) as { release_labels?: { release_label_id?: string | number }[]; distributed_device_count?: string; is_approved?: boolean };
  const rl = detail.release_labels?.[0]?.release_label_id;
  const dist = detail.distributed_device_count;
  console.log(`${a.app_name}  (distributed=${dist}, approved=${detail.is_approved})`);
  if (!rl) { console.log("  ⚠️  no release_label_id\n"); continue; }
  try {
    const labelDetail = await getAppLabelDetail(EID, a.app_id, rl) as { app_group_id?: string | number };
    const agId = labelDetail.app_group_id;
    console.log(`  app_group_id = ${agId ?? "(missing)"}`);
    if (!agId) { console.log(); continue; }
    // Try applockpolicy with this app_group_id
    const profName = `probe-${a.app_name}-${Date.now()}`;
    const created = await createProfile(EID, { name: profName, description: "probe", platformType: 1, scope: 0 });
    const zid = String((created as { profile_id?: string | number }).profile_id ?? "");
    try {
      const allowed = `[{"app_id":${agId},"group_display_name":${JSON.stringify(a.app_name ?? "probe")}}]`;
      await addPayload(EID, zid, "applockpolicy", { kiosk_mode: 1, allowed_apps: allowed, disable_auto_lock: true });
      console.log(`  ✅ applockpolicy accepts ${a.app_name}`);
    } catch (e) {
      const err = toAppError(e);
      console.log(`  ❌ applockpolicy rejects ${a.app_name}: ${err.message}`);
    } finally {
      try { await deleteProfiles(EID, [zid]); } catch { /* ignore */ }
    }
  } catch (e) {
    const err = toAppError(e);
    console.log(`  ⚠️  label-detail failed: ${err.message}`);
  }
  console.log();
}
