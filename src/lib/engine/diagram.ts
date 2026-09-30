import { KIND_ICON, serviceName, type Component, type ComponentKind, type PricedComponent } from "../pricing/components";
import type { DiagramEdge, DiagramNode } from "./types";

/**
 * Diagram for ANY component list (custom and AI proposals). Components are
 * placed on semantic tiers by kind and role, and connected the way traffic
 * actually flows: users → CDN → gateway/LB → request tier → queue → workers,
 * request tier → state & data, egress through NAT / endpoints.
 */

type Tier = "cdn" | "gateway" | "web" | "batch" | "k8s" | "queue" | "worker" | "stateful" | "network" | "data" | "analytics";

const LAYER: Record<Tier, number> = {
  cdn: 1,
  gateway: 2,
  web: 3,
  k8s: 3,
  queue: 3,
  batch: 4,
  worker: 4,
  network: 5,
  stateful: 5,
  data: 5,
  analytics: 5,
};

const HIDDEN = new Set<ComponentKind>(["network.egress", "observability.logs", "storage.block", "storage.snapshot", "network.public_ip", "other.fixed", "compute.k8s_control_plane"]);

function tierOf(c: Component): Tier | null {
  if (HIDDEN.has(c.kind)) return null;
  switch (c.kind) {
    case "network.cdn":
      return "cdn";
    case "network.api_gateway":
    case "network.load_balancer":
      return "gateway";
    case "compute.function":
      return /worker/i.test(c.label) ? "worker" : "web";
    case "compute.container":
    case "app.plan":
      return c.role === "batch" ? "batch" : "web";
    case "compute.vm":
      return c.role === "batch" ? "batch" : c.role === "stateful" ? "stateful" : c.role === "k8s" ? "k8s" : "web";
    case "messaging.queue":
      return "queue";
    case "cache.managed":
      return "stateful";
    case "network.nat_gateway":
    case "network.vpc_endpoint":
      return "network";
    case "db.instance":
    case "db.serverless":
    case "db.vcore":
    case "storage.object":
      return "data";
    case "analytics.warehouse":
      return "analytics";
    default:
      return null;
  }
}

function sublabelFor(c: Component): string | undefined {
  const detail = c.label.includes("—") ? c.label.split("—").slice(1).join("—").trim() : undefined;
  if (c.kind === "compute.vm") return [c.sku, c.usage.spot ? "Spot" : c.role].filter(Boolean).join(" · ");
  if (c.kind === "app.plan") return c.sku;
  if (c.kind === "compute.container") return detail ?? (c.usage.count ? `~${c.usage.count} replicas` : undefined);
  if (c.kind === "storage.object") return detail ?? (c.usage.tier && c.usage.tier !== "hot" ? `${c.usage.tier} tier` : undefined);
  if (c.kind === "db.instance") return [c.sku, c.usage.multiAz ? "Multi-AZ" : undefined].filter(Boolean).join(" · ");
  if (c.kind === "db.vcore") return c.usage.vcores ? `${c.usage.vcores} vCores` : undefined;
  if (c.kind === "db.serverless") return c.usage.capacityUnits ? `~${c.usage.capacityUnits} avg capacity` : "autoscaling";
  if (c.kind === "compute.function" || c.kind === "network.api_gateway") return detail ?? (c.usage.requestsM ? `${Math.round(c.usage.requestsM)}M req/mo` : undefined);
  return detail ?? c.sku;
}

const originOf = (id: string) => id.split("~")[0];

/** One bucket re-tiered into hot / cool / cold parts is still one bucket: draw it once. */
function mergeStorageTiers(components: (Component | PricedComponent)[]): (Component | PricedComponent)[] {
  const out: (Component | PricedComponent)[] = [];
  const seen = new Map<string, number>();
  for (const c of components) {
    if (c.kind !== "storage.object") {
      out.push(c);
      continue;
    }
    const key = `${originOf(c.id)}|${c.provider}`;
    const siblings = components.filter((x) => x.kind === "storage.object" && `${originOf(x.id)}|${x.provider}` === key);
    if (siblings.length < 2) {
      out.push(c);
      continue;
    }
    if (seen.has(key)) continue;
    seen.set(key, out.length);
    const total = siblings.reduce((s, x) => s + (x.usage.gb ?? 0), 0) || 1;
    const split = siblings.map((x) => `${x.usage.tier ?? "hot"} ${Math.round(((x.usage.gb ?? 0) / total) * 100)}%`).join(" · ");
    out.push({ ...c, id: originOf(c.id), label: `${c.label.split("—")[0].trim()} — ${split}`, usage: { ...c.usage, gb: total } });
  }
  return out;
}

export function autoDiagram(components: (Component | PricedComponent)[], highlight?: DiagramNode["highlight"]): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const shown = mergeStorageTiers(components).filter((c) => tierOf(c));
  const by = (t: Tier) => shown.filter((c) => tierOf(c) === t);
  const cdn = by("cdn");
  const gateways = by("gateway");
  const web = by("web");
  const k8s = by("k8s");
  const batch = by("batch");
  const queues = by("queue");
  const workers = by("worker");
  const stateful = by("stateful");
  const network = by("network");
  const data = by("data");
  const analytics = by("analytics");

  const nodes: DiagramNode[] = [];
  const entry = cdn.length + gateways.length + web.length + k8s.length > 0;
  if (entry) nodes.push({ id: "users", label: "Users", icon: "users", layer: 0 });
  for (const c of shown) {
    nodes.push({
      id: c.id,
      label: serviceName(c.kind, c.provider),
      sublabel: sublabelFor(c),
      icon: KIND_ICON[c.kind],
      layer: LAYER[tierOf(c)!],
      count: (c.kind === "compute.vm" || c.kind === "app.plan" || c.kind === "cache.managed") && (c.usage.count ?? 1) > 1 ? c.usage.count : undefined,
      provider: c.provider,
      region: c.region,
      highlight,
    });
  }

  const edges: DiagramEdge[] = [];
  const link = (from: string, to: string) => {
    if (from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to });
  };
  const functions = web.filter((c) => c.kind === "compute.function");
  const servers = [...web.filter((c) => c.kind !== "compute.function"), ...k8s];
  const lbs = gateways.filter((c) => c.kind === "network.load_balancer");
  const apis = gateways.filter((c) => c.kind === "network.api_gateway");
  const objects = data.filter((c) => c.kind === "storage.object");
  const databases = data.filter((c) => c.kind !== "storage.object");
  const endpoints = network.filter((c) => c.kind === "network.vpc_endpoint");
  const nats = network.filter((c) => c.kind === "network.nat_gateway");

  // Entry: users hit the CDN, else the gateways, else the request tier directly.
  if (entry) (cdn.length ? cdn : gateways.length ? gateways : [...web, ...k8s]).forEach((c) => link("users", c.id));
  for (const c of cdn) (gateways.length ? gateways : web.length ? web : objects).forEach((o) => link(c.id, o.id));
  for (const a of apis) (functions.length ? functions : servers).forEach((t) => link(a.id, t.id));
  for (const l of lbs) (servers.length ? servers : functions).forEach((t) => link(l.id, t.id));

  // Request tier → queues, state, data, egress.
  for (const s of [...web, ...k8s]) {
    queues.forEach((q) => link(s.id, q.id));
    stateful.forEach((t) => link(s.id, t.id));
    databases.forEach((d) => link(s.id, d.id));
    nats.forEach((n) => link(s.id, n.id));
    (endpoints.length ? endpoints : objects).forEach((o) => link(s.id, o.id));
  }
  // Async: queue → workers (or batch fleets), workers → data.
  for (const q of queues) (workers.length ? workers : batch).forEach((w) => link(q.id, w.id));
  for (const w of [...workers, ...batch]) {
    (objects.length ? objects : databases).forEach((o) => link(w.id, o.id));
    analytics.forEach((a) => link(w.id, a.id));
  }
  for (const e of endpoints) objects.forEach((o) => link(e.id, o.id));
  // A warehouse with no producer reads the data lake.
  for (const a of analytics) if (!edges.some((e) => e.to === a.id)) objects.forEach((o) => link(o.id, a.id));
  return { nodes, edges };
}
