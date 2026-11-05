// Loan origination glue: lists Mapene loans awaiting disbursal + available
// devices, and binds them in one shot. See services/loans.ts for the three-
// step dance (set externalId → insert loan_link → disburse).
import { Hono } from "hono";
import { readJson, str } from "../lib/validate.ts";
import { type AppEnv, requireRole, requireSession } from "../middleware/auth.ts";
import { linkAndDisburse, listAvailableDevices, listPending } from "../services/loans.ts";

export function loanRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/pending", async (c) =>
    c.json({ data: await listPending(c.get("session").enterpriseId) }));

  r.get("/available-devices", async (c) =>
    c.json({ data: await listAvailableDevices(c.get("session").enterpriseId) }));

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
