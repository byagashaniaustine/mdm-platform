// Outbound email for sign-in codes and critical alerts.
// development: printed to the console. production: Zoho ZeptoMail (recommended) or Resend.
import { getConfig } from "../config.ts";
import { appError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";

export type Mail = { to: string; subject: string; text: string };

export async function sendMail(mail: Mail): Promise<void> {
  const cfg = getConfig();
  if (cfg.mailProvider === "console") {
    console.log(`\n=== DEV EMAIL to ${mail.to} ===\n${mail.subject}\n${mail.text}\n===============\n`);
    return;
  }
  if (cfg.mailProvider === "zeptomail") return await sendZeptoMail(mail);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: cfg.mailFrom, to: [mail.to], subject: mail.subject, text: mail.text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    log("error", "mail.send_failed", { status: res.status });
    throw appError("INTERNAL", "Could not send email");
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
