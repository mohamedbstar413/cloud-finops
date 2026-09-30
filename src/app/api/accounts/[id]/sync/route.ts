import { route, type Ctx } from "@/lib/api";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncAccount } from "@/lib/services/ingest";

export const maxDuration = 300;

export const POST = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("analysis:run");
  const { id } = await ctx.params;
  const acct = await prisma.cloudAccount.findFirst({ where: { id, orgId: org.id } });
  if (!acct) throw new HttpError(404, "Account not found");
  const result = await syncAccount(id);
  await audit(org.id, user.name, result.ok ? "synced account" : "sync failed", `${acct.provider.toUpperCase()} ${acct.name}`);
  if (!result.ok) throw new HttpError(502, result.error);
  return result;
});
