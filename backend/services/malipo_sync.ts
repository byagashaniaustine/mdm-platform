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

export type LoanOutcome =
  | "equal"
  | "booked"
  | "duplicate"
  | "fineract_ahead"
  | "malipo_ref_unknown"
  | "failed"
  | "skipped_unconfigured";

/**
 * Reconcile a single loan's Malipopay vs Fineract state. Exported so the
 * webhook route can trigger an immediate per-loan sync on inbound event
 * delivery (rather than wait up to SYNC_INTERVAL_MINUTES for the next tick).
 * Idempotent: multiple concurrent callers converge on the same Fineract
 * externalId, so Fineract's own dedupe collapses the race to one booking.
 */
export async function reconcileLoan(
  fineractLoanId: string,
  malipoReference: string,
): Promise<LoanOutcome> {
  const cfg = getConfig();
  if (!cfg.malipoApiKey || cfg.malipoFineractPaymentTypeId <= 0) return "skipped_unconfigured";

  const malipo = await getPaymentByReference(malipoReference);
  if (!malipo) {
    log("info", "malipo_sync.ref_unknown", { loan_id: fineractLoanId, malipo_ref: malipoReference });
    return "malipo_ref_unknown";
  }
  const loan = await getLoan(fineractLoanId, new Date().toISOString().slice(0, 10));

  // `paidAmount` is Malipopay's cumulative gross; use the top-level `amount`
  // as a fallback since it equals the collection total only when fully paid.
  const malipoPaid = Number((malipo.raw as { paidAmount?: unknown }).paidAmount ?? malipo.amount ?? 0);
  const malipoUpdatedAt = String((malipo.raw as { updatedAt?: unknown }).updatedAt ?? "") || null;

  await run(db().from("loan_links").update({
    last_malipo_at: malipoUpdatedAt ?? new Date().toISOString(),
    last_malipo_amount: malipoPaid,
    last_malipo_status: malipo.status,
  }).eq("fineract_loan_id", fineractLoanId));

  const { direction, delta } = driftOf(malipoPaid, loan.totalRepaid);
  if (direction === "equal") return "equal";
  if (direction === "fineract_ahead") {
    log("warn", "malipo_sync.fineract_ahead", {
      loan_id: fineractLoanId, malipo_ref: malipoReference, delta,
      malipo_paid: malipoPaid, fineract_repaid: loan.totalRepaid,
    });
    return "fineract_ahead";
  }

  // malipo_ahead → book the delta. externalId encodes the cumulative so that
  // webhook-driven and tick-driven invocations for the same payment converge
  // on the same key; Fineract dedupes and we never double-book.
  const externalId = `${malipoReference}-cum${malipoPaid}`;
  try {
    const posted = await postRepayment({
      loanId: fineractLoanId,
      amount: delta,
      dateDMYY: formatFineractDate(new Date()),
      externalId,
      paymentTypeId: cfg.malipoFineractPaymentTypeId,
      note: `Via Malipopay ${malipoReference} [sync Δ=${delta}, cum=${malipoPaid}]`,
    });
    log("info", "malipo_sync.drift_booked", {
      loan_id: fineractLoanId, malipo_ref: malipoReference, delta,
      malipo_paid: malipoPaid, fineract_repaid_before: loan.totalRepaid,
      fineract_tx_id: posted.transactionId, external_id: externalId,
    });
    return "booked";
  } catch (e) {
    const err = toAppError(e);
    const looksDuplicate = err.code === "FINERACT_BAD_REQUEST" && /(duplicate|already)/i.test(err.message);
    if (looksDuplicate) {
      log("info", "malipo_sync.drift_already_booked", { loan_id: fineractLoanId, external_id: externalId });
      return "duplicate";
    }
    log("warn", "malipo_sync.drift_book_failed", {
      loan_id: fineractLoanId, malipo_ref: malipoReference, delta,
      external_id: externalId, error: err.code, message: (err.message ?? "").slice(0, 200),
    });
    return "failed";
  }
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
    try {
      const outcome = await reconcileLoan(row.fineract_loan_id, row.malipo_reference);
      switch (outcome) {
        case "equal":                stats.up_to_date++; break;
        case "booked":               stats.drift_booked++; break;
        case "duplicate":            stats.drift_dup++; break;
        case "fineract_ahead":       stats.reverse_drift++; break;
        case "failed":               stats.drift_failed++; break;
        case "malipo_ref_unknown":
        case "skipped_unconfigured": stats.skipped++; break;
      }
    } catch (e) {
      stats.skipped++;
      log("warn", "malipo_sync.loan_skipped", {
        loan_id: row.fineract_loan_id, malipo_ref: row.malipo_reference,
        error: String(e).slice(0, 200),
      });
    }
  }

  return stats;
}
