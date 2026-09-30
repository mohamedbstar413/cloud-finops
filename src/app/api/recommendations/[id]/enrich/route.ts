import { aiEnabled } from "@/lib/ai/client";
import { consume } from "@/lib/billing/limits";
import { route, type Ctx } from "@/lib/api";
import { enrichRecommendation } from "@/lib/ai/advisor";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const maxDuration = 120;

export const POST = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("ai:use");
  if (aiEnabled()) await consume(org.id, "ai_calls");
  const { id } = await ctx.params;
  const rec = await prisma.recommendation.findFirst({ where: { id, orgId: org.id }, select: { id: true, title: true } });
  if (!rec) throw new HttpError(404, "Recommendation not found");
  const out = await enrichRecommendation(rec.id);
  await audit(org.id, user.name, "generated AI deep-dive", rec.title);
  return out;
});
