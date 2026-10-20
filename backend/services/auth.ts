// Enterprise registration, passwordless OTP login and session keys.
import { getConfig } from "../config.ts";
import { db, run, runMaybe } from "../lib/db.ts";
import { hashPassword, hmacHex, randomDigits, randomToken, safeEqual, sha256Hex, verifyPassword } from "../lib/crypto.ts";
import { fail } from "../lib/errors.ts";
import { inviteMail, otpMail, sendMail } from "./mail.ts";
import { log } from "../lib/log.ts";
import { recordAudit } from "./events.ts";
import { noteLogin } from "./monitoring.ts";

export type Role = "owner" | "admin" | "viewer";

export type Session = {
  sessionId: string;
  adminId: string;
  enterpriseId: string;
  enterpriseName: string;
  email: string;
  fullName: string | null;
  role: Role;
};

const MAX_OTP_ATTEMPTS = 5;
const MAX_OTP_PER_15_MIN = 5;

type AdminRow = { id: string; enterprise_id: string; email: string; full_name: string | null; role: Role; is_active: boolean; password_hash?: string | null };

const MIN_PASSWORD_LENGTH = 10;

function assertPasswordStrength(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) fail("VALIDATION_FAILED", `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > 200) fail("VALIDATION_FAILED", "Password is too long");
}

export async function registerEnterprise(input: {
  enterpriseName: string;
  email: string;
  fullName: string;
  ip: string | null;
  password?: string | null;
}): Promise<{ hasPassword: boolean }> {
  const existing = await runMaybe<{ id: string }>(
    db().from("admins").select("id").eq("email", input.email).maybeSingle(),
  );
  if (existing) fail("ENTERPRISE_EXISTS");

  if (input.password) assertPasswordStrength(input.password);

  const enterprise = await run<{ id: string }>(
    db().from("enterprises").insert({ name: input.enterpriseName, email: input.email }).select("id").single(),
  );
  let admin: AdminRow;
  try {
    admin = await run<AdminRow>(
      db().from("admins").insert({
        enterprise_id: enterprise.id,
        email: input.email,
        full_name: input.fullName,
        role: "owner",
        password_hash: input.password ? await hashPassword(input.password) : null,
      }).select("*").single(),
    );
  } catch (e) {
    await db().from("enterprises").delete().eq("id", enterprise.id); // no orphan enterprise
    throw e;
  }
  await db().from("zoho_connections").insert({ enterprise_id: enterprise.id, status: "pending" });
  await db().from("monitoring_settings").insert({ enterprise_id: enterprise.id });
  await recordAudit({ enterpriseId: enterprise.id, adminId: admin.id, category: "auth", action: "enterprise.registered" });
  if (!input.password) await issueOtp(admin, "register", input.ip);
  return { hasPassword: Boolean(input.password) };
}

/** Always resolves (no account enumeration); only sends a code if the admin exists. */
export async function requestLoginOtp(email: string, ip: string | null): Promise<void> {
  const admin = await runMaybe<AdminRow>(db().from("admins").select("*").eq("email", email).maybeSingle());
  if (!admin || !admin.is_active) return;
  await issueOtp(admin, "login", ip);
}

async function issueOtp(admin: AdminRow, purpose: "login" | "register", ip: string | null) {
  const cfg = getConfig();
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await db().from("otp_codes").select("id", { count: "exact", head: true })
    .eq("admin_id", admin.id).gte("created_at", since);
  if ((count ?? 0) >= MAX_OTP_PER_15_MIN) fail("AUTH_TOO_MANY_ATTEMPTS");

  // Invalidate older unused codes so only the newest one works.
  await db().from("otp_codes").update({ consumed_at: new Date().toISOString() })
    .eq("admin_id", admin.id).is("consumed_at", null).neq("purpose", "invite");

  const code = randomDigits(6);
  await run(
    db().from("otp_codes").insert({
      admin_id: admin.id,
      purpose,
      code_hash: await hmacHex(`${admin.id}:${code}`),
      expires_at: new Date(Date.now() + cfg.otpTtlMinutes * 60_000).toISOString(),
      ip,
    }),
  );
  await sendMail(otpMail(admin.email, code, cfg.otpTtlMinutes));
}

export async function verifyOtp(input: {
  email: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const cfg = getConfig();
  const admin = await runMaybe<AdminRow>(db().from("admins").select("*").eq("email", input.email).maybeSingle());
  if (!admin || !admin.is_active) fail("AUTH_INVALID_OTP");

  const otp = await runMaybe<{ id: string; code_hash: string; attempts: number; expires_at: string }>(
    db().from("otp_codes").select("id, code_hash, attempts, expires_at")
      .eq("admin_id", admin.id).is("consumed_at", null).neq("purpose", "invite")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  );
  if (!otp) fail("AUTH_INVALID_OTP");
  if (Date.parse(otp.expires_at) < Date.now()) fail("AUTH_OTP_EXPIRED");
  if (otp.attempts >= MAX_OTP_ATTEMPTS) fail("AUTH_TOO_MANY_ATTEMPTS");

  const expected = await hmacHex(`${admin.id}:${input.code}`);
  if (!safeEqual(expected, otp.code_hash)) {
    await db().from("otp_codes").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
    await recordAudit({ enterpriseId: admin.enterprise_id, adminId: admin.id, category: "auth", action: "login.failed", state: "failed", params: { ip: input.ip } });
    fail("AUTH_INVALID_OTP");
  }
  await db().from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id);

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + cfg.sessionTtlHours * 3600_000);
  await run(
    db().from("sessions").insert({
      admin_id: admin.id,
      token_hash: await sha256Hex(token),
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 300),
      expires_at: expiresAt.toISOString(),
    }),
  );
  await db().from("admins").update({ last_login_at: new Date().toISOString() }).eq("id", admin.id);
  await recordAudit({ enterpriseId: admin.enterprise_id, adminId: admin.id, category: "auth", action: "login.succeeded", params: { ip: input.ip } });
  await noteLogin(admin, input.ip).catch(() => {});
  return { token, expiresAt };
}

export async function getSession(token: string): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  const row = await runMaybe<{
    id: string;
    last_seen_at: string;
    expires_at: string;
    revoked_at: string | null;
    admins: { id: string; enterprise_id: string; email: string; full_name: string | null; role: Role; is_active: boolean; enterprises: { name: string } };
  }>(
    db().from("sessions")
      .select("id, last_seen_at, expires_at, revoked_at, admins!inner(id, enterprise_id, email, full_name, role, is_active, enterprises!inner(name))")
      .eq("token_hash", await sha256Hex(token)).maybeSingle(),
  );
  if (!row || row.revoked_at || Date.parse(row.expires_at) < Date.now() || !row.admins.is_active) return null;
  if (Date.now() - Date.parse(row.last_seen_at) > 5 * 60_000) {
    await db().from("sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", row.id);
  }
  return {
    sessionId: row.id,
    adminId: row.admins.id,
    enterpriseId: row.admins.enterprise_id,
    enterpriseName: row.admins.enterprises.name,
    email: row.admins.email,
    fullName: row.admins.full_name,
    role: row.admins.role,
  };
}

export async function logout(sessionId: string): Promise<void> {
  await db().from("sessions").update({ revoked_at: new Date().toISOString() }).eq("id", sessionId);
}

export async function inviteAdmin(session: Session, email: string, fullName: string, role: Role) {
  const existing = await runMaybe<{ id: string }>(db().from("admins").select("id").eq("email", email).maybeSingle());
  if (existing) fail("CONFLICT", "This email already has an account");
  const admin = await run<AdminRow>(
    db().from("admins").insert({ enterprise_id: session.enterpriseId, email, full_name: fullName, role }).select("*").single(),
  );
  await recordAudit({ enterpriseId: session.enterpriseId, adminId: session.adminId, category: "auth", action: "admin.invited", params: { email, role } });
  return admin;
}

export async function listAdmins(enterpriseId: string) {
  const rows = await run<(Record<string, unknown> & { password_hash: string | null })[]>(
    db().from("admins").select("id, email, full_name, role, is_active, last_login_at, created_at, password_hash")
      .eq("enterprise_id", enterpriseId).order("created_at"),
  );
  return rows.map(({ password_hash, ...a }) => ({ ...a, has_password: Boolean(password_hash) }));
}

async function requireTeamMember(session: Session, targetId: string): Promise<AdminRow> {
  const admin = await runMaybe<AdminRow>(
    db().from("admins").select("*").eq("id", targetId).eq("enterprise_id", session.enterpriseId).maybeSingle(),
  );
  if (!admin) fail("NOT_FOUND", "Admin not found in this enterprise");
  return admin;
}

function assertNotSelf(session: Session, targetId: string, verb: string) {
  if (session.adminId === targetId) fail("VALIDATION_FAILED", `You cannot ${verb} yourself`);
}

export async function updateAdminRole(session: Session, targetId: string, role: Role) {
  if (role === "owner") fail("VALIDATION_FAILED", "Use transfer ownership to make someone the owner");
  assertNotSelf(session, targetId, "change the role of");
  const admin = await requireTeamMember(session, targetId);
  if (admin.role === "owner") fail("VALIDATION_FAILED", "Transfer ownership before changing the owner's role");
  if (admin.role === role) return admin;
  const updated = await run<AdminRow>(
    db().from("admins").update({ role }).eq("id", targetId).select("*").single(),
  );
  await recordAudit({ enterpriseId: session.enterpriseId, adminId: session.adminId, category: "auth", action: "admin.role_changed", params: { target: admin.email, from: admin.role, to: role } });
  return updated;
}

export async function transferOwnership(session: Session, targetId: string) {
  assertNotSelf(session, targetId, "transfer ownership to");
  const target = await requireTeamMember(session, targetId);
  if (!target.is_active) fail("VALIDATION_FAILED", "Reactivate the admin before transferring ownership");
  if (target.role === "viewer") fail("VALIDATION_FAILED", "Promote the viewer to admin before transferring ownership");
  if (target.role === "owner") return target;
  // Promote target first — a brief two-owner window is safer than a brief zero-owner window.
  await run(db().from("admins").update({ role: "owner" }).eq("id", target.id));
  await run(db().from("admins").update({ role: "admin" }).eq("id", session.adminId));
  await recordAudit({ enterpriseId: session.enterpriseId, adminId: session.adminId, category: "auth", action: "admin.ownership_transferred", params: { to: target.email } });
}

export async function setAdminActive(session: Session, targetId: string, active: boolean) {
  assertNotSelf(session, targetId, active ? "reactivate" : "deactivate");
  const admin = await requireTeamMember(session, targetId);
  if (!active && admin.role === "owner") fail("VALIDATION_FAILED", "Transfer ownership before deactivating the owner");
  if (admin.is_active === active) return admin;
  const updated = await run<AdminRow>(
    db().from("admins").update({ is_active: active }).eq("id", targetId).select("*").single(),
  );
  if (!active) {
    await db().from("sessions").update({ revoked_at: new Date().toISOString() }).eq("admin_id", targetId).is("revoked_at", null);
  }
  await recordAudit({ enterpriseId: session.enterpriseId, adminId: session.adminId, category: "auth", action: active ? "admin.reactivated" : "admin.deactivated", params: { target: admin.email } });
  return updated;
}

export async function removeAdmin(session: Session, targetId: string) {
  assertNotSelf(session, targetId, "remove");
  const admin = await requireTeamMember(session, targetId);
  if (admin.role === "owner") fail("VALIDATION_FAILED", "Transfer ownership before removing the owner");
  await run(db().from("admins").delete().eq("id", targetId));
  await recordAudit({ enterpriseId: session.enterpriseId, adminId: session.adminId, category: "auth", action: "admin.removed", params: { target: admin.email } });
}

// ------------------------------------------------------------ invite links
// Owner creates a one-time link; Resend emails it (sendMail → mail.ts). If the send fails,
// the owner still gets the link in the response and can share it another way. Opening the
// link lets the admin set a password. The same link resets the password of an admin who
// already has one. Stored like OTP codes (purpose "invite", HMAC of the token).
const INVITE_TTL_DAYS = 7;
const MAX_INVITE_ATTEMPTS = 5;

export async function createInviteLink(session: Session, targetId: string, ip: string | null) {
  const admin = await requireTeamMember(session, targetId);
  if (!admin.is_active) fail("VALIDATION_FAILED", "Reactivate the admin before creating a link");
  if (admin.role === "owner" && admin.id !== session.adminId) fail("VALIDATION_FAILED", "Only the owner can reset the owner's password");
  // Only the newest link works.
  await db().from("otp_codes").update({ consumed_at: new Date().toISOString() })
    .eq("admin_id", admin.id).eq("purpose", "invite").is("consumed_at", null);
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);
  await run(
    db().from("otp_codes").insert({
      admin_id: admin.id,
      purpose: "invite",
      code_hash: await hmacHex(`invite:${admin.id}:${token}`),
      expires_at: expiresAt.toISOString(),
      ip,
    }),
  );
  const kind = admin.password_hash ? "reset" : "invite";
  const link = `${getConfig().appUrl}/?invite=${admin.id}.${token}`;
  let emailed = false;
  let emailError: string | null = null;
  try {
    await sendMail(inviteMail({
      to: admin.email,
      link,
      kind,
      enterpriseName: session.enterpriseName,
      inviter: session.fullName || session.email,
      role: admin.role,
      expiresAt,
    }));
    emailed = true;
  } catch (e) {
    emailError = e instanceof Error ? e.message : "Could not send email";
    log("warn", "invite.email_failed", { target: admin.email, error: emailError });
  }
  await recordAudit({
    enterpriseId: session.enterpriseId, adminId: session.adminId, category: "auth",
    action: kind === "invite" ? "admin.invite_link_created" : "admin.reset_link_created",
    params: { target: admin.email, emailed },
  });
  return { link, expiresAt: expiresAt.toISOString(), kind, email: admin.email, emailed, emailError };
}

/** Invited admin opens the link, sets a password, and is signed in. */
export async function acceptInvite(input: { code: string; password: string; ip: string | null; userAgent: string | null }) {
  const cfg = getConfig();
  assertPasswordStrength(input.password);
  const m = input.code.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m) fail("AUTH_INVITE_INVALID");
  const [, adminId, token] = m;
  const admin = await runMaybe<AdminRow>(db().from("admins").select("*").eq("id", adminId).maybeSingle());
  if (!admin || !admin.is_active) fail("AUTH_INVITE_INVALID");
  const row = await runMaybe<{ id: string; code_hash: string; attempts: number; expires_at: string }>(
    db().from("otp_codes").select("id, code_hash, attempts, expires_at")
      .eq("admin_id", admin.id).eq("purpose", "invite").is("consumed_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  );
  if (!row || Date.parse(row.expires_at) < Date.now() || row.attempts >= MAX_INVITE_ATTEMPTS) fail("AUTH_INVITE_INVALID");
  if (!safeEqual(await hmacHex(`invite:${admin.id}:${token}`), row.code_hash)) {
    await db().from("otp_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    fail("AUTH_INVITE_INVALID");
  }
  await db().from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", row.id);
  const wasReset = Boolean(admin.password_hash);
  await run(db().from("admins").update({ password_hash: await hashPassword(input.password) }).eq("id", admin.id));
  // A password reset ends every other session of that admin.
  if (wasReset) await db().from("sessions").update({ revoked_at: new Date().toISOString() }).eq("admin_id", admin.id).is("revoked_at", null);

  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + cfg.sessionTtlHours * 3600_000);
  await run(
    db().from("sessions").insert({
      admin_id: admin.id,
      token_hash: await sha256Hex(sessionToken),
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 300),
      expires_at: expiresAt.toISOString(),
    }),
  );
  await db().from("admins").update({ last_login_at: new Date().toISOString() }).eq("id", admin.id);
  await recordAudit({ enterpriseId: admin.enterprise_id, adminId: admin.id, category: "auth", action: wasReset ? "password.reset_by_link" : "admin.invite_accepted", params: { ip: input.ip } });
  await noteLogin(admin, input.ip).catch(() => {});
  return { token: sessionToken, expiresAt };
}

/** Confirmation codes for destructive commands reuse the OTP primitives. */
export async function hashConfirmCode(eventId: string, code: string) {
  return await hmacHex(`confirm:${eventId}:${code}`);
}

export async function loginWithPassword(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const cfg = getConfig();
  const admin = await runMaybe<AdminRow>(db().from("admins").select("*").eq("email", input.email).maybeSingle());
  // Dummy hash check to keep response time similar whether the account exists or not.
  if (!admin || !admin.is_active || !admin.password_hash) {
    await verifyPassword(input.password, "v1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").catch(() => false);
    fail("AUTH_INVALID_CREDENTIALS");
  }
  const ok = await verifyPassword(input.password, admin.password_hash);
  if (!ok) {
    await recordAudit({ enterpriseId: admin.enterprise_id, adminId: admin.id, category: "auth", action: "login.failed", state: "failed", params: { ip: input.ip, mode: "password" } });
    fail("AUTH_INVALID_CREDENTIALS");
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + cfg.sessionTtlHours * 3600_000);
  await run(
    db().from("sessions").insert({
      admin_id: admin.id,
      token_hash: await sha256Hex(token),
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 300),
      expires_at: expiresAt.toISOString(),
    }),
  );
  await db().from("admins").update({ last_login_at: new Date().toISOString() }).eq("id", admin.id);
  await recordAudit({ enterpriseId: admin.enterprise_id, adminId: admin.id, category: "auth", action: "login.succeeded", params: { ip: input.ip, mode: "password" } });
  await noteLogin(admin, input.ip).catch(() => {});
  return { token, expiresAt };
}

export async function setOwnPassword(adminId: string, enterpriseId: string, newPassword: string, currentPassword: string | null): Promise<void> {
  assertPasswordStrength(newPassword);
  const admin = await runMaybe<AdminRow>(db().from("admins").select("*").eq("id", adminId).maybeSingle());
  if (!admin || !admin.is_active) fail("AUTH_INVALID_CREDENTIALS");
  if (admin.password_hash) {
    if (!currentPassword) fail("VALIDATION_FAILED", "Current password is required to change your password");
    const ok = await verifyPassword(currentPassword, admin.password_hash);
    if (!ok) fail("AUTH_INVALID_CREDENTIALS", "Current password is incorrect");
  }
  await run(db().from("admins").update({ password_hash: await hashPassword(newPassword) }).eq("id", adminId));
  await recordAudit({ enterpriseId, adminId, category: "auth", action: admin.password_hash ? "password.changed" : "password.set" });
}

export async function hasPasswordSet(email: string): Promise<boolean> {
  const admin = await runMaybe<{ password_hash: string | null; is_active: boolean }>(
    db().from("admins").select("password_hash, is_active").eq("email", email).maybeSingle(),
  );
  return Boolean(admin && admin.is_active && admin.password_hash);
}

export async function resetPasswordWithOtp(input: {
  email: string;
  code: string;
  newPassword: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const cfg = getConfig();
  assertPasswordStrength(input.newPassword);

  const admin = await runMaybe<AdminRow>(db().from("admins").select("*").eq("email", input.email).maybeSingle());
  if (!admin || !admin.is_active) fail("AUTH_INVALID_OTP");

  const otp = await runMaybe<{ id: string; code_hash: string; attempts: number; expires_at: string }>(
    db().from("otp_codes").select("id, code_hash, attempts, expires_at")
      .eq("admin_id", admin.id).is("consumed_at", null).neq("purpose", "invite")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  );
  if (!otp) fail("AUTH_INVALID_OTP");
  if (Date.parse(otp.expires_at) < Date.now()) fail("AUTH_OTP_EXPIRED");
  if (otp.attempts >= MAX_OTP_ATTEMPTS) fail("AUTH_TOO_MANY_ATTEMPTS");

  const expected = await hmacHex(`${admin.id}:${input.code}`);
  if (!safeEqual(expected, otp.code_hash)) {
    await db().from("otp_codes").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
    await recordAudit({ enterpriseId: admin.enterprise_id, adminId: admin.id, category: "auth", action: "login.failed", state: "failed", params: { ip: input.ip, mode: "otp_reset" } });
    fail("AUTH_INVALID_OTP");
  }
  await db().from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id);
  await run(db().from("admins").update({ password_hash: await hashPassword(input.newPassword) }).eq("id", admin.id));

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + cfg.sessionTtlHours * 3600_000);
  await run(
    db().from("sessions").insert({
      admin_id: admin.id,
      token_hash: await sha256Hex(token),
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 300),
      expires_at: expiresAt.toISOString(),
    }),
  );
  await db().from("admins").update({ last_login_at: new Date().toISOString() }).eq("id", admin.id);
  await recordAudit({ enterpriseId: admin.enterprise_id, adminId: admin.id, category: "auth", action: "password.reset", params: { ip: input.ip, mode: "otp_reset" } });
  await noteLogin(admin, input.ip).catch(() => {});
  return { token, expiresAt };
}
