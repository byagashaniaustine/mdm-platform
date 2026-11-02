// Cross-process leases (database/008_safety_and_leases.sql).
// The server's inline worker, `deno task worker`, the Sync button and scripts can all run at
// once; a lease makes sure only one of them syncs or scans an enterprise at a time.
// If a process dies, its lease simply expires.
import { db } from "./db.ts";
import { log } from "./log.ts";

/** Unique per running process. */
export const PROCESS_ID = `pid${Deno.pid}:${crypto.randomUUID().slice(0, 8)}`; // no --allow-sys needed

let leasesUnavailable = false;
/** Leases held by this process: the DB lease can't tell two callers in the same process apart. */
const heldHere = new Set<string>();

/**
 * True when this process now holds the lease. Falls back to "yes" if migration 008 isn't applied yet.
 * renew=true extends a lease this caller already holds.
 */
export async function acquireLease(name: string, ttlSeconds: number, renew = false): Promise<boolean> {
  if (!renew) {
    if (heldHere.has(name)) return false;
    heldHere.add(name); // reserve before the await so a concurrent caller sees it
  }
  try {
    const ok = await acquireInDb(name, ttlSeconds);
    if (!ok && !renew) heldHere.delete(name);
    return ok;
  } catch (e) {
    if (!renew) heldHere.delete(name);
    throw e;
  }
}

async function acquireInDb(name: string, ttlSeconds: number): Promise<boolean> {
  if (leasesUnavailable) return true;
  const { data, error } = await db().rpc("acquire_lease", { p_name: name, p_holder: PROCESS_ID, p_ttl_seconds: ttlSeconds });
  if (error) {
    // PGRST202 / 42883: function missing — run 008. Keep working, but say so once.
    if (/PGRST202|42883|acquire_lease/.test(`${error.code} ${error.message}`)) {
      leasesUnavailable = true;
      log("warn", "lease.unavailable", { hint: "Run database/008_safety_and_leases.sql to stop overlapping syncs" });
      return true;
    }
    throw new Error(`acquire_lease failed: ${error.message}`);
  }
  return data === true;
}

export async function releaseLease(name: string): Promise<void> {
  heldHere.delete(name);
  if (leasesUnavailable) return;
  const { error } = await db().rpc("release_lease", { p_name: name, p_holder: PROCESS_ID });
  if (error) log("warn", "lease.release_failed", { name, error: error.message });
}

/** Run fn while holding the lease; returns null (without running) when someone else holds it. */
export async function withLease<T>(name: string, ttlSeconds: number, fn: (renew: () => Promise<boolean>) => Promise<T>): Promise<T | null> {
  if (!(await acquireLease(name, ttlSeconds))) return null;
  try {
    return await fn(() => acquireLease(name, ttlSeconds, true));
  } finally {
    await releaseLease(name);
  }
}

/**
 * Wait up to `timeoutMs` for the lease, then run fn under it. Unlike withLease
 * which returns null when the lease is held, this one blocks (polling every
 * ~250 ms) until it can acquire. If timeout expires without acquiring, runs fn
 * anyway and logs — the caller gets to proceed rather than silently drop work.
 * Use this when the work HAS to happen (e.g. the apply path's post-sync).
 */
export async function withLeaseWait<T>(name: string, ttlSeconds: number, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let acquired = await acquireLease(name, ttlSeconds);
  while (!acquired && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    acquired = await acquireLease(name, ttlSeconds);
  }
  if (!acquired) {
    // Rather than block indefinitely, proceed without the lease and log — the
    // apply path's correctness is less important than its liveness.
    log("warn", "lease.wait_timeout", { name, timeout_ms: timeoutMs });
    return await fn();
  }
  try {
    return await fn();
  } finally {
    await releaseLease(name);
  }
}
