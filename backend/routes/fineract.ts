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
    finalDueOn: r.finalDueOn == null ? null : String(r.finalDueOn),
    dpd: Math.max(0, Number(r.dpd ?? 0) || 0),
    totalOutstanding: Number(r.totalOutstanding ?? 0) || 0,
    principalDisbursed: Number(r.principalDisbursed ?? 0) || 0,
    totalRepaid: Number(r.totalRepaid ?? 0) || 0,
    nextInstallmentAmount: Number(r.nextInstallmentAmount ?? 0) || 0,
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
// on hook registration when the Payload URL contains any path segment.
//
// Four accepted auth modes, tried in order:
//   1. HMAC: X-Fineract-Signature header carrying the hex HMAC-SHA256 of the
//      raw body under FINERACT_WEBHOOK_SECRET. CE 1.x doesn't produce it.
//   2. URL-param: a `?key=<FINERACT_WEBHOOK_SECRET>` query string. OkHttp 4.12
//      (CE 1.15's HTTP client) drops the query at delivery time, so this mode
//      effectively never triggers today — kept for future signed builds.
//   3. IP-source + body-shape: if FINERACT_WEBHOOK_ALLOWED_IPS matches and
//      the body is Fineract-shaped. Also non-functional on Deno Deploy today,
//      since the edge does NOT forward x-forwarded-for / x-real-ip on the
//      root POST route — the proxy chain terminates at deno-cluster and the
//      source IP is unobservable from userland. Kept for other hosting.
//   4. Fineract-header trust: Fineract CE 1.15 reliably sets custom headers
//      on each delivery: X-Fineract-Entity, X-Fineract-Action,
//      X-Fineract-Endpoint, Fineract-Platform-TenantId, User-Agent: okhttp/*.
//      When all four are present AND match a known shape AND the body parses
//      to a LOAN-event envelope, accept. This is the only path that actually
//      fires on istore today. It's a weak auth — any client who guesses the
//      URL can forge the headers — so it's logged loudly and we should swap
//      it out the moment Harvey wires a shared-secret header on the server.
const FINERACT_LOAN_ACTIONS = new Set<string>([
  ...DISBURSE_ACTIONS, ...RELEASE_ACTIONS, ...TIGHTENING_ACTIONS,
  "APPROVE", "APPROVALUNDO", "REJECT", "WITHDRAW",
  "ADJUSTTRANSACTION", "ADJUST", "UPDATE", "CREATE",
]);

function clientIpFromHeaders(c: { req: { header: (n: string) => string | undefined } }): string {
  const tries = [
    "x-forwarded-for", "x-real-ip", "cf-connecting-ip",
    "fly-client-ip", "true-client-ip", "x-client-ip",
  ];
  for (const name of tries) {
    const v = c.req.header(name) ?? "";
    const first = v.split(",")[0]?.trim();
    if (first) return first;
  }
  return "";
}

/** Extract the loan id from the real Fineract envelope — not the sim one. */
function extractLoanId(body: Record<string, unknown>): string {
  // Sim/legacy shape: top-level resourceId/loanId.
  const top = String(body.loanId ?? body.resourceId ?? body.resource_id ?? "");
  if (top) return top;
  // CE 1.15 real shape wraps the result: body.response.loanId and
  // body.response.resourceId both carry it (resourceId is also the
  // sub-transaction id for repayments; loanId is the parent).
  const resp = (body as Record<string, unknown>).response;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    return String(r.loanId ?? r.resourceId ?? "");
  }
  return "";
}

function looksLikeFineractEvent(body: Record<string, unknown>): boolean {
  const entity = String(body.entityName ?? body.entity ?? "").toUpperCase();
  const action = String(body.actionName ?? body.action ?? "").toUpperCase();
  return entity === "LOAN"
    && extractLoanId(body).length > 0
    && FINERACT_LOAN_ACTIONS.has(action);
}

/**
 * The CE 1.15 Web hook delivery sets a specific set of custom headers. We treat
 * the presence+consistency of all four as weak proof the request came from
 * Fineract. Forgeable by anyone who knows our URL; combined with body-shape
 * it's still a high-signal "came from Fineract" heuristic, and currently the
 * only one that fires.
 */
function hasFineractHeaders(
  c: { req: { header: (n: string) => string | undefined } },
  body: Record<string, unknown>,
): boolean {
  const hEntity = (c.req.header("x-fineract-entity") ?? "").toUpperCase();
  const hAction = (c.req.header("x-fineract-action") ?? "").toUpperCase();
  const hEndpoint = c.req.header("x-fineract-endpoint") ?? "";
  const hTenant = c.req.header("fineract-platform-tenantid") ?? "";
  const ua = c.req.header("user-agent") ?? "";
  if (!hEntity || !hAction || !hEndpoint || !hTenant) return false;
  if (!ua.toLowerCase().startsWith("okhttp/")) return false;
  const bEntity = String(body.entityName ?? body.entity ?? "").toUpperCase();
  const bAction = String(body.actionName ?? body.action ?? "").toUpperCase();
  return hEntity === "LOAN" && hEntity === bEntity && hAction === bAction;
}
// deno-lint-ignore no-explicit-any
export async function handleFineractWebhook(c: any) {
  const cfg = getConfig();
  const secret = cfg.fineractWebhookSecret;
  const raw = await c.req.text();
  const sig = c.req.header("X-Fineract-Signature") ?? c.req.header("x-fineract-signature") ?? "";
  const urlKey = c.req.query("key") ?? "";

  let authed = false;
  let authMode: "hmac" | "url_key" | "ip" | "headers" | "none" = "none";
  if (secret && sig) {
    const expected = await hmacHex(secret, raw);
    if (timingSafeEq(sig.toLowerCase(), expected)) { authed = true; authMode = "hmac"; }
  }
  if (!authed && secret && urlKey) {
    if (timingSafeEq(urlKey, secret)) { authed = true; authMode = "url_key"; }
  }

  let body: Record<string, unknown> = {};
  let bodyParseOk = false;
  if (raw) {
    try { body = JSON.parse(raw); bodyParseOk = true; } catch { bodyParseOk = false; }
  }

  if (!authed) {
    const sourceIp = clientIpFromHeaders(c);
    const ipAllowed = sourceIp && cfg.fineractWebhookAllowedIps.includes(sourceIp);
    const shapeOk = bodyParseOk && looksLikeFineractEvent(body);
    const headersOk = bodyParseOk && hasFineractHeaders(c, body);
    if (ipAllowed && shapeOk) {
      authed = true;
      authMode = "ip";
      log("warn", "fineract.webhook_accepted_by_ip", {
        source_ip: sourceIp,
        action: String(body.actionName ?? "").toUpperCase(),
        loan_id: extractLoanId(body),
      });
    } else if (headersOk) {
      authed = true;
      authMode = "headers";
      log("warn", "fineract.webhook_accepted_by_headers", {
        entity: c.req.header("x-fineract-entity"),
        action: c.req.header("x-fineract-action"),
        endpoint: c.req.header("x-fineract-endpoint"),
        tenant: c.req.header("fineract-platform-tenantid"),
        user_agent: c.req.header("user-agent"),
        loan_id: extractLoanId(body),
      });
    } else {
      log("warn", "fineract.webhook_bad_auth", {
        had_sig: Boolean(sig),
        had_url_key: Boolean(urlKey),
        source_ip: sourceIp,
        ip_allowed: Boolean(ipAllowed),
        body_shape_ok: shapeOk,
        headers_ok: headersOk,
        body_parse_ok: bodyParseOk,
      });
      return c.json({ error: { code: "AUTH_REQUIRED", message: "No valid signature, allowlisted IP, or Fineract-identifying headers." } }, 401);
    }
  }

  if (!bodyParseOk) {
    return c.json({ error: { code: "VALIDATION_FAILED", message: "Body is not JSON." } }, 400);
  }
  const entity = String(body.entityName ?? body.entity ?? "").toUpperCase();
  const action = String(body.actionName ?? body.action ?? "").toUpperCase();
  const loanId = extractLoanId(body);
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
