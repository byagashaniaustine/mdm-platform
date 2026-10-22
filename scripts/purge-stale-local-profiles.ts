// Direct DB cleanup: for the given enterprise, soft-delete any local `profiles`
// row whose zoho_profile_id isn't in Zoho's current list. Bypasses the sync
// lock so it can run even while a scheduled sync is holding the lease.
import * as zoho from "../backend/zoho/api.ts";
import { db, run } from "../backend/lib/db.ts";

const EID = Deno.args[0];
if (!EID) { console.error("usage: purge-stale-local-profiles.ts <enterpriseId>"); Deno.exit(2); }

const zohoProfiles = (await zoho.listProfiles(EID)) as { profile_id?: string | number }[];
const liveIds = new Set(zohoProfiles.map((p) => String(p.profile_id ?? "")).filter(Boolean));
console.log(`Zoho has ${liveIds.size} profile(s) live.`);

const local = await run<{ id: string; zoho_profile_id: string | null; name: string | null; state: string }[]>(
  db().from("profiles").select("id, zoho_profile_id, name, state")
    .eq("enterprise_id", EID).neq("state", "deleted").not("zoho_profile_id", "is", null),
);
console.log(`Local DB has ${local.length} active profile(s) with a zoho_profile_id.`);

const stale = local.filter((p) => !liveIds.has(String(p.zoho_profile_id)));
console.log(`\n${stale.length} stale (not in Zoho anymore):`);
for (const p of stale) console.log(`  ${p.id}  ${p.name}  zoho=${p.zoho_profile_id}  state=${p.state}`);
if (!stale.length) Deno.exit(0);

await run(db().from("profile_groups").delete().in("profile_id", stale.map((p) => p.id)));
await run(db().from("profiles").update({ state: "deleted" }).in("id", stale.map((p) => p.id)));
console.log(`\n✅ Soft-deleted ${stale.length} stale profiles.`);
