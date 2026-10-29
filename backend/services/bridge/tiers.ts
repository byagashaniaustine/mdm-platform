// Loan-driven device-automation tier engine. Pure: no I/O, no clock, no DB —
// so it can be exhaustively unit-tested. See LOAN_DEVICE_AUTOMATION.md §8.
//
// Dates are passed as "YYYY-MM-DD" strings in Africa/Dar_es_Salaam (spec §15:
// single fixed TZ so distributed workers always agree on DPD). This file never
// touches `new Date()` — the caller resolves "today" explicitly.

export type Tier =
  | "undisbursed"
  | "disbursed"
  | "due_2d"
  | "overdue_2d"
  | "locked"
  | "released";

export const TIERS: readonly Tier[] = ["undisbursed", "disbursed", "due_2d", "overdue_2d", "locked", "released"];

export interface LoanState {
  // Fineract loan status collapsed into the four outcomes we actually branch on.
  status: "active" | "closed" | "written_off" | "overpaid";
  // ISO date (YYYY-MM-DD) of the single balloon due date. Null before disbursement.
  dueOn: string | null;
  // Days past due. 0 if not yet due or if everything is paid.
  dpd: number;
  // Fineract loan product id — chooses the threshold row.
  productId: number;
}

// Per-product thresholds. Spec §4.2 defaults; override in future by moving this
// to automation_settings. k_soft = DPD at which the soft tier kicks in; L = DPD
// at which the hard lock lands.
// Operator decision (2026-10-29): lock at 72h past due uniformly across every
// loan product. Diverges from spec §4.2 defaults of 5/8/15 — tighter and
// product-agnostic. If this ever needs product-specific tuning, move the
// thresholds to automation_settings.
const THRESHOLDS: Record<number, { kSoft: number; L: number }> = {
  1: { kSoft: 2, L: 3 },   // 7-Day
  2: { kSoft: 2, L: 3 },   // 14-Day
  3: { kSoft: 2, L: 3 },   // 28-Day
};
const DEFAULT_THRESHOLD = { kSoft: 2, L: 3 };

const MS_PER_DAY = 86_400_000;

/** Whole-day signed difference `fromISO − toISO`, both "YYYY-MM-DD". */
function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  return Math.round((Date.UTC(fy, fm - 1, fd) - Date.UTC(ty, tm - 1, td)) / MS_PER_DAY);
}

export function tierFor(loan: LoanState, todayISO: string): Tier {
  // Terminal states first. "overpaid" collapses to released — spec §15.
  if (loan.status === "closed" || loan.status === "overpaid") return "released";
  // "written_off" is NOT auto-released: spec §15 says this path is manual/owner.
  // We still return `locked` so the device stays locked until a human intervenes.
  if (loan.status === "written_off") return "locked";

  if (!loan.dueOn) return "disbursed";

  const t = THRESHOLDS[loan.productId] ?? DEFAULT_THRESHOLD;
  if (loan.dpd >= t.L) return "locked";
  if (loan.dpd >= t.kSoft) return "overdue_2d";
  // Any arrears below k_soft (dpd 1) still signal soft tier — spec §8.
  if (loan.dpd >= 1) return "overdue_2d";

  // Not yet overdue. Window is T-2, T-1, and T (the due day itself).
  const daysToDue = daysBetween(loan.dueOn, todayISO);
  if (daysToDue <= 2) return "due_2d";

  return "disbursed";
}
