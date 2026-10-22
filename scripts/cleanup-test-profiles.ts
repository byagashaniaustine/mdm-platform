// Delete the probe profiles accumulated in Zoho's trash during testing.
// Matches names starting with: probe-, mdm-probe-, probe-ios-, probe-kiosk-,
// probe-applock-, probe-lockscreen-.
//
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/cleanup-test-profiles.ts <enterpriseId>
import { deleteProfiles, listProfiles } from "../backend/zoho/api.ts";
import { toAppError } from "../backend/lib/errors.ts";

const [eid] = Deno.args;
if (!eid) { console.error("usage: cleanup-test-profiles.ts <enterpriseId>"); Deno.exit(2); }

const TEST_PREFIXES = ["probe-", "mdm-probe-", "test-", "mdm-test-"];

const profiles = (await listProfiles(eid)) as { profile_id: string | number; profile_name?: string; is_moved_to_trash?: boolean }[];
const tests = profiles.filter((p) => TEST_PREFIXES.some((pre) => (p.profile_name ?? "").startsWith(pre)));
console.log(`${profiles.length} total profiles, ${tests.length} match test prefixes.`);
if (!tests.length) { console.log("Nothing to clean."); Deno.exit(0); }

const toTrash: string[] = [];
const toPurge: string[] = [];
// Zoho returns is_moved_to_trash as the string "true"/"false", not boolean.
const trashed = (v: unknown) => v === true || v === "true";
for (const p of tests) {
  const id = String(p.profile_id);
  if (trashed(p.is_moved_to_trash)) toPurge.push(id);
  else toTrash.push(id);
}
console.log(`→ moving ${toTrash.length} to trash, permanently deleting ${toPurge.length} already in trash`);
for (const name of tests) console.log(`  ${name.profile_id}  ${name.profile_name}  trash=${name.is_moved_to_trash}`);

// Delete one profile at a time: Zoho's DELETE /profiles seems to misreport
// batch state. Deleting individually makes the trash → purge transition stick.
async function delOne(id: string): Promise<"trashed" | "purged" | "error"> {
  try { await deleteProfiles(eid, [id]); } catch (e) {
    const msg = toAppError(e).message;
    console.log(`  ❌ ${id}: ${msg.slice(0, 120)}`);
    return "error";
  }
  return "trashed";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY_MS = 1200;

const all = [...toTrash, ...toPurge];
console.log(`\n→ Pass 1 — move each to trash (${all.length} profiles, ${DELAY_MS}ms between)`);
let p1ok = 0;
for (const id of all) {
  if ((await delOne(id)) !== "error") p1ok++;
  await sleep(DELAY_MS);
}
console.log(`Pass 1: ${p1ok}/${all.length} OK`);

console.log("\n→ waiting 5s for Zoho state to settle…");
await sleep(5000);

console.log("\n→ Pass 2 — permanent delete");
let p2ok = 0;
for (const id of all) {
  if ((await delOne(id)) !== "error") p2ok++;
  await sleep(DELAY_MS);
}
console.log(`Pass 2: ${p2ok}/${all.length} OK`);
console.log("\nDone.");
