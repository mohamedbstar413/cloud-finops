import type { ResourceMetrics } from "../engine/types";
import { profileUsage, type Series, type Stat, type Unit } from "../usage/series";
import { summarize } from "../usage/summary";

/**
 * Shared helpers for turning provider monitoring data into usage series.
 * Everything here is pure: the provider connectors fetch, these functions
 * align, combine and summarize.
 */

/** Hourly utilisation and traffic: six weeks, so every hour of the week is seen six times. */
export const HOURLY_DAYS = 42;
/** Daily storage and transfer figures. */
export const DAILY_DAYS = 90;

export interface CollectionWindow {
  start: Date;
  end: Date;
  stepMinutes: number;
  steps: number;
}

/** The collection window, aligned to whole steps in UTC so samples line up across metrics and resources. */
export function collectionWindow(days: number, stepMinutes = 60, now: Date = new Date()): CollectionWindow {
  const step = stepMinutes * 60_000;
  const end = new Date(Math.floor(now.getTime() / step) * step);
  const steps = Math.round((days * 1440) / stepMinutes);
  return { start: new Date(end.getTime() - steps * step), end, stepMinutes, steps };
}

export interface Point {
  /** Epoch milliseconds of the start of the sample's period. */
  t: number;
  v: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Place sparse points on the window's grid. Samples the provider did not
 * return stay null (a gap is not a zero). Returns null when there is no data
 * at all, so a metric that is not collected never becomes an empty series.
 */
export function toSeries(metric: string, stat: Stat, unit: Unit, w: CollectionWindow, points: Point[] | undefined, transform?: (v: number) => number): Series | null {
  if (!points?.length) return null;
  const step = w.stepMinutes * 60_000;
  const values: (number | null)[] = Array.from({ length: w.steps }, () => null);
  let any = false;
  for (const p of points) {
    const i = Math.round((p.t - w.start.getTime()) / step);
    const v = transform ? transform(p.v) : p.v;
    if (i < 0 || i >= w.steps || !Number.isFinite(v)) continue;
    values[i] = r3(v);
    any = true;
  }
  return any ? { metric, stat, unit, stepMinutes: w.stepMinutes, start: w.start.toISOString(), values } : null;
}

/**
 * Combine series sample by sample: read + write operations ("sum"), the members
 * of a fleet ("avg" / "max"), or how many members reported in each hour
 * ("count"). A sample is missing only when every input misses it.
 */
export function combine(metric: string, stat: Stat, unit: Unit, inputs: (Series | null | undefined)[], how: "sum" | "avg" | "max" | "count"): Series | null {
  const series = inputs.filter((s): s is Series => Boolean(s));
  if (!series.length) return null;
  const n = Math.max(...series.map((s) => s.values.length));
  const values = Array.from({ length: n }, (_, i) => {
    const present = series.map((s) => s.values[i]).filter((v): v is number => v !== null && v !== undefined);
    if (!present.length) return how === "count" ? 0 : null;
    const sum = present.reduce((a, b) => a + b, 0);
    return r3(how === "sum" ? sum : how === "avg" ? sum / present.length : how === "max" ? Math.max(...present) : present.length);
  });
  return { metric, stat, unit, stepMinutes: series[0].stepMinutes, start: series[0].start, values };
}

/** Apply a function to every present sample (unit conversions, bytes free → percent used). */
export function mapSeries(s: Series | null | undefined, metric: string, unit: Unit, fn: (v: number) => number): Series | null {
  if (!s) return null;
  return { ...s, metric, unit, values: s.values.map((v) => (v === null ? null : r3(fn(v)))) };
}

/** Sum of the last `days` of an additive series (0 when there is none). */
export function lastDaysTotal(s: Series | null | undefined, days = 30): number {
  if (!s) return 0;
  const n = Math.round((days * 1440) / s.stepMinutes);
  return s.values.slice(-n).reduce<number>((a, v) => a + (v ?? 0), 0);
}

/** Most recent present sample. */
export function latest(s: Series | null | undefined): number | undefined {
  if (!s) return undefined;
  for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) return s.values[i] as number;
  return undefined;
}

/**
 * The series a resource ends up with, and the summary metrics derived from
 * them. Summary metrics always come from the history, never the other way
 * round, so the two cannot disagree.
 */
export function withUsage(base: ResourceMetrics, series: (Series | null | undefined)[]): { metrics: ResourceMetrics; series: Series[] } {
  const present = series.filter((s): s is Series => Boolean(s));
  return { series: present, metrics: present.length ? summarize(profileUsage(present), base) : base };
}

/** Run a collection step; on failure record a warning and carry on with what was collected. */
export async function attempt<T>(warnings: string[], what: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    warnings.push(`${what}: ${msg.slice(0, 240)}`);
    return fallback;
  }
}
