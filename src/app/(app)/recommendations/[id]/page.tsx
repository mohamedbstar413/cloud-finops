import { notFound } from "next/navigation";
import { aiEnabled } from "@/lib/ai/client";
import { can, pageSession } from "@/lib/auth";
import { getRecommendation, orgGrowthRate } from "@/lib/services/queries";
import { RecommendationDetail } from "./detail";

export default async function RecommendationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { org, role } = await pageSession();
  const { id } = await params;
  const data = await getRecommendation(org.id, id);
  if (!data) notFound();
  const growthRate = await orgGrowthRate(org.id);
  return (
    <RecommendationDetail
      data={data}
      growthRate={growthRate}
      ai={aiEnabled()}
      canAct={can(role, "recommendation:act")}
      canUseAi={can(role, "ai:use")}
      initialTab={(await searchParams).tab}
    />
  );
}
