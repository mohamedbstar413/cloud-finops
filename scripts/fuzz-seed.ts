/**
 * Reproduce a property-based test failure: npm run fuzz:seed -- <seed>
 * Prints the random estate's recommendations and what-if results for that seed.
 */
import { randomEstate } from "../tests/fixtures";
import { runEngine, totalAtRisk, totalPotentialSavings } from "../src/lib/engine";
import { simulate, TRANSFORM_LABEL, type WhatIfTransform } from "../src/lib/engine/whatif";

const seed = Number(process.argv[2] ?? 1);
const estate = randomEstate(seed);
const recs = runEngine(estate);
const spend = estate.resources.reduce((s, r) => s + r.monthlyCost, 0);
console.log(`seed ${seed}: ${estate.resources.length} resources, spend $${spend.toFixed(2)}, potential $${totalPotentialSavings(recs).toFixed(2)}, at risk $${totalAtRisk(recs).toFixed(2)}`);
for (const r of recs) {
  console.log(`  ${r.overlapsWith ? "alt " : "    "}${r.detector.padEnd(22)} $${r.monthlySavings.toFixed(2).padStart(10)} of $${r.currentMonthlyCost.toFixed(2).padStart(10)}  ${r.title.slice(0, 80)}`);
}
for (const type of Object.keys(TRANSFORM_LABEL) as WhatIfTransform["type"][]) {
  const res = simulate(estate, { interpretation: "", assumptions: [], transforms: [{ type, providers: [], workloads: [], environments: [], commitmentTerm: "1y" }] });
  console.log(`  what-if ${type.padEnd(22)} saves $${res.monthlySavings.toFixed(2)} (${res.steps[0]?.items.length ?? 0} changes)`);
}
