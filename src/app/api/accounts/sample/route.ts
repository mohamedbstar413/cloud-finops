import { route } from "@/lib/api";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DEMO_ACCOUNTS } from "@/lib/demo/estate";
import { enqueue } from "@/lib/jobs/queue";

/** Load the four sample accounts (synthetic data, free on every plan) so a new customer can explore first. */
export const POST = route(async () => {
  const { org, user } = await requirePermission("account:manage");
  if (org.isDemo) throw new HttpError(403, "Not available in the demo organization.");
  const existing = new Set((await prisma.cloudAccount.findMany({ where: { orgId: org.id, isDemo: true }, select: { externalId: true } })).map((a) => a.externalId));
  const added = [];
  for (const spec of DEMO_ACCOUNTS.filter((a) => !existing.has(a.externalId))) {
    const account = await prisma.cloudAccount.create({
      data: { orgId: org.id, provider: spec.provider, name: `${spec.name} (sample)`, externalId: spec.externalId, region: spec.region, authType: spec.authType, isDemo: true, status: "pending" },
    });
    await enqueue(org.id, "sync_account", { accountId: account.id }, { requestedBy: user.name });
    added.push(account.id);
  }
  const job = await enqueue(org.id, "analyze", {}, { requestedBy: user.name });
  if (added.length) await audit(org.id, user.name, "loaded sample data", `${added.length} sample accounts`);
  return { added: added.length, job };
});
