import { ClientSecretCredential } from "@azure/identity";
import { resolveVm } from "../pricing/catalog";
import { priceComponent } from "../pricing/components";
import type { Series } from "../usage/series";
import { categorize, normalizeEnvironment, type AzureCredentials, type Connector, type NormalizedCost, type NormalizedResource } from "./types";
import { attempt, collectionWindow, HOURLY_DAYS, latest, mapSeries, toSeries, withUsage, type CollectionWindow, type Point } from "./usage";

const ARM = "https://management.azure.com";

async function token(c: AzureCredentials) {
  const cred = new ClientSecretCredential(c.tenantId, c.clientId, c.clientSecret);
  const t = await cred.getToken(`${ARM}/.default`);
  return t.token;
}

async function arm<T>(tok: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${ARM}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Azure ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

interface ArmList<T> {
  value: T[];
  nextLink?: string;
}

/** Follow nextLink until the list is complete. */
async function armList<T>(tok: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: ArmList<T> = await arm<ArmList<T>>(tok, next);
    out.push(...(page.value ?? []));
    next = page.nextLink;
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Azure Monitor metrics                                                      */
/* ------------------------------------------------------------------------- */

export interface AzureMetricsResponse {
  value: { name: { value: string }; timeseries: { data: { timeStamp: string; average?: number; maximum?: number; total?: number }[] }[] }[];
}
type Aggregation = "average" | "maximum" | "total";

/** Points of one metric and aggregation out of an Azure Monitor response (samples without a value are skipped). */
export function azurePoints(res: AzureMetricsResponse, metric: string, aggregation: Aggregation): Point[] {
  const m = res.value.find((v) => v.name.value === metric);
  return (m?.timeseries ?? []).flatMap((ts) => ts.data.filter((d) => d[aggregation] !== undefined && d[aggregation] !== null).map((d) => ({ t: Date.parse(d.timeStamp), v: d[aggregation] as number })));
}

/** Azure Monitor limits how much one query may span, so the window is fetched three weeks at a time. */
const CHUNK_DAYS = 21;

async function fetchAzureMetrics(tok: string, resourceId: string, metrics: string[], w: CollectionWindow): Promise<AzureMetricsResponse> {
  const merged: AzureMetricsResponse = { value: metrics.map((name) => ({ name: { value: name }, timeseries: [{ data: [] }] })) };
  for (let from = w.start.getTime(); from < w.end.getTime(); from += CHUNK_DAYS * 86_400_000) {
    const to = Math.min(w.end.getTime(), from + CHUNK_DAYS * 86_400_000);
    const qs = Object.entries({
      "api-version": "2023-10-01",
      metricnames: metrics.join(","),
      timespan: `${new Date(from).toISOString()}/${new Date(to).toISOString()}`,
      interval: "PT1H",
      aggregation: "Average,Maximum,Total",
    })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const page = await arm<AzureMetricsResponse>(tok, `${resourceId}/providers/Microsoft.Insights/metrics?${qs}`);
    for (const m of page.value) {
      const target = merged.value.find((v) => v.name.value === m.name.value);
      for (const ts of m.timeseries) target?.timeseries[0].data.push(...ts.data);
    }
  }
  return merged;
}

/**
 * Hourly series → one value per whole UTC day (mean for levels, sum for
 * totals). Partial days at either end are dropped; a day with missing hours is
 * scaled to a full day so a collection gap does not read as a drop.
 */
export function toDaily(s: Series | null, how: "avg" | "sum"): Series | null {
  if (!s) return null;
  const step = s.stepMinutes * 60_000;
  const perDay = 86_400_000 / step;
  const startMs = Date.parse(s.start);
  const skip = (Math.ceil(startMs / 86_400_000) * 86_400_000 - startMs) / step;
  const values: (number | null)[] = [];
  for (let i = skip; i + perDay <= s.values.length; i += perDay) {
    const day = s.values.slice(i, i + perDay).filter((v): v is number => v !== null);
    if (!day.length) values.push(null);
    else {
      const sum = day.reduce((a, b) => a + b, 0);
      values.push(Math.round((how === "sum" ? (sum * perDay) / day.length : sum / day.length) * 1000) / 1000);
    }
  }
  return values.some((v) => v !== null) ? { ...s, stepMinutes: 1440, start: new Date(startMs + skip * step).toISOString(), values } : null;
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

interface AzureVm {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  properties: { hardwareProfile: { vmSize: string }; instanceView?: { statuses?: { code: string }[] } };
}

interface AzureScaleSet {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  sku: { name: string; capacity: number };
  properties?: { orchestrationMode?: string };
}

interface AzureDisk {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  properties: { diskSizeGB: number; diskState: string };
  sku: { name: string };
}

interface AzureStorageAccount {
  id: string;
  name: string;
  location: string;
  kind: string;
  tags?: Record<string, string>;
  properties: { accessTier?: string };
}

interface AzureSqlDatabase {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  sku?: { name: string; tier: string; capacity?: number };
  properties: { maxSizeBytes?: number; status?: string };
}

interface AzurePlan {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  sku: { name: string; tier: string; capacity: number };
}

const workloadOf = (tags?: Record<string, string>) => tags?.app ?? tags?.workload ?? tags?.application;
const environmentOf = (tags?: Record<string, string>) => normalizeEnvironment(tags?.env ?? tags?.environment ?? tags?.Environment);
const tagList = (tags?: Record<string, string>) => Object.entries(tags ?? {}).map(([k, v]) => `${k}=${v}`);

const VM_METRICS = ["Percentage CPU", "Network In Total", "Network Out Total"];
/** Not published for every VM size or OS image; asked for, but never allowed to fail the query. */
const VM_OPTIONAL_METRICS = ["Available Memory Bytes"];

/** CPU, memory and network series for a VM or a scale set. Memory is a share of the size's RAM. */
function computeSeries(res: AzureMetricsResponse, w: CollectionWindow, vmSize: string) {
  const totalBytes = (resolveVm(vmSize)?.memGiB ?? 0) * 2 ** 30;
  return [
    toSeries("cpu", "avg", "percent", w, azurePoints(res, "Percentage CPU", "average")),
    toSeries("cpu_max", "max", "percent", w, azurePoints(res, "Percentage CPU", "maximum")),
    totalBytes > 0 ? toSeries("mem", "avg", "percent", w, azurePoints(res, "Available Memory Bytes", "average"), (free) => Math.min(100, Math.max(0, 100 * (1 - free / totalBytes)))) : null,
    toSeries("net_in", "sum", "bytes", w, azurePoints(res, "Network In Total", "total")),
    toSeries("net_out", "sum", "bytes", w, azurePoints(res, "Network Out Total", "total")),
  ];
}

export const azureConnector: Connector<AzureCredentials> = {
  provider: "azure",

  async validate(c) {
    try {
      const tok = await token(c);
      const sub = await arm<{ displayName: string; subscriptionId: string }>(tok, `/subscriptions/${c.subscriptionId}?api-version=2022-12-01`);
      return { ok: true, message: "Service principal authenticated", identity: `${sub.displayName} (${sub.subscriptionId})` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async collect(c, { days }) {
    const tok = await token(c);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const sub = `/subscriptions/${c.subscriptionId}`;

    // 1) Cost Management query: daily actual cost by service + region
    const q = await arm<{ properties: { columns: { name: string }[]; rows: (string | number)[][] } }>(tok, `${sub}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`, {
      method: "POST",
      body: JSON.stringify({
        type: "ActualCost",
        timeframe: "Custom",
        timePeriod: { from: from.toISOString(), to: to.toISOString() },
        dataset: {
          granularity: "Daily",
          aggregation: { totalCost: { name: "Cost", function: "Sum" } },
          grouping: [
            { type: "Dimension", name: "ServiceName" },
            { type: "Dimension", name: "ResourceLocation" },
          ],
        },
      }),
    });
    const cols = q.properties.columns.map((x) => x.name);
    const iCost = cols.indexOf("Cost");
    const iDate = cols.indexOf("UsageDate");
    const iSvc = cols.indexOf("ServiceName");
    const iLoc = cols.indexOf("ResourceLocation");
    const costs: NormalizedCost[] = q.properties.rows.map((r) => {
      const d = String(r[iDate]);
      const service = String(r[iSvc] || "Other");
      return {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        service,
        category: categorize(service),
        region: String(r[iLoc] || "global"),
        cost: Number(r[iCost]),
      };
    });

    // 2) Inventory with six weeks of hourly utilisation and traffic. Metrics are best-effort per
    //    resource: a failure is reported as a warning and the resource is kept without history.
    const warnings: string[] = [];
    const resources: NormalizedResource[] = [];
    const w = collectionWindow(HOURLY_DAYS);
    // One warning per kind of resource, however many of them fail for the same reason.
    const failures = new Map<string, { count: number; first: string }>();
    const metricsFor = async (kind: string, id: string, names: string[], optional: string[] = []): Promise<AzureMetricsResponse | null> => {
      try {
        return await fetchAzureMetrics(tok, id, [...names, ...optional], w);
      } catch (e) {
        // Azure Monitor rejects the whole query when one metric name is not published for the resource:
        // retry with the required metrics alone, so a missing memory metric does not cost the CPU history.
        if (optional.length) {
          const required = await fetchAzureMetrics(tok, id, names, w).catch(() => null);
          if (required) return required;
        }
        const f = failures.get(kind) ?? { count: 0, first: (e as Error).message.slice(0, 200) };
        failures.set(kind, { ...f, count: f.count + 1 });
        return null;
      }
    };
    const part = async (what: string, collect: () => Promise<void>) => attempt(warnings, what, undefined, collect);

    await part("Virtual machines", async () => {
      // statusOnly=true returns the power state of every VM in one call.
      const states = new Map<string, string>();
      const views = await attempt(warnings, "VM power states", [] as AzureVm[], () => armList<AzureVm>(tok, `${sub}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01&statusOnly=true`));
      for (const v of views) states.set(v.id.toLowerCase(), v.properties.instanceView?.statuses?.find((s) => s.code.startsWith("PowerState/"))?.code ?? "");

      for (const vm of await armList<AzureVm>(tok, `${sub}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01`)) {
        const sku = vm.properties.hardwareProfile.vmSize;
        const power = states.get(vm.id.toLowerCase());
        const running = !power || power === "PowerState/running";
        const res = running ? await metricsFor("virtual machines", vm.id, VM_METRICS, VM_OPTIONAL_METRICS) : null;
        resources.push({
          externalId: vm.id,
          name: vm.name,
          kind: "compute.vm",
          service: "Virtual Machines",
          sku,
          region: vm.location,
          workload: workloadOf(vm.tags),
          environment: environmentOf(vm.tags),
          state: running ? "running" : "stopped",
          quantity: 1,
          // A deallocated VM bills no compute.
          monthlyCost: running ? priceComponent({ id: vm.id, kind: "compute.vm", provider: "azure", label: sku, sku, region: vm.location, usage: {} }).monthlyCost : 0,
          config: {},
          tags: tagList(vm.tags),
          ...withUsage({}, res ? computeSeries(res, w, sku) : []),
        });
      }
    });

    await part("Virtual machine scale sets", async () => {
      for (const ss of await armList<AzureScaleSet>(tok, `${sub}/providers/Microsoft.Compute/virtualMachineScaleSets?api-version=2024-07-01`)) {
        // Flexible scale sets are made of ordinary VMs, which are already listed above.
        if (!ss.sku?.capacity || ss.properties?.orchestrationMode === "Flexible") continue;
        const sku = ss.sku.name;
        const res = await metricsFor("scale sets", ss.id, VM_METRICS, VM_OPTIONAL_METRICS);
        const aks = Boolean(ss.tags?.["aks-managed-poolName"] ?? ss.tags?.poolName);
        resources.push({
          externalId: ss.id,
          name: ss.tags?.["aks-managed-poolName"] ? `${ss.tags["aks-managed-poolName"]} (${ss.name})` : ss.name,
          kind: "compute.vm",
          service: aks ? "AKS node pool" : "Virtual Machine Scale Sets",
          sku,
          region: ss.location,
          workload: workloadOf(ss.tags),
          environment: environmentOf(ss.tags),
          state: "running",
          quantity: ss.sku.capacity,
          monthlyCost: priceComponent({ id: ss.id, kind: "compute.vm", provider: "azure", label: sku, sku, region: ss.location, usage: { count: ss.sku.capacity } }).monthlyCost,
          config: aks ? { role: "k8s-node" } : {},
          tags: tagList(ss.tags),
          ...withUsage({}, res ? computeSeries(res, w, sku) : []),
        });
      }
    });

    await part("Managed disks", async () => {
      for (const d of await armList<AzureDisk>(tok, `${sub}/providers/Microsoft.Compute/disks?api-version=2024-03-02`)) {
        const premium = d.sku.name.startsWith("Premium");
        resources.push({
          externalId: d.id,
          name: d.name,
          kind: "storage.block",
          service: "Managed Disks",
          region: d.location,
          workload: workloadOf(d.tags),
          environment: environmentOf(d.tags),
          state: d.properties.diskState,
          quantity: 1,
          monthlyCost: priceComponent({ id: d.id, kind: "storage.block", provider: "azure", label: d.name, usage: { gb: d.properties.diskSizeGB, tier: premium ? "premium" : "standard" } }).monthlyCost,
          metrics: {},
          config: { sizeGb: d.properties.diskSizeGB, attached: d.properties.diskState !== "Unattached" },
          tags: tagList(d.tags),
        });
      }
    });

    await part("Storage accounts", async () => {
      for (const a of await armList<AzureStorageAccount>(tok, `${sub}/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01`)) {
        const res = await metricsFor("storage accounts", a.id, ["UsedCapacity"], ["Egress"]);
        if (!res) continue;
        const stored = toDaily(mapSeries(toSeries("stored_gb", "avg", "gb", w, azurePoints(res, "UsedCapacity", "average")), "stored_gb", "gb", (bytes) => bytes / 1e9), "avg");
        const gb = latest(stored);
        if (!gb) continue;
        const read = toDaily(mapSeries(toSeries("read_gb", "sum", "gb", w, azurePoints(res, "Egress", "total")), "read_gb", "gb", (bytes) => bytes / 1e9), "sum");
        const tier = (a.properties.accessTier ?? "Hot").toLowerCase();
        const lifecycle = await arm<unknown>(tok, `${a.id}/managementPolicies/default?api-version=2023-05-01`).then(
          () => true,
          () => false, // 404: no lifecycle management policy
        );
        resources.push({
          externalId: a.id,
          name: a.name,
          kind: "storage.object",
          service: "Blob Storage",
          region: a.location,
          workload: workloadOf(a.tags),
          environment: environmentOf(a.tags),
          state: "running",
          quantity: 1,
          monthlyCost: priceComponent({ id: a.id, kind: "storage.object", provider: "azure", label: a.name, region: a.location, usage: { gb, tier: tier === "cool" ? "cool" : tier === "cold" ? "cold" : "hot" } }).monthlyCost,
          // Which share of the data is cold needs last-access-time tracking; without it the engine reports a gap.
          config: { sizeGb: Math.round(gb), tier, lifecyclePolicy: lifecycle },
          tags: tagList(a.tags),
          ...withUsage({}, [stored, read]),
        });
      }
    });

    await part("Azure SQL databases", async () => {
      for (const server of await armList<{ id: string; name: string }>(tok, `${sub}/providers/Microsoft.Sql/servers?api-version=2023-08-01-preview`)) {
        for (const db of await armList<AzureSqlDatabase>(tok, `${server.id}/databases?api-version=2023-08-01-preview`)) {
          // Provisioned vCore databases only: DTU tiers and serverless are billed differently.
          if (db.name === "master" || !db.sku?.capacity || !/^(GP|BC|HS)_Gen/.test(db.sku.name)) continue;
          const res = await metricsFor("SQL databases", db.id, ["cpu_percent"]);
          const storageGb = Math.round((db.properties.maxSizeBytes ?? 0) / 2 ** 30);
          resources.push({
            externalId: db.id,
            name: db.name,
            kind: "db.vcore",
            service: "Azure SQL Database",
            sku: db.sku.name,
            region: db.location,
            workload: workloadOf(db.tags),
            environment: environmentOf(db.tags),
            state: "running",
            quantity: 1,
            monthlyCost: priceComponent({ id: db.id, kind: "db.vcore", provider: "azure", label: db.name, region: db.location, usage: { vcores: db.sku.capacity, storageGb } }).monthlyCost,
            config: { vcores: db.sku.capacity, sizeGb: storageGb },
            tags: tagList(db.tags),
            ...withUsage({}, res ? [toSeries("cpu", "avg", "percent", w, azurePoints(res, "cpu_percent", "average")), toSeries("cpu_max", "max", "percent", w, azurePoints(res, "cpu_percent", "maximum"))] : []),
          });
        }
      }
    });

    await part("App Service plans", async () => {
      for (const plan of await armList<AzurePlan>(tok, `${sub}/providers/Microsoft.Web/serverfarms?api-version=2023-12-01`)) {
        if (!plan.sku?.capacity || !/^P\d/i.test(plan.sku.name)) continue; // Premium plans: the ones worth moving
        const res = await metricsFor("App Service plans", plan.id, ["CpuPercentage"], ["MemoryPercentage"]);
        resources.push({
          externalId: plan.id,
          name: plan.name,
          kind: "app.plan",
          service: "App Service",
          sku: plan.sku.name,
          region: plan.location,
          workload: workloadOf(plan.tags),
          environment: environmentOf(plan.tags),
          state: "running",
          quantity: plan.sku.capacity,
          monthlyCost: priceComponent({ id: plan.id, kind: "app.plan", provider: "azure", label: plan.name, sku: plan.sku.name, region: plan.location, usage: { count: plan.sku.capacity } }).monthlyCost,
          config: {},
          tags: tagList(plan.tags),
          ...withUsage({}, res ? [toSeries("cpu", "avg", "percent", w, azurePoints(res, "CpuPercentage", "average")), toSeries("cpu_max", "max", "percent", w, azurePoints(res, "CpuPercentage", "maximum")), toSeries("mem", "avg", "percent", w, azurePoints(res, "MemoryPercentage", "average"))] : []),
        });
      }
    });

    for (const [kind, f] of failures) warnings.push(`Azure Monitor metrics could not be read for ${f.count} ${kind}: ${f.first}`);
    return { resources, costs, warnings };
  },
};

export function azureSetupScript(subscriptionId: string) {
  return `az ad sp create-for-rbac \\
  --name "cloud-price-optimizer" \\
  --role "Cost Management Reader" \\
  --scopes /subscriptions/${subscriptionId || "<subscription-id>"}

az role assignment create \\
  --assignee <appId-from-above> \\
  --role "Reader" \\
  --scope /subscriptions/${subscriptionId || "<subscription-id>"}

# Utilisation and traffic history (CPU, memory, network, storage) from Azure Monitor
az role assignment create \\
  --assignee <appId-from-above> \\
  --role "Monitoring Reader" \\
  --scope /subscriptions/${subscriptionId || "<subscription-id>"}`;
}
