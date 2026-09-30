import type { Provider } from "../pricing/catalog";
import type { IconKey, PricedComponent } from "../pricing/components";
import type { UsageProfile } from "../usage/series";

export type Category =
  | "architecture"
  | "cross_cloud"
  | "rightsizing"
  | "idle"
  | "commitment"
  | "storage"
  | "scheduling"
  | "anomaly";

export type Level = "low" | "medium" | "high";

export interface ResourceMetrics {
  cpuAvg?: number;
  cpuP95?: number;
  cpuMax?: number;
  memP95?: number;
  /** Fraction of hours with meaningful load (0–1). */
  dutyCycle?: number;
  /** Peak-to-average traffic ratio. */
  peakToAvg?: number;
  requestsPerMonthM?: number;
  avgDurationMs?: number;
  gbProcessed?: number;
  gbEgress?: number;
  connectionsP95?: number;
  /** 24 values: average utilisation by hour of day (0–100). */
  hourly?: number[];
  /** Storage access profile: share of bytes not read in 30 / 90 days. */
  coldShare30?: number;
  coldShare90?: number;
  objectCount?: number;
  daysSinceAttach?: number;
  ageDays?: number;
}

export interface ResourceConfig {
  sizeGb?: number;
  tier?: string;
  volumeType?: string;
  multiAz?: boolean;
  vcores?: number;
  attached?: boolean;
  stateless?: boolean;
  containerized?: boolean;
  interruptible?: boolean;
  portable?: boolean;
  armCompatible?: boolean;
  role?: string;
  memoryMb?: number;
  /** Share of requests that trigger background work. */
  asyncShare?: number;
  /** Share of Kubernetes pods that are stateless / interruption tolerant. */
  statelessShare?: number;
  /** Data this workload reads from other clouds/regions (drives egress in arbitrage). */
  dataSources?: { provider: Provider; region: string; gbPerMonth: number; label: string }[];
  /** Data written back to other clouds. */
  dataSinks?: { provider: Provider; region: string; gbPerMonth: number; label: string }[];
  s3TrafficShare?: number;
  lifecyclePolicy?: boolean;
  staticContent?: boolean;
  dataResidency?: string;
}

export interface ResourceRow {
  id: string;
  accountId: string;
  provider: Provider;
  externalId: string;
  name: string;
  kind: string;
  service: string;
  sku: string | null;
  region: string;
  workload: string | null;
  environment: string | null;
  state: string;
  quantity: number;
  monthlyCost: number;
  metrics: ResourceMetrics;
  config: ResourceConfig;
  tags: string[];
  dependsOn: string[];
  /** Usage history profile (trend, weekly pattern, peaks). Absent when only summary metrics exist. */
  usage?: UsageProfile;
}

/** Why the engine held back on a resource instead of guessing. */
export interface DataGap {
  resourceId: string;
  resource: string;
  detector: string;
  /** missing_metric | short_history | growing | in_use | over_limit */
  kind: "missing_metric" | "short_history" | "growing" | "in_use";
  reason: string;
  /** What the customer can do to unlock the evaluation. */
  fix?: string;
  /** Monthly cost of the resource that could not be evaluated. */
  monthlyCost: number;
}

export interface AccountRow {
  id: string;
  provider: Provider;
  name: string;
  externalId: string;
  region: string;
}

export interface DailyCost {
  date: string; // YYYY-MM-DD
  accountId: string;
  provider: Provider;
  service: string;
  category: string;
  region: string;
  workload: string | null;
  cost: number;
}

export interface Estate {
  orgId: string;
  accounts: AccountRow[];
  resources: ResourceRow[];
  daily: DailyCost[];
  /** Filled by detectors while they run (see runEngineWithCoverage). */
  gaps?: DataGap[];
}

/** A usage chart shown as evidence on a recommendation. */
export interface UsageChart {
  id: string;
  title: string;
  unit: "percent" | "count" | "gb" | "bytes" | "ms" | "iops";
  /** Daily points: p95 (or daily total for additive metrics). */
  points: { d: string; v: number }[];
  /** Horizontal reference lines, e.g. the projected peak after the change. */
  lines?: { label: string; value: number; tone: "limit" | "projected" | "baseline" }[];
  trendPerMonth?: number;
  note?: string;
}

export interface UsageEvidence {
  /** Days of history the recommendation is based on. */
  days: number;
  /** Metrics that were available (e.g. CPU, memory, network). */
  metrics: string[];
  /** Metrics that were not available and what was assumed instead. */
  missing?: string[];
  charts: UsageChart[];
  /** Hour-of-week values (168, Monday 00:00 UTC first): utilisation in percent unless `unit` says otherwise, with the hours judged idle. */
  heatmap?: { title: string; values: number[]; unit?: string; idle?: boolean[]; schedule?: string };
}

export interface DiagramNode {
  id: string;
  label: string;
  sublabel?: string;
  icon: IconKey;
  layer: number;
  count?: number;
  provider?: Provider;
  region?: string;
  highlight?: "removed" | "added" | "changed";
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface ArchitectureSpec {
  title: string;
  provider: Provider;
  monthlyCost: number;
  components: PricedComponent[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  bullets: string[];
}

export interface ComparisonRow {
  metric: string;
  current: string;
  proposed: string;
  change: "better" | "worse" | "same" | "neutral";
  note?: string;
}

export interface ImplementationPhase {
  phase: string;
  weeks: string;
  tasks: string[];
}

export interface Alternative {
  label: string;
  provider: Provider;
  monthlyCost: number;
  savingsPct: number;
  note: string;
  chosen?: boolean;
}

export interface RecommendationDetails {
  explanation: string;
  evidence: { label: string; value: string }[];
  benefits: string[];
  risks: string[];
  current?: ArchitectureSpec;
  proposed?: ArchitectureSpec;
  comparison?: ComparisonRow[];
  implementation: ImplementationPhase[];
  terraform?: string;
  alternatives?: Alternative[];
  /** Weeks until savings start and weeks until fully realised (drives projections). */
  rollout: { startWeek: number; fullWeek: number };
  fitScore?: number;
  assumptions?: string[];
  /** Usage history behind the recommendation. */
  usage?: UsageEvidence;
}

export interface RecommendationDraft {
  fingerprint: string;
  detector: string;
  category: Category;
  provider: Provider;
  targetProvider?: Provider;
  accountId?: string;
  title: string;
  summary: string;
  currentMonthlyCost: number;
  projectedMonthlyCost: number;
  monthlySavings: number;
  savingsPct: number;
  migrationCost: number;
  effort: Level;
  risk: Level;
  timeline: string;
  confidence: number;
  resourceIds: string[];
  details: RecommendationDetails;
  impact?: Level;
  overlapsWith?: string;
  source?: "engine" | "ai";
}

export type Detector = (estate: Estate) => RecommendationDraft[];
