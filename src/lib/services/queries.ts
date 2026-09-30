import { prisma, parseJson } from "../db";
import { MEASURABLE_KINDS, type Coverage } from "../engine";
import type { Category, DataGap, Level, RecommendationDetails } from "../engine/types";
import type { Provider } from "../pricing/catalog";
import { PROVIDERS } from "../pricing/catalog";

const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export const ACTIVE_STATUSES = ["open", "in_progress"];

export interface RecRow {
  id: string;
  fingerprint: string;
  title: string;
  summary: string;
  category: Category;
  detector: string;
  provider: Provider;
  targetProvider: Provider | null;
  accountId: string | null;
  accountName: string | null;
  impact: Level;
  currentMonthlyCost: number;
  projectedMonthlyCost: number;
  monthlySavings: number;
  savingsPct: number;
  migrationCost: number;
  effort: Level;
  risk: Level;
  timeline: string;
  confidence: number;
  status: string;
  snoozedUntil: string | null;
  source: string;
  overlapsWith: { id: string; title: string } | null;
  hasAi: boolean;
  rollout: { startWeek: number; fullWeek: number };
  updatedAt: string;
}

type RecordRow = Awaited<ReturnType<typeof prisma.recommendation.findMany>>[number];

function toRow(r: RecordRow, accounts: Map<string, string>, byFp: Map<string, RecordRow>): RecRow {
  const details = parseJson<Partial<RecommendationDetails>>(r.details, {});
  const alt = r.overlapsWith ? byFp.get(r.overlapsWith) : undefined;
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    title: r.title,
    summary: r.summary,
    category: r.category as Category,
    detector: r.detector,
    provider: r.provider as Provider,
    targetProvider: (r.targetProvider as Provider) ?? null,
    accountId: r.accountId,
    accountName: r.accountId ? (accounts.get(r.accountId) ?? null) : null,
    impact: r.impact as Level,
    currentMonthlyCost: r.currentMonthlyCost,
    projectedMonthlyCost: r.projectedMonthlyCost,
    monthlySavings: r.monthlySavings,
    savingsPct: r.savingsPct,
    migrationCost: r.migrationCost,
    effort: r.effort as Level,
    risk: r.risk as Level,
    timeline: r.timeline,
    confidence: r.confidence,
    status: r.status,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    source: r.source,
    overlapsWith: alt ? { id: alt.id, title: alt.title } : null,
    hasAi: Boolean(r.ai),
    rollout: details.rollout ?? { startWeek: 0, fullWeek: 1 },
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listRecommendations(orgId: string) {
  const [recs, accounts] = await Promise.all([
    prisma.recommendation.findMany({ where: { orgId }, orderBy: { monthlySavings: "desc" } }),
    prisma.cloudAccount.findMany({ where: { orgId }, select: { id: true, name: true, provider: true } }),
  ]);
  const names = new Map(accounts.map((a) => [a.id, `${a.provider.toUpperCase()} ${a.name}`]));
  const byFp = new Map(recs.map((r) => [r.fingerprint, r]));
  return recs.map((r) => toRow(r, names, byFp));
}

export async function getRecommendation(orgId: string, id: string) {
  const r = await prisma.recommendation.findFirst({ where: { id, orgId }, include: { tickets: { orderBy: { createdAt: "desc" } } } });
  if (!r) return null;
  const [accounts, alternatives] = await Promise.all([
    prisma.cloudAccount.findMany({ where: { orgId }, select: { id: true, name: true, provider: true } }),
    prisma.recommendation.findMany({ where: { orgId, OR: [{ overlapsWith: r.fingerprint }, ...(r.overlapsWith ? [{ fingerprint: r.overlapsWith }] : [])] } }),
  ]);
  const names = new Map(accounts.map((a) => [a.id, `${a.provider.toUpperCase()} ${a.name}`]));
  const byFp = new Map([...alternatives, r].map((x) => [x.fingerprint, x]));
  return {
    rec: toRow(r, names, byFp),
    details: parseJson<RecommendationDetails>(r.details, { explanation: "", evidence: [], benefits: [], risks: [], implementation: [], rollout: { startWeek: 0, fullWeek: 1 } }),
    ai: parseJson<import("../ai/advisor").Enrichment | null>(r.ai, null),
    aiModel: r.aiModel,
    dismissReason: r.dismissReason,
    tickets: r.tickets.map((t) => ({ id: t.id, key: t.key, title: t.title, url: t.url, system: t.system, createdAt: t.createdAt.toISOString() })),
    related: alternatives.filter((a) => a.id !== r.id).map((a) => ({ id: a.id, title: a.title, monthlySavings: a.monthlySavings, primary: a.fingerprint === r.overlapsWith })),
  };
}

/** De-duplicated run-rate savings; anomalies are reported separately as spend at risk. */
export function potentialSavings(recs: Pick<RecRow, "monthlySavings" | "overlapsWith" | "status" | "category">[]) {
  return recs.filter((r) => !r.overlapsWith && ACTIVE_STATUSES.includes(r.status) && r.category !== "anomaly").reduce((s, r) => s + r.monthlySavings, 0);
}

export function spendAtRisk(recs: Pick<RecRow, "monthlySavings" | "overlapsWith" | "status" | "category">[]) {
  return recs.filter((r) => !r.overlapsWith && ACTIVE_STATUSES.includes(r.status) && r.category === "anomaly").reduce((s, r) => s + r.monthlySavings, 0);
}

/* ------------------------------------------------------------------------- */

/**
 * Cost records for a window of `days` ending at the latest ingested day
 * (billing exports lag by 1–2 days, so anchoring on "now" would compare a
 * partial window against a full one).
 */
async function costWindow(orgId: string, days: number, offsetDays = 0) {
  const accounts = await prisma.cloudAccount.findMany({ where: { orgId }, select: { id: true } });
  const ids = accounts.map((a) => a.id);
  const latest = await prisma.costRecord.findFirst({ where: { accountId: { in: ids } }, orderBy: { date: "desc" }, select: { date: true } });
  const anchor = latest?.date.getTime() ?? Date.now();
  const end = new Date(anchor - offsetDays * DAY);
  const start = new Date(end.getTime() - days * DAY);
  return prisma.costRecord.findMany({
    where: { accountId: { in: ids }, date: { gt: start, lte: end } },
    orderBy: { date: "asc" },
  });
}

export async function getDashboard(orgId: string, days = 30) {
  const [cur, prev, recs] = await Promise.all([costWindow(orgId, days), costWindow(orgId, days, days), listRecommendations(orgId)]);
  const total = cur.reduce((s, c) => s + c.cost, 0);
  const prevTotal = prev.reduce((s, c) => s + c.cost, 0);
  const monthly = (total / days) * 30.42;

  const byDay = new Map<string, Record<Provider, number>>();
  for (const c of cur) {
    const d = iso(c.date);
    const row = byDay.get(d) ?? { aws: 0, azure: 0, gcp: 0 };
    row[c.provider as Provider] += c.cost;
    byDay.set(d, row);
  }
  const trend = [...byDay.entries()].sort().map(([date, v]) => ({ date, aws: round(v.aws), azure: round(v.azure), gcp: round(v.gcp) }));

  const active = recs.filter((r) => ACTIVE_STATUSES.includes(r.status));
  const potential = potentialSavings(recs);
  const byStatus = (s: string) => recs.filter((r) => r.status === s && !r.overlapsWith && r.category !== "anomaly").reduce((a, r) => a + r.monthlySavings, 0);
  const byCategory = new Map<string, number>();
  for (const r of active.filter((x) => !x.overlapsWith && x.category !== "anomaly")) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.monthlySavings);

  return {
    days,
    totalSpend: round(total),
    monthlyRunRate: round(monthly),
    changePct: prevTotal ? round(((total - prevTotal) / prevTotal) * 100) : 0,
    potentialSavings: round(potential),
    atRisk: round(spendAtRisk(recs)),
    potentialPct: monthly ? round((potential / monthly) * 100) : 0,
    activeCount: active.length,
    highImpact: active.filter((r) => r.impact === "high").length,
    architectureCount: active.filter((r) => r.category === "architecture" || r.category === "cross_cloud").length,
    trend,
    top: active.filter((r) => !r.overlapsWith).slice(0, 4),
    pipeline: { open: round(byStatus("open")), inProgress: round(byStatus("in_progress")), applied: round(byStatus("applied")) },
    savingsByCategory: [...byCategory.entries()].map(([category, savings]) => ({ category, savings: round(savings) })).sort((a, b) => b.savings - a.savings),
  };
}

export interface CostFilters {
  days: number;
  providers: Provider[];
  categories: string[];
  regions: string[];
  accounts: string[];
  workloads: string[];
}

export function parseCostFilters(sp: URLSearchParams | Record<string, string | string[] | undefined>): CostFilters {
  if (!(sp instanceof URLSearchParams)) sp = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v]])));
  const list = (k: string) => (sp.get(k) ?? "").split(",").filter(Boolean);
  return {
    days: Math.min(90, Math.max(7, Number(sp.get("days") ?? 30))),
    providers: list("provider") as Provider[],
    categories: list("category"),
    regions: list("region"),
    accounts: list("account"),
    workloads: list("workload"),
  };
}

export async function getCostExplorer(orgId: string, f: CostFilters) {
  const accounts = await prisma.cloudAccount.findMany({ where: { orgId } });
  const [curAll, prevAll] = await Promise.all([costWindow(orgId, f.days), costWindow(orgId, f.days, f.days)]);
  const match = (c: (typeof curAll)[number]) =>
    (!f.providers.length || f.providers.includes(c.provider as Provider)) &&
    (!f.categories.length || f.categories.includes(c.category)) &&
    (!f.regions.length || f.regions.includes(c.region)) &&
    (!f.accounts.length || f.accounts.includes(c.accountId)) &&
    (!f.workloads.length || (c.workload && f.workloads.includes(c.workload)));
  const cur = curAll.filter(match);
  const prev = prevAll.filter(match);
  const total = cur.reduce((s, c) => s + c.cost, 0);
  const prevTotal = prev.reduce((s, c) => s + c.cost, 0);
  const days = [...new Set(cur.map((c) => iso(c.date)))].sort();

  const byProvider = PROVIDERS.map((p) => {
    const cost = cur.filter((c) => c.provider === p).reduce((s, c) => s + c.cost, 0);
    return { provider: p, cost: round(cost), pct: total ? round((cost / total) * 100) : 0 };
  }).filter((x) => x.cost > 0);

  const cats = [...new Set(cur.map((c) => c.category))];
  const byCategory = cats
    .map((cat) => {
      const row: { category: string; aws: number; azure: number; gcp: number; total: number } = { category: cat, aws: 0, azure: 0, gcp: 0, total: 0 };
      for (const c of cur.filter((x) => x.category === cat)) {
        row[c.provider as Provider] += c.cost;
        row.total += c.cost;
      }
      return { ...row, aws: round(row.aws), azure: round(row.azure), gcp: round(row.gcp), total: round(row.total) };
    })
    .sort((a, b) => b.total - a.total);

  const groups = new Map<string, { service: string; provider: Provider; category: string; cost: number; prev: number; daily: Map<string, number> }>();
  for (const c of cur) {
    const k = `${c.provider}|${c.service}`;
    const g = groups.get(k) ?? { service: c.service, provider: c.provider as Provider, category: c.category, cost: 0, prev: 0, daily: new Map() };
    g.cost += c.cost;
    const d = iso(c.date);
    g.daily.set(d, (g.daily.get(d) ?? 0) + c.cost);
    groups.set(k, g);
  }
  for (const c of prev) {
    const g = groups.get(`${c.provider}|${c.service}`);
    if (g) g.prev += c.cost;
  }
  const rows = [...groups.values()]
    .map((g) => ({
      service: g.service,
      provider: g.provider,
      category: g.category,
      cost: round(g.cost),
      pct: total ? round((g.cost / total) * 100) : 0,
      changePct: g.prev ? round(((g.cost - g.prev) / g.prev) * 100) : null,
      spark: days.map((d) => round(g.daily.get(d) ?? 0)),
    }))
    .sort((a, b) => b.cost - a.cost);

  const trend = days.map((d) => {
    const row = { date: d, aws: 0, azure: 0, gcp: 0 };
    for (const c of cur) if (iso(c.date) === d) row[c.provider as Provider] += c.cost;
    return { date: d, aws: round(row.aws), azure: round(row.azure), gcp: round(row.gcp) };
  });

  return {
    total: round(total),
    avgDaily: days.length ? round(total / days.length) : 0,
    changePct: prevTotal ? round(((total - prevTotal) / prevTotal) * 100) : 0,
    avgChangePct: prevTotal ? round(((total - prevTotal) / prevTotal) * 100) : 0,
    topService: rows[0] ?? null,
    byProvider,
    byCategory,
    rows,
    trend,
    options: {
      regions: [...new Set(curAll.map((c) => c.region))].sort(),
      categories: [...new Set(curAll.map((c) => c.category))].sort(),
      workloads: [...new Set(curAll.map((c) => c.workload).filter(Boolean))].sort() as string[],
      accounts: accounts.map((a) => ({ id: a.id, label: `${a.provider.toUpperCase()} ${a.name}` })),
    },
  };
}

export interface HeldBackRow extends DataGap {
  provider: Provider | null;
  accountName: string | null;
}

/**
 * What the last analysis could and could not evaluate: how many resources have
 * usage history, and which ones the engine deliberately left alone (and why).
 */
export async function getDataCoverage(orgId: string) {
  const run = await prisma.analysisRun.findFirst({ where: { orgId }, orderBy: { createdAt: "desc" } });
  if (!run) return null;
  const stored = parseJson<{ gaps?: DataGap[]; coverage?: Coverage }>(run.gaps, {});
  const gaps = stored.gaps ?? [];
  const resources = gaps.length
    ? await prisma.resource.findMany({ where: { id: { in: gaps.map((g) => g.resourceId) } }, select: { id: true, provider: true, account: { select: { name: true } } } })
    : [];
  const byId = new Map(resources.map((r) => [r.id, r]));
  return {
    at: run.createdAt.toISOString(),
    coverage: { measurable: run.evaluated, withHistory: run.withUsage, minDays: 0, maxDays: 0, unmeasured: 0, ...stored.coverage },
    gaps: gaps.map<HeldBackRow>((g) => ({ ...g, provider: (byId.get(g.resourceId)?.provider as Provider | undefined) ?? null, accountName: byId.get(g.resourceId)?.account.name ?? null })),
    heldBackCost: round(gaps.reduce((s, g) => s + g.monthlyCost, 0)),
  };
}

export async function listAccounts(orgId: string) {
  const accounts = await prisma.cloudAccount.findMany({ where: { orgId }, orderBy: [{ provider: "asc" }, { createdAt: "asc" }] });
  const since = new Date(Date.now() - 30 * DAY);
  const ids = accounts.map((a) => a.id);
  const [counts, costs, measurable, measured] = await Promise.all([
    prisma.resource.groupBy({ by: ["accountId"], _count: { _all: true }, where: { accountId: { in: ids } } }),
    prisma.costRecord.groupBy({ by: ["accountId"], _sum: { cost: true }, where: { accountId: { in: ids }, date: { gt: since } } }),
    prisma.resource.groupBy({ by: ["accountId"], _count: { _all: true }, where: { accountId: { in: ids }, kind: { in: MEASURABLE_KINDS }, state: "running" } }),
    prisma.resource.groupBy({ by: ["accountId"], _count: { _all: true }, where: { accountId: { in: ids }, kind: { in: MEASURABLE_KINDS }, state: "running", usage: { some: {} } } }),
  ]);
  return accounts.map((a) => ({
    id: a.id,
    provider: a.provider as Provider,
    name: a.name,
    externalId: a.externalId,
    region: a.region,
    status: a.status,
    permissions: a.permissions,
    authType: a.authType,
    isDemo: a.isDemo,
    lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    lastError: a.lastError,
    resources: counts.find((c) => c.accountId === a.id)?._count._all ?? 0,
    cost30d: round(costs.find((c) => c.accountId === a.id)?._sum.cost ?? 0),
    // Usage history: how many of the resources that need it actually have it.
    usage: { measurable: measurable.find((c) => c.accountId === a.id)?._count._all ?? 0, withHistory: measured.find((c) => c.accountId === a.id)?._count._all ?? 0 },
    warnings: parseJson<string[]>(a.syncWarnings, []),
  }));
}

export async function getOrganization(orgId: string) {
  const [org, audit, recs, accounts] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      include: { members: { include: { user: true }, orderBy: { createdAt: "asc" } }, invites: { orderBy: { createdAt: "desc" } } },
    }),
    prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.recommendation.count({ where: { orgId, status: "applied" } }),
    prisma.cloudAccount.count({ where: { orgId } }),
  ]);
  return {
    id: org.id,
    name: org.name,
    plan: org.plan,
    createdAt: org.createdAt.toISOString(),
    members: org.members.map((m) => ({ id: m.id, userId: m.userId, name: m.user.name, email: m.user.email, role: m.role, since: m.createdAt.toISOString() })),
    invites: org.invites.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt.toISOString() })),
    audit: audit.map((a) => ({ id: a.id, actor: a.actor, action: a.action, target: a.target, createdAt: a.createdAt.toISOString() })),
    stats: { applied: recs, accounts },
  };
}

export async function orgGrowthRate(orgId: string) {
  const { fitTrend } = await import("../engine/forecast");
  const rows = await costWindow(orgId, 90);
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(iso(r.date), (byDay.get(iso(r.date)) ?? 0) + r.cost);
  // Exclude the last week so short-lived anomalies don't inflate the trend.
  const series = [...byDay.entries()].sort().slice(0, -7).map(([date, cost]) => ({ date, cost }));
  return fitTrend(series).monthlyGrowthRate;
}
