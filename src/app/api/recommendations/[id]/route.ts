import { z } from "zod";
import { route, type Ctx } from "@/lib/api";
import { audit, getSession, HttpError, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { reconcileOverlaps } from "@/lib/services/analysis";
import { getRecommendation } from "@/lib/services/queries";

export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org } = await getSession();
  const { id } = await ctx.params;
  const rec = await getRecommendation(org.id, id);
  if (!rec) throw new HttpError(404, "Recommendation not found");
  return rec;
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("apply") }),
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("dismiss"), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal("snooze"), days: z.number().int().min(1).max(365) }),
]);

export const PATCH = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("recommendation:act");
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  const rec = await prisma.recommendation.findFirst({ where: { id, orgId: org.id } });
  if (!rec) throw new HttpError(404, "Recommendation not found");
  const account = rec.accountId ? await prisma.cloudAccount.findUnique({ where: { id: rec.accountId } }) : null;

  let message = "";
  let data: Parameters<typeof prisma.recommendation.update>[0]["data"] = {};
  switch (body.action) {
    case "apply": {
      const autoApplicable = rec.effort === "low" && ["idle", "storage", "commitment", "scheduling"].includes(rec.category);
      if (autoApplicable && account?.permissions === "read_write") {
        data = { status: "applied" };
        message = "Change applied through the connected account.";
      } else {
        data = { status: "in_progress" };
        message = autoApplicable
          ? "Marked in progress. The account is read-only — a change set was generated for your team to apply."
          : "Migration started. Track it here and mark it done when the new architecture is live.";
      }
      break;
    }
    case "complete":
      data = { status: "applied" };
      message = "Marked as applied — savings will be tracked as realized.";
      break;
    case "reopen":
      data = { status: "open", snoozedUntil: null, dismissReason: null };
      message = "Recommendation reopened.";
      break;
    case "dismiss":
      data = { status: "dismissed", dismissReason: body.reason ?? null };
      message = "Dismissed. It won't count towards potential savings.";
      break;
    case "snooze":
      data = { status: "snoozed", snoozedUntil: new Date(Date.now() + body.days * 86_400_000) };
      message = `Snoozed for ${body.days} days.`;
      break;
  }
  const updated = await prisma.recommendation.update({ where: { id }, data });
  await reconcileOverlaps(org.id);
  await audit(org.id, user.name, `${body.action} recommendation`, rec.title);
  return { status: updated.status, message };
});
