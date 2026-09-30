import type { ResourceMetrics } from "../engine/types";
import type { UsageProfile } from "./series";

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Derive the summary metrics shown around the app from the usage history, so
 * there is a single source of truth. A metric with no series stays undefined
 * (memory in particular is never invented).
 */
export function summarize(profile: UsageProfile, base: ResourceMetrics = {}): ResourceMetrics {
  const m = profile.metrics;
  const out: ResourceMetrics = { ...base };
  if (m.cpu) {
    out.cpuAvg = r1(m.cpu.avg);
    out.cpuP95 = r1(m.cpu.p95);
    out.cpuMax = r1((m.cpu_max ?? m.cpu).max);
    out.dutyCycle = Math.round(m.cpu.busyShare * 100) / 100;
    out.peakToAvg = r1(m.cpu.peakToAvg);
    if (m.cpu.howAvg) {
      out.hourly = Array.from({ length: 24 }, (_, h) => r1([0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + m.cpu.howAvg![d * 24 + h], 0) / 7));
    }
    // History exists for this resource: memory is whatever was measured, or unknown.
    if (m.mem) out.memP95 = r1(m.mem.p95);
    else delete out.memP95;
  }
  if (m.requests) {
    out.requestsPerMonthM = r1(m.requests.monthlyTotal / 1e6);
    out.peakToAvg = r1(m.requests.peakToAvg);
  }
  if (m.connections) out.connectionsP95 = Math.round(m.connections.p95);
  if (m.nat_bytes) out.gbProcessed = Math.round(m.nat_bytes.monthlyTotal / 1e9);
  if (m.egress_gb) out.gbEgress = Math.round(m.egress_gb.monthlyTotal);
  return out;
}
