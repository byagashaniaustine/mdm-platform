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
  // Total paid against the loan so far. Kept for display / other consumers;
  // no longer gates the initial-payment tier (firstInstallmentPaid does).
  totalRepaid?: number;
  // True once the first scheduled installment is paid in full (not partial).
  // Product policy 2026-11-25: device sits in Due-2D from disbursement day
  // until the full first installment settles — a TZS 1 drop doesn't flip
  // it to released. Optional so pre-schedule callers don't have to supply
  // it; omit → behaves as "unpaid" (safer default).
  firstInstallmentPaid?: boolean;
  // Hour-precision DPD. Only consulted for products that opt into hourly
  // thresholds (daily-repayment loans — a 24h cycle makes day-grain too
  // coarse). Omit for monthly products; dpd (days) is still authoritative.
  dpdHours?: number;
  // Signed hours between now and deadline. Positive = future. Used by the
  // hour-grain pre-due window (e.g. "within 2h of due → due_2d reminder").
  hoursToDue?: number;
}

// Per-product thresholds. Spec §4.2 defaults; override in future by moving
// this to automation_settings. k_soft = DPD at which the soft tier kicks in;
// L = DPD at which the hard lock lands. Add kSoftHours + LHours to a row to
// opt that product into hour-grain tier transitions (for daily-repayment
// products where a 24-hour lock delay is too lax).
// Operator decision (2026-10-29): lock at 72h past due uniformly across the
// monthly catalog. Daily test product (id 9) added 2026-11-25: 6h soft, 24h
// lock — one full cycle of grace before the device goes payment-first.
// Every product runs the SAME cycle — pre-due reminder → soft overdue → hard
// lock. Only the time unit differs. Day-grain products give (preDueDays,
// kSoft, L) in days; hour-grain daily-repayment products also supply
// (preDueHours, kSoftHours, LHours), which take precedence when the loan
// carries live hour-precision fields. Omit preDueDays → defaults to kSoft.
interface ProductThresholds {
  // Day-grain triple, always present. Values are integer days.
  kSoft: number;
  L: number;
  preDueDays?: number;
  // Hour-grain triple — presence of all three opts the product into
  // sub-day tier transitions.
  preDueHours?: number;
  kSoftHours?: number;
  LHours?: number;
}
const THRESHOLDS: Record<number, ProductThresholds> = {
  1: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone 17e — monthly
  2: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone 17 256 — monthly
  3: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone 17 512 — monthly
  4: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone Air 256 — monthly
  5: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone Air 512 — monthly
  6: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone 17 Pro — monthly
  7: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone 17 Pro Max 256 — monthly
  8: { kSoft: 2, L: 3, preDueDays: 2 },                                              // iPhone 17 Pro Max 512 — monthly
  9: { kSoft: 1, L: 1, preDueDays: 1, preDueHours: 2, kSoftHours: 2, LHours: 3 },    // iPhone 12 Daily TEST — hour-grain
};
const DEFAULT_THRESHOLD: ProductThresholds = { kSoft: 2, L: 3, preDueDays: 2 };

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

  // Both branches run the SAME cycle:
  //    (hard lock) → (soft overdue) → (initial-payment gate) → (pre-due) → disbursed
  // Only the unit (hours vs days) and the timeline values differ per product.
  const useHours =
    loan.dpdHours !== undefined &&
    loan.hoursToDue !== undefined &&
    t.LHours !== undefined &&
    t.kSoftHours !== undefined &&
    t.preDueHours !== undefined;

  if (useHours) {
    // Hour-grain cycle — daily-repayment products.
    if (loan.dpdHours! >= t.LHours!) return "locked";
    if (loan.dpdHours! >= t.kSoftHours!) return "overdue_2d";
    if (!loan.firstInstallmentPaid) return "due_2d";
    if (loan.hoursToDue! <= t.preDueHours!) return "due_2d";
    return "disbursed";
  }

  // Day-grain cycle — monthly / long-cycle products. Keeps the "any arrears
  // below kSoft is still soft tier" spec §8 rule so a loan at dpd=1 doesn't
  // sit in due_2d while actually past due.
  if (loan.dpd >= t.L) return "locked";
  if (loan.dpd >= t.kSoft) return "overdue_2d";
  if (loan.dpd >= 1) return "overdue_2d";
  if (!loan.firstInstallmentPaid) return "due_2d";
  const preDueDays = t.preDueDays ?? 2;
  const daysToDue = daysBetween(loan.dueOn, todayISO);
  if (daysToDue <= preDueDays) return "due_2d";
  return "disbursed";
}
