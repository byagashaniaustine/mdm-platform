// Malipopay (core-prod.malipopay.co.tz) read-only client.
//
// Scope today: the per-loan reconciliation check at loans.ts lifts Malipopay
// references (ML…) out of Fineract repayment notes and looks each one up here.
// Outbound collection (USSD push) and webhook ingress are deliberately absent
// until Harvey confirms direction — see Malipopay Integration Packet, Nov 24.
//
// Auth: `apiToken: <KEY>` on every request. No separate sandbox host — the
// account itself is sandbox until go-live is approved (TZS 100k/day cap per
// direction, test recipients only). Webhook signature verification is kept
// here so a future webhook route can import it without a second copy.

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

function normalize(raw: Record<string, unknown>): MalipoPayment {
  const data = (raw.data ?? raw) as Record<string, unknown>;
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
