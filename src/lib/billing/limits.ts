import { HttpError } from "../auth-errors";
import { prisma } from "../db";
import { planOf, type Plan } from "./plans";

/** Calendar month used for metering, e.g. "2026-10" (UTC). */
export const periodOf = (d = new Date()) => d.toISOString().slice(0, 7);
const dayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export class LimitError extends HttpError {
  constructor(message: string) {
    super(402, message);
  }
}

async function plan(orgId: string): Promise<Plan> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { plan: true, planStatus: true } });
  // A lapsed subscription falls back to the Free limits until it is paid.
  return planOf(org.planStatus === "canceled" || org.planStatus === "past_due" ? "free" : org.plan);
}

const over = (used: number, limit: number | null) => limit !== null && used >= limit;
const upgrade = (p: Plan) => (p.id === "enterprise" ? "" : " Upgrade your plan on the Billing page to raise it.");

export async function assertCanAddAccount(orgId: string) {
  const p = await plan(orgId);
  // Sample-data accounts are free: they exist so a new customer can see the product before connecting.
  const used = await prisma.cloudAccount.count({ where: { orgId, isDemo: false } });
  if (over(used, p.limits.cloudAccounts)) throw new LimitError(`The ${p.name} plan includes ${p.limits.cloudAccounts} cloud account${p.limits.cloudAccounts === 1 ? "" : "s"}.${upgrade(p)}`);
}

export async function assertCanAddMember(orgId: string) {
  const p = await plan(orgId);
  const [members, invites] = await Promise.all([prisma.membership.count({ where: { orgId } }), prisma.invite.count({ where: { orgId, acceptedAt: null } })]);
  if (over(members + invites, p.limits.members)) throw new LimitError(`The ${p.name} plan includes ${p.limits.members} members, counting pending invitations.${upgrade(p)}`);
}

/** Count one unit of a metered action, refusing it when the monthly quota is used up. */
export async function consume(orgId: string, metric: "ai_calls") {
  const p = await plan(orgId);
  const limit = p.limits.aiCallsPerMonth;
  const period = periodOf();
  const row = await prisma.usageCounter.upsert({ where: { orgId_metric_period: { orgId, metric, period } }, create: { orgId, metric, period, count: 0 }, update: {} });
  if (over(row.count, limit)) throw new LimitError(`This month's ${limit} AI requests on the ${p.name} plan are used up.${upgrade(p)}`);
  await prisma.usageCounter.update({ where: { id: row.id }, data: { count: { increment: 1 } } });
}

/** Manual syncs per day (scheduled syncs are not counted). */
export async function assertCanSyncNow(orgId: string) {
  const p = await plan(orgId);
  const today = await prisma.job.count({ where: { orgId, type: "sync_account", requestedBy: { not: "System" }, createdAt: { gte: dayStart() } } });
  if (over(today, p.limits.manualSyncsPerDay)) throw new LimitError(`The ${p.name} plan allows ${p.limits.manualSyncsPerDay} manual syncs a day; the daily sync still runs.${upgrade(p)}`);
}

export async function usage(orgId: string) {
  const p = await plan(orgId);
  const [accounts, resources, members, invites, ai] = await Promise.all([
    prisma.cloudAccount.count({ where: { orgId, isDemo: false } }),
    prisma.resource.count({ where: { account: { orgId, isDemo: false } } }),
    prisma.membership.count({ where: { orgId } }),
    prisma.invite.count({ where: { orgId, acceptedAt: null } }),
    prisma.usageCounter.findUnique({ where: { orgId_metric_period: { orgId, metric: "ai_calls", period: periodOf() } } }),
  ]);
  return {
    plan: p,
    meters: [
      { id: "cloudAccounts", label: "Cloud accounts", used: accounts, limit: p.limits.cloudAccounts },
      { id: "resources", label: "Resources analysed", used: resources, limit: p.limits.resources },
      { id: "members", label: "Members and pending invitations", used: members + invites, limit: p.limits.members },
      { id: "aiCalls", label: "AI requests this month", used: ai?.count ?? 0, limit: p.limits.aiCallsPerMonth },
    ],
  };
}
