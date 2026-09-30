/**
 * Time-aware optimization tests.
 *
 * 1. The usage library: percentiles, robust trend, daily rollups, hour-of-week
 *    profiles, idle windows and schedules.
 * 2. Detectors on hand-built usage histories: every rule that sizes, schedules
 *    or removes a resource is checked against the traffic it actually saw —
 *    and against the cases where the engine must hold back instead of guessing.
 * 3. Property-based fuzzing: random estates with random usage histories.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runEngine, runEngineWithCoverage } from "../src/lib/engine";
import { arbitrageWith } from "../src/lib/engine/arbitrage";
import { databaseServerless, kubernetesSpotConsolidation, natToEndpoints, serverlessModernization } from "../src/lib/engine/architecture";
import { commitmentRecommendations } from "../src/lib/engine/commitments";
import { cpuSignal, instanceFloor, memSignal, MIN_HISTORY_DAYS, usageDigest, usageWindow } from "../src/lib/engine/signals";
import { idleNetwork, idleResources, nonProdScheduling, rightsizing, storageTiering } from "../src/lib/engine/standard";
import type { DataGap, Detector, Estate, RecommendationDraft, ResourceRow } from "../src/lib/engine/types";
import { simulate, type WhatIfTransform } from "../src/lib/engine/whatif";
import { PRICES } from "../src/lib/pricing/catalog";
import {
  dailyRollup,
  describeSchedule,
  hourOfWeek,
  idleMask,
  percentile,
  profileSeries,
  profileUsage,
  scheduleTransitions,
  seasonalTheilSen,
  shrunkSlope,
  theilSen,
  withBuffer,
} from "../src/lib/usage/series";
import { summarize } from "../src/lib/usage/summary";
import { assertEngineInvariants, demoEstate, FIXED_END, randomUsageEstate, resource, rng, series, withUsage } from "./fixtures";

const RUNS = Math.max(1, Number(process.env.FUZZ_RUNS ?? 1));

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

const ACCOUNT = { id: "a", provider: "aws" as const, name: "Prod", externalId: "1", region: "us-east-1" };
const estateOf = (...resources: ResourceRow[]): Estate => ({ orgId: "t", accounts: [ACCOUNT], resources, daily: [] });

/** Run one detector and collect what it recommended and what it held back. */
function run(detect: Detector, ...resources: ResourceRow[]): { recs: RecommendationDraft[]; gaps: DataGap[] } {
  const estate: Estate = { ...estateOf(...resources), gaps: [] };
  return { recs: detect(estate), gaps: estate.gaps! };
}

const weekday = (ts: Date) => (ts.getUTCDay() + 6) % 7 < 5;
/** A little deterministic ripple so percentiles are not all identical. */
const ripple = (i: number, amp = 1) => amp * Math.sin(i * 1.7);
const flat = (level: number, amp = 1) => (i: number) => level + ripple(i, amp);
/** Busy on weekdays between [from, to) UTC, quiet otherwise. */
const business = (busy: number, quiet: number, from = 9, to = 18) => (i: number, ts: Date) =>
  (weekday(ts) && ts.getUTCHours() >= from && ts.getUTCHours() < to ? busy : quiet) + ripple(i, 0.3);
/** Grows linearly so that the level rises by `perMonth` (relative to the final level) every 30 days. */
const growing = (final: number, perMonth: number, days: number) => (i: number) => final * (1 - perMonth * ((days * 24 - 1 - i) / 720)) + ripple(i, 0.5);

const GB = 1e9;
const quietNet = (days: number) => [series("net_in", days, () => 1e6, { stat: "sum", unit: "bytes" }), series("net_out", days, () => 1e6, { stat: "sum", unit: "bytes" })];

const vm = (id: string, extra: Partial<ResourceRow> = {}) => resource({ id, accountId: "a", provider: "aws", kind: "compute.vm", sku: "m5.2xlarge", quantity: 4, workload: id, ...extra });

/** A VM fleet with CPU (average and hourly maximum), optional memory, and quiet network. */
function fleet(id: string, days: number, cpu: (i: number, ts: Date) => number, mem: ((i: number, ts: Date) => number) | null, extra: Partial<ResourceRow> = {}) {
  const s = [series("cpu", days, cpu), series("cpu_max", days, (i, ts) => Math.min(100, cpu(i, ts) * 1.2), { stat: "max" }), ...quietNet(days)];
  if (mem) s.push(series("mem", days, mem));
  return withUsage(vm(id, extra), ...s);
}

/* ------------------------------------------------------------------------- */
/* 1. Usage library                                                           */
/* ------------------------------------------------------------------------- */

describe("usage library: statistics", () => {
  it("interpolates percentiles", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
    assert.equal(percentile([0, 10], 95), 9.5);
    assert.equal(percentile([7], 99), 7);
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([5, 1, 3], 0), 1);
    assert.equal(percentile([5, 1, 3], 100), 5);
  });

  it("estimates a trend that outliers cannot bend (Theil–Sen)", () => {
    assert.equal(theilSen([0, 1, 2, 3, 4]), 1);
    assert.equal(theilSen([5, 5, 5, 5]), 0);
    assert.equal(theilSen([1, 2]), 0, "two points are not a trend");
    const spiky = Array.from({ length: 40 }, (_, i) => (i === 20 || i === 31 ? 500 : i));
    assert.ok(Math.abs(theilSen(spiky) - 1) < 0.1, `slope ${theilSen(spiky)} was bent by two spikes`);
  });

  it("compares weekday with weekday, so a weekly rhythm is not mistaken for a trend", () => {
    const week = [30, 32, 31, 33, 30, 8, 7]; // busy weekdays, quiet weekend
    for (const len of [21, 30, 42, 60]) {
      for (let offset = 0; offset < 7; offset++) {
        const flat = Array.from({ length: len }, (_, i) => week[(i + offset) % 7]);
        assert.equal(seasonalTheilSen(flat), 0, `${len} days starting on weekday ${offset}`);
        const rising = flat.map((v, i) => v + 0.2 * i);
        assert.ok(Math.abs(seasonalTheilSen(rising) - 0.2) < 1e-9);
      }
    }
    // With day-to-day noise on top of the rhythm it is about twice as precise as the plain estimate.
    const r = rng(11);
    const errors = { plain: 0, seasonal: 0 };
    for (let t = 0; t < 200; t++) {
      const offset = Math.floor(r() * 7);
      const y = Array.from({ length: 42 }, (_, i) => week[(i + offset) % 7] * (0.9 + r() * 0.2));
      errors.plain += theilSen(y) ** 2;
      errors.seasonal += seasonalTheilSen(y) ** 2;
    }
    assert.ok(errors.seasonal < errors.plain * 0.5, `seasonal ${errors.seasonal} vs plain ${errors.plain}`);
    // Too short for three weeks of comparison: the plain estimate is used.
    assert.equal(seasonalTheilSen([1, 2, 3, 4, 5, 6, 7, 8]), 1);
  });

  it("shrinks a trend that noise alone could have produced, and keeps a clear one", () => {
    const r = rng(5);
    let raw = 0;
    let shrunk = 0;
    for (let t = 0; t < 200; t++) {
      const noise = shrunkSlope(Array.from({ length: 42 }, () => 30 * (0.9 + r() * 0.2)));
      assert.ok(noise.error > 0 && Math.abs(noise.slope) <= Math.abs(noise.raw));
      raw += noise.raw ** 2;
      shrunk += noise.slope ** 2;
    }
    assert.ok(shrunk < raw * 0.75, "on pure noise the reported trend is markedly smaller than the raw estimate");
    // +15% a month with the same noise: well clear of it, kept almost whole.
    const growth = shrunkSlope(Array.from({ length: 42 }, (_, i) => 30 * (1 + (0.15 * (i - 41)) / 30) * (0.9 + r() * 0.2)));
    assert.ok(growth.slope / growth.raw > 0.95);
    assert.ok(growth.slope * 30 / 30 > 0.1 && growth.slope * 30 / 30 < 0.2, `slope ${growth.slope}`);
    // No noise at all: nothing to shrink.
    assert.deepEqual(shrunkSlope([1, 2, 3, 4, 5]), { slope: 1, raw: 1, error: 0 });
    assert.equal(shrunkSlope([4, 4, 4, 4]).slope, 0);
  });

  it("maps timestamps to a Monday-based hour of week", () => {
    assert.equal(new Date("2026-09-28T00:00:00Z").getUTCDay(), 1, "fixture date must be a Monday");
    assert.equal(hourOfWeek(Date.parse("2026-09-28T00:00:00Z")), 0);
    assert.equal(hourOfWeek(Date.parse("2026-09-28T13:00:00Z")), 13);
    assert.equal(hourOfWeek(Date.parse("2026-10-03T00:00:00Z")), 5 * 24, "Saturday");
    assert.equal(hourOfWeek(Date.parse("2026-10-04T23:00:00Z")), 167, "Sunday 23:00 is the last hour of the week");
  });
});

describe("usage library: profiling a series", () => {
  it("reports a flat series as flat, and forecasts it where it is", () => {
    const p = profileSeries(series("cpu", 42, flat(30, 2)));
    assert.ok(Math.abs(p.trendPerMonth) < 0.01, `trend ${p.trendPerMonth}`);
    assert.ok(Math.abs(p.avg - 30) < 0.5 && p.p95 > 30 && p.p95 <= 32.1);
    assert.ok(Math.abs(p.forecast90 - p.p95) < 0.5);
    assert.equal(p.days, 42);
    assert.equal(p.coverage, 1);
  });

  it("measures growth and projects it 90 days ahead", () => {
    const p = profileSeries(series("cpu", 42, growing(30, 0.15, 42)));
    assert.ok(p.trendPerMonth > 0.12 && p.trendPerMonth < 0.2, `trend ${p.trendPerMonth}`);
    assert.ok(p.trendError >= 0 && p.trendError < 0.02, "a clean ramp leaves little doubt about its slope");
    assert.ok(p.forecast90 > p.p95 * 1.3, `forecast ${p.forecast90} vs p95 ${p.p95}`);
  });

  it("measures decline without projecting below zero", () => {
    const p = profileSeries(series("cpu", 42, (i) => Math.max(0, 40 - i * 0.04)));
    assert.ok(p.trendPerMonth < -0.3, `trend ${p.trendPerMonth}`);
    assert.ok(p.forecast90 >= 0);
  });

  it("is not fooled by a one-day spike when estimating the trend", () => {
    const spike = (i: number) => (i >= 20 * 24 && i < 21 * 24 ? 95 : 30 + ripple(i));
    const p = profileSeries(series("cpu", 42, spike));
    assert.ok(Math.abs(p.trendPerMonth) < 0.02, `trend ${p.trendPerMonth}`);
    assert.ok(p.peakDay > 90, "the busiest day is still reported as the peak");
    assert.ok(p.p95 < 40, "while the overall p95 barely notices it");
  });

  it("keeps a month-end peak in view that an overall percentile would hide", () => {
    // One busy day in six weeks: 2.4% of all hours, invisible at p95.
    const monthEnd = (i: number) => (i >= 30 * 24 + 8 && i < 30 * 24 + 20 ? 85 : 12 + ripple(i));
    const p = profileSeries(series("cpu", 42, monthEnd));
    assert.ok(p.p95 < 15);
    assert.ok(p.peakDay > 80);
  });

  it("sums additive metrics over the last 30 days and forecasts the monthly total", () => {
    const p = profileSeries(series("requests", 42, () => 1000, { stat: "sum", unit: "count" }));
    assert.equal(p.monthlyTotal, 720_000);
    assert.ok(Math.abs(p.forecast90 - 720_000) < 1);
    const daily = profileSeries(series("egress_gb", 90, () => 100, { stat: "sum", unit: "gb", stepMinutes: 1440 }));
    assert.equal(daily.monthlyTotal, 3000);
    assert.equal(daily.howP95, undefined, "daily series have no hour-of-week profile");
  });

  it("tolerates missing samples and reports coverage", () => {
    const p = profileSeries(series("cpu", 28, (i) => (i % 5 === 0 ? null : 25)));
    assert.ok(Math.abs(p.coverage - 0.8) < 0.01);
    assert.equal(p.avg, 25);
    assert.equal(profileSeries(series("cpu", 28, () => null)).days, 0);
    // A sum with gaps is scaled to a full month rather than under-reported.
    const req = profileSeries(series("requests", 42, (i) => (i % 4 === 0 ? null : 100), { stat: "sum", unit: "count" }));
    assert.equal(Math.round(req.monthlyTotal), 72_000);
  });

  it("counts days of history by the days that have data, not by the span", () => {
    // Seen for two days six weeks ago and again today: that is not six weeks of history.
    const sparse = profileSeries(series("cpu", 42, (i) => (i < 48 || i >= 41 * 24 ? 20 : null)));
    assert.equal(sparse.days, 3);
    // A machine that only runs eight hours a day has data on every day.
    const officeHours = profileSeries(series("cpu", 28, (_, ts) => (ts.getUTCHours() >= 9 && ts.getUTCHours() < 17 ? 30 : null)));
    assert.ok(officeHours.days > 27 && officeHours.days <= 28, `days ${officeHours.days}`);
    // Complete data: the window length, whatever hour it starts at.
    assert.equal(profileSeries(series("cpu", 42, () => 20, { end: new Date("2026-09-28T13:00:00Z") })).days, 42);
    assert.equal(profileSeries(series("stored_gb", 90, () => 5, { stepMinutes: 1440, unit: "gb" })).days, 90);
  });

  it("drops partial days so they never look like a dip", () => {
    // 10 days of hourly samples starting at 18:00: the first day has 6 samples.
    const s = series("requests", 10, () => 50, { stat: "sum", unit: "count", end: new Date("2026-09-28T18:00:00Z") });
    const days = dailyRollup(s);
    assert.ok(days.every((d) => d.total === 1200), JSON.stringify(days.map((d) => d.total)));
    assert.equal(days.length, 9, "the 6-hour first day and the 18-hour last day are left out");
    // The same goes for a level metric at the edges of the window…
    const level = dailyRollup(series("cpu", 10, () => 40, { end: new Date("2026-09-28T18:00:00Z") }));
    assert.equal(level.length, 9);
    // …while a collection gap in the middle (a day with a third of its samples) is tolerated.
    const gap = dailyRollup(series("cpu", 10, (i) => (i >= 72 && i < 88 ? null : 40)));
    assert.equal(gap.length, 10);
    assert.equal(dailyRollup(series("requests", 10, (i) => (i >= 72 && i < 88 ? null : 50), { stat: "sum", unit: "count" })).length, 9, "an additive day with two thirds of its samples missing is dropped");
  });

  it("derives summary metrics from history and never invents memory", () => {
    const cpu = series("cpu", 30, business(60, 5));
    const withoutMem = summarize(profileUsage([cpu]), { memP95: 33, cpuAvg: 99 });
    assert.equal(withoutMem.memP95, undefined, "a stale memory figure must not survive when no memory series exists");
    assert.ok(withoutMem.cpuAvg! < 30 && withoutMem.cpuP95! > 55);
    assert.equal(withoutMem.hourly?.length, 24);
    const withMem = summarize(profileUsage([cpu, series("mem", 30, flat(44))]));
    assert.ok(Math.abs(withMem.memP95! - 45) < 1.5);
  });
});

describe("usage library: weekly patterns and schedules", () => {
  const cpu = profileSeries(series("cpu", 28, business(60, 2)));

  it("builds an hour-of-week profile", () => {
    assert.equal(cpu.howP95!.length, 168);
    assert.ok(cpu.howP95![10] > 55, "Monday 10:00 is busy");
    assert.ok(cpu.howP95![3] < 5, "Monday 03:00 is quiet");
    assert.ok(cpu.howP95![5 * 24 + 10] < 5, "Saturday 10:00 is quiet");
    assert.ok(cpu.howN!.every((n) => n === 4), "four weeks of history, four samples per bucket");
  });

  it("finds idle hours, adds a buffer and describes the schedule", () => {
    const idle = idleMask(cpu.howP95!, 9, cpu.howN);
    assert.equal(idle.filter((x) => !x).length, 5 * 9);
    const active = withBuffer(idle.map((x) => !x), 1);
    assert.equal(active.filter(Boolean).length, 5 * 11);
    assert.equal(describeSchedule(active), "Mon–Fri 08:00–19:00, Sat–Sun off (UTC)");
    assert.deepEqual(scheduleTransitions(active), {
      starts: [{ hour: 8, days: ["MON", "TUE", "WED", "THU", "FRI"] }],
      stops: [{ hour: 19, days: ["MON", "TUE", "WED", "THU", "FRI"] }],
    });
  });

  it("describes windows that run past midnight once, on the day they start", () => {
    const nightly = Array.from({ length: 168 }, (_, h) => h % 24 >= 23 || h % 24 < 9);
    assert.equal(describeSchedule(nightly), "Every day 23:00–09:00 next day (UTC)");
    const t = scheduleTransitions(nightly);
    assert.deepEqual(t.starts.map((s) => [s.hour, s.days.length]), [[23, 7]]);
    assert.deepEqual(t.stops.map((s) => [s.hour, s.days.length]), [[9, 7]]);
    const friday = Array.from({ length: 168 }, (_, h) => h >= 4 * 24 + 20 && h < 5 * 24 + 6);
    assert.equal(describeSchedule(friday), "Mon–Thu off, Fri 20:00–06:00 next day, Sat–Sun off (UTC)");
    assert.deepEqual(scheduleTransitions(friday), { starts: [{ hour: 20, days: ["FRI"] }], stops: [{ hour: 6, days: ["SAT"] }] });
  });

  it("handles several windows a day, whole days and the trivial masks", () => {
    const split = Array.from({ length: 168 }, (_, h) => (h < 24 ? (h >= 6 && h < 10) || (h >= 14 && h < 18) : h >= 24 && h < 48));
    assert.equal(describeSchedule(split), "Mon 06:00–10:00, 14:00–18:00, Tue all day, Wed–Sun off (UTC)");
    assert.equal(describeSchedule(Array(168).fill(true)), "All week (UTC)");
    assert.equal(describeSchedule(Array(168).fill(false)), "Never (UTC)");
    assert.deepEqual(scheduleTransitions(Array(168).fill(true)), { starts: [], stops: [] });
    // Every start has a matching stop, whatever the mask.
    for (let seed = 1; seed <= 50; seed++) {
      const mask = Array.from({ length: 168 }, (_, h) => Math.sin(h * seed * 0.37) > 0.2);
      const tr = scheduleTransitions(mask);
      const count = (xs: { days: string[] }[]) => xs.reduce((n, x) => n + x.days.length, 0);
      assert.equal(count(tr.starts), count(tr.stops), `seed ${seed}`);
      assert.ok(describeSchedule(mask).endsWith("(UTC)"));
    }
  });

  it("never calls an hour idle that was not observed in at least two weeks", () => {
    // 10 days of history: some hours of the week were seen only once.
    const short = profileSeries(series("cpu", 10, () => 1));
    const idle = idleMask(short.howP95!, 5, short.howN);
    assert.ok(idle.some((x) => x) && idle.some((x) => !x));
    idle.forEach((isIdle, h) => assert.ok(!isIdle || short.howN![h] >= 2));
    // And a collection gap is not an idle window.
    const gappy = profileSeries(series("cpu", 28, (_, ts) => (ts.getUTCHours() < 6 ? null : 50)));
    assert.ok(idleMask(gappy.howP95!, 5, gappy.howN).every((x) => !x), "hours with no data must not count as idle");
    // Nor a quiet hour when capacity is replayed hour by hour: an unobserved hour carries the typical level.
    assert.equal(gappy.howN![3], 0);
    assert.equal(gappy.howP95![3], gappy.p95);
    assert.equal(gappy.howAvg![3], gappy.avg);
  });
});

/* ------------------------------------------------------------------------- */
/* 2. Signals                                                                 */
/* ------------------------------------------------------------------------- */

describe("usage signals", () => {
  it("sizes against the busiest day of the hourly maximum, not the average", () => {
    const r = fleet("f", 30, flat(20), flat(30));
    const cpu = cpuSignal(r)!;
    assert.equal(cpu.source, "history");
    assert.ok(cpu.peak > 24 && cpu.peak < 26, `peak ${cpu.peak} should follow cpu_max (20 × 1.2)`);
    assert.ok(cpu.forecastPeak >= cpu.peak);
  });

  it("projects the peak 90 days ahead when usage is growing, never below today", () => {
    const up = cpuSignal(fleet("up", 42, growing(30, 0.1, 42), flat(30)))!;
    assert.ok(up.forecastPeak > up.peak * 1.2, `${up.peak} → ${up.forecastPeak}`);
    const down = cpuSignal(fleet("down", 42, (i) => 60 - i * 0.03, flat(30)))!;
    assert.ok(down.trendPerMonth < 0);
    assert.equal(down.forecastPeak, down.peak, "a shrinking workload is still sized for today's peak");
  });

  it("returns no memory signal when memory is not measured", () => {
    assert.equal(memSignal(fleet("nomem", 30, flat(20), null)), null);
    // Summary metrics: memory is used when present, absent otherwise.
    assert.equal(memSignal(vm("s1", { metrics: { cpuP95: 20, memP95: 35 } }))!.source, "summary");
    assert.equal(memSignal(vm("s2", { metrics: { cpuP95: 20 } })), null);
    // History without a memory series wins over a stale summary figure.
    const stale = withUsage(vm("s3", { metrics: { cpuP95: 20, memP95: 35 } }), series("cpu", 30, flat(20)));
    assert.equal(memSignal(stale), null);
  });

  it("takes the always-running instance count from the hourly floor", () => {
    const autoscaled = withUsage(vm("asg", { quantity: 10 }), series("instances", 30, (_, ts) => (ts.getUTCHours() >= 8 && ts.getUTCHours() < 20 ? 10 : 4), { unit: "count" }));
    assert.equal(instanceFloor(autoscaled), 4);
    assert.equal(instanceFloor(vm("fixed", { quantity: 6 })), 6, "without history the provisioned quantity is all we know");
  });

  it("summarises history for the AI advisor without letting silence pass for low usage", () => {
    const office = usageDigest(fleet("office", 28, business(60, 2), null))!;
    assert.equal(office.historyDays, 28);
    assert.equal(office.memory, "not measured — do not assume it is low");
    assert.deepEqual(office.weeklyPattern, { busyHoursPerWeek: 55, busyWindow: "Mon–Fri 08:00–19:00, Sat–Sun off (UTC)" });
    const cpu = office.cpu as { avgPct: number; busiestDayPeakPct: number; peakIn90DaysPct: number };
    assert.ok(cpu.avgPct < 20 && cpu.busiestDayPeakPct > 70 && cpu.peakIn90DaysPct >= cpu.busiestDayPeakPct);
    assert.equal(usageDigest(vm("summary-only", { metrics: { cpuP95: 30 } })), undefined, "no history, no digest");

    const demo = demoEstate();
    const digest = (name: string) => usageDigest(demo.resources.find((r) => r.name === name)!)!;
    assert.equal(digest("reporting-workers").memory, "not measured — do not assume it is low");
    assert.deepEqual(digest("gke-prod-pool").instances, { alwaysRunning: 8, max: 10 });
    const alb = digest("api-platform-alb").requests as { perMonthM: number; in6MonthsM: number };
    assert.ok(Math.abs(alb.perMonthM - 600) < 1 && alb.in6MonthsM > 600);
    assert.equal((digest("prod-vpc-nat").nat as { shareToObjectStorage: number }).shareToObjectStorage, 0.72);
    assert.equal((digest("legacy-vpc-nat").nat as { shareToObjectStorage: string }).shareToObjectStorage, "not measured");
    assert.ok((digest("acme-logs-archive").stored as { gb: number }).gb > 80_000);
    // Every digest is plain JSON the model can read.
    for (const r of demo.resources) assert.doesNotThrow(() => JSON.parse(JSON.stringify(usageDigest(r) ?? null)));
  });

  it("needs two weeks of hourly history before it names a usage window", () => {
    assert.equal(usageWindow(fleet("short", 10, business(60, 2), flat(30))), null);
    const w = usageWindow(fleet("ok", 28, business(60, 2), flat(30)))!;
    assert.equal(w.active.filter(Boolean).length, 55);
    assert.ok(Math.abs(w.share - 55 / 168) < 1e-9);
    assert.equal(usageWindow(vm("summary-only", { metrics: { cpuP95: 30 } })), null);
  });
});

/* ------------------------------------------------------------------------- */
/* 3. Rightsizing                                                             */
/* ------------------------------------------------------------------------- */

describe("rightsizing over time", () => {
  it("halves a fleet that stayed small for the whole window, and shows the evidence", () => {
    const { recs, gaps } = run(rightsizing, fleet("api", 42, flat(22), flat(30)));
    assert.equal(gaps.length, 0);
    assert.equal(recs.length, 1);
    const r = recs[0];
    assert.equal(r.confidence, 0.9);
    assert.ok(r.monthlySavings > 0 && r.projectedMonthlyCost < r.currentMonthlyCost);
    assert.match(r.details.explanation, /42 days of hourly history/);
    const u = r.details.usage!;
    assert.equal(u.days, 42);
    assert.deepEqual(u.charts.map((c) => c.id), ["cpu", "mem"]);
    assert.ok(u.charts.every((c) => c.points.length >= 40 && c.lines?.[0].value === 40));
  });

  it("holds back when memory is not measured instead of assuming it is fine", () => {
    const { recs, gaps } = run(rightsizing, fleet("nomem", 42, flat(15), null));
    assert.equal(recs.length, 0);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].kind, "missing_metric");
    assert.match(gaps[0].reason, /memory is not measured/);
    assert.match(gaps[0].fix!, /CloudWatch agent/);
    assert.ok(gaps[0].monthlyCost > 0);
  });

  it("leaves a memory-bound fleet alone without raising a gap", () => {
    const { recs, gaps } = run(rightsizing, fleet("membound", 42, flat(15), flat(70)));
    assert.equal(recs.length, 0);
    assert.equal(gaps.length, 0, "this fleet is correctly sized — nothing is missing");
  });

  it("holds back when usage is growing into the smaller size", () => {
    const { recs, gaps } = run(rightsizing, fleet("growing", 42, growing(26, 0.2, 42), flat(30)));
    assert.equal(recs.length, 0);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].kind, "growing");
    assert.match(gaps[0].reason, /in 90 days CPU \d+% → about \d+%/);
  });

  it("also holds back when only memory is growing", () => {
    const { recs, gaps } = run(rightsizing, fleet("memgrow", 42, flat(15), growing(36, 0.15, 42)));
    assert.equal(recs.length, 0);
    assert.equal(gaps[0]?.kind, "growing");
    assert.match(gaps[0].reason, /memory/);
  });

  it("needs two weeks of history", () => {
    const { recs, gaps } = run(rightsizing, fleet("new", 6, flat(15), flat(30)));
    assert.equal(recs.length, 0);
    assert.equal(gaps[0]?.kind, "short_history");
    // Two weeks are enough to see the peaks, not a trend: recommended, with lower confidence and a caveat.
    const twoWeeks = run(rightsizing, fleet("twoweeks", MIN_HISTORY_DAYS, flat(15), flat(30))).recs;
    assert.equal(twoWeeks.length, 1);
    assert.equal(twoWeeks[0].confidence, 0.8);
    assert.ok(twoWeeks[0].details.risks.some((x) => /Only 14 days of history/.test(x)));
  });

  it("does not mistake an old, sparse history for a long one", () => {
    // Two days of samples at the start of the window, then silence until yesterday.
    const sparse = (i: number) => (i < 48 || i >= 41 * 24 ? 15 : null) as unknown as number;
    const { recs, gaps } = run(rightsizing, fleet("sparse", 42, sparse, flat(30)));
    assert.equal(recs.length, 0);
    assert.equal(gaps[0]?.kind, "short_history");
    assert.match(gaps[0].reason, /Only 3 days of CPU history/);
  });

  it("respects short bursts that hourly averages hide", () => {
    // 15% on average every hour, but the hourly maximum reaches 85%.
    const bursty = withUsage(vm("bursty"), series("cpu", 42, flat(15)), series("cpu_max", 42, flat(85), { stat: "max" }), series("mem", 42, flat(30)), ...quietNet(42));
    const { recs, gaps } = run(rightsizing, bursty);
    assert.equal(recs.length, 0);
    assert.equal(gaps.length, 0);
  });

  it("respects a month-end peak that a p95 over the window would hide", () => {
    const monthEnd = (i: number) => (i >= 30 * 24 + 6 && i < 30 * 24 + 20 ? 70 : 14 + ripple(i));
    const r = fleet("monthend", 42, monthEnd, flat(30));
    assert.ok(r.usage!.metrics.cpu_max.p95 < 40, "the overall p95 looks safe");
    assert.equal(run(rightsizing, r).recs.length, 0, "but the busiest day does not fit on half the capacity");
  });

  it("falls back to summary metrics with lower confidence and says so", () => {
    const { recs } = run(rightsizing, vm("summary", { metrics: { cpuAvg: 10, cpuP95: 22, cpuMax: 35, memP95: 30 } }));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].confidence, 0.72);
    assert.match(recs[0].details.explanation, /summary metrics only/);
    assert.equal(recs[0].details.usage, undefined);
    assert.ok(recs[0].details.risks.some((x) => /No usage trend/.test(x)));
    // Same fleet without a memory figure: a gap, not a recommendation.
    const noMem = run(rightsizing, vm("summary-nomem", { metrics: { cpuAvg: 10, cpuP95: 22, cpuMax: 35 } }));
    assert.equal(noMem.recs.length, 0);
    assert.equal(noMem.gaps[0]?.kind, "missing_metric");
  });

  it("drops a gap once another recommendation already covers the resource", () => {
    // Staging fleet with no memory metric: rightsizing is held back, but the schedule still applies.
    const stg = fleet("stg", 28, business(30, 2), null, { environment: "staging" });
    const { drafts, gaps } = runEngineWithCoverage(estateOf(stg));
    assert.ok(drafts.some((d) => d.detector === "scheduling.nonprod"));
    assert.equal(gaps.length, 0, "the resource is covered — no need to nag about memory");
    // The same fleet in prod has no other recommendation: the gap is reported.
    const prod = runEngineWithCoverage(estateOf(fleet("prd", 28, flat(20), null)));
    assert.equal(prod.gaps.length, 1);
    assert.deepEqual(prod.coverage, { measurable: 1, withHistory: 1, minDays: 28, maxDays: 28, unmeasured: 0 });
    // A machine with no utilisation data at all is neither recommended nor held back — it is counted as unmeasured.
    const dark = runEngineWithCoverage(estateOf(vm("dark"), vm("summary", { metrics: { cpuP95: 60, cpuMax: 80, memP95: 50 } })));
    assert.equal(dark.drafts.length, 0);
    assert.equal(dark.gaps.length, 0);
    assert.deepEqual(dark.coverage, { measurable: 2, withHistory: 0, minDays: 0, maxDays: 0, unmeasured: 1 });
  });
});

/* ------------------------------------------------------------------------- */
/* 4. Idle resources                                                          */
/* ------------------------------------------------------------------------- */

describe("idle detection over time", () => {
  const idleCpu = flat(1.2, 0.3);

  it("flags a host as idle only when CPU and network are both quiet", () => {
    const { recs, gaps } = run(idleResources, fleet("idle", 30, idleCpu, flat(10)));
    assert.equal(gaps.length, 0);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].confidence, 0.9);
    assert.equal(recs[0].projectedMonthlyCost, 0);
    assert.match(recs[0].details.explanation, /network traffic \(in \+ out\) stayed under/);
    assert.deepEqual(recs[0].details.usage!.metrics, ["CPU", "network"]);
  });

  it("does not call a host idle while data still flows through it", () => {
    const serving = withUsage(
      vm("fileserver", { quantity: 1 }),
      series("cpu", 30, idleCpu),
      series("cpu_max", 30, idleCpu, { stat: "max" }),
      series("net_in", 30, () => 1e6, { stat: "sum", unit: "bytes" }),
      // A nightly job pulls 3 GB off the host between 01:00 and 03:00.
      series("net_out", 30, (_, ts) => (ts.getUTCHours() >= 1 && ts.getUTCHours() < 3 ? 1.5 * GB : 1e5), { stat: "sum", unit: "bytes" }),
    );
    const { recs, gaps } = run(idleResources, serving);
    assert.equal(recs.length, 0);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].kind, "in_use");
    assert.match(gaps[0].reason, /3 GB of network traffic/);
  });

  it("says so when network traffic was not measured", () => {
    const cpuOnly = withUsage(vm("cpuonly"), series("cpu", 30, idleCpu), series("cpu_max", 30, idleCpu, { stat: "max" }));
    const { recs } = run(idleResources, cpuOnly);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].confidence, 0.7);
    assert.match(recs[0].details.explanation, /Network traffic is not measured/);
    assert.deepEqual(recs[0].details.usage!.missing, ["network traffic"]);
    assert.doesNotMatch(recs[0].summary, /network/);
  });

  it("ignores a patch reboot, but not a day of real work", () => {
    // One busy hour a week (patching): still idle.
    const patched = (i: number, ts: Date) => (ts.getUTCDay() === 2 && ts.getUTCHours() === 3 ? 60 : 1 + ripple(i, 0.2));
    assert.equal(run(idleResources, fleet("patched", 30, patched, flat(10))).recs.length, 1);
    // Half a day of work once a month: in use.
    const monthly = (i: number) => (i >= 12 * 24 && i < 12 * 24 + 12 ? 40 : 1);
    assert.equal(run(idleResources, fleet("monthly", 30, monthly, flat(10))).recs.length, 0);
  });

  it("waits for two weeks of quiet before calling anything idle", () => {
    const { recs, gaps } = run(idleResources, fleet("new", 5, idleCpu, flat(10)));
    assert.equal(recs.length, 0);
    assert.equal(gaps[0]?.kind, "short_history");
  });

  it("finds load balancers and NAT gateways that carry no traffic", () => {
    const lb = (id: string, perHour: number, days = 30) =>
      withUsage(resource({ id, accountId: "a", provider: "aws", kind: "network.load_balancer", monthlyCost: 20 }), series("requests", days, () => perHour, { stat: "sum", unit: "count" }));
    const nat = (id: string, bytesPerHour: number) =>
      withUsage(resource({ id, accountId: "a", provider: "aws", kind: "network.nat_gateway", monthlyCost: 33 }), series("nat_bytes", 30, () => bytesPerHour, { stat: "sum", unit: "bytes" }));
    const unmeasured = resource({ id: "lb-unknown", accountId: "a", provider: "aws", kind: "network.load_balancer", monthlyCost: 20 });

    const { recs, gaps } = run(idleNetwork, lb("lb-idle", 1), lb("lb-busy", 5000), lb("lb-new", 0, 5), nat("nat-idle", 1e5), nat("nat-busy", 1e9), unmeasured);
    assert.equal(recs.length, 1);
    assert.deepEqual([...recs[0].resourceIds].sort(), ["lb-idle", "nat-idle"]);
    assert.equal(recs[0].title, "Delete 1 idle load balancer and 1 idle NAT gateway");
    assert.equal(recs[0].monthlySavings, 53);
    assert.deepEqual(gaps.map((g) => [g.resourceId, g.kind]), [["lb-new", "short_history"]]);
  });

  it("does not call a load balancer idle because of one quiet week", () => {
    // Busy for three weeks, then a quiet week: the busiest day decides.
    const seasonal = withUsage(
      resource({ id: "lb", accountId: "a", provider: "aws", kind: "network.load_balancer", monthlyCost: 20 }),
      series("requests", 28, (i) => (i < 21 * 24 ? 2000 : 0), { stat: "sum", unit: "count" }),
    );
    assert.equal(run(idleNetwork, seasonal).recs.length, 0);
  });
});

/* ------------------------------------------------------------------------- */
/* 5. Schedules                                                               */
/* ------------------------------------------------------------------------- */

describe("schedules derived from observed usage", () => {
  const stg = (id: string, cpu: (i: number, ts: Date) => number, days = 28, extra: Partial<ResourceRow> = {}) => fleet(id, days, cpu, flat(40), { environment: "staging", workload: null, ...extra });

  it("derives the schedule from the fleet's own hours, with a buffer", () => {
    const { recs } = run(nonProdScheduling, stg("stg", business(50, 2, 9, 18)));
    assert.equal(recs.length, 1);
    const r = recs[0];
    assert.match(r.summary, /Mon–Fri 08:00–19:00, Sat–Sun off \(UTC\)/);
    assert.ok(Math.abs(r.projectedMonthlyCost - r.currentMonthlyCost * (55 / 168)) < 0.01, "cost follows the hours actually needed");
    const hm = r.details.usage!.heatmap!;
    assert.equal(hm.values.length, 168);
    assert.equal(hm.idle!.filter(Boolean).length, 168 - 55);
    assert.match(r.details.terraform!, /cron\(0 8 \? \* MON,TUE,WED,THU,FRI \*\)/);
    assert.match(r.details.terraform!, /cron\(0 19 \? \* MON,TUE,WED,THU,FRI \*\)/);
  });

  it("keeps a Saturday job and an overnight job running", () => {
    const withJobs = (i: number, ts: Date) => {
      const day = (ts.getUTCDay() + 6) % 7;
      const h = ts.getUTCHours();
      if (day === 5 && h >= 2 && h < 4) return 70; // Saturday batch
      if (day === 2 && (h >= 22 || h < 1)) return 65; // Wednesday night release, past midnight
      return business(50, 2, 9, 18)(i, ts);
    };
    const { recs } = run(nonProdScheduling, stg("stg", withJobs));
    const active = recs[0].details.usage!.heatmap!.idle!.map((x) => !x);
    assert.ok(active[5 * 24 + 2] && active[5 * 24 + 3] && active[5 * 24 + 1] && active[5 * 24 + 4], "Saturday 01:00–05:00 stays on");
    assert.ok(active[2 * 24 + 23] && active[3 * 24], "the Wednesday-night window stays on past midnight");
    assert.ok(!active[6 * 24 + 12], "Sunday noon is off");
    assert.match(recs[0].summary, /Sat 01:00–05:00/);
  });

  it("keeps an hour on if it was busy in any observed week", () => {
    // A single late night in four weeks keeps that hour of the week on: an hour is idle only if it was quiet every week.
    const once = (i: number, ts: Date) => (i === 10 * 24 + 23 ? 80 : business(50, 2, 9, 18)(i, ts));
    const s = stg("stg", once);
    const lateHour = hourOfWeek(Date.parse(s.usage!.metrics.cpu.daily[0].d + "T00:00:00Z") + (10 * 24 + 23) * 3_600_000);
    const active = run(nonProdScheduling, s).recs[0].details.usage!.heatmap!.idle!.map((x) => !x);
    assert.ok(active[lateHour], "the hour that was busy once is kept on");
  });

  it("holds back without hourly history instead of assuming office hours", () => {
    const summaryOnly = vm("stg", { environment: "staging", metrics: { cpuAvg: 10, cpuP95: 45, cpuMax: 70, dutyCycle: 0.3 } });
    const a = run(nonProdScheduling, summaryOnly);
    assert.equal(a.recs.length, 0);
    assert.equal(a.gaps[0]?.kind, "missing_metric");
    const b = run(nonProdScheduling, stg("young", business(50, 2), 9));
    assert.equal(b.recs.length, 0);
    assert.equal(b.gaps[0]?.kind, "short_history");
  });

  it("leaves a fleet that is busy around the clock alone", () => {
    const { recs, gaps } = run(nonProdScheduling, stg("ci", flat(45, 3)));
    assert.equal(recs.length, 0);
    assert.equal(gaps.length, 0);
  });

  it("keeps a shared environment up whenever any member is in use", () => {
    const early = stg("early", business(50, 2, 6, 12));
    const late = stg("late", business(50, 2, 12, 22));
    const { recs } = run(nonProdScheduling, early, late);
    assert.equal(recs.length, 1);
    assert.match(recs[0].summary, /Mon–Fri 05:00–23:00/);
    assert.equal(recs[0].resourceIds.length, 2);
  });

  it("prices a batch fleet for the hours its job runs", () => {
    const nightly = (i: number, ts: Date) => (ts.getUTCHours() < 6 ? 92 : 2) + ripple(i, 0.3);
    const batch = (id: string, cpu: (i: number, ts: Date) => number, config = {}) =>
      fleet(id, 28, cpu, flat(50), { sku: "c5.4xlarge", quantity: 6, workload: id, config: { portable: true, interruptible: true, ...config } });

    const windowed = run(arbitrageWith({ sameProviderOnly: true }), batch("etl", nightly)).recs[0];
    const around = run(arbitrageWith({ sameProviderOnly: true }), batch("render", flat(80, 3))).recs[0];
    assert.match(windowed.details.explanation, /busy only during Every day 23:00–07:00 next day \(UTC\) — 33% of the week/);
    assert.match(around.details.explanation, /no regular idle window/);
    // Same fleet, same Spot discount: the windowed one only pays for a third of the hours.
    const spotShare = around.projectedMonthlyCost / around.currentMonthlyCost;
    assert.ok(Math.abs(windowed.projectedMonthlyCost / windowed.currentMonthlyCost - spotShare * (8 / 24)) < 0.005);
    assert.ok(windowed.details.alternatives!.some((a) => /on-demand, job window only/.test(a.label)), "running the current fleet for the job alone is offered as the low-risk option");
    assert.equal(windowed.details.usage!.heatmap!.idle!.filter(Boolean).length, 168 - 7 * 8);
    // A fleet that is not interruption-tolerant is never priced for part of the week.
    assert.equal(run(arbitrageWith({ sameProviderOnly: true }), batch("svc", nightly, { interruptible: false })).recs.length, 0);
    // A fleet that never does anything is not "a job that needs zero hours": it is left to the idle detector.
    const dead = batch("dead", flat(1, 0.2));
    assert.equal(run(arbitrageWith(), dead).recs.length, 0);
    assert.equal(run(idleResources, dead).recs.length, 1);
  });
});

/* ------------------------------------------------------------------------- */
/* 6. Traffic-driven architecture changes                                     */
/* ------------------------------------------------------------------------- */

describe("architecture changes priced on traffic over time", () => {
  const requests = (perMonthM: number, growth: number, days = 42) =>
    series("requests", days, (i) => ((perMonthM * 1e6) / 720) * Math.max(0.05, 1 - growth * ((days * 24 - 1 - i) / 720)) * (1 + 0.5 * Math.sin((i % 24) / 24 * 2 * Math.PI)), { stat: "sum", unit: "count" });
  const service = (perMonthM: number, growth: number, days = 42) => {
    const api = fleet("api", days, business(30, 4), flat(30), { sku: "m5.2xlarge", quantity: 10, workload: "api", config: { stateless: true }, metrics: { cpuAvg: 10, dutyCycle: 0.3 } });
    const lb = withUsage(resource({ id: "lb", accountId: "a", provider: "aws", kind: "network.load_balancer", workload: "api", monthlyCost: 40, metrics: { avgDurationMs: 100 } }), requests(perMonthM, growth, days));
    return [api, lb];
  };

  it("moves a steady service to serverless and shows the break-even", () => {
    const { recs, gaps } = run(serverlessModernization, ...service(100, 0));
    assert.equal(gaps.length, 0);
    assert.equal(recs.length, 1);
    const ev = Object.fromEntries(recs[0].details.evidence.map((e) => [e.label, e.value]));
    assert.equal(ev["Requests / month"], "100M (flat)");
    assert.match(ev["Break-even volume"], /M requests\/month$/);
    assert.ok(recs[0].details.usage!.charts.some((c) => c.id === "requests"));
  });

  it("holds back when growth carries traffic past the break-even", () => {
    // Cheaper today, but growing 20% a month: in six months it no longer pays.
    const steady = run(serverlessModernization, ...service(350, 0)).recs[0];
    assert.ok(steady && steady.monthlySavings > 0, "at a flat 350M requests serverless still wins");
    const { recs, gaps } = run(serverlessModernization, ...service(350, 0.2));
    assert.equal(recs.length, 0);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].kind, "growing");
    assert.match(gaps[0].reason, /traffic is growing \+\d+%\/month/);
  });

  it("needs two weeks of request history to price per-request", () => {
    const { recs, gaps } = run(serverlessModernization, ...service(100, 0, 6));
    assert.equal(recs.length, 0);
    assert.equal(gaps[0]?.kind, "short_history");
  });

  it("sizes a serverless database from its hour-of-week load curve", () => {
    const db = (id: string, cpu: (i: number, ts: Date) => number) =>
      withUsage(resource({ id, accountId: "a", provider: "aws", kind: "db.instance", sku: "db.r5.2xlarge", monthlyCost: 1500, config: { multiAz: false, sizeGb: 200 } }), series("cpu", 28, cpu), series("cpu_max", 28, (i, ts) => cpu(i, ts) * 1.2, { stat: "max" }));
    const office = run(databaseServerless, db("office", business(55, 3))).recs[0];
    assert.ok(office, "a database that is busy a quarter of the week fits serverless");
    assert.equal(office.details.usage!.heatmap!.values.length, 168);
    // The same peak, around the clock: capacity would be billed all day, so there is nothing to gain.
    assert.equal(run(databaseServerless, db("always", flat(55, 2))).recs.length, 0);
  });

  it("packs a Kubernetes pool for its busiest hour and bills the average", () => {
    const pool = (cpu: (i: number, ts: Date) => number, mem: ((i: number, ts: Date) => number) | null, metrics = {}) =>
      fleet("pool", 28, cpu, mem, { sku: "m5.2xlarge", quantity: 20, config: { role: "k8s-node", statelessShare: 0.5 }, metrics: { cpuAvg: 15, ...metrics } });
    const { recs } = run(kubernetesSpotConsolidation, pool(business(45, 10, 8, 20), flat(30)));
    assert.equal(recs.length, 1);
    const hm = recs[0].details.usage!.heatmap!;
    assert.equal(hm.unit, "nodes");
    // Busy hours: 20 × 45% ÷ 65% ≈ 14 nodes. Quiet hours are set by memory: 20 × 31% ÷ 75% ≈ 9.
    assert.equal(Math.max(...hm.values), 14);
    assert.equal(Math.min(...hm.values), 9);
    const nodes = recs[0].details.evidence.find((e) => e.label === "Nodes needed")!.value;
    assert.match(nodes, /^14 at peak · 1\d(\.\d)? on average$/);
    const [od, spot] = recs[0].details.proposed!.components;
    assert.equal(od.usage.count, 7, "on-demand base covers the stateful half at peak");
    assert.ok(spot.usage.spot && spot.usage.count! > 2 && spot.usage.count! < 7);

    // Memory not measured: no guess.
    const blind = run(kubernetesSpotConsolidation, pool(business(45, 10, 8, 20), null));
    assert.equal(blind.recs.length, 0);
    assert.equal(blind.gaps[0]?.kind, "missing_metric");
    // A pool that is already packed at peak and off-peak is left alone.
    assert.equal(run(kubernetesSpotConsolidation, pool(flat(30), flat(68), { cpuAvg: 30 })).recs.length, 0);
  });

  it("uses the measured share of NAT traffic that goes to storage", () => {
    const nat = (id: string, storageShare: number | null, config = {}) =>
      withUsage(
        resource({ id, accountId: "a", provider: "aws", kind: "network.nat_gateway", monthlyCost: 1000, config }),
        series("nat_bytes", 30, () => 40 * GB, { stat: "sum", unit: "bytes" }),
        ...(storageShare === null ? [] : [series("nat_storage_bytes", 30, () => 40 * GB * storageShare, { stat: "sum", unit: "bytes" })]),
      );
    const measured = run(natToEndpoints, nat("n1", 0.6)).recs[0];
    assert.match(measured.summary, /^60% of the 28\.13 TB\/month/, "40 GB an hour for 30 days");
    assert.equal(measured.confidence, 0.93);
    // Below 30% it is not worth a recommendation.
    assert.equal(run(natToEndpoints, nat("n2", 0.1)).recs.length, 0);
    // Unknown destination mix: a gap, not a guess.
    const unknown = run(natToEndpoints, nat("n3", null));
    assert.equal(unknown.recs.length, 0);
    assert.equal(unknown.gaps[0]?.kind, "missing_metric");
    assert.match(unknown.gaps[0].fix!, /Flow Logs/);
    // A supplied (unmeasured) share is used, flagged and trusted less.
    const supplied = run(natToEndpoints, nat("n4", null, { s3TrafficShare: 0.5 })).recs[0];
    assert.equal(supplied.confidence, 0.75);
    assert.match(supplied.details.explanation, /not measured here/);
  });
});

/* ------------------------------------------------------------------------- */
/* 7. Storage                                                                 */
/* ------------------------------------------------------------------------- */

describe("storage over time", () => {
  const bucket = (id: string, gb: number, extra: Partial<ResourceRow> = {}) =>
    resource({ id, accountId: "a", provider: "aws", kind: "storage.object", monthlyCost: gb * PRICES.objectStorage.aws.hot, config: { sizeGb: gb }, ...extra });

  it("nets retrieval fees out of lifecycle savings", () => {
    const b = bucket("logs", 100_000, { metrics: { coldShare30: 0.9, coldShare90: 0.8, objectCount: 1_000_000 } });
    const r = run(storageTiering, b).recs[0];
    const rates = PRICES.objectStorage.aws;
    const storageOnly = 100_000 * (0.1 * rates.hot + 0.1 * rates.cool + 0.8 * rates.cold);
    const retrieval = (10_000 * PRICES.objectRetrievalPerGb.aws.cool + 80_000 * PRICES.objectRetrievalPerGb.aws.cold) / 12;
    assert.ok(retrieval > 0);
    assert.ok(Math.abs(r.projectedMonthlyCost - (storageOnly + retrieval)) < 0.01, `${r.projectedMonthlyCost} vs ${storageOnly + retrieval}`);
    assert.ok(r.details.evidence.some((e) => e.label === "Retrieval fees (included)"));
    assert.deepEqual(r.details.assumptions, ["Each cool/cold object is read back once a year"]);
  });

  it("uses the measured size and growth of the bucket", () => {
    const b = withUsage(
      bucket("grow", 50_000, { metrics: { coldShare30: 0.8, coldShare90: 0.6, objectCount: 10 } }),
      series("stored_gb", 90, (i) => 50_000 + i * 250, { unit: "gb", stepMinutes: 1440 }),
      series("read_gb", 90, () => 20, { stat: "sum", unit: "gb", stepMinutes: 1440 }),
    );
    const r = run(storageTiering, b).recs[0];
    // 50,000 GB growing 250 GB a day for 90 days ends at 72,250 GB = 70.56 TB.
    assert.match(r.details.explanation, /of the 70\.56 TB in grow/, "size comes from the latest measurement, not the stale configured size");
    assert.match(r.details.explanation, /The bucket is growing \+\d+%\/month/);
    assert.match(r.details.explanation, /Reads average 20 GB a day/);
    assert.deepEqual(r.details.usage!.charts.map((c) => c.id), ["stored", "reads"]);
  });

  it("does not guess how cold a bucket is", () => {
    const blind = run(storageTiering, bucket("blind", 20_000));
    assert.equal(blind.recs.length, 0);
    assert.equal(blind.gaps[0]?.kind, "missing_metric");
    assert.match(blind.gaps[0].fix!, /Storage Lens/);
    // Small buckets and buckets that already have a policy are not worth a gap.
    assert.equal(run(storageTiering, bucket("small", 500)).gaps.length, 0);
    assert.equal(run(storageTiering, bucket("managed", 20_000, { config: { sizeGb: 20_000, lifecyclePolicy: true } })).gaps.length, 0);
    // Mostly-hot data is left where it is.
    assert.equal(run(storageTiering, bucket("hot", 20_000, { metrics: { coldShare30: 0.2, coldShare90: 0.1 } })).recs.length, 0);
  });

  it("charges for gp3 IOPS that the volume actually uses", () => {
    const volume = (id: string, sizeGb: number, iops: number | null, days = 30) => {
      const v = resource({ id, accountId: "a", provider: "aws", kind: "storage.block", workload: id, monthlyCost: sizeGb * 0.1, config: { sizeGb, volumeType: "gp2", attached: true } });
      return iops === null ? v : withUsage(v, series("iops", days, () => iops, { unit: "iops" }));
    };
    // 4 TB volume doing 5,000 IOPS: gp3 needs 5,000 × 1.25 = 6,250 → 3,250 above the included 3,000.
    const hot = run(storageTiering, volume("hot", 4000, 5000)).recs[0];
    const expected = 4000 * PRICES.blockStorage.aws.standard + 3250 * PRICES.gp3.perIopsMonth;
    assert.ok(Math.abs(hot.projectedMonthlyCost - expected) < 0.01, `${hot.projectedMonthlyCost} vs ${expected}`);
    assert.match(hot.details.explanation, /of provisioned IOPS/);
    // The surcharge never exceeds what gp2 could deliver (3 IOPS per GB → 9,000 for 3 TB).
    const capped = run(storageTiering, volume("capped", 3000, 20_000)).recs[0];
    assert.ok(Math.abs(capped.projectedMonthlyCost - (3000 * PRICES.blockStorage.aws.standard + 6000 * PRICES.gp3.perIopsMonth)) < 0.01);
    // A quiet volume pays nothing extra.
    const quiet = run(storageTiering, volume("quiet", 2000, 400)).recs[0];
    assert.ok(Math.abs(quiet.projectedMonthlyCost - 2000 * PRICES.blockStorage.aws.standard) < 0.01);
    // Large volume without IOPS data, or with only a few days of it: no estimate.
    const blind = run(storageTiering, volume("blind", 2000, null));
    assert.equal(blind.recs.length, 0);
    assert.equal(blind.gaps[0]?.kind, "missing_metric");
    assert.equal(run(storageTiering, volume("young", 2000, 400, 5)).gaps[0]?.kind, "short_history");
    // Up to 1 TB gp2 cannot exceed 3,000 IOPS, so no measurement is needed.
    const small = run(storageTiering, { ...volume("small", 800, null), quantity: 3, monthlyCost: 240 });
    assert.equal(small.recs.length, 1);
    assert.equal(small.gaps.length, 0);
    assert.match(small.recs[0].details.explanation, /IOPS are not measured; these volumes are 1 TB or smaller/);
  });
});

/* ------------------------------------------------------------------------- */
/* 8. Commitments                                                             */
/* ------------------------------------------------------------------------- */

describe("commitments sized on what always runs", () => {
  const instances = (fn: (i: number, ts: Date) => number) => series("instances", 30, fn, { unit: "count" });
  const prodFleet = (id: string, quantity: number, ...extra: ReturnType<typeof series>[]) =>
    withUsage(vm(id, { quantity, sku: "m5.2xlarge", environment: "prod" }), series("cpu", 30, flat(60)), ...extra);

  it("commits to the hourly floor of an autoscaled fleet, not its peak size", () => {
    const fixed = prodFleet("fixed", 10, instances(() => 10));
    const scaled = prodFleet("scaled", 10, instances((_, ts) => (ts.getUTCHours() >= 8 && ts.getUTCHours() < 20 ? 10 : 4)));
    const [a] = commitmentRecommendations(estateOf(fixed), []);
    const [b] = commitmentRecommendations(estateOf(scaled), []);
    assert.ok(Math.abs(b.currentMonthlyCost / a.currentMonthlyCost - 0.4) < 1e-4, "4 of 10 instances run every hour");
    assert.ok(b.details.evidence.some((e) => /10 provisioned, 4 always running/.test(e.value)));
  });

  it("does not commit to a fleet that scales to zero", () => {
    const nightly = prodFleet("nightly", 10, instances((_, ts) => (ts.getUTCHours() < 6 ? 10 : 0)));
    assert.equal(commitmentRecommendations(estateOf(nightly), []).length, 0);
  });

  it("commits less to a workload that is shrinking", () => {
    const steady = prodFleet("steady", 10, instances(() => 10));
    const shrinking = withUsage(vm("shrinking", { quantity: 10, environment: "prod" }), series("cpu", 42, (i) => 70 - i * 0.04), instances(() => 10));
    const [a] = commitmentRecommendations(estateOf(steady), []);
    const [b] = commitmentRecommendations(estateOf(shrinking), []);
    assert.ok(b.currentMonthlyCost < a.currentMonthlyCost * 0.95);
    assert.ok(b.details.evidence.some((e) => /usage trending -\d+%\/month/.test(e.value)));
  });
});

/* ------------------------------------------------------------------------- */
/* 9. The demo estate end to end                                              */
/* ------------------------------------------------------------------------- */

describe("demo estate with usage history", () => {
  const estate = demoEstate();
  const { drafts, gaps, coverage } = runEngineWithCoverage(estate);
  const byName = (name: string) => estate.resources.find((r) => r.name === name)!;

  it("holds every engine invariant", () => assertEngineInvariants(estate, drafts, "demo"));

  it("has history for every measurable resource", () => {
    assert.ok(coverage.measurable >= 28);
    assert.equal(coverage.withHistory, coverage.measurable);
    assert.ok(coverage.minDays >= 42 && coverage.maxDays >= 90);
  });

  it("holds back exactly where the data says to", () => {
    const kinds = Object.fromEntries(gaps.map((g) => [g.resource, g.kind]));
    assert.deepEqual(kinds, { "checkout-api-asg": "growing", "reporting-workers": "missing_metric", "old-bi-server": "in_use" });
    for (const g of gaps) {
      assert.ok(!drafts.some((d) => !d.overlapsWith && d.resourceIds.includes(g.resourceId)), `${g.resource} has both a gap and a recommendation`);
    }
    // None of the three is quietly recommended by another usage-based detector.
    assert.ok(!drafts.some((d) => d.detector === "rightsizing.vm" && d.resourceIds.includes(byName("reporting-workers").id)));
    assert.ok(!drafts.some((d) => d.detector === "idle.vm" && d.resourceIds.includes(byName("old-bi-server").id)));
  });

  it("backs every usage-based recommendation with the history it used", () => {
    const usageBased = ["rightsizing.vm", "rightsizing.db", "idle.vm", "idle.network", "scheduling.nonprod", "arch.serverless", "arch.db_serverless", "arch.k8s_spot", "arch.nat_endpoints", "arch.app_platform", "arch.cross_cloud", "storage.lifecycle"];
    for (const d of drafts.filter((x) => usageBased.includes(x.detector))) {
      const u = d.details.usage;
      assert.ok(u, `${d.title}: no usage evidence`);
      assert.ok(u.days >= MIN_HISTORY_DAYS, `${d.title}: only ${u.days} days`);
      assert.ok(u.charts.length > 0 || u.heatmap, `${d.title}: nothing to show`);
      for (const c of u.charts) {
        assert.ok(c.points.length >= MIN_HISTORY_DAYS && c.points.every((p) => Number.isFinite(p.v) && /^\d{4}-\d\d-\d\d$/.test(p.d)), `${d.title}: chart ${c.id}`);
      }
      if (u.heatmap) assert.ok(u.heatmap.values.length === 168 && u.heatmap.values.every(Number.isFinite) && (!u.heatmap.idle || u.heatmap.idle.length === 168), `${d.title}: heatmap`);
    }
  });

  it("derives both non-prod schedules from their own working hours", () => {
    const schedules = drafts.filter((d) => d.detector === "scheduling.nonprod").map((d) => d.details.usage!.heatmap!.schedule);
    assert.deepEqual(schedules.sort(), ["Mon–Fri 06:00–20:00, Sat–Sun off (UTC)", "Mon–Fri 08:00–19:00, Sat–Sun off (UTC)"]);
  });

  it("commits to 8 of the 10 GKE nodes", () => {
    const gcp = drafts.find((d) => d.detector === "commitment" && d.provider === "gcp")!;
    assert.ok(gcp.details.evidence.some((e) => /10 provisioned, 8 always running/.test(e.value)));
  });

  it("is deterministic for a fixed end date, and survives JSON storage", () => {
    const again = runEngine(demoEstate(FIXED_END));
    assert.deepEqual(again.map((d) => [d.fingerprint, d.monthlySavings]), drafts.map((d) => [d.fingerprint, d.monthlySavings]));
    const roundTrip = JSON.parse(JSON.stringify(drafts.map((d) => d.details)));
    assert.deepEqual(roundTrip, drafts.map((d) => JSON.parse(JSON.stringify(d.details))));
    assert.ok(!JSON.stringify(drafts).includes("null,null"), "no NaN leaked into stored details");
  });

  it("gives the same answer whatever day of the week it runs", () => {
    // The engine looks at whole weeks of history, so shifting "now" by a few days must not flip a decision.
    const base = new Set(drafts.filter((d) => d.category !== "anomaly").map((d) => d.fingerprint));
    for (let shift = 1; shift <= 6; shift++) {
      const later = runEngineWithCoverage(demoEstate(new Date(FIXED_END.getTime() + shift * 86_400_000 + shift * 3_600_000)));
      const got = new Set(later.drafts.filter((d) => d.category !== "anomaly").map((d) => d.fingerprint));
      assert.deepEqual([...got].sort(), [...base].sort(), `+${shift} days`);
      assert.deepEqual(later.gaps.map((g) => `${g.resource}:${g.kind}`).sort(), gaps.map((g) => `${g.resource}:${g.kind}`).sort(), `+${shift} days`);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 10. What-if scenarios                                                      */
/* ------------------------------------------------------------------------- */

describe("what-if scenarios say what the data did not support", () => {
  const estate = demoEstate();
  const plan = (...types: WhatIfTransform["type"][]) => ({ interpretation: "", assumptions: [], transforms: types.map((type) => ({ type, providers: [], workloads: [], environments: [] })) });

  it("lists the fleets a right-sizing scenario left out, with the reason", () => {
    const r = simulate(estate, plan("rightsizing"));
    const reasons = Object.fromEntries(r.notEligible.map((n) => [n.name, n.reason]));
    assert.match(reasons["reporting-workers"], /memory is not measured.*CloudWatch agent/);
    assert.match(reasons["checkout-api-asg"], /usage is growing/);
    assert.ok(r.steps[0].items.some((i) => /core-services/.test(i.title)), "fleets with the data to back it are still resized");
  });

  it("does not count a host that still serves data as removable", () => {
    const r = simulate(estate, plan("remove_idle"));
    assert.ok(r.notEligible.some((n) => n.name === "old-bi-server" && /network traffic/.test(n.reason)));
    const removed = r.steps[0].items.flatMap((i) => i.resourceIds);
    assert.ok(!removed.includes(estate.resources.find((x) => x.name === "old-bi-server")!.id));
    assert.ok(r.steps[0].items.some((i) => /idle load balancers/.test(i.title)), "idle load balancers and NAT gateways are part of the scenario");
  });

  it("drops a reason once another lever in the same scenario covers the resource", () => {
    // Staging has no memory gap to report, and nothing that the schedule covers shows up as left out.
    const r = simulate(estate, plan("rightsizing", "schedule_nonprod", "remove_idle"));
    const changed = new Set(r.steps.flatMap((st) => st.items.flatMap((i) => i.resourceIds)));
    for (const n of r.notEligible) {
      const res = estate.resources.find((x) => x.name === n.name);
      if (res) assert.ok(!changed.has(res.id), `${n.name} is both changed and listed as left out`);
    }
  });

  it("sizes containers from measured CPU and says so when there is none", () => {
    const measured = fleet("web", 28, flat(20), flat(30), { quantity: 10, workload: "web" });
    const blind = vm("legacy", { quantity: 10, workload: "legacy" });
    const r = simulate(estateOf(measured, blind), plan("containers"));
    assert.equal(r.steps[0].items.length, 1);
    assert.match(r.steps[0].items[0].title, /^Containerize web \(10 VMs → ~\d+ serverless container replicas\)$/);
    assert.deepEqual(r.notEligible.map((n) => n.name), ["legacy"]);
    assert.match(r.notEligible[0].reason, /CPU utilisation is not measured/);
    // A growing fleet gets the capacity it will need in 90 days, not today's.
    const replicas = (e: Estate) => Number(simulate(e, plan("containers")).steps[0].items[0].title.match(/~(\d+) serverless/)![1]);
    const steady = replicas(estateOf(fleet("api", 42, flat(20), flat(30), { quantity: 10, workload: "api" })));
    const growingFleet = replicas(estateOf(fleet("api", 42, growing(20, 0.15, 42), flat(30), { quantity: 10, workload: "api" })));
    assert.ok(growingFleet > steady, `${growingFleet} vs ${steady}`);
  });
});

/* ------------------------------------------------------------------------- */
/* 11. Property-based fuzzing with usage histories                            */
/* ------------------------------------------------------------------------- */

describe("property-based fuzzing: random usage histories", () => {
  it(`holds engine invariants and usage guardrails across ${200 * RUNS} random estates`, () => {
    let withGaps = 0;
    let withEvidence = 0;
    for (let seed = 1; seed <= 200 * RUNS; seed++) {
      const estate = randomUsageEstate(seed);
      const { drafts, gaps, coverage } = runEngineWithCoverage(estate);
      const label = `usage seed ${seed}`;
      assertEngineInvariants(estate, drafts, label);

      const byId = new Map(estate.resources.map((r) => [r.id, r]));
      const primary = new Set(drafts.filter((d) => !d.overlapsWith).flatMap((d) => d.resourceIds));
      assert.ok(coverage.withHistory <= coverage.measurable, label);
      for (const g of gaps) {
        assert.ok(byId.has(g.resourceId), `${label}: gap for unknown resource`);
        assert.ok(g.reason.length > 20 && !/NaN|undefined|Infinity/.test(g.reason), `${label}: gap reason "${g.reason}"`);
        assert.ok(!primary.has(g.resourceId), `${label}: ${g.resource} has a gap and a primary recommendation`);
        assert.ok(Number.isFinite(g.monthlyCost) && g.monthlyCost >= 0, label);
      }
      if (gaps.length) withGaps++;

      for (const d of drafts) {
        const where = `${label} / ${d.title}`;
        assert.ok(!/NaN|undefined|Infinity/.test(d.summary + d.details.explanation + d.details.evidence.map((e) => e.value).join(" ")), `${where}: broken text`);
        const u = d.details.usage;
        if (u) {
          withEvidence++;
          assert.ok(Number.isFinite(u.days) && u.days >= 0, where);
          for (const c of u.charts) assert.ok(c.points.length >= 2 && c.points.every((p) => Number.isFinite(p.v)), `${where}: chart ${c.id}`);
          if (u.heatmap) assert.ok(u.heatmap.values.length === 168 && u.heatmap.values.every(Number.isFinite), `${where}: heatmap`);
        }
        const members = d.resourceIds.map((id) => byId.get(id)!);
        if (d.detector === "rightsizing.vm") {
          for (const r of members) {
            const cpu = cpuSignal(r)!;
            const mem = memSignal(r);
            assert.ok(mem, `${where}: resized ${r.name} without a memory measurement`);
            assert.ok(cpu.forecastPeak <= 40 + 1e-9 && mem.forecastPeak <= 40 + 1e-9, `${where}: ${r.name} would exceed 80% after halving (cpu ${cpu.forecastPeak}, mem ${mem.forecastPeak})`);
            if (cpu.source === "history") assert.ok(cpu.days >= MIN_HISTORY_DAYS, `${where}: ${r.name} resized on ${cpu.days} days of history`);
          }
        }
        if (d.detector === "idle.vm") {
          for (const r of members) {
            const cpu = cpuSignal(r)!;
            assert.ok(cpu.source === "summary" || (cpu.days >= MIN_HISTORY_DAYS && cpu.peak < 5), `${where}: ${r.name} is not idle (peak ${cpu.peak}, ${cpu.days} days)`);
          }
        }
        if (d.detector === "scheduling.nonprod") {
          const hm = u?.heatmap;
          assert.ok(hm?.idle, `${where}: schedule without a usage heatmap`);
          const runtime = hm.idle.filter((x) => !x).length / 168;
          assert.ok(runtime <= 0.7 + 1e-9 && Math.abs(d.projectedMonthlyCost - d.currentMonthlyCost * runtime) < 0.02, `${where}: runtime ${runtime}`);
          for (const r of members) assert.ok(usageWindow(r), `${where}: ${r.name} scheduled without two weeks of hourly history`);
        }
      }
      const again = runEngineWithCoverage(randomUsageEstate(seed));
      assert.deepEqual(again.drafts.map((x) => [x.fingerprint, x.monthlySavings]), drafts.map((x) => [x.fingerprint, x.monthlySavings]), `${label}: non-deterministic`);
    }
    assert.ok(withGaps > 20 * RUNS && withEvidence > 100 * RUNS, `fuzz corpus too tame: ${withGaps} estates with gaps, ${withEvidence} recommendations with evidence`);
  });
});
