// Sim callback retry queue (migration 018).
//
// apply_queue.ts enqueues one row per terminal transition (applied OR dead).
// drainSimCallbacks runs each worker tick, HMAC-signs the payload with the
// shared secret, POSTs to the sim's /api/mdm/callback, and stamps delivered_at
// on success. On failure, exponential backoff capped at 10 attempts.
//
// Fire-and-forget on the apply side: callback liveness never blocks a
// terminal transition. The sim is responsible for idempotency on apply_job_id.
import { getConfig } from "../config.ts";
import { db, run } from "../lib/db.ts";
import { log } from "../lib/log.ts";

export interface SimCallbackPayload {
  apply_job_id: string;
  enterprise_id: string;
  device_id: string;
  loan_id: string;
  final_tier: string | null;      // the tier Zoho actually places the device in (observed), or null if unknown
  intended_tier: string | null;   // the tier the apply tried to move to
  state: "applied" | "dead";
  error_code?: string | null;
  error_message?: string | null;
  completed_at: string;           // ISO
}

const MAX_PER_TICK = 20;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 10 * 60 * 1000;

function backoffMs(attempts: number): number {
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempts) + jitter);
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Insert a callback row. Called by apply_queue after a terminal transition.
 * Skips the write when SIM_CALLBACK_URL is unset — the sim is decommissioned
 * and the drain would never deliver the row anyway. Prevents the undelivered
 * backlog from growing unbounded in production. */
export async function enqueueSimCallback(payload: SimCallbackPayload): Promise<void> {
  const cfg = getConfig();
  if (!cfg.simCallbackUrl) return;
  await run(db().from("sim_callbacks").upsert({
    enterprise_id: payload.enterprise_id,
    apply_job_id: payload.apply_job_id,
    payload: payload as unknown as Record<string, unknown>,
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
    delivered_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "apply_job_id" }));
}

interface SimCallbackRow {
  id: string;
  enterprise_id: string;
  apply_job_id: string;
  payload: SimCallbackPayload;
  attempts: number;
  max_attempts: number;
}

/** Drain up to MAX_PER_TICK due callbacks. Called from worker.tick(). */
export async function drainSimCallbacks(): Promise<{ delivered: number; failed: number; skipped: boolean }> {
  const cfg = getConfig();
  if (!cfg.simCallbackUrl || !cfg.simCallbackSecret) return { delivered: 0, failed: 0, skipped: true };

  const nowIso = new Date().toISOString();
  const due = await run<SimCallbackRow[]>(
    db().from("sim_callbacks")
      .select("id, enterprise_id, apply_job_id, payload, attempts, max_attempts")
      .is("delivered_at", null)
      .lte("next_attempt_at", nowIso)
      .order("next_attempt_at", { ascending: true })
      .limit(MAX_PER_TICK),
  );
  if (!due.length) return { delivered: 0, failed: 0, skipped: false };

  let delivered = 0, failed = 0;
  for (const row of due) {
    const body = JSON.stringify(row.payload);
    const sig = await hmacHex(cfg.simCallbackSecret, body);
    try {
      const res = await fetch(`${cfg.simCallbackUrl}/api/mdm/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-MDM-Signature": sig },
        body,
      });
      if (!res.ok) throw new Error(`sim returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await run(db().from("sim_callbacks").update({
        delivered_at: new Date().toISOString(),
        attempts: row.attempts + 1,
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", row.id));
      delivered++;
    } catch (e) {
      const nextAttempt = row.attempts + 1;
      const exhausted = nextAttempt >= row.max_attempts;
      const next = exhausted ? null : new Date(Date.now() + backoffMs(nextAttempt)).toISOString();
      await run(db().from("sim_callbacks").update({
        attempts: nextAttempt,
        next_attempt_at: next ?? new Date(Date.now() + BACKOFF_CAP_MS).toISOString(),
        last_error: String(e).slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id));
      failed++;
      log(exhausted ? "warn" : "info", "sim_callback.deliver_failed", {
        id: row.id, apply_job_id: row.apply_job_id, attempts: nextAttempt, exhausted, error: String(e).slice(0, 200),
      });
    }
  }
  return { delivered, failed, skipped: false };
}
