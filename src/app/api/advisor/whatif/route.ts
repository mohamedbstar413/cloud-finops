import { z } from "zod";
import { aiEnabled } from "@/lib/ai/client";
import { route } from "@/lib/api";
import { consume } from "@/lib/billing/limits";
import { narrateScenario, planWhatIf } from "@/lib/ai/advisor";
import { getSession, requirePermission } from "@/lib/auth";
import { prisma, parseJson } from "@/lib/db";
import { simulate } from "@/lib/engine/whatif";
import { loadEstate } from "@/lib/services/estate";

export const maxDuration = 120;

const Body = z.object({ prompt: z.string().min(3).max(1000) });

export const POST = route(async (req: Request) => {
  const { org, user } = await requirePermission("ai:use");
  const { prompt } = Body.parse(await req.json());
  if (aiEnabled()) await consume(org.id, "ai_calls");
  const estate = await loadEstate(org.id);
  const { plan, source, model } = await planWhatIf(prompt, estate);
  const result = simulate(estate, plan);
  const { narrative, model: narrModel } = await narrateScenario(prompt, plan, result);
  const saved = await prisma.scenario.create({
    data: {
      orgId: org.id,
      prompt,
      plan: JSON.stringify(plan),
      result: JSON.stringify(result),
      narrative: JSON.stringify(narrative),
      aiModel: model ?? narrModel ?? null,
      createdBy: user.name,
    },
  });
  return { id: saved.id, prompt, plan, result, narrative, source, model: model ?? narrModel ?? null, createdAt: saved.createdAt.toISOString() };
});

export const GET = route(async () => {
  const { org } = await getSession();
  const rows = await prisma.scenario.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "desc" }, take: 20 });
  return {
    scenarios: rows.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      plan: parseJson(s.plan, {}),
      result: parseJson(s.result, {}),
      narrative: parseJson(s.narrative, {}),
      model: s.aiModel,
      source: s.aiModel ? "ai" : "rules",
      createdBy: s.createdBy,
      createdAt: s.createdAt.toISOString(),
    })),
  };
});
