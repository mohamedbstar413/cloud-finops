/**
 * Connector tests: how monitoring data from each cloud becomes usage series.
 *
 * The provider SDK calls themselves need real accounts and are not exercised
 * here. Everything between "the API answered" and "the engine has a usage
 * profile" is: batching and paging, aligning sparse samples on the collection
 * grid, combining metrics, unit conversions and the derived summary metrics.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GetMetricDataCommand, GetMetricDataCommandOutput, ListMetricsCommand, ListMetricsCommandOutput } from "@aws-sdk/client-cloudwatch";
import { fetchMetrics, listMetricDimensions, memoryDimensionsFor, type MetricSpec } from "../src/lib/connectors/aws-metrics";
import { azurePoints, toDaily, type AzureMetricsResponse } from "../src/lib/connectors/azure";
import { gcpPoints } from "../src/lib/connectors/gcp";
import { normalizeEnvironment } from "../src/lib/connectors/types";
import { attempt, collectionWindow, combine, HOURLY_DAYS, lastDaysTotal, latest, mapSeries, toSeries, withUsage } from "../src/lib/connectors/usage";
import { runEngineWithCoverage } from "../src/lib/engine";
import type { Estate } from "../src/lib/engine/types";
import { profileUsage } from "../src/lib/usage/series";
import { resource } from "./fixtures";

const NOW = new Date("2026-09-28T10:37:12Z");
const HOUR = 3_600_000;

describe("collection window", () => {
  it("is aligned to whole hours so samples line up across metrics", () => {
    const w = collectionWindow(HOURLY_DAYS, 60, NOW);
    assert.equal(w.end.toISOString(), "2026-09-28T10:00:00.000Z");
    assert.equal(w.start.toISOString(), "2026-08-17T10:00:00.000Z");
    assert.equal(w.steps, 42 * 24);
  });

  it("aligns daily windows to UTC midnight", () => {
    const w = collectionWindow(90, 1440, NOW);
    assert.equal(w.end.toISOString(), "2026-09-28T00:00:00.000Z");
    assert.equal(w.steps, 90);
    assert.equal(w.start.toISOString(), "2026-06-30T00:00:00.000Z");
  });
});

describe("building series from sparse samples", () => {
  const w = collectionWindow(2, 60, NOW); // 48 hourly steps
  const at = (i: number) => w.start.getTime() + i * HOUR;

  it("places samples on the grid and leaves gaps as null, not zero", () => {
    const s = toSeries("cpu", "avg", "percent", w, [{ t: at(0), v: 10 }, { t: at(2), v: 30.12345 }, { t: at(47), v: 50 }])!;
    assert.equal(s.values.length, 48);
    assert.deepEqual(s.values.slice(0, 4), [10, null, 30.123, null]);
    assert.equal(s.values[47], 50);
    assert.equal(s.start, w.start.toISOString());
    assert.equal(s.stepMinutes, 60);
  });

  it("ignores samples outside the window and non-finite values", () => {
    const s = toSeries("cpu", "avg", "percent", w, [{ t: at(-1), v: 99 }, { t: at(48), v: 99 }, { t: at(5), v: NaN }, { t: at(6), v: 7 }])!;
    assert.deepEqual(s.values.filter((v) => v !== null), [7]);
  });

  it("tolerates timestamps that are a little off the grid", () => {
    const s = toSeries("cpu", "avg", "percent", w, [{ t: at(3) + 40_000, v: 1 }, { t: at(4) - 40_000, v: 2 }])!;
    assert.equal(s.values[3], 1);
    assert.equal(s.values[4], 2);
  });

  it("returns no series at all when a metric is not collected", () => {
    assert.equal(toSeries("mem", "avg", "percent", w, undefined), null);
    assert.equal(toSeries("mem", "avg", "percent", w, []), null);
    assert.equal(toSeries("mem", "avg", "percent", w, [{ t: at(-5), v: 1 }]), null);
  });

  it("converts units while aligning", () => {
    // FreeableMemory (bytes) on a 16 GiB instance → percent used.
    const total = 16 * 2 ** 30;
    const s = toSeries("mem", "avg", "percent", w, [{ t: at(0), v: total * 0.25 }], (free) => 100 * (1 - free / total))!;
    assert.equal(s.values[0], 75);
  });

  it("combines series sample by sample", () => {
    const a = toSeries("x", "sum", "count", w, [{ t: at(0), v: 1 }, { t: at(1), v: 2 }]);
    const b = toSeries("x", "sum", "count", w, [{ t: at(1), v: 10 }, { t: at(2), v: 20 }]);
    assert.deepEqual(combine("x", "sum", "count", [a, b, null], "sum")!.values.slice(0, 4), [1, 12, 20, null]);
    assert.deepEqual(combine("x", "avg", "count", [a, b], "avg")!.values.slice(0, 4), [1, 6, 20, null]);
    assert.deepEqual(combine("x", "max", "count", [a, b], "max")!.values.slice(0, 4), [1, 10, 20, null]);
    // "count" is how many members reported: the running-instance history of a fleet.
    assert.deepEqual(combine("instances", "avg", "count", [a, b], "count")!.values.slice(0, 4), [1, 2, 1, 0]);
    assert.equal(combine("x", "sum", "count", [null, undefined], "sum"), null);
  });

  it("maps, totals and reads the latest value", () => {
    const bytes = toSeries("b", "sum", "bytes", w, Array.from({ length: 48 }, (_, i) => ({ t: at(i), v: 2e9 })));
    assert.equal(lastDaysTotal(bytes, 1), 48e9);
    assert.equal(lastDaysTotal(null), 0);
    const gb = mapSeries(bytes, "gb", "gb", (v) => v / 1e9)!;
    assert.equal(gb.metric, "gb");
    assert.equal(latest(gb), 2);
    assert.equal(latest(toSeries("x", "avg", "count", w, [{ t: at(3), v: 9 }])), 9);
    assert.equal(latest(null), undefined);
  });

  it("derives summary metrics from the series, and nothing when there are none", () => {
    const cpu = toSeries("cpu", "avg", "percent", w, Array.from({ length: 48 }, (_, i) => ({ t: at(i), v: 20 + (i % 5) })));
    const withCpu = withUsage({ memP95: 50 }, [cpu, null]);
    assert.equal(withCpu.series.length, 1);
    assert.ok(withCpu.metrics.cpuAvg! > 21 && withCpu.metrics.cpuAvg! < 23);
    assert.equal(withCpu.metrics.memP95, undefined, "memory is never carried over without a memory series");
    assert.deepEqual(withUsage({ objectCount: 5 }, [null]), { series: [], metrics: { objectCount: 5 } });
  });

  it("turns a failed collection step into a warning", async () => {
    const warnings: string[] = [];
    assert.equal(await attempt(warnings, "EC2 metrics", 0, async () => 7), 7);
    assert.equal(
      await attempt(warnings, "RDS metrics in us-east-1", -1, async () => {
        throw new Error("AccessDenied: not authorized to perform cloudwatch:GetMetricData");
      }),
      -1,
    );
    assert.deepEqual(warnings, ["RDS metrics in us-east-1: AccessDenied: not authorized to perform cloudwatch:GetMetricData"]);
  });
});

describe("AWS CloudWatch", () => {
  const w = collectionWindow(HOURLY_DAYS, 60, NOW);
  const specs: MetricSpec[] = Array.from({ length: 250 }, (_, i) => ({ id: `i-${i}|cpu`, namespace: "AWS/EC2", metric: "CPUUtilization", dimensions: [{ Name: "InstanceId", Value: `i-${i}` }], stat: "Average" }));

  /** A fake CloudWatch that answers every query with two pages of three points. */
  function fakeCloudWatch() {
    const calls: { queries: number; token?: string; period?: number }[] = [];
    const client = {
      async send(cmd: GetMetricDataCommand): Promise<GetMetricDataCommandOutput> {
        const input = cmd.input;
        const queries = input.MetricDataQueries ?? [];
        calls.push({ queries: queries.length, token: input.NextToken, period: queries[0]?.MetricStat?.Period });
        const second = input.NextToken === "page-2";
        return {
          $metadata: {},
          NextToken: second ? undefined : "page-2",
          MetricDataResults: queries.map((q) => {
            const n = Number(q.MetricStat!.Metric!.Dimensions![0].Value!.slice(2));
            const base = second ? 3 : 0;
            return {
              Id: q.Id,
              Timestamps: [0, 1, 2].map((k) => new Date(w.start.getTime() + (base + k) * HOUR)),
              Values: [0, 1, 2].map((k) => n + (base + k) / 10),
            };
          }),
        };
      },
    };
    return { client, calls };
  }

  it("batches queries to stay inside one response and follows every page", async () => {
    const { client, calls } = fakeCloudWatch();
    const data = await fetchMetrics(client, specs, w);
    // 1,008 points per metric → 99 metrics per call → 3 batches, 2 pages each.
    assert.deepEqual(calls.map((c) => c.queries), [99, 99, 99, 99, 52, 52]);
    assert.deepEqual(calls.map((c) => c.token), [undefined, "page-2", undefined, "page-2", undefined, "page-2"]);
    assert.ok(calls.every((c) => c.period === 3600));
    assert.equal(data.size, 250);
    // Results come back under the caller's ids, with both pages merged in order.
    const s = toSeries("cpu", "avg", "percent", w, data.get("i-137|cpu"))!;
    assert.deepEqual(s.values.slice(0, 7), [137, 137.1, 137.2, 137.3, 137.4, 137.5, null]);
  });

  it("uses daily batches of 500 for storage metrics", async () => {
    const { client, calls } = fakeCloudWatch();
    const daily = collectionWindow(90, 1440, NOW);
    await fetchMetrics(client, [...specs, ...specs, ...specs].map((s, i) => ({ ...s, id: `${i}` })), daily);
    assert.deepEqual(calls.filter((c) => !c.token).map((c) => c.queries), [500, 250]);
    assert.ok(calls.every((c) => c.period === 86_400));
  });

  it("discovers the dimensions the CloudWatch agent publishes memory under", async () => {
    const pages: ListMetricsCommandOutput[] = [
      { $metadata: {}, NextToken: "more", Metrics: [{ Dimensions: [{ Name: "InstanceId", Value: "i-1" }, { Name: "ImageId", Value: "ami-1" }, { Name: "InstanceType", Value: "m5.large" }] }, { Dimensions: [{ Name: "InstanceId", Value: "i-1" }] }] },
      { $metadata: {}, Metrics: [{ Dimensions: [{ Name: "AutoScalingGroupName", Value: "web" }] }, { Dimensions: [{ Name: "AutoScalingGroupName", Value: "web" }, { Name: "InstanceId", Value: "i-2" }] }, { Dimensions: [{ Name: "host", Value: "ip-10-0-0-1" }] }] },
    ];
    let page = 0;
    const tokens: (string | undefined)[] = [];
    const sets = await listMetricDimensions(
      {
        async send(cmd: ListMetricsCommand) {
          tokens.push(cmd.input.NextToken);
          return pages[page++];
        },
      },
      "CWAgent",
      "mem_used_percent",
    );
    assert.deepEqual(tokens, [undefined, "more"]);
    assert.equal(sets.length, 5);
    // An instance: the set that names it, with the fewest extra dimensions.
    assert.deepEqual(memoryDimensionsFor(sets, { instanceId: "i-1" }), [{ Name: "InstanceId", Value: "i-1" }]);
    assert.deepEqual(memoryDimensionsFor(sets, { instanceId: "i-2" })?.map((d) => d.Name), ["AutoScalingGroupName", "InstanceId"]);
    // A group: the aggregated set only, never one member's.
    assert.deepEqual(memoryDimensionsFor(sets, { autoScalingGroup: "web" }), [{ Name: "AutoScalingGroupName", Value: "web" }]);
    // Not published: nothing, so no memory series is created and the engine reports the gap.
    assert.equal(memoryDimensionsFor(sets, { instanceId: "i-9" }), undefined);
    assert.equal(memoryDimensionsFor(sets, { autoScalingGroup: "api" }), undefined);
  });
});

describe("Azure Monitor", () => {
  const res: AzureMetricsResponse = {
    value: [
      { name: { value: "Percentage CPU" }, timeseries: [{ data: [{ timeStamp: "2026-09-27T00:00:00Z", average: 12, maximum: 40 }, { timeStamp: "2026-09-27T01:00:00Z" }, { timeStamp: "2026-09-27T02:00:00Z", average: 18, maximum: 55 }] }] },
      { name: { value: "Network Out Total" }, timeseries: [{ data: [{ timeStamp: "2026-09-27T00:00:00Z", total: 5e8 }] }] },
    ],
  };

  it("reads one metric and aggregation, skipping hours without data", () => {
    assert.deepEqual(azurePoints(res, "Percentage CPU", "average"), [{ t: Date.parse("2026-09-27T00:00:00Z"), v: 12 }, { t: Date.parse("2026-09-27T02:00:00Z"), v: 18 }]);
    assert.deepEqual(azurePoints(res, "Percentage CPU", "maximum").map((p) => p.v), [40, 55]);
    assert.deepEqual(azurePoints(res, "Network Out Total", "total").map((p) => p.v), [5e8]);
    assert.deepEqual(azurePoints(res, "Available Memory Bytes", "average"), [], "a metric the VM does not publish yields no points");
  });

  it("rolls hourly capacity and egress up to whole UTC days", () => {
    const w = collectionWindow(3, 60, NOW); // starts at 10:00, so the first 14 hours are a partial day
    const hourly = toSeries("read_gb", "sum", "gb", w, Array.from({ length: w.steps }, (_, i) => ({ t: w.start.getTime() + i * HOUR, v: 2 })));
    const days = toDaily(hourly, "sum")!;
    assert.equal(days.start, "2026-09-26T00:00:00.000Z");
    assert.equal(days.stepMinutes, 1440);
    assert.deepEqual(days.values, [48, 48], "two whole days; the partial ones at either end are dropped");
    const level = toDaily(toSeries("stored_gb", "avg", "gb", w, Array.from({ length: w.steps }, (_, i) => ({ t: w.start.getTime() + i * HOUR, v: 500 + i }))), "avg")!;
    assert.deepEqual(level.values, [525.5, 549.5]);
    // A day with missing hours is scaled, not under-reported.
    const gappy = toSeries("read_gb", "sum", "gb", w, Array.from({ length: w.steps }, (_, i) => ({ t: w.start.getTime() + i * HOUR, v: 2 })).filter((_, i) => i % 2 === 0));
    assert.deepEqual(toDaily(gappy, "sum")!.values, [48, 48]);
    assert.equal(toDaily(null, "sum"), null);
  });
});

describe("Google Cloud Monitoring", () => {
  it("keys points by resource and moves them to the start of their period", () => {
    const points = gcpPoints(
      {
        timeSeries: [
          { resource: { labels: { instance_id: "111" } }, points: [{ interval: { endTime: "2026-09-28T10:00:00Z" }, value: { doubleValue: 0.42 } }, { interval: { endTime: "2026-09-28T09:00:00Z" }, value: { doubleValue: 0.4 } }] },
          { resource: { labels: { instance_id: "222" } }, points: [{ interval: { endTime: "2026-09-28T10:00:00Z" }, value: { int64Value: "123456789012" } }] },
          { resource: { labels: {} }, points: [{ interval: { endTime: "2026-09-28T10:00:00Z" }, value: { doubleValue: 1 } }] },
        ],
      },
      "instance_id",
      HOUR,
    );
    assert.deepEqual([...points.keys()], ["111", "222"]);
    assert.deepEqual(points.get("111"), [{ t: Date.parse("2026-09-28T09:00:00Z"), v: 0.42 }, { t: Date.parse("2026-09-28T08:00:00Z"), v: 0.4 }]);
    assert.equal(points.get("222")![0].v, 123456789012, "int64 values arrive as strings");
    // Newest-first points land in the right slots; CPU arrives as a fraction.
    const w = collectionWindow(1, 60, NOW);
    const s = toSeries("cpu", "avg", "percent", w, points.get("111"), (v) => v * 100)!;
    assert.deepEqual(s.values.slice(-2), [40, 42]);
  });

  it("merges pages of the same resource", () => {
    const into = gcpPoints({ timeSeries: [{ resource: { labels: { bucket_name: "lake" } }, points: [{ interval: { endTime: "2026-09-28T00:00:00Z" }, value: { doubleValue: 5 } }] }] }, "bucket_name", 86_400_000);
    gcpPoints({ timeSeries: [{ resource: { labels: { bucket_name: "lake" } }, points: [{ interval: { endTime: "2026-09-27T00:00:00Z" }, value: { doubleValue: 4 } }] }] }, "bucket_name", 86_400_000, into);
    assert.deepEqual(into.get("lake")!.map((p) => p.v), [5, 4]);
  });
});

describe("environment tags", () => {
  it("maps the usual spellings onto the ones the engine knows", () => {
    assert.equal(normalizeEnvironment("Production"), "prod");
    assert.equal(normalizeEnvironment("PRD"), "prod");
    assert.equal(normalizeEnvironment("stage"), "staging");
    assert.equal(normalizeEnvironment("UAT"), "staging");
    assert.equal(normalizeEnvironment("Development"), "dev");
    assert.equal(normalizeEnvironment("qa"), "test");
    assert.equal(normalizeEnvironment("perf"), "perf");
    assert.equal(normalizeEnvironment(undefined), undefined);
    assert.equal(normalizeEnvironment("  "), undefined);
  });
});

describe("collected history drives the engine", () => {
  const w = collectionWindow(HOURLY_DAYS, 60, NOW);
  const hourly = (fn: (i: number, ts: Date) => number) => Array.from({ length: w.steps }, (_, i) => ({ t: w.start.getTime() + i * HOUR, v: fn(i, new Date(w.start.getTime() + i * HOUR)) }));
  const account = { id: "a", provider: "aws" as const, name: "Prod", externalId: "1", region: "us-east-1" };
  const estate = (...resources: Estate["resources"]): Estate => ({ orgId: "t", accounts: [account], resources, daily: [] });

  /** An Auto Scaling group as the AWS connector assembles it. */
  function group(id: string, opts: { memory: boolean }) {
    const cpu = toSeries("cpu", "avg", "percent", w, hourly((i) => 14 + (i % 7)));
    const usage = withUsage({}, [
      cpu,
      toSeries("cpu_max", "max", "percent", w, hourly((i) => 22 + (i % 9))),
      opts.memory ? toSeries("mem", "avg", "percent", w, hourly(() => 31)) : null,
      toSeries("net_in", "sum", "bytes", w, hourly(() => 2e8)),
      toSeries("net_out", "sum", "bytes", w, hourly(() => 3e8)),
      // No group metrics: instance count from CPU sample counts (12 per instance-hour).
      toSeries("instances", "avg", "count", w, hourly((_, ts) => (ts.getUTCHours() < 6 ? 48 : 96)), (samples) => samples / 12),
    ]);
    return { ...resource({ id, accountId: "a", provider: "aws", kind: "compute.vm", sku: "m5.2xlarge", quantity: 8, workload: id, metrics: usage.metrics }), usage: profileUsage(usage.series) };
  }

  it("a fleet without the CloudWatch agent is held back, with the agent it is resized", () => {
    const blind = runEngineWithCoverage(estate(group("api", { memory: false })));
    assert.equal(blind.drafts.filter((d) => d.detector === "rightsizing.vm").length, 0);
    assert.deepEqual(blind.gaps.map((g) => [g.resource, g.kind]), [["api", "missing_metric"]]);
    assert.match(blind.gaps[0].fix!, /CloudWatch agent/);

    const measured = runEngineWithCoverage(estate(group("api", { memory: true })));
    assert.equal(measured.gaps.length, 0);
    const resize = measured.drafts.find((d) => d.detector === "rightsizing.vm")!;
    assert.ok(resize, "with memory measured the fleet is resized");
    assert.match(resize.details.explanation, /42 days of hourly history/);
    assert.deepEqual(measured.coverage, { measurable: 1, withHistory: 1, minDays: 42, maxDays: 42, unmeasured: 0 });
  });

  it("the running-instance history from sample counts sets the commitment floor", () => {
    const g = group("api", { memory: true });
    assert.equal(Math.round(g.usage.metrics.instances.p10), 4);
    assert.equal(Math.round(g.usage.metrics.instances.max), 8);
  });
});
