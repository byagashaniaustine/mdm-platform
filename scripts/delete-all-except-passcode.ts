// Delete every Zoho profile EXCEPT the one named "passcode".
// Uses batches of 10 with gaps to stay under Zoho's rate limit.
import { deleteProfiles, listProfiles } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";

const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const KEEP_NAME = "passcode";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pass(label: string): Promise<void> {
  const profiles = (await listProfiles(EID)) as { profile_id: string | number; profile_name?: string }[];
  const toKill = profiles.filter((p) => (p.profile_name ?? "") !== KEEP_NAME).map((p) => String(p.profile_id));
  console.log(`\n== ${label} ==  ${toKill.length} profile(s) to DELETE  (keeping ${profiles.length - toKill.length} named '${KEEP_NAME}')`);
  if (!toKill.length) { console.log("Nothing to delete."); return; }
  const BATCH = 10;
  for (let i = 0; i < toKill.length; i += BATCH) {
    const chunk = toKill.slice(i, i + BATCH);
    try {
      await deleteProfiles(EID, chunk);
      console.log(`  ✅ batch ${1 + i / BATCH}: ${chunk.length} deleted`);
    } catch (e) {
      const err = toAppError(e);
      const msg = err.message.slice(0, 120);
      // "already in trash" or "must be moved to trash" are harmless — different states.
      const soft = /moved to trash|COM0015|precondition|already/i.test(err.message);
      console.log(`  ${soft ? "⚠️ " : "❌ "}batch ${1 + i / BATCH}: ${msg}`);
    }
    await sleep(3000); // 3s between batches to avoid rate limit
  }
}

await pass("Pass 1 — trash active profiles");
console.log("\n→ waiting 5s for Zoho state to settle...");
await sleep(5000);
await pass("Pass 2 — purge trashed profiles");

const final = (await listProfiles(EID)) as { profile_id: string | number; profile_name?: string }[];
console.log(`\nFinal count: ${final.length} profile(s) left:`);
for (const p of final) console.log(`  ${p.profile_id}  ${p.profile_name}`);
