/**
 * CLI: run the optimization engine against the first organization and print
 * the ranked recommendations. Usage: npm run analyze
 */
import { PrismaClient } from "@prisma/client";
import { runEngine, totalAtRisk, totalPotentialSavings } from "../src/lib/engine";
import { loadEstate } from "../src/lib/services/estate";

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.findFirstOrThrow();
  const estate = await loadEstate(org.id);
  const spend = estate.resources.reduce((s, r) => s + r.monthlyCost, 0);
  const recs = runEngine(estate);
  console.log(`${org.name}: ${estate.resources.length} resources, $${Math.round(spend).toLocaleString()}/mo run-rate\n`);
  for (const r of recs) {
    const alt = r.overlapsWith ? `  ↳ alternative to ${r.overlapsWith}` : "";
    console.log(
      `${r.impact!.padEnd(6)} ${r.category.padEnd(12)} ${r.provider.padEnd(5)} $${Math.round(r.monthlySavings).toLocaleString().padStart(6)} (${String(Math.round(r.savingsPct)).padStart(2)}%)  ${r.title}${alt}`,
    );
  }
  console.log(`\nPotential savings (de-duplicated): $${Math.round(totalPotentialSavings(recs)).toLocaleString()}/mo`);
  console.log(`Spend at risk from anomalies:      $${Math.round(totalAtRisk(recs)).toLocaleString()}/mo`);
}

main().finally(() => prisma.$disconnect());
