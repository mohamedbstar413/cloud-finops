/** Shared generators for complex-architecture tests and debugging scripts. */
import assert from "node:assert/strict";
import { demoSnapshot } from "../src/lib/connectors/demo";
import { DEMO_ACCOUNTS } from "../src/lib/demo/estate";
import { totalPotentialSavings } from "../src/lib/engine";
import type { ArchitectureSpec, Estate, RecommendationDraft, ResourceRow } from "../src/lib/engine/types";
import type { WorkloadProfile } from "../src/lib/engine/custom";
import { PROVIDERS, VM_TYPES, type Provider } from "../src/lib/pricing/catalog";
import { priceComponent, type Component, type ComponentKind } from "../src/lib/pricing/components";
import { profileUsage, type Series, type Stat, type Unit } from "../src/lib/usage/series";
import { summarize } from "../src/lib/usage/summary";

/** A fixed "now" so generated usage history is identical on every run. */
export const FIXED_END = new Date("2026-09-28T00:00:00Z");

/**
 * The demo estate built in memory (no database), exactly as ingestion would
 * load it: summary metrics plus the usage-history profile of every resource.
 */
export function demoEstate(end: Date = FIXED_END): Estate {
  const accounts = DEMO_ACCOUNTS.map((a) => ({ id: a.key, provider: a.provider, name: a.name, externalId: a.externalId, region: a.region }));
  const resources: ResourceRow[] = [];
  const daily: Estate["daily"] = [];
  for (const a of DEMO_ACCOUNTS) {
    const snap = demoSnapshot(a.key, a.externalId, 90, end);
    for (const { series, ...r } of snap.resources) {
      resources.push({
        ...r,
        id: `${a.key}:${r.externalId}`,
        accountId: a.key,
        provider: a.provider,
        sku: r.sku ?? null,
        workload: r.workload ?? null,
        environment: r.environment ?? null,
        dependsOn: [],
        usage: series?.length ? profileUsage(series) : undefined,
      });
    }
    snap.costs.forEach((c) => daily.push({ ...c, accountId: a.key, provider: a.provider, workload: c.workload ?? null }));
  }
  return { orgId: "test", accounts, resources, daily };
}

/** Build a usage series from a function of (index, timestamp). `days` of samples ending at FIXED_END. */
export function series(metric: string, days: number, fn: (i: number, ts: Date) => number | null, opts: { stat?: Stat; unit?: Unit; stepMinutes?: number; end?: Date } = {}): Series {
  const stepMinutes = opts.stepMinutes ?? 60;
  const n = Math.round((days * 1440) / stepMinutes);
  const start = (opts.end ?? FIXED_END).getTime() - n * stepMinutes * 60_000;
  return {
    metric,
    stat: opts.stat ?? "avg",
    unit: opts.unit ?? "percent",
    stepMinutes,
    start: new Date(start).toISOString(),
    values: Array.from({ length: n }, (_, i) => fn(i, new Date(start + i * stepMinutes * 60_000))),
  };
}

/** Attach a usage-history profile to a resource built with `resource()`. */
export const withUsage = (r: ResourceRow, ...s: Series[]): ResourceRow => ({ ...r, usage: profileUsage(s) });

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resource(p: Partial<ResourceRow> & Pick<ResourceRow, "id" | "accountId" | "provider" | "kind">): ResourceRow {
  const base: ResourceRow = {
    externalId: p.id,
    name: p.id,
    service: p.kind,
    sku: null,
    region: p.provider === "aws" ? "us-east-1" : p.provider === "azure" ? "eastus" : "us-central1",
    workload: null,
    environment: "prod",
    state: "running",
    quantity: 1,
    monthlyCost: 0,
    metrics: {},
    config: {},
    tags: [],
    dependsOn: [],
    ...p,
  };
  if (!p.monthlyCost) {
    base.monthlyCost = priceComponent({ id: base.id, kind: base.kind as ComponentKind, provider: base.provider, label: base.name, sku: base.sku ?? undefined, region: base.region, usage: { count: base.quantity, gb: base.config.sizeGb ? base.config.sizeGb * base.quantity : undefined } }).monthlyCost;
  }
  return base;
}

export function complexEstate(): Estate {
  const accounts = [
    { id: "aws-a", provider: "aws" as const, name: "Prod A", externalId: "1", region: "us-east-1" },
    { id: "aws-b", provider: "aws" as const, name: "Prod B", externalId: "2", region: "eu-west-1" },
    { id: "az", provider: "azure" as const, name: "Sub", externalId: "3", region: "eastus" },
    { id: "gcp", provider: "gcp" as const, name: "Proj", externalId: "4", region: "us-central1" },
  ];
  const resources: ResourceRow[] = [
    // Heterogeneous portable batch fleet reading from Azure, SKUs partly outside the catalog.
    resource({ id: "etl-1", accountId: "aws-a", provider: "aws", kind: "compute.vm", sku: "m5.4xlarge", quantity: 6, workload: "etl", metrics: { cpuAvg: 40, cpuP95: 97, cpuMax: 100, dutyCycle: 0.4 }, config: { portable: true, interruptible: true, dataSources: [{ provider: "azure", region: "eastus", gbPerMonth: 40_000, label: "azure-lake" }] } }),
    resource({ id: "etl-2", accountId: "aws-a", provider: "aws", kind: "compute.vm", sku: "c6i.2xlarge", quantity: 10, workload: "etl", metrics: { cpuAvg: 45, cpuP95: 98, cpuMax: 100, dutyCycle: 0.4 }, config: { portable: true, interruptible: true } }),
    resource({ id: "etl-disk", accountId: "aws-a", provider: "aws", kind: "storage.block", quantity: 16, workload: "etl", config: { sizeGb: 300, volumeType: "gp2", attached: true } }),
    resource({ id: "etl-xcloud", accountId: "az", provider: "azure", kind: "network.egress", workload: "etl", monthlyCost: 40_000 * 0.083, metrics: { gbEgress: 40_000 } }),
    // Same workload name in two AWS accounts (must not be merged for single-account detectors).
    resource({ id: "api-a", accountId: "aws-a", provider: "aws", kind: "compute.vm", sku: "m6i.4xlarge", quantity: 12, workload: "api", metrics: { cpuAvg: 8, cpuP95: 30, cpuMax: 60, memP95: 35, dutyCycle: 0.3 }, config: { stateless: true } }),
    resource({ id: "api-a-lb", accountId: "aws-a", provider: "aws", kind: "network.load_balancer", workload: "api", monthlyCost: 300, metrics: { requestsPerMonthM: 400, avgDurationMs: 90, peakToAvg: 5 } }),
    resource({ id: "api-b", accountId: "aws-b", provider: "aws", kind: "compute.vm", sku: "m5.2xlarge", region: "eu-west-1", quantity: 8, workload: "api", metrics: { cpuAvg: 12, cpuP95: 33, cpuMax: 55, memP95: 40, dutyCycle: 0.95 }, config: { armCompatible: true } }),
    // Kubernetes pools on all three clouds, one of them with an unknown SKU.
    resource({ id: "eks", accountId: "aws-a", provider: "aws", kind: "compute.vm", sku: "m6i.2xlarge", quantity: 30, workload: "eks", metrics: { cpuAvg: 18, cpuP95: 40, memP95: 45, dutyCycle: 1 }, config: { role: "k8s-node", statelessShare: 0.7 } }),
    resource({ id: "aks", accountId: "az", provider: "azure", kind: "compute.vm", sku: "Standard_D16as_v5", quantity: 10, workload: "aks", metrics: { cpuAvg: 25, cpuP95: 50, memP95: 55, dutyCycle: 1 }, config: { role: "k8s-node", statelessShare: 0.5 } }),
    resource({ id: "gke", accountId: "gcp", provider: "gcp", kind: "compute.vm", sku: "n2d-standard-16", quantity: 8, workload: "gke", metrics: { cpuAvg: 60, cpuP95: 80, memP95: 70, dutyCycle: 1 }, config: { role: "k8s-node" } }),
    // Databases, storage, NAT, idle and stopped resources.
    resource({ id: "db", accountId: "aws-a", provider: "aws", kind: "db.instance", sku: "db.r5.2xlarge", workload: "api", monthlyCost: 1700, metrics: { cpuAvg: 9, cpuP95: 25, peakToAvg: 4, hourly: Array.from({ length: 24 }, (_, h) => (h > 8 && h < 19 ? 30 : 3)) }, config: { multiAz: true, sizeGb: 800 } }),
    resource({ id: "sql", accountId: "az", provider: "azure", kind: "db.vcore", workload: "orders", monthlyCost: 5800, metrics: { cpuAvg: 6, cpuP95: 30, peakToAvg: 6 }, config: { vcores: 32, sizeGb: 2000 } }),
    resource({ id: "lake", accountId: "az", provider: "azure", kind: "storage.object", monthlyCost: 300_000 * 0.0184, config: { sizeGb: 300_000 }, metrics: { coldShare30: 0.7, coldShare90: 0.5, objectCount: 90_000_000 } }),
    resource({ id: "nat", accountId: "aws-a", provider: "aws", kind: "network.nat_gateway", quantity: 3, monthlyCost: 2600, metrics: { gbProcessed: 55_000 }, config: { s3TrafficShare: 0.6 } }),
    resource({ id: "idle", accountId: "gcp", provider: "gcp", kind: "compute.vm", sku: "n2-highmem-8", quantity: 4, metrics: { cpuAvg: 0.5, cpuP95: 1, cpuMax: 2 } }),
    resource({ id: "stopped", accountId: "aws-b", provider: "aws", kind: "compute.vm", sku: "m5.xlarge", quantity: 3, state: "stopped", monthlyCost: 0, metrics: { cpuMax: 0 } }),
    resource({ id: "stg", accountId: "aws-b", provider: "aws", kind: "compute.vm", sku: "t3.xlarge", quantity: 15, environment: "staging", metrics: { cpuAvg: 10, cpuP95: 45, cpuMax: 70, dutyCycle: 0.3 } }),
    resource({ id: "free", accountId: "gcp", provider: "gcp", kind: "other.fixed", monthlyCost: 0 }),
  ];
  return { orgId: "complex", accounts, resources, daily: [] };
}

export const VM_KINDS_FOR_FUZZ = ["compute.vm", "compute.vm", "compute.vm", "storage.block", "storage.object", "network.load_balancer", "network.nat_gateway", "network.egress", "db.instance", "db.vcore", "app.plan", "storage.snapshot", "network.public_ip", "observability.logs", "other.fixed"] as const;
export const EXTRA_SKUS = ["m6i.2xlarge", "c7g.4xlarge", "r6i.xlarge", "t4g.large", "Standard_D32as_v5", "Standard_E4ps_v5", "n2d-standard-32", "c3-highcpu-8", "m5.metal", "weird-sku"];

export function randomEstate(seed: number): Estate {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const nAcc = 1 + Math.floor(r() * 5);
  const accounts = Array.from({ length: nAcc }, (_, i) => {
    const provider = pick(PROVIDERS);
    return { id: `acc${i}`, provider, name: `acc${i}`, externalId: `${i}`, region: provider === "aws" ? "us-east-1" : provider === "azure" ? "eastus" : "us-central1" };
  });
  const workloads = ["api", "web", "etl", "batch", "search", "k8s", "data", null];
  const resources: ResourceRow[] = [];
  const n = 3 + Math.floor(r() * 60);
  for (let i = 0; i < n; i++) {
    const acc = pick(accounts);
    const kind = pick(VM_KINDS_FOR_FUZZ);
    const skus = [...VM_TYPES.filter((v) => v.provider === acc.provider).map((v) => v.sku), ...EXTRA_SKUS];
    const cpuAvg = r() * 90;
    const res = resource({
      id: `r${i}`,
      accountId: acc.id,
      provider: acc.provider,
      kind,
      sku: kind === "compute.vm" ? pick(skus) : kind === "db.instance" ? pick(["db.r5.2xlarge", "db.m5.large", "db.r6g.xlarge", "db.unknown"]) : kind === "app.plan" ? pick(["P1v3", "P2v3", "P3V3", "X9"]) : null,
      quantity: r() < 0.1 ? 0 : 1 + Math.floor(r() * 30),
      workload: pick(workloads),
      environment: pick(["prod", "prod", "staging", "dev", null]),
      state: r() < 0.1 ? "stopped" : "running",
      monthlyCost: r() < 0.05 ? 0 : r() < 0.5 ? undefined : Math.round(r() * 20_000),
      metrics: {
        cpuAvg,
        cpuP95: Math.min(100, cpuAvg * (1 + r() * 3)),
        cpuMax: Math.min(100, cpuAvg * (1 + r() * 5)),
        memP95: r() * 100,
        dutyCycle: r(),
        peakToAvg: 1 + r() * 8,
        requestsPerMonthM: r() < 0.5 ? r() * 3000 : undefined,
        avgDurationMs: r() * 2000,
        gbProcessed: r() * 100_000,
        gbEgress: r() * 50_000,
        coldShare30: r(),
        coldShare90: r() * 0.9,
        objectCount: Math.floor(r() * 1e8),
        ageDays: Math.floor(r() * 800),
        hourly: r() < 0.3 ? Array.from({ length: 24 }, () => r() * 100) : undefined,
      },
      config: {
        stateless: r() < 0.5,
        portable: r() < 0.3,
        interruptible: r() < 0.3,
        armCompatible: r() < 0.3,
        staticContent: r() < 0.05,
        attached: r() < 0.8,
        sizeGb: Math.floor(r() * 200_000),
        volumeType: pick(["gp2", "gp3"]),
        multiAz: r() < 0.5,
        vcores: 2 + Math.floor(r() * 64),
        s3TrafficShare: r(),
        role: r() < 0.15 ? "k8s-node" : undefined,
        statelessShare: r(),
        dataSources: r() < 0.2 ? [{ provider: pick(PROVIDERS), region: "us-central1", gbPerMonth: r() * 80_000, label: "src" }] : undefined,
        dataSinks: r() < 0.1 ? [{ provider: pick(PROVIDERS), region: "us-east-1", gbPerMonth: r() * 10_000, label: "sink" }] : undefined,
      },
    });
    resources.push(res);
  }
  // Daily costs with an occasional spike, so anomaly detection runs too.
  const daily: Estate["daily"] = [];
  for (let d = 0; d < 60; d++) {
    const date = new Date(Date.UTC(2026, 6, 1) + d * 86_400_000).toISOString().slice(0, 10);
    for (const acc of accounts) {
      const spike = d > 54 && r() < 0.5 ? 3 : 1;
      daily.push({ date, accountId: acc.id, provider: acc.provider, service: "Compute", category: "compute", region: acc.region, workload: null, cost: (100 + r() * 20) * spike });
    }
  }
  return { orgId: `fuzz-${seed}`, accounts, resources, daily };
}

const USAGE_SHAPES = ["flat", "business", "nightly", "growing", "shrinking", "spiky", "idle", "weekend"] as const;

/**
 * A random estate whose resources also carry random usage histories: different
 * lengths (from 3 days to 2 months), shapes (flat, office hours, nightly batch,
 * growing, shrinking, spiky, idle), missing metrics and collection gaps. About
 * a quarter of the resources keep summary metrics only, as an account that was
 * connected before history was collected would.
 */
export function randomUsageEstate(seed: number): Estate {
  const estate = randomEstate(seed);
  const r = rng(seed * 31 + 7);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const resources = estate.resources.map((res) => {
    if (r() < 0.25) return res;
    const days = pick([3, 10, 14, 21, 35, 42, 60]);
    const shape = pick(USAGE_SHAPES);
    const level = shape === "idle" ? 0.3 + r() * 3 : 4 + r() * 80;
    const growth = shape === "growing" ? 0.05 + r() * 0.4 : shape === "shrinking" ? -(0.05 + r() * 0.3) : 0;
    const gappy = r() < 0.15;
    const hours = days * 24;
    const at = (scale: number, cap = Infinity) => (i: number, ts: Date): number | null => {
      if (gappy && r() < 0.2) return null;
      const h = ts.getUTCHours();
      const weekend = (ts.getUTCDay() + 6) % 7 >= 5;
      let v = level;
      if (shape === "business") v *= !weekend && h >= 8 && h < 18 ? 1 : 0.04;
      else if (shape === "nightly") v *= h < 6 ? 1 : 0.03;
      else if (shape === "weekend") v *= weekend ? 1 : 0.05;
      else if (shape === "spiky") v *= r() < 0.03 ? 4 : 0.5;
      v *= Math.max(0.02, 1 - growth * ((hours - 1 - i) / 720));
      v *= 0.9 + r() * 0.2;
      return Math.min(cap, Math.max(0, v * scale));
    };
    const hourly = (metric: string, scale: number, opts: { stat?: Stat; unit?: Unit; cap?: number } = {}) => series(metric, days, at(scale, opts.cap), opts);
    const daily = (metric: string, scale: number, opts: { stat?: Stat; unit?: Unit } = {}) => series(metric, Math.max(days, 30), at(scale), { ...opts, stepMinutes: 1440 });
    const s: Series[] = [];
    switch (res.kind) {
      case "compute.vm":
      case "db.instance":
      case "db.vcore":
      case "app.plan": {
        s.push(hourly("cpu", 1, { cap: 100 }));
        if (r() < 0.8) s.push(hourly("cpu_max", 1.1 + r() * 0.6, { stat: "max", cap: 100 }));
        if (r() < 0.6) s.push(series("mem", days, () => 10 + level * (0.4 + r() * 0.1)));
        if (res.kind === "compute.vm" && r() < 0.7) {
          const bytes = r() < 0.5 ? 1e5 : 1e8 * (1 + r() * 50);
          s.push(hourly("net_in", bytes / level, { stat: "sum", unit: "bytes" }), hourly("net_out", bytes / level, { stat: "sum", unit: "bytes" }));
        }
        if (res.kind === "compute.vm" && r() < 0.4) s.push(series("instances", days, (_, ts) => (ts.getUTCHours() < 8 ? Math.floor(res.quantity * 0.5) : res.quantity), { unit: "count" }));
        if (res.kind === "app.plan" && r() < 0.5) s.push(hourly("requests", 1e3, { stat: "sum", unit: "count" }));
        break;
      }
      case "network.load_balancer":
        s.push(hourly("requests", shape === "idle" ? 0.5 : 5e3 * (1 + r() * 200), { stat: "sum", unit: "count" }));
        break;
      case "network.nat_gateway":
        s.push(hourly("nat_bytes", shape === "idle" ? 1e5 : 1e9 * (0.1 + r() * 3), { stat: "sum", unit: "bytes" }));
        if (r() < 0.6) {
          const share = r();
          s.push({ ...s[0], metric: "nat_storage_bytes", values: s[0].values.map((v) => (v === null ? null : v * share)) });
        }
        break;
      case "storage.object":
        s.push(daily("stored_gb", 50 + r() * 3000, { unit: "gb" }));
        if (r() < 0.5) s.push(daily("read_gb", 1 + r() * 20, { stat: "sum", unit: "gb" }));
        break;
      case "storage.block":
        if (r() < 0.5) s.push(hourly("iops", 5 + r() * 300, { unit: "iops" }));
        break;
      case "network.egress":
        s.push(daily("egress_gb", 1 + r() * 30, { stat: "sum", unit: "gb" }));
        break;
    }
    if (!s.length) return res;
    const usage = profileUsage(s);
    // Summary metrics are derived from the history, exactly as the connectors do.
    return { ...res, usage, metrics: summarize(usage, res.metrics) };
  });
  return { ...estate, resources };
}

export const FUZZ_KINDS: ComponentKind[] = ["compute.vm", "compute.vm", "network.load_balancer", "storage.object", "storage.block", "db.instance", "db.vcore", "network.nat_gateway", "app.plan", "cache.managed", "network.egress", "network.cdn", "compute.function", "network.api_gateway"];


export function randomArchitecture(seed: number): { components: Component[]; profile: WorkloadProfile } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const providers: Provider[] = r() < 0.3 ? [pick(PROVIDERS), pick(PROVIDERS)] : [pick(PROVIDERS)];
  const components: Component[] = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) => {
    const provider = pick(providers);
    const kind = pick(FUZZ_KINDS);
    const skus = [...VM_TYPES.filter((v) => v.provider === provider).map((v) => v.sku), ...EXTRA_SKUS.slice(0, 8)];
    return {
      id: `c${i}`,
      kind,
      provider,
      label: `${kind} ${i}`,
      sku: kind === "compute.vm" ? pick(skus) : kind === "db.instance" ? pick(["db.r5.xlarge", "db.m5.large"]) : kind === "app.plan" ? pick(["P1v3", "P3v3"]) : undefined,
      role: kind === "compute.vm" ? pick(["web", "batch", "stateful", "k8s", undefined] as const) : undefined,
      usage: {
        count: 1 + Math.floor(r() * 40),
        gb: Math.floor(r() * 300_000),
        storageGb: Math.floor(r() * 5000),
        vcores: 2 + Math.floor(r() * 64),
        multiAz: r() < 0.5,
        memGb: 1 + Math.floor(r() * 100),
        requestsM: r() * 2000,
        tier: kind === "storage.object" ? pick(["hot", "hot", "cool"] as const) : undefined,
      },
    };
  });
  const profile: WorkloadProfile = {
    trafficPattern: pick(["steady", "spiky", "business_hours", "batch", "unknown"] as const),
    stateless: r() < 0.6,
    interruptible: r() < 0.4,
    latencySensitive: r() < 0.2,
    requestsPerMonthM: r() < 0.6 ? Math.round(r() * 5000) : undefined,
    cpuUtilization: r() < 0.4 ? r() : undefined,
    coldShare: r() < 0.3 ? r() : undefined,
  };
  return { components, profile };
}

/* ------------------------------------------------------------------------- */
/* Invariants every engine run must hold                                      */
/* ------------------------------------------------------------------------- */
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);

export function assertSpecIntegrity(spec: ArchitectureSpec | undefined, where: string) {
  if (!spec) return;
  const ids = spec.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, `${where}: duplicate diagram node ids`);
  for (const e of spec.edges) assert.ok(ids.includes(e.from) && ids.includes(e.to), `${where}: edge ${e.from}→${e.to} references a missing node`);
  const sum = spec.components.reduce((s, c) => s + c.monthlyCost, 0);
  assert.ok(Math.abs(sum - spec.monthlyCost) < 0.05 + spec.components.length * 0.01, `${where}: spec total ${spec.monthlyCost} ≠ Σ components ${sum}`);
}

export function assertEngineInvariants(estate: Estate, recs: RecommendationDraft[], label: string) {
  const resourceIds = new Set(estate.resources.map((r) => r.id));
  const fps = recs.map((r) => r.fingerprint);
  assert.equal(new Set(fps).size, fps.length, `${label}: duplicate fingerprints`);
  const primary = recs.filter((r) => !r.overlapsWith);
  const primaryFps = new Set(primary.map((r) => r.fingerprint));
  const claimed = new Set<string>();
  for (const r of recs) {
    const where = `${label} / ${r.title}`;
    for (const k of ["currentMonthlyCost", "projectedMonthlyCost", "monthlySavings", "savingsPct", "migrationCost", "confidence"] as const) {
      assert.ok(finite(r[k]), `${where}: ${k} is not finite (${r[k]})`);
    }
    assert.ok(r.monthlySavings >= 0 && r.monthlySavings <= r.currentMonthlyCost + 0.01, `${where}: savings ${r.monthlySavings} outside [0, ${r.currentMonthlyCost}]`);
    assert.ok(r.projectedMonthlyCost >= 0, `${where}: negative projected cost`);
    assert.ok(r.savingsPct >= 0 && r.savingsPct <= 100, `${where}: savingsPct ${r.savingsPct}`);
    assert.ok(r.migrationCost >= 0, `${where}: negative migration cost`);
    assert.ok(r.details.rollout.startWeek >= 0 && r.details.rollout.startWeek <= r.details.rollout.fullWeek, `${where}: invalid rollout`);
    for (const id of r.resourceIds) assert.ok(resourceIds.has(id), `${where}: unknown resource ${id}`);
    if (r.overlapsWith) assert.ok(primaryFps.has(r.overlapsWith), `${where}: overlapsWith points to a non-primary recommendation`);
    assertSpecIntegrity(r.details.current, `${where} (current)`);
    assertSpecIntegrity(r.details.proposed, `${where} (proposed)`);
  }
  for (const r of primary) {
    for (const id of r.resourceIds) {
      assert.ok(!claimed.has(id), `${label}: resource ${id} is claimed by two primary recommendations (double-counted savings)`);
      claimed.add(id);
    }
  }
  const spend = estate.resources.reduce((s, r) => s + r.monthlyCost, 0);
  assert.ok(totalPotentialSavings(recs) <= spend + 0.01, `${label}: potential savings exceed total spend`);
}
