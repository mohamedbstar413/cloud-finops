import { PageHeader } from "@/components/ui";
import { aiEnabled } from "@/lib/ai/client";
import { getSession } from "@/lib/auth";
import { prisma, parseJson } from "@/lib/db";
import type { ArchitectureSpec, RecommendationDetails } from "@/lib/engine/types";
import { getDashboard, orgGrowthRate } from "@/lib/services/queries";
import { SavingsView, type SavingsRec } from "./view";

export default async function SavingsPage({ searchParams }: { searchParams: Promise<{ rec?: string; mode?: string }> }) {
  const { org } = await getSession();
  const sp = await searchParams;
  const [recs, dash, growthRate] = await Promise.all([
    prisma.recommendation.findMany({ where: { orgId: org.id, status: { in: ["open", "in_progress"] } }, orderBy: { monthlySavings: "desc" } }),
    getDashboard(org.id, 30),
    orgGrowthRate(org.id),
  ]);
  const rows: SavingsRec[] = recs.map((r) => {
    const d = parseJson<Partial<RecommendationDetails>>(r.details, {});
    const slim = (s?: ArchitectureSpec) => (s ? { ...s, components: s.components } : undefined);
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      provider: r.provider as SavingsRec["provider"],
      targetProvider: (r.targetProvider as SavingsRec["provider"]) ?? null,
      currentMonthlyCost: r.currentMonthlyCost,
      projectedMonthlyCost: r.projectedMonthlyCost,
      monthlySavings: r.monthlySavings,
      savingsPct: r.savingsPct,
      migrationCost: r.migrationCost,
      effort: r.effort,
      risk: r.risk,
      overlaps: Boolean(r.overlapsWith),
      source: r.source,
      rollout: d.rollout ?? { startWeek: 0, fullWeek: 1 },
      current: slim(d.current),
      proposed: slim(d.proposed),
    };
  });
  const initial = sp.rec && rows.some((r) => r.id === sp.rec) ? [sp.rec] : rows.filter((r) => !r.overlaps && (r.category === "architecture" || r.category === "cross_cloud")).slice(0, 3).map((r) => r.id);

  return (
    <>
      <PageHeader
        title="Savings Projection"
        subtitle="Cost-improvement charts for every architecture we suggest — or for any architecture you describe"
      />
      <SavingsView recs={rows} initialSelection={initial} baselineSpend={dash.monthlyRunRate} growthRate={growthRate} ai={aiEnabled()} initialMode={sp.mode === "custom" ? "custom" : "suggested"} />
    </>
  );
}
