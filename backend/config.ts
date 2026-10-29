// Central configuration. Read once from the environment; never log secrets.

export type Config = Readonly<{
  env: "development" | "production";
  port: number;
  appUrl: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  encryptionKey: string; // base64, 32 bytes (AES-256-GCM)
  hashPepper: string; // secret used to HMAC OTP codes and confirmation codes
  zohoClientId: string; // server-based client for the "Connect Zoho" OAuth flow
  zohoClientSecret: string;
  zohoRedirectUri: string;
  zohoScopes: string;
  mailProvider: "console" | "resend" | "zeptomail";
  zeptomailToken: string;
  zeptomailUrl: string;
  resendApiKey: string;
  mailFrom: string;
  sessionTtlHours: number;
  otpTtlMinutes: number;
  confirmTtlMinutes: number;
  workerIntervalSeconds: number;
  syncIntervalMinutes: number;
  deviceStaleHours: number; // > this since last Zoho check-in → UI shows "stale" badge
  deviceZombieDays: number; // > this since last check-in → auto-mark is_removed in sync
  cookieSecure: boolean;
  // --- Loan-driven device automation (LOAN_DEVICE_AUTOMATION.md) ---
  // All optional: if fineractBaseUrl is empty the Bridge stays dormant and the
  // app boots the same as before. Supplied here for the automation worker + the
  // /api/fineract/hooks ingress; actual values live in .env (never committed).
  fineractBaseUrl: string;
  fineractTenantId: string;
  fineractUsername: string;
  fineractPassword: string;
  fineractWebhookSecret: string;        // HMAC fallback when per-enterprise automation_settings.webhook_secret_enc isn't set
  automationTickMinutes: number;        // daily tick cadence (default 60 = hourly reconcile, cheaper than one-shot per day for Phase 0)
}>;

const DEFAULT_SCOPES = [
  "MDMOnDemand.MDMInventory.ALL",
  "MDMOnDemand.MDMDeviceMgmt.ALL",
  "MDMOnDemand.MDMUser.ALL",
].join(",");

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name);
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const v = Deno.env.get(name);
  const n = v ? Number(v) : fallback;
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const appEnv = env("APP_ENV", "development") === "production" ? "production" : "development";
  const appUrl = env("APP_URL", "http://localhost:8000").replace(/\/$/, "");
  cached = Object.freeze({
    env: appEnv,
    port: num("PORT", 8000),
    appUrl,
    supabaseUrl: env("SUPABASE_URL"),
    supabaseServiceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    encryptionKey: env("ENCRYPTION_KEY"),
    hashPepper: env("HASH_PEPPER"),
    zohoClientId: env("ZOHO_CLIENT_ID", ""),
    zohoClientSecret: env("ZOHO_CLIENT_SECRET", ""),
    zohoRedirectUri: env("ZOHO_REDIRECT_URI", `${appUrl}/api/zoho/callback`),
    zohoScopes: env("ZOHO_SCOPES", DEFAULT_SCOPES),
    mailProvider: (["resend", "zeptomail"].includes(env("MAIL_PROVIDER", "console")) ? env("MAIL_PROVIDER") : "console") as Config["mailProvider"],
    zeptomailToken: env("ZEPTOMAIL_TOKEN", ""),
    zeptomailUrl: env("ZEPTOMAIL_URL", "https://zeptomail.zoho.com/v1.1/email"),
    resendApiKey: env("RESEND_API_KEY", ""),
    mailFrom: env("MAIL_FROM", "MDM Console <no-reply@example.com>"),
    sessionTtlHours: num("SESSION_TTL_HOURS", 12),
    otpTtlMinutes: num("OTP_TTL_MINUTES", 10),
    confirmTtlMinutes: num("CONFIRM_TTL_MINUTES", 10),
    workerIntervalSeconds: num("WORKER_INTERVAL_SECONDS", 15),
    syncIntervalMinutes: num("SYNC_INTERVAL_MINUTES", 15),
    deviceStaleHours: num("DEVICE_STALE_HOURS", 48),
    deviceZombieDays: num("DEVICE_ZOMBIE_DAYS", 14),
    cookieSecure: env("COOKIE_SECURE", appEnv === "production" ? "true" : "false") === "true",
    fineractBaseUrl: env("FINERACT_BASE_URL", "").replace(/\/$/, ""),
    fineractTenantId: env("FINERACT_TENANT_ID", "default"),
    fineractUsername: env("FINERACT_USERNAME", ""),
    fineractPassword: env("FINERACT_PASSWORD", ""),
    fineractWebhookSecret: env("FINERACT_WEBHOOK_SECRET", ""),
    // 30 min keeps DPD-driven transitions within the same business hour as the
    // DPD rollover; 60 was Phase 0's conservative default.
    automationTickMinutes: num("AUTOMATION_TICK_MINUTES", 30),
  });
  if (cached.env === "production" && cached.mailProvider === "console") {
    throw new Error("MAIL_PROVIDER=console is not allowed in production (OTP codes would be logged)");
  }
  return cached;
}
