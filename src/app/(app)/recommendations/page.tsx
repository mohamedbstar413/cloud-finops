import { PageHeader } from "@/components/ui";
import { aiEnabled } from "@/lib/ai/client";
import { can, pageSession } from "@/lib/auth";
import { getDataCoverage, listRecommendations } from "@/lib/services/queries";
import { RecommendationsNav } from "./nav";
import { OpenRecommendations, RecommendationActionsBar } from "./view";

export default async function RecommendationsPage() {
  const { org, role } = await pageSession();
  const [recs, coverage] = await Promise.all([listRecommendations(org.id), getDataCoverage(org.id)]);
  return (
    <>
      <PageHeader
        title="Recommendations"
        subtitle="Ranked by de-duplicated savings — alternatives on the same resources are never counted twice"
        actions={<RecommendationActionsBar ai={aiEnabled()} canRun={can(role, "analysis:run")} />}
      />
      <RecommendationsNav recs={recs} heldBack={coverage?.gaps.length ?? 0} />
      <OpenRecommendations recs={recs} heldBack={coverage?.gaps.length ?? 0} />
    </>
  );
}
