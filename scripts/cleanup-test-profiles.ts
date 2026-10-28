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

const TEST_PREFIXES = ["probe-", "mdm-probe-", "test-", "mdm-test-", "shape-probe-", "ct-probe-", "verify-", "fp-", "v-", "kiosk-real-"];

const profiles = (await listProfiles(eid)) as { profile_id: string | number; profile_name?: string; is_moved_to_trash?: boolean }[];
const tests = profiles.filter((p) => TEST_PREFIXES.some((pre) => (p.profile_name ?? "").startsWith(pre)));
console.log(`${profiles.length} total profiles, ${tests.length} match test prefixes.`);
if (!tests.length) { console.log("Nothing to clean."); Deno.exit(0); }

const all = tests.map((p) => String(p.profile_id));
for (const t of tests) console.log(`  ${t.profile_id}  ${t.profile_name}`);

// Zoho's DELETE /profiles is two-pass: first call trashes, second purges.
// Batched calls (≤10) actually move state; single-ID calls can silently
// no-op the trash step. See scripts/delete-all-except-passcode.ts for the
// same pattern.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BATCH = 10;
const DELAY_MS = 3000;

async function pass(label: string): Promise<void> {
  console.log(`\n== ${label} ==`);
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    try {
      await deleteProfiles(eid, chunk);
      console.log(`  ✅ batch ${1 + i / BATCH}: ${chunk.length} ok`);
    } catch (e) {
      const err = toAppError(e);
      // "already in trash" / "must be moved to trash" are harmless state mismatches between passes.
      const soft = /moved to trash|COM0015|precondition|already/i.test(err.message);
      console.log(`  ${soft ? "⚠️" : "❌"} batch ${1 + i / BATCH}: ${err.message.slice(0, 140)}`);
    }
    await sleep(DELAY_MS);
  }
}

await pass("Pass 1 — move to trash");
console.log("\n→ waiting 5s for Zoho to settle…");
await sleep(5000);
await pass("Pass 2 — permanent delete");

const final = (await listProfiles(eid)) as { profile_id: string | number; profile_name?: string }[];
const stillTests = final.filter((p) => TEST_PREFIXES.some((pre) => (p.profile_name ?? "").startsWith(pre)));
console.log(`\nFinal: ${final.length} profiles total, ${stillTests.length} test profiles remaining.`);
