import { ClientSecretCredential } from "@azure/identity";
import { priceComponent } from "../pricing/components";
import { categorize, type AzureCredentials, type Connector, type NormalizedCost, type NormalizedResource } from "./types";

const ARM = "https://management.azure.com";

async function token(c: AzureCredentials) {
  const cred = new ClientSecretCredential(c.tenantId, c.clientId, c.clientSecret);
  const t = await cred.getToken(`${ARM}/.default`);
  return t.token;
}

async function arm<T>(tok: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ARM}${path}`, {
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

interface AzureVm {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  properties: { hardwareProfile: { vmSize: string } };
}

interface AzureDisk {
  id: string;
  name: string;
  location: string;
  properties: { diskSizeGB: number; diskState: string };
  sku: { name: string };
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

    // 1) Cost Management query: daily actual cost by service + region
    const q = await arm<{ properties: { columns: { name: string }[]; rows: (string | number)[][] } }>(
      tok,
      `/subscriptions/${c.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
      {
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
      },
    );
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

    // 2) Inventory: VMs + CPU metrics, managed disks
    const resources: NormalizedResource[] = [];
    const vms = await arm<ArmList<AzureVm>>(tok, `/subscriptions/${c.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01`);
    for (const vm of vms.value) {
      let metrics: NormalizedResource["metrics"] = {};
      try {
        const m = await arm<{ value: { timeseries: { data: { average?: number; maximum?: number }[] }[] }[] }>(
          tok,
          `${vm.id}/providers/Microsoft.Insights/metrics?api-version=2023-10-01&metricnames=Percentage%20CPU&timespan=P14D&interval=PT1H&aggregation=Average,Maximum`,
        );
        const pts = m.value[0]?.timeseries[0]?.data ?? [];
        const avgs = pts.map((p) => p.average ?? 0).sort((a, b) => a - b);
        if (avgs.length) {
          metrics = {
            cpuAvg: avgs.reduce((a, b) => a + b, 0) / avgs.length,
            cpuP95: avgs[Math.floor(avgs.length * 0.95)],
            cpuMax: Math.max(...pts.map((p) => p.maximum ?? 0)),
          };
        }
      } catch {
        /* metrics are best-effort */
      }
      const sku = vm.properties.hardwareProfile.vmSize;
      resources.push({
        externalId: vm.id,
        name: vm.name,
        kind: "compute.vm",
        service: "Virtual Machines",
        sku,
        region: vm.location,
        workload: vm.tags?.app ?? vm.tags?.workload,
        environment: vm.tags?.env ?? vm.tags?.environment,
        state: "running",
        quantity: 1,
        monthlyCost: priceComponent({ id: vm.id, kind: "compute.vm", provider: "azure", label: sku, sku, region: vm.location, usage: {} }).monthlyCost,
        metrics,
        config: {},
        tags: Object.entries(vm.tags ?? {}).map(([k, v]) => `${k}=${v}`),
      });
    }

    const disks = await arm<ArmList<AzureDisk>>(tok, `/subscriptions/${c.subscriptionId}/providers/Microsoft.Compute/disks?api-version=2024-03-02`);
    for (const d of disks.value) {
      const premium = d.sku.name.startsWith("Premium");
      resources.push({
        externalId: d.id,
        name: d.name,
        kind: "storage.block",
        service: "Managed Disks",
        region: d.location,
        state: d.properties.diskState,
        quantity: 1,
        monthlyCost: priceComponent({ id: d.id, kind: "storage.block", provider: "azure", label: d.name, usage: { gb: d.properties.diskSizeGB, tier: premium ? "premium" : "standard" } }).monthlyCost,
        metrics: {},
        config: { sizeGb: d.properties.diskSizeGB, attached: d.properties.diskState !== "Unattached" },
        tags: [],
      });
    }
    return { resources, costs };
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

az role assignment create \\
  --assignee <appId-from-above> \\
  --role "Monitoring Reader" \\
  --scope /subscriptions/${subscriptionId || "<subscription-id>"}`;
}
