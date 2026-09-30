"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { Card } from "@/components/ui";
import type { UsageChart, UsageEvidence } from "@/lib/engine/types";
import { shortDate } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TipProps = TooltipContentProps<any, any>;

const GRID = "#eef1f5";
const AXIS = { stroke: "#e6eaf1", tickLine: false, axisLine: false } as const;
const SERIES = "#2a78d6";
const THRESHOLD = "#475569";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** One hue, light → dark: more is darker. */
const RAMP = ["#e8f1fd", "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];

/* ---------------- Formatting ---------------- */

const trim = (n: number, digits = 1) => Number(n.toFixed(digits)).toLocaleString("en-US");

function compact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${trim(n / 1e9)}B`;
  if (a >= 1e6) return `${trim(n / 1e6)}M`;
  if (a >= 1e4) return `${trim(n / 1e3, 0)}k`;
  if (a >= 1e3) return `${trim(n / 1e3)}k`;
  return trim(n, a < 10 ? 1 : 0);
}

/** `short` is for axis ticks: a bare number, because the chart title names the unit. */
export function formatUsage(v: number, unit: string, short = false) {
  switch (unit) {
    case "percent":
      return `${trim(v)}%`;
    case "gb":
      return short ? compact(v) : `${trim(v, v < 10 ? 1 : 0)} GB`;
    case "tb":
      return short ? compact(v) : `${trim(v, v >= 100 ? 1 : 2)} TB`;
    case "ms":
      return short ? compact(v) : `${trim(v, 0)} ms`;
    case "iops":
      return short ? compact(v) : `${trim(v, 0)} IOPS`;
    case "count":
      return compact(v);
    default:
      return `${trim(v)}${short ? "" : ` ${unit}`}`;
  }
}

/**
 * How a chart is displayed: large volumes switch from GB to TB — for the axis,
 * the tooltip, the table and the title alike, so one chart never mixes units.
 */
function displayOf(chart: UsageChart) {
  const max = Math.max(...chart.points.map((p) => p.v), ...(chart.lines ?? []).map((l) => l.value));
  const inTb = chart.unit === "gb" && max >= 2048;
  const k = inTb ? 1 / 1024 : 1;
  return {
    unit: inTb ? "tb" : chart.unit,
    title: inTb ? chart.title.replace(/\bGB\b/, "TB") : chart.title,
    points: inTb ? chart.points.map((p) => ({ d: p.d, v: p.v * k })) : chart.points,
    lines: (chart.lines ?? []).map((l) => ({ ...l, value: l.value * k })),
  };
}

/** Clean axis ticks from zero: steps of 1, 2, 2.5 or 5 × 10ⁿ, four to six of them. */
function axisTicks(dataMax: number, cap?: number): number[] {
  const top = Math.max(dataMax, 1e-9);
  const raw = top / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((st) => st >= raw) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v < top + step - 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return cap !== undefined ? ticks.filter((t) => t <= cap + 1e-9) : ticks;
}

const fullDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/* ---------------- Trend ---------------- */

function Trend({ perMonth }: { perMonth?: number }) {
  if (perMonth === undefined) return null;
  const flat = Math.round(perMonth * 100) === 0; // same rule as the text of the recommendation
  const Icon = flat ? Minus : perMonth > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700" title="Trend of the daily level over the last 60 days (robust to outliers)">
      <Icon size={12} aria-hidden />
      {flat ? "Flat" : `${perMonth > 0 ? "+" : "−"}${Math.abs(Math.round(perMonth * 100))}% / month`}
    </span>
  );
}

/* ---------------- Daily line chart ---------------- */

function UsageLineChart({ chart }: { chart: UsageChart }) {
  const { unit, title, points, lines } = displayOf(chart);
  // Leave room above the highest mark (and above a threshold line for its label).
  const dataMax = Math.max(...points.map((p) => p.v), ...lines.map((l) => l.value * 1.12));
  const ticks = axisTicks(dataMax * 1.05, unit === "percent" ? 100 : undefined);
  const max = ticks[ticks.length - 1];
  const last = points[points.length - 1];
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-medium text-ink" title={title}>
            {title}
          </p>
          <p className="text-[11px] text-muted">
            Latest <span className="tabular font-medium text-ink">{formatUsage(last.v, unit)}</span> · {shortDate(last.d)}
          </p>
        </div>
        <Trend perMonth={chart.trendPerMonth} />
      </figcaption>
      <div className="mt-2" role="img" aria-label={`${title}: ${points.length} daily values from ${shortDate(points[0].d)} to ${shortDate(last.d)}, latest ${formatUsage(last.v, unit)}.`}>
        <ResponsiveContainer width="100%" height={168}>
          <LineChart data={points} margin={{ top: 14, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="d" tickFormatter={shortDate} minTickGap={44} {...AXIS} />
            <YAxis domain={[0, max]} ticks={ticks} tickFormatter={(v) => formatUsage(Number(v), unit, true)} width={46} {...AXIS} />
            <Tooltip
              cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }}
              content={({ active, payload, label }: TipProps) =>
                active && payload?.length ? (
                  <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-lg">
                    <p className="text-muted">{fullDate(String(label))}</p>
                    <p className="mt-1 flex items-center gap-2">
                      <span className="inline-block h-0.5 w-3.5 rounded" style={{ background: SERIES }} />
                      <span className="tabular text-[13px] font-semibold text-ink">{formatUsage(Number(payload[0].value), unit)}</span>
                    </p>
                    {lines.map((l) => (
                      <p key={l.label} className="mt-0.5 flex items-center gap-2 text-muted">
                        <span className="inline-block h-0 w-3.5 border-t border-dashed" style={{ borderColor: THRESHOLD }} />
                        {l.label} <span className="tabular font-medium text-ink">{formatUsage(l.value, unit)}</span>
                      </p>
                    ))}
                  </div>
                ) : null
              }
            />
            {lines.map((l) => (
              <ReferenceLine
                key={l.label}
                y={l.value}
                stroke={THRESHOLD}
                strokeDasharray="5 4"
                label={({ viewBox }: { viewBox?: { x?: number; y?: number; width?: number } }) => (
                  <text x={(viewBox?.x ?? 0) + (viewBox?.width ?? 0) - 2} y={(viewBox?.y ?? 0) - 5} textAnchor="end" fontSize={10.5} fill={THRESHOLD} stroke="#fff" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
                    {l.label} · {formatUsage(l.value, unit)}
                  </text>
                )}
              />
            ))}
            <Line type="monotone" dataKey="v" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {chart.note && <p className="mt-1 text-[11px] text-muted">{chart.note}</p>}
    </figure>
  );
}

/* ---------------- Hour-of-week heatmap ---------------- */

type Heatmap = NonNullable<UsageEvidence["heatmap"]>;

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const heatValue = (v: number, unit?: string) => (unit ? `${trim(v)} ${unit}` : `${trim(v)}%`);

/** Runs of consecutive hours that stay on, per day: [startHour, length]. */
function onRuns(idle: boolean[] | undefined, day: number): [number, number][] {
  if (!idle) return [];
  const runs: [number, number][] = [];
  let start = -1;
  for (let h = 0; h <= 24; h++) {
    const on = h < 24 && !idle[day * 24 + h];
    if (on && start < 0) start = h;
    if (!on && start >= 0) {
      runs.push([start, h - start]);
      start = -1;
    }
  }
  return runs;
}

function HourOfWeekHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const max = Math.max(...heatmap.values, 1e-9);
  // Utilisation is shaded from zero; a count (nodes needed) from its own minimum, so a 9-to-10 swing stays visible.
  // Either way the scale legend names both ends.
  const min = heatmap.unit ? Math.min(...heatmap.values) : 0;
  const color = (v: number) => RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor((max - min < 1e-9 ? 0.5 : (v - min) / (max - min)) * RAMP.length)))];
  const scheduled = Boolean(heatmap.idle);

  const label = (i: number) => {
    const d = Math.floor(i / 24);
    const h = i % 24;
    const state = scheduled ? (heatmap.idle![i] ? ", switched off" : ", kept on") : "";
    return `${DAYS[d]} ${hh(h)} to ${h === 23 ? "24:00" : hh(h + 1)} UTC: ${heatValue(heatmap.values[i], heatmap.unit)}${state}`;
  };

  function onKeyDown(e: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 24, ArrowUp: -24 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = Math.min(167, Math.max(0, focus + step));
    setFocus(next);
    grid.current?.querySelector<HTMLElement>(`[data-cell="${next}"]`)?.focus();
  }

  return (
    <figure>
      <figcaption>
        <p className="text-[12.5px] font-medium text-ink">{heatmap.title}</p>
        <p className="text-[11px] text-muted">
          By hour of the week (UTC){scheduled && heatmap.schedule ? (
            <>
              {" "}
              · stays on <span className="font-medium text-ink">{heatmap.schedule.replace(" (UTC)", "")}</span>
            </>
          ) : null}
        </p>
      </figcaption>

      <div ref={grid} role="grid" aria-label={`${heatmap.title}. Use the arrow keys to move between hours.`} onKeyDown={onKeyDown} className="mt-3">
        <div className="flex items-end pl-9" aria-hidden>
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="tabular flex-1 text-left text-[10px] text-muted">
              {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
            </span>
          ))}
        </div>
        {DAYS.map((day, d) => (
          <div key={day} role="row" className={clsx("flex items-start", scheduled ? "mt-1" : "mt-0.5")}>
            <span className="w-9 shrink-0 pt-0.5 text-[11px] leading-[18px] text-muted">{day}</span>
            <div className="relative min-w-0 flex-1">
              <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5">
                {Array.from({ length: 24 }, (_, h) => {
                  const i = d * 24 + h;
                  return (
                    <div
                      key={h}
                      role="gridcell"
                      data-cell={i}
                      tabIndex={i === focus ? 0 : -1}
                      aria-label={label(i)}
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover((cur) => (cur === i ? null : cur))}
                      onFocus={() => {
                        setFocus(i);
                        setHover(i);
                      }}
                      onBlur={() => setHover((cur) => (cur === i ? null : cur))}
                      className="relative h-[18px] rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1"
                      style={{ background: color(heatmap.values[i]), boxShadow: hover === i ? "0 0 0 2px #0f172a" : undefined, zIndex: hover === i ? 10 : undefined }}
                    >
                      {hover === i && (
                        <div
                          role="tooltip"
                          className={clsx(
                            "pointer-events-none absolute bottom-full z-20 mb-2 whitespace-nowrap rounded-lg border border-line bg-white px-3 py-2 text-left text-xs shadow-lg",
                            h < 5 ? "left-0" : h > 18 ? "right-0" : "left-1/2 -translate-x-1/2",
                          )}
                        >
                          <p className="text-muted">
                            {day} {hh(h)}–{h === 23 ? "24:00" : hh(h + 1)} UTC
                          </p>
                          <p className="tabular mt-0.5 text-[13px] font-semibold text-ink">{heatValue(heatmap.values[i], heatmap.unit)}</p>
                          {scheduled && <p className="mt-0.5 text-muted">{heatmap.idle![i] ? "Switched off" : "Kept on"}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* The hours that stay on, as a bar under the row: the schedule never relies on colour alone. */}
              {scheduled && (
                <div className="relative mt-0.5 h-[3px]" aria-hidden>
                  {onRuns(heatmap.idle, d).map(([from, len]) => (
                    <span key={from} className="absolute inset-y-0 rounded-full bg-ink" style={{ left: `calc(${from} * (100% + 2px) / 24)`, width: `calc(${len} * (100% + 2px) / 24 - 2px)` }} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 pl-9 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="tabular">{heatValue(min, heatmap.unit)}</span>
          <span className="flex gap-px" aria-hidden>
            {RAMP.filter((_, i) => i % 2 === 1).map((c) => (
              <span key={c} className="h-2.5 w-4 first:rounded-l-sm last:rounded-r-sm" style={{ background: c }} />
            ))}
          </span>
          <span className="tabular">{heatValue(max, heatmap.unit)}</span>
        </span>
        {scheduled && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-[3px] w-5 rounded-full bg-ink" aria-hidden /> Kept on (includes a 1-hour buffer)
          </span>
        )}
      </div>
    </figure>
  );
}

/* ---------------- Table views ---------------- */

function ChartsTable({ charts: raw }: { charts: UsageChart[] }) {
  const charts = useMemo(() => raw.map((c) => ({ id: c.id, ...displayOf(c) })), [raw]);
  const rows = useMemo(() => {
    const dates = [...new Set(charts.flatMap((c) => c.points.map((p) => p.d)))].sort().reverse();
    const lookup = charts.map((c) => new Map(c.points.map((p) => [p.d, p.v])));
    return dates.map((d) => ({ d, values: lookup.map((m) => m.get(d)) }));
  }, [charts]);
  return (
    <div className="max-h-[340px] overflow-auto rounded-lg border border-line">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-slate-50 text-left text-[11px] text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Date (UTC)</th>
            {charts.map((c) => (
              <th key={c.id} className="px-3 py-2 text-right font-medium">
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.d} className="border-t border-line">
              <td className="px-3 py-1.5 text-muted">{fullDate(r.d)}</td>
              {r.values.map((v, i) => (
                <td key={charts[i].id} className="tabular px-3 py-1.5 text-right text-ink">
                  {v === undefined ? "—" : formatUsage(v, charts[i].unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatmapTable({ heatmap }: { heatmap: Heatmap }) {
  return (
    <div>
      <p className="text-[12.5px] font-medium text-ink">{heatmap.title}</p>
      <p className="text-[11px] text-muted">
        {heatmap.unit ? `${heatmap.unit[0].toUpperCase()}${heatmap.unit.slice(1)}` : "Percent"} by hour of the week (UTC){heatmap.idle ? " · hours in bold stay on" : ""}
      </p>
      <div className="mt-2 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-[11px]">
          <thead className="bg-slate-50 text-muted">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Day</th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="tabular px-1 py-1.5 text-right font-medium">
                  {String(h).padStart(2, "0")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day, d) => (
              <tr key={day} className="border-t border-line">
                <th className="px-2 py-1 text-left font-medium text-muted">{day}</th>
                {Array.from({ length: 24 }, (_, h) => {
                  const i = d * 24 + h;
                  const on = heatmap.idle ? !heatmap.idle[i] : false;
                  return (
                    <td key={h} className={clsx("tabular px-1 py-1 text-right", on ? "font-semibold text-ink" : heatmap.idle ? "text-slate-400" : "text-ink")}>
                      {trim(heatmap.values[i], heatmap.values[i] >= 10 ? 0 : 1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Panel ---------------- */

export function UsageEvidencePanel({ usage }: { usage: UsageEvidence }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const charts = usage.charts.filter((c) => c.points.length >= 2);
  if (!charts.length && !usage.heatmap) return null;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[13.5px] font-semibold text-ink">Usage behind this recommendation</h3>
          <p className="mt-0.5 text-xs text-muted">
            Based on <span className="font-medium text-ink">{usage.days} days</span> of measured history
            {usage.metrics.length > 0 && <> · {usage.metrics.join(", ")}</>}
          </p>
          {usage.missing && usage.missing.length > 0 && <p className="mt-1 text-xs text-amber-700">Not measured: {usage.missing.join(", ")} — the recommendation says so where it matters.</p>}
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1" role="group" aria-label="View">
          {(["chart", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={clsx("rounded-md px-2.5 py-1 text-xs font-medium", view === v ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink")}>
              {v === "chart" ? "Charts" : "Table"}
            </button>
          ))}
        </div>
      </div>

      {view === "chart" ? (
        <div className="mt-4 space-y-6">
          {charts.length > 0 && (
            <div className={clsx("grid gap-x-8 gap-y-6", charts.length > 1 && "lg:grid-cols-2")}>
              {charts.map((c) => (
                <UsageLineChart key={c.id} chart={c} />
              ))}
            </div>
          )}
          {usage.heatmap && <HourOfWeekHeatmap heatmap={usage.heatmap} />}
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          {charts.length > 0 && <ChartsTable charts={charts} />}
          {usage.heatmap && <HeatmapTable heatmap={usage.heatmap} />}
        </div>
      )}
    </Card>
  );
}
