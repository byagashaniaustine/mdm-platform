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
  r.post("/create", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const clientId = str(b, "client_id", { max: 32 });
    const productIdRaw = (b as Record<string, unknown>).product_id;
    const productId = Number(productIdRaw);
    if (!Number.isInteger(productId) || productId <= 0) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "product_id must be a positive integer" } }, 400);
    }
    const principal = Number((b as Record<string, unknown>).principal);
    if (!(principal > 0)) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "principal must be a positive number" } }, 400);
    }
    const expectedDisbursementOn = str(b, "expected_disbursement_on", { max: 10 });
    const rawEmail = (b as Record<string, unknown>).client_email;
    const clientEmail = typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim() : null;
    if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "client_email is not a valid email address" } }, 400);
    }
    const result = await createLoan(
      c.get("session").enterpriseId,
      c.get("session").adminId ?? null,
      { clientId, productId, principal, expectedDisbursementOn, clientEmail },
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
