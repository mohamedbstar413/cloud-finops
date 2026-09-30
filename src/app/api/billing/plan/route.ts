import { z } from "zod";
import { route } from "@/lib/api";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { stripeConfigured } from "@/lib/billing/stripe";
import { prisma } from "@/lib/db";

/** Development only: change plan without payments, to try the limits. Disabled in production and whenever Stripe is configured. */
export const POST = route(async (req: Request) => {
  if (process.env.NODE_ENV === "production" || stripeConfigured()) throw new HttpError(404, "Not found");
  const { org, user } = await requirePermission("billing:manage");
  const { plan } = z.object({ plan: z.enum(["free", "pro", "enterprise"]) }).parse(await req.json());
  await prisma.organization.update({ where: { id: org.id }, data: { plan, planStatus: "active" } });
  await audit(org.id, user.name, `switched plan to ${plan} (development)`);
  return { ok: true };
});
