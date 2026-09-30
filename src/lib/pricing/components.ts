import {
  HOURS_PER_MONTH,
  PRICES,
  Provider,
  regionMultiplier,
  resolveVm,
} from "./catalog";

/**
 * Provider-agnostic building blocks. Both the rules engine and the LLM describe
 * architectures using ONLY these kinds, so every proposal — human, rule or AI —
 * is priced by the same deterministic calculator.
 */
export const COMPONENT_KINDS = [
  "compute.vm",
  "compute.function",
  "compute.container",
  "compute.k8s_control_plane",
  "network.load_balancer",
  "network.api_gateway",
  "network.nat_gateway",
  "network.egress",
  "network.cdn",
  "network.vpc_endpoint",
  "network.public_ip",
  "messaging.queue",
  "storage.object",
  "storage.block",
  "storage.snapshot",
  "db.instance",
  "db.serverless",
  "db.vcore",
  "app.plan",
  "analytics.warehouse",
  "observability.logs",
  "cache.managed",
  "other.fixed",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export type Tier =
  | "hot"
  | "cool"
  | "cold"
  | "archive"
  | "premium"
  | "standard"
  | "http"
  | "rest"
  | "gateway"
  | "interface";

export interface ComponentUsage {
  count?: number;
  hours?: number;
  spot?: boolean;
  requestsM?: number;
  avgDurationMs?: number;
  memoryMb?: number;
  vcpu?: number;
  memGb?: number;
  activeHours?: number;
  gb?: number;
  tier?: Tier;
  multiAz?: boolean;
  storageGb?: number;
  capacityUnits?: number;
  vcores?: number;
  monthlyCost?: number;
  destination?: "internet" | "inter_region" | "inter_cloud";
}

/** Workload role of a component; drives which optimizations are safe to apply. */
export type ComponentRole = "web" | "batch" | "stateful" | "k8s";

export interface Component {
  id: string;
  kind: ComponentKind;
  provider: Provider;
  label: string;
  sku?: string;
  region?: string;
  usage: ComponentUsage;
  role?: ComponentRole;
  notes?: string;
}

export interface PricedComponent extends Component {
  monthlyCost: number;
  pricingNote: string;
}

export type IconKey =
  | "users"
  | "internet"
  | "lb"
  | "vm"
  | "function"
  | "container"
  | "k8s"
  | "api"
  | "queue"
  | "db"
  | "storage"
  | "disk"
  | "cdn"
  | "nat"
  | "endpoint"
  | "ip"
  | "cache"
  | "analytics"
  | "logs"
  | "app"
  | "other";

export const KIND_ICON: Record<ComponentKind, IconKey> = {
  "compute.vm": "vm",
  "compute.function": "function",
  "compute.container": "container",
  "compute.k8s_control_plane": "k8s",
  "network.load_balancer": "lb",
  "network.api_gateway": "api",
  "network.nat_gateway": "nat",
  "network.egress": "internet",
  "network.cdn": "cdn",
  "network.vpc_endpoint": "endpoint",
  "network.public_ip": "ip",
  "messaging.queue": "queue",
  "storage.object": "storage",
  "storage.block": "disk",
  "storage.snapshot": "disk",
  "db.instance": "db",
  "db.serverless": "db",
  "db.vcore": "db",
  "app.plan": "app",
  "analytics.warehouse": "analytics",
  "observability.logs": "logs",
  "cache.managed": "cache",
  "other.fixed": "other",
};

const SERVICE_NAMES: Partial<Record<ComponentKind, Record<Provider, string>>> = {
  "compute.vm": { aws: "EC2", azure: "Virtual Machines", gcp: "Compute Engine" },
  "compute.function": { aws: "Lambda", azure: "Azure Functions", gcp: "Cloud Run functions" },
  "compute.container": { aws: "Fargate", azure: "Container Apps", gcp: "Cloud Run" },
  "compute.k8s_control_plane": { aws: "EKS", azure: "AKS", gcp: "GKE" },
  "network.load_balancer": { aws: "ALB", azure: "Application Gateway", gcp: "Cloud Load Balancing" },
  "network.api_gateway": { aws: "API Gateway", azure: "API Management", gcp: "API Gateway" },
  "network.nat_gateway": { aws: "NAT Gateway", azure: "NAT Gateway", gcp: "Cloud NAT" },
  "network.egress": { aws: "Data Transfer", azure: "Bandwidth", gcp: "Network Egress" },
  "network.cdn": { aws: "CloudFront", azure: "Front Door", gcp: "Cloud CDN" },
  "network.vpc_endpoint": { aws: "VPC Endpoint", azure: "Private Endpoint", gcp: "Private Service Connect" },
  "network.public_ip": { aws: "Public IPv4", azure: "Public IP", gcp: "External IP" },
  "messaging.queue": { aws: "SQS", azure: "Storage Queues", gcp: "Pub/Sub" },
  "storage.object": { aws: "S3", azure: "Blob Storage", gcp: "Cloud Storage" },
  "storage.block": { aws: "EBS", azure: "Managed Disks", gcp: "Persistent Disk" },
  "storage.snapshot": { aws: "EBS Snapshots", azure: "Disk Snapshots", gcp: "PD Snapshots" },
  "db.instance": { aws: "RDS", azure: "Azure Database", gcp: "Cloud SQL" },
  "db.serverless": { aws: "Aurora Serverless v2", azure: "Azure SQL Serverless", gcp: "Cloud SQL" },
  "db.vcore": { aws: "RDS", azure: "Azure SQL Database", gcp: "Cloud SQL" },
  "app.plan": { aws: "Elastic Beanstalk", azure: "App Service", gcp: "App Engine" },
  "analytics.warehouse": { aws: "Athena", azure: "Synapse", gcp: "BigQuery" },
  "observability.logs": { aws: "CloudWatch Logs", azure: "Log Analytics", gcp: "Cloud Logging" },
  "cache.managed": { aws: "ElastiCache", azure: "Azure Cache for Redis", gcp: "Memorystore" },
};

export function serviceName(kind: ComponentKind, provider: Provider): string {
  return SERVICE_NAMES[kind]?.[provider] ?? "Other";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Case-insensitive price-table lookup (users type P3V3, DB.R5.XLARGE, …). */
const lookup = (table: Record<string, number>, sku?: string) =>
  sku ? (table[sku] ?? Object.entries(table).find(([k]) => k.toLowerCase() === sku.toLowerCase())?.[1]) : undefined;

/** Deterministic monthly price for one architecture component. */
export function priceComponent(c: Component): PricedComponent {
  const u = c.usage;
  const p = c.provider;
  const rm = regionMultiplier(c.region);
  const count = u.count ?? 1;
  const hours = u.hours ?? HOURS_PER_MONTH;
  let cost = 0;
  let note = "";

  switch (c.kind) {
    case "compute.vm": {
      const vm = resolveVm(c.sku);
      const hourly = vm ? vm.hourly : 0.1;
      const factor = u.spot ? (vm?.spotFactor ?? 0.35) : 1;
      cost = hourly * rm * factor * hours * count;
      note = `${count} × ${c.sku ?? "vm"} @ $${(hourly * rm * factor).toFixed(4)}/hr × ${Math.round(hours)}h${u.spot ? " (spot)" : ""}${!vm ? " (unknown type, default rate)" : vm.estimated ? " (rate estimated from instance shape)" : ""}`;
      break;
    }
    case "compute.function": {
      const f = PRICES.serverlessFunction[p];
      const req = u.requestsM ?? 0;
      const gbs = req * 1_000_000 * ((u.avgDurationMs ?? 100) / 1000) * ((u.memoryMb ?? 512) / 1024);
      cost = req * f.perMillionRequests + gbs * f.perGbSecond;
      note = `${req}M invocations, ${Math.round(gbs / 1e6)}M GB-s`;
      break;
    }
    case "compute.container": {
      const f = PRICES.containerServerless[p];
      const active = u.activeHours ?? hours;
      const vcpu = u.vcpu ?? 1;
      const mem = u.memGb ?? 2;
      const spot = u.spot ? f.spotFactor : 1;
      cost = count * active * (vcpu * f.perVcpuHour + mem * f.perGbHour) * spot * rm + (u.requestsM ?? 0) * f.perMillionRequests;
      note = `${count} × ${vcpu} vCPU / ${mem} GB for ${Math.round(active)} active h${u.spot ? " (spot)" : ""}`;
      break;
    }
    case "compute.k8s_control_plane":
      cost = PRICES.kubernetesControlPlane[p] * count;
      note = `${count} managed control plane(s)`;
      break;
    case "network.load_balancer": {
      const lb = PRICES.loadBalancer[p];
      cost = count * lb.hourly * hours + (u.gb ?? 0) * lb.perGb;
      note = `${count} LB, ${fmtGb(u.gb ?? 0)} processed`;
      break;
    }
    case "network.api_gateway": {
      const g = PRICES.apiGateway[p];
      const rate = u.tier === "rest" ? g.rest : g.http;
      cost = (u.requestsM ?? 0) * rate;
      note = `${u.requestsM ?? 0}M requests @ $${rate}/M`;
      break;
    }
    case "network.nat_gateway": {
      const n = PRICES.natGateway[p];
      cost = count * n.hourly * hours + (u.gb ?? 0) * n.perGb;
      note = `${count} gateway(s), ${fmtGb(u.gb ?? 0)} processed`;
      break;
    }
    case "network.egress": {
      const rate =
        u.destination === "inter_region" ? PRICES.egressInterRegion[p] : PRICES.egressInternet[p];
      cost = (u.gb ?? 0) * rate;
      note = `${fmtGb(u.gb ?? 0)} ${u.destination?.replace("_", "-") ?? "internet"} egress`;
      break;
    }
    case "network.cdn": {
      const cdn = PRICES.cdn[p];
      cost = (u.gb ?? 0) * cdn.perGb + (u.requestsM ?? 0) * cdn.perMillionRequests;
      note = `${fmtGb(u.gb ?? 0)} delivered, ${u.requestsM ?? 0}M requests`;
      break;
    }
    case "network.vpc_endpoint":
      if (u.tier === "gateway") {
        cost = 0;
        note = "Gateway endpoint (no hourly or data charge)";
      } else {
        const e = PRICES.vpcInterfaceEndpoint;
        cost = count * e.hourly * hours + (u.gb ?? 0) * e.perGb;
        note = `${count} interface endpoint AZ(s), ${fmtGb(u.gb ?? 0)}`;
      }
      break;
    case "network.public_ip":
      cost = count * PRICES.publicIp[p];
      note = `${count} address(es)`;
      break;
    case "messaging.queue":
      cost = (u.requestsM ?? 0) * PRICES.queue[p].perMillionRequests;
      note = `${u.requestsM ?? 0}M requests`;
      break;
    case "storage.object": {
      const tier = (u.tier ?? "hot") as "hot" | "cool" | "cold" | "archive";
      const rate = PRICES.objectStorage[p][tier] ?? PRICES.objectStorage[p].hot;
      cost = (u.gb ?? 0) * rate * rm;
      note = `${fmtGb(u.gb ?? 0)} in ${PRICES.objectStorageTierLabel[p][tier] ?? tier}`;
      break;
    }
    case "storage.block": {
      const tier = u.tier === "standard" ? "standard" : "premium";
      cost = (u.gb ?? 0) * PRICES.blockStorage[p][tier] * rm;
      note = `${fmtGb(u.gb ?? 0)} ${tier === "standard" ? (p === "aws" ? "gp3" : "standard SSD") : p === "aws" ? "gp2" : "premium SSD"}`;
      break;
    }
    case "storage.snapshot": {
      const rate = u.tier === "archive" ? PRICES.snapshotArchive[p] : PRICES.snapshot[p];
      cost = (u.gb ?? 0) * rate;
      note = `${fmtGb(u.gb ?? 0)} snapshots${u.tier === "archive" ? " (archive tier)" : ""}`;
      break;
    }
    case "db.instance": {
      const hourly = lookup(PRICES.dbInstance, c.sku) ?? 0.5;
      const az = u.multiAz ? 2 : 1;
      cost = count * hourly * az * hours * rm + (u.storageGb ?? 0) * PRICES.dbStoragePerGb[p] * az;
      note = `${count} × ${c.sku ?? "db"}${u.multiAz ? " Multi-AZ" : ""}, ${u.storageGb ?? 0} GB`;
      break;
    }
    case "db.serverless": {
      const s = PRICES.dbServerless[p];
      const units = u.capacityUnits ?? 2;
      const active = u.activeHours ?? hours;
      cost = units * active * s.perCapacityHour * rm + (u.storageGb ?? 0) * PRICES.dbStoragePerGb[p];
      note = `avg ${units} ${s.unit} × ${Math.round(active)} active h, ${u.storageGb ?? 0} GB`;
      break;
    }
    case "db.vcore": {
      const v = PRICES.dbVcore[p];
      cost = (u.vcores ?? 4) * v.perVcoreHour * hours * rm + (u.storageGb ?? 0) * PRICES.dbStoragePerGb[p];
      note = `${u.vcores ?? 4} vCores provisioned, ${u.storageGb ?? 0} GB`;
      break;
    }
    case "app.plan": {
      const hourly = lookup(PRICES.appPlatformPlan, c.sku) ?? 0.225;
      cost = count * hourly * hours * rm;
      note = `${count} × ${c.sku ?? "plan"} instance(s)`;
      break;
    }
    case "analytics.warehouse":
      cost = (u.gb ?? 0) / 1024 * PRICES.warehousePerTb[p];
      note = `${fmtGb(u.gb ?? 0)} scanned`;
      break;
    case "observability.logs":
      cost = (u.gb ?? 0) * PRICES.logsPerGb[p];
      note = `${fmtGb(u.gb ?? 0)} ingested`;
      break;
    case "cache.managed":
      cost = (u.memGb ?? 1) * PRICES.cachePerGbHour[p] * hours * count;
      note = `${count} × ${u.memGb ?? 1} GB cache`;
      break;
    case "other.fixed":
      cost = u.monthlyCost ?? 0;
      note = "fixed monthly cost";
      break;
  }

  return { ...c, monthlyCost: round2(cost), pricingNote: note };
}

export function priceComponents(cs: Component[]): { components: PricedComponent[]; total: number } {
  const components = cs.map(priceComponent);
  return { components, total: round2(components.reduce((s, c) => s + c.monthlyCost, 0)) };
}

export function fmtGb(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(gb >= 10240 ? 0 : 1)} TB`;
  return `${Math.round(gb)} GB`;
}
