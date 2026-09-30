import { PageHeader, Pill } from "@/components/ui";
import { aiEnabled, aiModel } from "@/lib/ai/client";
import { can, getSession } from "@/lib/auth";
import { prisma, parseJson } from "@/lib/db";
import { orgGrowthRate } from "@/lib/services/queries";
import { AdvisorView, type ScenarioView } from "./view";

export default async function AdvisorPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { org, role } = await getSession();
  const [rows, growthRate] = await Promise.all([
    prisma.scenario.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "desc" }, take: 15 }),
    orgGrowthRate(org.id),
  ]);
  const history: ScenarioView[] = rows.map((s) => ({
    id: s.id,
    prompt: s.prompt,
    plan: parseJson(s.plan, { interpretation: "", transforms: [], assumptions: [] }),
    result: parseJson(s.result, null as never),
    narrative: parseJson(s.narrative, { headline: "", summary: "", keyPoints: [], caveats: [], nextSteps: [] }),
    model: s.aiModel,
    source: s.aiModel ? "ai" : "rules",
    createdAt: s.createdAt.toISOString(),
  }));
  const ai = aiEnabled();
  return (
    <>
      <PageHeader
        title="Architecture Advisor"
        subtitle="Ask what-if questions about your whole estate. The AI plans the scenario; the pricing engine computes every number."
        actions={<Pill className={ai ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-slate-100 text-slate-600 ring-slate-200"}>{ai ? `OpenAI · ${aiModel()}` : "Rules mode — set OPENAI_API_KEY for AI planning"}</Pill>}
      />
      <AdvisorView history={history} initialPrompt={(await searchParams).q} canUse={can(role, "ai:use")} growthRate={growthRate} />
    </>
  );
}
