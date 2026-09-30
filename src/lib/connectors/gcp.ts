import { GoogleAuth } from "google-auth-library";
import { priceComponent } from "../pricing/components";
import type { Series } from "../usage/series";
import { categorize, normalizeEnvironment, type Connector, type GcpCredentials, type NormalizedCost, type NormalizedResource } from "./types";
import { attempt, collectionWindow, combine, DAILY_DAYS, HOURLY_DAYS, latest, toSeries, withUsage, type CollectionWindow, type Point } from "./usage";

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

/* ------------------------------------------------------------------------- */
/* Cloud Monitoring                                                           */
/* ------------------------------------------------------------------------- */

export interface GcpTimeSeriesResponse {
  timeSeries?: {
    resource?: { labels?: Record<string, string> };
    metric?: { labels?: Record<string, string> };
    points?: { interval: { startTime?: string; endTime: string }; value: { doubleValue?: number; int64Value?: string } }[];
  }[];
  nextPageToken?: string;
}

/**
 * Points per resource out of a Cloud Monitoring response, keyed by a resource
 * label (instance_id, bucket_name). Aligned points are stamped with the END of
 * their period; they are moved to its start to match the collection grid.
 */
export function gcpPoints(res: GcpTimeSeriesResponse, label: string, periodMs: number, into: Map<string, Point[]> = new Map()): Map<string, Point[]> {
  for (const ts of res.timeSeries ?? []) {
    const key = ts.resource?.labels?.[label];
    if (!key) continue;
    const pts = into.get(key) ?? [];
    for (const p of ts.points ?? []) {
      const v = p.value.doubleValue ?? (p.value.int64Value !== undefined ? Number(p.value.int64Value) : NaN);
      if (Number.isFinite(v)) pts.push({ t: Date.parse(p.interval.endTime) - periodMs, v });
    }
    into.set(key, pts);
  }
  return into;
}

interface MetricQuery {
  type: string;
  /** Extra filter, e.g. metric.labels.state = "used". */
  where?: string;
  aligner: "ALIGN_MEAN" | "ALIGN_MAX" | "ALIGN_DELTA";
  /** How the raw series of one resource are merged. Defaults to mean / max / sum, following the aligner. */
  reducer?: "REDUCE_MEAN" | "REDUCE_MAX" | "REDUCE_SUM";
  /** Resource label to group by. */
  label: string;
}

async function fetchGcpMetric(c: GcpCredentials, q: MetricQuery, w: CollectionWindow): Promise<Map<string, Point[]>> {
  const out = new Map<string, Point[]>();
  const periodMs = w.stepMinutes * 60_000;
  let pageToken: string | undefined;
  do {
    const params: [string, string][] = [
      ["filter", `metric.type = "${q.type}"${q.where ? ` AND ${q.where}` : ""}`],
      ["interval.startTime", w.start.toISOString()],
      ["interval.endTime", w.end.toISOString()],
      ["aggregation.alignmentPeriod", `${w.stepMinutes * 60}s`],
      ["aggregation.perSeriesAligner", q.aligner],
      ["aggregation.crossSeriesReducer", q.reducer ?? (q.aligner === "ALIGN_MAX" ? "REDUCE_MAX" : q.aligner === "ALIGN_MEAN" ? "REDUCE_MEAN" : "REDUCE_SUM")],
      ["aggregation.groupByFields", `resource.label.${q.label}`],
      ["pageSize", "50000"],
    ];
    if (pageToken) params.push(["pageToken", pageToken]);
    const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const page = await call<GcpTimeSeriesResponse>(c, `https://monitoring.googleapis.com/v3/projects/${c.projectId}/timeSeries?${qs}`);
    gcpPoints(page, q.label, periodMs, out);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

interface Instance {
  id: string;
  name: string;
  machineType: string;
  status: string;
  zone: string;
  labels?: Record<string, string>;
  scheduling?: { provisioningModel?: string };
  metadata?: { items?: { key: string; value: string }[] };
}

interface Disk {
  id: string;
  name: string;
  zone?: string;
  sizeGb: string;
  type: string;
  users?: string[];
  labels?: Record<string, string>;
}

interface Bucket {
  name: string;
  location: string;
  storageClass?: string;
  labels?: Record<string, string>;
  lifecycle?: { rule?: unknown[] };
  autoclass?: { enabled?: boolean };
}

const regionOf = (zone: string) => zone.split("/").pop()!.replace(/-[a-z]$/, "");
/** The managed instance group that created an instance, if any. */
const groupOf = (i: Instance) => i.metadata?.items?.find((m) => m.key === "created-by")?.value.match(/instanceGroupManagers\/([^/]+)$/)?.[1];

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

    const warnings: string[] = [];
    const resources: NormalizedResource[] = [];
    const hourly = collectionWindow(HOURLY_DAYS);
    const daily = collectionWindow(DAILY_DAYS, 1440);
    const none = new Map<string, Point[]>();
    // One query per metric returns every resource in the project; a failure is a warning, not a failed sync.
    const metric = (what: string, q: MetricQuery, w: CollectionWindow) => attempt(warnings, `Cloud Monitoring: ${what}`, none, () => fetchGcpMetric(c, q, w));

    /* ---- Compute Engine: managed instance groups as fleets, other instances one by one ---- */
    await attempt(warnings, "Compute Engine instances", undefined, async () => {
      const instances: Instance[] = [];
      let pageToken: string | undefined;
      do {
        const agg: { items?: Record<string, { instances?: Instance[] }>; nextPageToken?: string } = await call(c, `https://compute.googleapis.com/compute/v1/projects/${c.projectId}/aggregated/instances${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`);
        for (const zone of Object.values(agg.items ?? {})) instances.push(...(zone.instances ?? []));
        pageToken = agg.nextPageToken;
      } while (pageToken);

      const [cpu, cpuMax, mem, sent, received] = await Promise.all([
        metric("CPU utilisation", { type: "compute.googleapis.com/instance/cpu/utilization", aligner: "ALIGN_MEAN", label: "instance_id" }, hourly),
        metric("CPU peaks", { type: "compute.googleapis.com/instance/cpu/utilization", aligner: "ALIGN_MAX", label: "instance_id" }, hourly),
        // Memory is only published by the Ops Agent; without it there is simply no series.
        metric("memory (Ops Agent)", { type: "agent.googleapis.com/memory/percent_used", where: 'metric.labels.state = "used"', aligner: "ALIGN_MEAN", label: "instance_id" }, hourly),
        metric("network sent", { type: "compute.googleapis.com/instance/network/sent_bytes_count", aligner: "ALIGN_DELTA", label: "instance_id" }, hourly),
        metric("network received", { type: "compute.googleapis.com/instance/network/received_bytes_count", aligner: "ALIGN_DELTA", label: "instance_id" }, hourly),
      ]);
      const seriesOf = (i: Instance) => ({
        cpu: toSeries("cpu", "avg", "percent", hourly, cpu.get(i.id), (v) => v * 100), // reported as a fraction
        cpuMax: toSeries("cpu_max", "max", "percent", hourly, cpuMax.get(i.id), (v) => v * 100),
        mem: toSeries("mem", "avg", "percent", hourly, mem.get(i.id)),
        netIn: toSeries("net_in", "sum", "bytes", hourly, received.get(i.id)),
        netOut: toSeries("net_out", "sum", "bytes", hourly, sent.get(i.id)),
      });
      const price = (i: Instance) => {
        const sku = i.machineType.split("/").pop()!;
        return priceComponent({ id: i.id, kind: "compute.vm", provider: "gcp", label: sku, sku, region: regionOf(i.zone), usage: { spot: i.scheduling?.provisioningModel === "SPOT" } }).monthlyCost;
      };

      const running = instances.filter((i) => i.status === "RUNNING");
      const fleets = new Map<string, Instance[]>();
      const single: Instance[] = [];
      for (const i of running) {
        const group = groupOf(i);
        if (group) fleets.set(group, [...(fleets.get(group) ?? []), i]);
        else single.push(i);
      }

      for (const [name, members] of fleets) {
        // The fleet's history is built from its current members: instances that were replaced since are
        // not in it, so an autoscaled group can show less history (and a lower floor) than it really has.
        const parts = members.map(seriesOf);
        const pick = (k: keyof ReturnType<typeof seriesOf>) => parts.map((p) => p[k]);
        const first = members[0];
        const sku = first.machineType.split("/").pop()!;
        const spot = members.every((i) => i.scheduling?.provisioningModel === "SPOT");
        const series: (Series | null)[] = [
          combine("cpu", "avg", "percent", pick("cpu"), "avg"),
          combine("cpu_max", "max", "percent", pick("cpuMax"), "max"),
          combine("mem", "avg", "percent", pick("mem"), "avg"),
          combine("net_in", "sum", "bytes", pick("netIn"), "sum"),
          combine("net_out", "sum", "bytes", pick("netOut"), "sum"),
          combine("instances", "avg", "count", pick("cpu"), "count"),
        ];
        resources.push({
          externalId: `mig/${name}`,
          name,
          kind: "compute.vm",
          service: first.labels?.["goog-k8s-cluster-name"] ? "GKE node pool" : "Compute Engine (managed group)",
          sku,
          region: regionOf(first.zone),
          workload: first.labels?.app ?? first.labels?.workload,
          environment: normalizeEnvironment(first.labels?.env ?? first.labels?.environment),
          state: "running",
          quantity: members.length,
          monthlyCost: members.reduce((sum, i) => sum + price(i), 0),
          config: { interruptible: spot, ...(first.labels?.["goog-k8s-cluster-name"] ? { role: "k8s-node" } : {}) },
          tags: Object.entries(first.labels ?? {}).map(([k, v]) => `${k}=${v}`),
          ...withUsage({}, series),
        });
      }

      for (const i of instances) {
        const isRunning = i.status === "RUNNING";
        if (isRunning && groupOf(i)) continue;
        const spot = i.scheduling?.provisioningModel === "SPOT";
        const s = isRunning ? seriesOf(i) : null;
        resources.push({
          externalId: i.id,
          name: i.name,
          kind: "compute.vm",
          service: "Compute Engine",
          sku: i.machineType.split("/").pop()!,
          region: regionOf(i.zone),
          workload: i.labels?.app ?? i.labels?.workload,
          environment: normalizeEnvironment(i.labels?.env ?? i.labels?.environment),
          state: isRunning ? "running" : "stopped",
          quantity: 1,
          monthlyCost: isRunning ? price(i) : 0,
          config: { interruptible: spot },
          tags: Object.entries(i.labels ?? {}).map(([k, v]) => `${k}=${v}`),
          ...withUsage({}, s ? [s.cpu, s.cpuMax, s.mem, s.netIn, s.netOut] : []),
        });
      }
    });

    /* ---- Persistent disks (unattached ones are idle spend) ---- */
    await attempt(warnings, "Persistent disks", undefined, async () => {
      let pageToken: string | undefined;
      do {
        const agg: { items?: Record<string, { disks?: Disk[] }>; nextPageToken?: string } = await call(c, `https://compute.googleapis.com/compute/v1/projects/${c.projectId}/aggregated/disks${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`);
        for (const scope of Object.values(agg.items ?? {})) {
          for (const d of scope.disks ?? []) {
            const gb = Number(d.sizeGb);
            const premium = /pd-ssd|hyperdisk|pd-extreme/.test(d.type);
            resources.push({
              externalId: d.id,
              name: d.name,
              kind: "storage.block",
              service: "Persistent Disk",
              region: d.zone ? regionOf(d.zone) : "global",
              workload: d.labels?.app ?? d.labels?.workload,
              environment: normalizeEnvironment(d.labels?.env ?? d.labels?.environment),
              state: d.users?.length ? "in-use" : "available",
              quantity: 1,
              monthlyCost: priceComponent({ id: d.id, kind: "storage.block", provider: "gcp", label: d.name, usage: { gb, tier: premium ? "premium" : "standard" } }).monthlyCost,
              metrics: {},
              config: { sizeGb: gb, attached: Boolean(d.users?.length) },
              tags: Object.entries(d.labels ?? {}).map(([k, v]) => `${k}=${v}`),
            });
          }
        }
        pageToken = agg.nextPageToken;
      } while (pageToken);
    });

    /* ---- Cloud Storage: size and reads, day by day ---- */
    await attempt(warnings, "Cloud Storage buckets", undefined, async () => {
      const buckets: Bucket[] = [];
      let pageToken: string | undefined;
      do {
        const page: { items?: Bucket[]; nextPageToken?: string } = await call(c, `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(c.projectId)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
        buckets.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      if (!buckets.length) return;

      const [size, sent] = await Promise.all([
        // Size is reported per storage class: the classes of a bucket are summed, not averaged.
        metric("bucket size", { type: "storage.googleapis.com/storage/total_bytes", aligner: "ALIGN_MEAN", reducer: "REDUCE_SUM", label: "bucket_name" }, daily),
        metric("bucket reads", { type: "storage.googleapis.com/network/sent_bytes_count", aligner: "ALIGN_DELTA", label: "bucket_name" }, daily),
      ]);
      for (const b of buckets) {
        const stored = toSeries("stored_gb", "avg", "gb", daily, size.get(b.name), (bytes) => bytes / 1e9);
        const gb = latest(stored);
        if (!gb) continue;
        const cls = (b.storageClass ?? "STANDARD").toUpperCase();
        const tier = cls === "NEARLINE" ? "cool" : cls === "COLDLINE" || cls === "ARCHIVE" ? "cold" : "hot";
        resources.push({
          externalId: `gs://${b.name}`,
          name: b.name,
          kind: "storage.object",
          service: "Cloud Storage",
          region: b.location.toLowerCase(),
          workload: b.labels?.app ?? b.labels?.workload,
          environment: normalizeEnvironment(b.labels?.env ?? b.labels?.environment),
          state: "running",
          quantity: 1,
          monthlyCost: priceComponent({ id: b.name, kind: "storage.object", provider: "gcp", label: b.name, usage: { gb, tier } }).monthlyCost,
          // How much of the data is cold is not available here: the engine reports a gap for large hot
          // buckets without a lifecycle policy (or Autoclass) instead of guessing.
          config: { sizeGb: Math.round(gb), tier, lifecyclePolicy: Boolean(b.lifecycle?.rule?.length) || Boolean(b.autoclass?.enabled) },
          tags: Object.entries(b.labels ?? {}).map(([k, v]) => `${k}=${v}`),
          ...withUsage({}, [stored, toSeries("read_gb", "sum", "gb", daily, sent.get(b.name), (bytes) => bytes / 1e9)]),
        });
      }
    });

    return { resources, costs, warnings };
  },
};

export function gcpSetupScript(projectId: string) {
  const p = projectId || "<project-id>";
  return `gcloud iam service-accounts create cloud-price-optimizer --project ${p}

# roles/monitoring.viewer gives read access to utilisation and traffic history (CPU, memory, network, storage)
for ROLE in roles/viewer roles/billing.viewer roles/bigquery.dataViewer roles/bigquery.jobUser roles/monitoring.viewer; do
  gcloud projects add-iam-policy-binding ${p} \\
    --member "serviceAccount:cloud-price-optimizer@${p}.iam.gserviceaccount.com" \\
    --role "$ROLE"
done

# Enable Cloud Billing export to BigQuery (Billing → Billing export → Detailed usage cost)
gcloud iam service-accounts keys create key.json \\
  --iam-account cloud-price-optimizer@${p}.iam.gserviceaccount.com`;
}
