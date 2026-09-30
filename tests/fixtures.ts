/** Shared generators for complex-architecture tests and debugging scripts. */
import type { Estate, ResourceRow } from "../src/lib/engine/types";
import type { WorkloadProfile } from "../src/lib/engine/custom";
import { PROVIDERS, VM_TYPES, type Provider } from "../src/lib/pricing/catalog";
import { priceComponent, type Component, type ComponentKind } from "../src/lib/pricing/components";

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

