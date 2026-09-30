import type { Provider } from "../pricing/catalog";
import { Component, ComponentKind, priceComponent, serviceName } from "../pricing/components";
import type { ResourceConfig, ResourceMetrics } from "../engine/types";

/**
 * Deterministic demo estate for "Acme Corp": four accounts across AWS, Azure
 * and GCP with realistic inefficiencies for every detector to find.
 */

export interface DemoAccountSpec {
  key: string;
  provider: Provider;
  name: string;
  externalId: string;
  region: string;
  authType: string;
}

export const DEMO_ACCOUNTS: DemoAccountSpec[] = [
  { key: "aws-prod", provider: "aws", name: "Production", externalId: "123456789012", region: "us-east-1", authType: "iam_role" },
  { key: "aws-staging", provider: "aws", name: "Staging", externalId: "987654321098", region: "eu-west-1", authType: "iam_role" },
  { key: "azure-main", provider: "azure", name: "Main Subscription", externalId: "11111111-2222-3333-4444-555555555555", region: "eastus", authType: "service_principal" },
  { key: "gcp-prod", provider: "gcp", name: "Production Project", externalId: "my-project-id-123", region: "us-central1", authType: "service_account" },
];

export interface DemoResource {
  key: string;
  account: string;
  provider: Provider;
  name: string;
  kind: ComponentKind;
  service?: string;
  sku?: string;
  region: string;
  workload?: string;
  environment?: string;
  quantity?: number;
  usage?: Component["usage"];
  monthlyCost?: number;
  metrics?: ResourceMetrics;
  config?: ResourceConfig;
  tags?: string[];
  dependsOn?: string[];
  category: string;
}

/** Diurnal profile: busy hours peak at `peak`%, nights at `floor`%. */
function profile(floor: number, peak: number, start = 8, end = 19): number[] {
  return Array.from({ length: 24 }, (_, h) => {
    if (h < start || h > end) return floor;
    const mid = (start + end) / 2;
    const w = 1 - Math.abs(h - mid) / ((end - start) / 2 + 1);
    return Math.round(floor + (peak - floor) * (0.55 + 0.45 * w));
  });
}

const aws = "aws" as const;
const azure = "azure" as const;
const gcp = "gcp" as const;

export const DEMO_RESOURCES: DemoResource[] = [
  /* ---------------- AWS Production ---------------- */
  {
    key: "api-asg", account: "aws-prod", provider: aws, name: "api-platform-asg", kind: "compute.vm", sku: "m5.4xlarge", region: "us-east-1",
    workload: "api-platform", environment: "prod", quantity: 14, category: "compute",
    metrics: { cpuAvg: 9, cpuP95: 34, cpuMax: 71, memP95: 38, dutyCycle: 0.31, hourly: profile(3, 30) },
    config: { stateless: true, asyncShare: 0.25, memoryMb: 1024, containerized: true },
    tags: ["app=api-platform", "env=prod", "team=platform"], dependsOn: ["api-db"],
  },
  {
    key: "api-alb", account: "aws-prod", provider: aws, name: "api-platform-alb", kind: "network.load_balancer", region: "us-east-1",
    workload: "api-platform", environment: "prod", usage: { gb: 60_000 }, category: "network",
    metrics: { requestsPerMonthM: 600, avgDurationMs: 120, peakToAvg: 4.2 }, tags: ["app=api-platform"],
  },
  {
    key: "api-ebs", account: "aws-prod", provider: aws, name: "api-platform-volumes", kind: "storage.block", region: "us-east-1",
    workload: "api-platform", environment: "prod", quantity: 14, usage: { gb: 7000, tier: "premium" }, category: "storage",
    config: { sizeGb: 500, volumeType: "gp2", attached: true },
  },
  {
    key: "api-egress", account: "aws-prod", provider: aws, name: "api-platform-internet-egress", kind: "network.egress", region: "us-east-1",
    workload: "api-platform", environment: "prod", usage: { gb: 18_432, destination: "internet" }, metrics: { gbEgress: 18_432 }, category: "network",
  },
  {
    key: "api-logs", account: "aws-prod", provider: aws, name: "api-platform-logs", kind: "observability.logs", region: "us-east-1",
    workload: "api-platform", environment: "prod", usage: { gb: 1200 }, category: "observability",
  },
  {
    key: "api-db", account: "aws-prod", provider: aws, name: "orders-postgres", kind: "db.instance", sku: "db.r5.2xlarge", region: "us-east-1",
    workload: "api-platform", environment: "prod", usage: { multiAz: true, storageGb: 500 }, category: "database",
    metrics: { cpuAvg: 12, cpuP95: 31, cpuMax: 58, peakToAvg: 3.1, connectionsP95: 180, hourly: profile(4, 28) },
    config: { multiAz: true, sizeGb: 500 },
  },
  {
    key: "core-asg", account: "aws-prod", provider: aws, name: "core-services-asg", kind: "compute.vm", sku: "m5.2xlarge", region: "us-east-1",
    workload: "core-services", environment: "prod", quantity: 12, category: "compute",
    metrics: { cpuAvg: 14, cpuP95: 27, cpuMax: 49, memP95: 41, dutyCycle: 0.95 },
    config: { armCompatible: true }, tags: ["app=core-services", "env=prod"],
  },
  {
    key: "core-ebs", account: "aws-prod", provider: aws, name: "core-services-volumes", kind: "storage.block", region: "us-east-1",
    workload: "core-services", environment: "prod", quantity: 12, usage: { gb: 2400, tier: "premium" }, category: "storage",
    config: { sizeGb: 200, volumeType: "gp2", attached: true },
  },
  {
    key: "platform-asg", account: "aws-prod", provider: aws, name: "platform-services-asg", kind: "compute.vm", sku: "m5.xlarge", region: "us-east-1",
    workload: "platform-services", environment: "prod", quantity: 10, category: "compute",
    metrics: { cpuAvg: 46, cpuP95: 71, cpuMax: 88, memP95: 64, dutyCycle: 0.97 },
  },
  {
    // No CloudWatch agent on these hosts: CPU and network are measured, memory is not.
    key: "reporting-workers", account: "aws-prod", provider: aws, name: "reporting-workers", kind: "compute.vm", sku: "m5.2xlarge", region: "us-east-1",
    workload: "reporting", environment: "prod", quantity: 6, category: "compute", tags: ["app=reporting", "env=prod"],
  },
  {
    // Recently launched and growing ~16%/month: looks oversized today, will not be in a quarter.
    key: "checkout-api", account: "aws-prod", provider: aws, name: "checkout-api-asg", kind: "compute.vm", sku: "m5.2xlarge", region: "us-east-1",
    workload: "checkout", environment: "prod", quantity: 8, category: "compute", tags: ["app=checkout", "env=prod"],
  },
  {
    key: "batch-fleet", account: "aws-prod", provider: aws, name: "batch-etl-workers", kind: "compute.vm", sku: "c5.4xlarge", region: "us-east-1",
    workload: "batch-etl", environment: "prod", quantity: 8, category: "compute",
    metrics: { cpuAvg: 38, cpuP95: 96, cpuMax: 100, memP95: 71, dutyCycle: 0.36, hourly: profile(2, 95, 0, 8) },
    config: {
      portable: true, interruptible: true, containerized: true,
      dataSources: [{ provider: gcp, region: "us-central1", gbPerMonth: 28_672, label: "gs://acme-data-lake" }],
      dataSinks: [{ provider: aws, region: "us-east-1", gbPerMonth: 3_072, label: "s3://acme-analytics" }],
    },
    tags: ["app=batch-etl", "workload-type=batch"],
  },
  {
    key: "batch-ebs", account: "aws-prod", provider: aws, name: "batch-etl-volumes", kind: "storage.block", region: "us-east-1",
    workload: "batch-etl", environment: "prod", quantity: 8, usage: { gb: 1600, tier: "premium" }, category: "storage",
    config: { sizeGb: 200, volumeType: "gp2", attached: true },
  },
  {
    key: "mkt-web", account: "aws-prod", provider: aws, name: "marketing-site-web", kind: "compute.vm", sku: "m5.xlarge", region: "us-east-1",
    workload: "marketing-site", environment: "prod", quantity: 4, category: "compute",
    metrics: { cpuAvg: 4, cpuP95: 11, cpuMax: 22, memP95: 20, dutyCycle: 0.4 }, config: { staticContent: true, sizeGb: 30 },
  },
  {
    key: "mkt-alb", account: "aws-prod", provider: aws, name: "marketing-site-alb", kind: "network.load_balancer", region: "us-east-1",
    workload: "marketing-site", environment: "prod", usage: { gb: 8000 }, metrics: { requestsPerMonthM: 45 }, category: "network",
  },
  {
    key: "mkt-egress", account: "aws-prod", provider: aws, name: "marketing-site-egress", kind: "network.egress", region: "us-east-1",
    workload: "marketing-site", environment: "prod", usage: { gb: 8192, destination: "internet" }, metrics: { gbEgress: 8192 }, category: "network",
  },
  {
    key: "nat", account: "aws-prod", provider: aws, name: "prod-vpc-nat", kind: "network.nat_gateway", region: "us-east-1",
    workload: "shared-network", environment: "prod", quantity: 3, usage: { count: 3, gb: 38_912 }, category: "network",
    metrics: { gbProcessed: 38_912 }, config: { s3TrafficShare: 0.72, role: "vpc-0a1b2c3d4e5f" },
  },
  {
    // Left behind by a VPC migration: still billed every hour, no traffic for weeks.
    key: "old-alb", account: "aws-prod", provider: aws, name: "old-internal-alb", kind: "network.load_balancer", region: "us-east-1",
    environment: "prod", quantity: 2, usage: { count: 2, gb: 0 }, category: "network", tags: ["vpc=legacy"],
  },
  {
    key: "old-nat", account: "aws-prod", provider: aws, name: "legacy-vpc-nat", kind: "network.nat_gateway", region: "us-east-1",
    environment: "prod", quantity: 1, usage: { count: 1, gb: 0 }, category: "network", tags: ["vpc=legacy"],
  },
  {
    key: "legacy", account: "aws-prod", provider: aws, name: "legacy-reporting", kind: "compute.vm", sku: "m5.xlarge", region: "us-east-1",
    workload: "legacy-reporting", environment: "prod", quantity: 2, category: "compute",
    metrics: { cpuAvg: 0.8, cpuP95: 1.6, cpuMax: 2.4, dutyCycle: 0 },
  },
  {
    key: "orphans", account: "aws-prod", provider: aws, name: "unattached-volumes", kind: "storage.block", region: "us-east-1",
    quantity: 6, usage: { gb: 3000, tier: "premium" }, category: "storage", config: { sizeGb: 500, volumeType: "gp2", attached: false },
    metrics: { daysSinceAttach: 64 },
  },
  {
    key: "eips", account: "aws-prod", provider: aws, name: "unassociated-eips", kind: "network.public_ip", region: "us-east-1",
    quantity: 6, usage: { count: 6 }, category: "network", config: { attached: false },
  },
  {
    key: "snaps", account: "aws-prod", provider: aws, name: "ebs-snapshots-legacy", kind: "storage.snapshot", region: "us-east-1",
    usage: { gb: 24_576 }, category: "storage", config: { sizeGb: 24_576 }, metrics: { ageDays: 410 },
  },
  {
    key: "s3-logs", account: "aws-prod", provider: aws, name: "acme-logs-archive", kind: "storage.object", region: "us-east-1",
    workload: "observability", environment: "prod", usage: { gb: 81_920, tier: "hot" }, category: "storage",
    config: { sizeGb: 81_920 }, metrics: { coldShare30: 0.9, coldShare90: 0.78, objectCount: 42_000_000 },
  },
  {
    key: "s3-media", account: "aws-prod", provider: aws, name: "acme-media-assets", kind: "storage.object", region: "us-east-1",
    workload: "media", environment: "prod", usage: { gb: 40_960, tier: "hot" }, category: "storage",
    config: { sizeGb: 40_960, tier: "unpredictable" }, metrics: { coldShare30: 0.5, coldShare90: 0.35, objectCount: 9_500_000 },
  },
  {
    key: "s3-analytics", account: "aws-prod", provider: aws, name: "acme-analytics", kind: "storage.object", region: "us-east-1",
    workload: "data-platform", environment: "prod", usage: { gb: 20_480, tier: "hot" }, category: "storage",
    config: { sizeGb: 20_480, lifecyclePolicy: true }, metrics: { coldShare30: 0.2, coldShare90: 0.1 },
  },
  { key: "aws-other", account: "aws-prod", provider: aws, name: "Route 53, KMS, Secrets Manager, Support", kind: "other.fixed", service: "Other", region: "us-east-1", monthlyCost: 1180, category: "other" },

  /* ---------------- AWS Staging ---------------- */
  {
    key: "stg-app", account: "aws-staging", provider: aws, name: "staging-app-fleet", kind: "compute.vm", sku: "m5.xlarge", region: "eu-west-1",
    workload: "staging", environment: "staging", quantity: 10, category: "compute",
    metrics: { cpuAvg: 11, cpuP95: 52, cpuMax: 80, memP95: 48, dutyCycle: 0.3, hourly: profile(1, 45, 7, 19) },
    tags: ["env=staging"],
  },
  {
    key: "stg-db", account: "aws-staging", provider: aws, name: "staging-postgres", kind: "db.instance", sku: "db.m5.large", region: "eu-west-1",
    workload: "staging", environment: "staging", usage: { storageGb: 100 }, category: "database", metrics: { cpuAvg: 6, cpuP95: 22 },
  },
  { key: "stg-other", account: "aws-staging", provider: aws, name: "Staging shared services", kind: "other.fixed", service: "Other", region: "eu-west-1", monthlyCost: 280, category: "other" },

  /* ---------------- Azure ---------------- */
  {
    key: "aks-pool", account: "azure-main", provider: azure, name: "aks-prod-userpool", kind: "compute.vm", sku: "Standard_D8s_v5", region: "eastus",
    workload: "aks-prod", environment: "prod", quantity: 12, category: "compute",
    metrics: { cpuAvg: 22, cpuP95: 48, cpuMax: 77, memP95: 55, dutyCycle: 1 },
    config: { role: "k8s-node", statelessShare: 0.65 },
  },
  { key: "aks-cp", account: "azure-main", provider: azure, name: "aks-prod", kind: "compute.k8s_control_plane", region: "eastus", workload: "aks-prod", environment: "prod", category: "compute" },
  {
    key: "azsql", account: "azure-main", provider: azure, name: "orders-sql", kind: "db.vcore", region: "eastus",
    workload: "orders", environment: "prod", usage: { vcores: 16, storageGb: 1024 }, category: "database",
    metrics: { cpuAvg: 8, cpuP95: 41, cpuMax: 63, peakToAvg: 5.5, hourly: profile(3, 42, 8, 18) },
    config: { vcores: 16, sizeGb: 1024 },
  },
  {
    key: "appsvc", account: "azure-main", provider: azure, name: "customer-portal", kind: "app.plan", sku: "P2v3", region: "eastus",
    workload: "customer-portal", environment: "prod", quantity: 4, usage: { count: 4 }, category: "compute",
    metrics: { cpuAvg: 9, cpuP95: 24, requestsPerMonthM: 40 },
  },
  {
    key: "search", account: "azure-main", provider: azure, name: "search-cluster", kind: "compute.vm", sku: "Standard_E8s_v5", region: "eastus",
    workload: "search", environment: "prod", quantity: 6, category: "compute",
    metrics: { cpuAvg: 41, cpuP95: 66, cpuMax: 84, memP95: 78, dutyCycle: 1 },
  },
  {
    key: "az-dev", account: "azure-main", provider: azure, name: "dev-workstations", kind: "compute.vm", sku: "Standard_D4s_v5", region: "eastus",
    workload: "dev", environment: "dev", quantity: 6, category: "compute",
    metrics: { cpuAvg: 8, cpuP95: 45, cpuMax: 70, memP95: 52, dutyCycle: 0.28, hourly: profile(1, 38) },
  },
  {
    key: "az-idle", account: "azure-main", provider: azure, name: "old-bi-server", kind: "compute.vm", sku: "Standard_E8s_v5", region: "eastus",
    environment: "prod", quantity: 1, category: "compute", metrics: { cpuAvg: 0.6, cpuP95: 1.2, cpuMax: 1.8, dutyCycle: 0 },
  },
  {
    key: "az-blob", account: "azure-main", provider: azure, name: "acmeprodarchive", kind: "storage.object", region: "eastus",
    workload: "archive", environment: "prod", usage: { gb: 122_880, tier: "hot" }, category: "storage",
    config: { sizeGb: 122_880 }, metrics: { coldShare30: 0.8, coldShare90: 0.6, objectCount: 18_000_000 },
  },
  { key: "az-logs", account: "azure-main", provider: azure, name: "log-analytics-prod", kind: "observability.logs", region: "eastus", usage: { gb: 450 }, category: "observability" },
  { key: "az-egress", account: "azure-main", provider: azure, name: "internet-egress", kind: "network.egress", region: "eastus", usage: { gb: 6144, destination: "internet" }, category: "network" },
  { key: "az-other", account: "azure-main", provider: azure, name: "Defender, Key Vault, Monitor", kind: "other.fixed", service: "Other", region: "eastus", monthlyCost: 640, category: "other" },

  /* ---------------- GCP ---------------- */
  {
    key: "gke-pool", account: "gcp-prod", provider: gcp, name: "gke-prod-pool", kind: "compute.vm", sku: "n2-standard-8", region: "us-central1",
    workload: "gke-prod", environment: "prod", quantity: 10, category: "compute",
    metrics: { cpuAvg: 58, cpuP95: 74, cpuMax: 90, memP95: 70, dutyCycle: 1 }, config: { role: "k8s-node", statelessShare: 0.4 },
  },
  { key: "gke-cp", account: "gcp-prod", provider: gcp, name: "gke-prod", kind: "compute.k8s_control_plane", region: "us-central1", workload: "gke-prod", environment: "prod", category: "compute" },
  {
    key: "gcs-lake", account: "gcp-prod", provider: gcp, name: "acme-data-lake", kind: "storage.object", region: "us-central1",
    workload: "data-platform", environment: "prod", usage: { gb: 61_440, tier: "hot" }, category: "storage",
    config: { sizeGb: 61_440 }, metrics: { coldShare30: 0.15, coldShare90: 0.1 },
  },
  {
    key: "gcp-xcloud", account: "gcp-prod", provider: gcp, name: "egress-to-aws (batch-etl)", kind: "network.egress", region: "us-central1",
    workload: "batch-etl", environment: "prod", usage: { gb: 28_672, destination: "inter_cloud" }, metrics: { gbEgress: 28_672 }, category: "network",
  },
  { key: "bq", account: "gcp-prod", provider: gcp, name: "analytics-warehouse", kind: "analytics.warehouse", region: "us-central1", workload: "data-platform", environment: "prod", usage: { gb: 256_000 }, category: "analytics" },
  {
    key: "cloudsql", account: "gcp-prod", provider: gcp, name: "inventory-db", kind: "db.vcore", region: "us-central1",
    workload: "inventory", environment: "prod", usage: { vcores: 8, storageGb: 250 }, category: "database", metrics: { cpuAvg: 35, cpuP95: 62, peakToAvg: 1.8 }, config: { vcores: 8 },
  },
  {
    key: "gce-idle", account: "gcp-prod", provider: gcp, name: "ml-experiments", kind: "compute.vm", sku: "n2-standard-4", region: "us-central1",
    environment: "prod", quantity: 3, category: "compute", metrics: { cpuAvg: 0.9, cpuP95: 2, cpuMax: 3.1, dutyCycle: 0 },
  },
  { key: "gcp-logs", account: "gcp-prod", provider: gcp, name: "cloud-logging", kind: "observability.logs", region: "us-central1", usage: { gb: 300 }, category: "observability" },
  { key: "gcp-other", account: "gcp-prod", provider: gcp, name: "Cloud DNS, KMS, Support", kind: "other.fixed", service: "Other", region: "us-central1", monthlyCost: 380, category: "other" },
];

export function demoResourceCost(r: DemoResource): number {
  if (r.monthlyCost !== undefined) return r.monthlyCost;
  const usage = { count: r.quantity ?? 1, ...(r.usage ?? {}) };
  return priceComponent({ id: r.key, kind: r.kind, provider: r.provider, label: r.name, sku: r.sku, region: r.region, usage }).monthlyCost;
}

export function demoServiceName(r: DemoResource): string {
  if (r.service) return r.service;
  if (r.kind === "storage.block" || r.kind === "storage.snapshot") return serviceName("storage.block", r.provider);
  return serviceName(r.kind, r.provider);
}

/* ------------------------------------------------------------------------- */
/* Daily cost history                                                         */
/* ------------------------------------------------------------------------- */

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

export const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

export interface DemoDaily {
  date: string;
  resourceKey: string;
  cost: number;
}

/**
 * 90 days of daily costs per resource: ~2%/month organic growth, weekday
 * seasonality on traffic-driven services, deterministic noise, and an injected
 * BigQuery spike in the last 6 days for the anomaly detector.
 */
export function buildDemoDaily(resources: DemoResource[], days = 90, end = new Date()): DemoDaily[] {
  const out: DemoDaily[] = [];
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (const r of resources) {
    const rand = rng(hash(r.key));
    const monthly = demoResourceCost(r);
    const base = monthly / 30.42;
    const trafficDriven = ["network", "observability", "analytics"].includes(r.category) || r.kind === "compute.function";
    for (let i = days - 1; i >= 0; i--) {
      const t = endUtc - i * 86_400_000;
      const d = new Date(t);
      const dow = d.getUTCDay();
      const growth = 1 - 0.00068 * i; // ≈2%/month
      const seasonal = trafficDriven ? (dow === 0 || dow === 6 ? 0.82 : 1.06) : 1;
      const noise = 1 + (rand() - 0.5) * (trafficDriven ? 0.12 : 0.04);
      let cost = base * growth * seasonal * noise;
      if (r.key === "bq" && i < 6) cost *= 2.7;
      out.push({ date: d.toISOString().slice(0, 10), resourceKey: r.key, cost: Math.round(cost * 100) / 100 });
    }
  }
  return out;
}
