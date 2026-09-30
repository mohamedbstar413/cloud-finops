import type { ResourceConfig, ResourceMetrics } from "../engine/types";
import type { Provider } from "../pricing/catalog";
import type { ComponentKind } from "../pricing/components";
import type { Series } from "../usage/series";

export interface AwsCredentials {
  roleArn: string;
  externalId: string;
  regions?: string[];
}

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

export interface GcpCredentials {
  projectId: string;
  /** Service-account key JSON (or omit to use Workload Identity Federation / ADC). */
  serviceAccountKey?: string;
  /** Fully-qualified billing export table, e.g. billing-proj.billing.gcp_billing_export_v1_XXXX */
  billingTable?: string;
}

export type ProviderCredentials = AwsCredentials | AzureCredentials | GcpCredentials;

export interface NormalizedResource {
  externalId: string;
  name: string;
  kind: ComponentKind;
  service: string;
  sku?: string;
  region: string;
  workload?: string;
  environment?: string;
  state: string;
  quantity: number;
  monthlyCost: number;
  metrics: ResourceMetrics;
  config: ResourceConfig;
  tags: string[];
  /** Usage history (hourly / daily). Summary metrics are derived from it when present. */
  series?: Series[];
}

export interface NormalizedCost {
  date: string; // YYYY-MM-DD
  service: string;
  category: string;
  region: string;
  workload?: string;
  cost: number;
}

export interface Snapshot {
  resources: NormalizedResource[];
  costs: NormalizedCost[];
  /** Data that could not be collected (e.g. a metric namespace the role may not read). The sync still succeeds. */
  warnings?: string[];
}

export interface ValidationResult {
  ok: boolean;
  message: string;
  identity?: string;
}

export interface Connector<C> {
  provider: Provider;
  validate(creds: C): Promise<ValidationResult>;
  collect(creds: C, opts: { days: number }): Promise<Snapshot>;
}

/** Map a provider-native service name to a normalized cost category. */
export function categorize(service: string): string {
  const s = service.toLowerCase();
  if (/(ec2|compute|virtual machine|lambda|functions|app service|kubernetes|eks|aks|gke|fargate|container|cloud run)/.test(s)) return "compute";
  if (/(s3|storage|blob|disk|ebs|snapshot|glacier|filestore|backup)/.test(s)) return "storage";
  if (/(rds|sql|database|aurora|dynamo|cosmos|spanner|firestore|redis|cache|memorystore)/.test(s)) return "database";
  if (/(data transfer|bandwidth|egress|network|nat|load balanc|cloudfront|cdn|front door|vpc|dns|route)/.test(s)) return "network";
  if (/(bigquery|athena|redshift|synapse|analytics|dataflow|emr|glue)/.test(s)) return "analytics";
  if (/(cloudwatch|log|monitor|insights)/.test(s)) return "observability";
  return "other";
}

/** Map the many spellings of an environment tag onto the ones the engine knows: prod, staging, dev, test. */
export function normalizeEnvironment(value: string | undefined | null): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (/^(prod|production|prd|live)$/.test(v)) return "prod";
  if (/^(stag|staging|stage|stg|preprod|pre-prod|uat)$/.test(v)) return "staging";
  if (/^(dev|development|sandbox)$/.test(v)) return "dev";
  if (/^(test|testing|qa|ci)$/.test(v)) return "test";
  return v;
}
