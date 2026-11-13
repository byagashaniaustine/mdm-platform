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
  addLoanNote,
  createAndApproveLoan,
  createFineractClient,
  disburseLoan,
  fetchRawLoan,
  type FineractLoanSummary,
  getClient,
  getLoan,
  listClients,
  type FineractClientRef,
  listLoanProducts,
  type FineractLoanProductRef,
  updateLoanExternalId,
} from "./bridge/fineract.ts";
import { toAppError } from "../lib/errors.ts";
import { todayDarISO } from "./bridge/automation.ts";

/** Pending = a loan WE created in Fineract (via createLoan below) that hasn't
 *  been linked + disbursed yet. Fineract-originated loans never surface here. */
export interface PendingLoanRow {
  loanId: string;
  accountNo: string | null;
  clientId: string | null;
  clientName: string | null;
  clientEmail: string | null;
  clientMobile: string | null;
  productName: string | null;
  principal: number;
  externalId: string | null;
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

/** One row on the Loan Tracking table — covers every state (pending, active, closed, written off). */
export interface LoanTrackingRow {
  loanId: string;
  accountNo: string | null;
  // One of: pending (approved, no device), active, overdue, closed, written_off, overpaid.
  // The frontend turns this into the colored status tag.
  trackingStatus: "pending" | "active" | "overdue" | "closed" | "written_off" | "overpaid" | "unknown";
  dpd: number;                        // days past due; 0 unless overdue/written_off
  clientName: string | null;
  clientMobile: string | null;
  clientEmail: string | null;
  device: {
    id: string;
    name: string | null;
    model: string | null;
    imei: string | null;
    serialNumber: string | null;
    platform: string | null;
  } | null;                           // null for pending (no device linked yet)
  productName: string | null;
  principalDisbursed: number;         // 0 for pending until disbursal
  totalRepaid: number;
  totalOutstanding: number;
  percentRepaid: number;              // 0–100, derived server-side so the UI stays dumb
  disbursedOn: string | null;
  dueOn: string | null;
  finalDueOn: string | null;
  nextInstallmentAmount: number;
}

export async function listPending(enterpriseId: string): Promise<PendingLoanRow[]> {
  // Drafts = loans we created on this platform that haven't been disbursed yet.
  // Deleted from loan_drafts when linkAndDisburse promotes the row to loan_links.
  const drafts = await run<Array<{
    fineract_loan_id: string;
    product_id: number;
    product_name: string | null;
    client_id: string | null;
    client_name: string | null;
    principal: number;
  }>>(
    db().from("loan_drafts")
      .select("fineract_loan_id, product_id, product_name, client_id, client_name, principal")
      .eq("enterprise_id", enterpriseId)
      .order("created_at", { ascending: false }),
  );

  // Enrich each with client contact. Keep this a per-loan await loop so one
  // bad client fetch doesn't knock out the whole list; drafts list is small.
  const out: PendingLoanRow[] = [];
  for (const d of drafts) {
    let email: string | null = null;
    let mobile: string | null = null;
    if (d.client_id) {
      try {
        const c = await getClient(d.client_id);
        if (c) { email = c.emailAddress; mobile = c.mobileNo; }
      } catch (e) {
        log("warn", "loans.pending.client_fetch_failed", { client_id: d.client_id, error: String(e) });
      }
    }
    out.push({
      loanId: d.fineract_loan_id,
      accountNo: null,
      clientId: d.client_id,
      clientName: d.client_name,
      clientEmail: email,
      clientMobile: mobile,
      productName: d.product_name,
      principal: Number(d.principal),
      externalId: null,
      prelinkedDeviceId: null,
    });
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
    assigned_user: Array<{ user_name: string | null; email: string | null }> | null;
  }>>(
    db().from("devices")
      .select("id, platform, device_name, model, serial_number, imei, assigned_user:mdm_users(user_name,email)")
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
      assigned_user_name: u?.user_name ?? null,
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

  // Step 1: best-effort externalId stamp. CE 1.15 freezes the field once the
  // loan is Approved, which is exactly the state our Loans page operates on.
  // The failure doesn't block us — the webhook finds the loan_links row we're
  // about to insert via fineract_loan_id, no externalId required. We fall
  // back to a loan note so Mapene operators still see the device binding.
  let externalIdStamped = false;
  if (loan.externalId !== externalId) {
    try {
      await updateLoanExternalId(loanId, externalId!);
      externalIdStamped = true;
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "FINERACT_BAD_REQUEST" || err.code === "FINERACT_UNAUTHORIZED") {
        log("info", "loans.external_id_frozen_falling_back_to_note", { loan_id: loanId, code: err.code });
      } else {
        log("warn", "loans.set_external_id_failed", { loan_id: loanId, error: String(e) });
        throw e;
      }
    }
  } else {
    externalIdStamped = true;
  }
  if (!externalIdStamped) {
    try {
      await addLoanNote(loanId, `Device bound by MDM Console. Serial: ${externalId}`);
    } catch (e) {
      // Even the note failed — degrade silently. The loan_links row + webhook
      // handling below are what actually drive the device.
      log("warn", "loans.add_note_failed", { loan_id: loanId, error: String(e) });
    }
  }

  // Pull the draft row (if this loan was created through the platform) so we
  // can carry the admin-supplied contact fields through to loan_links; the
  // reminder path reads only from loan_links.
  const draft = await run<Array<{ client_email: string | null; client_name: string | null; client_mobile: string | null }>>(
    db().from("loan_drafts").select("client_email, client_name, client_mobile")
      .eq("enterprise_id", enterpriseId).eq("fineract_loan_id", loanId).limit(1),
  );
  const draftEmail = draft[0]?.client_email ?? null;
  const draftName = draft[0]?.client_name ?? null;
  const draftMobile = draft[0]?.client_mobile ?? null;

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
      client_name: loan.clientName ?? draftName ?? null,
      // Prefer the admin's typed-in contacts over whatever Fineract stamped
      // (admin probably knows which address/number the customer monitors).
      client_email: draftEmail ?? loan.clientEmail ?? null,
      client_mobile: draftMobile ?? null,
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

  // Step 4: promote complete — remove the draft row so the loan disappears from
  // the Pending section. loan_links is now the authoritative row.
  await db().from("loan_drafts")
    .delete()
    .eq("enterprise_id", enterpriseId).eq("fineract_loan_id", loanId);

  return { loanId, deviceId, externalId: externalId!, disbursedOn: today };
}

// -------------------------------------------------- Platform-initiated create

export interface NewBorrowerInput {
  firstname: string;
  middlename?: string | null;
  lastname: string;
  mobileNo?: string | null;
  emailAddress?: string | null;
}

export interface CreateLoanServiceInput {
  /** Either pick an existing Fineract client… */
  clientId?: string;
  /** …or supply fields to create one inline. Exactly one of the two is required. */
  newBorrower?: NewBorrowerInput;
  productId: number;
  principal: number;
  expectedDisbursementOn: string; // YYYY-MM-DD
  /** Admin-supplied address for repayment reminders; promoted to
   *  loan_links.client_email on linkAndDisburse so fireReminderEmail finds it. */
  clientEmail?: string | null;
  /** Admin-supplied mobile number; stored for SMS reminders (not yet wired)
   *  and shown in the Loans detail modal. Promoted to loan_links.client_mobile
   *  on linkAndDisburse. */
  clientMobile?: string | null;
  numberOfRepayments?: number;
  repaymentEvery?: number;
  repaymentFrequencyType?: number;
  interestRatePerPeriod?: number;
}

/** List Fineract loan products — the "Create loan" form's product picker. */
export async function listProductsForCreate(): Promise<FineractLoanProductRef[]> {
  return await listLoanProducts();
}

/** List Fineract clients — the "Create loan" form's borrower picker. */
export async function listClientsForCreate(): Promise<FineractClientRef[]> {
  return await listClients();
}

/**
 * Create a loan in Fineract (POST + approve), then record a draft row so it
 * appears in the Pending section of the Loans page. Device binding + disburse
 * happen later via the existing Link & disburse flow.
 *
 * Accepts either an existing Fineract clientId or a NewBorrowerInput. When the
 * caller supplies NewBorrowerInput, we POST /clients to Fineract first and
 * feed the returned id into the loan payload. Exactly one of the two inputs
 * must be provided.
 */
export async function createLoan(
  enterpriseId: string,
  adminId: string | null,
  input: CreateLoanServiceInput,
): Promise<{ loanId: string; clientId: string; createdClient: boolean }> {
  if (!(input.principal > 0)) fail("VALIDATION_FAILED", "principal must be > 0");
  if (!input.clientId && !input.newBorrower) {
    fail("VALIDATION_FAILED", "Provide either client_id or new_borrower.");
  }
  if (input.clientId && input.newBorrower) {
    fail("VALIDATION_FAILED", "Provide client_id OR new_borrower, not both.");
  }

  // Resolve product so the draft row carries human-readable context.
  let product: FineractLoanProductRef | null = null;
  try {
    const products = await listLoanProducts();
    product = products.find((p) => p.id === input.productId) ?? null;
  } catch (e) {
    log("warn", "loans.create.product_lookup_failed", { product_id: input.productId, error: String(e) });
  }
  if (!product) fail("VALIDATION_FAILED", `Unknown loan product id=${input.productId}`);

  // Bounds check against the product.
  if (product.minPrincipal != null && input.principal < product.minPrincipal) {
    fail("VALIDATION_FAILED", `Principal ${input.principal} is below the product minimum ${product.minPrincipal}.`);
  }
  if (product.maxPrincipal != null && input.principal > product.maxPrincipal) {
    fail("VALIDATION_FAILED", `Principal ${input.principal} is above the product maximum ${product.maxPrincipal}.`);
  }

  const dateDMY = formatDarDate(parseISODate(input.expectedDisbursementOn));

  // Branch: resolve clientId. If the admin supplied new-borrower fields,
  // POST /clients to Fineract and use the returned id. Otherwise use the
  // picker's clientId straight through.
  let resolvedClientId: string;
  let clientName: string | null = null;
  let createdClient = false;
  if (input.newBorrower) {
    const nb = input.newBorrower;
    if (!nb.firstname.trim() || !nb.lastname.trim()) {
      fail("VALIDATION_FAILED", "firstname and lastname are required for a new borrower.");
    }
    resolvedClientId = await createFineractClient({
      firstname: nb.firstname.trim(),
      middlename: nb.middlename?.trim() || null,
      lastname: nb.lastname.trim(),
      mobileNo: nb.mobileNo || null,
      emailAddress: nb.emailAddress || null,
      activationDateDMY: dateDMY,
    });
    clientName = `${nb.firstname.trim()}${nb.middlename ? ` ${nb.middlename.trim()}` : ""} ${nb.lastname.trim()}`;
    createdClient = true;
  } else {
    resolvedClientId = input.clientId!;
    try {
      const c = await getClient(resolvedClientId);
      if (c) clientName = c.displayName ?? null;
    } catch (e) {
      log("warn", "loans.create.client_lookup_failed", { client_id: resolvedClientId, error: String(e) });
    }
  }

  const loanId = await createAndApproveLoan({
    clientId: resolvedClientId,
    productId: input.productId,
    principal: input.principal,
    numberOfRepayments: input.numberOfRepayments ?? product.numberOfRepayments ?? undefined,
    repaymentEvery: input.repaymentEvery ?? product.repaymentEvery ?? undefined,
    repaymentFrequencyType: input.repaymentFrequencyType ?? product.repaymentFrequencyType ?? undefined,
    interestRatePerPeriod: input.interestRatePerPeriod ?? product.interestRatePerPeriod ?? undefined,
    amortizationType: product.amortizationType ?? undefined,
    interestType: product.interestType ?? undefined,
    interestCalculationPeriodType: product.interestCalculationPeriodType ?? undefined,
    transactionProcessingStrategyCode: product.transactionProcessingStrategyCode ?? undefined,
    expectedDisbursementDateDMY: dateDMY,
    submittedOnDateDMY: dateDMY,
  });

  await run(db().from("loan_drafts").insert({
    enterprise_id: enterpriseId,
    fineract_loan_id: loanId,
    created_by: adminId,
    product_id: input.productId,
    product_name: product.name,
    client_id: resolvedClientId,
    client_name: clientName,
    client_email: input.clientEmail ?? input.newBorrower?.emailAddress ?? null,
    client_mobile: input.clientMobile ?? input.newBorrower?.mobileNo ?? null,
    principal: input.principal,
    expected_disbursement_on: input.expectedDisbursementOn,
  }));

  return { loanId, clientId: resolvedClientId, createdClient };
}

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

interface EmbeddedDevice {
  id: string;
  device_name: string | null;
  model: string | null;
  imei: string | null;
  serial_number: string | null;
  platform: string | null;
}
interface LoanLinkDeviceRow {
  fineract_loan_id: string;
  status: string;
  client_name: string | null;
  client_email: string | null;
  external_id: string | null;
  // PostgREST may render this to-one FK as a single object OR an array
  // depending on client / schema cache state; `unwrapDevice` handles both.
  devices: EmbeddedDevice | EmbeddedDevice[] | null;
}
function unwrapDevice(v: EmbeddedDevice | EmbeddedDevice[] | null | undefined): EmbeddedDevice | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

/** Soft-failure flags surfaced to the Loans page so a silent zero-row result
 *  (Fineract unreachable, breaker open, auth misconfigured) is distinguishable
 *  from a genuine empty state. */
export interface LoanTrackingWarnings {
  pendingUnavailable: boolean;    // listPendingDisbursal threw — pending rows missing
  pendingError?: string;          // short code for the UI, e.g. FINERACT_UNAVAILABLE
}

export interface LoanTrackingResult {
  rows: LoanTrackingRow[];
  warnings: LoanTrackingWarnings;
}

/**
 * Loan tracking list — union of (a) loans already disbursed and linked to devices
 * (from loan_links, enriched live from Fineract) and (b) loans pending disbursal
 * (from Fineract listPendingDisbursal, with the "no device yet" shape).
 *
 * Fineract reads are parallelized; errors on a single loan degrade to a row with
 * the cached fields only so one 500 doesn't blank the whole page. A failure of
 * the pending-fetch is surfaced via `warnings.pendingUnavailable` so the UI can
 * banner it instead of looking empty.
 */
export async function listAll(enterpriseId: string): Promise<LoanTrackingResult> {
  const today = todayDarISO();

  // (a) Disbursed loans (any status) — pulled from our side, enriched live.
  const links = await run<LoanLinkDeviceRow[]>(
    db().from("loan_links")
      .select("fineract_loan_id, status, client_name, client_email, external_id, devices(id, device_name, model, imei, serial_number, platform)")
      .eq("enterprise_id", enterpriseId),
  );
  const disbursedRows = await Promise.all(links.map(async (l): Promise<LoanTrackingRow> => {
    const d = unwrapDevice(l.devices);
    const base: LoanTrackingRow = {
      loanId: l.fineract_loan_id,
      accountNo: null,
      trackingStatus: "unknown",
      dpd: 0,
      clientName: l.client_name,
      clientMobile: null,
      clientEmail: l.client_email,
      device: d ? {
        id: d.id,
        name: d.device_name,
        model: d.model,
        imei: d.imei,
        serialNumber: d.serial_number,
        platform: d.platform,
      } : null,
      productName: null,
      principalDisbursed: 0,
      totalRepaid: 0,
      totalOutstanding: 0,
      percentRepaid: 0,
      disbursedOn: null,
      dueOn: null,
      finalDueOn: null,
      nextInstallmentAmount: 0,
    };
    try {
      const loan = await getLoan(l.fineract_loan_id, today);
      return {
        ...base,
        accountNo: loan.accountNo || null,
        trackingStatus: deriveTrackingStatus(loan.status, loan.dpd),
        dpd: loan.dpd,
        clientName: loan.clientName ?? base.clientName,
        clientEmail: loan.clientEmail ?? base.clientEmail,
        productName: loan.productName,
        principalDisbursed: loan.principalDisbursed,
        totalRepaid: loan.totalRepaid,
        totalOutstanding: loan.totalOutstanding,
        percentRepaid: computePercentRepaid(loan.totalRepaid, loan.principalDisbursed),
        disbursedOn: loan.disbursedOn,
        dueOn: loan.dueOn,
        finalDueOn: loan.finalDueOn,
        nextInstallmentAmount: loan.nextInstallmentAmount,
      };
    } catch (e) {
      log("warn", "loans.list_all.fineract_fetch_failed", { loan_id: l.fineract_loan_id, error: String(e) });
      // Fall back to the link's cached fields; status best-effort from the link row.
      return {
        ...base,
        trackingStatus: l.status === "closed" ? "closed" : l.status === "written_off" ? "written_off" : "unknown",
      };
    }
  }));

  // (b) Pending disbursal — from loan_drafts (loans we created via the Loans
  // page that aren't disbursed yet). Fineract-originated loans never surface
  // here; dropping Fineract's listPendingDisbursal also made the "pending
  // banner" obsolete.
  const drafts = await run<Array<{
    fineract_loan_id: string;
    product_name: string | null;
    client_name: string | null;
    principal: number;
  }>>(
    db().from("loan_drafts")
      .select("fineract_loan_id, product_name, client_name, principal")
      .eq("enterprise_id", enterpriseId),
  );
  const linkedLoanIds = new Set(links.map((l) => l.fineract_loan_id));
  const pendingRows: LoanTrackingRow[] = drafts
    .filter((d) => !linkedLoanIds.has(d.fineract_loan_id))
    .map((d) => ({
      loanId: d.fineract_loan_id,
      accountNo: null,
      trackingStatus: "pending",
      dpd: 0,
      clientName: d.client_name,
      clientMobile: null,
      clientEmail: null,
      device: null,
      productName: d.product_name,
      principalDisbursed: Number(d.principal),
      totalRepaid: 0,
      totalOutstanding: Number(d.principal),
      percentRepaid: 0,
      disbursedOn: null,
      dueOn: null,
      finalDueOn: null,
      nextInstallmentAmount: 0,
    }));

  const warnings: LoanTrackingWarnings = { pendingUnavailable: false };
  return { rows: [...pendingRows, ...disbursedRows], warnings };
}

function deriveTrackingStatus(status: string, dpd: number): LoanTrackingRow["trackingStatus"] {
  if (status === "closed") return "closed";
  if (status === "written_off") return "written_off";
  if (status === "overpaid") return "overpaid";
  if (status === "approved" || status === "pending") return "pending";
  if (status === "active") return dpd > 0 ? "overdue" : "active";
  return "unknown";
}

function computePercentRepaid(totalRepaid: number, principal: number): number {
  if (!(principal > 0)) return 0;
  const pct = (totalRepaid / principal) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return Math.round(pct * 10) / 10;   // one decimal is enough for a progress bar label
}

/** One loan's full tracking detail — expanded view for the row-click modal. */
export interface LoanTrackingDetail extends LoanTrackingRow {
  schedule: Array<{
    period: number;
    dueDate: string | null;
    principalDue: number;
    interestDue: number;
    feesDue: number;
    totalDue: number;
    totalPaid: number;
    outstanding: number;
    complete: boolean;
    daysOverdue: number;
  }>;
  lockEvents: Array<{
    id: string;
    action: string;
    state: string;
    actionTime: string | null;
    completedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
  tierState: {
    desiredTier: string | null;
    appliedTier: string | null;
    observedState: string | null;
    observedAt: string | null;
    lastLoanDpd: number | null;
    lastError: string | null;
  } | null;
  // Derived checks reconciling Mapene loan state ↔ device tier/lock state ↔ MalipoPay.
  // Computed cheaply on read so the detail view is always current; a daily worker
  // (reconciliation_findings table, task #16) will persist these for alerting.
  reconciliation: Array<{
    check: string;
    state: "ok" | "warn" | "mismatch" | "pending";
    detail: string;
  }>;
}

export async function getTrackingDetail(enterpriseId: string, loanId: string): Promise<LoanTrackingDetail> {
  const today = todayDarISO();

  // Live Fineract read first — authoritative on all monetary fields.
  const loan = await getLoan(loanId, today);

  // Pull the loan_links row (and its device) for the enterprise-scoped device identity.
  // Keep the query tolerant: a still-pending loan has no loan_links row yet.
  const [linkRow] = await run<Array<LoanLinkDeviceRow & { client_mobile: string | null }>>(
    db().from("loan_links")
      .select("fineract_loan_id, status, client_name, client_email, client_mobile, external_id, devices(id, device_name, model, imei, serial_number, platform)")
      .eq("enterprise_id", enterpriseId).eq("fineract_loan_id", loanId).limit(1),
  );
  const d = unwrapDevice(linkRow?.devices);

  // Client mobile: prefer the admin-typed value stored on loan_links. Fall
  // back to live Fineract (same chain the Loans list uses). Pending-only loans
  // (no loan_link yet) fall back to loan_drafts.client_mobile.
  let clientMobile: string | null = linkRow?.client_mobile ?? null;
  if (!clientMobile) {
    const [draft] = await run<Array<{ client_mobile: string | null }>>(
      db().from("loan_drafts").select("client_mobile")
        .eq("enterprise_id", enterpriseId).eq("fineract_loan_id", loanId).limit(1),
    );
    clientMobile = draft?.client_mobile ?? null;
  }
  if (!clientMobile && loan.clientId) {
    try {
      const c = await getClient(loan.clientId);
      if (c) clientMobile = c.mobileNo ?? null;
    } catch (e) {
      log("warn", "loans.detail.client_fetch_failed", { loan_id: loanId, error: String(e) });
    }
  }

  const schedule = await fetchLoanSchedule(loanId, today);

  // Device tier state (desired → applied → observed) for reconciliation.
  let tierState: LoanTrackingDetail["tierState"] = null;
  if (d?.id) {
    const [tsRow] = await run<Array<{ desired_tier: string | null; applied_tier: string | null; observed_state: string | null; observed_at: string | null; last_loan_dpd: number | null; last_error: string | null }>>(
      db().from("device_tier_state")
        .select("desired_tier, applied_tier, observed_state, observed_at, last_loan_dpd, last_error")
        .eq("enterprise_id", enterpriseId).eq("device_id", d.id).limit(1),
    );
    if (tsRow) {
      tierState = {
        desiredTier: tsRow.desired_tier,
        appliedTier: tsRow.applied_tier,
        observedState: tsRow.observed_state,
        observedAt: tsRow.observed_at,
        lastLoanDpd: tsRow.last_loan_dpd,
        lastError: tsRow.last_error,
      };
    }
  }

  // Lock/unlock events scoped to this loan's device, newest first.
  let lockEvents: LoanTrackingDetail["lockEvents"] = [];
  if (d?.id) {
    const rows = await run<Array<{ id: string; action: string; state: string; action_time: string | null; completed_at: string | null; error_code: string | null; error_message: string | null }>>(
      db().from("events")
        .select("id, action, state, action_time, completed_at, error_code, error_message")
        .eq("enterprise_id", enterpriseId)
        .eq("device_id", d.id)
        .in("action", ["device.lock", "device.unlock", "device.lost_mode_enable", "device.lost_mode_disable"])
        .order("action_time", { ascending: false })
        .limit(50),
    );
    lockEvents = rows.map((r) => ({
      id: r.id,
      action: r.action,
      state: r.state,
      actionTime: r.action_time,
      completedAt: r.completed_at,
      errorCode: r.error_code,
      errorMessage: r.error_message,
    }));
  }

  const reconciliation = buildReconciliation(loan, tierState, lockEvents);

  return {
    loanId: loan.loanId,
    accountNo: loan.accountNo || null,
    trackingStatus: deriveTrackingStatus(loan.status, loan.dpd),
    dpd: loan.dpd,
    clientName: loan.clientName ?? linkRow?.client_name ?? null,
    clientMobile,
    clientEmail: loan.clientEmail ?? linkRow?.client_email ?? null,
    device: d ? {
      id: d.id,
      name: d.device_name,
      model: d.model,
      imei: d.imei,
      serialNumber: d.serial_number,
      platform: d.platform,
    } : null,
    productName: loan.productName,
    principalDisbursed: loan.principalDisbursed,
    totalRepaid: loan.totalRepaid,
    totalOutstanding: loan.totalOutstanding,
    percentRepaid: computePercentRepaid(loan.totalRepaid, loan.principalDisbursed),
    disbursedOn: loan.disbursedOn,
    dueOn: loan.dueOn,
    finalDueOn: loan.finalDueOn,
    nextInstallmentAmount: loan.nextInstallmentAmount,
    schedule,
    lockEvents,
    tierState,
    reconciliation,
  };
}

/**
 * Reconciliation derivation. Compares Mapene loan state against the device's
 * tier state and recent lock events. Each check returns ok (fully consistent),
 * warn (soft drift — in-flight or recoverable), mismatch (loud inconsistency
 * ops should act on), or pending (dependency not yet integrated — MalipoPay).
 *
 * The daily worker (task #16) will run this same shape across all loans and
 * persist findings; the detail view calls it inline so the UI is always live.
 */
function buildReconciliation(
  loan: FineractLoanSummary,
  tierState: LoanTrackingDetail["tierState"],
  lockEvents: LoanTrackingDetail["lockEvents"],
): LoanTrackingDetail["reconciliation"] {
  const out: LoanTrackingDetail["reconciliation"] = [];

  // (1) Mapene loan status vs device tier intent.
  // Active + overdue → the device should be moving toward or already at 'locked';
  // closed → device should be 'released'; approved/pending → undisbursed is fine.
  if (!tierState) {
    out.push({
      check: "Loan vs device tier",
      state: loan.status === "approved" || loan.status === "pending" ? "ok" : "warn",
      detail: tierState
        ? "No tier state recorded for this device yet."
        : "No tier state recorded — automation hasn't acted on this device yet.",
    });
  } else {
    const desired = tierState.desiredTier;
    if (loan.status === "closed" && desired && desired !== "released" && desired !== "closed") {
      out.push({ check: "Loan vs device tier", state: "mismatch", detail: `Loan closed but desired tier is "${desired}" (expected "released").` });
    } else if (loan.status === "active" && loan.dpd >= 3 && desired !== "locked") {
      out.push({ check: "Loan vs device tier", state: "mismatch", detail: `Loan is ${loan.dpd} days past due but desired tier is "${desired ?? "unset"}" (expected "locked").` });
    } else if (loan.status === "written_off" && desired !== "locked") {
      out.push({ check: "Loan vs device tier", state: "mismatch", detail: `Loan written off but desired tier is "${desired ?? "unset"}".` });
    } else {
      out.push({ check: "Loan vs device tier", state: "ok", detail: `Desired tier: ${desired ?? "unset"}.` });
    }

    // (2) Desired vs applied vs observed drift. "In flight" is a warn, divergence is a mismatch.
    const desiredT = tierState.desiredTier;
    const appliedT = tierState.appliedTier;
    const observedT = tierState.observedState;
    if (!appliedT && desiredT) {
      out.push({ check: "Tier apply state", state: "warn", detail: `Desired "${desiredT}" not yet applied.` });
    } else if (desiredT && appliedT && desiredT !== appliedT) {
      out.push({ check: "Tier apply state", state: "mismatch", detail: `Desired "${desiredT}" but applied "${appliedT}"${tierState.lastError ? ` (${tierState.lastError})` : ""}.` });
    } else if (appliedT && observedT && observedT !== "unknown" && appliedT !== observedT) {
      out.push({ check: "Tier apply state", state: "mismatch", detail: `We think tier is "${appliedT}" but Zoho reports "${observedT}".` });
    } else if (appliedT) {
      out.push({ check: "Tier apply state", state: "ok", detail: `Applied "${appliedT}"${observedT && observedT !== "unknown" ? `, Zoho confirms "${observedT}"` : ""}.` });
    }
  }

  // (3) Most recent lock event vs the current loan state.
  const lastLock = lockEvents.find((e) => e.action === "device.lock");
  const lastUnlock = lockEvents.find((e) => e.action === "device.unlock");
  const latest = [lastLock, lastUnlock]
    .filter(Boolean)
    .sort((a, b) => (b!.actionTime ?? "").localeCompare(a!.actionTime ?? ""))[0];
  if (latest) {
    const wasLock = latest.action === "device.lock";
    const expectsLocked = loan.status === "active" ? loan.dpd >= 3 : loan.status === "written_off";
    if (wasLock && !expectsLocked && latest.state === "succeeded") {
      out.push({ check: "Lock action vs loan state", state: "warn", detail: `Device locked at ${latest.actionTime ?? "—"} but loan is now ${loan.status}${loan.dpd ? ` (${loan.dpd}d dpd)` : ""}.` });
    } else if (!wasLock && expectsLocked && latest.state === "succeeded") {
      out.push({ check: "Lock action vs loan state", state: "warn", detail: `Device unlocked at ${latest.actionTime ?? "—"} but loan is overdue (${loan.dpd}d).` });
    } else if (latest.state === "failed" || latest.state === "dead") {
      out.push({ check: "Lock action vs loan state", state: "mismatch", detail: `Latest ${latest.action.replace(/^device\./, "")} failed: ${latest.errorMessage ?? latest.errorCode ?? "no reason"}.` });
    } else {
      out.push({ check: "Lock action vs loan state", state: "ok", detail: `Most recent action: ${latest.action.replace(/^device\./, "")} · ${latest.state}.` });
    }
  }

  // (4) MalipoPay reconciliation — stubbed until the integration ships.
  // Task #17 fills this in by looking up last payment ref + amount for the loan.
  out.push({
    check: "MalipoPay payments",
    state: "pending",
    detail: "MalipoPay integration not wired yet. Will compare last payment vs Mapene totalRepaid once live.",
  });

  return out;
}

/** Flatten Fineract's repaymentSchedule.periods into a UI-friendly shape. */
async function fetchLoanSchedule(loanId: string, todayISO: string): Promise<LoanTrackingDetail["schedule"]> {
  try {
    const raw = await fetchRawLoan(loanId);
    const periods = ((raw?.repaymentSchedule as { periods?: Array<Record<string, unknown>> } | undefined)?.periods ?? []) as Array<Record<string, unknown>>;
    return periods
      .filter((p) => p.period !== undefined && p.dueDate !== undefined)
      .map((p) => {
        const due = coerceDateArray(p.dueDate);
        const complete = Boolean(p.complete) || Boolean(p.obligationsMetOnDate);
        return {
          period: Number(p.period ?? 0),
          dueDate: due,
          principalDue: Number(p.principalDue ?? p.principalOriginalDue ?? 0),
          interestDue: Number(p.interestDue ?? p.interestOriginalDue ?? 0),
          feesDue: Number(p.feeChargesDue ?? 0) + Number(p.penaltyChargesDue ?? 0),
          totalDue: Number(p.totalDueForPeriod ?? 0),
          totalPaid: Number(p.totalPaidForPeriod ?? 0),
          outstanding: Number(p.totalOutstandingForPeriod ?? 0),
          complete,
          daysOverdue: complete || !due ? 0 : Math.max(0, daysBetweenISO(todayISO, due)),
        };
      });
  } catch (e) {
    log("warn", "loans.detail.schedule_fetch_failed", { loan_id: loanId, error: String(e) });
    return [];
  }
}

function coerceDateArray(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [y, m, d] = v as number[];
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysBetweenISO(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  return Math.round((Date.UTC(fy, fm - 1, fd) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

/** Fineract renders dates as `dd MMMM yyyy`. Match the configured locale. */
function formatDarDate(now: Date): string {
  const dar = new Date(now.getTime() + 3 * 3_600_000);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${String(dar.getUTCDate()).padStart(2, "0")} ${months[dar.getUTCMonth()]} ${dar.getUTCFullYear()}`;
}
