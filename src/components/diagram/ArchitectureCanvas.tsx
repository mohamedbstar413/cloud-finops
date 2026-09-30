"use client";

import {
  Box,
  Boxes,
  ChartColumn,
  CircleDollarSign,
  Container,
  Database,
  Globe,
  HardDrive,
  Inbox,
  Layers,
  ListChecks,
  Network,
  Package,
  Radio,
  Route,
  Router,
  Server,
  Split,
  Users,
  Waypoints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProviderLogo } from "@/components/ProviderLogo";
import type { EdgeStatus, NodeStatus } from "@/lib/diagram/diff";
import { COMPACT_LAYOUT, laneName, layoutDiagram, roundedPath, type PositionedNode } from "@/lib/diagram/layout";
import type { DiagramEdge, DiagramNode } from "@/lib/engine/types";
import { PROVIDER_COLOR, PROVIDER_NAME } from "@/lib/format";
import type { Provider } from "@/lib/pricing/catalog";
import type { IconKey, PricedComponent } from "@/lib/pricing/components";

export interface CanvasNode extends DiagramNode {
  status?: NodeStatus;
  cost?: number;
  costBefore?: number;
  components?: PricedComponent[];
  before?: DiagramNode;
}

export interface CanvasEdge extends DiagramEdge {
  status?: EdgeStatus;
  beforeLabel?: string;
}

export interface CanvasHandle {
  svg(): SVGSVGElement | null;
}

const ICONS: Record<IconKey, { icon: LucideIcon; color: string; bg: string }> = {
  users: { icon: Users, color: "#475569", bg: "#eef2f6" },
  internet: { icon: Globe, color: "#475569", bg: "#eef2f6" },
  lb: { icon: Split, color: "#7c3aed", bg: "#f2eefe" },
  api: { icon: Waypoints, color: "#7c3aed", bg: "#f2eefe" },
  cdn: { icon: Radio, color: "#7c3aed", bg: "#f2eefe" },
  nat: { icon: Router, color: "#7c3aed", bg: "#f2eefe" },
  endpoint: { icon: Route, color: "#7c3aed", bg: "#f2eefe" },
  ip: { icon: Network, color: "#7c3aed", bg: "#f2eefe" },
  vm: { icon: Server, color: "#ea580c", bg: "#fff1e8" },
  function: { icon: Zap, color: "#ea580c", bg: "#fff1e8" },
  container: { icon: Container, color: "#ea580c", bg: "#fff1e8" },
  k8s: { icon: Boxes, color: "#2563eb", bg: "#eaf1ff" },
  queue: { icon: Inbox, color: "#db2777", bg: "#fdeef6" },
  db: { icon: Database, color: "#2563eb", bg: "#eaf1ff" },
  storage: { icon: Package, color: "#16a34a", bg: "#eafaf0" },
  disk: { icon: HardDrive, color: "#16a34a", bg: "#eafaf0" },
  cache: { icon: Layers, color: "#dc2626", bg: "#fdeeee" },
  analytics: { icon: ChartColumn, color: "#0891b2", bg: "#e8f8fb" },
  logs: { icon: ListChecks, color: "#64748b", bg: "#f1f4f8" },
  app: { icon: Box, color: "#0891b2", bg: "#e8f8fb" },
  other: { icon: CircleDollarSign, color: "#64748b", bg: "#f1f4f8" },
};

const STATUS: Partial<Record<NodeStatus, { stroke: string; pillBg: string; pillFg: string; text: string }>> = {
  added: { stroke: "#22c55e", pillBg: "#dcfce7", pillFg: "#15803d", text: "NEW" },
  removed: { stroke: "#f87171", pillBg: "#fee2e2", pillFg: "#b91c1c", text: "REMOVED" },
  changed: { stroke: "#f59e0b", pillBg: "#fef3c7", pillFg: "#b45309", text: "CHANGED" },
};

const EDGE_COLOR = { neutral: "#9aa8ba", flow: "#f97316", added: "#22c55e", removed: "#f87171", focus: "#2563eb" } as const;
type EdgeTone = keyof typeof EDGE_COLOR;

export const money = (n: number, compact = false) => {
  const abs = Math.abs(n);
  if (compact && abs >= 1000) return `${n < 0 ? "−" : ""}$${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${n < 0 ? "−" : ""}$${Math.round(abs).toLocaleString("en-US")}`;
};

/* ------------------------------------------------------------------------- */
/* Text measurement (canvas, with the page's real font)                      */
/* ------------------------------------------------------------------------- */

function useMeasure() {
  const cache = useRef<{ ctx: CanvasRenderingContext2D | null; family: string } | null>(null);
  return useCallback((text: string, size: number, weight = 400) => {
    if (typeof document === "undefined") return text.length * size * 0.56;
    if (!cache.current) {
      cache.current = { ctx: document.createElement("canvas").getContext("2d"), family: getComputedStyle(document.body).fontFamily || "sans-serif" };
    }
    const { ctx, family } = cache.current;
    if (!ctx) return text.length * size * 0.56;
    ctx.font = `${weight} ${size}px ${family}`;
    return ctx.measureText(text).width;
  }, []);
}

type Measure = ReturnType<typeof useMeasure>;

function fit(measure: Measure, text: string, maxW: number, size: number, weight = 400): string {
  if (maxW <= 0) return "";
  if (measure(text, size, weight) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid).trimEnd()}…`, size, weight) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : "";
}

/** Break a label into at most two lines, preferring separators (space / - . _ :). */
function wrap2(measure: Measure, text: string, maxW: number, size: number, weight = 400): string[] {
  if (measure(text, size, weight) <= maxW) return [text];
  let cut = -1;
  for (let i = 1; i < text.length; i++) {
    if (/[\s/\-._:]/.test(text[i - 1]) && measure(text.slice(0, i).trimEnd(), size, weight) <= maxW) cut = i;
  }
  if (cut < 0) {
    cut = text.length;
    while (cut > 1 && measure(text.slice(0, cut), size, weight) > maxW) cut--;
  }
  return [text.slice(0, cut).trimEnd(), fit(measure, text.slice(cut).trimStart(), maxW, size, weight)].filter(Boolean);
}

/** Drop what the cloud boundary already says ("AWS EC2" → "EC2", sublabel "GCP" → none). */
function displayText(n: CanvasNode): { label: string; sublabel?: string } {
  const cloud = n.provider ? PROVIDER_NAME[n.provider] : undefined;
  let label = n.label;
  if (cloud && label.startsWith(`${cloud} `) && label.length > cloud.length + 1) label = label.slice(cloud.length + 1);
  const sublabel = n.sublabel && cloud && n.sublabel.trim().toLowerCase() === cloud.toLowerCase() ? undefined : n.sublabel;
  return { label, sublabel };
}

/* ------------------------------------------------------------------------- */
/* Canvas                                                                    */
/* ------------------------------------------------------------------------- */

interface Props {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Accessible description of the diagram. */
  label: string;
  /** Show tier labels in a left gutter when the canvas is wide enough. */
  lanes?: boolean;
  /** Smallest zoom before the canvas scrolls horizontally instead. */
  minScale?: number;
}

export const ArchitectureCanvas = forwardRef<CanvasHandle, Props>(function ArchitectureCanvas({ nodes, edges, label, lanes = false, minScale = 0.8 }, ref) {
  const uid = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const measure = useMeasure();
  useImperativeHandle(ref, () => ({ svg: () => svgRef.current }), []);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edgeId = (e: DiagramEdge) => `${e.from}->${e.to}`;
  const edgeById = useMemo(() => new Map(edges.map((e) => [edgeId(e), e])), [edges]);

  const computed = useMemo(() => {
    if (!width) return null;
    const inputs = nodes.map((n) => ({ id: n.id, layer: n.layer, group: n.provider, stack: (n.count ?? 1) > 1 }));
    const es = edges.map((e) => ({ id: edgeId(e), from: e.from, to: e.to }));
    const gutter = lanes && width >= 720 ? 96 : 0;
    let layout = layoutDiagram(inputs, es, { minWidth: width, laneGutter: gutter });
    let compact = false;
    if (layout.width > width + 1) {
      layout = layoutDiagram(inputs, es, { ...COMPACT_LAYOUT, minWidth: width, laneGutter: gutter, wrap: true });
      compact = true;
    }
    return { layout, compact, gutter };
  }, [nodes, edges, width, lanes]);

  if (!width || !computed) {
    return <div ref={wrapRef} className="h-[320px] w-full animate-pulse-soft rounded-lg bg-slate-50" aria-hidden />;
  }

  const { layout, compact, gutter } = computed;
  const scale = Math.max(minScale, Math.min(1, width / layout.width));
  const P = new Map(layout.nodes.map((n) => [n.id, n]));

  const neighbours = new Set<string>();
  if (active) {
    neighbours.add(active);
    for (const e of edges) {
      if (e.from === active) neighbours.add(e.to);
      if (e.to === active) neighbours.add(e.from);
    }
  }
  const tone = (e: CanvasEdge): EdgeTone => {
    if (active && (e.from === active || e.to === active)) return "focus";
    if (e.status === "added") return "added";
    if (e.status === "removed") return "removed";
    return e.dashed ? "flow" : "neutral";
  };

  const regionOf = (g: string) => {
    const regions = nodes.filter((n) => n.provider === g && n.region).map((n) => n.region!);
    return regions.length && regions.every((r) => r === regions[0]) ? regions[0] : undefined;
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <div className="relative overflow-x-auto" style={{ height: layout.height * scale }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width * scale}
          height={layout.height * scale}
          role="img"
          aria-label={label}
          style={{ fontFamily: "var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif", display: "block" }}
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <style>{`
              .cpo-flow { stroke-dasharray: 6 5; animation: cpo-flow-${uid} 1.1s linear infinite; }
              @keyframes cpo-flow-${uid} { to { stroke-dashoffset: -22; } }
              @media (prefers-reduced-motion: reduce) { .cpo-flow { animation: none; } }
              .cpo-node, .cpo-edge { transition: opacity .15s ease; }
              .cpo-node { cursor: default; outline: none; }
              .cpo-node:focus-visible .cpo-card { stroke: #2563eb; stroke-width: 2; }
            `}</style>
            <filter id={`shadow-${uid}`} x="-10%" y="-20%" width="120%" height="150%">
              <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#0f172a" floodOpacity="0.06" />
              <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#0f172a" floodOpacity="0.05" />
            </filter>
            {(Object.keys(EDGE_COLOR) as EdgeTone[]).map((t) => (
              <marker key={t} id={`arrow-${t}-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M1 1.5 9 5 1 8.5z" fill={EDGE_COLOR[t]} />
              </marker>
            ))}
          </defs>

          {/* Tier labels */}
          {gutter > 0 &&
            layout.rows.map((r) => (
              <text key={r.row} x={layout.options.marginX} y={r.y + layout.options.nodeH / 2 + 3.5} fontSize={9.5} fontWeight={650} letterSpacing={0.9} fill="#94a3b8">
                {laneName(r.ids.map((id) => byId.get(id)?.icon ?? "other")).toUpperCase()}
              </text>
            ))}

          {/* Cloud boundaries */}
          {layout.groups.map((g) => {
            const color = PROVIDER_COLOR[g.key as Provider] ?? "#64748b";
            const name = PROVIDER_NAME[g.key as Provider] ?? g.key;
            const region = regionOf(g.key);
            const logoW = g.key === "aws" ? 21 : 14;
            const nameW = measure(name, 11, 650);
            const firstRowCenters = layout.nodes.filter((n) => n.column === g.key && Math.abs(n.y - (g.y + layout.options.groupTop)) < 1).map((n) => n.x + n.w / 2);
            const room = Math.min(...firstRowCenters, g.x + g.w) - (g.x + 14) - 18;
            const withRegion = region ? 10 + logoW + 6 + nameW + 6 + measure(`· ${region}`, 10.5) + 10 : 0;
            const chipW = region && withRegion <= room ? withRegion : 10 + logoW + 6 + nameW + 10;
            return (
              <g key={g.key}>
                <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={16} fill={color} fillOpacity={0.035} stroke={color} strokeOpacity={0.45} strokeDasharray="6 5" />
                <g transform={`translate(${g.x + 14}, ${g.y - 10})`}>
                  <rect width={chipW} height={20} rx={10} fill="#fff" stroke={color} strokeOpacity={0.55} />
                  <ProviderLogo provider={g.key as Provider} size={14} x={10} y={3} />
                  <text x={10 + logoW + 6} y={14} fontSize={11} fontWeight={650} fill="#1e293b">
                    {name}
                  </text>
                  {region && withRegion <= room && (
                    <text x={10 + logoW + 6 + nameW + 6} y={14} fontSize={10.5} fill="#64748b">
                      · {region}
                    </text>
                  )}
                </g>
              </g>
            );
          })}

          {/* Edges */}
          {layout.edges.map((le) => {
            const e = edgeById.get(le.id)!;
            const t = tone(e);
            const dim = active && !(e.from === active || e.to === active);
            return (
              <path
                key={le.id}
                className={`cpo-edge ${e.dashed && t !== "removed" ? "cpo-flow" : ""}`}
                d={roundedPath(le.points, 10)}
                fill="none"
                stroke={EDGE_COLOR[t]}
                strokeWidth={t === "focus" ? 2.2 : t === "added" ? 1.9 : 1.6}
                strokeDasharray={t === "removed" ? "4 4" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={dim ? 0.18 : t === "removed" ? 0.85 : 1}
                markerEnd={`url(#arrow-${t}-${uid})`}
              />
            );
          })}

          {/* Edge labels */}
          {layout.edges.map((le) => {
            const e = edgeById.get(le.id)!;
            const text = e.status === "changed" && e.beforeLabel && e.label ? `${e.beforeLabel} → ${e.label}` : e.label;
            if (!text) return null;
            const dim = active && !(e.from === active || e.to === active);
            const w = measure(text, 10, 550) + 14;
            const flow = e.dashed;
            return (
              <g key={`l-${le.id}`} className="cpo-edge" opacity={dim ? 0.18 : 1} transform={`translate(${le.labelAt.x}, ${le.labelAt.y})`}>
                <rect x={-w / 2} y={-9} width={w} height={18} rx={9} fill="#fff" stroke={flow ? "#fed7aa" : "#e2e8f0"} />
                <text y={3.5} textAnchor="middle" fontSize={10} fontWeight={550} fill={flow ? "#c2410c" : "#475569"}>
                  {text}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {layout.nodes.map((p) => (
            <NodeCard
              key={p.id}
              node={byId.get(p.id)!}
              p={p}
              compact={compact}
              measure={measure}
              uid={uid}
              dim={Boolean(active) && !neighbours.has(p.id)}
              stackOffset={layout.options.stackOffset}
              onEnter={() => setActive(p.id)}
              onLeave={() => setActive((a) => (a === p.id ? null : a))}
            />
          ))}
        </svg>
        {active && P.get(active) && <Tooltip node={byId.get(active)!} p={P.get(active)!} scale={scale} canvasW={layout.width * scale} />}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------------- */

function NodeCard({
  node: n,
  p,
  compact,
  measure,
  uid,
  dim,
  stackOffset,
  onEnter,
  onLeave,
}: {
  node: CanvasNode;
  p: PositionedNode;
  compact: boolean;
  measure: Measure;
  uid: string;
  dim: boolean;
  stackOffset: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { w, h } = p;
  const style = ICONS[n.icon] ?? ICONS.other;
  const Icon = style.icon;
  const st = n.status ?? (n.highlight as NodeStatus | undefined);
  const moved = st === "changed" && n.before?.provider && n.provider && n.before.provider !== n.provider;
  const s = st ? (moved ? { ...STATUS.changed!, text: `MOVED FROM ${PROVIDER_NAME[n.before!.provider!]}` } : STATUS[st]) : undefined;
  const removed = st === "removed";
  const pad = compact ? 10 : 12;
  const tile = compact ? 32 : 36;
  const iconSize = compact ? 16 : 18;
  const textX = pad + tile + (compact ? 9 : 11);
  const titleSize = compact ? 11.75 : 12.5;
  const subSize = compact ? 10 : 10.5;
  const pillW = s ? measure(s.text, 8.5, 700) + 12 : 0;
  const count = (n.count ?? 1) > 1 ? n.count! : 0;
  const badge = count ? `×${count}` : "";
  const badgeW = badge ? measure(badge, 10, 650) + 12 : 0;
  const shown = displayText(n);
  const textW = w - textX - pad;

  const sub = shown.sublabel ? fit(measure, shown.sublabel, textW, subSize) : "";
  const cost = costLine(n);
  const costMax = textW - (badge ? badgeW + 6 : 0);
  const costText = cost ? [cost.full, cost.full.replace(/\/mo$/, ""), cost.compact].find((t) => measure(t, subSize, 650) <= costMax) ?? fit(measure, cost.compact, costMax, subSize, 650) : "";
  // Titles may wrap to two lines when the card has room for it (at most three text lines).
  const titleLines = [sub, costText].filter(Boolean).length < 2 ? wrap2(measure, shown.label, textW, titleSize, 650) : [fit(measure, shown.label, textW, titleSize, 650)];

  const lines = titleLines.length + [sub, costText].filter(Boolean).length;
  const lh = compact ? 14 : 15;
  let baseline = h / 2 - ((lines - 1) * lh) / 2 + 4;
  const next = () => {
    const y = baseline;
    baseline += lh;
    return y;
  };
  const describe = [
    n.label,
    n.sublabel,
    count ? `${count} instances` : "",
    n.provider ? PROVIDER_NAME[n.provider] : "",
    st && st !== "kept" ? st : "",
    cost?.full ?? "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <g
      className="cpo-node"
      transform={`translate(${p.x}, ${p.y})`}
      opacity={dim ? 0.35 : 1}
      tabIndex={0}
      role="img"
      aria-label={describe}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      <title>{describe}</title>
      {count > 0 && (
        <>
          <rect x={stackOffset} y={stackOffset} width={w} height={h} rx={12} fill="#fff" stroke="#e2e8f0" />
          <rect x={stackOffset / 2} y={stackOffset / 2} width={w} height={h} rx={12} fill="#fff" stroke="#e2e8f0" />
        </>
      )}
      <rect
        className="cpo-card"
        width={w}
        height={h}
        rx={12}
        fill={removed ? "#fffafa" : "#fff"}
        stroke={s?.stroke ?? "#dfe5ee"}
        strokeWidth={s ? 1.6 : 1}
        strokeDasharray={removed ? "5 4" : undefined}
        filter={removed ? undefined : `url(#shadow-${uid})`}
      />
      <rect x={pad} y={(h - tile) / 2} width={tile} height={tile} rx={compact ? 8 : 9} fill={removed ? "#f1f5f9" : style.bg} />
      <Icon x={pad + (tile - iconSize) / 2} y={(h - iconSize) / 2} width={iconSize} height={iconSize} color={removed ? "#94a3b8" : style.color} strokeWidth={2} />
      {titleLines.map((t, i) => (
        <text key={i} x={textX} y={next()} fontSize={titleSize} fontWeight={650} fill={removed ? "#64748b" : "#0f172a"} textDecoration={removed ? "line-through" : undefined}>
          {t}
        </text>
      ))}
      {sub && (
        <text x={textX} y={next()} fontSize={subSize} fill="#64748b">
          {sub}
        </text>
      )}
      {costText && cost && (
        <text x={textX} y={next()} fontSize={subSize} fontWeight={650} fill={cost.color} style={{ fontVariantNumeric: "tabular-nums" }}>
          {costText}
        </text>
      )}
      {s && (
        <g transform={`translate(${w - pillW - 10}, -7.5)`}>
          <rect width={pillW} height={15} rx={7.5} fill={s.pillBg} stroke={s.stroke} strokeWidth={1} />
          <text x={pillW / 2} y={10.6} textAnchor="middle" fontSize={8.5} fontWeight={700} letterSpacing={0.5} fill={s.pillFg}>
            {s.text}
          </text>
        </g>
      )}
      {badge && (
        <g transform={`translate(${w - pad - badgeW + 4}, ${h - 22})`}>
          <rect width={badgeW} height={15} rx={7.5} fill="#0f172a" />
          <text x={badgeW / 2} y={10.8} textAnchor="middle" fontSize={10} fontWeight={650} fill="#fff">
            {badge}
          </text>
        </g>
      )}
    </g>
  );
}

function costLine(n: CanvasNode): { full: string; compact: string; color: string } | null {
  const before = n.costBefore;
  const after = n.cost;
  if (before === undefined && after === undefined) return null;
  if (n.status === "removed" || after === undefined) {
    const v = before ?? after ?? 0;
    return { full: `${money(v)}/mo`, compact: `${money(v, true)}/mo`, color: n.status === "removed" ? "#b91c1c" : "#334155" };
  }
  if (before !== undefined && Math.abs(before - after) > 0.5) {
    const color = after < before ? "#15803d" : "#b91c1c";
    return { full: `${money(before)} → ${money(after)}/mo`, compact: `${money(before, true)} → ${money(after, true)}`, color };
  }
  return { full: `${money(after)}/mo`, compact: `${money(after, true)}/mo`, color: "#334155" };
}

function Tooltip({ node: n, p, scale, canvasW }: { node: CanvasNode; p: PositionedNode; scale: number; canvasW: number }) {
  const W = 272;
  const center = (p.x + p.w / 2) * scale;
  const left = Math.min(Math.max(center - W / 2, 4), Math.max(4, canvasW - W - 4));
  const above = p.y * scale > 150;
  const top = above ? p.y * scale - 8 : (p.y + p.h) * scale + 12;
  const st = n.status;
  const moved = st === "changed" && n.before?.provider && n.provider && n.before.provider !== n.provider;
  const s = st ? (moved ? { ...STATUS.changed!, text: `MOVED FROM ${PROVIDER_NAME[n.before!.provider!]}` } : STATUS[st]) : undefined;
  const shown = displayText(n);
  const comps = [...(n.components ?? [])].sort((a, b) => b.monthlyCost - a.monthlyCost).slice(0, 4);
  return (
    <div
      className="pointer-events-none absolute z-20 rounded-xl border border-line bg-white p-3 text-[11.5px] shadow-xl"
      style={{ left, top, width: W, transform: above ? "translateY(-100%)" : undefined }}
      role="tooltip"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[12.5px] font-semibold text-ink">{shown.label}</p>
          {shown.sublabel && <p className="text-muted">{shown.sublabel}</p>}
        </div>
        {s && (
          <span className="rounded-full px-1.5 py-px text-[9px] font-bold tracking-wide" style={{ background: s.pillBg, color: s.pillFg }}>
            {s.text}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-muted">
        {[n.provider ? PROVIDER_NAME[n.provider] : null, n.region, (n.count ?? 1) > 1 ? `${n.count} instances` : null].filter(Boolean).join(" · ")}
      </p>
      {st === "changed" && n.before && (n.before.label !== n.label || n.before.sublabel !== n.sublabel) && (
        <p className="mt-1.5 text-muted">
          Was: <span className="text-ink">{[n.before.label, n.before.sublabel].filter(Boolean).join(" · ")}</span>
        </p>
      )}
      {(n.cost !== undefined || n.costBefore !== undefined) && (
        <p className="mt-1.5 font-semibold tabular text-ink">
          {n.costBefore !== undefined && n.cost !== undefined && Math.abs(n.costBefore - n.cost) > 0.5 ? (
            <>
              {money(n.costBefore)} → <span className={n.cost < n.costBefore ? "text-good" : "text-bad"}>{money(n.cost)}</span> /month
            </>
          ) : (
            <>{money(n.cost ?? n.costBefore ?? 0)} /month</>
          )}
        </p>
      )}
      {comps.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-line pt-2">
          {comps.map((c) => (
            <li key={c.id} className="flex justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-ink">{c.label}</span>
                <span className="block truncate text-[10.5px] text-muted">{c.pricingNote}</span>
              </span>
              <span className="shrink-0 tabular text-ink">{money(c.monthlyCost)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
