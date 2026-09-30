import { PageHeader } from "@/components/ui";
import { getSession } from "@/lib/auth";
import { listScenarios } from "@/lib/services/scenarios";
import { AdvisorNav } from "../nav";
import { ScenarioList } from "../view";

export default async function ScenarioHistoryPage() {
  const { org } = await getSession();
  const scenarios = await listScenarios(org.id);
  return (
    <>
      <PageHeader title="Architecture Advisor" subtitle="Every scenario your organization has simulated — open one to see its breakdown" />
      <AdvisorNav scenarios={scenarios.length} />
      <ScenarioList scenarios={scenarios} />
    </>
  );
}
