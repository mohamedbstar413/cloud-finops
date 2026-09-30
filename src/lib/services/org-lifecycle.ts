import { HttpError } from "../auth-errors";
import { prisma, parseJson } from "../db";
import { enqueue } from "../jobs/queue";
import { forgetOrgKey } from "../tenant-crypto";

/**
 * Leaving the platform: a full export of what we hold about an organization,
 * and deletion. Deletion is immediate from the customer's point of view (the
 * organization disappears and its sessions end) and completed by a job, which
 * removes every row and destroys the tenant key — so any stray copy of its
 * encrypted credentials becomes unreadable.
 */

export async function exportOrganization(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    include: {
      members: { include: { user: { select: { name: true, email: true } } } },
      invites: { select: { email: true, role: true, createdAt: true, acceptedAt: true } },
      accounts: { select: { id: true, provider: true, name: true, externalId: true, region: true, status: true, permissions: true, lastSyncAt: true, createdAt: true } },
      recommendations: true,
      scenarios: true,
      auditLogs: { orderBy: { createdAt: "asc" } },
    },
  });
  const resources = await prisma.resource.findMany({ where: { account: { orgId } } });
  const costs = await prisma.costRecord.findMany({ where: { account: { orgId } }, orderBy: { date: "asc" } });
  return {
    exportedAt: new Date().toISOString(),
    format: "cloud-price-optimizer-export/v1",
    note: "Cloud credentials are never exported.",
    organization: { id: org.id, name: org.name, plan: org.plan, createdAt: org.createdAt, settings: parseJson(org.settings, {}) },
    members: org.members.map((m) => ({ name: m.user.name, email: m.user.email, role: m.role, since: m.createdAt })),
    invites: org.invites,
    accounts: org.accounts,
    resources: resources.map((r) => ({ ...r, metrics: parseJson(r.metrics, {}), config: parseJson(r.config, {}), tags: parseJson(r.tags, []), dependsOn: parseJson(r.dependsOn, []) })),
    costs,
    recommendations: org.recommendations.map((r) => ({ ...r, resourceIds: parseJson(r.resourceIds, []), details: parseJson(r.details, {}), ai: parseJson(r.ai, null) })),
    scenarios: org.scenarios.map((s) => ({ ...s, plan: parseJson(s.plan, {}), result: parseJson(s.result, {}), narrative: parseJson(s.narrative, {}) })),
    auditLog: org.auditLogs,
  };
}

/** Step 1 (request): make the organization inaccessible at once and queue the removal. */
export async function requestOrganizationDeletion(orgId: string, confirmName: string, requestedBy: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (org.isDemo) throw new HttpError(403, "The demo organization cannot be deleted.");
  if (confirmName.trim() !== org.name) throw new HttpError(400, "Type the organization's name exactly to confirm.");
  if (org.stripeSubscriptionId && org.planStatus !== "canceled") throw new HttpError(409, "Cancel the subscription on the Billing page first.");
  await prisma.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
  // Sessions keep the user but drop the organization; credentials are wiped right away.
  await prisma.session.updateMany({ where: { orgId }, data: { orgId: null } });
  await prisma.cloudAccount.updateMany({ where: { orgId }, data: { credentials: null } });
  return enqueue(orgId, "delete_org", {}, { requestedBy });
}

/** Step 2 (job): remove every record, then the organization and its key. */
export async function deleteOrganizationData(orgId: string) {
  const accounts = await prisma.cloudAccount.findMany({ where: { orgId }, select: { id: true } });
  let resources = 0;
  // Large tables first, account by account, so no single statement is huge.
  for (const a of accounts) {
    await prisma.usageSeries.deleteMany({ where: { resource: { accountId: a.id } } });
    await prisma.costRecord.deleteMany({ where: { accountId: a.id } });
    resources += (await prisma.resource.deleteMany({ where: { accountId: a.id } })).count;
  }
  const recommendations = (await prisma.recommendation.deleteMany({ where: { orgId } })).count;
  await prisma.organization.delete({ where: { id: orgId } }); // cascades: members, invites, accounts, scenarios, audit log, jobs, counters
  forgetOrgKey(orgId);
  // Users who belonged only to this organization keep their login (they may join or create another).
  return { accounts: accounts.length, resources, recommendations };
}
