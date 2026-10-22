import { listProfiles } from "../backend/zoho/api.ts";
const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const all = (await listProfiles(EID)) as { profile_id: string | number; profile_name?: string; payloads?: string[]; is_moved_to_trash?: unknown }[];
console.log(`${all.length} profile(s):`);
for (const p of all) {
  const trash = p.is_moved_to_trash === true || p.is_moved_to_trash === "true" ? " TRASHED" : "";
  const payloads = (p.payloads ?? []).join(",") || "(no payloads)";
  console.log(`  ${p.profile_id}  ${p.profile_name}  [${payloads}]${trash}`);
}
