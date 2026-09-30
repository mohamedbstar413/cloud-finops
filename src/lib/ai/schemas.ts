import { VM_TYPES, PRICES } from "../pricing/catalog";
import { COMPONENT_KINDS } from "../pricing/components";
import { arr, bool, enumOf, nullable, num, obj, str } from "./client";

const nullableEnum = (values: readonly string[]) => ({ type: ["string", "null"], enum: [...values, null] });

export const TIERS = ["hot", "cool", "cold", "archive", "premium", "standard", "http", "rest", "gateway", "interface"] as const;

export const componentSchema = obj({
  kind: enumOf(COMPONENT_KINDS, "Provider-agnostic component kind"),
  provider: enumOf(["aws", "azure", "gcp"]),
  label: str("Human-readable name, e.g. 'Lambda — API handlers'"),
  sku: nullable(str("compute.vm: an instance type from the allowed list; db.instance: DB class; app.plan: plan SKU; otherwise null")),
  region: nullable(str()),
  usage: obj({
    count: nullable(num("Instances / replicas / gateways")),
    hours: nullable(num("Hours per month, default 730")),
    spot: nullable(bool()),
    requestsM: nullable(num("Millions of requests per month")),
    avgDurationMs: nullable(num()),
    memoryMb: nullable(num()),
    vcpu: nullable(num("compute.container vCPU per replica")),
    memGb: nullable(num("compute.container / cache memory GB")),
    activeHours: nullable(num("Billable active hours per month (containers, serverless DB)")),
    gb: nullable(num("GB stored, transferred, processed, ingested or scanned")),
    tier: nullableEnum(TIERS),
    multiAz: nullable(bool()),
    storageGb: nullable(num()),
    capacityUnits: nullable(num("db.serverless average ACU / vCores billed")),
    vcores: nullable(num()),
    monthlyCost: nullable(num("only for other.fixed")),
    destination: nullableEnum(["internet", "inter_region", "inter_cloud"]),
  }),
});

export const LEVEL = ["low", "medium", "high"] as const;

export const proposalSchema = obj({
  title: str("Imperative title, e.g. 'Replace EC2 + ALB with API Gateway + Lambda + SQS'"),
  strategy: enumOf(["serverless", "containers", "spot", "cross_cloud", "managed_service", "storage_tiering", "data_locality", "caching", "commitment", "hybrid"]),
  targetProvider: enumOf(["aws", "azure", "gcp"]),
  rationale: str("2–4 sentences grounded in the metrics provided"),
  components: arr(componentSchema, "The COMPLETE proposed architecture for the replaced part"),
  benefits: arr(str()),
  risks: arr(str()),
  effort: enumOf(LEVEL),
  risk: enumOf(LEVEL),
  timelineWeeks: num(),
  migrationEngineerWeeks: num(),
});

export const discoverySchema = obj({
  proposals: arr(
    obj({
      workload: str("Workload name exactly as given"),
      replacesResourceIds: arr(str(), "Ids of the current resources this proposal replaces"),
      signals: arr(obj({ label: str(), value: str() }), "Metrics that justify the proposal"),
      proposal: proposalSchema,
    }),
  ),
});

export const enrichmentSchema = obj({
  headline: str(),
  narrative: str("2–3 short paragraphs, plain language, for an engineering manager"),
  whyNow: str(),
  risks: arr(obj({ risk: str(), likelihood: enumOf(LEVEL), mitigation: str() })),
  migrationPlan: arr(obj({ phase: str(), weeks: str(), tasks: arr(str()) })),
  validationChecks: arr(str(), "Metrics/tests that prove success"),
  rollbackPlan: str(),
  terraform: str("Terraform HCL sketch for the target architecture"),
  questionsForTeam: arr(str()),
  savingsCaveats: arr(str()),
});

export const TRANSFORMS = [
  "serverless",
  "containers",
  "spot",
  "cross_cloud_cheapest",
  "commitments",
  "schedule_nonprod",
  "rightsizing",
  "arm",
  "storage_tiering",
  "remove_idle",
  "cheapest_region",
] as const;

export const whatIfPlanSchema = obj({
  interpretation: str("One sentence restating the question as a scenario"),
  transforms: arr(
    obj({
      type: enumOf(TRANSFORMS),
      providers: arr(enumOf(["aws", "azure", "gcp"]), "Empty = all providers"),
      workloads: arr(str(), "Empty = all workloads"),
      environments: arr(str(), "Empty = all environments"),
      commitmentTerm: nullableEnum(["1y", "3y"]),
    }),
  ),
  assumptions: arr(str()),
});

export const narrativeSchema = obj({
  headline: str(),
  summary: str(),
  keyPoints: arr(str()),
  caveats: arr(str()),
  nextSteps: arr(str()),
});

export const customAnalysisSchema = obj({
  interpretedCurrent: arr(componentSchema, "The customer's CURRENT architecture as priced components (all of it)"),
  profile: obj({
    trafficPattern: enumOf(["steady", "spiky", "business_hours", "batch", "unknown"]),
    stateless: bool(),
    interruptible: bool(),
    latencySensitive: bool(),
    requestsPerMonthM: nullable(num()),
  }),
  proposals: arr(proposalSchema, "2–3 alternative architectures, cheapest-credible first"),
});

export const ALLOWED_SKUS = {
  vm: VM_TYPES.map((v) => `${v.provider}:${v.sku} (${v.vcpu} vCPU, ${v.memGiB} GiB, $${v.hourly}/h)`).join("; "),
  db: Object.keys(PRICES.dbInstance).join(", "),
  app: Object.keys(PRICES.appPlatformPlan).join(", "),
};
