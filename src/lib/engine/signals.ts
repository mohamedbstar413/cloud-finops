import { describeSchedule, idleMask, withBuffer, type MetricProfile } from "../usage/series";
import type { DataGap, Estate, ResourceRow, UsageChart, UsageEvidence } from "./types";

/**
 * Time-aware usage signals for detectors. Every signal says where it came
 * from: "history" (hourly/daily series with trend and forecast) or "summary"
 * (a few pre-aggregated numbers, no trend). Detectors size to the forecast
 * peak, and record a DataGap instead of guessing when a signal is missing.
 */

/** Minimum history before a usage-based decision is trusted. */
export const MIN_HISTORY_DAYS = 14;
/** Horizon the engine sizes for: a change must still be right in 90 days. */
export const FORECAST_DAYS = 90;

export interface Signal {
  source: "history" | "summary";
  /** Days of history behind the signal (0 for summary metrics). */
  days: number;
  avg: number;
  p95: number;
  /**
   * Peak to size against: the busiest day's p95 of the hourly maximum (of the
   * hourly average when no maximum is collected). A month-end or weekly peak
   * counts; a single odd hour does not.
   */
  peak: number;
  max: number;
  /** Relative change per 30 days. */
  trendPerMonth: number;
  /** Peak projected 90 days ahead (never below today's peak). */
  forecastPeak: number;
  profile?: MetricProfile;
}

const fromProfile = (m: MetricProfile, peakOf?: MetricProfile): Signal => {
  const peak = (peakOf ?? m).peakDay;
  const trend = m.trendPerMonth;
  return {
    source: "history",
    days: m.days,
    avg: m.avg,
    p95: m.p95,
    peak,
    max: peakOf ? peakOf.max : m.max,
    trendPerMonth: trend,
    forecastPeak: Math.max(peak, peak * (1 + trend * (FORECAST_DAYS / 30))),
    profile: m,
  };
};

export function cpuSignal(r: ResourceRow): Signal | null {
  const m = r.usage?.metrics;
  if (m?.cpu) return fromProfile(m.cpu, m.cpu_max);
  if (r.metrics.cpuP95 === undefined) return null;
  const p95 = r.metrics.cpuP95;
  // Summary metrics are hourly averages: approximate the short-burst peak.
  const peak = Math.min(100, p95 * 1.2);
  return { source: "summary", days: 0, avg: r.metrics.cpuAvg ?? p95, p95, peak, max: r.metrics.cpuMax ?? peak, trendPerMonth: 0, forecastPeak: peak };
}

/**
 * Is the machine idle? With history: not even its busiest day reached 5% (a
 * patch reboot does not count as use). With summary metrics only the maximum
 * is all there is to go on.
 */
export const IDLE_CPU = 5;
export const isIdleCpu = (s: Signal) => (s.source === "history" ? s.peak < IDLE_CPU : s.max < IDLE_CPU);

/** Memory utilisation, or null when it is not measured (never assumed). */
export function memSignal(r: ResourceRow): Signal | null {
  const m = r.usage?.metrics.mem;
  if (m) return fromProfile(m);
  if (r.usage?.metrics.cpu) return null; // history exists, but no memory series: the agent is not installed
  if (r.metrics.memP95 === undefined) return null;
  const p95 = r.metrics.memP95;
  return { source: "summary", days: 0, avg: p95, p95, peak: p95, max: p95, trendPerMonth: 0, forecastPeak: p95 };
}

/** p95 of daily network bytes (in + out), or null when network is not measured. */
export function networkBytesPerDay(r: ResourceRow): number | null {
  const m = r.usage?.metrics;
  if (!m?.net_in && !m?.net_out) return null;
  const days = new Map<string, number>();
  for (const s of [m.net_in, m.net_out]) for (const d of s?.daily ?? []) days.set(d.d, (days.get(d.d) ?? 0) + d.total);
  const totals = [...days.values()].sort((a, b) => a - b);
  return totals.length ? totals[Math.floor(0.95 * (totals.length - 1))] : null;
}

/** Instances that are always running: p10 of the hourly instance count, else the provisioned quantity. */
export function instanceFloor(r: ResourceRow): number {
  const m = r.usage?.metrics.instances;
  return m ? Math.min(r.quantity, Math.max(0, Math.floor(m.p10 + 1e-9))) : r.quantity;
}

export interface TrafficSignal {
  source: "history" | "summary";
  monthlyM: number;
  /** Requests per month projected 6 months ahead. */
  forecastM: number;
  trendPerMonth: number;
  peakToAvg: number;
  days: number;
  profile?: MetricProfile;
}

export function requestSignal(r: ResourceRow | undefined): TrafficSignal | null {
  if (!r) return null;
  const m = r.usage?.metrics.requests;
  if (m) {
    const monthlyM = m.monthlyTotal / 1e6;
    const g = Math.max(-0.2, Math.min(0.25, m.trendPerMonth));
    return { source: "history", monthlyM, forecastM: monthlyM * (1 + g) ** 6, trendPerMonth: m.trendPerMonth, peakToAvg: m.peakToAvg, days: m.days, profile: m };
  }
  if (!r.metrics.requestsPerMonthM) return null;
  return { source: "summary", monthlyM: r.metrics.requestsPerMonthM, forecastM: r.metrics.requestsPerMonthM, trendPerMonth: 0, peakToAvg: r.metrics.peakToAvg ?? 1, days: 0 };
}

export interface UsageWindow {
  /** 168 hours (Monday 00:00 UTC first): true when the resource is in use, including the safety buffer. */
  active: boolean[];
  /** Share of the week that is active (0–1). */
  share: number;
  /** Days of hourly history behind the window. */
  days: number;
  /** Hour-of-week utilisation, for the heatmap. */
  how: number[];
}

/**
 * When is this machine really in use? An hour of the week counts as idle only
 * if it stayed quiet in EVERY observed week (p95 across weeks of the hourly
 * peak), and a buffer is kept before and after each busy window. Returns null
 * without two weeks of hourly history: there is no safe way to guess.
 */
export function usageWindow(r: ResourceRow, bufferHours = 1): UsageWindow | null {
  const profile = r.usage?.metrics.cpu_max ?? r.usage?.metrics.cpu;
  if (!profile?.howP95 || profile.days < MIN_HISTORY_DAYS) return null;
  const threshold = Math.max(5, 0.15 * profile.p95);
  const active = withBuffer(idleMask(profile.howP95, threshold, profile.howN).map((idle) => !idle), bufferHours);
  return { active, share: active.filter(Boolean).length / active.length, days: profile.days, how: profile.howAvg ?? profile.howP95 };
}

/** A fleet stays up whenever ANY member is in use. */
export function mergeWindows(ws: UsageWindow[]): UsageWindow {
  const active = ws[0].active.map((_, h) => ws.some((w) => w.active[h]));
  return { active, share: active.filter(Boolean).length / active.length, days: Math.min(...ws.map((w) => w.days)), how: ws[0].how };
}

/** Does the signal rest on enough history? Summary metrics carry their own (unknown) window. */
export const enoughHistory = (s: Signal | TrafficSignal) => s.source === "summary" || s.days >= MIN_HISTORY_DAYS;

export function recordGap(estate: Estate, r: ResourceRow, detector: string, kind: DataGap["kind"], reason: string, fix?: string) {
  if (!estate.gaps) return;
  if (estate.gaps.some((g) => g.resourceId === r.id && g.detector === detector)) return;
  estate.gaps.push({ resourceId: r.id, resource: r.name, detector, kind, reason, fix, monthlyCost: Math.round(r.monthlyCost * 100) / 100 });
}

export const MEMORY_AGENT_FIX: Record<string, string> = {
  aws: "Install the CloudWatch agent to publish mem_used_percent",
  azure: "Enable the Azure Monitor agent (guest memory metrics)",
  gcp: "Install the Ops Agent to publish memory utilisation",
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Daily chart for the evidence panel: daily p95 for level metrics, daily totals for additive ones. */
export function chartOf(m: MetricProfile | undefined, id: string, title: string, extra: Partial<UsageChart> = {}): UsageChart | null {
  if (!m || m.daily.length < 2) return null;
  const additive = m.stat === "sum";
  const scale = m.unit === "bytes" ? 1e-9 : 1;
  return {
    id,
    title,
    unit: m.unit === "bytes" ? "gb" : (m.unit as UsageChart["unit"]),
    points: m.daily.slice(-60).map((d) => ({ d: d.d, v: r1((additive ? d.total : m.stepMinutes === 60 ? d.p95 : d.avg) * scale) })),
    trendPerMonth: Math.round(m.trendPerMonth * 1e4) / 1e4,
    ...extra,
  };
}

export function evidence(days: number, metrics: string[], charts: (UsageChart | null)[], extra: Partial<UsageEvidence> = {}): UsageEvidence | undefined {
  const shown = charts.filter(Boolean) as UsageChart[];
  if (!shown.length && !extra.heatmap) return undefined;
  return { days: Math.round(days), metrics, charts: shown, ...extra };
}

/** "+16%/month", "-4%/month" or "flat" (under half a percent a month). */
export const pctTrend = (t: number) => (Math.round(t * 100) === 0 ? "flat" : `${t >= 0 ? "+" : ""}${Math.round(t * 100)}%/month`);

/**
 * A compact, model-readable summary of a resource's usage history, for the AI
 * advisor: the same peaks, forecasts and weekly pattern the detectors use, and
 * an explicit "not measured" where a metric is missing, so the model cannot
 * mistake silence for low usage.
 */
export function usageDigest(r: ResourceRow): Record<string, unknown> | undefined {
  const m = r.usage?.metrics;
  if (!m || !Object.keys(m).length) return undefined;
  const out: Record<string, unknown> = { historyDays: Math.round(r.usage!.days) };
  const trendPct = (t: number) => r1(t * 100);
  const cpu = m.cpu ? cpuSignal(r) : null;
  if (cpu) {
    out.cpu = { avgPct: r1(cpu.avg), busiestDayPeakPct: r1(cpu.peak), trendPerMonthPct: trendPct(cpu.trendPerMonth), peakIn90DaysPct: r1(cpu.forecastPeak) };
    const mem = memSignal(r);
    out.memory = mem ? { p95Pct: r1(mem.p95), peakIn90DaysPct: r1(mem.forecastPeak) } : "not measured — do not assume it is low";
    const window = usageWindow(r);
    if (window) out.weeklyPattern = { busyHoursPerWeek: window.active.filter(Boolean).length, busyWindow: describeSchedule(window.active) };
  }
  if (m.instances) out.instances = { alwaysRunning: instanceFloor(r), max: Math.round(m.instances.max) };
  const traffic = m.requests ? requestSignal(r) : null;
  if (traffic) out.requests = { perMonthM: r1(traffic.monthlyM), trendPerMonthPct: trendPct(traffic.trendPerMonth), in6MonthsM: r1(traffic.forecastM), peakToAverage: r1(traffic.peakToAvg) };
  const net = networkBytesPerDay(r);
  if (net !== null) out.networkGbPerDay = Math.round((net / 1e9) * 100) / 100;
  if (m.nat_bytes) {
    out.nat = {
      gbPerMonth: Math.round(m.nat_bytes.monthlyTotal / 1e9),
      trendPerMonthPct: trendPct(m.nat_bytes.trendPerMonth),
      shareToObjectStorage: m.nat_storage_bytes && m.nat_bytes.monthlyTotal > 0 ? Math.round((m.nat_storage_bytes.monthlyTotal / m.nat_bytes.monthlyTotal) * 100) / 100 : "not measured",
    };
  }
  if (m.stored_gb) out.stored = { gb: Math.round(m.stored_gb.daily.at(-1)?.avg ?? m.stored_gb.avg), trendPerMonthPct: trendPct(m.stored_gb.trendPerMonth) };
  if (m.read_gb) out.readGbPerMonth = Math.round(m.read_gb.monthlyTotal);
  if (m.egress_gb) out.egress = { gbPerMonth: Math.round(m.egress_gb.monthlyTotal), trendPerMonthPct: trendPct(m.egress_gb.trendPerMonth) };
  if (m.iops) out.iopsP99 = Math.round(m.iops.p99);
  return out;
}
