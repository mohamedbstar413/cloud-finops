import { route, type Ctx } from "@/lib/api";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { assertCanSyncNow } from "@/lib/billing/limits";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";

/** Sync one account now (in the background), then re-analyse. */
export const POST = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("analysis:run");
  const { id } = await ctx.params;
  const acct = await prisma.cloudAccount.findFirst({ where: { id, orgId: org.id } });
  if (!acct) throw new HttpError(404, "Account not found");
  await assertCanSyncNow(org.id);
  const job = await enqueue(org.id, "sync_account", { accountId: id }, { requestedBy: user.name });
  await enqueue(org.id, "analyze", {}, { requestedBy: user.name });
  await audit(org.id, user.name, "requested sync", `${acct.provider.toUpperCase()} ${acct.name}`);
  return { job };
});
