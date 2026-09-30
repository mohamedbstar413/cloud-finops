"use client";

import clsx from "clsx";
import { ArrowRight, Columns2, Download, GitCompareArrows, Maximize2, MousePointerClick } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "@/components/client-ui";
import { diffArchitectures, type NodeStatus } from "@/lib/diagram/diff";
import type { ArchitectureSpec } from "@/lib/engine/types";
import type { PricedComponent } from "@/lib/pricing/components";
import { ArchitectureCanvas, money, type CanvasEdge, type CanvasHandle, type CanvasNode } from "./ArchitectureCanvas";

type View = "split" | "diff";

interface Props {
  current: ArchitectureSpec;
  proposed: ArchitectureSpec;
  /** Render without the outer card chrome (when nested inside another card). */
  bare?: boolean;
  defaultView?: View;
  title?: string;
  /** Base name for exported SVG files. */
  filename?: string;
}

/**
 * Current vs. proposed architecture, as two diagrams side by side or as one
 * unified diff (removed components struck through, new ones highlighted).
 */
export function ArchitectureCompare({ current, proposed, bare, defaultView = "split", title = "Architecture comparison", filename = "architecture" }: Props) {
  const [view, setView] = useState<View>(defaultView);
  const [expanded, setExpanded] = useState(false);
  const diff = useMemo(() => diffArchitectures(current, proposed), [current, proposed]);

  const currentNodes = useMemo<CanvasNode[]>(
    () =>
      current.nodes.map((n) => {
        const status = diff.currentStatus.get(n.id);
        return { ...n, status: status === "kept" ? undefined : status, cost: diff.costsBefore.get(n.id)?.cost, components: diff.costsBefore.get(n.id)?.components };
      }),
    [current, diff],
  );
  const proposedNodes = useMemo<CanvasNode[]>(
    () =>
      proposed.nodes.map((n) => {
        const status = diff.proposedStatus.get(n.id);
        const d = diff.nodes.find((x) => x.id === n.id);
        return { ...n, status: status === "kept" ? undefined : status, cost: diff.costsAfter.get(n.id)?.cost, costBefore: status === "changed" ? d?.costBefore : undefined, components: diff.costsAfter.get(n.id)?.components, before: d?.before };
      }),
    [proposed, diff],
  );
  const diffNodes = useMemo<CanvasNode[]>(
    () =>
      diff.nodes.map((n) => ({
        ...n,
        status: n.status === "kept" ? undefined : n.status,
        cost: n.status === "removed" ? undefined : n.costAfter,
        costBefore: n.costBefore,
        components: n.status === "removed" ? n.componentsBefore : n.componentsAfter,
      })),
    [diff],
  );
  const diffEdges = useMemo<CanvasEdge[]>(() => diff.edges.map((e) => ({ ...e, status: e.status === "kept" ? undefined : e.status })), [diff]);

  const savings = current.monthlyCost - proposed.monthlyCost;
  const pct = current.monthlyCost > 0 ? (savings / current.monthlyCost) * 100 : 0;

  const toolbar = (
    <div className="flex items-center gap-1.5">
      <div className="flex rounded-lg bg-slate-100 p-0.5" role="tablist" aria-label="Diagram view">
        {(
          [
            { id: "split", label: "Side by side", icon: Columns2 },
            { id: "diff", label: "Unified diff", icon: GitCompareArrows },
          ] as const
        ).map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={clsx("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium", view === v.id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink")}
          >
            <v.icon size={13} /> {v.label}
          </button>
        ))}
      </div>
    </div>
  );

  const summary = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
      <span className="inline-flex items-center gap-1.5 font-semibold tabular text-ink">
        {money(current.monthlyCost)}
        <ArrowRight size={13} className="text-slate-400" />
        <span className="text-good">{money(proposed.monthlyCost)}</span>
        <span className="font-normal text-muted">/month</span>
        {savings > 0 && <span className="ml-1 rounded-full bg-green-50 px-2 py-px text-[11px] font-semibold text-green-700 ring-1 ring-inset ring-green-200">−{Math.round(pct)}%</span>}
      </span>
      <span className="flex flex-wrap items-center gap-3 text-muted">
        <StatusCount status="added" n={diff.counts.added} />
        <StatusCount status="removed" n={diff.counts.removed} />
        <StatusCount status="changed" n={diff.counts.changed} />
        {diff.counts.kept > 0 && <StatusCount status="kept" n={diff.counts.kept} />}
      </span>
    </div>
  );

  const body = (large: boolean) =>
    view === "split" ? (
      <div className={clsx("grid gap-3", large ? "lg:grid-cols-2" : "xl:grid-cols-2")}>
        <Panel title="Current" cost={current.monthlyCost} nodes={currentNodes} edges={current.edges} notDrawn={diff.notDrawnBefore} filename={`${filename}-current`} lanes={large} />
        <Panel
          title="Recommended"
          cost={proposed.monthlyCost}
          accent
          badge={savings > 0 ? `−${Math.round(pct)}%` : undefined}
          nodes={proposedNodes}
          edges={proposed.edges}
          notDrawn={diff.notDrawnAfter}
          filename={`${filename}-recommended`}
          lanes={large}
        />
      </div>
    ) : (
      <Panel title="Changes" cost={proposed.monthlyCost} costBefore={current.monthlyCost} nodes={diffNodes} edges={diffEdges} notDrawn={diff.notDrawnAfter} filename={`${filename}-diff`} lanes />
    );

  const content = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-[13.5px] font-semibold text-ink">{title}</p>
          {summary}
        </div>
        <div className="flex items-center gap-1.5">
          {toolbar}
          <button onClick={() => setExpanded(true)} className="rounded-lg p-1.5 text-muted ring-1 ring-inset ring-line hover:bg-slate-50 hover:text-ink" aria-label="Expand diagram" title="Expand">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
      <div className="mt-3">{body(false)}</div>
      <Legend />
      <Modal open={expanded} onClose={() => setExpanded(false)} title={title} size="xl">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          {summary}
          {toolbar}
        </div>
        {body(true)}
        <Legend />
      </Modal>
    </>
  );

  return bare ? <div>{content}</div> : <div className="rounded-xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">{content}</div>;
}

function Panel({
  title,
  cost,
  costBefore,
  accent,
  badge,
  nodes,
  edges,
  notDrawn,
  filename,
  lanes,
}: {
  title: string;
  cost: number;
  costBefore?: number;
  accent?: boolean;
  badge?: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  notDrawn: PricedComponent[];
  filename: string;
  lanes?: boolean;
}) {
  const canvas = useRef<CanvasHandle>(null);
  const other = notDrawn.filter((c) => Math.abs(c.monthlyCost) >= 0.5).sort((a, b) => Math.abs(b.monthlyCost) - Math.abs(a.monthlyCost));
  return (
    <section className={clsx("overflow-hidden rounded-xl border", accent ? "border-green-200" : "border-line")}>
      <header className={clsx("flex items-center justify-between gap-2 border-b px-3.5 py-2", accent ? "border-green-100 bg-green-50/50" : "border-line bg-slate-50/60")}>
        <span className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-slate-600">
          <span className={clsx("size-2 rounded-full", accent ? "bg-green-500" : "bg-slate-400")} />
          {title}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold tabular text-ink">
            {costBefore !== undefined ? (
              <>
                <span className="text-muted line-through decoration-slate-300">{money(costBefore)}</span> <span className="text-good">{money(cost)}</span>
              </>
            ) : (
              money(cost)
            )}
            <span className="font-normal text-muted">/mo</span>
          </span>
          {badge && <span className="rounded-full bg-green-100 px-1.5 py-px text-[10.5px] font-semibold text-green-700">{badge}</span>}
          <button
            onClick={() => {
              const svg = canvas.current?.svg();
              if (svg) downloadSvg(svg, `${filename}.svg`);
            }}
            className="rounded p-1 text-slate-400 hover:bg-white hover:text-ink"
            aria-label={`Download ${title.toLowerCase()} diagram as SVG`}
            title="Download SVG"
          >
            <Download size={13} />
          </button>
        </span>
      </header>
      <div className="diagram-canvas p-3">
        <ArchitectureCanvas ref={canvas} nodes={nodes} edges={edges} label={`${title} architecture diagram`} lanes={lanes} />
      </div>
      {other.length > 0 && (
        <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
          <span className="font-medium text-slate-600">Also priced, not drawn:</span>{" "}
          {other.slice(0, 4).map((c, i) => (
            <span key={c.id}>
              {i > 0 && " · "}
              {c.label.replace(/\s*\(unchanged\)$/, "")} <span className="tabular text-slate-600">{money(c.monthlyCost)}</span>
            </span>
          ))}
          {other.length > 4 && ` · +${other.length - 4} more`}
        </p>
      )}
    </section>
  );
}

const STATUS_DOT: Record<NodeStatus, { label: string; className: string }> = {
  added: { label: "new", className: "border-green-500 bg-green-50" },
  removed: { label: "removed", className: "border-dashed border-red-400 bg-red-50" },
  changed: { label: "changed", className: "border-amber-500 bg-amber-50" },
  kept: { label: "unchanged", className: "border-slate-300 bg-white" },
};

function StatusCount({ status, n }: { status: NodeStatus; n: number }) {
  if (!n) return null;
  const s = STATUS_DOT[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx("inline-block h-2.5 w-3.5 rounded-[3px] border-[1.5px]", s.className)} />
      <span className="font-semibold text-ink">{n}</span> {s.label}
    </span>
  );
}

function Legend() {
  const Item = ({ children }: { children: ReactNode }) => <span className="inline-flex items-center gap-1.5">{children}</span>;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted">
      <Item>
        <span className="inline-block h-3 w-4 rounded-[3px] border-[1.5px] border-green-500 bg-green-50" /> New
      </Item>
      <Item>
        <span className="inline-block h-3 w-4 rounded-[3px] border-[1.5px] border-dashed border-red-400 bg-red-50" /> Removed
      </Item>
      <Item>
        <span className="inline-block h-3 w-4 rounded-[3px] border-[1.5px] border-amber-500 bg-amber-50" /> Changed
      </Item>
      <Item>
        <svg width="26" height="8" aria-hidden>
          <line x1="1" y1="4" x2="25" y2="4" stroke="#f97316" strokeWidth="1.6" strokeDasharray="5 4" />
        </svg>
        Cross-cloud data transfer
      </Item>
      <Item>
        <span className="inline-block h-3 w-4 rounded-[4px] border border-dashed border-slate-400" /> Cloud boundary
      </Item>
      <span className="ml-auto inline-flex items-center gap-1">
        <MousePointerClick size={12} /> Hover or focus a component for its cost breakdown
      </span>
    </div>
  );
}

/** Serialise a rendered diagram to a standalone SVG file. */
function downloadSvg(svg: SVGSVGElement, filename: string) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const vb = svg.viewBox.baseVal;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(vb.width));
  clone.setAttribute("height", String(vb.height));
  clone.style.fontFamily = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#ffffff");
  clone.insertBefore(bg, clone.firstChild);
  clone.querySelectorAll("[opacity]").forEach((el) => el.setAttribute("opacity", "1"));
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
