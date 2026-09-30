import { z } from "zod";
import { route } from "@/lib/api";
import { audit, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const PATCH = route(async (req: Request) => {
  const { org, user } = await requirePermission("org:manage");
  const { name } = z.object({ name: z.string().trim().min(2).max(80) }).parse(await req.json());
  await prisma.organization.update({ where: { id: org.id }, data: { name } });
  await audit(org.id, user.name, "renamed organization", name);
  return { ok: true };
});
