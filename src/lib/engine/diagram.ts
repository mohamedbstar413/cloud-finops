import { KIND_ICON, serviceName, type Component, type ComponentKind } from "../pricing/components";
import type { DiagramEdge, DiagramNode } from "./types";

const LAYER: Partial<Record<ComponentKind, number>> = {
  "network.cdn": 1,
  "network.api_gateway": 1,
  "network.load_balancer": 1,
  "compute.vm": 2,
  "compute.function": 2,
  "compute.container": 2,
  "app.plan": 2,
  "messaging.queue": 3,
  "cache.managed": 3,
  "network.nat_gateway": 3,
  "network.vpc_endpoint": 3,
  "db.instance": 4,
  "db.serverless": 4,
  "db.vcore": 4,
  "storage.object": 4,
  "analytics.warehouse": 4,
};

/** Layered diagram for any component list (used for AI and custom proposals). */
export function autoDiagram(components: Component[], highlight?: DiagramNode["highlight"]): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes: DiagramNode[] = [];
  const shown = components.filter((c) => LAYER[c.kind] !== undefined);
  const servesTraffic = shown.some((c) => (LAYER[c.kind] ?? 9) <= 2);
  if (servesTraffic) nodes.push({ id: "users", label: "Users", icon: "users", layer: 0 });
  for (const c of shown) {
    nodes.push({
      id: c.id,
      label: serviceName(c.kind, c.provider),
      sublabel: c.sku ?? c.label.split("—")[1]?.trim(),
      icon: KIND_ICON[c.kind],
      layer: LAYER[c.kind]!,
      count: c.usage.count && c.usage.count > 1 && (c.kind === "compute.vm" || c.kind === "app.plan") ? c.usage.count : undefined,
      provider: c.provider,
      highlight,
    });
  }
  const layers = [...new Set(nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const edges: DiagramEdge[] = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const from = nodes.filter((n) => n.layer === layers[i]);
    const to = nodes.filter((n) => n.layer === layers[i + 1]);
    for (const f of from) for (const t of to.slice(0, 3)) if (from.length * to.length <= 9 || f === from[0]) edges.push({ from: f.id, to: t.id });
  }
  return { nodes, edges };
}
