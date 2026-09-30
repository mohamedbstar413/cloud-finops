import { crossCloudArbitrage } from "./arbitrage";
import { anomalyRecommendations } from "./anomaly";
import { ARCHITECTURE_DETECTORS } from "./architecture";
import { commitmentRecommendations } from "./commitments";
import { STANDARD_DETECTORS } from "./standard";
import type { DataGap, Estate, RecommendationDraft, ResourceRow } from "./types";
import { isFiniteDraft } from "./util";

export * from "./types";

/**
 * Savings de-duplication: recommendations that touch the same resources are
 * alternatives, not additive. The highest-savings option becomes primary and
 * the others are linked to it via `overlapsWith` (excluded from totals).
 */
export function resolveOverlaps(drafts: RecommendationDraft[]): RecommendationDraft[] {
  const sorted = [...drafts].sort((a, b) => b.monthlySavings - a.monthlySavings);
  const claimed = new Map<string, string>();
  for (const d of sorted) {
    const hit = d.resourceIds.find((id) => claimed.has(id));
    if (hit) {
      d.overlapsWith = claimed.get(hit);
      continue;
    }
    for (const id of d.resourceIds) claimed.set(id, d.fingerprint);
  }
  return sorted;
}

/** Resource kinds whose optimization depends on usage history. */
export const MEASURABLE_KINDS = ["compute.vm", "db.instance", "db.vcore", "app.plan", "network.load_balancer", "network.nat_gateway", "storage.object"];
const MEASURABLE = new Set(MEASURABLE_KINDS);

/** Is there anything at all to judge this resource's usage by — history, or at least a summary figure? */
const hasUsageData = (r: ResourceRow) =>
  Boolean(r.usage && r.usage.days > 0) || r.kind === "storage.object" || r.metrics.cpuP95 !== undefined || r.metrics.requestsPerMonthM !== undefined || r.metrics.gbProcessed !== undefined;

export interface Coverage {
  /** Resources whose optimization depends on usage data. */
  measurable: number;
  /** …of which have usage history (not only summary metrics). */
  withHistory: number;
  /** Shortest and longest history among those, in days. */
  minDays: number;
  maxDays: number;
  /** Resources with no utilisation or traffic data at all: they could not be evaluated, so nothing is said about them. */
  unmeasured: number;
}

export interface EngineResult {
  drafts: RecommendationDraft[];
  /** Resources the engine deliberately did not optimize, and why. */
  gaps: DataGap[];
  coverage: Coverage;
}

export function runEngineWithCoverage(input: Estate): EngineResult {
  const estate: Estate = { ...input, gaps: [] };
  const structural = [...ARCHITECTURE_DETECTORS, crossCloudArbitrage, ...STANDARD_DETECTORS].flatMap((detect) => detect(estate));
  const resolved = resolveOverlaps(structural.filter((d) => isFiniteDraft(d) && d.monthlySavings >= 10));
  const primary = resolved.filter((d) => !d.overlapsWith);
  const commitments = commitmentRecommendations(estate, primary);
  const anomalies = anomalyRecommendations(estate).filter(isFiniteDraft);
  const drafts = [...resolved, ...commitments, ...anomalies].map((d) => ({ ...d, source: d.source ?? "engine" })).sort((a, b) => b.monthlySavings - a.monthlySavings);

  // A gap is moot when another recommendation already covers the resource.
  const covered = new Set(primary.flatMap((d) => d.resourceIds));
  const gaps = (estate.gaps ?? []).filter((g) => !covered.has(g.resourceId)).sort((a, b) => b.monthlyCost - a.monthlyCost);

  const measurable = estate.resources.filter((r) => MEASURABLE.has(r.kind) && r.state === "running");
  const histories = measurable.filter((r) => r.usage && r.usage.days > 0).map((r) => r.usage!.days);
  return {
    drafts,
    gaps,
    coverage: {
      measurable: measurable.length,
      withHistory: histories.length,
      minDays: histories.length ? Math.round(Math.min(...histories)) : 0,
      maxDays: histories.length ? Math.round(Math.max(...histories)) : 0,
      unmeasured: measurable.filter((r) => !hasUsageData(r)).length,
    },
  };
}

export function runEngine(estate: Estate): RecommendationDraft[] {
  return runEngineWithCoverage(estate).drafts;
}

type Summable = { monthlySavings: number; category: string; overlapsWith?: string | null; status?: string };
const active = (r: Summable) => !r.overlapsWith && (r.status === undefined || r.status === "open" || r.status === "in_progress");

/**
 * Sum of non-overlapping run-rate savings — what the dashboard calls "potential
 * savings". Anomalies are excluded: they are cost *avoidance* (spend at risk if
 * a spike persists), not a reduction of today's run-rate.
 */
export function totalPotentialSavings(recs: Summable[]) {
  return recs.filter((r) => active(r) && r.category !== "anomaly").reduce((s, r) => s + r.monthlySavings, 0);
}

/** Monthly spend at risk from open cost anomalies (reported separately from savings). */
export function totalAtRisk(recs: Summable[]) {
  return recs.filter((r) => active(r) && r.category === "anomaly").reduce((s, r) => s + r.monthlySavings, 0);
}
