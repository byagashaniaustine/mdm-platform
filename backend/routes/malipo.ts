// Malipopay webhook ingress. Public endpoint — authenticated by HMAC-SHA256
// of the raw request body against the per-webhook signing secret (MALIPOPAY_
// WEBHOOK_SECRET). Delivery semantics per the Integration Packet (pp. 5-6):
//   - One POST per event, 30-second timeout, retries NOT guaranteed.
//   - Return 200 immediately; process asynchronously.
//   - Dedupe on `reference` (Malipopay's ML…).
//   - Match on `reference` (Malipopay's) OR `customerReference` (ours, e.g.
//     "LOAN-<loanId>"). The createCollection flow in services/loans.ts seeds
//     the latter on disburse so this route can look the loan up O(1).
//
// Scope today is read-only reconciliation per the operator's current ask:
//   - persist every event in `events` for audit,
//   - stamp loan_links.last_malipo_* fields,
//   - NO Fineract repayment write-back (held until Harvey confirms).
// A future PR adds the Fineract POST.
import { Hono } from "hono";
import { getConfig } from "../config.ts";
import { db, run, runMaybe } from "../lib/db.ts";
import { toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { formatFineractDate, postRepayment } from "../services/bridge/fineract.ts";
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

  // Dedupe on Malipopay reference — per the packet, retries aren't guaranteed
  // but neither is single-delivery, so we treat the same (event, reference)
  // pair as idempotent. Only state=succeeded is a true duplicate; a prior
  // state=failed means the Fineract POST never landed and the operator
  // (or Malipopay, if it happens to retry) should be allowed to re-drive it.
  const dedupeKey = `malipo:${evt.event}:${evt.reference ?? "noref"}`;
  const existing = await runMaybe<{ id: string; state: string }>(
    db().from("events").select("id, state").eq("idempotency_key", dedupeKey).maybeSingle(),
  );
  if (existing && (existing.state === "succeeded" || existing.state === "sent")) {
    log("info", "malipo.webhook_duplicate", { event: evt.event, reference: evt.reference });
    return c.json({ data: { duplicate: true } });
  }
  if (existing) {
    // Prior failure — wipe so we can re-attempt. Fineract's externalId dedupe
    // on the transaction itself still protects against double-booking.
    await run(db().from("events").delete().eq("id", existing.id));
    log("info", "malipo.webhook_retry_after_failure", { event: evt.event, reference: evt.reference });
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

  // Terminal confirmations stamp the last-seen snapshot on loan_links for the
  // Loan Tracking UI, THEN book the repayment in Fineract so the loan ledger
  // catches up. The Fineract POST is idempotent via externalId = Malipopay
  // reference — a retried webhook can't double-book.
  const isConfirmed = evt.event === "payment.confirmed" && (evt.status === "SUCCESSFUL" || evt.status === "PAID" || evt.status === "PARTIAL");
  if (isConfirmed && loanId) {
    await run(db().from("loan_links").update({
      last_malipo_at: new Date().toISOString(),
      last_malipo_amount: evt.amount,
      last_malipo_status: evt.status,
    }).eq("fineract_loan_id", loanId));

    // Fineract write-back. Soft-fail: if Fineract rejects, we still 200 to
    // Malipopay (per packet: retries not guaranteed). Operator sees the
    // failure in events + loan_links.last_malipo_* without Malipopay
    // ever re-firing. The reconciliation check at loans.ts:849 surfaces
    // the drift in the Loan Tracking panel.
    if (cfg.malipoFineractPaymentTypeId > 0 && evt.reference) {
      try {
        const posted = await postRepayment({
          loanId,
          amount: evt.amount,
          dateDMYY: formatFineractDate(new Date()),
          externalId: evt.reference,     // ML… → Fineract rejects duplicate externalIds
          paymentTypeId: cfg.malipoFineractPaymentTypeId,
          note: `Via Malipopay ${evt.reference}${evt.customerReference ? ` (${evt.customerReference})` : ""}`,
        });
        log("info", "malipo.repayment_booked", {
          loan_id: loanId,
          malipo_ref: evt.reference,
          fineract_tx_id: posted.transactionId,
          amount: evt.amount,
        });
      } catch (e) {
        const err = toAppError(e);
        // Duplicate externalId → repayment already booked (Malipopay retried,
        // our previous POST succeeded). Treat as success.
        const looksDuplicate = err.code === "FINERACT_BAD_REQUEST" && /(duplicate|already)/i.test(err.message);
        if (looksDuplicate) {
          log("info", "malipo.repayment_duplicate", { loan_id: loanId, malipo_ref: evt.reference });
        } else {
          log("warn", "malipo.repayment_post_failed", {
            loan_id: loanId,
            malipo_ref: evt.reference,
            error: err.code,
            message: err.message?.slice(0, 200),
          });
          // Flip the event row from succeeded → failed with a 2-min backoff
          // so drainMalipoRetries() in the worker picks it up and re-drives
          // the Fineract POST. attempts=1 records this first try.
          await run(db().from("events").update({
            state: "failed",
            attempts: 1,
            next_attempt_at: new Date(Date.now() + 2 * 60_000).toISOString(),
            error_message: `Fineract post failed: ${err.code} ${err.message?.slice(0, 200) ?? ""}`,
          }).eq("idempotency_key", dedupeKey));
        }
      }
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
