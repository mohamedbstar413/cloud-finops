import { PRICES, PROVIDER_LABEL, PROVIDERS } from "../pricing/catalog";
import type { Estate, RecommendationDraft } from "./types";
import { cpuSignal, instanceFloor, pctTrend } from "./signals";
import { makeDraft, money, pct, round } from "./util";

const COVERAGE = 0.8;

/**
 * Commitment recommendations sized on the POST-optimization baseline: we first
 * subtract everything other recommendations remove or shrink, so customers never
 * commit to capacity we are about to tell them to delete.
 */
export function commitmentRecommendations(estate: Estate, primary: RecommendationDraft[], term: "1y" | "3y" = "1y"): RecommendationDraft[] {
  const claimedBy = new Map<string, RecommendationDraft>();
  for (const d of primary) for (const id of d.resourceIds) claimedBy.set(id, d);

  const out: RecommendationDraft[] = [];
  for (const p of PROVIDERS) {
    const steady = estate.resources.filter(
      (r) =>
        r.provider === p &&
        r.kind === "compute.vm" &&
        r.environment === "prod" &&
        r.state === "running" &&
        !r.config.interruptible &&
        // "Steady" means instances that run every hour. With history that is the hourly floor of the
        // running-instance count; with summary metrics only, fall back to the busy share.
        (r.usage?.metrics.instances ? instanceFloor(r) >= 1 : (r.metrics.dutyCycle ?? 0) >= 0.85 || r.config.role === "k8s-node" || r.config.stateless),
    );
    let baselineNow = 0;
    let baselineAfter = 0;
    const lines: { label: string; value: string }[] = [];
    for (const r of steady) {
      baselineNow += r.monthlyCost;
      const rec = claimedBy.get(r.id);
      if (!rec) {
        // Commit only to what runs every hour: the p10 of the hourly instance count, not the provisioned maximum.
        const floor = instanceFloor(r);
        const always = r.quantity > 0 ? (r.monthlyCost * floor) / r.quantity : r.monthlyCost;
        // A shrinking workload should not be locked in at today's level.
        const trend = cpuSignal(r)?.trendPerMonth ?? 0;
        const kept = always * (trend < -0.05 ? Math.max(0.5, 1 + trend * 3) : 1);
        baselineAfter += kept;
        if (floor < r.quantity) lines.push({ label: r.name, value: `${r.quantity} provisioned, ${floor} always running (hourly floor) → ${money(kept)} committed baseline` });
        else if (kept < always) lines.push({ label: r.name, value: `usage trending ${pctTrend(trend)} → baseline reduced to ${money(kept)}` });
        continue;
      }
      // Post-optimization on-demand VM spend implied by the recommendation.
      const proposedVm = (rec.details.proposed?.components ?? [])
        .filter((c) => c.kind === "compute.vm" && !c.usage.spot)
        .reduce((s, c) => s + c.monthlyCost, 0);
      const recVmNow = (rec.details.current?.components ?? [])
        .filter((c) => c.kind === "compute.vm")
        .reduce((s, c) => s + c.monthlyCost, 0);
      const share = recVmNow > 0 ? r.monthlyCost / recVmNow : 0;
      const after = rec.targetProvider && rec.targetProvider !== p ? 0 : proposedVm * share;
      baselineAfter += after;
      lines.push({ label: `${r.name}`, value: `${money(r.monthlyCost)} → ${money(after)} after "${rec.title.slice(0, 48)}${rec.title.length > 48 ? "…" : ""}"` });
    }
    if (baselineAfter < 500) continue;
    const c = PRICES.commitment[p];
    const committed = baselineAfter * COVERAGE;
    const savings1y = committed * c["1y"];
    const savings3y = committed * c["3y"];
    const years = term === "3y" ? 3 : 1;
    const chosen = term === "3y" ? savings3y : savings1y;
    out.push(
      makeDraft({
        fingerprint: `commitment:${p}`,
        detector: "commitment",
        category: "commitment",
        provider: p,
        title: `Purchase ${c.name} for steady ${PROVIDER_LABEL[p]} compute`,
        summary: `Cover ${pct(COVERAGE * 100)} of your post-optimization compute baseline (${money(baselineAfter)}/mo) with a ${years}-year, no-upfront commitment.`,
        currentMonthlyCost: committed,
        projectedMonthlyCost: committed - chosen,
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: 0.84,
        resourceIds: [],
        details: {
          explanation:
            `Your steady ${PROVIDER_LABEL[p]} compute today is ${money(baselineNow)}/month. After the other open recommendations are applied, and counting only instances that run every hour (the hourly floor of autoscaled fleets), the always-on baseline is ${money(baselineAfter)}/month. ` +
            `We size the commitment on that post-optimization baseline at ${pct(COVERAGE * 100)} coverage, so you never commit to capacity you are about to remove. A ${years}-year no-upfront ${c.name} saves ${pct(c[term] * 100)} on the covered usage.`,
          evidence: [
            { label: "Steady compute today", value: money(baselineNow) },
            { label: "Baseline after optimizations", value: money(baselineAfter) },
            { label: "Recommended commitment", value: `${money(committed)}/mo (${pct(COVERAGE * 100)} coverage)` },
            ...lines.slice(0, 4),
          ],
          benefits: ["No architecture change", "Applies automatically to matching usage"],
          risks: [`${years}-year lock-in — re-evaluate quarterly as architecture changes land`],
          alternatives: [
            { label: "1-year, no upfront", provider: p, monthlyCost: round(committed - savings1y), savingsPct: round(c["1y"] * 100), note: `saves ${money(savings1y)}/mo`, chosen: term === "1y" },
            { label: "3-year, no upfront", provider: p, monthlyCost: round(committed - savings3y), savingsPct: round(c["3y"] * 100), note: `saves ${money(savings3y)}/mo, longer lock-in`, chosen: term === "3y" },
          ],
          implementation: [{ phase: "Purchase", weeks: "Day 1", tasks: [`Buy ${c.name} for ${money(committed)}/mo equivalent`, "Set coverage & utilization alerts at 90%"] }],
          rollout: { startWeek: 0, fullWeek: 0 },
          assumptions: [`${pct(COVERAGE * 100)} coverage of post-optimization baseline`, `${pct(c[term] * 100)} ${years}-year discount`],
        },
      }),
    );
  }
  return out;
}
