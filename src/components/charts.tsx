"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TipProps = TooltipContentProps<any, any>;
import { CATEGORY_LABEL, PROVIDER_COLOR, PROVIDER_NAME, shortDate, usd } from "@/lib/format";
import type { Provider } from "@/lib/pricing/catalog";
import type { ProjectionPoint, WaterfallStep } from "@/lib/projection";

const GRID = "#eef1f5";
const AXIS = { stroke: "#e6eaf1", tickLine: false, axisLine: false } as const;
const PROVIDERS: Provider[] = ["aws", "azure", "gcp"];

/* ---------------- Tooltip ---------------- */

type Row = { color: string; label: string; value: string; strong?: boolean };

function TipCard({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="min-w-[170px] rounded-lg border border-line bg-white px-3 py-2.5 text-xs shadow-lg">
      <p className="mb-1.5 font-medium text-ink">{title}</p>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="size-2 rounded-full" style={{ background: r.color }} />
            {r.label}
          </span>
          <span className={`tabular ${r.strong ? "font-semibold" : "font-medium"} text-ink`}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: i.dashed ? `repeating-linear-gradient(90deg, ${i.color} 0 4px, transparent 4px 7px)` : i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export const providerLegend = PROVIDERS.map((p) => ({ label: PROVIDER_NAME[p], color: PROVIDER_COLOR[p] }));

/* ---------------- Spend trend (daily, by provider) ---------------- */

export function SpendTrendChart({ data, height = 240 }: { data: { date: string; aws: number; azure: number; gcp: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} {...AXIS} />
        <YAxis tickFormatter={(v) => usd(v, { compact: true })} width={48} {...AXIS} />
        <Tooltip
          cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }}
          content={({ active, payload, label }: TipProps) =>
            active && payload?.length ? (
              <TipCard
                title={new Date(`${label}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
                rows={[
                  ...payload.map((p) => ({ color: p.color as string, label: PROVIDER_NAME[p.dataKey as Provider], value: usd(Number(p.value)) })),
                  { color: "transparent", label: "Total", value: usd(payload.reduce((s, p) => s + Number(p.value), 0)), strong: true },
                ]}
              />
            ) : null
          }
        />
        {PROVIDERS.map((p) => (
          <Line key={p} type="monotone" dataKey={p} stroke={PROVIDER_COLOR[p]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ---------------- Provider donut ---------------- */

export function ProviderDonut({ data, total }: { data: { provider: Provider; cost: number; pct: number }[]; total: number }) {
  return (
    <div className="flex items-center gap-6">
      <div className="relative size-[168px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="cost" nameKey="provider" innerRadius={56} outerRadius={80} paddingAngle={1.5} stroke="#fff" strokeWidth={2} startAngle={90} endAngle={-270}>
              {data.map((d) => (
                <Cell key={d.provider} fill={PROVIDER_COLOR[d.provider]} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }: TipProps) =>
                active && payload?.length ? (
                  <TipCard title={PROVIDER_NAME[payload[0].payload.provider as Provider]} rows={[{ color: PROVIDER_COLOR[payload[0].payload.provider as Provider], label: "Cost", value: usd(Number(payload[0].value)) }]} />
                ) : null
              }
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-[17px] font-semibold text-ink">{usd(total)}</p>
            <p className="text-[11px] text-muted">Total cost</p>
          </div>
        </div>
      </div>
      <ul className="flex-1 space-y-2.5 text-[13px]">
        {data.map((d) => (
          <li key={d.provider} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink">
              <span className="size-2.5 rounded-full" style={{ background: PROVIDER_COLOR[d.provider] }} />
              {PROVIDER_NAME[d.provider]}
            </span>
            <span className="tabular text-ink">
              {usd(d.cost)} <span className="ml-2 text-muted">{Math.round(d.pct)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- Category × provider stacked bars ---------------- */

export function CategoryStackedBar({ data, height = 220 }: { data: { category: string; aws: number; azure: number; gcp: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="category" tickFormatter={(c) => CATEGORY_LABEL[c] ?? c} interval={0} {...AXIS} />
        <YAxis tickFormatter={(v) => usd(v, { compact: true })} width={48} {...AXIS} />
        <Tooltip
          cursor={{ fill: "#f1f5f9" }}
          content={({ active, payload, label }: TipProps) =>
            active && payload?.length ? (
              <TipCard
                title={CATEGORY_LABEL[label as string] ?? String(label)}
                rows={[...payload].reverse().filter((p) => Number(p.value) > 0).map((p) => ({ color: p.color as string, label: PROVIDER_NAME[p.dataKey as Provider], value: usd(Number(p.value)) }))}
              />
            ) : null
          }
        />
        {PROVIDERS.map((p, i) => (
          <Bar key={p} dataKey={p} stackId="s" fill={PROVIDER_COLOR[p]} stroke="#fff" strokeWidth={1} radius={i === PROVIDERS.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={34} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---------------- Sparkline (pure SVG) ---------------- */

export function Sparkline({ values, color = "#2a78d6", width = 96, height = 26 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------- Cost-improvement projection ---------------- */

export const PROJECTION_COLORS = { baseline: "#94a3b8", optimized: "#2a78d6", band: "#1baf7a" };

export function ProjectionChart({ points, height = 300 }: { points: ProjectionPoint[]; height?: number }) {
  const data = points.map((p) => ({ ...p, band: [p.optimized, p.baseline] as [number, number] }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="savingsBand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={PROJECTION_COLORS.band} stopOpacity={0.28} />
            <stop offset="1" stopColor={PROJECTION_COLORS.band} stopOpacity={0.12} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis tickFormatter={(v) => usd(v, { compact: true })} width={52} domain={[0, "auto"]} {...AXIS} />
        <Tooltip
          cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }}
          content={({ active, payload, label }: TipProps) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as ProjectionPoint;
            return (
              <TipCard
                title={String(label)}
                rows={[
                  { color: PROJECTION_COLORS.baseline, label: "Current trajectory", value: usd(p.baseline) },
                  { color: PROJECTION_COLORS.optimized, label: "With improvement", value: usd(p.optimized) },
                  { color: PROJECTION_COLORS.band, label: "Monthly savings", value: usd(p.savings), strong: true },
                  { color: "transparent", label: "Rollout", value: `${Math.round(p.adoption * 100)}%` },
                ]}
              />
            );
          }}
        />
        <Area type="monotone" dataKey="band" stroke="none" fill="url(#savingsBand)" isAnimationActive={false} />
        <Line type="monotone" dataKey="baseline" stroke={PROJECTION_COLORS.baseline} strokeWidth={2} strokeDasharray="5 4" dot={false} />
        <Line type="monotone" dataKey="optimized" stroke={PROJECTION_COLORS.optimized} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: PROJECTION_COLORS.optimized }} activeDot={{ r: 5, stroke: "#fff", strokeWidth: 2 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function CumulativeChart({ points, breakEvenMonth, height = 240 }: { points: ProjectionPoint[]; breakEvenMonth: number | null; height?: number }) {
  const be = points.find((p) => p.month === breakEvenMonth);
  const min = Math.min(0, ...points.map((p) => p.cumulativeNet));
  const max = Math.max(0, ...points.map((p) => p.cumulativeNet));
  const zero = max === min ? 0.5 : max / (max - min);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={points} margin={{ top: 14, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1baf7a" stopOpacity={0.3} />
            <stop offset={zero} stopColor="#1baf7a" stopOpacity={0.08} />
            <stop offset={zero} stopColor="#dc2626" stopOpacity={0.08} />
            <stop offset="1" stopColor="#dc2626" stopOpacity={0.25} />
          </linearGradient>
          <linearGradient id="cumStroke" x1="0" y1="0" x2="0" y2="1">
            <stop offset={zero} stopColor="#16a34a" />
            <stop offset={zero} stopColor="#dc2626" />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis tickFormatter={(v) => usd(v, { compact: true })} width={52} {...AXIS} />
        <ReferenceLine y={0} stroke="#94a3b8" />
        <Tooltip
          cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }}
          content={({ active, payload, label }: TipProps) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as ProjectionPoint;
            return (
              <TipCard
                title={String(label)}
                rows={[
                  { color: "#16a34a", label: "Cumulative savings", value: usd(p.cumulativeSavings) },
                  { color: "#dc2626", label: "Migration spend (month)", value: usd(p.migrationSpend) },
                  { color: "transparent", label: "Net position", value: usd(p.cumulativeNet), strong: true },
                ]}
              />
            );
          }}
        />
        <Area type="monotone" dataKey="cumulativeNet" stroke="url(#cumStroke)" strokeWidth={2} fill="url(#cumFill)" />
        {be && <ReferenceDot x={be.label} y={be.cumulativeNet} r={5} fill="#16a34a" stroke="#fff" strokeWidth={2} label={{ value: "Break-even", position: "top", fontSize: 11, fill: "#16a34a" }} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ---------------- Waterfall ---------------- */

function wrap(text: string, max = 16): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && cur) lines.push(cur);
  const used = lines.join(" ").length;
  if (used < text.length - 1) lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, max - 1)}…`;
  return lines.slice(0, 2);
}

export function WaterfallChart({ steps, height = 300 }: { steps: WaterfallStep[]; height?: number }) {
  const numbered = steps.length > 7;
  const data = steps.map((s, i) => ({ ...s, base: s.start, span: s.end - s.start, tick: numbered && s.kind === "saving" ? String(i) : s.name }));
  const Tick = ({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) => (
    <g transform={`translate(${x},${(y ?? 0) + 4})`}>
      <text textAnchor="middle" fontSize={10.5} fill="#7a8699">
        {wrap(payload?.value ?? "").map((line, i) => (
          <tspan key={i} x={0} dy={i === 0 ? 8 : 12}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="tick" interval={0} height={40} tick={<Tick />} {...AXIS} />
          <YAxis tickFormatter={(v) => usd(v, { compact: true })} width={52} {...AXIS} />
          <Tooltip
            cursor={{ fill: "#f1f5f9" }}
            content={({ active, payload }: TipProps) => {
              if (!active || !payload?.length) return null;
              const s = payload[0].payload as WaterfallStep;
              return <TipCard title={s.name} rows={[{ color: s.kind === "total" ? "#475569" : "#1baf7a", label: s.kind === "total" ? "Monthly spend" : "Monthly savings", value: s.kind === "total" ? usd(s.value) : `−${usd(s.value)}`, strong: true }]} />;
            }}
          />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="span" stackId="w" radius={[4, 4, 0, 0]} maxBarSize={48} label={{ position: "top", fontSize: 10.5, fill: "#475569", formatter: (v: unknown) => usd(Number(v), { compact: true }) }}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.kind === "total" ? (d.name === "Optimized" ? "#2a78d6" : "#64748b") : "#1baf7a"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {numbered && (
        <ol className="mt-2 grid gap-x-6 gap-y-0.5 px-3 text-[11.5px] text-muted sm:grid-cols-2">
          {steps.map((s, i) =>
            s.kind === "saving" ? (
              <li key={s.name} className="flex justify-between gap-2">
                <span className="truncate">
                  <b className="font-medium text-ink">{i}.</b> {s.name}
                </span>
                <span className="tabular shrink-0 text-good">−{usd(s.value)}</span>
              </li>
            ) : null,
          )}
        </ol>
      )}
    </div>
  );
}

/* ---------------- Provider before/after ---------------- */

export function ProviderBeforeAfter({ data, height = 220 }: { data: { provider: Provider; before: number; after: number }[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, name: PROVIDER_NAME[d.provider] }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={3} barCategoryGap="30%">
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" {...AXIS} />
        <YAxis tickFormatter={(v) => usd(v, { compact: true })} width={52} {...AXIS} />
        <Tooltip
          cursor={{ fill: "#f1f5f9" }}
          content={({ active, payload, label }: TipProps) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as { before: number; after: number; provider: Provider };
            return (
              <TipCard
                title={String(label)}
                rows={[
                  { color: "#cbd5e1", label: "Today", value: usd(d.before) },
                  { color: PROVIDER_COLOR[d.provider], label: "Scenario", value: usd(d.after) },
                  { color: "transparent", label: "Change", value: `${d.after - d.before <= 0 ? "−" : "+"}${usd(Math.abs(d.after - d.before))}`, strong: true },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="before" fill="#cbd5e1" radius={[4, 4, 0, 0]} maxBarSize={36} />
        <Bar dataKey="after" radius={[4, 4, 0, 0]} maxBarSize={36}>
          {rows.map((r) => (
            <Cell key={r.provider} fill={PROVIDER_COLOR[r.provider]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
