import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../auth-errors";
import { prisma } from "../db";
import { appUrl } from "../email";

/**
 * Stripe Checkout (subscribe), the customer portal (change card, cancel) and
 * the webhook that keeps each organization's plan in step with its
 * subscription. Talks to the Stripe REST API directly.
 *   STRIPE_SECRET_KEY, STRIPE_PRICE_PRO (price id of the Pro plan), STRIPE_WEBHOOK_SECRET
 */

export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_PRO);

/** Stripe's form encoding, including nested keys: { line_items: [{ price }] } → line_items[0][price]=… */
export function formEncode(data: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") parts.push(formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join("&");
}

async function stripe<T>(path: string, data: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode(data),
  });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new HttpError(502, `Payment provider: ${body.error?.message ?? res.status}`);
  return body;
}

export async function createCheckout(org: { id: string; name: string; stripeCustomerId: string | null }, email: string) {
  if (!stripeConfigured()) throw new HttpError(501, "Payments are not configured on this deployment.");
  let customer = org.stripeCustomerId;
  if (!customer) {
    customer = (await stripe<{ id: string }>("customers", { email, name: org.name, metadata: { orgId: org.id } })).id;
    await prisma.organization.update({ where: { id: org.id }, data: { stripeCustomerId: customer } });
  }
  const session = await stripe<{ url: string }>("checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: org.id,
    line_items: [{ price: process.env.STRIPE_PRICE_PRO, quantity: 1 }],
    subscription_data: { metadata: { orgId: org.id } },
    success_url: appUrl("/billing?upgraded=1"),
    cancel_url: appUrl("/billing"),
    allow_promotion_codes: true,
  });
  return session.url;
}

export async function createPortal(org: { stripeCustomerId: string | null }) {
  if (!stripeConfigured() || !org.stripeCustomerId) throw new HttpError(400, "There is no billing account to manage yet.");
  return (await stripe<{ url: string }>("billing_portal/sessions", { customer: org.stripeCustomerId, return_url: appUrl("/billing") })).url;
}

/** Verify the Stripe-Signature header (HMAC-SHA256 of "timestamp.payload"), rejecting old or forged events. */
export function verifyWebhook(payload: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  return header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .some((p) => {
      const sig = Buffer.from(p.slice(3), "hex");
      return sig.length === expected.length && timingSafeEqual(sig, expected);
    });
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> & { id: string; customer?: string; status?: string; metadata?: Record<string, string>; client_reference_id?: string; subscription?: string } };
}

/** Keep the organization's plan in step with its subscription. */
export async function applyStripeEvent(event: StripeEvent) {
  const o = event.data.object;
  const orgId = o.metadata?.orgId ?? o.client_reference_id;
  const org = orgId
    ? await prisma.organization.findUnique({ where: { id: orgId } })
    : o.customer
      ? await prisma.organization.findUnique({ where: { stripeCustomerId: o.customer } })
      : null;
  if (!org) return { ignored: "no matching organization" };

  switch (event.type) {
    case "checkout.session.completed":
      await prisma.organization.update({ where: { id: org.id }, data: { plan: "pro", planStatus: "active", stripeCustomerId: o.customer ?? org.stripeCustomerId, stripeSubscriptionId: o.subscription ?? org.stripeSubscriptionId } });
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const status = o.status === "trialing" ? "trialing" : o.status === "active" ? "active" : o.status === "past_due" ? "past_due" : "canceled";
      await prisma.organization.update({ where: { id: org.id }, data: { plan: status === "canceled" ? "free" : "pro", planStatus: status, stripeSubscriptionId: o.id } });
      break;
    }
    case "customer.subscription.deleted":
      await prisma.organization.update({ where: { id: org.id }, data: { plan: "free", planStatus: "canceled", stripeSubscriptionId: null } });
      break;
    default:
      return { ignored: event.type };
  }
  await prisma.auditLog.create({ data: { orgId: org.id, actor: "Billing", action: event.type.replace(/[._]/g, " ") } });
  return { applied: event.type };
}
