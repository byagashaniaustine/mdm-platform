// Malipopay webhook ingress. Public endpoint — authenticated by HMAC-SHA256
// of the raw request body against the per-webhook signing secret (MALIPOPAY_
// WEBHOOK_SECRET). Delivery semantics per the Integration Packet (pp. 5-6):
//   - One POST per event, 30-second timeout, retries NOT guaranteed.
//   - Return 200 immediately; process asynchronously.
//   - Dedupe by the raw body's SHA-256 (the packet says "dedupe on reference"
//     but that silently drops every PARTIAL after the first on a FLEXIBLE
//     collection — see dedupeKeyForWebhook for the details).
//   - Match on `reference` (Malipopay's) OR `customerReference` (ours, e.g.
//     "LOAN-<loanId>"). The createCollection flow in services/loans.ts seeds
//     the latter on disburse so this route can look the loan up O(1).
//
// Scope today:
//   - persist every event in `events` for audit,
//   - trigger an immediate reconcileLoan() for payment.confirmed events so the
//     device-tier pipeline sees the truth without waiting a full sync window.
// reconcileLoan() is the sole writer to Fineract and the only place that
// stamps loan_links.last_malipo_* — the webhook no longer does either, so
// the webhook and the periodic tick can't race to double-book a repayment.
import { Hono } from "hono";
import { getConfig } from "../config.ts";
import { db, run, runMaybe } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import { reconcileLoan } from "../services/malipo_sync.ts";
import { verifyWebhookSignature } from "../services/malipo.ts";

interface MalipoWebhookEvent {
  event: string;                         // payment.confirmed | payment.failed | …
  reference: string | null;              // Malipopay's ML…
  customerReference: string | null;      // ours, e.g. "LOAN-42"
  amount: number;                        // gross TZS
  feeAmount: number;
  netAmount: number;
  status: string | null;
  payerAccount: string | null;           // phone / account id as reported by Malipopay
  raw: Record<string, unknown>;
}

function parseEvent(body: Record<string, unknown>): MalipoWebhookEvent {
  // The packet shows `event`, `reference`, `customerReference` at top-level in
  // narrative, but Malipopay wraps success responses in `{ success, data: {…} }`.
  // Accept either shape so we're robust to future doc revisions.
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  const amount = Number(data.amount ?? body.amount ?? 0);
  const fee = Number(data.feeAmount ?? body.feeAmount ?? 0);
  const net = data.netAmount != null
    ? Number(data.netAmount)
    : (body.netAmount != null ? Number(body.netAmount) : amount - fee);
  return {
    event: String(body.event ?? data.event ?? ""),
    reference: (data.reference as string | null) ?? (body.reference as string | null) ?? null,
    customerReference: (data.customerReference as string | null) ?? (body.customerReference as string | null) ?? null,
    amount,
    feeAmount: fee,
    netAmount: net,
    status: (data.status as string | null) ?? (body.status as string | null) ?? null,
    payerAccount: (data.account as string | null) ?? (data.payerAccount as string | null) ?? null,
    raw: data,
  };
}

/**
 * Idempotency key for the events row, derived from the exact bytes Malipopay
 * sent us. Why body hash and not `(event, reference)`:
 *
 *   - FLEXIBLE collections keep one ML reference open until the total is met;
 *     every partial top-up fires its own payment.confirmed. Dedupe by ref
 *     would discard every top-up after the first (observed on loan 18 on
 *     2026-11-28: second partial of TZS 2,500 arrived at Malipopay but the
 *     DB had no second event row).
 *   - A byte-identical retry (Malipopay re-delivering the same event) hashes
 *     to the same key and correctly collapses.
 *   - Two distinct partials differ in netAmount / timestamp / sub-tx id, so
 *     their bodies differ, so their hashes differ, so both insert.
 *   - The raw bytes have already cleared HMAC verification above, so a
 *     tampered body can't poison the key.
 *
 * Deterministic and pure so unit tests can pin it.
 */
export async function dedupeKeyForWebhook(rawBody: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `malipo:evt:${hex}`;
}

// deno-lint-ignore no-explicit-any
export async function handleMalipoWebhook(c: any) {
  const cfg = getConfig();
  const raw = await c.req.text();
  const sig = c.req.header("X-Malipopay-Signature") ?? c.req.header("x-malipopay-signature") ?? "";

  // Signature check. If MALIPOPAY_WEBHOOK_SECRET isn't configured we refuse to
  // accept the event rather than silently process unverified payments — same
  // posture as the Fineract route. This is safer than "accept in dev"; it also
  // means the endpoint stays dormant until the secret lands.
  if (!cfg.malipoWebhookSecret) {
    log("warn", "malipo.webhook_unconfigured");
    return c.json({ error: { code: "AUTH_REQUIRED", message: "Webhook secret not configured on this server." } }, 503);
  }
  const ok = await verifyWebhookSignature(raw, sig);
  if (!ok) {
    log("warn", "malipo.webhook_bad_sig", { had_sig: Boolean(sig) });
    return c.json({ error: { code: "AUTH_REQUIRED", message: "Invalid signature." } }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw); } catch {
    return c.json({ error: { code: "VALIDATION_FAILED", message: "Body is not JSON." } }, 400);
  }
  const evt = parseEvent(body);

  // Dedupe on a SHA-256 of the raw request body rather than on
  // (event, reference) alone. The packet (p.6) prescribes dedupe-by-reference,
  // but that's wrong for FLEXIBLE collections where every partial top-up
  // against the same ML reference legitimately produces a fresh
  // payment.confirmed event — a per-reference key silently swallows every
  // partial after the first. Hashing the body means: byte-identical retries
  // (same event delivered twice) collapse to one row, distinct partials
  // (different netAmount / timestamp / sub-tx id) each insert. The hash
  // runs against the exact bytes we already verified via HMAC above, so a
  // tampered body would have been rejected before reaching this point.
  const dedupeKey = await dedupeKeyForWebhook(raw);
  const existing = await runMaybe<{ id: string; state: string }>(
    db().from("events").select("id, state").eq("idempotency_key", dedupeKey).maybeSingle(),
  );
  if (existing && (existing.state === "succeeded" || existing.state === "sent")) {
    log("info", "malipo.webhook_duplicate", { event: evt.event, reference: evt.reference, amount: evt.amount });
    return c.json({ data: { duplicate: true } });
  }
  if (existing) {
    // Prior failure — wipe so we can re-attempt. Fineract's externalId dedupe
    // on the transaction itself still protects against double-booking.
    await run(db().from("events").delete().eq("id", existing.id));
    log("info", "malipo.webhook_retry_after_failure", { event: evt.event, reference: evt.reference, amount: evt.amount });
  }

  // Resolve loan ownership. Prefer customerReference ("LOAN-<id>") since we
  // set it on disburse; fall back to looking up by malipo_reference which we
  // also stamped on loan_links at the same time.
  let loanId: string | null = null;
  let enterpriseId: string | null = null;
  let deviceId: string | null = null;
  const cr = evt.customerReference ?? "";
  const loanIdFromCR = /^LOAN-(.+)$/.exec(cr)?.[1] ?? null;
  if (loanIdFromCR) loanId = loanIdFromCR;

  if (!loanId && evt.reference) {
    const link = await runMaybe<{ fineract_loan_id: string; enterprise_id: string; device_id: string }>(
      db().from("loan_links").select("fineract_loan_id, enterprise_id, device_id")
        .eq("malipo_reference", evt.reference).maybeSingle(),
    );
    if (link) {
      loanId = link.fineract_loan_id;
      enterpriseId = link.enterprise_id;
      deviceId = link.device_id;
    }
  } else if (loanId) {
    const link = await runMaybe<{ enterprise_id: string; device_id: string }>(
      db().from("loan_links").select("enterprise_id, device_id")
        .eq("fineract_loan_id", loanId).maybeSingle(),
    );
    if (link) {
      enterpriseId = link.enterprise_id;
      deviceId = link.device_id;
    }
  }

  // Persist the raw event. If we couldn't identify the loan we still log it
  // (enterprise_id is required on events, so for an unmatched event we skip
  // the DB write and surface the orphan in the response for debugging).
  if (enterpriseId) {
    await run(db().from("events").insert({
      enterprise_id: enterpriseId,
      category: "announcement",
      action: `malipo.${evt.event}`,
      device_id: deviceId,
      params: {
        reference: evt.reference,
        customer_reference: evt.customerReference,
        amount: evt.amount,
        fee_amount: evt.feeAmount,
        net_amount: evt.netAmount,
        status: evt.status,
        payer_account: evt.payerAccount,
        loan_id: loanId,
      },
      idempotency_key: dedupeKey,
      state: "succeeded",
      completed_at: new Date().toISOString(),
    }));
  } else {
    log("warn", "malipo.webhook_orphan", {
      event: evt.event,
      reference: evt.reference,
      customer_reference: evt.customerReference,
      amount: evt.amount,
    });
    return c.json({ data: { orphan: true, reason: "no loan match" } });
  }

  // Terminal confirmations trigger an immediate per-loan reconcile. The
  // webhook itself no longer writes to Fineract: the reconciler is the sole
  // Fineract writer, so its cumulative-based externalId
  // (`${ref}-cum${paidAmount}`) applies whether we were kicked by a webhook
  // or by the periodic sync tick — no double-booking possible. loan_links
  // stamping also moves inside reconcileLoan so it sees Malipopay's
  // cumulative paidAmount (not this single event's gross).
  const isConfirmed = evt.event === "payment.confirmed" && (evt.status === "SUCCESSFUL" || evt.status === "PAID" || evt.status === "PARTIAL");
  if (isConfirmed && loanId && evt.reference) {
    try {
      const outcome = await reconcileLoan(loanId, evt.reference);
      log("info", "malipo.webhook_reconciled", {
        loan_id: loanId, malipo_ref: evt.reference, amount: evt.amount, outcome,
      });
    } catch (e) {
      log("warn", "malipo.webhook_reconcile_failed", {
        loan_id: loanId, malipo_ref: evt.reference, error: String(e).slice(0, 200),
      });
    }
  }

  log("info", "malipo.webhook_processed", {
    event: evt.event,
    reference: evt.reference,
    customer_reference: evt.customerReference,
    loan_id: loanId,
    amount: evt.amount,
    status: evt.status,
  });
  return c.json({ data: { accepted: true, loan_id: loanId } });
}

export function malipoWebhookRoutes() {
  const r = new Hono();
  r.post("/hooks", handleMalipoWebhook);
  return r;
}
