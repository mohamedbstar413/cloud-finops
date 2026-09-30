import { route } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { createPortal } from "@/lib/billing/stripe";

export const POST = route(async () => {
  const { org } = await requirePermission("billing:manage");
  return { url: await createPortal(org) };
});
