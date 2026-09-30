/**
 * Multi-cloud list-price snapshot (USD, Linux, on-demand unless stated).
 *
 * Prices are a curated snapshot of public list prices used to *compare*
 * architectures consistently across providers. They are intentionally kept in
 * one place so a pricing-API refresher (AWS Price List, Azure Retail Prices,
 * GCP Cloud Billing Catalog) can replace them without touching the engine.
 */

export type Provider = "aws" | "azure" | "gcp";
export const PROVIDERS: Provider[] = ["aws", "azure", "gcp"];

export const HOURS_PER_MONTH = 730;

export const PROVIDER_LABEL: Record<Provider, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
};

export interface VmType {
  sku: string;
  provider: Provider;
  family: string;
  vcpu: number;
  memGiB: number;
  hourly: number; // reference-region on-demand price
  arch: "x86" | "arm";
  /** Typical spot/preemptible price as a fraction of on-demand. */
  spotFactor: number;
  profile: "general" | "compute" | "memory" | "burstable";
}

const vm = (
  provider: Provider,
  sku: string,
  family: string,
  vcpu: number,
  memGiB: number,
  hourly: number,
  profile: VmType["profile"],
  arch: VmType["arch"] = "x86",
  spotFactor = provider === "gcp" ? 0.3 : 0.35,
): VmType => ({ provider, sku, family, vcpu, memGiB, hourly, profile, arch, spotFactor });

export const VM_TYPES: VmType[] = [
  // AWS (us-east-1)
  vm("aws", "t3.medium", "t3", 2, 4, 0.0416, "burstable"),
  vm("aws", "t3.large", "t3", 2, 8, 0.0832, "burstable"),
  vm("aws", "t3.xlarge", "t3", 4, 16, 0.1664, "burstable"),
  vm("aws", "m5.large", "m5", 2, 8, 0.096, "general"),
  vm("aws", "m5.xlarge", "m5", 4, 16, 0.192, "general"),
  vm("aws", "m5.2xlarge", "m5", 8, 32, 0.384, "general"),
  vm("aws", "m5.4xlarge", "m5", 16, 64, 0.768, "general"),
  vm("aws", "m7g.large", "m7g", 2, 8, 0.0816, "general", "arm"),
  vm("aws", "m7g.xlarge", "m7g", 4, 16, 0.1632, "general", "arm"),
  vm("aws", "m7g.2xlarge", "m7g", 8, 32, 0.3264, "general", "arm"),
  vm("aws", "m7g.4xlarge", "m7g", 16, 64, 0.6528, "general", "arm"),
  vm("aws", "c5.xlarge", "c5", 4, 8, 0.17, "compute"),
  vm("aws", "c5.2xlarge", "c5", 8, 16, 0.34, "compute"),
  vm("aws", "c5.4xlarge", "c5", 16, 32, 0.68, "compute"),
  vm("aws", "c7g.4xlarge", "c7g", 16, 32, 0.58, "compute", "arm"),
  vm("aws", "r5.xlarge", "r5", 4, 32, 0.252, "memory"),
  vm("aws", "r5.2xlarge", "r5", 8, 64, 0.504, "memory"),
  // Azure (eastus)
  vm("azure", "Standard_D2s_v5", "Dsv5", 2, 8, 0.096, "general"),
  vm("azure", "Standard_D4s_v5", "Dsv5", 4, 16, 0.192, "general"),
  vm("azure", "Standard_D8s_v5", "Dsv5", 8, 32, 0.384, "general"),
  vm("azure", "Standard_D16s_v5", "Dsv5", 16, 64, 0.768, "general"),
  vm("azure", "Standard_D4ps_v5", "Dpsv5", 4, 16, 0.154, "general", "arm"),
  vm("azure", "Standard_D8ps_v5", "Dpsv5", 8, 32, 0.308, "general", "arm"),
  vm("azure", "Standard_F16s_v2", "Fsv2", 16, 32, 0.677, "compute"),
  vm("azure", "Standard_E4s_v5", "Esv5", 4, 32, 0.252, "memory"),
  vm("azure", "Standard_E8s_v5", "Esv5", 8, 64, 0.504, "memory"),
  // GCP (us-central1)
  vm("gcp", "e2-standard-2", "e2", 2, 8, 0.067, "general"),
  vm("gcp", "e2-standard-4", "e2", 4, 16, 0.134, "general"),
  vm("gcp", "e2-standard-8", "e2", 8, 32, 0.268, "general"),
  vm("gcp", "n2-standard-4", "n2", 4, 16, 0.1942, "general"),
  vm("gcp", "n2-standard-8", "n2", 8, 32, 0.3885, "general"),
  vm("gcp", "n2-standard-16", "n2", 16, 64, 0.777, "general"),
  vm("gcp", "n2-highcpu-16", "n2", 16, 16, 0.5737, "compute"),
  vm("gcp", "c3-highcpu-22", "c3", 22, 44, 0.9716, "compute"),
  vm("gcp", "t2a-standard-16", "t2a", 16, 64, 0.616, "general", "arm"),
  vm("gcp", "n2-highmem-8", "n2", 8, 64, 0.524, "memory"),
];

export const REGION_MULTIPLIER: Record<string, number> = {
  "us-east-1": 1,
  "us-east-2": 1,
  "us-west-2": 1,
  "eu-west-1": 1.115,
  "eu-central-1": 1.19,
  "ap-southeast-1": 1.25,
  "sa-east-1": 1.59,
  eastus: 1,
  eastus2: 1,
  westus2: 1,
  westeurope: 1.1,
  northeurope: 1.07,
  "us-central1": 1,
  "us-east1": 1,
  "europe-west1": 1.1,
  "asia-southeast1": 1.23,
};

export const DEFAULT_REGION: Record<Provider, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
};

export const regionMultiplier = (region?: string) =>
  (region && REGION_MULTIPLIER[region]) || 1;

/** Exact catalog lookup. */
export function findVm(sku?: string | null): VmType | undefined {
  if (!sku) return undefined;
  return VM_TYPES.find((v) => v.sku.toLowerCase() === sku.toLowerCase());
}

export interface VmShape {
  provider: Provider;
  family: string;
  vcpu: number;
  memGiB: number;
  arch: "x86" | "arm";
  profile: VmType["profile"];
}

const AWS_SIZE: Record<string, number> = { nano: 2, micro: 2, small: 2, medium: 2, large: 2, xlarge: 4 };
const AWS_MEM_PER_VCPU: Record<string, number> = { m: 4, c: 2, r: 8, t: 4, x: 16, z: 8, i: 8, d: 8, h: 4, g: 4, p: 8 };

/**
 * Infer vCPU / memory / architecture from an instance-type name that is not in
 * the catalog (e.g. m6i.2xlarge, c7g.xlarge, Standard_D32as_v5, n2d-highmem-16).
 */
export function inferVmShape(sku: string): VmShape | undefined {
  const s = sku.trim();
  let m = /^([a-z]+)(\d+)([a-z-]*)\.(\d*)(xlarge|large|medium|small|micro|nano|metal(?:-\d+xl)?)$/i.exec(s);
  if (m) {
    const [, fam, , attrs, mult, size] = m;
    if (size.startsWith("metal")) return undefined;
    const vcpu = size === "xlarge" ? 4 * (mult ? Number(mult) : 1) : AWS_SIZE[size.toLowerCase()] ?? 2;
    const letter = fam[0].toLowerCase();
    const burst = letter === "t";
    const memPer = AWS_MEM_PER_VCPU[letter] ?? 4;
    return {
      provider: "aws",
      family: `${fam}${m[2]}${attrs}`.toLowerCase(),
      vcpu,
      memGiB: burst ? ({ nano: 0.5, micro: 1, small: 2, medium: 4, large: 8 }[size.toLowerCase()] ?? vcpu * 4) : vcpu * memPer,
      arch: /g/i.test(attrs) || fam.toLowerCase() === "a" ? "arm" : "x86",
      profile: burst ? "burstable" : letter === "c" ? "compute" : ["r", "x", "z"].includes(letter) ? "memory" : "general",
    };
  }
  m = /^standard_([a-z]+)(\d+)([a-z]*)(?:_v(\d+))?$/i.exec(s);
  if (m) {
    const [, fam, n, attrs] = m;
    const letter = fam[0].toUpperCase();
    const vcpu = Number(n);
    const memPer: Record<string, number> = { D: 4, E: 8, F: 2, B: 4, M: 28, L: 8 };
    return {
      provider: "azure",
      family: `${fam}${attrs}`.toUpperCase(),
      vcpu,
      memGiB: vcpu * (memPer[letter] ?? 4),
      arch: /p/i.test(attrs) ? "arm" : "x86",
      profile: letter === "F" ? "compute" : letter === "E" || letter === "M" ? "memory" : letter === "B" ? "burstable" : "general",
    };
  }
  m = /^([a-z]\d[a-z]?)-(standard|highcpu|highmem|megamem)-(\d+)$/i.exec(s);
  if (m) {
    const [, fam, kind, n] = m;
    const vcpu = Number(n);
    const f = fam.toLowerCase();
    const memPer = kind === "highcpu" ? (f.startsWith("c") ? 2 : 1) : kind === "highmem" ? 8 : kind === "megamem" ? 14 : 4;
    return {
      provider: "gcp",
      family: f,
      vcpu,
      memGiB: vcpu * memPer,
      arch: f === "t2a" || f === "c4a" ? "arm" : "x86",
      profile: kind === "highcpu" ? "compute" : kind === "highmem" || kind === "megamem" ? "memory" : "general",
    };
  }
  return undefined;
}

/**
 * Catalog lookup with a fallback for instance types outside the snapshot: the
 * shape is inferred from the name and priced at the per-vCPU rate of the
 * closest catalog types (same provider, profile and architecture).
 */
export function resolveVm(sku?: string | null): (VmType & { estimated?: boolean }) | undefined {
  const exact = findVm(sku);
  if (exact || !sku) return exact;
  const shape = inferVmShape(sku);
  if (!shape) return undefined;
  const peers = VM_TYPES.filter((v) => v.provider === shape.provider && v.profile === shape.profile && v.arch === shape.arch);
  const pool = peers.length ? peers : VM_TYPES.filter((v) => v.provider === shape.provider && v.profile === shape.profile);
  const fallback = pool.length ? pool : VM_TYPES.filter((v) => v.provider === shape.provider);
  const perVcpu = fallback.map((v) => v.hourly / v.vcpu).sort((a, b) => a - b)[Math.floor(fallback.length / 2)];
  return {
    sku,
    provider: shape.provider,
    family: shape.family,
    vcpu: shape.vcpu,
    memGiB: shape.memGiB,
    hourly: Math.round(perVcpu * shape.vcpu * 10000) / 10000,
    arch: shape.arch,
    profile: shape.profile,
    spotFactor: shape.provider === "gcp" ? 0.3 : 0.35,
    estimated: true,
  };
}

/** Cheapest VM on `provider` meeting the vCPU / memory floor (optionally same arch/profile). */
export function cheapestEquivalentVm(
  provider: Provider,
  vcpu: number,
  memGiB: number,
  opts: { allowArm?: boolean; profile?: VmType["profile"] } = {},
): VmType | undefined {
  return VM_TYPES.filter(
    (v) =>
      v.provider === provider &&
      v.vcpu >= vcpu &&
      v.memGiB >= memGiB &&
      v.profile !== "burstable" &&
      (opts.allowArm || v.arch === "x86"),
  ).sort((a, b) => a.hourly - b.hourly)[0];
}

/** Name of the instance type one size down (halved vCPU), following each provider's naming scheme. */
function halvedSkuName(sku: string): string | undefined {
  let m = /^([a-z]+\d+[a-z-]*)\.(\d*)xlarge$/i.exec(sku);
  if (m) {
    const n = m[2] ? Number(m[2]) : 1;
    return n === 1 ? `${m[1]}.large` : `${m[1]}.${n / 2 === 1 ? "" : n / 2}xlarge`;
  }
  m = /^(standard_[a-z]+)(\d+)([a-z]*(?:_v\d+)?)$/i.exec(sku);
  if (m && Number(m[2]) >= 4) return `${m[1]}${Number(m[2]) / 2}${m[3]}`;
  m = /^([a-z]\d[a-z]?-[a-z]+-)(\d+)$/i.exec(sku);
  if (m && Number(m[2]) >= 4) return `${m[1]}${Number(m[2]) / 2}`;
  return undefined;
}

/** Next size down in the same family (halve vCPU), if one exists. */
export function downsizeVm(sku: string): VmType | undefined {
  const cur = resolveVm(sku);
  if (!cur || cur.vcpu <= 2) return undefined;
  const inCatalog = VM_TYPES.filter((v) => v.provider === cur.provider && v.family === cur.family && v.vcpu === cur.vcpu / 2)[0];
  if (inCatalog) return inCatalog;
  const name = halvedSkuName(sku);
  return name ? resolveVm(name) : undefined;
}

/** Arm-based equivalent in the same size class (Graviton / Ampere / Axion). */
export function armEquivalent(sku: string): VmType | undefined {
  const cur = resolveVm(sku);
  if (!cur || cur.arch === "arm") return undefined;
  return VM_TYPES.filter(
    (v) =>
      v.provider === cur.provider &&
      v.arch === "arm" &&
      v.vcpu === cur.vcpu &&
      v.memGiB >= cur.memGiB &&
      v.profile === cur.profile,
  ).sort((a, b) => a.hourly - b.hourly)[0];
}

/* ------------------------------------------------------------------------- */
/* Managed-service unit prices                                               */
/* ------------------------------------------------------------------------- */

export const PRICES = {
  serverlessFunction: {
    aws: { perMillionRequests: 0.2, perGbSecond: 0.0000166667, name: "Lambda" },
    azure: { perMillionRequests: 0.2, perGbSecond: 0.000016, name: "Azure Functions" },
    gcp: { perMillionRequests: 0.4, perGbSecond: 0.0000165, name: "Cloud Run functions" },
  },
  containerServerless: {
    aws: { perVcpuHour: 0.04048, perGbHour: 0.004445, perMillionRequests: 0, spotFactor: 0.3, name: "Fargate" },
    azure: { perVcpuHour: 0.0864, perGbHour: 0.0108, perMillionRequests: 0.4, spotFactor: 1, name: "Container Apps" },
    gcp: { perVcpuHour: 0.0864, perGbHour: 0.009, perMillionRequests: 0.4, spotFactor: 1, name: "Cloud Run" },
  },
  apiGateway: {
    aws: { http: 1.0, rest: 3.5, name: "API Gateway" },
    azure: { http: 3.5, rest: 3.5, name: "API Management (Consumption)" },
    gcp: { http: 3.0, rest: 3.0, name: "API Gateway" },
  },
  queue: {
    aws: { perMillionRequests: 0.4, name: "SQS" },
    azure: { perMillionRequests: 0.4, name: "Storage Queues" },
    gcp: { perMillionRequests: 0.4, name: "Pub/Sub" },
  },
  loadBalancer: {
    aws: { hourly: 0.0225, perGb: 0.008, name: "Application Load Balancer" },
    azure: { hourly: 0.246, perGb: 0.008, name: "Application Gateway v2" },
    gcp: { hourly: 0.025, perGb: 0.008, name: "Cloud Load Balancing" },
  },
  natGateway: {
    aws: { hourly: 0.045, perGb: 0.045, name: "NAT Gateway" },
    azure: { hourly: 0.045, perGb: 0.045, name: "NAT Gateway" },
    gcp: { hourly: 0.044, perGb: 0.045, name: "Cloud NAT" },
  },
  egressInternet: { aws: 0.085, azure: 0.083, gcp: 0.085 } as Record<Provider, number>,
  egressInterRegion: { aws: 0.02, azure: 0.02, gcp: 0.02 } as Record<Provider, number>,
  cdn: {
    aws: { perGb: 0.085, perMillionRequests: 1.0, name: "CloudFront" },
    azure: { perGb: 0.081, perMillionRequests: 1.0, name: "Front Door" },
    gcp: { perGb: 0.08, perMillionRequests: 0.75, name: "Cloud CDN" },
  },
  objectStorage: {
    aws: { hot: 0.023, cool: 0.0125, cold: 0.004, archive: 0.00099, name: "S3" },
    azure: { hot: 0.0184, cool: 0.01, cold: 0.0036, archive: 0.00099, name: "Blob Storage" },
    gcp: { hot: 0.02, cool: 0.01, cold: 0.004, archive: 0.0012, name: "Cloud Storage" },
  },
  objectStorageTierLabel: {
    aws: { hot: "S3 Standard", cool: "S3 Standard-IA", cold: "S3 Glacier Instant Retrieval", archive: "S3 Glacier Deep Archive" },
    azure: { hot: "Hot", cool: "Cool", cold: "Cold", archive: "Archive" },
    gcp: { hot: "Standard", cool: "Nearline", cold: "Coldline", archive: "Archive" },
  },
  blockStorage: {
    aws: { premium: 0.1, standard: 0.08, name: "EBS" }, // gp2 vs gp3
    azure: { premium: 0.132, standard: 0.075, name: "Managed Disks" },
    gcp: { premium: 0.17, standard: 0.1, name: "Persistent Disk" },
  },
  snapshot: { aws: 0.05, azure: 0.05, gcp: 0.026 } as Record<Provider, number>,
  snapshotArchive: { aws: 0.0125, azure: 0.0125, gcp: 0.0026 } as Record<Provider, number>,
  publicIp: { aws: 3.65, azure: 2.63, gcp: 3.65 } as Record<Provider, number>,
  vpcInterfaceEndpoint: { hourly: 0.01, perGb: 0.01 },
  dbInstance: {
    // hourly, single-AZ, PostgreSQL
    "db.t4g.medium": 0.065,
    "db.m5.large": 0.171,
    "db.m6g.large": 0.152,
    "db.r5.xlarge": 0.5,
    "db.r5.2xlarge": 1.0,
    "db.r6g.xlarge": 0.451,
    "db.r6g.2xlarge": 0.901,
  } as Record<string, number>,
  dbServerless: {
    aws: { perCapacityHour: 0.12, unit: "ACU", name: "Aurora Serverless v2" },
    azure: { perCapacityHour: 0.522, unit: "vCore", name: "Azure SQL Serverless" },
    gcp: { perCapacityHour: 0.0413 + 4 * 0.007, unit: "vCPU", name: "Cloud SQL (autoscaled)" },
  },
  dbVcore: {
    azure: { perVcoreHour: 0.2497, name: "Azure SQL Database (General Purpose)" },
    gcp: { perVcoreHour: 0.0413 + 4 * 0.007, name: "Cloud SQL" },
    aws: { perVcoreHour: 0.125, name: "RDS" },
  },
  dbStoragePerGb: { aws: 0.115, azure: 0.115, gcp: 0.17 } as Record<Provider, number>,
  appPlatformPlan: {
    P1v3: 0.225,
    P2v3: 0.45,
    P3v3: 0.9,
    S1: 0.1,
  } as Record<string, number>,
  kubernetesControlPlane: { aws: 73, azure: 73, gcp: 73 } as Record<Provider, number>,
  warehousePerTb: { aws: 5.0, azure: 5.0, gcp: 6.25 } as Record<Provider, number>,
  logsPerGb: { aws: 0.5, azure: 2.3, gcp: 0.5 } as Record<Provider, number>,
  /** Managed Redis per GB-hour (≈ cache.r6g.xlarge $0.411/h ÷ 26 GB; Azure Premium; Memorystore Standard). */
  cachePerGbHour: { aws: 0.0158, azure: 0.019, gcp: 0.046 } as Record<Provider, number>,
  /** Commitment discounts vs on-demand for steady compute. */
  commitment: {
    aws: { "1y": 0.28, "3y": 0.5, name: "Compute Savings Plan" },
    azure: { "1y": 0.36, "3y": 0.58, name: "Reserved VM Instances" },
    gcp: { "1y": 0.37, "3y": 0.55, name: "Committed Use Discounts" },
  },
};

/** Loaded engineering rate used to estimate one-time migration cost. */
export const ENGINEER_WEEK_COST = 4_000;
