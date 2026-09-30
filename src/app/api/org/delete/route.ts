import { z } from "zod";
import { route } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { requestOrganizationDeletion } from "@/lib/services/org-lifecycle";

export const POST = route(async (req: Request) => {
  const { org, user } = await requirePermission("org:delete");
  const { confirm } = z.object({ confirm: z.string().max(100) }).parse(await req.json());
  await requestOrganizationDeletion(org.id, confirm, user.name);
  return { next: "/" };
});
