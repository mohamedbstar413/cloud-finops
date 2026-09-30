import { PageHeader, Pill } from "@/components/ui";
import { aiEnabled, aiModel } from "@/lib/ai/client";
import { can, pageSession } from "@/lib/auth";
import { countScenarios, listScenarios } from "@/lib/services/scenarios";
import { AdvisorNav } from "./nav";
import { AskView } from "./view";

export default async function AdvisorPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { org, role } = await pageSession();
  const [recent, count] = await Promise.all([listScenarios(org.id, 3), countScenarios(org.id)]);
  const ai = aiEnabled();
  return (
    <>
      <PageHeader
        title="Architecture Advisor"
        subtitle="Ask what-if questions about your whole estate. The AI plans the scenario; the pricing engine computes every number."
        actions={<Pill className={ai ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-slate-100 text-slate-600 ring-slate-200"}>{ai ? `OpenAI · ${aiModel()}` : "Rules mode — set OPENAI_API_KEY for AI planning"}</Pill>}
      />
      <AdvisorNav scenarios={count} />
      <AskView recent={recent} initialPrompt={(await searchParams).q} canUse={can(role, "ai:use")} />
    </>
  );
}
