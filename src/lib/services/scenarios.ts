import type { Narrative } from "../ai/advisor";
import { parseJson, prisma } from "../db";
import type { WhatIfPlan, WhatIfResult } from "../engine/whatif";

export interface ScenarioView {
  id: string;
  prompt: string;
  plan: WhatIfPlan;
  result: WhatIfResult;
  narrative: Narrative;
  model: string | null;
  source: string;
  createdBy: string | null;
  createdAt: string;
}

type Row = Awaited<ReturnType<typeof prisma.scenario.findMany>>[number];

const toView = (s: Row): ScenarioView => ({
  id: s.id,
  prompt: s.prompt,
  plan: parseJson(s.plan, { interpretation: "", transforms: [], assumptions: [] }),
  result: parseJson(s.result, null as never),
  narrative: parseJson(s.narrative, { headline: "", summary: "", keyPoints: [], caveats: [], nextSteps: [] }),
  model: s.aiModel,
  source: s.aiModel ? "ai" : "rules",
  createdBy: s.createdBy,
  createdAt: s.createdAt.toISOString(),
});

export async function listScenarios(orgId: string, take = 100) {
  const rows = await prisma.scenario.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take });
  return rows.map(toView);
}

export async function getScenario(orgId: string, id: string) {
  const row = await prisma.scenario.findFirst({ where: { id, orgId } });
  return row ? toView(row) : null;
}

export const countScenarios = (orgId: string) => prisma.scenario.count({ where: { orgId } });
