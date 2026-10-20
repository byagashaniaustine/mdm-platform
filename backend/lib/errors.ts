// Error codes + messages. Mirrors the error_codes table in database/schema.sql.
// Function-based: errors are plain Error objects decorated with a code (no classes).

export const ERROR_CATALOG = {
  AUTH_REQUIRED: { status: 401, message: "Sign in to continue.", retryable: false },
  AUTH_INVALID_OTP: { status: 401, message: "The code is incorrect.", retryable: false },
  AUTH_INVALID_CREDENTIALS: { status: 401, message: "Email or password is incorrect.", retryable: false },
  AUTH_INVITE_INVALID: { status: 401, message: "This link is invalid, already used, or expired. Ask your enterprise owner for a new one.", retryable: false },
  AUTH_OTP_EXPIRED: { status: 401, message: "The code has expired. Request a new one.", retryable: false },
  AUTH_TOO_MANY_ATTEMPTS: { status: 429, message: "Too many attempts. Try again later.", retryable: false },
  AUTH_FORBIDDEN: { status: 403, message: "Your role does not allow this action.", retryable: false },
  VALIDATION_FAILED: { status: 400, message: "Some fields are missing or invalid.", retryable: false },
  NOT_FOUND: { status: 404, message: "The item was not found.", retryable: false },
  CONFLICT: { status: 409, message: "The item already exists or was changed.", retryable: false },
  ENTERPRISE_EXISTS: { status: 409, message: "An enterprise with this email already exists.", retryable: false },
  RATE_LIMITED: { status: 429, message: "Too many requests. Slow down.", retryable: true },
  ZOHO_NOT_CONNECTED: { status: 412, message: "Connect your Zoho account first.", retryable: false },
  ZOHO_OAUTH_FAILED: { status: 502, message: "Zoho sign-in failed.", retryable: false },
  ZOHO_TOKEN_REFRESH_FAILED: { status: 502, message: "Could not refresh the Zoho access token. Reconnect Zoho.", retryable: false },
  ZOHO_UNAUTHORIZED: { status: 502, message: "Zoho rejected the credentials.", retryable: false },
  ZOHO_SCOPE_MISMATCH: { status: 502, message: "The Zoho token is missing required scopes.", retryable: false },
  ZOHO_BAD_REQUEST: { status: 422, message: "Zoho rejected the request.", retryable: false },
  ZOHO_NOT_FOUND: { status: 404, message: "The item does not exist in Zoho.", retryable: false },
  ZOHO_RATE_LIMITED: { status: 503, message: "Zoho rate limit reached. Will retry.", retryable: true },
  ZOHO_UNAVAILABLE: { status: 503, message: "Zoho is unavailable. Will retry.", retryable: true },
  ZOHO_NETWORK: { status: 503, message: "Network error talking to Zoho. Will retry.", retryable: true },
  COMMAND_UNKNOWN: { status: 400, message: "Unknown device action.", retryable: false },
  COMMAND_CONFIRMATION_REQUIRED: { status: 202, message: "This action needs a second confirmation.", retryable: false },
  COMMAND_CONFIRMATION_INVALID: { status: 400, message: "Confirmation details do not match.", retryable: false },
  COMMAND_CONFIRMATION_EXPIRED: { status: 410, message: "Confirmation window expired.", retryable: false },
  SYNC_IN_PROGRESS: { status: 409, message: "A sync is already running for this enterprise. Try again in a minute.", retryable: true },
  DIRECT_PROFILE_DEVICE_BLOCKED: { status: 400, message: "Profiles are applied through groups only.", retryable: false },
  PROFILE_NOT_PUBLISHED: { status: 409, message: "Publish the profile before associating it.", retryable: false },
  TRACKING_DISABLED: { status: 409, message: "Location tracking is turned off for this enterprise.", retryable: false },
  CONSENT_REQUIRED: { status: 400, message: "Confirm that employees have been informed before enabling tracking.", retryable: false },
  MAX_RETRIES_EXCEEDED: { status: 500, message: "Gave up after several retries; moved to backlog.", retryable: false },
  INTERNAL: { status: 500, message: "Unexpected server error.", retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export type AppError = Error & {
  isAppError: true;
  code: ErrorCode;
  status: number;
  retryable: boolean;
  details?: unknown;
};

export function appError(code: ErrorCode, message?: string, details?: unknown): AppError {
  const entry = ERROR_CATALOG[code];
  const err = new Error(message ?? entry.message) as AppError;
  err.name = "AppError";
  err.isAppError = true;
  err.code = code;
  err.status = entry.status;
  err.retryable = entry.retryable;
  err.details = details;
  return err;
}

export function fail(code: ErrorCode, message?: string, details?: unknown): never {
  throw appError(code, message, details);
}

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && (e as AppError).isAppError === true;
}

export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof TypeError) return appError("ZOHO_NETWORK", e.message);
  return appError("INTERNAL", e instanceof Error ? e.message : String(e));
}

// Shape returned to the browser. Admin tool — the real reason is more useful than a generic 500.
export function errorBody(e: AppError) {
  return {
    error: {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      details: e.details,
    },
  };
}
