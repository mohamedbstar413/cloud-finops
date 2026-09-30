/**
 * Transactional email. With RESEND_API_KEY set, mail goes out through Resend;
 * otherwise it is written to the server log (development) so links can be
 * followed locally. Tests read the outbox.
 */
export interface Email {
  to: string;
  subject: string;
  text: string;
}

export const outbox: Email[] = [];

export const appUrl = (path = "") => `${(process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "")}${path}`;

export async function sendEmail(mail: Email): Promise<void> {
  outbox.push(mail);
  if (outbox.length > 50) outbox.shift();
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV !== "test") console.info(`[email] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM ?? "Cloud Price Optimizer <no-reply@cloudpriceoptimizer.dev>", to: mail.to, subject: mail.subject, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Email delivery failed (${res.status})`);
}
