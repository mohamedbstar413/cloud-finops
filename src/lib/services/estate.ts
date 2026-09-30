import { prisma, parseJson } from "../db";
import type { Provider } from "../pricing/catalog";
import type { AccountRow, DailyCost, Estate, ResourceRow } from "../engine/types";
import { profileUsage, type Series } from "../usage/series";

export async function loadEstate(orgId: string, days = 90): Promise<Estate> {
  const since = new Date(Date.now() - days * 86_400_000);
  const accounts = await prisma.cloudAccount.findMany({ where: { orgId, status: { not: "pending" } } });
  const ids = accounts.map((a) => a.id);
  const [resources, costs, usage] = await Promise.all([
    prisma.resource.findMany({ where: { accountId: { in: ids } } }),
    prisma.costRecord.findMany({ where: { accountId: { in: ids }, date: { gte: since } }, orderBy: { date: "asc" } }),
    prisma.usageSeries.findMany({ where: { resource: { accountId: { in: ids } } } }),
  ]);
  const seriesByResource = new Map<string, Series[]>();
  for (const u of usage) {
    const s: Series = { metric: u.metric, stat: u.stat as Series["stat"], unit: u.unit as Series["unit"], stepMinutes: u.stepMinutes, start: u.start.toISOString(), values: parseJson(u.values, []) };
    seriesByResource.set(u.resourceId, [...(seriesByResource.get(u.resourceId) ?? []), s]);
  }

  return {
    orgId,
    accounts: accounts.map<AccountRow>((a) => ({
      id: a.id,
      provider: a.provider as Provider,
      name: a.name,
      externalId: a.externalId,
      region: a.region,
    })),
    resources: resources.map<ResourceRow>((r) => ({
      id: r.id,
      accountId: r.accountId,
      provider: r.provider as Provider,
      externalId: r.externalId,
      name: r.name,
      kind: r.kind,
      service: r.service,
      sku: r.sku,
      region: r.region,
      workload: r.workload,
      environment: r.environment,
      state: r.state,
      quantity: r.quantity,
      monthlyCost: r.monthlyCost,
      metrics: parseJson(r.metrics, {}),
      config: parseJson(r.config, {}),
      tags: parseJson(r.tags, []),
      dependsOn: parseJson(r.dependsOn, []),
      usage: seriesByResource.has(r.id) ? profileUsage(seriesByResource.get(r.id)!) : undefined,
    })),
    daily: costs.map<DailyCost>((c) => ({
      date: c.date.toISOString().slice(0, 10),
      accountId: c.accountId,
      provider: c.provider as Provider,
      service: c.service,
      category: c.category,
      region: c.region,
      workload: c.workload,
      cost: c.cost,
    })),
  };
}
