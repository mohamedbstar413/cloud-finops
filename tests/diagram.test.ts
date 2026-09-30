/**
 * Architecture-diagram engine tests: geometric guarantees of the layout and
 * router (no overlaps, no edge through a node, clouds in separate boxes),
 * semantic auto-diagrams for arbitrary architectures, and the architecture diff.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffArchitectures, linkNodeCosts } from "../src/lib/diagram/diff";
import { layoutDiagram, laneName, roundedPath, type Layout, type LayoutEdgeInput, type LayoutNodeInput } from "../src/lib/diagram/layout";
import { analyzeHeuristically, parseArchitectureText } from "../src/lib/engine/custom";
import { autoDiagram } from "../src/lib/engine/diagram";
import type { ArchitectureSpec, DiagramNode } from "../src/lib/engine/types";
import { priceComponents } from "../src/lib/pricing/components";
import { rng } from "./fixtures";

const RUNS = Math.max(1, Number(process.env.FUZZ_RUNS ?? 1));

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function nodeBox(l: Layout, id: string): Box {
  const n = l.nodes.find((x) => x.id === id)!;
  const extra = n.stack ? l.options.stackOffset : 0;
  return { x: n.x, y: n.y, w: n.w + extra, h: n.h + extra };
}

const overlaps = (a: Box, b: Box, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Does an axis-aligned segment pass through the interior of a box? */
function segmentHits(a: { x: number; y: number }, b: { x: number; y: number }, r: Box): boolean {
  const s = 1;
  if (Math.abs(a.x - b.x) < 0.01) {
    const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return a.x > r.x + s && a.x < r.x + r.w - s && y2 > r.y + s && y1 < r.y + r.h - s;
  }
  const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  return a.y > r.y + s && a.y < r.y + r.h - s && x2 > r.x + s && x1 < r.x + r.w - s;
}

function onBorder(p: { x: number; y: number }, r: Box) {
  const t = 0.6;
  const withinX = p.x >= r.x - t && p.x <= r.x + r.w + t;
  const withinY = p.y >= r.y - t && p.y <= r.y + r.h + t;
  return (withinX && (Math.abs(p.y - r.y) < t || Math.abs(p.y - (r.y + r.h)) < t)) || (withinY && (Math.abs(p.x - r.x) < t || Math.abs(p.x - (r.x + r.w)) < t));
}

function assertLayout(l: Layout, nodes: LayoutNodeInput[], edges: LayoutEdgeInput[], label: string) {
  assert.ok(Number.isFinite(l.width) && Number.isFinite(l.height) && l.width > 0 && l.height > 0, `${label}: bad canvas ${l.width}×${l.height}`);
  // 1) nodes never overlap and stay on the canvas
  for (let i = 0; i < l.nodes.length; i++) {
    const a = nodeBox(l, l.nodes[i].id);
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= l.width + 0.5 && a.y + a.h <= l.height + 0.5, `${label}: node ${l.nodes[i].id} is off-canvas`);
    for (let j = i + 1; j < l.nodes.length; j++) {
      assert.ok(!overlaps(a, nodeBox(l, l.nodes[j].id), 4), `${label}: nodes ${l.nodes[i].id} and ${l.nodes[j].id} overlap`);
    }
  }
  // 2) each cloud's nodes are inside its box; boxes never overlap; ungrouped nodes stay outside boxes
  const groupOf = new Map(nodes.map((n) => [n.id, n.group]));
  for (const g of l.groups) {
    for (const n of l.nodes) {
      const b = nodeBox(l, n.id);
      const inside = b.x >= g.x - 0.5 && b.y >= g.y - 0.5 && b.x + b.w <= g.x + g.w + 0.5 && b.y + b.h <= g.y + g.h + 0.5;
      if (groupOf.get(n.id) === g.key) assert.ok(inside, `${label}: ${n.id} escapes its ${g.key} box`);
      else assert.ok(!overlaps(b, g), `${label}: ${n.id} (${groupOf.get(n.id) ?? "no cloud"}) sits inside the ${g.key} box`);
    }
    for (const h of l.groups) if (h !== g) assert.ok(!overlaps(g, h), `${label}: boxes ${g.key} and ${h.key} overlap`);
  }
  // 3) every valid edge is routed, orthogonally, from border to border, without crossing any other node
  const valid = edges.filter((e) => e.from !== e.to && nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));
  const uniq = new Set(valid.map((e) => `${e.from}→${e.to}`));
  assert.equal(l.edges.length, uniq.size, `${label}: routed ${l.edges.length} of ${uniq.size} edges`);
  for (const e of l.edges) {
    const pts = e.points;
    assert.ok(pts.length >= 2, `${label}: edge ${e.id} has no path`);
    for (const q of pts) assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y), `${label}: edge ${e.id} has a non-finite point`);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      assert.ok(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, `${label}: edge ${e.id} has a diagonal segment`);
      for (const n of l.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        assert.ok(!segmentHits(a, b, nodeBox(l, n.id)), `${label}: edge ${e.from}→${e.to} passes through ${n.id}`);
      }
    }
    assert.ok(onBorder(pts[0], nodeBox(l, e.from)), `${label}: edge ${e.id} does not start on ${e.from}'s border`);
    assert.ok(onBorder(pts[pts.length - 1], nodeBox(l, e.to)), `${label}: edge ${e.id} does not end on ${e.to}'s border`);
    assert.ok(roundedPath(pts).startsWith("M"), `${label}: bad path`);
  }
}

const toLayout = (nodes: DiagramNode[], edges: { from: string; to: string }[]) => ({
  nodes: nodes.map((n) => ({ id: n.id, layer: n.layer, group: n.provider, stack: (n.count ?? 1) > 1 })),
  edges: edges.map((e) => ({ id: `${e.from}->${e.to}`, from: e.from, to: e.to })),
});

describe("diagram layout engine", () => {
  it("lays out a serverless architecture with aligned tiers and no crossings", () => {
    const nodes: DiagramNode[] = [
      { id: "users", label: "Users", icon: "users", layer: 0 },
      { id: "api", label: "API Gateway", icon: "api", layer: 1, provider: "aws" },
      { id: "fn", label: "Lambda", icon: "function", layer: 2, provider: "aws" },
      { id: "q", label: "SQS", icon: "queue", layer: 2, provider: "aws" },
      { id: "n-db", label: "RDS", icon: "db", layer: 3, provider: "aws" },
      { id: "worker", label: "Lambda", icon: "function", layer: 3, provider: "aws" },
    ];
    const edges = [
      { from: "users", to: "api" },
      { from: "api", to: "fn" },
      { from: "fn", to: "q" },
      { from: "q", to: "worker" },
      { from: "fn", to: "n-db" },
    ];
    const { nodes: n, edges: e } = toLayout(nodes, edges);
    const l = layoutDiagram(n, e, { minWidth: 560 });
    assertLayout(l, n, e, "serverless");
    const x = (id: string) => l.nodes.find((k) => k.id === id)!.x;
    assert.ok(x("n-db") < x("worker"), "the database should sit under the handler, the worker under the queue");
    assert.equal(x("fn"), x("n-db"), "fn → db should be a straight vertical");
    assert.equal(x("q"), x("worker"), "queue → worker should be a straight vertical");
    const users = l.nodes.find((k) => k.id === "users")!;
    assert.equal(users.x, x("api"), "users should be centred over the API gateway");
    assert.equal(l.groups.length, 1);
    assert.ok(users.y + users.h < l.groups[0].y, "users sit outside (above) the AWS boundary");
  });

  it("gives each cloud its own column in a cross-cloud move", () => {
    const nodes: DiagramNode[] = [
      { id: "src0", label: "gs://acme-data-lake", icon: "storage", layer: 0, provider: "gcp" },
      { id: "fleet", label: "AWS EC2", icon: "vm", layer: 1, count: 8, provider: "aws" },
      { id: "sink0", label: "s3://acme-analytics", icon: "storage", layer: 2, provider: "aws" },
    ];
    const edges = [
      { from: "src0", to: "fleet" },
      { from: "fleet", to: "sink0" },
    ];
    const { nodes: n, edges: e } = toLayout(nodes, edges);
    const l = layoutDiagram(n, e, { minWidth: 480 });
    assertLayout(l, n, e, "cross-cloud");
    assert.deepEqual(l.groups.map((g) => g.key), ["gcp", "aws"]);
  });

  it("keeps the Internet outside the cloud boundary", () => {
    const nodes: DiagramNode[] = [
      { id: "app", label: "Private subnets", icon: "vm", layer: 0, provider: "aws" },
      { id: "gw", label: "VPC Gateway Endpoints", icon: "endpoint", layer: 1, provider: "aws" },
      { id: "nat", label: "NAT Gateway", icon: "nat", layer: 1, provider: "aws", count: 3 },
      { id: "s3", label: "S3", icon: "storage", layer: 2, provider: "aws" },
      { id: "net", label: "Internet", icon: "internet", layer: 2 },
    ];
    const edges = [
      { from: "app", to: "gw" },
      { from: "gw", to: "s3" },
      { from: "app", to: "nat" },
      { from: "nat", to: "net" },
    ];
    const { nodes: n, edges: e } = toLayout(nodes, edges);
    const l = layoutDiagram(n, e, { minWidth: 560 });
    assertLayout(l, n, e, "nat");
    const net = l.nodes.find((k) => k.id === "net")!;
    assert.equal(net.column, "__ext");
  });

  it("merges many-to-many edges into a single bus lane", () => {
    const nodes: LayoutNodeInput[] = [
      { id: "a", layer: 0, group: "aws" },
      { id: "b", layer: 0, group: "aws" },
      { id: "c", layer: 0, group: "aws" },
      { id: "x", layer: 1, group: "aws" },
      { id: "y", layer: 1, group: "aws" },
      { id: "z", layer: 1, group: "aws" },
    ];
    const edges = ["a", "b", "c"].flatMap((s) => ["x", "y", "z"].map((t) => ({ id: `${s}${t}`, from: s, to: t })));
    const l = layoutDiagram(nodes, edges, {});
    assertLayout(l, nodes, edges, "bus");
    const lanes = new Set(l.edges.filter((e) => e.points.length > 2).map((e) => e.points[1].y));
    assert.equal(lanes.size, 1, `expected one shared lane, got ${lanes.size}`);
  });

  it("routes long edges around nodes in intermediate rows", () => {
    const nodes: LayoutNodeInput[] = [
      { id: "top", layer: 0, group: "aws" },
      { id: "mid", layer: 1, group: "aws" },
      { id: "bottom", layer: 2, group: "aws" },
    ];
    const edges = [
      { id: "1", from: "top", to: "mid" },
      { id: "2", from: "mid", to: "bottom" },
      { id: "3", from: "top", to: "bottom" },
    ];
    const l = layoutDiagram(nodes, edges, {});
    assertLayout(l, nodes, edges, "long-edge");
    assert.ok(l.edges.find((e) => e.id === "3")!.points.length >= 4, "the skip edge must detour around the middle node");
  });

  it("handles upward edges, same-row edges and degenerate input", () => {
    const nodes: LayoutNodeInput[] = [
      { id: "a", layer: 0 },
      { id: "b", layer: 1 },
      { id: "c", layer: 1 },
      { id: "d", layer: 1 },
      { id: "a", layer: 5 },
    ];
    const edges = [
      { id: "up", from: "b", to: "a" },
      { id: "side", from: "b", to: "d" },
      { id: "self", from: "c", to: "c" },
      { id: "dangling", from: "c", to: "nope" },
      { id: "dup", from: "b", to: "a" },
    ];
    const l = layoutDiagram(nodes, edges, {});
    assertLayout(l, nodes.slice(0, 4), edges, "degenerate");
    assert.equal(layoutDiagram([], [], { minWidth: 300 }).nodes.length, 0);
  });

  it("names tiers from the components in each row", () => {
    assert.equal(laneName(["function", "queue"]), "Compute · Messaging");
    assert.equal(laneName(["db", "storage", "cache"]), "Data · State");
    assert.equal(laneName(["users"]), "Clients");
  });

  it("fuzz: random multi-cloud graphs always satisfy every geometric guarantee", () => {
    for (let seed = 1; seed <= 400 * RUNS; seed++) {
      const r = rng(seed * 13);
      const clouds = [undefined, "aws", "azure", "gcp"];
      const n = 1 + Math.floor(r() * 16);
      const nodes: LayoutNodeInput[] = Array.from({ length: n }, (_, i) => ({
        id: `n${i}`,
        layer: Math.floor(r() * 6),
        group: clouds[Math.floor(r() * (r() < 0.5 ? 2 : 4))],
        stack: r() < 0.25,
      }));
      const edges: LayoutEdgeInput[] = Array.from({ length: Math.floor(r() * n * 1.8) }, (_, i) => ({
        id: `e${i}`,
        from: `n${Math.floor(r() * n)}`,
        to: `n${Math.floor(r() * n)}`,
      }));
      const compact = r() < 0.5;
      const l = layoutDiagram(nodes, edges, compact ? { nodeW: 158, nodeH: 64, gapX: 16, colGap: 28, groupPad: 12, minWidth: 360 + Math.floor(r() * 300), laneGutter: r() < 0.5 ? 96 : 0, wrap: true } : { minWidth: Math.floor(r() * 900) });
      assertLayout(l, nodes, edges, `seed ${seed}`);
    }
  });
});

describe("row wrapping", () => {
  it("breaks an overfull tier onto sub-rows so the diagram fits its container", () => {
    const nodes: LayoutNodeInput[] = [{ id: "src", layer: 0, group: "aws" }, ...Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, layer: 1, group: "aws" }))];
    const edges = nodes.slice(1).map((n) => ({ id: n.id, from: "src", to: n.id }));
    const unwrapped = layoutDiagram(nodes, edges, { minWidth: 560 });
    const wrapped = layoutDiagram(nodes, edges, { minWidth: 560, wrap: true });
    assert.ok(unwrapped.width > 560);
    assert.ok(wrapped.width <= 561, `wrapped width ${wrapped.width}`);
    assert.ok(wrapped.rows.length > unwrapped.rows.length);
    assertLayout(wrapped, nodes, edges, "wrapped");
  });
});

describe("auto diagrams for any architecture", () => {
  const ecommerce = parseArchitectureText(
    "E-commerce platform on AWS: 20 m6i.2xlarge web tier behind an ALB, 12 c6g.xlarge API servers, 6 r6i.4xlarge running self-managed Redis, Aurora Postgres Multi-AZ, 200 TB in S3, CloudFront, NAT gateway, 8 c5.2xlarge for batch jobs, 50 TB egress per month, 1.2 billion requests/month, spiky.",
  );

  it("connects tiers the way traffic flows", () => {
    const { nodes, edges } = autoDiagram(ecommerce.components);
    const kind = (id: string) => ecommerce.components.find((c) => c.id === id)?.kind ?? id;
    const has = (from: string, to: string) => edges.some((e) => kind(e.from) === from && kind(e.to) === to);
    assert.ok(has("users", "network.cdn"), "users → CDN");
    assert.ok(has("network.cdn", "network.load_balancer"), "CDN → load balancer");
    assert.ok(has("network.load_balancer", "compute.vm"), "load balancer → web tier");
    assert.ok(has("compute.vm", "db.instance"), "web tier → database");
    const batch = ecommerce.components.find((c) => c.role === "batch")!;
    assert.ok(!edges.some((e) => kind(e.from) === "network.load_balancer" && e.to === batch.id), "batch fleet must not sit behind the load balancer");
    for (const e of edges) assert.ok(nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to), "no dangling edges");
    const { nodes: n, edges: le } = toLayout(nodes, edges);
    assertLayout(layoutDiagram(n, le, { minWidth: 640 }), n, le, "ecommerce");
  });

  it("draws a re-tiered bucket as one node with its tier split", () => {
    const a = analyzeHeuristically(ecommerce.components, ecommerce.profile);
    const tiered = a.proposals.find((p) => p.components.filter((c) => c.kind === "storage.object").length > 1)!;
    assert.ok(tiered, "expected a proposal that tiers the bucket");
    const d = autoDiagram(tiered.components);
    const buckets = d.nodes.filter((n) => n.icon === "storage");
    assert.equal(buckets.length, 1);
    assert.match(buckets[0].sublabel ?? "", /hot \d+% · cool \d+% · cold \d+%/);
    const { byNode } = linkNodeCosts({ nodes: d.nodes, components: tiered.components });
    const bucketCost = tiered.components.filter((c) => c.kind === "storage.object").reduce((s, c) => s + c.monthlyCost, 0);
    assert.ok(Math.abs(byNode.get(buckets[0].id)!.cost - bucketCost) < 0.05, "the merged node owns all tier costs");
  });

  it("every proposal of a complex architecture lays out cleanly", () => {
    const a = analyzeHeuristically(ecommerce.components, ecommerce.profile);
    for (const p of a.proposals) {
      const d = autoDiagram(p.components);
      const { nodes, edges } = toLayout(d.nodes, d.edges);
      assertLayout(layoutDiagram(nodes, edges, { minWidth: 560 }), nodes, edges, p.title);
    }
  });
});

describe("architecture diff", () => {
  const spec = (nodes: DiagramNode[], edges: { from: string; to: string; label?: string; dashed?: boolean }[], components: Parameters<typeof priceComponents>[0]): ArchitectureSpec => {
    const priced = priceComponents(components);
    return { title: "", provider: "aws", monthlyCost: priced.total, components: priced.components, nodes, edges, bullets: [] };
  };

  it("classifies a serverless migration as removed / added / kept", () => {
    const cur = spec(
      [
        { id: "users", label: "Users", icon: "users", layer: 0 },
        { id: "lb", label: "ALB", icon: "lb", layer: 1, provider: "aws" },
        { id: "vm", label: "EC2", sublabel: "m5.4xlarge", icon: "vm", layer: 2, provider: "aws", count: 14 },
        { id: "n-db", label: "RDS", icon: "db", layer: 3, provider: "aws" },
      ],
      [
        { from: "users", to: "lb" },
        { from: "lb", to: "vm" },
        { from: "vm", to: "n-db" },
      ],
      [
        { id: "asg", kind: "compute.vm", provider: "aws", label: "api-asg", sku: "m5.4xlarge", usage: { count: 14 } },
        { id: "alb", kind: "network.load_balancer", provider: "aws", label: "alb", usage: { gb: 60_000 } },
        { id: "db", kind: "db.instance", provider: "aws", label: "orders", sku: "db.r5.2xlarge", usage: { multiAz: true } },
        { id: "egress", kind: "network.egress", provider: "aws", label: "egress", usage: { gb: 18_000 } },
      ],
    );
    const pro = spec(
      [
        { id: "users", label: "Users", icon: "users", layer: 0 },
        { id: "api", label: "API Gateway", icon: "api", layer: 1, provider: "aws" },
        { id: "fn", label: "Lambda", sublabel: "API handlers", icon: "function", layer: 2, provider: "aws" },
        { id: "n-db", label: "RDS", icon: "db", layer: 3, provider: "aws" },
      ],
      [
        { from: "users", to: "api" },
        { from: "api", to: "fn" },
        { from: "fn", to: "n-db" },
      ],
      [
        { id: "api", kind: "network.api_gateway", provider: "aws", label: "API Gateway", usage: { requestsM: 600 } },
        { id: "fn-api", kind: "compute.function", provider: "aws", label: "Lambda — API handlers", usage: { requestsM: 450, avgDurationMs: 120, memoryMb: 1024 } },
        { id: "keep-db", kind: "other.fixed", provider: "aws", label: "orders (unchanged)", usage: { monthlyCost: 1575 } },
      ],
    );
    const d = diffArchitectures(cur, pro);
    const status = (id: string) => d.nodes.find((n) => n.id === id)?.status;
    assert.equal(status("api"), "added");
    assert.equal(status("fn"), "added");
    assert.equal(status("was:lb"), "removed");
    assert.equal(status("was:vm"), "removed");
    assert.equal(status("users"), "kept");
    assert.deepEqual(d.counts, { kept: 0, changed: 1, added: 2, removed: 2 }, "users are not counted; the DB is 'changed' because its cost moved");
    assert.ok(d.edges.some((e) => e.from === "was:vm" && e.to === "n-db" && e.status === "removed"));
    assert.ok(d.edges.some((e) => e.from === "fn" && e.to === "n-db" && e.status === "added"));
    // Costs are linked: 14 × m5.4xlarge on the removed EC2 node, the handler function on "fn".
    assert.ok(d.nodes.find((n) => n.id === "was:vm")!.costBefore! > 7000);
    assert.ok(d.nodes.find((n) => n.id === "fn")!.costAfter! > 0);
    assert.deepEqual(d.notDrawnBefore.map((c) => c.id), ["egress"]);
  });

  it("matches clones from custom proposals by origin and ids by kind + cloud", () => {
    const cur = spec([{ id: "vm-1", label: "EC2", sublabel: "m5.2xlarge", icon: "vm", layer: 3, provider: "aws", count: 10 }], [], [{ id: "vm-1", kind: "compute.vm", provider: "aws", label: "web", sku: "m5.2xlarge", usage: { count: 10 } }]);
    const pro = spec([{ id: "vm-1~7", label: "EC2", sublabel: "m7g.xlarge", icon: "vm", layer: 3, provider: "aws", count: 10 }], [], [{ id: "vm-1~7", kind: "compute.vm", provider: "aws", label: "web", sku: "m7g.xlarge", usage: { count: 10 } }]);
    const d = diffArchitectures(cur, pro);
    assert.equal(d.nodes.length, 1);
    assert.equal(d.nodes[0].status, "changed");
    assert.ok(d.nodes[0].costAfter! < d.nodes[0].costBefore!);
    const k8s = diffArchitectures(
      spec([{ id: "pool", label: "Node pool", icon: "vm", layer: 1, provider: "azure", count: 12 }], [], []),
      spec(
        [
          { id: "od", label: "On-demand pool", icon: "vm", layer: 1, provider: "azure", count: 3 },
          { id: "spot", label: "Spot pool", icon: "vm", layer: 1, provider: "azure", count: 4 },
        ],
        [],
        [],
      ),
    );
    assert.deepEqual(k8s.nodes.map((n) => [n.id, n.status]), [
      ["od", "changed"],
      ["spot", "added"],
    ]);
  });

  it("assigns each priced component to at most one node", () => {
    const a = analyzeHeuristically(
      parseArchitectureText("20 m6i.2xlarge web tier behind an ALB, 6 r6i.4xlarge running self-managed Redis, Aurora Postgres, 200 TB in S3, NAT gateway, 1.2 billion requests/month, spiky").components,
      { trafficPattern: "spiky", stateless: true, interruptible: false, latencySensitive: false, requestsPerMonthM: 1200 },
    );
    for (const p of [{ components: a.current.components }, ...a.proposals]) {
      const d = autoDiagram(p.components);
      const { byNode, notDrawn } = linkNodeCosts({ nodes: d.nodes, components: p.components });
      const linked = [...byNode.values()].flatMap((v) => v.components.map((c) => c.id));
      assert.equal(new Set(linked).size, linked.length, "a component was linked twice");
      const total = [...byNode.values()].reduce((s, v) => s + v.cost, 0) + notDrawn.reduce((s, c) => s + c.monthlyCost, 0);
      const expected = p.components.reduce((s, c) => s + c.monthlyCost, 0);
      assert.ok(Math.abs(total - expected) < 0.05, `linked ${total} vs total ${expected}`);
    }
  });
});
