// Loan-automation orchestration. Two entrypoints:
//   - onEvent(enterpriseId, trigger, loan?): called by the Fineract webhook route.
//     Phase 0 just funnels into a single-link reconcile.
//   - dailyTick(enterpriseId): called by worker.ts on the AUTOMATION_TICK_MINUTES
//     cadence. Reconciles every active loan link for the enterprise.
// Both run under withLease so a scaled-out deployment never double-processes an
// enterprise. See LOAN_DEVICE_AUTOMATION.md §9 (triggers) and §10 (apply path).
import { db, run, runMaybe } from "../../lib/db.ts";
import { withLease } from "../../lib/lease.ts";
import { log } from "../../lib/log.ts";
import { getClient, getLoan, type FineractLoanSummary } from "./fineract.ts";
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

/** Daily (or hourly) tick — reconcile every active loan_link in the enterprise.
 *  Runs inline (syncApply) because the worker loop that invokes it is already
 *  the "background" context — enqueuing would just push work to the next tick. */
export async function dailyTick(enterpriseId: string): Promise<ReconcileBatchResult | null> {
  return await withLease(`automation:${enterpriseId}`, 300, async () => {
    const today = todayDarISO();
    return await reconcileBatch(enterpriseId, today, "daily_tick", undefined, { syncApply: true });
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
export async function resolveLoanToEnterprise(fineractLoanId: string): Promise<{ enterpriseId: string; deviceId: string } | null> {
  const row = await run<Array<{ enterprise_id: string; device_id: string }>>(
    db().from("loan_links").select("enterprise_id, device_id").eq("fineract_loan_id", fineractLoanId).eq("status", "active").limit(1),
  );
  return row.length ? { enterpriseId: row[0].enterprise_id, deviceId: row[0].device_id } : null;
}

/**
 * Keep the loan_links row in sync with the Fineract source of truth. Called
 * on every webhook so client_name / client_email / due_on / status reflect
 * reality — then fireReminderEmail can prefer loan_links.client_email over the
 * device-user fallback. Matches on the partial unique index
 * (enterprise_id, fineract_loan_id) WHERE status='active' from migration 021.
 */
export async function upsertLoanLink(
  enterpriseId: string,
  deviceId: string,
  loan: FineractLoanSummary,
): Promise<void> {
  // Email fallback chain: inline on the loan response, then /clients/{id},
  // else leave null. Current client row may not have fetched email yet.
  let clientEmail = loan.clientEmail;
  let clientName = loan.clientName;
  if (!clientEmail && loan.clientId) {
    const c = await getClient(loan.clientId);
    if (c) {
      clientEmail = c.emailAddress ?? null;
      clientName = clientName ?? c.displayName ?? null;
    }
  }

  const nowIso = new Date().toISOString();
  const status = loan.status === "closed" || loan.status === "written_off" ? "closed" : "active";
  const closedOn = status === "closed" ? todayDarISO() : null;

  // Try update first (preserves created_at + status=closed history rows). If
  // nothing matched, insert. We can't use .upsert() because the unique index
  // is partial (WHERE status='active'); supabase doesn't honor partial-index
  // conflict targets reliably across versions.
  const existing = await runMaybe<{ id: string }>(
    db().from("loan_links").select("id")
      .eq("enterprise_id", enterpriseId)
      .eq("fineract_loan_id", loan.loanId)
      .eq("status", "active")
      .maybeSingle(),
  );
  if (existing) {
    await run(db().from("loan_links").update({
      device_id: deviceId,
      fineract_client_id: loan.clientId ?? null,
      external_id: loan.externalId ?? null,
      product_id: loan.productId,
      disbursed_on: loan.disbursedOn ?? null,
      due_on: loan.dueOn ?? null,
      status,
      closed_on: closedOn,
      client_name: clientName ?? null,
      client_email: clientEmail ?? null,
    }).eq("id", existing.id));
  } else {
    await run(db().from("loan_links").insert({
      enterprise_id: enterpriseId,
      device_id: deviceId,
      fineract_loan_id: loan.loanId,
      fineract_client_id: loan.clientId ?? null,
      external_id: loan.externalId ?? null,
      product_id: loan.productId,
      disbursed_on: loan.disbursedOn ?? null,
      due_on: loan.dueOn ?? null,
      status,
      closed_on: closedOn,
      client_name: clientName ?? null,
      client_email: clientEmail ?? null,
    }));
    log("info", "automation.loan_link_created", { enterprise_id: enterpriseId, device_id: deviceId, fineract_loan_id: loan.loanId });
  }
  // Suppress unused-var warning on nowIso in this branch; kept for future audit timestamp.
  void nowIso;
}

/**
 * Resolve a device by the externalId Fineract stamped on the loan. We accept:
 *   1. exact serial_number match
 *   2. "SIM-<serial>" prefix (sim convention) ↔ raw serial
 *   3. imei match
 * All variants require is_removed=false. First hit wins; returns null if
 * nothing matches so the webhook can fall through to "unlinked" logging.
 */
async function findDeviceByExternalId(externalId: string): Promise<{ enterpriseId: string; deviceId: string } | null> {
  const serialCandidates = externalId.startsWith("SIM-")
    ? [externalId.slice(4), externalId]
    : [externalId, `SIM-${externalId}`];
  for (const cand of serialCandidates) {
    const row = await runMaybe<{ id: string; enterprise_id: string }>(
      db().from("devices").select("id, enterprise_id")
        .eq("serial_number", cand).eq("is_removed", false).maybeSingle(),
    );
    if (row) return { enterpriseId: row.enterprise_id, deviceId: row.id };
  }
  const byImei = await runMaybe<{ id: string; enterprise_id: string }>(
    db().from("devices").select("id, enterprise_id")
      .eq("imei", externalId).eq("is_removed", false).maybeSingle(),
  );
  return byImei ? { enterpriseId: byImei.enterprise_id, deviceId: byImei.id } : null;
}

/**
 * Convenience for the webhook: fetch the loan once, enrich the link, then
 * reconcile. If no loan_links row exists yet, try auto-linking by
 * loan.externalId → devices.serial_number — the production path where
 * Fineract's DISBURSE event is the trigger with no prior manual registration.
 */
export async function onLoanEvent(fineractLoanId: string, trigger: string): Promise<ReconcileBatchResult | null> {
  let resolved = await resolveLoanToEnterprise(fineractLoanId);
  const today = todayDarISO();
  let loan: FineractLoanSummary | undefined;
  try {
    loan = await getLoan(fineractLoanId, today);
  } catch (e) {
    log("warn", "automation.loan_fetch_failed_webhook", { fineract_loan_id: fineractLoanId, error: String(e) });
  }

  // Auto-link path: unknown loan + Fineract gave us an externalId → look up
  // the device by serial/IMEI. First DISBURSE on a loan whose externalId is a
  // device serial creates the loan_links row here, no human in the loop.
  if (!resolved && loan?.externalId) {
    const auto = await findDeviceByExternalId(loan.externalId);
    if (auto) {
      try {
        await upsertLoanLink(auto.enterpriseId, auto.deviceId, loan);
        resolved = auto;
        log("info", "automation.loan_auto_linked", {
          fineract_loan_id: fineractLoanId, device_id: auto.deviceId,
          enterprise_id: auto.enterpriseId, external_id: loan.externalId, trigger,
        });
      } catch (e) {
        log("warn", "automation.auto_link_failed", { fineract_loan_id: fineractLoanId, error: String(e) });
      }
    } else {
      log("info", "automation.auto_link_no_device", { fineract_loan_id: fineractLoanId, external_id: loan.externalId });
    }
  }

  if (!resolved) {
    log("info", "automation.unlinked_loan", { fineract_loan_id: fineractLoanId, trigger, external_id: loan?.externalId ?? null });
    return null;
  }

  // Enrich on every event so a late-arriving email or a Fineract-side edit
  // to the client propagates to loan_links on the next webhook. Also runs on
  // the auto-link path to catch any field that upsertLoanLink's first call
  // left null (notably clientEmail from /clients/{id}).
  if (loan) {
    try { await upsertLoanLink(resolved.enterpriseId, resolved.deviceId, loan); }
    catch (e) { log("warn", "automation.loan_link_upsert_failed", { fineract_loan_id: fineractLoanId, error: String(e) }); }
  }
  return await onEvent(resolved.enterpriseId, trigger, loan);
}
