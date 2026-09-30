import { PageHeader } from "@/components/ui";
import { getSession } from "@/lib/auth";
import { getDataCoverage, listRecommendations } from "@/lib/services/queries";
import { RecommendationsNav } from "../nav";
import { RecommendationHistory } from "../view";

export default async function RecommendationHistoryPage() {
  const { org } = await getSession();
  const [recs, coverage] = await Promise.all([listRecommendations(org.id), getDataCoverage(org.id)]);
  return (
    <>
      <PageHeader title="Recommendations" subtitle="What your team applied, snoozed or dismissed" />
      <RecommendationsNav recs={recs} heldBack={coverage?.gaps.length ?? 0} />
      <RecommendationHistory recs={recs} />
    </>
  );
}
