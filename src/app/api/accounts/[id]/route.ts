import { z } from "zod";
import { route, type Ctx } from "@/lib/api";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { runAnalysis } from "@/lib/services/analysis";

const Body = z.object({ permissions: z.enum(["read_only", "read_write"]).optional(), name: z.string().min(1).max(80).optional() });

export const PATCH = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("account:manage");
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  const acct = await prisma.cloudAccount.findFirst({ where: { id, orgId: org.id } });
  if (!acct) throw new HttpError(404, "Account not found");
  await prisma.cloudAccount.update({ where: { id }, data: body });
  await audit(org.id, user.name, body.permissions ? `set permissions to ${body.permissions.replace("_", "-")}` : "renamed account", `${acct.provider.toUpperCase()} ${acct.name}`);
  return { ok: true };
});

export const DELETE = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("account:manage");
  const { id } = await ctx.params;
  const acct = await prisma.cloudAccount.findFirst({ where: { id, orgId: org.id } });
  if (!acct) throw new HttpError(404, "Account not found");
  await prisma.cloudAccount.delete({ where: { id } });
  await prisma.recommendation.deleteMany({ where: { orgId: org.id, accountId: id } });
  await audit(org.id, user.name, "disconnected account", `${acct.provider.toUpperCase()} ${acct.name}`);
  await runAnalysis(org.id);
  return { ok: true };
});
