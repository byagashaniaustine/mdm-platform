// Fineract REST client for the loan-driven automation Bridge. HTTP Basic auth +
// `Fineract-Platform-TenantId` header. Phase 0 only needs reads — list active
// loans and fetch one with its repayment schedule. No DB writes here.
//
// See LOAN_DEVICE_AUTOMATION.md §12.1 (contract) and §18.1 (preconditions).
// Credentials live in getConfig(); if fineractBaseUrl is empty, every call
// throws FINERACT_UNCONFIGURED so the server can boot without Fineract set up.
import { getConfig } from "../../config.ts";
import { withBreaker } from "../../lib/circuit.ts";
import { appError, fail, toAppError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";

export interface FineractLoanSummary {
  loanId: string;
  accountNo: string;
  clientId: string | null;
  clientName: string | null;
  productId: number;
  productName: string | null;
  status: "active" | "closed" | "written_off" | "overpaid" | "pending" | "approved" | "rejected" | "unknown";
  externalId: string | null;        // our device-link key (serial/IMEI, see §12.1)
  disbursedOn: string | null;       // YYYY-MM-DD
  dueOn: string | null;             // YYYY-MM-DD; next unpaid due date (single-balloon → the balloon date)
  dpd: number;                      // days past due; 0 if not overdue
  totalOutstanding: number;         // whatever currency the product uses
}

interface FineractAuth {
  baseUrl: string;
  tenantId: string;
  basicAuth: string;
}

function auth(): FineractAuth {
  const c = getConfig();
  if (!c.fineractBaseUrl || !c.fineractUsername || !c.fineractPassword) {
    fail("FINERACT_UNCONFIGURED");
  }
  return {
    baseUrl: c.fineractBaseUrl,
    tenantId: c.fineractTenantId,
    basicAuth: "Basic " + btoa(`${c.fineractUsername}:${c.fineractPassword}`),
  };
}

/** Low-level fetch. Maps non-2xx into AppError and never leaks credentials. */
async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const a = auth();
  const url = `${a.baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Authorization": a.basicAuth,
        "Fineract-Platform-TenantId": a.tenantId,
        "Accept": "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    log("warn", "fineract.network_error", { path, error: String(e) });
    throw appError("FINERACT_UNAVAILABLE");
  }
  const text = await res.text();
  if (res.ok) {
    try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
  }
  log("warn", "fineract.request_failed", { path, status: res.status, body: text.slice(0, 200) });
  if (res.status === 401 || res.status === 403) throw appError("FINERACT_UNAUTHORIZED");
  if (res.status === 404) throw appError("FINERACT_NOT_FOUND");
  if (res.status >= 500) throw appError("FINERACT_UNAVAILABLE");
  throw appError("FINERACT_BAD_REQUEST", `Fineract returned ${res.status}: ${text.slice(0, 200)}`);
}

/** Fineract renders YYYY-M-D as a JSON array [y, m, d]. Collapse to ISO string. */
function arrToDate(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [y, m, d] = v as number[];
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function statusFrom(raw: unknown): FineractLoanSummary["status"] {
  const r = raw as { active?: boolean; closedObligationsMet?: boolean; overpaid?: boolean; writeOff?: boolean; pendingApproval?: boolean; waitingForDisbursal?: boolean } | undefined;
  if (!r) return "unknown";
  if (r.active) return "active";
  if (r.closedObligationsMet) return "closed";
  if (r.overpaid) return "overpaid";
  if (r.writeOff) return "written_off";
  if (r.pendingApproval) return "pending";
  if (r.waitingForDisbursal) return "approved";
  return "unknown";
}

/** Compute DPD = today − earliest unpaid dueDate. 0 when nothing is overdue. */
function dpdFromSchedule(schedule: unknown, todayISO: string): number {
  const periods = (schedule as { periods?: Array<{ dueDate?: unknown; complete?: boolean; obligationsMetOnDate?: unknown }> } | undefined)?.periods ?? [];
  // Earliest unpaid period that has a dueDate (skip the "disbursement" period).
  for (const p of periods) {
    const due = arrToDate(p.dueDate);
    if (!due) continue;
    if (p.complete || p.obligationsMetOnDate) continue;
    const diff = daysBetween(todayISO, due);
    return Math.max(0, diff);
  }
  return 0;
}

/** Next unpaid due date (single-balloon loans → the one balloon date). */
function nextDueFromSchedule(schedule: unknown): string | null {
  const periods = (schedule as { periods?: Array<{ dueDate?: unknown; complete?: boolean; obligationsMetOnDate?: unknown }> } | undefined)?.periods ?? [];
  for (const p of periods) {
    const due = arrToDate(p.dueDate);
    if (!due) continue;
    if (p.complete || p.obligationsMetOnDate) continue;
    return due;
  }
  // All periods paid — fall back to the last dueDate for display.
  for (let i = periods.length - 1; i >= 0; i--) {
    const due = arrToDate(periods[i].dueDate);
    if (due) return due;
  }
  return null;
}

function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

// All Fineract reads share one circuit breaker. UNCONFIGURED is a dev-time
// state (no base URL set) and must NOT count against the trip threshold.
// Everything else — unreachable host, 401, 404, 5xx — is a real signal that
// Fineract is unhealthy right now.
const BREAKER = "fineract";
function isNetworkFailure(e: unknown): boolean {
  return toAppError(e).code !== "FINERACT_UNCONFIGURED";
}

/** Full loan detail — status, repayment schedule, DPD, outstanding, externalId. */
export async function getLoan(loanId: string, todayISO: string): Promise<FineractLoanSummary> {
  return await withBreaker(BREAKER, async () => {
    const raw = await req<Record<string, unknown>>(`/loans/${encodeURIComponent(loanId)}?associations=repaymentSchedule,summary`);
    const summary = (raw.summary ?? {}) as { totalOutstanding?: number };
    const timeline = (raw.timeline ?? {}) as { actualDisbursementDate?: unknown };
    return {
      loanId: String(raw.id ?? loanId),
      accountNo: String(raw.accountNo ?? ""),
      clientId: raw.clientId != null ? String(raw.clientId) : null,
      clientName: raw.clientName as string | null ?? null,
      productId: Number(raw.loanProductId ?? 0),
      productName: raw.loanProductName as string | null ?? null,
      status: statusFrom(raw.status),
      externalId: (raw.externalId as string | null) || null,
      disbursedOn: arrToDate(timeline.actualDisbursementDate),
      dueOn: nextDueFromSchedule(raw.repaymentSchedule),
      dpd: dpdFromSchedule(raw.repaymentSchedule, todayISO),
      totalOutstanding: Number(summary.totalOutstanding ?? 0),
    };
  }, { countFailure: isNetworkFailure });
}

/** List loans — paginates via Fineract's offset/limit. Phase 0 reads all active. */
export async function listLoans(opts: { active?: boolean; limit?: number } = {}): Promise<Array<{ id: string; status: FineractLoanSummary["status"]; externalId: string | null; productId: number }>> {
  return await withBreaker(BREAKER, async () => {
    const limit = opts.limit ?? 200;
    // GET /loans supports pagination; keep it simple — one page per call, Phase 0's
    // dataset is tiny (3 loans). Grow this when the volume demands it.
    const data = await req<{ pageItems?: Array<Record<string, unknown>>; totalFilteredRecords?: number }>(`/loans?limit=${limit}&offset=0`);
    const items = data.pageItems ?? [];
    const rows = items.map((it) => ({
      id: String(it.id),
      status: statusFrom(it.status),
      externalId: (it.externalId as string | null) || null,
      productId: Number(it.loanProductId ?? 0),
    }));
    return opts.active ? rows.filter((r) => r.status === "active") : rows;
  }, { countFailure: isNetworkFailure });
}

/** Lookup by externalId (the device serial/IMEI stamped on the loan). */
export async function loanByExternalId(externalId: string, todayISO: string): Promise<FineractLoanSummary | null> {
  try {
    // Use the breaker on the lookup; getLoan() below is already wrapped so
    // nested calls just see a closed breaker and pass through.
    const raw = await withBreaker(BREAKER, () =>
      req<Record<string, unknown>>(`/loans/external-id/${encodeURIComponent(externalId)}?associations=repaymentSchedule,summary`),
      { countFailure: isNetworkFailure },
    );
    return await getLoan(String(raw.id), todayISO);
  } catch (e) {
    if (toAppError(e).code === "FINERACT_NOT_FOUND") return null;
    throw e;
  }
}
