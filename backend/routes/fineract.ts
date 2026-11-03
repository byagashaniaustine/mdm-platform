// Fineract webhook ingress. Public endpoint — authenticated by HMAC of the raw
// request body against the shared secret. If no secret is configured on this
// server, the endpoint 503s rather than silently accepting unverified events.
// See LOAN_DEVICE_AUTOMATION.md §9.1 (ingest) and §13 (security).
import { Hono } from "hono";
import { getConfig } from "../config.ts";
import { log } from "../lib/log.ts";
import { onEvent, onLoanEvent, resolveLoanToEnterprise } from "../services/bridge/automation.ts";
import type { FineractLoanSummary } from "../services/bridge/fineract.ts";

// Fineract hook actionName enum values. Mifos emits UPPERCASE imperative
// verbs; aliases exist across versions + UIs (Community vs Enterprise). We
// classify them into three device-side intents: disburse (device activates),
// release (loan is done, device returns to released), tighten (loan is in
// trouble, device moves toward locked). Pre-disburse states (APPROVE,
// UNDOAPPROVAL) and purely-informational edits (UPDATE, ADJUSTTRANSACTION)
// stay in "other" — the current loan state from getLoan() still drives the
// real tier decision in reconcileBatch regardless of this hint.
// Fineract CE 1.15 (istore build) action names — enumerated from the live
// /permissions endpoint on 2026-11-03. Older-Fineract and Mifos-Community
// aliases included as a safety net for other deployments. The kind is only a
// log + response hint; reconcileBatch always drives the real tier decision
// off the current loan state from getLoan(), so unknown actions still move
// the device correctly.
const DISBURSE_ACTIONS = new Set([
  "DISBURSE",                            // standard
  "DISBURSAL",                           // older Fineract alias
  "DISBURSETOSAVINGS",                   // disburse to a linked savings account
  "DISBURSEWITHOUTAUTODOWNPAYMENT",      // disburse but skip auto-downpayment logic
]);
const RELEASE_ACTIONS = new Set([
  "REPAYMENT",             // standard — Fineract CE 1.15 emits this
  "MAKEREPAYMENT",         // Mifos Community UI (other builds)
  "MAKEREPAYMENTS",        // bulk repayment (other builds)
  "RECOVERYPAYMENT",       // payment after writeoff
  "CLOSE",                 // loan closed
  "CLOSEASRESCHEDULED",    // closed because rescheduled
  "FORECLOSURE",           // borrower pays off early
  "GOODWILLCREDIT",        // operator discretionary payment
  "UNDOWRITEOFF",          // reversing a writeoff (loan is alive again, but device returned)
  "UNDOCHARGEOFF",         // reversing a chargeoff
  "CONTRACT_TERMINATION_UNDO", // reversing a contract termination
  "CREDITBALANCEREFUND",   // overpayment refund — loan is settled
]);
const TIGHTENING_ACTIONS = new Set([
  "WRITEOFF",              // lender takes the loss
  "CHARGEOFF",             // alternative writeoff path on CE 1.15
  "REJECT",                // application rejected (pre-disburse)
  "SETFRAUD",              // fraud flagged — device should lock
  "CONTRACT_TERMINATION",  // loan contract terminated
  "UNDODISBURSAL",         // reversing a disbursal (word-order variant in some builds)
  "DISBURSALUNDO",         // reversing a disbursal (CE 1.15 word order)
  "DISBURSALLASTUNDO",     // reversing the last tranche of a multi-tranche disbursal
]);
const LOAN_STATUSES = new Set<FineractLoanSummary["status"]>([
  "active", "closed", "written_off", "overpaid", "pending", "approved", "rejected", "unknown",
]);

/**
 * Coerce a signed webhook body's optional `loan` field into FineractLoanSummary.
 * The sender (LMS Simulator) owns the shape; we validate the status enum and
 * default anything missing to safe values. Returns null if the field isn't
 * usable as an override — the caller then falls back to the live Fineract fetch.
 */
function coerceLoanOverride(raw: unknown, loanId: string): FineractLoanSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = String(r.status ?? "") as FineractLoanSummary["status"];
  return {
    loanId: String(r.loanId ?? loanId),
    accountNo: String(r.accountNo ?? ""),
    clientId: r.clientId == null ? null : String(r.clientId),
    clientName: r.clientName == null ? null : String(r.clientName),
    clientEmail: r.clientEmail == null ? null : String(r.clientEmail),
    productId: Number(r.productId ?? 0),
    productName: r.productName == null ? null : String(r.productName),
    status: LOAN_STATUSES.has(status) ? status : "active",
    externalId: r.externalId == null ? null : String(r.externalId),
    disbursedOn: r.disbursedOn == null ? null : String(r.disbursedOn),
    dueOn: r.dueOn == null ? null : String(r.dueOn),
    dpd: Math.max(0, Number(r.dpd ?? 0) || 0),
    totalOutstanding: Number(r.totalOutstanding ?? 0) || 0,
  };
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare for hex signatures. */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function fineractWebhookRoutes() {
  const r = new Hono();

  // POST /api/fineract/hooks — Fineract Web hook delivery.
  //
  // Two accepted auth modes, so this works both with Fineract builds that
  // HMAC-sign the body and with vanilla CE 1.x where the standard Web hook
  // template just POSTs the payload with no header:
  //   1. HMAC path: X-Fineract-Signature header carrying the hex HMAC-SHA256
  //      of the raw body under FINERACT_WEBHOOK_SECRET. Preferred when the
  //      Mifos build supports a signing extension.
  //   2. URL-param path: a `?key=<FINERACT_WEBHOOK_SECRET>` query string on
  //      the hook URL — the secret is URL-decoded by Hono. CE 1.x operators
  //      configure the hook URL in Mifos as
  //        https://.../api/fineract/hooks?key=<url-encoded-secret>
  //      Compared constant-time; no header requirement.
  r.post("/hooks", async (c) => {
    const secret = getConfig().fineractWebhookSecret;
    if (!secret) {
      log("warn", "fineract.webhook_no_secret");
      return c.json({ error: { code: "FINERACT_UNCONFIGURED", message: "Webhook secret not configured on this server." } }, 503);
    }
    const raw = await c.req.text();
    const sig = c.req.header("X-Fineract-Signature") ?? c.req.header("x-fineract-signature") ?? "";
    const urlKey = c.req.query("key") ?? "";

    let authed = false;
    if (sig) {
      const expected = await hmacHex(secret, raw);
      authed = timingSafeEq(sig.toLowerCase(), expected);
    }
    if (!authed && urlKey) {
      authed = timingSafeEq(urlKey, secret);
    }
    if (!authed) {
      log("warn", "fineract.webhook_bad_auth", { had_sig: Boolean(sig), had_url_key: Boolean(urlKey) });
      return c.json({ error: { code: "AUTH_REQUIRED", message: "No valid X-Fineract-Signature header or ?key=<secret> query param." } }, 401);
    }
    // Parse now that the signature is verified.
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "Body is not JSON." } }, 400);
    }
    // Fineract's webhook body shape varies by version. Common fields:
    //   entityName, actionName, resourceId, officeId, clientId, loanId.
    const entity = String(body.entityName ?? body.entity ?? "").toUpperCase();
    const action = String(body.actionName ?? body.action ?? "").toUpperCase();
    const loanId = String(body.loanId ?? body.resourceId ?? body.resource_id ?? "");
    if (entity !== "LOAN" || !loanId) {
      // Not an event we care about — ack so Fineract stops retrying.
      log("info", "fineract.webhook_ignored", { entity, action });
      return c.json({ data: { ignored: true, reason: "not a LOAN event" } });
    }
    const trigger = `webhook:LOAN/${action || "UNKNOWN"}`;
    // Hint whether this event tightens or releases; Phase 0 just logs it, Phase 2+
    // uses this to decide whether guards run or release path is instant.
    const kind = DISBURSE_ACTIONS.has(action) ? "disburse"
      : RELEASE_ACTIONS.has(action) ? "release"
      : TIGHTENING_ACTIONS.has(action) ? "tighten"
      : "other";
    // The caller may embed a pre-built FineractLoanSummary as `body.loan`. This
    // is how the LMS Simulator drives dry-run reconciles without a real Fineract.
    // Real Fineract webhooks never carry this field — they take the fetch path.
    const override = coerceLoanOverride((body as Record<string, unknown>).loan, loanId);
    const source = override ? "override" : "fineract";
    log("info", "fineract.webhook_received", { entity, action, loan_id: loanId, kind, source });
    try {
      let result;
      if (override) {
        const resolved = await resolveLoanToEnterprise(loanId);
        if (!resolved) {
          log("info", "fineract.webhook_unlinked_override", { loan_id: loanId });
          return c.json({ data: { trigger, kind, source, result: null, note: "no active loan_links row for this loanId" } });
        }
        result = await onEvent(resolved.enterpriseId, trigger, override);
      } else {
        result = await onLoanEvent(loanId, trigger);
      }
      // 202 Accepted when the apply work was queued; 200 when it ran inline
      // (dry-run or no decisions) — the sim treats both equivalently.
      const status = result?.enqueued?.length ? 202 : 200;
      return c.json({ data: { trigger, kind, source, result } }, status);
    } catch (e) {
      // Still 200 so Fineract doesn't flood retries; the error is in our logs.
      log("warn", "fineract.webhook_apply_failed", { loan_id: loanId, source, error: String(e) });
      return c.json({ data: { trigger, kind, source, error: "processing_failed" } });
    }
  });

  return r;
}
