/**
 * CLI: run the optimization engine against the first organization and print
 * the ranked recommendations. Usage: npm run analyze
 */
import { PrismaClient } from "@prisma/client";
import { runEngineWithCoverage, totalAtRisk, totalPotentialSavings } from "../src/lib/engine";
import { loadEstate } from "../src/lib/services/estate";

const prisma = new PrismaClient();

async function main() {
  // npm run analyze -- "<organization name or id>"   (default: the demo organization)
  const which = process.argv[2];
  const org = await prisma.organization.findFirstOrThrow({ where: which ? { OR: [{ id: which }, { name: which }] } : { isDemo: true } });
  const estate = await loadEstate(org.id);
  const spend = estate.resources.reduce((s, r) => s + r.monthlyCost, 0);
  const { drafts: recs, gaps, coverage } = runEngineWithCoverage(estate);
  console.log(`${org.name}: ${estate.resources.length} resources, $${Math.round(spend).toLocaleString()}/mo run-rate\n`);
  for (const r of recs) {
    const alt = r.overlapsWith ? `  ↳ alternative to ${r.overlapsWith}` : "";
    console.log(
      `${r.impact!.padEnd(6)} ${r.category.padEnd(12)} ${r.provider.padEnd(5)} $${Math.round(r.monthlySavings).toLocaleString().padStart(6)} (${String(Math.round(r.savingsPct)).padStart(2)}%)  ${r.title}${alt}`,
    );
  }
  console.log(`\nPotential savings (de-duplicated): $${Math.round(totalPotentialSavings(recs)).toLocaleString()}/mo`);
  console.log(`Spend at risk from anomalies:      $${Math.round(totalAtRisk(recs)).toLocaleString()}/mo`);
  console.log(`\nUsage history: ${coverage.withHistory} of ${coverage.measurable} measurable resources (${coverage.minDays}–${coverage.maxDays} days)${coverage.unmeasured ? `; ${coverage.unmeasured} with no usage data at all (not evaluated)` : ""}`);
  if (gaps.length) {
    console.log(`Held back (${gaps.length}) — the engine did not guess:`);
    for (const g of gaps) console.log(`  [${g.kind}] ${g.resource} ($${Math.round(g.monthlyCost).toLocaleString()}/mo, ${g.detector}): ${g.reason}${g.fix ? `  → ${g.fix}` : ""}`);
  }
}

main().finally(() => prisma.$disconnect());
