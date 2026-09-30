import { buildDemoDaily, demoResourceCost, demoServiceName, DEMO_RESOURCES, type DemoResource } from "../demo/estate";
import type { NormalizedCost, NormalizedResource, Snapshot } from "./types";

const hex = (s: string, n: number) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0").repeat(3).slice(0, n);
};

function externalId(r: DemoResource, accountExternalId: string) {
  if (r.provider === "aws") {
    const prefix: Record<string, string> = {
      "compute.vm": "asg",
      "storage.block": "vol",
      "network.nat_gateway": "nat",
      "network.load_balancer": "app",
      "network.public_ip": "eipalloc",
      "storage.snapshot": "snap",
    };
    if (r.kind === "storage.object") return `arn:aws:s3:::${r.name}`;
    if (r.kind === "db.instance") return `arn:aws:rds:${r.region}:${accountExternalId}:db:${r.name}`;
    return `${prefix[r.kind] ?? "res"}-0${hex(r.key, 16)}`;
  }
  if (r.provider === "azure") return `/subscriptions/${accountExternalId}/resourceGroups/rg-prod/providers/${r.kind}/${r.name}`;
  return `projects/${accountExternalId}/${r.kind.split(".")[0]}/${r.name}`;
}

export function demoSnapshot(accountKey: string, accountExternalId: string, days = 90): Snapshot {
  const specs = DEMO_RESOURCES.filter((r) => r.account === accountKey);
  const resources: NormalizedResource[] = specs.map((r) => ({
    externalId: externalId(r, accountExternalId),
    name: r.name,
    kind: r.kind,
    service: demoServiceName(r),
    sku: r.sku,
    region: r.region,
    workload: r.workload,
    environment: r.environment,
    state: "running",
    quantity: r.quantity ?? 1,
    monthlyCost: demoResourceCost(r),
    metrics: r.metrics ?? {},
    config: r.config ?? {},
    tags: r.tags ?? [],
  }));

  const byKey = new Map(specs.map((r) => [r.key, r]));
  const agg = new Map<string, NormalizedCost>();
  for (const d of buildDemoDaily(specs, days)) {
    const r = byKey.get(d.resourceKey)!;
    const service = demoServiceName(r);
    const k = `${d.date}|${service}|${r.region}|${r.workload ?? ""}`;
    const cur = agg.get(k);
    if (cur) cur.cost += d.cost;
    else agg.set(k, { date: d.date, service, category: r.category, region: r.region, workload: r.workload, cost: d.cost });
  }
  return { resources, costs: [...agg.values()] };
}
