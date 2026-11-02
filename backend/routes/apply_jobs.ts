// Status probe for the async apply queue (migration 016).
//
// Deliberately unauthenticated — the sim polls these from Deno Deploy without
// a session. Job IDs are 128-bit UUIDs so unguessable; the body carries no
// enterprise or device identifiers beyond the outcome the caller already saw
// in the webhook response. If this ever needs tightening, add HMAC like
// /api/fineract/hooks (the sim already signs there).

import { Hono } from "hono";
import { getApplyJob } from "../services/bridge/apply_queue.ts";

export function applyJobRoutes() {
  const r = new Hono();

  // GET /api/apply-jobs/:id → { state, attempts, outcome, error? }
  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: { code: "VALIDATION_FAILED", message: "bad id" } }, 400);
    const job = await getApplyJob(id);
    if (!job) return c.json({ error: { code: "NOT_FOUND", message: "job not found" } }, 404);
    return c.json({ data: {
      id: job.id,
      state: job.state,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      next_attempt_at: job.next_attempt_at,
      outcome: job.outcome,
      error_code: job.error_code,
      error_message: job.error_message,
      completed_at: job.completed_at,
    } });
  });

  return r;
}
