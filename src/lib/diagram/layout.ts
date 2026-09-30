/**
 * Layered architecture-diagram layout with cloud boundaries and orthogonal
 * edge routing. Pure and deterministic.
 *
 * Guarantees (enforced by tests/diagram.test.ts):
 *  - nodes never overlap; every node of a cloud sits inside that cloud's box;
 *  - cloud boxes never overlap (each cloud gets its own column);
 *  - edges are axis-aligned and never pass through a node;
 *  - many-to-many edges between two tiers merge into a single "bus".
 *
 * Pipeline: rows by layer → columns by cloud → crossing reduction
 * (barycenter sweeps) → x placement → edge planning (lanes live in the gaps
 * between rows) → lane packing → y placement → point materialisation.
 */

export interface LayoutNodeInput {
  id: string;
  layer: number;
  /** Cloud the node belongs to; a cloud's nodes share a column and a boundary box. */
  group?: string;
  /** Drawn as a stack of cards (count > 1): reserve room for the offset. */
  stack?: boolean;
}

export interface LayoutEdgeInput {
  id: string;
  from: string;
  to: string;
}

export interface LayoutOptions {
  nodeW: number;
  nodeH: number;
  /** Horizontal gap between nodes in the same row. */
  gapX: number;
  /** Minimum vertical gap between rows (grows with the number of edge lanes). */
  gapY: number;
  /** Gap between cloud columns. */
  colGap: number;
  groupPad: number;
  /** Distance from a cloud box's top border to its first row (the header chip lives here). */
  groupTop: number;
  marginX: number;
  marginY: number;
  /** Left gutter reserved for tier (lane) labels; 0 disables it. */
  laneGutter: number;
  /** Minimum canvas width; content is centred inside it. */
  minWidth: number;
  stackOffset: number;
  /** Break rows that are too wide for `minWidth` onto extra sub-rows. */
  wrap: boolean;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeW: 204,
  nodeH: 68,
  gapX: 28,
  gapY: 56,
  colGap: 48,
  groupPad: 18,
  groupTop: 30,
  marginX: 16,
  marginY: 16,
  laneGutter: 0,
  minWidth: 0,
  stackOffset: 8,
  wrap: false,
};

export const COMPACT_LAYOUT: Partial<LayoutOptions> = { nodeW: 158, nodeH: 64, gapX: 16, colGap: 28, groupPad: 12 };

export interface Point {
  x: number;
  y: number;
}

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  column: string;
  stack: boolean;
}

export interface RoutedEdge {
  id: string;
  from: string;
  to: string;
  points: Point[];
  labelAt: Point;
}

export interface GroupBox {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RowInfo {
  row: number;
  layer: number;
  y: number;
  ids: string[];
}

export interface Layout {
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: RoutedEdge[];
  groups: GroupBox[];
  rows: RowInfo[];
  options: LayoutOptions;
}

const FREE = "__free";
const EXT = "__ext";
const LANE_STEP = 14;
const LANE_TOP = 22;
const CLEARANCE = 12;

export function layoutDiagram(inputNodes: LayoutNodeInput[], inputEdges: LayoutEdgeInput[], options: Partial<LayoutOptions> = {}): Layout {
  const o: LayoutOptions = { ...DEFAULT_LAYOUT, ...options };
  let nodes = inputNodes;
  let result = layoutOnce(nodes, inputEdges, o);
  // Row wrapping: move the right half of the widest row onto a sub-row until the diagram fits.
  for (let i = 0; o.wrap && o.minWidth > 0 && result.width > o.minWidth + 1 && i < 8; i++) {
    const cells = new Map<string, typeof result.nodes>();
    for (const n of result.nodes) cells.set(`${n.row}|${n.column}`, [...(cells.get(`${n.row}|${n.column}`) ?? []), n]);
    const widest = [...cells.values()].sort((a, b) => b.length - a.length)[0];
    if (!widest || widest.length < 2) break;
    const moved = new Set([...widest].sort((a, b) => a.x - b.x).slice(Math.ceil(widest.length / 2)).map((n) => n.id));
    const layer = result.rows[widest[0].row].layer;
    const next = result.rows[widest[0].row + 1]?.layer ?? layer + 1;
    const sub = layer + (next - layer) / 2;
    nodes = nodes.map((n) => (moved.has(n.id) ? { ...n, layer: sub } : n));
    result = layoutOnce(nodes, inputEdges, o);
  }
  return result;
}

function layoutOnce(inputNodes: LayoutNodeInput[], inputEdges: LayoutEdgeInput[], o: LayoutOptions): Layout {
  const W = o.nodeW;
  const H = o.nodeH;

  /* ---- sanitize ---- */
  const seen = new Set<string>();
  const nodes = inputNodes.filter((n) => Number.isFinite(n.layer) && (seen.has(n.id) ? false : (seen.add(n.id), true)));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edgeKeys = new Set<string>();
  const edges = inputEdges.filter((e) => {
    if (!index.has(e.from) || !index.has(e.to) || e.from === e.to) return false;
    const k = `${e.from}→${e.to}`;
    if (edgeKeys.has(k)) return false;
    edgeKeys.add(k);
    return true;
  });
  if (!nodes.length) return { width: o.minWidth, height: 0, nodes: [], edges: [], groups: [], rows: [], options: o };

  /* ---- rows ---- */
  const layers = [...new Set(nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const row = new Map(nodes.map((n) => [n.id, layers.indexOf(n.layer)]));
  const nRows = layers.length;
  const stack = new Map(nodes.map((n) => [n.id, Boolean(n.stack)]));
  const rowMembers: string[][] = Array.from({ length: nRows }, () => []);
  for (const n of nodes) rowMembers[row.get(n.id)!].push(n.id);

  /* ---- columns: one per cloud (first-appearance order) + an external column ---- */
  const groupOrder: string[] = [];
  [...nodes]
    .sort((a, b) => row.get(a.id)! - row.get(b.id)! || index.get(a.id)! - index.get(b.id)!)
    .forEach((n) => {
      if (n.group && !groupOrder.includes(n.group)) groupOrder.push(n.group);
    });
  const groupSpan = new Map<string, [number, number]>();
  for (const n of nodes) {
    if (!n.group) continue;
    const r = row.get(n.id)!;
    const s = groupSpan.get(n.group);
    groupSpan.set(n.group, s ? [Math.min(s[0], r), Math.max(s[1], r)] : [r, r]);
  }
  const rowHasGroup = (r: number) => rowMembers[r].some((id) => nodes[index.get(id)!].group);
  const insideSpan = (r: number) => [...groupSpan.values()].some(([a, b]) => r > a && r < b);
  const column = new Map<string, string>();
  for (const n of nodes) {
    const r = row.get(n.id)!;
    column.set(n.id, n.group ?? (rowHasGroup(r) || insideSpan(r) ? EXT : FREE));
  }
  const columns = [...groupOrder, ...(nodes.some((n) => column.get(n.id) === EXT) ? [EXT] : [])];
  const isGroup = (c: string) => c !== EXT && c !== FREE;

  /* ---- cells ---- */
  const cellKey = (r: number, c: string) => `${r}|${c}`;
  const order = new Map<string, string[]>();
  for (const n of nodes) {
    const k = cellKey(row.get(n.id)!, column.get(n.id)!);
    order.set(k, [...(order.get(k) ?? []), n.id]);
  }
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of edges) {
    succs.set(e.from, [...(succs.get(e.from) ?? []), e.to]);
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  }

  const cellW = (k: number) => (k <= 0 ? 0 : k * W + (k - 1) * o.gapX);
  const rightEdge = (id: string, x: number) => x + W + (stack.get(id) ? o.stackOffset : 0);

  interface Placement {
    x: Map<string, number>;
    width: number;
    colX: Map<string, number>;
    outer: Map<string, number>;
  }

  const place = (): Placement => {
    const inner = new Map<string, number>();
    const outer = new Map<string, number>();
    for (const c of columns) {
      let w = W;
      for (let r = 0; r < nRows; r++) w = Math.max(w, cellW(order.get(cellKey(r, c))?.length ?? 0));
      inner.set(c, w + o.stackOffset);
      outer.set(c, w + o.stackOffset + (isGroup(c) ? 2 * o.groupPad : 0));
    }
    const columnsW = columns.reduce((s, c) => s + outer.get(c)!, 0) + Math.max(0, columns.length - 1) * o.colGap;
    let freeW = 0;
    for (let r = 0; r < nRows; r++) freeW = Math.max(freeW, cellW(order.get(cellKey(r, FREE))?.length ?? 0) + o.stackOffset);
    const contentW = Math.max(columnsW, freeW, W);
    const left = o.marginX + o.laneGutter;
    const natural = left + contentW + o.marginX;
    const width = Math.max(o.minWidth, natural);
    const contentLeft = left + (width - natural) / 2;
    const x = new Map<string, number>();
    const colX = new Map<string, number>();
    let cursor = contentLeft + (contentW - columnsW) / 2;
    for (const c of columns) {
      colX.set(c, cursor);
      cursor += outer.get(c)! + o.colGap;
    }
    for (let r = 0; r < nRows; r++) {
      for (const c of columns) {
        const ids = order.get(cellKey(r, c)) ?? [];
        const start = colX.get(c)! + (isGroup(c) ? o.groupPad : 0) + (inner.get(c)! - o.stackOffset - cellW(ids.length)) / 2;
        ids.forEach((id, i) => x.set(id, start + i * (W + o.gapX)));
      }
    }
    // Free rows (e.g. "Users"): centre the block over the nodes it connects to.
    for (let r = 0; r < nRows; r++) {
      const ids = order.get(cellKey(r, FREE)) ?? [];
      if (!ids.length) continue;
      const centers = ids
        .flatMap((id) => [...(preds.get(id) ?? []), ...(succs.get(id) ?? [])])
        .filter((n) => x.has(n))
        .map((n) => x.get(n)! + W / 2);
      const mid = centers.length ? centers.reduce((a, b) => a + b, 0) / centers.length : contentLeft + contentW / 2;
      const blockW = cellW(ids.length);
      const start = Math.min(Math.max(mid - blockW / 2, contentLeft), contentLeft + contentW - blockW - o.stackOffset);
      ids.forEach((id, i) => x.set(id, start + i * (W + o.gapX)));
    }
    return { x, width, colX, outer };
  };

  /* ---- crossing reduction: barycenter sweeps ---- */
  let p = place();
  for (let iter = 0; iter < 6; iter++) {
    const down = iter % 2 === 0;
    const rowsToVisit = [...Array(nRows).keys()];
    if (!down) rowsToVisit.reverse();
    for (const r of rowsToVisit) {
      for (const c of [...columns, FREE]) {
        const k = cellKey(r, c);
        const ids = order.get(k);
        if (!ids || ids.length < 2) continue;
        const key = (id: string) => {
          const primary = ((down ? preds : succs).get(id) ?? []).filter((n) => row.get(n) !== r);
          const nb = primary.length ? primary : [...(preds.get(id) ?? []), ...(succs.get(id) ?? [])];
          const xs = nb.map((n) => p.x.get(n)! + W / 2);
          return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : p.x.get(id)! + W / 2;
        };
        const keyed = ids.map((id, i) => ({ id, i, k: key(id) }));
        keyed.sort((a, b) => a.k - b.k || a.i - b.i);
        const ordered = keyed.map((e) => e.id);
        // Pull nodes connected within the row next to each other (avoids detours under other nodes).
        for (const e of edges) {
          const i = ordered.indexOf(e.from);
          const j = ordered.indexOf(e.to);
          if (i < 0 || j < 0 || Math.abs(i - j) <= 1) continue;
          const [a, b] = i < j ? [i, j] : [j, i];
          const [moved] = ordered.splice(b, 1);
          ordered.splice(a + 1, 0, moved);
        }
        order.set(k, ordered);
      }
      p = place();
    }
  }
  const X = p.x;
  const cx = (id: string) => X.get(id)! + W / 2;

  /* ---- edge planning (x only) ---- */
  const occupiedIn = (r: number) => rowMembers[r].map((id) => [X.get(id)! - CLEARANCE, rightEdge(id, X.get(id)!) + CLEARANCE] as [number, number]);
  const blocked = (x: number, r1: number, r2: number) => {
    for (let r = r1; r <= r2; r++) for (const [a, b] of occupiedIn(r)) if (x > a && x < b) return true;
    return false;
  };
  const gutter = (r1: number, r2: number, prefer: number) => {
    let free: [number, number][] = [[o.laneGutter + 6, p.width - 6]];
    for (let r = r1; r <= r2; r++) {
      for (const [a, b] of occupiedIn(r)) {
        free = free.flatMap(([s, e]) => {
          if (b <= s || a >= e) return [[s, e] as [number, number]];
          const parts: [number, number][] = [];
          if (a > s) parts.push([s, a]);
          if (b < e) parts.push([b, e]);
          return parts;
        });
      }
    }
    let best = p.width - 6;
    let bestCost = Infinity;
    for (const [s, e] of free) {
      if (e - s < 2) continue;
      const x = Math.min(Math.max(prefer, s + 1), e - 1);
      const cost = Math.abs(x - prefer);
      if (cost < bestCost) {
        bestCost = cost;
        best = x;
      }
    }
    return best;
  };

  type Kind = "straight" | "simple" | "jog" | "adjacent" | "detour";
  interface Plan {
    e: LayoutEdgeInput;
    reversed: boolean;
    kind: Kind;
    u: string;
    v: string;
    gx?: number;
  }
  interface Seg {
    gap: number;
    x1: number;
    x2: number;
    source: string;
    target: string;
    key: string;
  }
  const segs: Seg[] = [];
  const plans: Plan[] = edges.map((e) => {
    let u = e.from;
    let v = e.to;
    let reversed = false;
    if (row.get(u)! > row.get(v)!) {
      [u, v] = [v, u];
      reversed = true;
    }
    const ru = row.get(u)!;
    const rv = row.get(v)!;
    const sx = cx(u);
    const tx = cx(v);
    if (ru === rv) {
      const [a, b] = X.get(u)! < X.get(v)! ? [u, v] : [v, u];
      const between = rowMembers[ru].some((id) => id !== u && id !== v && X.get(id)! > X.get(a)! && X.get(id)! < X.get(b)!);
      if (!between) return { e, reversed, kind: "adjacent" as const, u, v };
      segs.push({ gap: ru + 1, x1: Math.min(sx, tx), x2: Math.max(sx, tx), source: `detour:${e.id}`, target: `detour:${e.id}`, key: `${e.id}:0` });
      return { e, reversed, kind: "detour" as const, u, v };
    }
    if (!blocked(sx, ru + 1, rv - 1)) {
      if (Math.abs(sx - tx) < 0.5) return { e, reversed, kind: "straight" as const, u, v };
      segs.push({ gap: rv, x1: Math.min(sx, tx), x2: Math.max(sx, tx), source: u, target: v, key: `${e.id}:0` });
      return { e, reversed, kind: "simple" as const, u, v };
    }
    const gx = gutter(ru + 1, rv - 1, (sx + tx) / 2);
    segs.push({ gap: ru + 1, x1: Math.min(sx, gx), x2: Math.max(sx, gx), source: u, target: `jog:${e.id}`, key: `${e.id}:0` });
    segs.push({ gap: rv, x1: Math.min(gx, tx), x2: Math.max(gx, tx), source: `jog:${e.id}`, target: v, key: `${e.id}:1` });
    return { e, reversed, kind: "jog" as const, u, v, gx };
  });

  /* ---- lane packing per gap (fan-outs, fan-ins and dense many-to-many share one lane: a bus) ---- */
  const lane = new Map<string, number>();
  const laneCount = new Map<number, number>();
  for (const g of [...new Set(segs.map((s) => s.gap))].sort((a, b) => a - b)) {
    const gs = segs.filter((s) => s.gap === g);
    const parent = gs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        if (gs[i].source === gs[j].source || gs[i].target === gs[j].target) parent[find(i)] = find(j);
      }
    }
    const comps = new Map<number, Seg[]>();
    gs.forEach((s, i) => comps.set(find(i), [...(comps.get(find(i)) ?? []), s]));
    const bundles: { members: Seg[]; x1: number; x2: number }[] = [];
    const bundle = (members: Seg[]) => ({ members, x1: Math.min(...members.map((m) => m.x1)), x2: Math.max(...members.map((m) => m.x2)) });
    for (const members of comps.values()) {
      const S = new Set(members.map((m) => m.source));
      const T = new Set(members.map((m) => m.target));
      if (S.size === 1 || T.size === 1 || members.length >= 0.6 * S.size * T.size) bundles.push(bundle(members));
      else for (const s of S) bundles.push(bundle(members.filter((m) => m.source === s)));
    }
    bundles.sort((a, b) => a.x1 - b.x1 || b.x2 - a.x2);
    const lanes: [number, number][][] = [];
    for (const b of bundles) {
      let li = lanes.findIndex((iv) => iv.every(([s, e]) => b.x2 + 16 < s || b.x1 - 16 > e));
      if (li < 0) {
        lanes.push([]);
        li = lanes.length - 1;
      }
      lanes[li].push([b.x1, b.x2]);
      for (const m of b.members) lane.set(m.key, li);
    }
    laneCount.set(g, lanes.length);
  }

  /* ---- y placement ---- */
  const groupStarts = new Set([...groupSpan.values()].map(([a]) => a));
  const rowHasStack = (r: number) => rowMembers[r].some((id) => stack.get(id));
  const reserve = (r: number) => (groupStarts.has(r) ? o.groupTop + 10 : 0);
  const laneSpace = (g: number) => Math.max(o.gapY, 40 + LANE_STEP * (laneCount.get(g) ?? 0));
  const rowY: number[] = [];
  const rowBottom = (r: number) => rowY[r] + H + (rowHasStack(r) ? o.stackOffset : 0);
  for (let r = 0; r < nRows; r++) rowY[r] = r === 0 ? o.marginY + reserve(0) : rowBottom(r - 1) + laneSpace(r) + reserve(r);
  const laneY = (g: number, li: number) => rowBottom(g - 1) + LANE_TOP + li * LANE_STEP;

  const positioned: PositionedNode[] = nodes.map((n) => ({
    id: n.id,
    x: X.get(n.id)!,
    y: rowY[row.get(n.id)!],
    w: W,
    h: H,
    row: row.get(n.id)!,
    column: column.get(n.id)!,
    stack: stack.get(n.id)!,
  }));
  const P = new Map(positioned.map((n) => [n.id, n]));
  const bottomOf = (id: string) => P.get(id)!.y + H + (stack.get(id) ? o.stackOffset : 0);

  /* ---- materialise edges ---- */
  const routed: RoutedEdge[] = plans.map((pl) => {
    const u = P.get(pl.u)!;
    const v = P.get(pl.v)!;
    const sx = u.x + W / 2;
    const tx = v.x + W / 2;
    let pts: Point[];
    switch (pl.kind) {
      case "straight":
        pts = [{ x: sx, y: bottomOf(u.id) }, { x: tx, y: v.y }];
        break;
      case "simple": {
        const L = laneY(v.row, lane.get(`${pl.e.id}:0`) ?? 0);
        pts = [{ x: sx, y: bottomOf(u.id) }, { x: sx, y: L }, { x: tx, y: L }, { x: tx, y: v.y }];
        break;
      }
      case "jog": {
        const L1 = laneY(u.row + 1, lane.get(`${pl.e.id}:0`) ?? 0);
        const L2 = laneY(v.row, lane.get(`${pl.e.id}:1`) ?? 0);
        pts = [{ x: sx, y: bottomOf(u.id) }, { x: sx, y: L1 }, { x: pl.gx!, y: L1 }, { x: pl.gx!, y: L2 }, { x: tx, y: L2 }, { x: tx, y: v.y }];
        break;
      }
      case "adjacent": {
        const cy = u.y + H / 2;
        pts = u.x < v.x ? [{ x: rightEdge(u.id, u.x), y: cy }, { x: v.x, y: cy }] : [{ x: u.x, y: cy }, { x: rightEdge(v.id, v.x), y: cy }];
        break;
      }
      case "detour": {
        // Attach off-centre so the detour never overlaps edges leaving a node's bottom centre.
        const L = laneY(u.row + 1, lane.get(`${pl.e.id}:0`) ?? 0);
        const dir = tx >= sx ? 1 : -1;
        const off = Math.min(18, W / 4);
        pts = [{ x: sx + dir * off, y: bottomOf(u.id) }, { x: sx + dir * off, y: L }, { x: tx - dir * off, y: L }, { x: tx - dir * off, y: bottomOf(v.id) }];
        break;
      }
    }
    if (pl.reversed) pts.reverse();
    pts = simplify(pts);
    return { id: pl.e.id, from: pl.e.from, to: pl.e.to, points: pts, labelAt: labelPoint(pts) };
  });

  /* ---- cloud boxes ---- */
  const groups: GroupBox[] = groupOrder.map((g) => {
    const members = positioned.filter((n) => n.column === g);
    const top = Math.min(...members.map((n) => n.y)) - o.groupTop;
    const bottom = Math.max(...members.map((n) => bottomOf(n.id))) + o.groupPad;
    return { key: g, x: p.colX.get(g)!, y: top, w: p.outer.get(g)!, h: bottom - top };
  });

  const detourBottom = plans.filter((pl) => pl.kind === "detour").map((pl) => laneY(P.get(pl.u)!.row + 1, lane.get(`${pl.e.id}:0`) ?? 0));
  const contentBottom = Math.max(...positioned.map((n) => bottomOf(n.id)), ...groups.map((g) => g.y + g.h), ...detourBottom);
  return {
    width: p.width,
    height: contentBottom + o.marginY,
    nodes: positioned,
    edges: routed,
    groups,
    rows: layers.map((layer, r) => ({ row: r, layer, y: rowY[r], ids: rowMembers[r] })),
    options: o,
  };
}

/** Remove duplicate and collinear points so corners can be rounded cleanly. */
function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - q.x) < 0.01 && Math.abs(last.y - q.y) < 0.01) continue;
    out.push(q);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const collinear = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
    if (collinear) out.splice(i, 1);
  }
  return out;
}

/**
 * Label anchor: the longest horizontal run (it lives in a gap between rows, so
 * it never collides with nodes or cloud header chips); otherwise the segment
 * nearest the target that is long enough, else the longest segment.
 */
function labelPoint(pts: Point[]): Point {
  const segs = pts.slice(1).map((q, i) => ({ a: pts[i], b: q, len: Math.abs(q.x - pts[i].x) + Math.abs(q.y - pts[i].y), horizontal: Math.abs(q.y - pts[i].y) < 0.01 }));
  const horizontal = segs.filter((s) => s.horizontal && s.len >= 72).sort((a, b) => b.len - a.len)[0];
  const pick = horizontal ?? [...segs].reverse().find((s) => s.len >= 30) ?? segs.reduce((m, s) => (s.len > m.len ? s : m), segs[0]);
  return { x: (pick.a.x + pick.b.x) / 2, y: (pick.a.y + pick.b.y) / 2 };
}

/** SVG path through orthogonal points with rounded corners. */
export function roundedPath(pts: Point[], radius = 10): string {
  if (pts.length < 2) return "";
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) {
      d += ` L${f(p1.x)} ${f(p1.y)}`;
      continue;
    }
    const a = { x: p1.x + ((p0.x - p1.x) / d1) * r, y: p1.y + ((p0.y - p1.y) / d1) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / d2) * r, y: p1.y + ((p2.y - p1.y) / d2) * r };
    d += ` L${f(a.x)} ${f(a.y)} Q${f(p1.x)} ${f(p1.y)} ${f(b.x)} ${f(b.y)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${f(last.x)} ${f(last.y)}`;
}

const LANE_OF_ICON: Record<string, string> = {
  users: "Clients",
  internet: "Internet",
  cdn: "Edge",
  api: "Edge",
  lb: "Edge",
  vm: "Compute",
  function: "Compute",
  container: "Compute",
  app: "Compute",
  k8s: "Control plane",
  queue: "Messaging",
  cache: "State",
  nat: "Network",
  endpoint: "Network",
  ip: "Network",
  db: "Data",
  storage: "Data",
  disk: "Data",
  analytics: "Analytics",
  logs: "Observability",
  other: "Other",
};

/** Human tier name for a row, from the kinds of components in it. */
export function laneName(icons: string[]): string {
  const counts = new Map<string, number>();
  for (const i of icons) {
    const name = LANE_OF_ICON[i] ?? "Other";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  return ranked.slice(0, 2).join(" · ");
}
