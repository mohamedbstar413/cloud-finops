import { GoogleAuth } from "google-auth-library";
import { priceComponent } from "../pricing/components";
import { categorize, type Connector, type GcpCredentials, type NormalizedCost, type NormalizedResource } from "./types";

function auth(c: GcpCredentials) {
  return new GoogleAuth({
    credentials: c.serviceAccountKey ? JSON.parse(c.serviceAccountKey) : undefined,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
}

async function call<T>(c: GcpCredentials, url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const client = await auth(c).getClient();
  const res = await client.request<T>({ url, method: (init?.method as "GET" | "POST") ?? "GET", data: init?.body });
  return res.data;
}

interface Instance {
  id: string;
  name: string;
  machineType: string;
  status: string;
  zone: string;
  labels?: Record<string, string>;
  scheduling?: { provisioningModel?: string };
}

export const gcpConnector: Connector<GcpCredentials> = {
  provider: "gcp",

  async validate(c) {
    try {
      const p = await call<{ projectId: string; name: string }>(c, `https://cloudresourcemanager.googleapis.com/v1/projects/${c.projectId}`);
      return { ok: true, message: "Service account authenticated", identity: `${p.name} (${p.projectId})` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async collect(c, { days }) {
    const costs: NormalizedCost[] = [];
    if (c.billingTable) {
      const query = `
        SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS d,
               service.description AS s,
               IFNULL(location.region, 'global') AS r,
               (SELECT value FROM UNNEST(labels) WHERE key = 'app') AS w,
               SUM(cost) + SUM(IFNULL((SELECT SUM(x.amount) FROM UNNEST(credits) x), 0)) AS cost
        FROM \`${c.billingTable}\`
        WHERE project.id = @project
          AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY)
        GROUP BY 1, 2, 3, 4`;
      const res = await call<{ rows?: { f: { v: string | null }[] }[] }>(c, `https://bigquery.googleapis.com/bigquery/v2/projects/${c.projectId}/queries`, {
        method: "POST",
        body: {
          query,
          useLegacySql: false,
          parameterMode: "NAMED",
          queryParameters: [{ name: "project", parameterType: { type: "STRING" }, parameterValue: { value: c.projectId } }],
          timeoutMs: 60_000,
        },
      });
      for (const row of res.rows ?? []) {
        const [d, s, r, w, cost] = row.f.map((x) => x.v);
        costs.push({ date: d!, service: s ?? "Other", category: categorize(s ?? ""), region: r ?? "global", workload: w ?? undefined, cost: Number(cost) });
      }
    }

    const resources: NormalizedResource[] = [];
    const agg = await call<{ items?: Record<string, { instances?: Instance[] }> }>(c, `https://compute.googleapis.com/compute/v1/projects/${c.projectId}/aggregated/instances`);
    for (const zone of Object.values(agg.items ?? {})) {
      for (const i of zone.instances ?? []) {
        const sku = i.machineType.split("/").pop()!;
        const region = i.zone.split("/").pop()!.replace(/-[a-z]$/, "");
        const spot = i.scheduling?.provisioningModel === "SPOT";
        resources.push({
          externalId: i.id,
          name: i.name,
          kind: "compute.vm",
          service: "Compute Engine",
          sku,
          region,
          workload: i.labels?.app,
          environment: i.labels?.env,
          state: i.status === "RUNNING" ? "running" : "stopped",
          quantity: 1,
          monthlyCost: i.status === "RUNNING" ? priceComponent({ id: i.id, kind: "compute.vm", provider: "gcp", label: sku, sku, region, usage: { spot } }).monthlyCost : 0,
          metrics: {},
          config: { interruptible: spot },
          tags: Object.entries(i.labels ?? {}).map(([k, v]) => `${k}=${v}`),
        });
      }
    }
    return { resources, costs };
  },
};

export function gcpSetupScript(projectId: string) {
  const p = projectId || "<project-id>";
  return `gcloud iam service-accounts create cloud-price-optimizer --project ${p}

for ROLE in roles/viewer roles/billing.viewer roles/bigquery.dataViewer roles/bigquery.jobUser roles/monitoring.viewer; do
  gcloud projects add-iam-policy-binding ${p} \\
    --member "serviceAccount:cloud-price-optimizer@${p}.iam.gserviceaccount.com" \\
    --role "$ROLE"
done

# Enable Cloud Billing export to BigQuery (Billing → Billing export → Detailed usage cost)
gcloud iam service-accounts keys create key.json \\
  --iam-account cloud-price-optimizer@${p}.iam.gserviceaccount.com`;
}
