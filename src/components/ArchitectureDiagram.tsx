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
import type { DiagramEdge, DiagramNode } from "@/lib/engine/types";
import type { IconKey } from "@/lib/pricing/components";

const ICONS: Record<IconKey, { icon: LucideIcon; color: string; bg: string }> = {
  users: { icon: Users, color: "#475569", bg: "#f1f5f9" },
  internet: { icon: Globe, color: "#475569", bg: "#f1f5f9" },
  lb: { icon: Split, color: "#7c3aed", bg: "#f5f3ff" },
  vm: { icon: Server, color: "#ea580c", bg: "#fff7ed" },
  function: { icon: Zap, color: "#ea580c", bg: "#fff7ed" },
  container: { icon: Container, color: "#ea580c", bg: "#fff7ed" },
  k8s: { icon: Boxes, color: "#2563eb", bg: "#eff6ff" },
  api: { icon: Waypoints, color: "#7c3aed", bg: "#f5f3ff" },
  queue: { icon: Inbox, color: "#db2777", bg: "#fdf2f8" },
  db: { icon: Database, color: "#2563eb", bg: "#eff6ff" },
  storage: { icon: Package, color: "#16a34a", bg: "#f0fdf4" },
  disk: { icon: HardDrive, color: "#16a34a", bg: "#f0fdf4" },
  cdn: { icon: Radio, color: "#7c3aed", bg: "#f5f3ff" },
  nat: { icon: Router, color: "#7c3aed", bg: "#f5f3ff" },
  endpoint: { icon: Route, color: "#7c3aed", bg: "#f5f3ff" },
  ip: { icon: Network, color: "#7c3aed", bg: "#f5f3ff" },
  cache: { icon: Layers, color: "#dc2626", bg: "#fef2f2" },
  analytics: { icon: ChartColumn, color: "#0891b2", bg: "#ecfeff" },
  logs: { icon: ListChecks, color: "#64748b", bg: "#f8fafc" },
  app: { icon: Box, color: "#0891b2", bg: "#ecfeff" },
  other: { icon: CircleDollarSign, color: "#64748b", bg: "#f8fafc" },
};

const NODE_W = 124;
const NODE_H = 64;
const GAP_X = 26;
const ROW_H = 108;
const WIDTH = 600;

/** Layered architecture diagram rendered as SVG (works in server components). */
export function ArchitectureDiagram({ nodes, edges, title }: { nodes: DiagramNode[]; edges: DiagramEdge[]; title?: string }) {
  if (!nodes.length) return null;
  const layers = [...new Set(nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, row) => {
    const inRow = nodes.filter((n) => n.layer === layer);
    const total = inRow.length * NODE_W + (inRow.length - 1) * GAP_X;
    const start = (WIDTH - total) / 2;
    inRow.forEach((n, i) => pos.set(n.id, { x: start + i * (NODE_W + GAP_X), y: 16 + row * ROW_H }));
  });
  const height = 16 + layers.length * ROW_H - (ROW_H - NODE_H) + 16;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="h-auto w-full" role="img" aria-label={title ?? "Architecture diagram"}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" fill="#94a3b8" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        let x1: number, y1: number, x2: number, y2: number;
        if (Math.abs(a.y - b.y) < 1) {
          const leftToRight = a.x < b.x;
          x1 = leftToRight ? a.x + NODE_W : a.x;
          x2 = leftToRight ? b.x : b.x + NODE_W;
          y1 = y2 = a.y + NODE_H / 2;
        } else {
          x1 = a.x + NODE_W / 2;
          y1 = a.y + NODE_H + (nodes.find((n) => n.id === e.from)?.count ? 6 : 0);
          x2 = b.x + NODE_W / 2;
          y2 = b.y - 2;
        }
        const midY = (y1 + y2) / 2;
        const d = Math.abs(y1 - y2) < 1 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`;
        return (
          <g key={i}>
            <path d={d} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray={e.dashed ? "5 4" : undefined} markerEnd="url(#arrow)" />
            {e.label && (
              <text x={(x1 + x2) / 2 + 6} y={midY + 3} fontSize={10} fill={e.dashed ? "#dc2626" : "#64748b"}>
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id)!;
        const { icon: Icon, color, bg } = ICONS[n.icon] ?? ICONS.other;
        const outline = n.highlight === "removed" ? "#fca5a5" : n.highlight === "added" ? "#86efac" : n.highlight === "changed" ? "#fcd34d" : "#e2e8f0";
        return (
          <g key={n.id}>
            {n.count && n.count > 1 && (
              <>
                <rect x={p.x + 6} y={p.y + 6} width={NODE_W} height={NODE_H} rx={10} fill="#fff" stroke="#e2e8f0" />
                <rect x={p.x + 3} y={p.y + 3} width={NODE_W} height={NODE_H} rx={10} fill="#fff" stroke="#e2e8f0" />
              </>
            )}
            <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={10} fill="#fff" stroke={outline} strokeWidth={n.highlight ? 1.6 : 1} />
            <rect x={p.x + 8} y={p.y + 8} width={26} height={26} rx={6} fill={bg} />
            <Icon x={p.x + 13} y={p.y + 13} width={16} height={16} color={color} strokeWidth={2} />
            <text x={p.x + 40} y={p.y + 20} fontSize={11} fontWeight={600} fill="#0f172a">
              {n.label.length > 15 ? `${n.label.slice(0, 14)}…` : n.label}
            </text>
            {n.sublabel && (
              <text x={p.x + 40} y={p.y + 33} fontSize={9.5} fill="#64748b">
                {n.sublabel.length > 16 ? `${n.sublabel.slice(0, 15)}…` : n.sublabel}
              </text>
            )}
            {n.provider && (
              <text x={p.x + 8} y={p.y + 53} fontSize={9} fontWeight={600} fill="#94a3b8" letterSpacing={0.5}>
                {n.provider.toUpperCase()}
              </text>
            )}
            {n.count && n.count > 1 && (
              <g>
                <rect x={p.x + NODE_W - 34} y={p.y + NODE_H - 22} width={28} height={16} rx={8} fill="#0f172a" />
                <text x={p.x + NODE_W - 20} y={p.y + NODE_H - 11} fontSize={9.5} fontWeight={600} fill="#fff" textAnchor="middle">
                  ×{n.count}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
