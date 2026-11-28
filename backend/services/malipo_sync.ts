// Periodic Malipopay ↔ Fineract reconciler.
//
// Runs on the same cadence as the Zoho sync tick. For every active linked loan
// with a Malipopay collection reference we:
//   1. Fetch Malipopay's authoritative paidAmount on the ref.
//   2. Fetch Fineract's totalRepaid on the loan.
//   3. If Malipopay is ahead (missed a webhook / partial top-up not delivered)
//      → book the delta into Fineract as a repayment. Externally-unique id is
//      `${ref}-cum${paidAmount}` so re-runs collapse on Fineract's own
//      externalId dedupe, and Fineract fires its REPAYMENT webhook back,
//      which drives the device-tier pipeline through the existing path.
//   4. If Fineract is ahead → log a warn (manual Fineract entry, needs ops)
//      but take no action.
// In both cases we stamp loan_links.last_malipo_* with Malipopay's view so the
// Loan Tracking UI shows the truth even when no payment just landed.
//
// Why this exists: Malipopay webhooks on state transition (NEW → PARTIAL),
// not on every top-up against an open FLEXIBLE collection. The webhook path
// handles the first partial fine; everything after it would silently sit on
// Malipopay's side until the loan was closed. This closes the gap.
import { getConfig } from "../config.ts";
import { db, run } from "../lib/db.ts";
import { toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { formatFineractDate, getLoan, postRepayment } from "./bridge/fineract.ts";
import { getPaymentByReference } from "./malipo.ts";

export interface SyncStats {
  checked: number;      // loan_links rows considered
  drift_booked: number; // delta POSTed to Fineract successfully
  drift_dup: number;    // Fineract said "already booked" — safe
  drift_failed: number; // Fineract POST failed, will retry next tick
  reverse_drift: number;// Fineract ahead of Malipopay — logged only
  up_to_date: number;   // malipo == fineract — stamped, nothing booked
  skipped: number;      // missing ref / Malipopay unknown / loan absent
}

/**
 * Compute the drift direction + magnitude between Malipopay's cumulative
 * paid amount and Fineract's total repayment. Pure so the thresholds are
 * exhaustively unit-testable. Rounding to the nearest whole TZS matches
 * Fineract's ledger precision — sub-TZS floats would otherwise churn every
 * tick on a loan that's genuinely in sync.
 */
export function driftOf(
  malipoPaidAmount: number,
  fineractTotalRepaid: number,
): { direction: "equal" | "malipo_ahead" | "fineract_ahead"; delta: number } {
  const m = Math.round(Number(malipoPaidAmount) || 0);
  const f = Math.round(Number(fineractTotalRepaid) || 0);
  if (m === f) return { direction: "equal", delta: 0 };
  if (m > f) return { direction: "malipo_ahead", delta: m - f };
  return { direction: "fineract_ahead", delta: f - m };
}

interface LinkRow {
  enterprise_id: string;
  fineract_loan_id: string;
  malipo_reference: string;
  status: string;
}

export async function reconcileAllLoans(): Promise<SyncStats> {
  const stats: SyncStats = {
    checked: 0, drift_booked: 0, drift_dup: 0, drift_failed: 0,
    reverse_drift: 0, up_to_date: 0, skipped: 0,
  };
  const cfg = getConfig();
  if (!cfg.malipoApiKey || cfg.malipoFineractPaymentTypeId <= 0) return stats;

  const rows = await run<LinkRow[]>(
    db().from("loan_links")
      .select("enterprise_id, fineract_loan_id, malipo_reference, status")
      .eq("status", "active")
      .not("malipo_reference", "is", null),
  );

  for (const row of rows) {
    stats.checked++;
    const ref = row.malipo_reference;
    const loanId = row.fineract_loan_id;
    try {
      // One Malipopay call + one Fineract call per loan. ~1.5s each worst case;
      // sequenced to keep the circuit-breaker signal clean (parallel would blur
      // which side failed).
      const malipo = await getPaymentByReference(ref);
      if (!malipo) {
        stats.skipped++;
        log("info", "malipo_sync.ref_unknown", { loan_id: loanId, malipo_ref: ref });
        continue;
      }
      const loan = await getLoan(loanId, new Date().toISOString().slice(0, 10));

      // Malipopay reports `paidAmount` as the cumulative gross — that's what
      // we compare against Fineract's totalRepaid. The webhook path stamps
      // `last_malipo_amount` with the single-event amount, which drifts from
      // cumulative on multi-partial loans; we now overwrite it with the
      // cumulative so the UI shows the right thing.
      const malipoPaid = Number((malipo.raw as { paidAmount?: unknown }).paidAmount ?? malipo.amount ?? 0);
      const malipoUpdatedAt = String((malipo.raw as { updatedAt?: unknown }).updatedAt ?? "") || null;
      const { direction, delta } = driftOf(malipoPaid, loan.totalRepaid);

      await run(db().from("loan_links").update({
        last_malipo_at: malipoUpdatedAt ?? new Date().toISOString(),
        last_malipo_amount: malipoPaid,
        last_malipo_status: malipo.status,
      }).eq("fineract_loan_id", loanId));

      if (direction === "equal") {
        stats.up_to_date++;
        continue;
      }
      if (direction === "fineract_ahead") {
        stats.reverse_drift++;
        log("warn", "malipo_sync.fineract_ahead", {
          loan_id: loanId, malipo_ref: ref, delta,
          malipo_paid: malipoPaid, fineract_repaid: loan.totalRepaid,
        });
        continue;
      }

      // malipo_ahead → book the delta. externalId encodes the cumulative so
      // concurrent workers converge on the same key (Fineract dedupes) and a
      // later top-up gets a fresh key.
      const externalId = `${ref}-cum${malipoPaid}`;
      try {
        const posted = await postRepayment({
          loanId,
          amount: delta,
          dateDMYY: formatFineractDate(new Date()),
          externalId,
          paymentTypeId: cfg.malipoFineractPaymentTypeId,
          note: `Via Malipopay ${ref} [sync drift Δ=${delta}, cum=${malipoPaid}]`,
        });
        stats.drift_booked++;
        log("info", "malipo_sync.drift_booked", {
          loan_id: loanId, malipo_ref: ref, delta,
          malipo_paid: malipoPaid, fineract_repaid_before: loan.totalRepaid,
          fineract_tx_id: posted.transactionId, external_id: externalId,
        });
      } catch (e) {
        const err = toAppError(e);
        const looksDuplicate = err.code === "FINERACT_BAD_REQUEST" && /(duplicate|already)/i.test(err.message);
        if (looksDuplicate) {
          stats.drift_dup++;
          log("info", "malipo_sync.drift_already_booked", { loan_id: loanId, external_id: externalId });
        } else {
          stats.drift_failed++;
          log("warn", "malipo_sync.drift_book_failed", {
            loan_id: loanId, malipo_ref: ref, delta,
            external_id: externalId, error: err.code, message: (err.message ?? "").slice(0, 200),
          });
        }
      }
    } catch (e) {
      stats.skipped++;
      log("warn", "malipo_sync.loan_skipped", { loan_id: loanId, malipo_ref: ref, error: String(e).slice(0, 200) });
    }
  }

  return stats;
}
