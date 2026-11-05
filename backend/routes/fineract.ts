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

// Shared Fineract webhook handler. Mounted at both /api/fineract/hooks and
// POST / (root). The root mount exists because Fineract CE 1.15-SNAPSHOT 500s
// on hook registration when the Payload URL contains any path segment —
// confirmed on istore.lms.bsa.ai on 2026-11-05. Query strings are accepted at
// registration time, so the hook is registered as `https://host?key=<secret>`.
//
// Three accepted auth modes, tried in order:
//   1. HMAC path: X-Fineract-Signature header carrying the hex HMAC-SHA256
//      of the raw body under FINERACT_WEBHOOK_SECRET. Not produced by CE 1.x
//      Web template, but kept for future signed deployments.
//   2. URL-param path: a `?key=<FINERACT_WEBHOOK_SECRET>` query string.
//      OkHttp 4.12 (CE 1.15's HTTP client) silently drops the query when the
//      stored Payload URL has no `/` before `?` — which is the only shape
//      that fits istore's varchar(100) config column. So this mode almost
//      never triggers in prod right now, but will light up again once Harvey
//      bumps the column size and we re-register as `https://host/?key=...`.
//   3. IP-source + body-shape trust: if the request comes from an IP in
//      FINERACT_WEBHOOK_ALLOWED_IPS AND the body is a Fineract-shaped event
//      (entityName=LOAN with a non-empty resourceId/loanId), accept. This is
//      the only mode that actually works with CE 1.15 + OkHttp 4.12 today.
//      Logged loudly as fineract.webhook_accepted_by_ip so we can drop this
//      fallback the moment one of the cryptographic modes starts delivering.
const FINERACT_LOAN_ACTIONS = new Set<string>([
  ...DISBURSE_ACTIONS, ...RELEASE_ACTIONS, ...TIGHTENING_ACTIONS,
  "APPROVE", "APPROVALUNDO", "REJECT", "WITHDRAW",
  "ADJUSTTRANSACTION", "ADJUST", "UPDATE", "CREATE",
]);

function clientIpFromHeaders(c: { req: { header: (n: string) => string | undefined } }): string {
  // Try each proxy-IP header in order. Deno Deploy, Cloudflare, Fastly and
  // the generic Forwarded standard disagree on which one they set.
  const tries = [
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "fly-client-ip",
    "true-client-ip",
    "x-client-ip",
  ];
  for (const name of tries) {
    const v = c.req.header(name) ?? "";
    const first = v.split(",")[0]?.trim();
    if (first) return first;
  }
  return "";
}

function looksLikeFineractEvent(body: Record<string, unknown>): boolean {
  const entity = String(body.entityName ?? body.entity ?? "").toUpperCase();
  const action = String(body.actionName ?? body.action ?? "").toUpperCase();
  const resource = String(body.resourceId ?? body.resource_id ?? body.loanId ?? "");
  // We only trust LOAN events — any other entity from an "allowed" IP is still
  // rejected so a compromised network path can't fire arbitrary automation.
  return entity === "LOAN" && resource.length > 0 && FINERACT_LOAN_ACTIONS.has(action);
}
// deno-lint-ignore no-explicit-any
export async function handleFineractWebhook(c: any) {
  const cfg = getConfig();
  const secret = cfg.fineractWebhookSecret;
  const raw = await c.req.text();
  const sig = c.req.header("X-Fineract-Signature") ?? c.req.header("x-fineract-signature") ?? "";
  const urlKey = c.req.query("key") ?? "";

  let authed = false;
  let authMode: "hmac" | "url_key" | "ip" | "none" = "none";
  if (secret && sig) {
    const expected = await hmacHex(secret, raw);
    if (timingSafeEq(sig.toLowerCase(), expected)) { authed = true; authMode = "hmac"; }
  }
  if (!authed && secret && urlKey) {
    if (timingSafeEq(urlKey, secret)) { authed = true; authMode = "url_key"; }
  }

  // Parse the body up front — the IP-trust fallback needs to see the shape
  // before deciding whether to accept.
  let body: Record<string, unknown> = {};
  let bodyParseOk = false;
  if (raw) {
    try { body = JSON.parse(raw); bodyParseOk = true; } catch { bodyParseOk = false; }
  }

  if (!authed) {
    const sourceIp = clientIpFromHeaders(c);
    const ipAllowed = sourceIp && cfg.fineractWebhookAllowedIps.includes(sourceIp);
    const shapeOk = bodyParseOk && looksLikeFineractEvent(body);
    if (ipAllowed && shapeOk) {
      authed = true;
      authMode = "ip";
      log("warn", "fineract.webhook_accepted_by_ip", {
        source_ip: sourceIp,
        entity: String(body.entityName ?? "").toUpperCase(),
        action: String(body.actionName ?? "").toUpperCase(),
        resource_id: String(body.resourceId ?? body.loanId ?? ""),
        user_agent: c.req.header("user-agent") ?? "",
      });
    } else {
      // Temporary diagnostic: dump every request header + first 400 chars of
      // body so we can see what Fineract/OkHttp is actually sending vs what
      // our auth paths require. Scrub once diagnosed.
      const allHeaders: Record<string, string> = {};
      try {
        // deno-lint-ignore no-explicit-any
        const h = (c.req as any).raw?.headers as Headers | undefined;
        if (h) for (const [k, v] of h.entries()) allHeaders[k] = v;
      } catch { /* ignore */ }
      log("warn", "fineract.webhook_bad_auth", {
        had_sig: Boolean(sig),
        had_url_key: Boolean(urlKey),
        source_ip: sourceIp,
        ip_allowed: Boolean(ipAllowed),
        body_shape_ok: shapeOk,
        body_parse_ok: bodyParseOk,
        body_preview: raw.slice(0, 400),
        body_keys: bodyParseOk ? Object.keys(body) : [],
        url: c.req.url,
        path: new URL(c.req.url).pathname,
        query_keys: [...new URL(c.req.url).searchParams.keys()],
        headers: allHeaders,
      });
      return c.json({ error: { code: "AUTH_REQUIRED", message: "No valid signature, ?key=<secret>, or allowlisted source IP with Fineract-shaped body." } }, 401);
    }
  }

  if (!bodyParseOk) {
    return c.json({ error: { code: "VALIDATION_FAILED", message: "Body is not JSON." } }, 400);
  }
  // Fineract's webhook body shape varies by version. Common fields:
  //   entityName, actionName, resourceId, officeId, clientId, loanId.
  const entity = String(body.entityName ?? body.entity ?? "").toUpperCase();
  const action = String(body.actionName ?? body.action ?? "").toUpperCase();
  const loanId = String(body.loanId ?? body.resourceId ?? body.resource_id ?? "");
  if (entity !== "LOAN" || !loanId) {
    log("info", "fineract.webhook_ignored", { entity, action });
    return c.json({ data: { ignored: true, reason: "not a LOAN event" } });
  }
  const trigger = `webhook:LOAN/${action || "UNKNOWN"}`;
  const kind = DISBURSE_ACTIONS.has(action) ? "disburse"
    : RELEASE_ACTIONS.has(action) ? "release"
    : TIGHTENING_ACTIONS.has(action) ? "tighten"
    : "other";
  // The caller may embed a pre-built FineractLoanSummary as `body.loan`. This
  // is how the LMS Simulator drives dry-run reconciles without a real Fineract.
  // Real Fineract webhooks never carry this field — they take the fetch path.
  const override = coerceLoanOverride((body as Record<string, unknown>).loan, loanId);
  const source = override ? "override" : "fineract";
  log("info", "fineract.webhook_received", { entity, action, loan_id: loanId, kind, source, auth_mode: authMode });
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
    const status = result?.enqueued?.length ? 202 : 200;
    return c.json({ data: { trigger, kind, source, result } }, status);
  } catch (e) {
    log("warn", "fineract.webhook_apply_failed", { loan_id: loanId, source, error: String(e) });
    return c.json({ data: { trigger, kind, source, error: "processing_failed" } });
  }
}

export function fineractWebhookRoutes() {
  const r = new Hono();
  r.post("/hooks", handleFineractWebhook);
  return r;
}
