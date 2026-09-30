import { route } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { createCheckout } from "@/lib/billing/stripe";

export const POST = route(async () => {
  const { org, user } = await requirePermission("billing:manage");
  return { url: await createCheckout(org, user.email) };
});
