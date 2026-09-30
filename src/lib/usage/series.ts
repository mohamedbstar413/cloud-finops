/**
 * Usage time series and their analysis: robust trend, weekly (hour-of-week)
 * profile, peaks, forecast and idle windows. Pure functions shared by the
 * engine, connectors, demo data and UI.
 *
 * Series are stored columnar: one array of samples per metric, at a fixed step
 * (hourly or daily), starting at `start` (UTC). `null` marks a missing sample.
 */

export type Stat = "avg" | "max" | "sum";
export type Unit = "percent" | "bytes" | "count" | "ms" | "gb" | "iops";

export interface Series {
  /** e.g. cpu, cpu_max, mem, net_in, net_out, requests, latency_p95, instances, iops, nat_bytes, nat_storage_bytes, stored_gb, read_gb, egress_gb, scanned_gb, connections */
  metric: string;
  stat: Stat;
  unit: Unit;
  stepMinutes: number;
  /** ISO timestamp of the first sample. */
  start: string;
  values: (number | null)[];
}

export interface DailyPoint {
  d: string;
  avg: number;
  p95: number;
  max: number;
  total: number;
}

export interface MetricProfile {
  metric: string;
  stat: Stat;
  unit: Unit;
  stepMinutes: number;
  /** Days of history: the span of the samples, capped by the number of days that have data. */
  days: number;
  /** Share of expected samples that are present. */
  coverage: number;
  avg: number;
  p10: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /**
   * The busiest day's p95: the highest level the metric held for a few hours on
   * any single day. Unlike an overall percentile it keeps a month-end or weekly
   * peak in view, while still ignoring one-off spikes of an hour or so.
   */
  peakDay: number;
  /** p99 ÷ average — how peaky the metric is. */
  peakToAvg: number;
  /** Share of samples above half of the p95 ("busy" share). */
  busyShare: number;
  /**
   * Relative change per 30 days of the daily level. Estimated weekday against
   * weekday (seasonal Theil–Sen: robust to outliers and to the weekly rhythm)
   * and shrunk towards zero by its own uncertainty, so day-to-day noise is not
   * reported — or acted on — as growth.
   */
  trendPerMonth: number;
  /** One standard error of the trend (relative, per 30 days): what six noisy weeks cannot tell apart from flat. */
  trendError: number;
  /** Projected p95 in 90 days for level metrics; projected 30-day total in 90 days for additive metrics. */
  forecast90: number;
  /** Sum over the last 30 days (additive metrics only). */
  monthlyTotal: number;
  daily: DailyPoint[];
  /** Hour-of-week mean and p95 (168 values, Monday 00:00 UTC first); hourly series only. */
  howAvg?: number[];
  howP95?: number[];
  /** Samples behind each hour-of-week bucket (how many weeks that hour was observed). */
  howN?: number[];
}

export interface UsageProfile {
  /** Longest history available across metrics. */
  days: number;
  metrics: Record<string, MetricProfile>;
}

export const HOURS_PER_WEEK = 168;
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Theil–Sen slope: median of pairwise slopes. Robust to spikes and gaps. */
export function theilSen(y: number[]): number {
  const pts = y.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 3) return 0;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) slopes.push((pts[j][1] - pts[i][1]) / (pts[j][0] - pts[i][0]));
  return percentile(slopes, 50);
}

/**
 * Sen's slope for seasonal data: pairwise slopes are taken only between points
 * a whole number of periods apart (the same weekday), so a weekly rhythm —
 * quiet weekends, a Monday peak — cannot masquerade as growth or decline,
 * whichever day the window happens to start on. Falls back to the plain
 * estimate when there are fewer than three periods to compare.
 */
export function seasonalTheilSen(y: number[], period = 7): number {
  if (y.length < 3 * period) return theilSen(y);
  const slopes: number[] = [];
  for (let i = 0; i < y.length; i++) {
    if (!Number.isFinite(y[i])) continue;
    for (let j = i + period; j < y.length; j += period) {
      if (Number.isFinite(y[j])) slopes.push((y[j] - y[i]) / (j - i));
    }
  }
  return slopes.length >= 3 ? percentile(slopes, 50) : theilSen(y);
}

/**
 * The seasonal slope with its standard error, shrunk towards zero by how
 * uncertain it is: slope × slope² / (slope² + error²). A slope well clear of
 * the noise is kept almost whole; one the noise could have produced on its own
 * mostly disappears. The error comes from the scatter left after removing the
 * trend and each weekday's typical level.
 */
export function shrunkSlope(y: number[], period = 7): { slope: number; raw: number; error: number } {
  const n = y.length;
  const raw = seasonalTheilSen(y, period);
  if (n < 3) return { slope: 0, raw, error: 0 };
  const detrended = y.map((v, i) => v - raw * i);
  const seasonal = n >= 3 * period;
  const offsets = Array.from({ length: period }, (_, k) => percentile(detrended.filter((_, i) => i % period === k), 50));
  const centre = percentile(detrended, 50);
  const residuals = detrended.map((v, i) => Math.abs(v - (seasonal ? offsets[i % period] : centre)));
  const sigma = 1.4826 * percentile(residuals, 50);
  const error = sigma * Math.sqrt(12 / (n * (n * n - 1)));
  const weight = raw === 0 ? 0 : (raw * raw) / (raw * raw + error * error);
  return { slope: raw * weight, raw, error };
}

export function timestampAt(s: Series, i: number): number {
  return Date.parse(s.start) + i * s.stepMinutes * 60_000;
}

const DAY_MS = 86_400_000;

/** Monday-based hour of week (0 = Monday 00:00 UTC). Plain arithmetic: 1970-01-01 was a Thursday. */
export function hourOfWeek(ts: number): number {
  return ((Math.floor(ts / DAY_MS) + 3) % 7) * 24 + (Math.floor(ts / 3_600_000) % 24);
}

/** Present samples grouped by UTC day number (days since the epoch). */
function samplesByDay(s: Series): Map<number, number[]> {
  const start = Date.parse(s.start);
  const step = s.stepMinutes * 60_000;
  const perDay = new Map<number, number[]>();
  for (let i = 0; i < s.values.length; i++) {
    const v = s.values[i];
    if (v === null || !Number.isFinite(v)) continue;
    const day = Math.floor((start + i * step) / DAY_MS);
    const arr = perDay.get(day);
    if (arr) arr.push(v);
    else perDay.set(day, [v]);
  }
  return perDay;
}

/**
 * One point per UTC day. Days with too few samples are dropped so they never
 * show up as a dip: the first and last day are usually partial (the window
 * starts and ends mid-day) and need 80% of their samples, as does every day of
 * an additive metric (its total is then scaled to the full day). A level metric
 * tolerates collection gaps on the days in between.
 */
export function dailyRollup(s: Series, perDay: Map<number, number[]> = samplesByDay(s)): DailyPoint[] {
  const stepsPerDay = Math.max(1, Math.round(1440 / s.stepMinutes));
  const full = Math.max(1, Math.ceil(stepsPerDay * 0.8));
  const some = Math.max(1, Math.ceil(stepsPerDay * 0.25));
  const firstDay = Math.floor(timestampAt(s, 0) / DAY_MS);
  const lastDay = Math.floor(timestampAt(s, Math.max(0, s.values.length - 1)) / DAY_MS);
  return [...perDay.entries()]
    .filter(([day, vs]) => vs.length >= (s.stat === "sum" || day === firstDay || day === lastDay ? full : some))
    .sort((a, b) => a[0] - b[0])
    .map(([day, vs]) => ({
      d: new Date(day * DAY_MS).toISOString().slice(0, 10),
      avg: mean(vs),
      p95: percentile(vs, 95),
      max: Math.max(...vs),
      total: (vs.reduce((x, y) => x + y, 0) * stepsPerDay) / Math.min(stepsPerDay, vs.length),
    }));
}

export function profileSeries(s: Series): MetricProfile {
  const present = s.values.filter((v): v is number => v !== null && Number.isFinite(v));
  const perDay = samplesByDay(s);
  const daily = dailyRollup(s, perDay);
  const additive = s.stat === "sum";
  const stepsPerDay = 1440 / s.stepMinutes;
  const avg = mean(present);
  const p95 = percentile(present, 95);
  const p99 = percentile(present, 99);

  // Trend of the daily level over the last 60 days (daily totals for additive metrics, daily p95 otherwise),
  // compared weekday with weekday so the weekly rhythm does not read as a trend.
  const level = daily.slice(-60).map((d) => (additive ? d.total : stepsPerDay > 1 ? d.p95 : d.avg));
  const medianLevel = percentile(level, 50);
  const { slope, error } = shrunkSlope(level);
  const trendPerMonth = medianLevel > 1e-9 ? Math.max(-0.9, Math.min(3, (slope * 30) / medianLevel)) : 0;
  const trendError = medianLevel > 1e-9 ? (error * 30) / medianLevel : 0;

  const last30 = s.values.slice(-30 * stepsPerDay).filter((v): v is number => v !== null && Number.isFinite(v));
  const monthlyTotal = additive ? last30.reduce((a, b) => a + b, 0) * ((30 * stepsPerDay) / Math.max(1, last30.length)) : 0;
  const recent = s.values.slice(-14 * stepsPerDay).filter((v): v is number => v !== null && Number.isFinite(v));
  const growth90 = Math.max(0, 1 + trendPerMonth * 3);
  const forecast90 = additive ? monthlyTotal * Math.max(0, (1 + trendPerMonth) ** 3) : percentile(recent.length ? recent : present, 95) * growth90;

  let howAvg: number[] | undefined;
  let howP95: number[] | undefined;
  let howN: number[] | undefined;
  if (s.stepMinutes === 60) {
    const buckets: number[][] = Array.from({ length: HOURS_PER_WEEK }, () => []);
    s.values.forEach((v, i) => {
      if (v !== null && Number.isFinite(v)) buckets[hourOfWeek(timestampAt(s, i))].push(v);
    });
    // An hour of the week with no samples gets the metric's typical level, never zero: no data is not no load.
    howAvg = buckets.map((b) => (b.length ? mean(b) : avg));
    howP95 = buckets.map((b) => (b.length ? percentile(b, 95) : p95));
    howN = buckets.map((b) => b.length);
  }

  // Days of history: the span from the first to the last sample, but never more than the number of
  // days that actually have data — a machine seen for two days three weeks ago has two days of history.
  const firstIdx = s.values.findIndex((v) => v !== null);
  const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
  const span = firstIdx < 0 ? 0 : ((lastIdx - firstIdx + 1) * s.stepMinutes) / 1440;
  const enough = Math.max(1, Math.ceil(stepsPerDay * 0.25));
  const days = Math.min(span, [...perDay.values()].filter((vs) => vs.length >= enough).length);

  return {
    metric: s.metric,
    stat: s.stat,
    unit: s.unit,
    stepMinutes: s.stepMinutes,
    days: Math.round(days * 10) / 10,
    coverage: s.values.length ? present.length / s.values.length : 0,
    avg,
    p10: percentile(present, 10),
    p50: percentile(present, 50),
    p95,
    p99,
    max: present.length ? Math.max(...present) : 0,
    peakDay: daily.length ? Math.max(...daily.map((d) => d.p95)) : p95,
    peakToAvg: avg > 0 ? p99 / avg : 1,
    busyShare: present.length && p95 > 0 ? present.filter((v) => v > 0.5 * p95).length / present.length : 0,
    trendPerMonth,
    trendError,
    forecast90,
    monthlyTotal,
    daily,
    howAvg,
    howP95,
    howN,
  };
}

export function profileUsage(series: Series[]): UsageProfile {
  const metrics: Record<string, MetricProfile> = {};
  for (const s of series) {
    if (!s.values.length) continue;
    metrics[s.metric] = profileSeries(s);
  }
  return { days: Math.max(0, ...Object.values(metrics).map((m) => m.days)), metrics };
}

/* ------------------------------------------------------------------------- */
/* Schedules                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Hours of the week in which the resource is consistently idle: the p95 over
 * every observed week stays below `threshold`. An hour seen in fewer than
 * `minWeeks` weeks is never called idle — no data is not the same as no load.
 */
export function idleMask(howP95: number[], threshold: number, howN?: number[], minWeeks = 2): boolean[] {
  return howP95.map((v, i) => v < threshold && (howN ? howN[i] >= minWeeks : true));
}

/** Active hours plus a safety buffer before and after each active window. */
export function withBuffer(active: boolean[], hours = 1): boolean[] {
  const n = active.length;
  return active.map((_, i) => {
    for (let k = -hours; k <= hours; k++) if (active[(i + k + n) % n]) return true;
    return false;
  });
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * "Mon–Fri 07:00–19:00, Sat–Sun off (UTC)" from a 168-hour active mask. A
 * window that runs past midnight is shown once, on the day it starts
 * ("Every day 23:00–09:00 next day").
 */
export function describeSchedule(active: boolean[]): string {
  if (active.every(Boolean)) return "All week (UTC)";
  if (!active.some(Boolean)) return "Never (UTC)";
  // Windows per day as [startHour, endHour) pairs.
  const perDay: [number, number][][] = DAY_NAMES.map((_, d) => {
    const hours = active.slice(d * 24, d * 24 + 24);
    const windows: [number, number][] = [];
    let start = -1;
    for (let h = 0; h <= 24; h++) {
      const on = h < 24 && hours[h];
      if (on && start < 0) start = h;
      if (!on && start >= 0) {
        windows.push([start, h]);
        start = -1;
      }
    }
    return windows;
  });
  // Join a window that ends at midnight with the one that starts the next day at midnight.
  const overnight: (number | null)[] = perDay.map(() => null);
  const dropFirst = perDay.map(() => false);
  perDay.forEach((windows, d) => {
    const next = perDay[(d + 1) % 7];
    const last = windows[windows.length - 1];
    if (!last || last[1] !== 24 || last[0] === 0 || !next.length || next[0][0] !== 0 || next[0][1] === 24) return;
    overnight[d] = next[0][1];
    dropFirst[(d + 1) % 7] = true;
  });
  const text = perDay.map((windows, d) => {
    const parts = windows
      .filter((_, i) => !(i === 0 && dropFirst[d]))
      .map(([from, to], i, kept) => {
        if (i === kept.length - 1 && overnight[d] !== null && to === 24) return `${hh(from)}–${hh(overnight[d]!)} next day`;
        return from === 0 && to === 24 ? "all day" : `${hh(from)}–${hh(to)}`;
      });
    return parts.length ? parts.join(", ") : "off";
  });
  const groups: { from: number; to: number; text: string }[] = [];
  text.forEach((t, d) => {
    const last = groups[groups.length - 1];
    if (last && last.text === t && last.to === d - 1) last.to = d;
    else groups.push({ from: d, to: d, text: t });
  });
  const days = (g: { from: number; to: number }) => (g.from === 0 && g.to === 6 ? "Every day" : g.from === g.to ? DAY_NAMES[g.from] : `${DAY_NAMES[g.from]}–${DAY_NAMES[g.to]}`);
  return groups.map((g) => `${days(g)} ${g.text}`).join(", ") + " (UTC)";
}

export interface ScheduleTransition {
  /** UTC hour (0–23). */
  hour: number;
  /** Days on which the transition happens, e.g. ["MON", "TUE"]. */
  days: string[];
}

/**
 * Start and stop times for a 168-hour active mask, grouped by hour so a regular
 * week needs one start rule and one stop rule. Handles windows that cross
 * midnight and weeks with several windows per day.
 */
export function scheduleTransitions(active: boolean[]): { starts: ScheduleTransition[]; stops: ScheduleTransition[] } {
  const n = active.length;
  const starts = new Map<number, string[]>();
  const stops = new Map<number, string[]>();
  if (active.every(Boolean) || !active.some(Boolean)) return { starts: [], stops: [] };
  for (let i = 0; i < n; i++) {
    const before = active[(i - 1 + n) % n];
    if (active[i] === before) continue;
    const target = active[i] ? starts : stops;
    const day = DAY_NAMES[Math.floor(i / 24)].toUpperCase();
    target.set(i % 24, [...(target.get(i % 24) ?? []), day]);
  }
  const list = (m: Map<number, string[]>) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([hour, days]) => ({ hour, days }));
  return { starts: list(starts), stops: list(stops) };
}
