// Background drain of Malipopay webhooks whose Fineract write-back failed.
//
// The /api/malipo/hooks route POSTs the repayment to Fineract on each
// payment.confirmed; if Fineract 5xx's or the circuit breaker is open,
// the events row is left at state=failed with a 2-min backoff. This drainer
// runs every worker tick, picks up those failed rows, and re-drives the
// Fineract POST. Idempotency is already free on the Fineract side via
// externalId (= the Malipopay ML reference).
//
// Backoff schedule per row: 2 → 4 → 8 → 16 → 32 → 60 min (capped), then
// state=dead after max_attempts (default 5). Dead rows surface in the UI
// for manual ops intervention — nothing retries them automatically.
import { getConfig } from "../config.ts";
import { db, run } from "../lib/db.ts";
import { toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { formatFineractDate, postRepayment } from "./bridge/fineract.ts";

interface FailedEventRow {
  id: string;
  params: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface DrainStats {
  attempted: number;
  succeeded: number;
  retried: number;  // still failed, re-queued with backoff
  dead: number;     // max attempts hit
}

export async function drainMalipoRetries(): Promise<DrainStats> {
  const stats: DrainStats = { attempted: 0, succeeded: 0, retried: 0, dead: 0 };
  const cfg = getConfig();
  if (cfg.malipoFineractPaymentTypeId <= 0) return stats;

  const now = new Date();
  const batch = await run<FailedEventRow[]>(
    db().from("events")
      .select("id, params, attempts, max_attempts")
      .eq("action", "malipo.payment.confirmed")
      .eq("state", "failed")
      .lte("next_attempt_at", now.toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(20),
  );

  for (const ev of batch) {
    stats.attempted++;

    // Soft lease: push next_attempt_at 5 min out so a concurrent drain tick
    // doesn't double-process the same row while postRepayment is in flight.
    await run(db().from("events").update({
      next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    }).eq("id", ev.id));

    const p = ev.params as {
      loan_id?: string;
      amount?: number;
      reference?: string;
      customer_reference?: string | null;
    };
    if (!p.loan_id || !p.reference || typeof p.amount !== "number") {
      // Malformed params — can't retry. Mark dead so it stops being re-picked.
      await run(db().from("events").update({
        state: "dead",
        error_message: "retry skipped: params missing loan_id, reference, or amount",
      }).eq("id", ev.id));
      stats.dead++;
      log("warn", "malipo_retry.malformed", { event_id: ev.id });
      continue;
    }

    try {
      const posted = await postRepayment({
        loanId: p.loan_id,
        amount: p.amount,
        dateDMYY: formatFineractDate(now),
        externalId: p.reference,
        paymentTypeId: cfg.malipoFineractPaymentTypeId,
        note: `Via Malipopay ${p.reference}${p.customer_reference ? ` (${p.customer_reference})` : ""} [retry ${ev.attempts + 1}]`,
      });
      await run(db().from("events").update({
        state: "succeeded",
        attempts: ev.attempts + 1,
        completed_at: new Date().toISOString(),
      }).eq("id", ev.id));
      stats.succeeded++;
      log("info", "malipo_retry.booked", {
        event_id: ev.id,
        loan_id: p.loan_id,
        malipo_ref: p.reference,
        fineract_tx_id: posted.transactionId,
        attempt: ev.attempts + 1,
      });
    } catch (e) {
      const err = toAppError(e);
      // Duplicate externalId → a prior attempt actually succeeded on Fineract
      // but we never recorded it locally. Treat as success so we stop retrying.
      const looksDuplicate = err.code === "FINERACT_BAD_REQUEST" && /(duplicate|already)/i.test(err.message);
      if (looksDuplicate) {
        await run(db().from("events").update({
          state: "succeeded",
          attempts: ev.attempts + 1,
          completed_at: new Date().toISOString(),
          error_message: "already booked in Fineract (duplicate externalId)",
        }).eq("id", ev.id));
        stats.succeeded++;
        log("info", "malipo_retry.duplicate_on_fineract", { event_id: ev.id, malipo_ref: p.reference });
        continue;
      }

      const attempts = ev.attempts + 1;
      const exhausted = attempts >= ev.max_attempts;
      // 2, 4, 8, 16, 32, 60 min — cap at 60.
      const backoffMin = Math.min(60, 2 ** attempts);
      await run(db().from("events").update({
        state: exhausted ? "dead" : "failed",
        attempts,
        next_attempt_at: new Date(Date.now() + backoffMin * 60_000).toISOString(),
        error_message: `retry ${attempts}/${ev.max_attempts}: ${err.code} ${(err.message ?? "").slice(0, 200)}`,
      }).eq("id", ev.id));
      if (exhausted) {
        stats.dead++;
        log("warn", "malipo_retry.dead", { event_id: ev.id, malipo_ref: p.reference, error: err.code });
      } else {
        stats.retried++;
        log("info", "malipo_retry.failed", {
          event_id: ev.id,
          malipo_ref: p.reference,
          attempt: attempts,
          next_in_min: backoffMin,
          error: err.code,
        });
      }
    }
  }

  return stats;
}
