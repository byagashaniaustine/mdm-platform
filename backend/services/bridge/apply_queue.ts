// Async apply queue (migration 016). The webhook ingress enqueues one job per
// device decision; the worker drains the queue and performs the actual Zoho
// moves + announcement sends in the background.
//
// Why async: synchronous apply held the webhook response for 7-10 s per tier
// transition and gave Zoho's eventual-consistency a chance to produce
// APPLY_MOVE_NOT_VISIBLE verify failures. The queue decouples ingress latency
// from Zoho work, lets us retry transient failures with proper backoff, and
// provides a natural backpressure point for traffic bursts and Fineract
// outages.
//
// Flow:
//   1. webhook → reconcileBatch (DB-only, fast) → enqueueDecisions
//   2. HTTP 202 returned to sim with the job ids
//   3. worker.tick() drains ~10 jobs/tick (claim via UPDATE … RETURNING)
//   4. per job: pre-sync tier groups → applyOneDecision → stamp outcome
//   5. on failure, backoff + retry up to max_attempts, then mark dead

import { db, run, runMaybe } from "../../lib/db.ts";
import { log } from "../../lib/log.ts";
import { applyOneDecision, stampObserved, type ApplyOutcome } from "./apply.ts";
import { loadPlan } from "./policy.ts";
import type { DeviceDecision } from "./reconcile.ts";
import { enqueueSimCallback } from "../sim_callbacks.ts";
import { syncGroupMembership } from "../sync.ts";

export type JobState = "pending" | "in_progress" | "applied" | "failed" | "dead";

export interface ApplyJobRow {
  id: string;
  enterprise_id: string;
  device_id: string;
  loan_id: string;
  trigger: string;
  decision: DeviceDecision;
  state: JobState;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_until: string | null;
  outcome: ApplyOutcome | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

const CLAIM_LOCK_SECONDS = 120;
const MAX_JOBS_PER_TICK = 10;

/** Exponential backoff capped at 10 min, matching the events-queue pattern. */
function backoffMs(attempts: number): number {
  const base = 1_000;
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(10 * 60_000, base * 2 ** attempts + jitter);
}

/**
 * Insert one apply_jobs row per decision. Decisions that would skip (dry_run /
 * same_tier / no_mapping / no_platform / no_loan_id) are NOT enqueued — those
 * are handled synchronously in the webhook response via reconcile.ts's own
 * guards.
 */
export async function enqueueDecisions(
  enterpriseId: string,
  decisions: DeviceDecision[],
  trigger: string,
): Promise<Array<{ id: string; device_id: string; loan_id: string }>> {
  if (!decisions.length) return [];
  const rows = decisions.map((d) => ({
    enterprise_id: enterpriseId,
    device_id: d.deviceId,
    loan_id: d.loanId,
    trigger,
    decision: d as unknown as Record<string, unknown>,
  }));
  const inserted = await run<Array<{ id: string; device_id: string; loan_id: string }>>(
    db().from("apply_jobs").insert(rows).select("id, device_id, loan_id"),
  );
  log("info", "apply_queue.enqueued", { enterprise_id: enterpriseId, trigger, count: inserted.length });
  return inserted;
}

/**
 * Claim up to `limit` due jobs. Atomic via UPDATE … WHERE id IN (SELECT …) …
 * RETURNING. The lock-until window prevents a second worker from re-claiming
 * the same row while we process it.
 */
export async function claimApplyJobs(limit = MAX_JOBS_PER_TICK): Promise<ApplyJobRow[]> {
  const nowIso = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + CLAIM_LOCK_SECONDS * 1000).toISOString();

  // Supabase/PostgREST doesn't give us SELECT FOR UPDATE SKIP LOCKED, so we
  // emulate: read pending ids, update to in_progress with a lock, return the
  // rows. Concurrent workers racing on the same id lose quietly thanks to the
  // (state='pending') predicate.
  const due = await run<Array<{ id: string }>>(
    db().from("apply_jobs")
      .select("id")
      .in("state", ["pending", "in_progress"])
      .lte("next_attempt_at", nowIso)
      .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
      .order("next_attempt_at", { ascending: true })
      .limit(limit),
  );
  if (!due.length) return [];

  const ids = due.map((r) => r.id);
  const claimed = await run<ApplyJobRow[]>(
    db().from("apply_jobs")
      .update({ state: "in_progress", locked_until: lockedUntil, updated_at: nowIso })
      .in("id", ids)
      // extra guard against double-claim between read and update
      .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
      .select("*"),
  );
  return claimed;
}

/**
 * Run one job to completion. On success, mark state=applied with outcome.
 * On failure, backoff + retry up to max_attempts, then mark dead.
 */
export async function processApplyJob(job: ApplyJobRow): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    // Fresh per-job pre-sync so the queue worker always acts on current
    // Zoho reality (not the webhook's stale moment).
    const plan = await loadPlan(job.enterprise_id);
    const tierGroupRowIds = [...new Set([...plan.values()].map((p) => p.targetGroupRowId))];
    for (const gid of tierGroupRowIds) {
      try { await syncGroupMembership(job.enterprise_id, gid); } catch { /* best effort */ }
    }
    const groupNames = new Map<string, string>();
    for (const p of plan.values()) groupNames.set(p.targetGroupRowId, p.targetGroupName);

    const outcome = await applyOneDecision(job.enterprise_id, job.decision, plan, tierGroupRowIds, groupNames);

    const nextAttempt = job.attempts + 1;
    const hasError = Boolean(outcome.error);
    const canRetry = hasError && outcome.error?.code === "APPLY_MOVE_NOT_VISIBLE" && nextAttempt < job.max_attempts;

    // Soft error we can wait out — Zoho eventual consistency usually clears
    // within one retry cycle.
    if (canRetry) {
      await run(db().from("apply_jobs").update({
        state: "pending",
        attempts: nextAttempt,
        next_attempt_at: new Date(Date.now() + backoffMs(nextAttempt)).toISOString(),
        locked_until: null,
        outcome: outcome as unknown as Record<string, unknown>,
        error_code: outcome.error?.code ?? null,
        error_message: outcome.error?.message ?? null,
        updated_at: nowIso,
      }).eq("id", job.id));
      log("info", "apply_queue.will_retry", { job_id: job.id, attempts: nextAttempt, code: outcome.error?.code });
      return;
    }

    // Terminal outcome. `applied` means Zoho confirmed the move (outcome.moved
    // or outcome.skipped set). `dead` means we exhausted retries on a
    // persistent error — this is NOT applied; downstream (alerts, UI) must
    // treat it as a failure that needs operator attention.
    const terminalState: JobState = hasError && !outcome.moved ? "dead" : "applied";

    // On dead, re-read Zoho so device_tier_state reflects reality (not the
    // last stamped applied_tier, which may be a lie now). On success, apply.ts
    // already stamped observed_state inline — skip the re-read.
    if (terminalState === "dead") {
      try { await stampObserved(job.enterprise_id, job.device_id); }
      catch (e) { log("warn", "apply_queue.stamp_observed_failed", { job_id: job.id, error: String(e) }); }
    }

    await run(db().from("apply_jobs").update({
      state: terminalState,
      attempts: nextAttempt,
      outcome: outcome as unknown as Record<string, unknown>,
      error_code: outcome.error?.code ?? null,
      error_message: outcome.error?.message ?? null,
      completed_at: nowIso,
      updated_at: nowIso,
      locked_until: null,
    }).eq("id", job.id));
    log(terminalState === "dead" ? "warn" : "info", `apply_queue.${terminalState}`, {
      job_id: job.id, moved: outcome.moved, announced: outcome.announcementSent, error_code: outcome.error?.code,
    });

    // Notify the sim. Fire-and-forget: enqueueSimCallback just writes a row;
    // actual delivery happens in the worker's drainSimCallbacks pass.
    try {
      await enqueueSimCallback({
        apply_job_id: job.id,
        enterprise_id: job.enterprise_id,
        device_id: job.device_id,
        loan_id: job.loan_id,
        final_tier: terminalState === "applied" ? outcome.to : null,
        intended_tier: outcome.to,
        state: terminalState,
        error_code: outcome.error?.code ?? null,
        error_message: outcome.error?.message ?? null,
        completed_at: nowIso,
      });
    } catch (e) {
      log("warn", "apply_queue.sim_callback_enqueue_failed", { job_id: job.id, error: String(e) });
    }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const nextAttempt = job.attempts + 1;
    const exhausted = nextAttempt >= job.max_attempts;
    const state: JobState = exhausted ? "dead" : "pending";
    const next = exhausted ? null : new Date(Date.now() + backoffMs(nextAttempt)).toISOString();

    // Same observed-state stamp on exhausted-retry path (the catch branch
    // handles unexpected throws from applyOneDecision; the explicit terminal
    // handling above covers in-outcome errors).
    if (exhausted) {
      try { await stampObserved(job.enterprise_id, job.device_id); }
      catch (ee) { log("warn", "apply_queue.stamp_observed_failed", { job_id: job.id, error: String(ee) }); }
    }

    await run(db().from("apply_jobs").update({
      state,
      attempts: nextAttempt,
      next_attempt_at: next ?? nowIso,
      locked_until: null,
      error_code: err.code ?? "APPLY_FAILED",
      error_message: (err.message ?? String(e)).slice(0, 500),
      updated_at: nowIso,
      completed_at: exhausted ? nowIso : null,
    }).eq("id", job.id));
    log("warn", "apply_queue.failed", { job_id: job.id, state, attempts: nextAttempt, error: err.code ?? err.message });

    if (exhausted) {
      try {
        await enqueueSimCallback({
          apply_job_id: job.id,
          enterprise_id: job.enterprise_id,
          device_id: job.device_id,
          loan_id: job.loan_id,
          final_tier: null,
          intended_tier: (job.decision as { to?: string | null })?.to ?? null,
          state: "dead",
          error_code: err.code ?? "APPLY_FAILED",
          error_message: (err.message ?? String(e)).slice(0, 500),
          completed_at: nowIso,
        });
      } catch (ee) {
        log("warn", "apply_queue.sim_callback_enqueue_failed", { job_id: job.id, error: String(ee) });
      }
    }
  }
}

/** Drain up to MAX_JOBS_PER_TICK jobs. Called from worker.tick(). */
export async function drainApplyQueue(): Promise<{ claimed: number; processed: number }> {
  const jobs = await claimApplyJobs(MAX_JOBS_PER_TICK);
  if (!jobs.length) return { claimed: 0, processed: 0 };
  let processed = 0;
  for (const job of jobs) {
    try {
      await processApplyJob(job);
      processed++;
    } catch (e) {
      log("error", "apply_queue.drain_error", { job_id: job.id, error: String(e) });
    }
  }
  return { claimed: jobs.length, processed };
}

/** Status probe used by the sim for its polling loop. */
export async function getApplyJob(jobId: string): Promise<ApplyJobRow | null> {
  return await runMaybe<ApplyJobRow>(
    db().from("apply_jobs").select("*").eq("id", jobId).maybeSingle(),
  );
}
