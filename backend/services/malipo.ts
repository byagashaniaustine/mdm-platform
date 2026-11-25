// Malipopay (core-prod.malipopay.co.tz) client.
//
// Scope:
//   - createCollection: on disburse, pre-create one FLEXIBLE push:false
//     collection per loan targeting iStore's merchant identifier. The returned
//     ML… reference goes to the borrower via email so the webhook can match
//     payments to the loan via customerReference.
//   - getPaymentByReference: used by the per-loan reconciliation check in
//     loans.ts, called on webhook delivery to fetch the authoritative state.
//   - listChannels: connectivity probe.
//   - verifyWebhookSignature: imported by the /api/malipo/hooks route.
//
// Auth: `apiToken: <KEY>` on every request. No separate sandbox host — the
// account itself is sandbox until go-live is approved (TZS 100k/day cap per
// direction, test recipients only). See Malipopay Integration Packet, Nov 24.

import { getConfig } from "../config.ts";
import { withBreaker } from "../lib/circuit.ts";
import { appError, fail, toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";

export interface MalipoPayment {
  reference: string;                    // Malipopay reference (ML…)
  customerReference: string | null;     // our reference if we set one on create
  description: string | null;
  amount: number;                       // gross TZS
  feeAmount: number;                    // deducted on receipt
  netAmount: number;                    // amount - feeAmount, what reached the wallet
  status: "SUCCESSFUL" | "PAID" | "PARTIAL" | "PROCESSING" | "FAILED" | "CANCELLED" | "TIMEOUT" | "AWAITING_APPROVAL" | "UNKNOWN";
  service: string | null;               // mobile | account | merchant | tanqr
  provider: string | null;              // VODACOM | AIRTEL | TIGO | HALOPESA | TTCL | CRDB | NMB
  account: string | null;               // phone/bank-account/till (masked server-side, we pass through)
  createdAt: string | null;             // ISO; Malipopay uses its own format, we accept the string
  confirmedAt: string | null;
  raw: Record<string, unknown>;         // full API payload for audit
}

interface MalipoAuth {
  baseUrl: string;
  apiToken: string;
}

function auth(): MalipoAuth {
  const c = getConfig();
  if (!c.malipoApiKey) fail("MALIPO_UNCONFIGURED");
  return { baseUrl: c.malipoBaseUrl, apiToken: c.malipoApiKey };
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const a = auth();
  const url = `${a.baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "apiToken": a.apiToken,
        "Accept": "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    log("warn", "malipo.network_error", { path, error: String(e) });
    throw appError("MALIPO_UNAVAILABLE");
  }
  const text = await res.text();
  if (res.ok) {
    try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
  }
  log("warn", "malipo.request_failed", { path, status: res.status, body: text.slice(0, 200) });
  if (res.status === 401 || res.status === 403) throw appError("MALIPO_UNAUTHORIZED");
  if (res.status === 404) throw appError("MALIPO_NOT_FOUND");
  if (res.status >= 500) throw appError("MALIPO_UNAVAILABLE");
  throw appError("MALIPO_BAD_REQUEST", `Malipopay returned ${res.status}: ${text.slice(0, 200)}`);
}

const BREAKER = "malipo";
const NON_UPSTREAM: ReadonlySet<string> = new Set([
  "MALIPO_UNCONFIGURED",
  "MALIPO_NOT_FOUND",
  "MALIPO_BAD_REQUEST",
]);
function isNetworkFailure(e: unknown): boolean {
  return !NON_UPSTREAM.has(toAppError(e).code);
}

function pickStatus(raw: unknown): MalipoPayment["status"] {
  const s = String(raw ?? "").toUpperCase();
  if (s === "SUCCESSFUL" || s === "PAID" || s === "PARTIAL" || s === "PROCESSING" || s === "FAILED" || s === "CANCELLED" || s === "TIMEOUT" || s === "AWAITING_APPROVAL") {
    return s;
  }
  return "UNKNOWN";
}

function normalize(raw: Record<string, unknown>): MalipoPayment | null {
  // Malipopay's envelope is `{ success, code, message, data: {…} | null }`.
  // A 200 with `data: null` means "no such reference" — we surface as null so
  // the reconciliation check can flag it as a mismatch (Fineract claims a
  // payment Malipopay has no record of) instead of producing a bogus row.
  const data = (raw.data ?? null) as Record<string, unknown> | null;
  if (!data) return null;
  const amount = Number(data.amount ?? 0);
  const fee = Number(data.feeAmount ?? 0);
  const net = data.netAmount != null ? Number(data.netAmount) : (amount - fee);
  return {
    reference: String(data.reference ?? ""),
    customerReference: (data.customerReference as string | null) || null,
    description: (data.description as string | null) || null,
    amount,
    feeAmount: fee,
    netAmount: net,
    status: pickStatus(data.status),
    service: (data.service as string | null) || null,
    provider: (data.provider as string | null) || null,
    account: (data.account as string | null) || null,
    createdAt: (data.createdAt as string | null) || (data.created_at as string | null) || null,
    confirmedAt: (data.confirmedAt as string | null) || (data.completedAt as string | null) || null,
    raw: data,
  };
}

// iStore's merchant identifiers inside Malipopay, from the Integration Packet
// page 4 ("Wallet top-ups: identifier 863260 under biller MALIPOPAY (NMB, CRDB)
// or business number 700500 with reference 99940863260 (TCB)") + Harvey's
// confirmation 2026-11-24. These are the `account` values we pass when creating
// customer-initiated bill-pay collections — they are NOT secrets.
export const ISTORE_ACCOUNT_NMB_CRDB = "863260";
export const ISTORE_ACCOUNT_TCB = "99940863260";

export interface CreateCollectionInput {
  reference: string;             // our order/loan id. Reusing it is idempotent.
  description: string;           // shown on the payment record.
  amount: number;                // whole TZS; FLEXIBLE allows part payments up to this.
  account?: string;              // target. Defaults to ISTORE_ACCOUNT_NMB_CRDB.
  service?: "account" | "merchant" | "mobile" | "tanqr";
  provider?: string;             // optional; required for `account` direct-charge, not bill-pay.
  amountType?: "FULL" | "FIXED" | "FLEXIBLE";
  push?: boolean;                // default false → bank bill-pay ref the customer uses.
}

export interface CreateCollectionResult {
  reference: string;             // Malipopay ML… reference the customer will type at the bank.
  status: string;                // e.g. "PROCESSING" for push=true; "PENDING" for push=false.
  code: number | null;           // Malipopay result code, e.g. 1109.
  raw: Record<string, unknown>;  // full response for audit.
}

/**
 * Create a Malipopay collection. For our disburse flow we call this with
 * push:false + FLEXIBLE so one ML reference carries every repayment made
 * against the loan until the total is reached. The customer types the ML…
 * ref at NMB/CRDB biller MALIPOPAY (or TCB business 700500); the webhook
 * then arrives with both `reference` (Malipopay's ML…) and `customerReference`
 * (what we set here as `input.reference`).
 *
 * Returning null is NOT a case — on any failure we throw MALIPO_* so the caller
 * can decide whether to roll back the disburse (we choose not to; the email
 * falls back to the merchant-level 863260 instructions).
 */
export async function createCollection(input: CreateCollectionInput): Promise<CreateCollectionResult> {
  const body = {
    reference: input.reference,
    description: input.description,
    amount: input.amount,
    service: input.service ?? "account",
    account: input.account ?? ISTORE_ACCOUNT_NMB_CRDB,
    amountType: input.amountType ?? "FLEXIBLE",
    push: input.push ?? false,
    ...(input.provider ? { provider: input.provider } : {}),
  };
  const raw = await withBreaker(BREAKER, () =>
    req<Record<string, unknown>>(`/api/v2/payment/collection`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { countFailure: isNetworkFailure },
  );
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const ref = String(data.reference ?? "");
  if (!ref) {
    // Malipopay returned 2xx but no reference — treat as upstream contract
    // violation rather than a successful create.
    throw appError("MALIPO_BAD_REQUEST", `Malipopay create returned no reference: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return {
    reference: ref,
    status: String(data.status ?? "UNKNOWN"),
    code: raw.code != null ? Number(raw.code) : null,
    raw,
  };
}

/**
 * Look up a single payment by its Malipopay reference (ML…). v1 path is still
 * documented in the integration packet. Returns null when the reference isn't
 * known — callers treat that as "Fineract claims a payment Malipopay has no
 * record of" (mismatch), not an error.
 */
export async function getPaymentByReference(reference: string): Promise<MalipoPayment | null> {
  try {
    const raw = await withBreaker(BREAKER, () =>
      req<Record<string, unknown>>(`/api/v1/payment/reference/${encodeURIComponent(reference)}`),
      { countFailure: isNetworkFailure },
    );
    // normalize returns null for `data: null` (200-with-no-such-ref), which
    // this layer still exposes as null to the caller. 404 is handled below
    // in case Malipopay's behavior ever changes.
    return normalize(raw);
  } catch (e) {
    if (toAppError(e).code === "MALIPO_NOT_FOUND") return null;
    throw e;
  }
}

/**
 * Lightweight connectivity probe used by the reconciliation check to say
 * "Fineract ↔ Malipopay link is up" before it bothers looking at refs.
 * Returns the raw channels payload; a shape change is not a reason to fail.
 */
export async function listChannels(): Promise<Record<string, unknown>> {
  return await withBreaker(BREAKER, () =>
    req<Record<string, unknown>>(`/api/v2/payment/channels`),
    { countFailure: isNetworkFailure },
  );
}

/**
 * HMAC-SHA256 of the RAW request body, keyed by the webhook signing secret
 * (not the API key — the packet is explicit). Header form:
 *     X-Malipopay-Signature: sha256=<hex>
 * Kept in this module so a future webhook route can import it directly.
 */
export async function verifyWebhookSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = getConfig().malipoWebhookSecret;
  if (!secret || !header) return false;
  const provided = header.replace(/^sha256=/i, "").trim();
  if (!provided) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time compare. Length check first — short-circuit a non-match
  // without a timing signal that leaks the prefix.
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/**
 * Pull every Malipopay reference out of a free-text note. Harvey's convention
 * is to write the ML reference (e.g. "paid via ML008985") into the Fineract
 * repayment's note field. Pattern is `ML` + 5+ digits, case-insensitive.
 * Returns refs upper-cased and de-duplicated in encounter order.
 */
export function extractReferencesFromNote(note: string | null | undefined): string[] {
  if (!note) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of note.matchAll(/\bML\d{5,}\b/gi)) {
    const ref = m[0].toUpperCase();
    if (!seen.has(ref)) { seen.add(ref); out.push(ref); }
  }
  return out;
}
