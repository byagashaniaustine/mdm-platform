// Probe ioslockscreenmessage payload against live Zoho.
import { addPayload, createProfile, deleteProfiles } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";

const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const name = `probe-lockscreen-${Date.now()}`;
let zid: string | null = null;
try {
  const created = await createProfile(EID, { name, description: "probe", platformType: 1, scope: 0 });
  zid = String((created as { profile_id?: string | number }).profile_id ?? "");
  console.log(`profile_id=${zid}`);

  const body = {
    wallpaper_type: 1,          // 1 = custom bg color (vs 2 = uploaded image)
    bg_colour: "#1F3A5F",       // dark blue
    orientation: 1,             // 1 or 2
    messages: [
      {
        message: "This device is in POS Kiosk mode. For help call +255 712 345 678.",
        text_colour: "#FFFFFF",
      },
    ],
  };
  console.log("body:", JSON.stringify(body, null, 2));
  const r = await addPayload(EID, zid, "ioslockscreenmessage", body);
  console.log("\n✅ accepted:", JSON.stringify(r).slice(0, 400));
} catch (e) {
  const err = toAppError(e);
  console.log(`\n❌ ${err.code}: ${err.message}`);
  if (err.details) console.log("details:", JSON.stringify(err.details).slice(0, 400));
} finally {
  if (zid) { try { await deleteProfiles(EID, [zid]); } catch { /* ignore */ } }
}
