import { crossCloudArbitrage } from "./arbitrage";
import { anomalyRecommendations } from "./anomaly";
import { ARCHITECTURE_DETECTORS } from "./architecture";
import { commitmentRecommendations } from "./commitments";
import { STANDARD_DETECTORS } from "./standard";
import type { Estate, RecommendationDraft } from "./types";
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

export function runEngine(estate: Estate): RecommendationDraft[] {
  const structural = [...ARCHITECTURE_DETECTORS, crossCloudArbitrage, ...STANDARD_DETECTORS].flatMap((detect) => detect(estate));
  const resolved = resolveOverlaps(structural.filter((d) => isFiniteDraft(d) && d.monthlySavings >= 10));
  const primary = resolved.filter((d) => !d.overlapsWith);
  const commitments = commitmentRecommendations(estate, primary);
  const anomalies = anomalyRecommendations(estate).filter(isFiniteDraft);
  return [...resolved, ...commitments, ...anomalies]
    .map((d) => ({ ...d, source: d.source ?? "engine" }))
    .sort((a, b) => b.monthlySavings - a.monthlySavings);
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
