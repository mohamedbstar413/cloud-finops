import { route, type Ctx } from "@/lib/api";
import { HttpError, requirePermission } from "@/lib/auth";
import { decryptForOrg } from "@/lib/tenant-crypto";
import { prisma } from "@/lib/db";
import { validateCredentials } from "@/lib/services/ingest";

/** Connection health check (re-validates stored credentials). */
export const POST = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org } = await requirePermission("account:manage");
  const { id } = await ctx.params;
  const acct = await prisma.cloudAccount.findFirst({ where: { id, orgId: org.id } });
  if (!acct) throw new HttpError(404, "Account not found");
  const result = acct.isDemo
    ? { ok: true, message: "Demo account — synthetic data source is healthy", identity: acct.externalId }
    : acct.credentials
      ? await validateCredentials(acct.provider, await decryptForOrg(org.id, acct.credentials))
      : { ok: false, message: "No credentials stored — reconnect this account" };
  await prisma.cloudAccount.update({ where: { id }, data: { status: result.ok ? "connected" : "error", lastError: result.ok ? null : result.message } });
  return result;
});
