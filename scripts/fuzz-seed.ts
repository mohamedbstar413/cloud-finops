/**
 * Reproduce a property-based test failure:
 *   npm run fuzz:seed -- <seed>            random estate with summary metrics only
 *   npm run fuzz:seed -- <seed> --usage    the same estate with random usage histories
 * Prints the estate's recommendations, what the engine held back, and what-if results for that seed.
 */
import { randomEstate, randomUsageEstate } from "../tests/fixtures";
import { runEngineWithCoverage, totalAtRisk, totalPotentialSavings } from "../src/lib/engine";
import { simulate, TRANSFORM_LABEL, type WhatIfTransform } from "../src/lib/engine/whatif";

const seed = Number(process.argv[2] ?? 1);
const withUsage = process.argv.includes("--usage");
const estate = withUsage ? randomUsageEstate(seed) : randomEstate(seed);
const { drafts: recs, gaps, coverage } = runEngineWithCoverage(estate);
const spend = estate.resources.reduce((s, r) => s + r.monthlyCost, 0);
console.log(`seed ${seed}${withUsage ? " (usage histories)" : ""}: ${estate.resources.length} resources, spend $${spend.toFixed(2)}, potential $${totalPotentialSavings(recs).toFixed(2)}, at risk $${totalAtRisk(recs).toFixed(2)}`);
console.log(`  usage history for ${coverage.withHistory} of ${coverage.measurable} measurable resources${coverage.withHistory ? ` (${coverage.minDays}–${coverage.maxDays} days)` : ""}`);
for (const r of recs) {
  console.log(`  ${r.overlapsWith ? "alt " : "    "}${r.detector.padEnd(22)} $${r.monthlySavings.toFixed(2).padStart(10)} of $${r.currentMonthlyCost.toFixed(2).padStart(10)}  ${r.title.slice(0, 80)}`);
}
for (const g of gaps) console.log(`  held ${g.detector.padEnd(22)} [${g.kind}] ${g.resource}: ${g.reason.slice(0, 110)}`);
for (const type of Object.keys(TRANSFORM_LABEL) as WhatIfTransform["type"][]) {
  const res = simulate(estate, { interpretation: "", assumptions: [], transforms: [{ type, providers: [], workloads: [], environments: [], commitmentTerm: "1y" }] });
  console.log(`  what-if ${type.padEnd(22)} saves $${res.monthlySavings.toFixed(2)} (${res.steps[0]?.items.length ?? 0} changes, ${res.notEligible.length} left out)`);
}
