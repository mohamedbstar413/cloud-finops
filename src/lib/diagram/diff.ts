import type { ArchitectureSpec, DiagramEdge, DiagramNode } from "../engine/types";
import { KIND_ICON, type PricedComponent } from "../pricing/components";

/**
 * Architecture diff: matches the nodes of a current and a proposed
 * architecture (by id, by clone origin, then by kind + cloud), classifies
 * them as kept / changed / added / removed, and links each node to the priced
 * components it represents so diagrams can show per-node costs.
 */

export type NodeStatus = "kept" | "changed" | "added" | "removed";
export type EdgeStatus = "kept" | "changed" | "added" | "removed";

export interface NodeCost {
  cost: number;
  components: PricedComponent[];
}

export interface DiffNode extends DiagramNode {
  status: NodeStatus;
  before?: DiagramNode;
  costBefore?: number;
  costAfter?: number;
  componentsBefore?: PricedComponent[];
  componentsAfter?: PricedComponent[];
}

export interface DiffEdge extends DiagramEdge {
  status: EdgeStatus;
  beforeLabel?: string;
}

export interface ArchitectureDiff {
  nodes: DiffNode[];
  edges: DiffEdge[];
  /** Status of each node id of the current architecture (kept / changed / removed). */
  currentStatus: Map<string, NodeStatus>;
  /** Status of each node id of the proposed architecture (kept / changed / added). */
  proposedStatus: Map<string, NodeStatus>;
  counts: Record<NodeStatus, number>;
  costsBefore: Map<string, NodeCost>;
  costsAfter: Map<string, NodeCost>;
  notDrawnBefore: PricedComponent[];
  notDrawnAfter: PricedComponent[];
}

type Spec = Pick<ArchitectureSpec, "nodes" | "edges" | "components">;

const origin = (id: string) => id.split("~")[0];

/** Assign every priced component to at most one node; the rest are "not drawn". */
export function linkNodeCosts(spec: Pick<ArchitectureSpec, "nodes" | "components">): { byNode: Map<string, NodeCost>; notDrawn: PricedComponent[] } {
  const byNode = new Map<string, NodeCost>();
  const unused = new Set(spec.components.map((c) => c.id));
  const byId = new Map(spec.components.map((c) => [c.id, c]));
  const take = (nodeId: string, cs: PricedComponent[]) => {
    const fresh = cs.filter((c) => unused.has(c.id));
    if (!fresh.length) return;
    fresh.forEach((c) => unused.delete(c.id));
    const cur = byNode.get(nodeId) ?? { cost: 0, components: [] };
    cur.components.push(...fresh);
    cur.cost = Math.round((cur.cost + fresh.reduce((s, c) => s + c.monthlyCost, 0)) * 100) / 100;
    byNode.set(nodeId, cur);
  };

  // 1) Identity: node id = component id, "n-<resource>" ↔ resource / "keep-<resource>".
  for (const n of spec.nodes) {
    const rid = n.id.startsWith("n-") ? n.id.slice(2) : n.id;
    const hits = [n.id, rid, `keep-${rid}`].map((k) => byId.get(k)).filter(Boolean) as PricedComponent[];
    // Merged nodes (e.g. one bucket split into storage tiers) own every clone of their origin.
    const clones = spec.components.filter((c) => c.id.includes("~") && origin(c.id) === n.id);
    take(n.id, [...new Set([...hits, ...clones])]);
  }
  // 2) Same kind of service on the same cloud; disambiguate siblings by sku / label words.
  for (const n of spec.nodes) {
    if (byNode.has(n.id) || n.icon === "users") continue;
    const cands = spec.components.filter((c) => unused.has(c.id) && KIND_ICON[c.kind] === n.icon && (!n.provider || c.provider === n.provider));
    if (!cands.length) continue;
    const siblings = spec.nodes.filter((m) => m.icon === n.icon && m.provider === n.provider && !byNode.has(m.id));
    if (siblings.length <= 1) {
      take(n.id, cands);
      continue;
    }
    const words = `${n.sublabel ?? ""}`.toLowerCase().trim();
    const scored = cands.map((c) => ({
      c,
      score: (c.sku && words.includes(c.sku.toLowerCase()) ? 2 : 0) + (words && c.label.toLowerCase().includes(words) ? 3 : 0) + (c.label.toLowerCase().includes(n.label.toLowerCase()) ? 1 : 0),
    }));
    const best = Math.max(...scored.map((s) => s.score));
    if (best > 0) take(n.id, scored.filter((s) => s.score === best).slice(0, 1).map((s) => s.c));
  }
  return { byNode, notDrawn: spec.components.filter((c) => unused.has(c.id)) };
}

const sameNode = (a: DiagramNode, b: DiagramNode) =>
  a.label === b.label && (a.sublabel ?? "") === (b.sublabel ?? "") && (a.count ?? 1) === (b.count ?? 1) && a.provider === b.provider;

export function diffArchitectures(cur: Spec, pro: Spec): ArchitectureDiff {
  const match = new Map<string, string>();
  const taken = new Set<string>();
  const pair = (c: DiagramNode, p?: DiagramNode) => {
    if (!p) return;
    match.set(c.id, p.id);
    taken.add(p.id);
  };
  for (const c of cur.nodes) pair(c, pro.nodes.find((p) => !taken.has(p.id) && p.id === c.id));
  for (const c of cur.nodes) if (!match.has(c.id)) pair(c, pro.nodes.find((p) => !taken.has(p.id) && origin(p.id) === origin(c.id)));
  for (const c of cur.nodes) {
    if (match.has(c.id) || c.icon === "users" || c.icon === "internet") continue;
    const cands = pro.nodes.filter((p) => !taken.has(p.id) && p.icon === c.icon && p.provider === c.provider);
    pair(c, cands.find((p) => p.label === c.label) ?? cands[0]);
  }

  const before = linkNodeCosts(cur);
  const after = linkNodeCosts(pro);
  const currentStatus = new Map<string, NodeStatus>();
  const proposedStatus = new Map<string, NodeStatus>();
  const reverse = new Map([...match.entries()].map(([c, p]) => [p, c]));

  for (const c of cur.nodes) {
    const pid = match.get(c.id);
    if (!pid) {
      currentStatus.set(c.id, "removed");
      continue;
    }
    const p = pro.nodes.find((n) => n.id === pid)!;
    const cb = before.byNode.get(c.id)?.cost;
    const ca = after.byNode.get(pid)?.cost;
    const costMoved = cb !== undefined && ca !== undefined && Math.abs(cb - ca) > Math.max(1, 0.01 * cb);
    const status: NodeStatus = sameNode(c, p) && !costMoved ? "kept" : "changed";
    currentStatus.set(c.id, status);
    proposedStatus.set(pid, status);
  }
  for (const p of pro.nodes) if (!proposedStatus.has(p.id)) proposedStatus.set(p.id, "added");

  const removedId = (id: string) => `was:${id}`;
  const nodes: DiffNode[] = [
    ...pro.nodes.map((p) => {
      const cid = reverse.get(p.id);
      const b = cid ? cur.nodes.find((n) => n.id === cid) : undefined;
      return {
        ...p,
        status: proposedStatus.get(p.id)!,
        before: b,
        costBefore: cid ? before.byNode.get(cid)?.cost : undefined,
        costAfter: after.byNode.get(p.id)?.cost,
        componentsBefore: cid ? before.byNode.get(cid)?.components : undefined,
        componentsAfter: after.byNode.get(p.id)?.components,
      };
    }),
    ...cur.nodes
      .filter((c) => !match.has(c.id))
      .map((c) => ({
        ...c,
        id: removedId(c.id),
        status: "removed" as const,
        before: c,
        costBefore: before.byNode.get(c.id)?.cost,
        componentsBefore: before.byNode.get(c.id)?.components,
      })),
  ];

  const mapId = (id: string) => match.get(id) ?? removedId(id);
  const key = (e: { from: string; to: string }) => `${e.from}→${e.to}`;
  const curEdges = cur.edges.map((e) => ({ ...e, from: mapId(e.from), to: mapId(e.to) }));
  const curByKey = new Map(curEdges.map((e) => [key(e), e]));
  const proKeys = new Set(pro.edges.map(key));
  const edges: DiffEdge[] = [
    ...pro.edges.map((e) => {
      const b = curByKey.get(key(e));
      if (!b) return { ...e, status: "added" as const };
      const changed = (b.label ?? "") !== (e.label ?? "") || Boolean(b.dashed) !== Boolean(e.dashed);
      return { ...e, status: changed ? ("changed" as const) : ("kept" as const), beforeLabel: changed ? b.label : undefined };
    }),
    ...curEdges.filter((e) => !proKeys.has(key(e))).map((e) => ({ ...e, status: "removed" as const })),
  ];

  const counts: Record<NodeStatus, number> = { kept: 0, changed: 0, added: 0, removed: 0 };
  for (const n of nodes) if (n.icon !== "users") counts[n.status]++;

  return {
    nodes,
    edges,
    currentStatus,
    proposedStatus,
    counts,
    costsBefore: before.byNode,
    costsAfter: after.byNode,
    notDrawnBefore: before.notDrawn,
    notDrawnAfter: after.notDrawn,
  };
}
