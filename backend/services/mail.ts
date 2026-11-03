// Outbound email for sign-in codes and critical alerts.
// development: printed to the console. production: Zoho ZeptoMail (recommended) or Resend.
import { getConfig } from "../config.ts";
import { db } from "../lib/db.ts";
import { appError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";

export type Mail = { to: string; subject: string; text: string };

/**
 * Resend's testing sender (onboarding@resend.dev) only delivers to the Resend account owner.
 * In test mode we reroute every message to one allowed inbox, taken from the DB (the enterprise
 * owner's email) unless MAIL_TEST_REDIRECT_TO overrides it. The real intended recipient is kept
 * in the subject/body so you can see who it was meant for.
 */
async function resolveTestRecipient(): Promise<string | null> {
  const cfg = getConfig();
  if (cfg.mailTestRedirectTo) return cfg.mailTestRedirectTo;
  try {
    const { data } = await db().from("admins").select("email")
      .eq("role", "owner").eq("is_active", true).order("created_at").limit(1).maybeSingle();
    return (data?.email as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function applyTestRedirect(mail: Mail): Promise<Mail> {
  const cfg = getConfig();
  if (!cfg.mailTestRedirect) return mail;
  const to = await resolveTestRecipient();
  if (!to || to.toLowerCase() === mail.to.toLowerCase()) return mail;
  log("info", "mail.test_redirect", { intended: mail.to, redirected_to: to });
  return { to, subject: `[test → ${mail.to}] ${mail.subject}`,
    text: `(Test mode: this message was originally addressed to ${mail.to}.)\n\n${mail.text}` };
}

export async function sendMail(input: Mail): Promise<void> {
  const cfg = getConfig();
  const mail = await applyTestRedirect(input);
  if (cfg.mailProvider === "console") {
    console.log(`\n=== DEV EMAIL to ${mail.to} ===\n${mail.subject}\n${mail.text}\n===============\n`);
    return;
  }
  if (cfg.mailProvider === "zeptomail") return await sendZeptoMail(mail);
  if (cfg.mailProvider === "sendgrid")  return await sendSendGridMail(mail);
  // RESEND_FROM_ADDRESS (bare "name@domain") overrides MAIL_FROM for Resend-only
  // sends. Harvey's convention: swap sender without touching MAIL_FROM.
  const from = cfg.resendFromAddress || cfg.mailFrom;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log("error", "mail.send_failed", { status: res.status, body: body.slice(0, 300) });
    throw appError("INTERNAL", `Resend rejected the email (${res.status}): ${body.slice(0, 200) || "no details"}`);
  }
}

/** SendGrid v3 Mail Send. Works with their single-sender-verification path, so
 *  no DNS setup is required for small-team usage (free tier: 100 mails/day). */
async function sendSendGridMail(mail: Mail): Promise<void> {
  const cfg = getConfig();
  // MAIL_FROM can be either "Name <addr@domain>" or just "addr@domain".
  const match = cfg.mailFrom.match(/^(.*)<(.+)>$/);
  const from = match ? { name: match[1].trim(), email: match[2].trim() } : { email: cfg.mailFrom.trim() };
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.sendgridApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: mail.to }] }],
      from,
      subject: mail.subject,
      content: [{ type: "text/plain", value: mail.text }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  // 202 Accepted is SendGrid's success — the body is empty.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log("error", "mail.sendgrid_failed", { status: res.status, body: body.slice(0, 300) });
    throw appError("INTERNAL", `SendGrid rejected the email (${res.status}): ${body.slice(0, 200) || "no details"}`);
  }
}

/** Zoho ZeptoMail transactional API. ZEPTOMAIL_TOKEN is the "Send Mail token" from the Mail Agent. */
async function sendZeptoMail(mail: Mail): Promise<void> {
  const cfg = getConfig();
  const match = cfg.mailFrom.match(/^(.*)<(.+)>$/);
  const from = match ? { name: match[1].trim(), address: match[2].trim() } : { address: cfg.mailFrom.trim() };
  const token = cfg.zeptomailToken.startsWith("Zoho-enczapikey") ? cfg.zeptomailToken : `Zoho-enczapikey ${cfg.zeptomailToken}`;
  const res = await fetch(cfg.zeptomailUrl, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      from,
      to: [{ email_address: { address: mail.to } }],
      subject: mail.subject,
      textbody: mail.text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    log("error", "mail.zeptomail_failed", { status: res.status, body: (await res.text()).slice(0, 300) });
    throw appError("INTERNAL", "Could not send email");
  }
}

export function otpMail(to: string, code: string, minutes: number): Mail {
  return {
    to,
    subject: `Your MDM Console sign-in code: ${code}`,
    text: `Your sign-in code is ${code}.\nIt expires in ${minutes} minutes. If you did not request it, ignore this email.`,
  };
}

/**
 * Payment reminder email, fired alongside the device-announcement in apply.ts
 * when a loan tier transition happens. The copy mirrors the three announcements
 * registered in tier_announcements (Due-2D, Overdue-2D, Locked) so the user
 * sees the same message on their inbox and their device.
 */
export type ReminderTier = "due_2d" | "overdue_2d" | "locked" | "released";

export function paymentReminderMail(opts: {
  to: string;
  userName: string | null;
  enterpriseName: string;
  tier: ReminderTier;
  dpd: number;
  dueOn: string | null;        // ISO date (YYYY-MM-DD)
}): Mail {
  const { to, userName, enterpriseName, tier, dpd, dueOn } = opts;
  const name = userName?.trim() || "there";
  const dueLine = dueOn ? `Due date: ${dueOn}` : "";
  const sign = `— ${enterpriseName}`;
  if (tier === "due_2d") {
    return {
      to,
      subject: `Payment reminder: your loan is due soon`,
      text:
`Hi ${name},

Your loan payment is coming up. Please settle on or before the due date to keep your device unrestricted.

${dueLine}

If you have already paid, ignore this message — our records refresh after each settlement.

${sign}`,
    };
  }
  if (tier === "overdue_2d") {
    return {
      to,
      subject: `Overdue: please settle your loan to avoid device lock`,
      text:
`Hi ${name},

Your loan is ${dpd} day${dpd === 1 ? "" : "s"} past due. Please settle now to avoid your device being locked.

${dueLine}

Pay through your usual channel. Once received, your device returns to normal within minutes.

${sign}`,
    };
  }
  if (tier === "locked") {
    return {
      to,
      subject: `Your device has been locked — settle to restore access`,
      text:
`Hi ${name},

Because your loan is ${dpd} day${dpd === 1 ? "" : "s"} past due, your device has been placed in payment-first mode. Call/essential apps still work; other apps are blocked until you settle.

${dueLine}

Make a payment and your device unlocks automatically within minutes.

${sign}`,
    };
  }
  // released
  return {
    to,
    subject: `Thanks — your loan is settled`,
    text:
`Hi ${name},

Thanks for settling your loan. Your device is back to normal.

${sign}`,
  };
}

export function inviteMail(opts: {
  to: string;
  link: string;
  kind: "invite" | "reset";
  enterpriseName: string;
  inviter: string;
  role: string;
  expiresAt: Date;
}): Mail {
  const { to, link, kind, enterpriseName, inviter, role, expiresAt } = opts;
  const expires = expiresAt.toUTCString();
  if (kind === "reset") {
    return {
      to,
      subject: `Reset your password on ${enterpriseName} Device Console`,
      text:
`${inviter} created a password reset link for your Device Console account.

Open this link to set a new password:
  ${link}

The link works once and expires on ${expires}. If you weren't expecting this, ignore the email.`,
    };
  }
  return {
    to,
    subject: `You've been added to ${enterpriseName} on Device Console`,
    text:
`${inviter} added you to ${enterpriseName} on the Device Console as a ${role}.

Open this link to set your password and sign in:
  ${link}

The link works once and expires on ${expires}. If you weren't expecting this, ignore the email.`,
  };
}
