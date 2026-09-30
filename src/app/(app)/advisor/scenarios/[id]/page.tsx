import { notFound } from "next/navigation";
import { pageSession } from "@/lib/auth";
import { orgGrowthRate } from "@/lib/services/queries";
import { countScenarios, getScenario } from "@/lib/services/scenarios";
import { AdvisorNav } from "../../nav";
import { ScenarioDetail } from "../../scenario";

export default async function ScenarioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { org } = await pageSession();
  const { id } = await params;
  const [scenario, count, growthRate] = await Promise.all([getScenario(org.id, id), countScenarios(org.id), orgGrowthRate(org.id)]);
  if (!scenario) notFound();
  return (
    <>
      <div className="mb-5">
        <p className="text-[13px] font-medium text-muted">Architecture Advisor</p>
      </div>
      <AdvisorNav scenarios={count} />
      <ScenarioDetail s={scenario} growthRate={growthRate} initialTab={(await searchParams).tab} />
    </>
  );
}
