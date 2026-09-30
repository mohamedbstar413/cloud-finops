import { DAILY_DAYS, HOURLY_DAYS } from "../connectors/usage";
import type { Series, Unit } from "../usage/series";
import { hash, rng } from "./estate";

/**
 * Deterministic usage history for the demo estate: 42 days of hourly samples
 * (90 days daily for storage and transfer) with realistic shapes — diurnal
 * traffic, weekends, business hours, nightly batch windows, growth and noise.
 * Summary metrics shown in the app are derived from these series.
 */

/** The same windows the real connectors collect. */
const USAGE_DAYS = HOURLY_DAYS;

interface Shape {
  /** Mean level before scaling to a target. */
  level?: number;
  /** Diurnal peakiness: 0 = flat, higher = sharper daytime peak. */
  peak?: number;
  /** UTC hour of the daily peak. */
  peakHour?: number;
  /** Active only Mon–Fri within [start, end) UTC; `floor` otherwise. */
  business?: [number, number];
  /** Active only within [start, end) UTC every day (batch windows). */
  window?: [number, number];
  /** Multiplier on Saturday and Sunday. */
  weekend?: number;
  /** Relative growth per 30 days (the level at the end of the window is the target). */
  growth?: number;
  noise?: number;
  /** Level outside active windows, as a share of the active level. */
  floor?: number;
  cap?: number;
}

interface Target {
  p95?: number;
  avg?: number;
  /** Sum over the last 30 days. */
  total30?: number;
}

function generator(key: string, end: Date) {
  const endHour = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), end.getUTCHours());
  const hourly = USAGE_DAYS * 24;
  const startHourly = endHour - (hourly - 1) * 3_600_000;
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const startDaily = endDay - (DAILY_DAYS - 1) * 86_400_000;
  let n = 0;

  const shapeAt = (ts: number, i: number, total: number, s: Shape, rand: () => number) => {
    const d = new Date(ts);
    const hour = d.getUTCHours();
    const weekend = (d.getUTCDay() + 6) % 7 >= 5;
    let v = 1;
    if (s.business) v = !weekend && hour >= s.business[0] && hour < s.business[1] ? 1 : (s.floor ?? 0.04);
    else if (s.window) v = hour >= s.window[0] && hour < s.window[1] ? 1 : (s.floor ?? 0.03);
    else if (s.peak) {
      const c = (1 + Math.cos(((hour - (s.peakHour ?? 15)) / 24) * 2 * Math.PI)) / 2;
      v = (s.floor ?? 0.15) + (1 - (s.floor ?? 0.15)) * c ** s.peak;
    }
    if (weekend && s.weekend !== undefined && !s.business) v *= s.weekend;
    const monthsFromEnd = (total - 1 - i) / (total > DAILY_DAYS ? 720 : 30);
    v *= Math.max(0.05, 1 - (s.growth ?? 0) * monthsFromEnd);
    v *= 1 + (rand() - 0.5) * 2 * (s.noise ?? 0.08);
    return Math.max(0, v * (s.level ?? 1));
  };

  const scale = (values: number[], t: Target, stepsPer30: number, cap?: number) => {
    let k = 1;
    if (t.p95 !== undefined) {
      const sorted = [...values].sort((a, b) => a - b);
      const p = sorted[Math.floor(0.95 * (sorted.length - 1))] || 1;
      k = t.p95 / p;
    } else if (t.avg !== undefined) {
      k = t.avg / (values.reduce((a, b) => a + b, 0) / values.length || 1);
    } else if (t.total30 !== undefined) {
      k = t.total30 / (values.slice(-stepsPer30).reduce((a, b) => a + b, 0) || 1);
    }
    return values.map((v) => Math.min(cap ?? Infinity, Math.round(v * k * 1000) / 1000));
  };

  const series = (metric: string, stat: Series["stat"], unit: Unit, values: number[], daily = false): Series => ({
    metric,
    stat,
    unit,
    stepMinutes: daily ? 1440 : 60,
    start: new Date(daily ? startDaily : startHourly).toISOString(),
    values,
  });

  return {
    hourly(shape: Shape, target: Target): number[] {
      const rand = rng(hash(`${key}:${++n}`));
      const raw = Array.from({ length: hourly }, (_, i) => shapeAt(startHourly + i * 3_600_000, i, hourly, shape, rand));
      return scale(raw, target, 720, shape.cap);
    },
    daily(shape: Shape, target: Target): number[] {
      const rand = rng(hash(`${key}:${++n}`));
      const raw = Array.from({ length: DAILY_DAYS }, (_, i) => shapeAt(startDaily + i * 86_400_000, i, DAILY_DAYS, { ...shape, peak: undefined, business: undefined, window: undefined }, rand));
      return scale(raw, target, 30, shape.cap);
    },
    /** A related metric that follows `base` (e.g. hourly max vs hourly average). */
    follow(base: number[], factor: number, noise = 0.08, cap?: number): number[] {
      const rand = rng(hash(`${key}:${++n}`));
      return base.map((v) => Math.min(cap ?? Infinity, Math.round(v * factor * (1 + (rand() - 0.5) * 2 * noise) * 1000) / 1000));
    },
    constant(v: number): number[] {
      return Array.from({ length: hourly }, () => v);
    },
    series,
  };
}

const GB = 1e9;

/** Usage series for one demo resource (empty when the resource has none, e.g. a bare volume). */
export function demoUsage(key: string, end: Date = new Date()): Series[] {
  const g = generator(key, end);
  const pct = (metric: string, values: number[], stat: Series["stat"] = "avg") => g.series(metric, stat, "percent", values);
  const web = (p95: number, extra: Shape = {}) => g.hourly({ peak: 2.2, peakHour: 16, weekend: 0.72, noise: 0.1, cap: 100, ...extra }, { p95 });
  const steady = (p95: number, extra: Shape = {}) => g.hourly({ peak: 0.6, peakHour: 15, weekend: 0.9, noise: 0.06, cap: 100, ...extra }, { p95 });
  /** Memory barely follows the clock: a flat level with a little noise. */
  const memory = (p95: number, extra: Shape = {}) => g.hourly({ weekend: 0.97, noise: 0.04, cap: 100, ...extra }, { p95 });
  const vm = (cpu: number[], mem: number[] | null, instances: number[], netOutGbPerHour = 0.2, netInGbPerHour = 0.1) => {
    const out: Series[] = [pct("cpu", cpu), pct("cpu_max", g.follow(cpu, 1.3, 0.1, 100), "max")];
    if (mem) out.push(pct("mem", mem));
    out.push(
      g.series("net_in", "sum", "bytes", g.follow(cpu, (netInGbPerHour * GB) / Math.max(0.01, avgOf(cpu)), 0.15)),
      g.series("net_out", "sum", "bytes", g.follow(cpu, (netOutGbPerHour * GB) / Math.max(0.01, avgOf(cpu)), 0.15)),
      g.series("instances", "avg", "count", instances),
    );
    return out;
  };

  switch (key) {
    /* ---------------- AWS Production ---------------- */
    case "api-asg": {
      const cpu = web(32, { growth: 0.02 });
      return vm(cpu, memory(36), g.constant(14), 25, 5);
    }
    case "api-alb": {
      const req = g.hourly({ peak: 2.6, peakHour: 16, weekend: 0.7, growth: 0.03, noise: 0.1 }, { total30: 600e6 });
      return [g.series("requests", "sum", "count", req), g.series("latency_p95", "avg", "ms", g.hourly({ peak: 0.5, noise: 0.12 }, { avg: 120 }))];
    }
    case "api-ebs":
      return [g.series("iops", "avg", "iops", web(6000, { cap: undefined }))];
    case "api-egress":
      return [g.series("egress_gb", "sum", "gb", g.daily({ growth: 0.02, noise: 0.08 }, { total30: 18_432 }), true)];
    case "api-db": {
      const cpu = g.hourly({ business: [8, 20], floor: 0.2, noise: 0.15, cap: 100 }, { p95: 28 });
      return [pct("cpu", cpu), pct("cpu_max", g.follow(cpu, 1.15, 0.08, 100), "max"), pct("mem", memory(35)), g.series("connections", "avg", "count", g.follow(cpu, 6, 0.1))];
    }
    case "core-asg":
      return vm(steady(25), memory(30), g.constant(12));
    case "core-ebs":
      return [g.series("iops", "avg", "iops", steady(2400, { cap: undefined }))];
    case "platform-asg":
      return vm(steady(71), memory(64), g.constant(10));
    case "batch-fleet": {
      const cpu = g.hourly({ window: [0, 8], floor: 0.02, noise: 0.05, cap: 100 }, { p95: 96 });
      return vm(cpu, g.hourly({ window: [0, 8], floor: 0.3, noise: 0.05, cap: 100 }, { p95: 71 }), g.constant(8), 4, 120);
    }
    case "batch-ebs":
      return [g.series("iops", "avg", "iops", g.hourly({ window: [0, 8], floor: 0.05, noise: 0.1 }, { p95: 2600 }))];
    case "mkt-web":
      return vm(web(11), memory(20), g.constant(4), 11);
    case "mkt-alb":
      return [g.series("requests", "sum", "count", g.hourly({ peak: 2.2, peakHour: 17, weekend: 0.8, noise: 0.1 }, { total30: 45e6 }))];
    case "mkt-egress":
      return [g.series("egress_gb", "sum", "gb", g.daily({ noise: 0.1 }, { total30: 8192 }), true)];
    case "nat": {
      const bytes = g.hourly({ peak: 1.2, peakHour: 15, weekend: 0.8, growth: 0.02, noise: 0.08 }, { total30: 38_912 * GB });
      return [g.series("nat_bytes", "sum", "bytes", bytes), g.series("nat_storage_bytes", "sum", "bytes", g.follow(bytes, 0.72, 0.04))];
    }
    case "old-alb":
      // A handful of stray requests a day: scanners, not a workload.
      return [g.series("requests", "sum", "count", g.hourly({ noise: 1 }, { total30: 420 }).map(Math.round))];
    case "old-nat":
      return [g.series("nat_bytes", "sum", "bytes", g.hourly({ noise: 0.6 }, { total30: 0.4 * GB }))];
    case "legacy":
      return vm(g.hourly({ noise: 0.3, cap: 100 }, { avg: 0.8 }), memory(10), g.constant(2), 0.0001, 0.0001);
    case "reporting-workers":
      // No CloudWatch agent on these hosts: CPU and network only, no memory.
      return vm(steady(18, { peak: 0.9 }), null, g.constant(6));
    case "checkout-api":
      // Launched recently and growing fast: even its busiest day is still under the limit today.
      return vm(web(25, { growth: 0.16, peak: 1.4 }), memory(35, { growth: 0.1 }), g.constant(8), 3, 1);
    case "s3-logs":
      return [
        g.series("stored_gb", "avg", "gb", g.daily({ growth: 0.015, noise: 0.002 }, { avg: 81_920 }), true),
        g.series("read_gb", "sum", "gb", g.daily({ noise: 0.25 }, { total30: 1_200 }), true),
      ];
    case "s3-media":
      return [
        g.series("stored_gb", "avg", "gb", g.daily({ growth: 0.02, noise: 0.002 }, { avg: 40_960 }), true),
        g.series("read_gb", "sum", "gb", g.daily({ noise: 0.2, weekend: 0.8 }, { total30: 9_000 }), true),
      ];
    case "s3-analytics":
      return [g.series("stored_gb", "avg", "gb", g.daily({ growth: 0.01, noise: 0.002 }, { avg: 20_480 }), true)];

    /* ---------------- AWS Staging ---------------- */
    case "stg-app": {
      const cpu = g.hourly({ business: [7, 19], floor: 0.03, noise: 0.25, cap: 100 }, { p95: 52 });
      return vm(cpu, g.hourly({ business: [7, 19], floor: 0.6, noise: 0.05, cap: 100 }, { p95: 48 }), g.constant(10));
    }
    case "stg-db":
      return [pct("cpu", g.hourly({ business: [7, 19], floor: 0.08, noise: 0.2, cap: 100 }, { p95: 22 }))];

    /* ---------------- Azure ---------------- */
    case "aks-pool":
      return vm(web(48, { peak: 1.2, weekend: 0.85 }), memory(55), g.constant(12));
    case "azsql": {
      const cpu = g.hourly({ business: [8, 18], floor: 0.07, noise: 0.2, cap: 100 }, { p95: 41 });
      return [pct("cpu", cpu), pct("cpu_max", g.follow(cpu, 1.35, 0.1, 100), "max")];
    }
    case "appsvc":
      return [pct("cpu", web(24)), g.series("requests", "sum", "count", g.hourly({ peak: 2.2, peakHour: 15, weekend: 0.6, noise: 0.12 }, { total30: 40e6 }))];
    case "search":
      return vm(steady(66), memory(78), g.constant(6));
    case "az-dev": {
      const cpu = g.hourly({ business: [9, 18], floor: 0.03, noise: 0.3, cap: 100 }, { p95: 45 });
      return vm(cpu, g.hourly({ business: [9, 18], floor: 0.5, noise: 0.05, cap: 100 }, { p95: 52 }), g.constant(6));
    }
    case "az-idle": {
      // CPU is idle, but a nightly job still pulls ~2 GB off this host: it is in use.
      const out = vm(g.hourly({ noise: 0.3, cap: 100 }, { avg: 0.6 }), memory(22), g.constant(1), 0.0001, 0.0001);
      const netOut = g.hourly({ window: [1, 3], floor: 0.0005, noise: 0.1 }, { total30: 60 * GB });
      return out.map((s) => (s.metric === "net_out" ? { ...s, values: netOut } : s));
    }
    case "az-blob":
      return [
        g.series("stored_gb", "avg", "gb", g.daily({ growth: 0.01, noise: 0.002 }, { avg: 122_880 }), true),
        g.series("read_gb", "sum", "gb", g.daily({ noise: 0.3 }, { total30: 1_800 }), true),
      ];
    case "az-egress":
      return [g.series("egress_gb", "sum", "gb", g.daily({ noise: 0.1 }, { total30: 6_144 }), true)];

    /* ---------------- GCP ---------------- */
    case "gke-pool": {
      // Cluster autoscaler: 8 nodes at night, 10 during the day.
      const nodes = g.hourly({ peak: 1, peakHour: 15, floor: 0, noise: 0 }, { p95: 1 }).map((v) => (v > 0.5 ? 10 : 8));
      return vm(steady(74, { peak: 0.9 }), memory(70), nodes);
    }
    case "gcs-lake":
      return [
        g.series("stored_gb", "avg", "gb", g.daily({ growth: 0.015, noise: 0.002 }, { avg: 61_440 }), true),
        g.series("read_gb", "sum", "gb", g.daily({ noise: 0.1 }, { total30: 28_672 }), true),
      ];
    case "gcp-xcloud":
      return [g.series("egress_gb", "sum", "gb", g.daily({ growth: 0.03, noise: 0.08 }, { total30: 28_672 }), true)];
    case "bq": {
      const scanned = g.daily({ noise: 0.12 }, { total30: 256_000 });
      return [g.series("scanned_gb", "sum", "gb", scanned.map((v, i) => (i >= DAILY_DAYS - 6 ? Math.round(v * 2.7) : v)), true)];
    }
    case "cloudsql":
      return [pct("cpu", steady(62, { peak: 0.8 }))];
    case "gce-idle":
      return vm(g.hourly({ noise: 0.3, cap: 100 }, { avg: 0.9 }), memory(12), g.constant(3), 0.0001, 0.0001);
    default:
      return [];
  }
}

function avgOf(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}
