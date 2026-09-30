import { aiEnabled } from "@/lib/ai/client";
import { route } from "@/lib/api";
import { consume } from "@/lib/billing/limits";
import { analyzeCustomArchitecture } from "@/lib/ai/advisor";
import { HttpError, requirePermission } from "@/lib/auth";
import { CustomAnalysisRequest } from "@/lib/ai/requests";
import type { Component } from "@/lib/pricing/components";

export const maxDuration = 120;

export const POST = route(async (req: Request) => {
  const { org } = await requirePermission("ai:use");
  if (aiEnabled()) await consume(org.id, "ai_calls");
  const body = CustomAnalysisRequest.parse(await req.json());
  if (!body.description?.trim() && !body.components?.length) throw new HttpError(400, "Describe the architecture or add at least one component.");
  try {
    return await analyzeCustomArchitecture({ ...body, components: body.components as Component[] | undefined });
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
});
