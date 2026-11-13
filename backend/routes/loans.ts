// Loan origination glue: lists Mapene loans awaiting disbursal + available
// devices, and binds them in one shot. See services/loans.ts for the three-
// step dance (set externalId → insert loan_link → disburse).
import { Hono } from "hono";
import { readJson, str } from "../lib/validate.ts";
import { type AppEnv, requireRole, requireSession } from "../middleware/auth.ts";
import {
  createLoan,
  getTrackingDetail,
  linkAndDisburse,
  listAll,
  listAvailableDevices,
  listClientsForCreate,
  listPending,
  listProductsForCreate,
} from "../services/loans.ts";

export function loanRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/pending", async (c) =>
    c.json({ data: await listPending(c.get("session").enterpriseId) }));

  r.get("/available-devices", async (c) =>
    c.json({ data: await listAvailableDevices(c.get("session").enterpriseId) }));

  // Loan tracking table: every loan in any state (pending, active, overdue,
  // closed, written-off), shaped for the colored-tag table in the Console.
  r.get("/all", async (c) =>
    c.json({ data: await listAll(c.get("session").enterpriseId) }));

  // Row-click detail: full schedule + lock event history.
  r.get("/:loanId/detail", async (c) => {
    const loanId = str({ loanId: c.req.param("loanId") }, "loanId", { max: 64 });
    return c.json({ data: await getTrackingDetail(c.get("session").enterpriseId, loanId) });
  });

  // Fineract client + product pickers for the Create loan form.
  r.get("/clients", requireRole("admin"), async (c) =>
    c.json({ data: await listClientsForCreate() }));

  r.get("/products", requireRole("admin"), async (c) =>
    c.json({ data: await listProductsForCreate() }));

  // Create a new loan in Fineract (POST + approve) and record a draft row.
  // The returned loanId appears in Pending; admin then calls link-and-disburse
  // below to bind a device and fire the disbursal.
  //
  // Body accepts EITHER client_id (existing Fineract client) OR new_borrower
  // ({firstname, lastname, middlename?, mobileNo?, emailAddress?}); the latter
  // creates the client in Fineract first.
  r.post("/create", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw) as Record<string, unknown>;
    const productId = Number(b.product_id);
    if (!Number.isInteger(productId) || productId <= 0) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "product_id must be a positive integer" } }, 400);
    }
    const principal = Number(b.principal);
    if (!(principal > 0)) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "principal must be a positive number" } }, 400);
    }
    const expectedDisbursementOn = str(b, "expected_disbursement_on", { max: 10 });
    const clientEmail = normalizeEmail(b.client_email);
    if (clientEmail === false) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "client_email is not a valid email address" } }, 400);
    }
    const clientMobile = normalizeMobile(b.client_mobile);
    if (clientMobile === false) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "client_mobile must be 8-15 digits, optional leading +" } }, 400);
    }

    const rawClientId = b.client_id;
    const clientId = typeof rawClientId === "string" && rawClientId.trim() ? rawClientId.trim() : null;
    const newBorrowerRaw = b.new_borrower as Record<string, unknown> | undefined;
    let newBorrower: { firstname: string; middlename?: string | null; lastname: string; mobileNo?: string | null; emailAddress?: string | null } | undefined;
    if (newBorrowerRaw) {
      const fn = typeof newBorrowerRaw.firstname === "string" ? newBorrowerRaw.firstname.trim() : "";
      const ln = typeof newBorrowerRaw.lastname === "string" ? newBorrowerRaw.lastname.trim() : "";
      if (!fn || !ln) {
        return c.json({ error: { code: "VALIDATION_FAILED", message: "new_borrower.firstname and new_borrower.lastname are required" } }, 400);
      }
      const mn = typeof newBorrowerRaw.middlename === "string" ? newBorrowerRaw.middlename.trim() : null;
      newBorrower = {
        firstname: fn,
        middlename: mn || null,
        lastname: ln,
        // Default the new client's contact fields to the reminder-side values
        // so the Fineract client record is populated even if the admin only
        // typed them once.
        mobileNo: (typeof newBorrowerRaw.mobileNo === "string" && newBorrowerRaw.mobileNo.trim()) ? newBorrowerRaw.mobileNo.trim() : clientMobile,
        emailAddress: (typeof newBorrowerRaw.emailAddress === "string" && newBorrowerRaw.emailAddress.trim()) ? newBorrowerRaw.emailAddress.trim() : clientEmail,
      };
    }
    if (!clientId && !newBorrower) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "Provide either client_id or new_borrower." } }, 400);
    }

    const result = await createLoan(
      c.get("session").enterpriseId,
      c.get("session").adminId ?? null,
      { clientId: clientId ?? undefined, newBorrower, productId, principal, expectedDisbursementOn, clientEmail: clientEmail ?? undefined, clientMobile: clientMobile ?? undefined },
    );
    return c.json({ data: result });
  });

  r.post("/:loanId/link-and-disburse", requireRole("admin"), async (c) => {
    const loanId = str({ loanId: c.req.param("loanId") }, "loanId", { max: 64 });
    const b = await readJson(c.req.raw);
    const deviceId = str(b, "device_id", { max: 64 });
    const principal = Number((b as Record<string, unknown>).principal);
    const result = await linkAndDisburse(c.get("session").enterpriseId, loanId, deviceId, principal);
    return c.json({ data: result });
  });

  return r;
}

/** Returns null on empty, false on invalid, trimmed string on valid. */
function normalizeEmail(v: unknown): string | null | false {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : false;
}
function normalizeMobile(v: unknown): string | null | false {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  return /^\+?\d[\d\s-]{6,19}$/.test(s) ? s : false;
}
