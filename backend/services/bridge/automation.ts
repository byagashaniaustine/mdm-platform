// Loan-automation orchestration. Two entrypoints:
//   - onEvent(enterpriseId, trigger, loan?): called by the Fineract webhook route.
//     Phase 0 just funnels into a single-link reconcile.
//   - dailyTick(enterpriseId): called by worker.ts on the AUTOMATION_TICK_MINUTES
//     cadence. Reconciles every active loan link for the enterprise.
// Both run under withLease so a scaled-out deployment never double-processes an
// enterprise. See LOAN_DEVICE_AUTOMATION.md §9 (triggers) and §10 (apply path).
import { db, run } from "../../lib/db.ts";
import { withLease } from "../../lib/lease.ts";
import { log } from "../../lib/log.ts";
import { getLoan, type FineractLoanSummary } from "./fineract.ts";
import { reconcileBatch, type ReconcileBatchResult } from "./reconcile.ts";

/**
 * Africa/Dar_es_Salaam "today" as YYYY-MM-DD. Spec §15: compute DPD in one fixed
 * TZ. Dar is UTC+3 year-round (no DST), so a simple offset works and avoids
 * pulling in a timezone library.
 */
export function todayDarISO(now: Date = new Date()): string {
  const dar = new Date(now.getTime() + 3 * 3_600_000);
  return `${dar.getUTCFullYear()}-${String(dar.getUTCMonth() + 1).padStart(2, "0")}-${String(dar.getUTCDate()).padStart(2, "0")}`;
}

/** Webhook-triggered reconcile. loanOverride, if provided, skips the Fineract fetch. */
export async function onEvent(
  enterpriseId: string,
  trigger: string,
  loanOverride?: FineractLoanSummary,
): Promise<ReconcileBatchResult | null> {
  return await withLease(`automation:${enterpriseId}`, 120, async () => {
    const today = todayDarISO();
    return await reconcileBatch(enterpriseId, today, trigger, loanOverride ? [loanOverride] : undefined);
  });
}

/** Daily (or hourly) tick — reconcile every active loan_link in the enterprise. */
export async function dailyTick(enterpriseId: string): Promise<ReconcileBatchResult | null> {
  return await withLease(`automation:${enterpriseId}`, 300, async () => {
    const today = todayDarISO();
    return await reconcileBatch(enterpriseId, today, "daily_tick");
  });
}

/** For the worker loop: find every enterprise that has automation settings and tick it. */
export async function dailyTickAll(): Promise<void> {
  const rows = await run<Array<{ enterprise_id: string }>>(
    db().from("automation_settings").select("enterprise_id").eq("enabled", true),
  );
  for (const r of rows) {
    try {
      await dailyTick(r.enterprise_id);
    } catch (e) {
      log("warn", "automation.tick_failed", { enterprise_id: r.enterprise_id, error: String(e) });
    }
  }
}

/** Resolve a Fineract loan to its linked device so the webhook can target reconcile. */
export async function resolveLoanToEnterprise(fineractLoanId: string): Promise<{ enterpriseId: string } | null> {
  const row = await run<Array<{ enterprise_id: string }>>(
    db().from("loan_links").select("enterprise_id").eq("fineract_loan_id", fineractLoanId).eq("status", "active").limit(1),
  );
  return row.length ? { enterpriseId: row[0].enterprise_id } : null;
}

/** Convenience for the webhook: fetch the loan once, then reconcile the single-device batch. */
export async function onLoanEvent(fineractLoanId: string, trigger: string): Promise<ReconcileBatchResult | null> {
  const resolved = await resolveLoanToEnterprise(fineractLoanId);
  if (!resolved) {
    log("info", "automation.unlinked_loan", { fineract_loan_id: fineractLoanId, trigger });
    return null;
  }
  const today = todayDarISO();
  let loan: FineractLoanSummary | undefined;
  try {
    loan = await getLoan(fineractLoanId, today);
  } catch (e) {
    log("warn", "automation.loan_fetch_failed_webhook", { fineract_loan_id: fineractLoanId, error: String(e) });
  }
  return await onEvent(resolved.enterpriseId, trigger, loan);
}
