import { NextResponse } from "next/server";
import { applyStripeEvent, verifyWebhook } from "@/lib/billing/stripe";

/** Stripe → us. Unauthenticated by design; trusted only through the signature. */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 501 });
  const payload = await req.text();
  if (!verifyWebhook(payload, req.headers.get("stripe-signature"), secret)) return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  return NextResponse.json(await applyStripeEvent(JSON.parse(payload)));
}
