// Device ↔ loan link store. One `active` link per device at a time (enforced by
// the partial unique index in migration 012). See LOAN_DEVICE_AUTOMATION.md §7.1.
import { db, run, runMaybe } from "../../lib/db.ts";

export interface LoanLink {
  id: string;
  enterprise_id: string;
  device_id: string;
  fineract_loan_id: string;
  fineract_client_id: string | null;
  external_id: string;
  product_id: number;
  disbursed_on: string | null;
  due_on: string | null;
  status: "active" | "closed" | "written_off";
  closed_on: string | null;
  created_at: string;
}

/** All active links in the enterprise — the input set for the daily reconcile. */
export async function listActive(enterpriseId: string): Promise<LoanLink[]> {
  return await run<LoanLink[]>(
    db().from("loan_links").select("*").eq("enterprise_id", enterpriseId).eq("status", "active"),
  );
}

export async function findByLoanId(enterpriseId: string, loanId: string): Promise<LoanLink | null> {
  return await runMaybe<LoanLink>(
    db().from("loan_links").select("*").eq("enterprise_id", enterpriseId).eq("fineract_loan_id", loanId).maybeSingle(),
  );
}

export async function findActiveByExternalId(enterpriseId: string, externalId: string): Promise<LoanLink | null> {
  return await runMaybe<LoanLink>(
    db().from("loan_links").select("*").eq("enterprise_id", enterpriseId).eq("external_id", externalId).eq("status", "active").maybeSingle(),
  );
}
