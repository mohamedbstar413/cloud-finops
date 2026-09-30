import { prisma } from "../db";
import { decryptJson } from "../crypto";
import { awsConnector } from "../connectors/aws";
import { azureConnector } from "../connectors/azure";
import { gcpConnector } from "../connectors/gcp";
import { demoSnapshot } from "../connectors/demo";
import { DEMO_ACCOUNTS } from "../demo/estate";
import type { AwsCredentials, AzureCredentials, GcpCredentials, Snapshot, ValidationResult } from "../connectors/types";
import { runAnalysis } from "./analysis";

const DAYS = 90;

/** Upsert inventory by external id (stable ids keep recommendation fingerprints stable). */
export async function persistSnapshot(accountId: string, provider: string, snap: Snapshot) {
  const existing = await prisma.resource.findMany({ where: { accountId }, select: { id: true, externalId: true } });
  const byExt = new Map(existing.map((r) => [r.externalId, r.id]));
  const keep = new Set<string>();

  for (const r of snap.resources) {
    const data = {
      accountId,
      provider,
      externalId: r.externalId,
      name: r.name,
      kind: r.kind,
      service: r.service,
      sku: r.sku ?? null,
      region: r.region,
      workload: r.workload ?? null,
      environment: r.environment ?? null,
      state: r.state,
      quantity: r.quantity,
      monthlyCost: r.monthlyCost,
      metrics: JSON.stringify(r.metrics),
      config: JSON.stringify(r.config),
      tags: JSON.stringify(r.tags),
    };
    const id = byExt.get(r.externalId);
    if (id) {
      await prisma.resource.update({ where: { id }, data });
      keep.add(id);
    } else {
      const created = await prisma.resource.create({ data });
      keep.add(created.id);
    }
  }
  const gone = existing.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (gone.length) await prisma.resource.deleteMany({ where: { id: { in: gone } } });

  // Usage history: replace each resource's series with the freshly collected window.
  const refreshed = await prisma.resource.findMany({ where: { accountId }, select: { id: true, externalId: true } });
  const idByExt = new Map(refreshed.map((r) => [r.externalId, r.id]));
  await prisma.usageSeries.deleteMany({ where: { resourceId: { in: refreshed.map((r) => r.id) } } });
  const seriesRows = snap.resources.flatMap((r) =>
    (r.series ?? [])
      .filter((s) => s.values.length)
      .map((s) => ({
        resourceId: idByExt.get(r.externalId)!,
        metric: s.metric,
        stat: s.stat,
        unit: s.unit,
        stepMinutes: s.stepMinutes,
        start: new Date(s.start),
        values: JSON.stringify(s.values),
      })),
  );
  for (let i = 0; i < seriesRows.length; i += 50) await prisma.usageSeries.createMany({ data: seriesRows.slice(i, i + 50) });

  await prisma.costRecord.deleteMany({ where: { accountId } });
  const rows = snap.costs.map((c) => ({
    accountId,
    date: new Date(`${c.date}T00:00:00Z`),
    provider,
    service: c.service,
    category: c.category,
    region: c.region,
    workload: c.workload ?? null,
    cost: Math.round(c.cost * 100) / 100,
  }));
  for (let i = 0; i < rows.length; i += 2000) {
    await prisma.costRecord.createMany({ data: rows.slice(i, i + 2000) });
  }
  return { resources: snap.resources.length, costRows: rows.length, series: seriesRows.length };
}

export async function collectSnapshot(account: { provider: string; isDemo: boolean; externalId: string; credentials: string | null }): Promise<Snapshot> {
  if (account.isDemo) {
    const spec = DEMO_ACCOUNTS.find((a) => a.externalId === account.externalId);
    if (!spec) throw new Error("Unknown demo account");
    return demoSnapshot(spec.key, spec.externalId, DAYS);
  }
  if (!account.credentials) throw new Error("No credentials stored for this account");
  switch (account.provider) {
    case "aws":
      return awsConnector.collect(decryptJson<AwsCredentials>(account.credentials), { days: DAYS });
    case "azure":
      return azureConnector.collect(decryptJson<AzureCredentials>(account.credentials), { days: DAYS });
    case "gcp":
      return gcpConnector.collect(decryptJson<GcpCredentials>(account.credentials), { days: DAYS });
    default:
      throw new Error(`Unsupported provider ${account.provider}`);
  }
}

export async function validateCredentials(provider: string, creds: unknown): Promise<ValidationResult> {
  switch (provider) {
    case "aws":
      return awsConnector.validate(creds as AwsCredentials);
    case "azure":
      return azureConnector.validate(creds as AzureCredentials);
    case "gcp":
      return gcpConnector.validate(creds as GcpCredentials);
    default:
      return { ok: false, message: "Unsupported provider" };
  }
}

/** Pull → normalize → store → re-analyse. Records health on the account. */
export async function syncAccount(accountId: string, { analyze = true } = {}) {
  const account = await prisma.cloudAccount.findUniqueOrThrow({ where: { id: accountId } });
  try {
    const snap = await collectSnapshot(account);
    const stats = await persistSnapshot(account.id, account.provider, snap);
    await prisma.cloudAccount.update({
      where: { id: accountId },
      data: { status: "connected", lastSyncAt: new Date(), lastError: null, syncWarnings: JSON.stringify([...new Set(snap.warnings ?? [])].slice(0, 20)) },
    });
    const analysis = analyze ? await runAnalysis(account.orgId) : null;
    return { ok: true as const, ...stats, warnings: snap.warnings ?? [], analysis };
  } catch (e) {
    await prisma.cloudAccount.update({ where: { id: accountId }, data: { status: "error", lastError: (e as Error).message.slice(0, 500) } });
    return { ok: false as const, error: (e as Error).message };
  }
}
