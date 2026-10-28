// Zoho OAuth token handling + HTTP client for the ManageEngine MDM Cloud API.
// One token cache per enterprise; one in-flight refresh per enterprise.
import { getConfig } from "../config.ts";
import { db, run, runMaybe } from "../lib/db.ts";
import { decryptSecret, encryptSecret } from "../lib/crypto.ts";
import { appError, type AppError, fail, isAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";

export type ZohoConnection = {
  enterprise_id: string;
  status: "pending" | "connected" | "error" | "revoked";
  accounts_server: string;
  api_base: string;
  client_id: string | null;
  client_secret_enc: string | null;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires_at: string | null;
  scopes: string[];
};

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

// ------------------------------------------------------------- data centres
const DC_MAP: Record<string, string> = {
  "accounts.zoho.com": "mdm.manageengine.com",
  "accounts.zoho.eu": "mdm.manageengine.eu",
  "accounts.zoho.in": "mdm.manageengine.in",
  "accounts.zoho.com.au": "mdm.manageengine.com.au",
  "accounts.zoho.jp": "mdm.manageengine.jp",
  "accounts.zoho.ca": "mdm.manageengine.ca",
  "accounts.zoho.uk": "mdm.manageengine.uk",
  "accounts.zoho.sa": "mdm.manageengine.sa",
  "accounts.zoho.com.cn": "mdm.manageengine.cn",
};

/** Only accept known Zoho account servers (prevents token exfiltration via a forged redirect). */
export function normaliseAccountsServer(raw: string | null | undefined): string {
  const fallback = "https://accounts.zoho.com";
  if (!raw) return fallback;
  try {
    const host = new URL(raw).host;
    if (!DC_MAP[host]) fail("ZOHO_OAUTH_FAILED", `Unknown Zoho data centre: ${host}`);
    return `https://${host}`;
  } catch (e) {
    if (isAppError(e)) throw e;
    fail("ZOHO_OAUTH_FAILED", "Invalid accounts server");
  }
}

export function apiBaseFor(accountsServer: string): string {
  const host = new URL(accountsServer).host;
  return `https://${DC_MAP[host] ?? "mdm.manageengine.com"}/api/v1/mdm`;
}

// --------------------------------------------------------------- connection
export async function getConnection(enterpriseId: string): Promise<ZohoConnection> {
  const conn = await runMaybe<ZohoConnection>(
    db().from("zoho_connections").select("*").eq("enterprise_id", enterpriseId).maybeSingle(),
  );
  if (!conn || !conn.refresh_token_enc || conn.status === "revoked") fail("ZOHO_NOT_CONNECTED");
  return conn;
}

async function clientCredentials(conn: ZohoConnection) {
  if (conn.client_id && conn.client_secret_enc) {
    return { clientId: conn.client_id, clientSecret: await decryptSecret(conn.client_secret_enc) };
  }
  const cfg = getConfig();
  if (!cfg.zohoClientId || !cfg.zohoClientSecret) fail("ZOHO_NOT_CONNECTED", "Platform Zoho client is not configured");
  return { clientId: cfg.zohoClientId, clientSecret: cfg.zohoClientSecret };
}

/** Exchange an authorization code (OAuth redirect or self-client code) for tokens. */
export async function exchangeCode(opts: {
  accountsServer: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  if (opts.redirectUri) params.set("redirect_uri", opts.redirectUri);
  const res = await fetch(`${opts.accountsServer}/oauth/v2/token`, {
    method: "POST",
    body: params,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.refresh_token) {
    fail("ZOHO_OAUTH_FAILED", `Zoho token exchange failed: ${data.error ?? res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in ?? 3600),
    scope: String(data.scope ?? ""),
  };
}

async function refreshAccessToken(conn: ZohoConnection): Promise<string> {
  const { clientId, clientSecret } = await clientCredentials(conn);
  const refreshToken = await decryptSecret(conn.refresh_token_enc!);
  const res = await fetch(`${conn.accounts_server}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => {
    throw appError("ZOHO_NETWORK", String(e));
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const reason = data.error ?? `HTTP ${res.status}`;
    await db().from("zoho_connections").update({ status: "error", last_error: `refresh: ${reason}` })
      .eq("enterprise_id", conn.enterprise_id);
    log("error", "zoho.refresh_failed", { enterprise_id: conn.enterprise_id, reason });
    fail("ZOHO_TOKEN_REFRESH_FAILED", `Zoho refresh failed: ${reason}`);
  }
  const expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
  await run(
    db().from("zoho_connections").update({
      access_token_enc: await encryptSecret(data.access_token),
      access_token_expires_at: new Date(expiresAt).toISOString(),
      status: "connected",
      last_error: null,
    }).eq("enterprise_id", conn.enterprise_id),
  );
  tokenCache.set(conn.enterprise_id, { token: data.access_token, expiresAt });
  return data.access_token;
}

export function getAccessToken(enterpriseId: string, forceRefresh = false): Promise<string> {
  const cached = tokenCache.get(enterpriseId);
  if (!forceRefresh && cached && cached.expiresAt - 60_000 > Date.now()) return Promise.resolve(cached.token);

  const pending = inflight.get(enterpriseId);
  if (pending) return pending;

  const p = (async () => {
    const conn = await getConnection(enterpriseId);
    const exp = conn.access_token_expires_at ? Date.parse(conn.access_token_expires_at) : 0;
    if (!forceRefresh && conn.access_token_enc && exp - 60_000 > Date.now()) {
      const token = await decryptSecret(conn.access_token_enc);
      tokenCache.set(enterpriseId, { token, expiresAt: exp });
      return token;
    }
    return await refreshAccessToken(conn);
  })().finally(() => inflight.delete(enterpriseId));

  inflight.set(enterpriseId, p);
  return p;
}

export function forgetToken(enterpriseId: string) {
  tokenCache.delete(enterpriseId);
}

/** Call after (re)connecting or disconnecting Zoho for an enterprise. */
export function forgetConnection(enterpriseId: string) {
  tokenCache.delete(enterpriseId);
  apiBaseCache.delete(enterpriseId);
}

// --------------------------------------------------------------- requests
export type ZohoRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // e.g. "/devices"
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

const apiBaseCache = new Map<string, string>();

async function apiBase(enterpriseId: string): Promise<string> {
  const hit = apiBaseCache.get(enterpriseId);
  if (hit) return hit;
  const conn = await getConnection(enterpriseId);
  apiBaseCache.set(enterpriseId, conn.api_base);
  return conn.api_base;
}

function mapHttpError(status: number, text: string): AppError {
  const snippet = text.slice(0, 300);
  // Zoho returns {"error_description": "...", "error_code": "...", "localized_error_description": "..."}.
  // Prefer the human sentence over the raw JSON so admins see "Command not applicable for Device",
  // not the whole payload. Fall back to the snippet when the body is not JSON.
  let friendly = snippet;
  try {
    const j = JSON.parse(text);
    friendly = j.localized_error_description ?? j.error_description ?? j.message ?? snippet;
  } catch { /* keep snippet */ }
  if (/SCOPE_MISMATCH/i.test(text)) return appError("ZOHO_SCOPE_MISMATCH", undefined, { zoho: snippet });
  // 412 is Zoho's "precondition failed" — used for CMD0001 "Command not applicable for Device" and friends.
  if (status === 400 || status === 412 || status === 422) {
    return appError("ZOHO_BAD_REQUEST", friendly, { zoho: snippet });
  }
  if (status === 401) return appError("ZOHO_UNAUTHORIZED", friendly, { zoho: snippet });
  if (status === 403) return appError("ZOHO_SCOPE_MISMATCH", friendly, { zoho: snippet });
  if (status === 404) return appError("ZOHO_NOT_FOUND", friendly, { zoho: snippet });
  if (status === 429) return appError("ZOHO_RATE_LIMITED");
  if (status >= 500) return appError("ZOHO_UNAVAILABLE", `Zoho returned ${status}`);
  return appError("ZOHO_BAD_REQUEST", `Zoho returned ${status}: ${friendly}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the MDM API. GET requests retry transient errors with backoff.
 * Writes are NOT retried here (Zoho has no idempotency keys) — the event queue retries them.
 */
export async function zohoRequest<T = unknown>(enterpriseId: string, req: ZohoRequest): Promise<T> {
  const method = req.method ?? "GET";
  const base = await apiBase(enterpriseId);
  const url = new URL(base + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const maxAttempts = method === "GET" ? 3 : 1;
  let lastErr: AppError | null = null;
  let refreshed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await getAccessToken(enterpriseId);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          Accept: "application/json",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(25_000),
      });
    } catch (e) {
      lastErr = appError("ZOHO_NETWORK", String(e));
      if (attempt < maxAttempts) await sleep(500 * 2 ** attempt);
      continue;
    }

    if (res.status === 401 && !refreshed) {
      // Token revoked/expired early: refresh once and retry (any method — request was rejected, not executed).
      refreshed = true;
      forgetToken(enterpriseId);
      await getAccessToken(enterpriseId, true);
      attempt--;
      continue;
    }

    const text = res.status === 204 ? "" : await res.text();
    if (res.ok) {
      log("debug", "zoho.request", { method, path: req.path, status: res.status });
      if (!text) return null as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }

    lastErr = mapHttpError(res.status, text);
    log("warn", "zoho.request_failed", { method, path: req.path, status: res.status, code: lastErr.code });
    if (!lastErr.retryable || attempt === maxAttempts) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
  }
  throw lastErr ?? appError("INTERNAL", "Zoho request failed");
}

/**
 * Upload a file to Zoho via the recommended /emsapi/files endpoint. Lives on
 * the host root, NOT under /api/v1/mdm. Required header: `Module` naming the
 * usage (e.g. MDM_PROFILES_IMAGES for wallpaper images). Returns Zoho's
 * fileID as a string (snowflake-sized — never Number() it).
 *
 * The handler is picky about Accept — "application/json" returns 406; omit it.
 */
export async function uploadFileToZoho(
  enterpriseId: string,
  module: string,
  file: { bytes: Uint8Array; filename: string; contentType: string },
): Promise<{ fileId: string; fileName: string; expiryDate: string }> {
  const conn = await getConnection(enterpriseId);
  const host = conn.api_base.replace(/\/api\/v1\/mdm$/, "");
  const url = `${host}/emsapi/files`;
  const token = await getAccessToken(enterpriseId);

  const fd = new FormData();
  // Deno's lib dom types want BlobPart (ArrayBuffer | TypedArray with ArrayBuffer backing).
  // Uint8Array<ArrayBufferLike> isn't accepted directly — slice the underlying buffer.
  const buf = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
  fd.append("file", new Blob([buf], { type: file.contentType }), file.filename);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, Module: module },
    body: fd,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    log("warn", "zoho.file_upload_failed", { module, status: res.status, body: text.slice(0, 300) });
    throw appError("ZOHO_BAD_REQUEST", `File upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  // Response is a JSON ARRAY with one entry per uploaded file.
  const parsed = JSON.parse(text) as { fileID: string; fileName: string; expiryDate: string }[];
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.fileID) fail("ZOHO_BAD_REQUEST", "Zoho did not return a fileID");
  return { fileId: String(first.fileID), fileName: first.fileName, expiryDate: first.expiryDate };
}

/** Return the first array found in a Zoho list response ({devices:[...]}, {groups:[...]}, ...). */
export function firstArray<T = Record<string, unknown>>(data: unknown, preferredKey?: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (preferredKey && Array.isArray(o[preferredKey])) return o[preferredKey] as T[];
    for (const v of Object.values(o)) if (Array.isArray(v)) return v as T[];
  }
  return [];
}

/** Walk all pages (offset/limit) of a list endpoint. */
export async function zohoPaginate<T = Record<string, unknown>>(
  enterpriseId: string,
  path: string,
  key: string,
  query: Record<string, string | number | boolean | undefined> = {},
  pageSize = 200,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await zohoRequest<Record<string, unknown>>(enterpriseId, {
      path,
      query: { ...query, limit: pageSize, offset: page * pageSize },
    });
    const items = firstArray<T>(data, key);
    out.push(...items);
    const next = (data?.paging as { next?: string } | undefined)?.next;
    if (items.length < pageSize || !next) break;
  }
  return out;
}
