// Fetch wrapper: session cookie, CSRF header, idempotency keys, uniform errors.

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

/**
 * api("POST", "/api/groups", body, { idem }) -> { status, data }
 * Mutations get an Idempotency-Key automatically; pass the same key to retry safely.
 */
export async function api(method, path, body, opts = {}) {
  const headers = { "x-mdm-request": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = opts.idem ?? newIdempotencyKey();

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw apiError("NETWORK", "Cannot reach the server. Check your connection.", 0);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }

  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    onUnauthorized();
    throw apiError("AUTH_REQUIRED", "Your session has ended. Sign in again.", 401);
  }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw apiError(e.code ?? "HTTP_" + res.status, e.message ?? `Request failed (${res.status})`, res.status, e.details);
  }
  return { status: res.status, data: json?.data };
}

function apiError(code, message, status, details) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.details = details;
  return err;
}

export const get = (path) => api("GET", path).then((r) => r.data);
export const post = (path, body, opts) => api("POST", path, body ?? {}, opts);
export const del = (path, body, opts) => api("DELETE", path, body, opts);

/** POST multipart/form-data. Browser sets Content-Type (with boundary). */
export async function uploadFile(path, file, extraFields = {}) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  for (const [k, v] of Object.entries(extraFields)) fd.append(k, String(v));
  const res = await fetch(path, {
    method: "POST",
    headers: { "x-mdm-request": "1", "idempotency-key": newIdempotencyKey() },
    credentials: "same-origin",
    body: fd,
  });
  const json = await res.json().catch(() => null);
  if (res.status === 401) { onUnauthorized(); throw apiError("AUTH_REQUIRED", "Session ended", 401); }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw apiError(e.code ?? "HTTP_" + res.status, e.message ?? `Upload failed (${res.status})`, res.status, e.details);
  }
  return json?.data;
}
