import { route, type Ctx } from "@/lib/api";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { prisma, parseJson } from "@/lib/db";
import type { RecommendationDetails } from "@/lib/engine/types";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("recommendation:act");
  const { id } = await ctx.params;
  const rec = await prisma.recommendation.findFirst({ where: { id, orgId: org.id } });
  if (!rec) throw new HttpError(404, "Recommendation not found");
  const d = parseJson<RecommendationDetails>(rec.details, {} as RecommendationDetails);
  const origin = new URL(req.url).origin;

  const body = [
    `**Estimated savings:** ${money(rec.monthlySavings)}/month (${Math.round(rec.savingsPct)}%)`,
    `**Effort / risk:** ${rec.effort} / ${rec.risk} · **Timeline:** ${rec.timeline}`,
    "",
    "## Why",
    d.explanation,
    "",
    ...(d.evidence?.length ? ["## Evidence", ...d.evidence.map((e) => `- ${e.label}: ${e.value}`), ""] : []),
    ...(d.implementation?.length ? ["## Plan", ...d.implementation.flatMap((p) => [`### ${p.phase} (${p.weeks})`, ...p.tasks.map((t) => `- [ ] ${t}`)]), ""] : []),
    ...(d.risks?.length ? ["## Risks", ...d.risks.map((r) => `- ${r}`), ""] : []),
    `Source: ${origin}/recommendations/${rec.id}`,
  ].join("\n");

  const count = await prisma.ticket.count();
  let key = `CPO-${101 + count}`;
  let url: string | null = null;
  let system = "internal";
  if (process.env.TICKET_WEBHOOK_URL) {
    const res = await fetch(process.env.TICKET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: rec.title, body, labels: ["finops", rec.category], savings: rec.monthlySavings }),
    });
    if (!res.ok) throw new HttpError(502, `Ticket webhook failed (${res.status})`);
    const out = (await res.json().catch(() => ({}))) as { key?: string; url?: string };
    key = out.key ?? key;
    url = out.url ?? null;
    system = "webhook";
  }
  const ticket = await prisma.ticket.create({ data: { recommendationId: rec.id, key, title: rec.title, body, url, system } });
  await audit(org.id, user.name, "created ticket", `${key} — ${rec.title}`);
  return { ticket: { id: ticket.id, key: ticket.key, url: ticket.url, body } };
});
