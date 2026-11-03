// One-off: drive sendMail(inviteMail(...)) against the real Resend API using
// current .env. Prints Resend's HTTP response so we can tell whether the key +
// verified domain accept the message. Run with:
//   deno run --allow-env --allow-net --env-file=.env scripts/test_invite_email.ts <recipient>
import { inviteMail, sendMail } from "../backend/services/mail.ts";
import { getConfig } from "../backend/config.ts";

const to = Deno.args[0];
if (!to) {
  console.error("Usage: deno run --allow-env --allow-net --env-file=.env scripts/test_invite_email.ts <recipient>");
  Deno.exit(2);
}

const cfg = getConfig();
console.log(JSON.stringify({
  mail_provider: cfg.mailProvider,
  mail_from: cfg.mailFrom,
  resend_from_address: cfg.resendFromAddress || null,
  test_redirect: cfg.mailTestRedirect,
  recipient: to,
}, null, 2));

const expiresAt = new Date(Date.now() + 7 * 86400_000);
const mail = inviteMail({
  to,
  link: "https://console.example/accept?code=TEST-ONLY",
  kind: "invite",
  enterpriseName: "Black Swan (test)",
  inviter: "Austine (test)",
  role: "admin",
  expiresAt,
});

try {
  await sendMail(mail);
  console.log("ok: Resend accepted the message");
} catch (e) {
  console.error("send failed:", e instanceof Error ? e.message : String(e));
  Deno.exit(1);
}
