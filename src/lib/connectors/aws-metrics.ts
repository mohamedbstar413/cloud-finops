import { GetMetricDataCommand, ListMetricsCommand, type Dimension, type GetMetricDataCommandOutput, type ListMetricsCommandOutput } from "@aws-sdk/client-cloudwatch";
import type { CollectionWindow, Point } from "./usage";

/** One CloudWatch metric to fetch. `id` is the caller's key for the result. */
export interface MetricSpec {
  id: string;
  namespace: string;
  metric: string;
  dimensions: Dimension[];
  /** Average | Maximum | Sum | SampleCount | p95 … */
  stat: string;
}

/** The slice of the CloudWatch client this module needs (lets tests pass a fake). */
export interface MetricsClient {
  send(command: GetMetricDataCommand): Promise<GetMetricDataCommandOutput>;
}
export interface MetricsLister {
  send(command: ListMetricsCommand): Promise<ListMetricsCommandOutput>;
}

/** GetMetricData accepts 500 queries and returns at most 100,800 datapoints per call. */
const MAX_QUERIES = 500;
const MAX_DATAPOINTS = 100_000;

/**
 * Fetch many metrics over one window. Queries are batched so a full response
 * fits in a single call (a six-week hourly window is 1,008 points per metric),
 * and every page is followed.
 */
export async function fetchMetrics(cw: MetricsClient, specs: MetricSpec[], w: CollectionWindow): Promise<Map<string, Point[]>> {
  const out = new Map<string, Point[]>();
  const perCall = Math.max(1, Math.min(MAX_QUERIES, Math.floor(MAX_DATAPOINTS / w.steps)));
  for (let i = 0; i < specs.length; i += perCall) {
    const batch = specs.slice(i, i + perCall);
    let token: string | undefined;
    do {
      const res = await cw.send(
        new GetMetricDataCommand({
          StartTime: w.start,
          EndTime: w.end,
          ScanBy: "TimestampAscending",
          NextToken: token,
          MetricDataQueries: batch.map((s, j) => ({
            Id: `m${j}`,
            ReturnData: true,
            MetricStat: { Metric: { Namespace: s.namespace, MetricName: s.metric, Dimensions: s.dimensions }, Period: w.stepMinutes * 60, Stat: s.stat },
          })),
        }),
      );
      for (const r of res.MetricDataResults ?? []) {
        const spec = batch[Number(r.Id?.slice(1))];
        if (!spec) continue;
        const pts = out.get(spec.id) ?? [];
        const values = r.Values ?? [];
        (r.Timestamps ?? []).forEach((t, k) => {
          if (values[k] !== undefined) pts.push({ t: t.getTime(), v: values[k] });
        });
        out.set(spec.id, pts);
      }
      token = res.NextToken;
    } while (token);
  }
  return out;
}

/**
 * Every dimension set under which a metric is published. Agent metrics (memory)
 * carry whatever dimensions the agent was configured with, and CloudWatch only
 * answers exact matches — so they are discovered rather than guessed.
 */
export async function listMetricDimensions(cw: MetricsLister, namespace: string, metric: string): Promise<Dimension[][]> {
  const out: Dimension[][] = [];
  let token: string | undefined;
  do {
    const res = await cw.send(new ListMetricsCommand({ Namespace: namespace, MetricName: metric, NextToken: token }));
    for (const m of res.Metrics ?? []) out.push(m.Dimensions ?? []);
    token = res.NextToken;
  } while (token);
  return out;
}

const dim = (dims: Dimension[], name: string) => dims.find((d) => d.Name === name)?.Value;

/**
 * Pick the dimension sets that describe a machine or a fleet.
 *  - an instance: the set that names it, preferring the one with the fewest extra dimensions;
 *  - an Auto Scaling group: the aggregated set (group name, no instance id) when the agent publishes one.
 */
export function memoryDimensionsFor(all: Dimension[][], target: { instanceId?: string; autoScalingGroup?: string }): Dimension[] | undefined {
  const candidates = all.filter((dims) =>
    target.instanceId ? dim(dims, "InstanceId") === target.instanceId : dim(dims, "AutoScalingGroupName") === target.autoScalingGroup && !dim(dims, "InstanceId"),
  );
  return candidates.sort((a, b) => a.length - b.length)[0];
}
