import { listProfiles } from "../backend/zoho/api.ts";
const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const PREFIX = /^(mdm-)?probe-/;
const all = (await listProfiles(EID)) as { profile_id: string | number; profile_name?: string; is_moved_to_trash?: unknown }[];
const tests = all.filter((p) => PREFIX.test(p.profile_name ?? ""));
const trashed = tests.filter((p) => p.is_moved_to_trash === true || p.is_moved_to_trash === "true");
const active = tests.filter((p) => !(p.is_moved_to_trash === true || p.is_moved_to_trash === "true"));
console.log(`total profiles: ${all.length}`);
console.log(`probe profiles: ${tests.length}  (active=${active.length}, trashed=${trashed.length})`);
