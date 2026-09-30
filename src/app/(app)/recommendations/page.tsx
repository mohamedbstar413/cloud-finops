import { PageHeader } from "@/components/ui";
import { aiEnabled } from "@/lib/ai/client";
import { can, getSession } from "@/lib/auth";
import { listRecommendations } from "@/lib/services/queries";
import { RecommendationActionsBar, RecommendationsView } from "./view";

export default async function RecommendationsPage() {
  const { org, role } = await getSession();
  const recs = await listRecommendations(org.id);
  return (
    <>
      <PageHeader
        title="Recommendations"
        subtitle="AI-powered recommendations to reduce your cloud costs — ranked by de-duplicated impact"
        actions={<RecommendationActionsBar ai={aiEnabled()} canRun={can(role, "analysis:run")} />}
      />
      <RecommendationsView recs={recs} />
    </>
  );
}
