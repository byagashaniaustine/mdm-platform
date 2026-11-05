// Loan-origination glue for the Console's Loans page. Reads approved-pending
// loans from Mapene (Fineract), lists devices still available for financing
// from our DB, and binds the two with a single link-and-disburse action.
//
// Fineract remains source of truth for loan state; our DB stays source of
// truth for device inventory. The `loan_links` row written here is what the
// DISBURSE webhook later finds, skipping the fragile externalId auto-link
// path (see automation.ts § auto_link_no_device).
import { db, run } from "../lib/db.ts";
import { appError, fail } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import {
  disburseLoan,
  type FineractPendingLoan,
  getClient,
  getLoan,
  listPendingDisbursal,
  updateLoanExternalId,
} from "./bridge/fineract.ts";
import { todayDarISO } from "./bridge/automation.ts";

export interface PendingLoanRow extends FineractPendingLoan {
  clientEmail: string | null;
  clientMobile: string | null;
  // If the loan already has an externalId stamped AND it matches a device in
  // our DB, pre-fill the picker with that device so the admin can one-click
  // disburse. null means nothing pre-matched.
  prelinkedDeviceId: string | null;
}

/** Device row shown in the "available for financing" picker. */
export interface AvailableDevice {
  id: string;
  platform: string;
  device_name: string | null;
  model: string | null;
  serial_number: string | null;
  imei: string | null;
  assigned_user_name: string | null;
  assigned_user_email: string | null;
}

export async function listPending(enterpriseId: string): Promise<PendingLoanRow[]> {
  const loans = await listPendingDisbursal();
  // Enrich each with client contact. Keep this a per-loan await loop so one
  // bad client fetch doesn't knock out the whole list; the list is small.
  const out: PendingLoanRow[] = [];
  for (const l of loans) {
    let email: string | null = null;
    let mobile: string | null = null;
    if (l.clientId) {
      const c = await getClient(l.clientId);
      if (c) { email = c.emailAddress; mobile = c.mobileNo; }
    }
    let prelinkedDeviceId: string | null = null;
    if (l.externalId) {
      // Match against serial or imei — mirrors findDeviceByExternalId in automation.ts.
      const d = await run<Array<{ id: string }>>(
        db().from("devices").select("id")
          .eq("enterprise_id", enterpriseId).eq("is_removed", false)
          .or(`serial_number.eq.${l.externalId},imei.eq.${l.externalId}`)
          .limit(1),
      );
      if (d.length) prelinkedDeviceId = d[0].id;
    }
    out.push({ ...l, clientEmail: email, clientMobile: mobile, prelinkedDeviceId });
  }
  return out;
}

export async function listAvailableDevices(enterpriseId: string): Promise<AvailableDevice[]> {
  // Devices in this enterprise, not removed, with no active loan_link.
  // Supabase renders a FK join as an array even when it's one-to-one, so the
  // assigned_user column comes back as [{name,email}] | []; unwrap below.
  const rows = await run<Array<{
    id: string; platform: string; device_name: string | null; model: string | null;
    serial_number: string | null; imei: string | null;
    assigned_user: Array<{ name: string | null; email: string | null }> | null;
  }>>(
    db().from("devices")
      .select("id, platform, device_name, model, serial_number, imei, assigned_user:mdm_users(name,email)")
      .eq("enterprise_id", enterpriseId).eq("is_removed", false),
  );
  const activeLoanDevices = await run<Array<{ device_id: string }>>(
    db().from("loan_links").select("device_id").eq("enterprise_id", enterpriseId).eq("status", "active"),
  );
  const taken = new Set(activeLoanDevices.map((r) => r.device_id));
  return rows.filter((r) => !taken.has(r.id)).map((r) => {
    const u = Array.isArray(r.assigned_user) ? r.assigned_user[0] ?? null : r.assigned_user;
    return {
      id: r.id,
      platform: r.platform,
      device_name: r.device_name,
      model: r.model,
      serial_number: r.serial_number,
      imei: r.imei,
      assigned_user_name: u?.name ?? null,
      assigned_user_email: u?.email ?? null,
    };
  });
}

/**
 * Bind one Fineract loan to one of our devices and immediately disburse it.
 * Three writes in a strict order so failure midway leaves recoverable state:
 *   1. Fineract: PUT loan.externalId = device.serial_number. If this fails we
 *      haven't touched our DB; admin can retry.
 *   2. Our DB: INSERT loan_links row (status='active'). Must succeed before
 *      the disburse — otherwise the DISBURSE webhook arrives, finds no
 *      loan_links row, and falls back to auto-link (which may or may not find
 *      the device depending on serial vs imei match).
 *   3. Fineract: POST disburse. If this fails, the loan_links row stays
 *      active but the loan is Approved; admin can retry the disburse button.
 */
export async function linkAndDisburse(
  enterpriseId: string,
  loanId: string,
  deviceId: string,
  principal: number,
): Promise<{ loanId: string; deviceId: string; externalId: string; disbursedOn: string }> {
  if (!(principal > 0)) fail("VALIDATION_FAILED", "principal must be a positive number.");
  // Load device + verify ownership. Two separate conditions on purpose: don't
  // leak existence of cross-enterprise devices via distinguishable errors.
  const device = await run<Array<{ id: string; enterprise_id: string; serial_number: string | null; imei: string | null; is_removed: boolean }>>(
    db().from("devices").select("id, enterprise_id, serial_number, imei, is_removed").eq("id", deviceId).limit(1),
  );
  if (!device.length || device[0].enterprise_id !== enterpriseId || device[0].is_removed) {
    fail("NOT_FOUND", "Device not available for financing.");
  }
  const d = device[0];
  const externalId = d.serial_number || d.imei;
  if (!externalId) fail("VALIDATION_FAILED", "Device has neither serial nor IMEI; cannot be used as loan externalId.");

  // Device must not already have an active loan link.
  const existingLink = await run<Array<{ id: string }>>(
    db().from("loan_links").select("id").eq("enterprise_id", enterpriseId).eq("device_id", deviceId).eq("status", "active"),
  );
  if (existingLink.length) fail("VALIDATION_FAILED", "Device already has an active loan link.");

  // Load loan from Fineract, confirm Approved state. Don't trust client claim.
  const today = todayDarISO();
  const loan = await getLoan(loanId, today);
  if (loan.status !== "approved") {
    fail("VALIDATION_FAILED", `Loan is in '${loan.status}' state; only 'approved' loans can be linked and disbursed.`);
  }

  // Step 1: stamp externalId. If already set to the same value we skip the PUT.
  if (loan.externalId !== externalId) {
    try {
      await updateLoanExternalId(loanId, externalId!);
    } catch (e) {
      log("warn", "loans.set_external_id_failed", { loan_id: loanId, error: String(e) });
      throw e;
    }
  }

  // Step 2: pre-create loan_links row so the DISBURSE webhook finds it on
  // first delivery. Carry client identity if we have it — the automation
  // enrichment pass will backfill anything missing on subsequent webhooks.
  try {
    await run(db().from("loan_links").insert({
      enterprise_id: enterpriseId,
      device_id: deviceId,
      fineract_loan_id: loanId,
      fineract_client_id: loan.clientId ?? null,
      external_id: externalId,
      product_id: loan.productId,
      disbursed_on: loan.disbursedOn ?? today,
      due_on: loan.dueOn ?? null,
      status: "active",
      client_name: loan.clientName ?? null,
      client_email: loan.clientEmail ?? null,
    }));
  } catch (e) {
    log("warn", "loans.loan_link_insert_failed", { loan_id: loanId, device_id: deviceId, error: String(e) });
    throw appError("CONFLICT", "Failed to create loan link; nothing on Fineract was disbursed yet.");
  }

  // Step 3: fire disburse. If this throws, the loan_links row stays and the
  // admin can hit disburse again.
  const dateDMY = formatDarDate(new Date());
  try {
    await disburseLoan(loanId, principal, dateDMY);
  } catch (e) {
    log("warn", "loans.disburse_failed", { loan_id: loanId, device_id: deviceId, error: String(e) });
    throw e;
  }

  return { loanId, deviceId, externalId: externalId!, disbursedOn: today };
}

/** Fineract renders dates as `dd MMMM yyyy`. Match the configured locale. */
function formatDarDate(now: Date): string {
  const dar = new Date(now.getTime() + 3 * 3_600_000);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${String(dar.getUTCDate()).padStart(2, "0")} ${months[dar.getUTCMonth()]} ${dar.getUTCFullYear()}`;
}
