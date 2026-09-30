import { prisma } from "../db";
import { runEngine, totalPotentialSavings } from "../engine";
import type { RecommendationDraft } from "../engine/types";
import { loadEstate } from "./estate";

export function draftToRow(orgId: string, d: RecommendationDraft) {
  return {
    orgId,
    fingerprint: d.fingerprint,
    accountId: d.accountId ?? null,
    provider: d.provider,
    targetProvider: d.targetProvider ?? null,
    category: d.category,
    detector: d.detector,
    title: d.title,
    summary: d.summary,
    impact: d.impact ?? "low",
    currentMonthlyCost: d.currentMonthlyCost,
    projectedMonthlyCost: d.projectedMonthlyCost,
    monthlySavings: d.monthlySavings,
    savingsPct: d.savingsPct,
    migrationCost: d.migrationCost,
    effort: d.effort,
    risk: d.risk,
    timeline: d.timeline,
    confidence: d.confidence,
    resourceIds: JSON.stringify(d.resourceIds),
    details: JSON.stringify(d.details),
    source: d.source ?? "engine",
    overlapsWith: d.overlapsWith ?? null,
  };
}

/**
 * Re-runs every detector over the org's current estate and reconciles results
 * with stored recommendations by fingerprint — preserving user decisions
 * (dismiss / snooze / apply) and AI enrichment across runs.
 */
export async function runAnalysis(orgId: string) {
  const estate = await loadEstate(orgId);
  const drafts = runEngine(estate);
  const existing = await prisma.recommendation.findMany({ where: { orgId, source: "engine" } });
  const byFp = new Map(existing.map((r) => [r.fingerprint, r]));
  const seen = new Set<string>();

  for (const d of drafts) {
    seen.add(d.fingerprint);
    const row = draftToRow(orgId, d);
    const prev = byFp.get(d.fingerprint);
    if (prev) {
      await prisma.recommendation.update({ where: { id: prev.id }, data: row });
    } else {
      await prisma.recommendation.create({ data: row });
    }
  }

  // Engine no longer produces these → the issue is resolved; drop open ones.
  const stale = existing.filter((r) => !seen.has(r.fingerprint) && (r.status === "open" || r.status === "snoozed"));
  if (stale.length) await prisma.recommendation.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });

  await reconcileOverlaps(orgId);

  // Wake up snoozed recommendations whose snooze expired.
  await prisma.recommendation.updateMany({
    where: { orgId, status: "snoozed", snoozedUntil: { lt: new Date() } },
    data: { status: "open", snoozedUntil: null },
  });

  return {
    recommendations: drafts.length,
    architecture: drafts.filter((d) => d.category === "architecture" || d.category === "cross_cloud").length,
    removed: stale.length,
    monthlySavings: totalPotentialSavings(drafts),
  };
}

/**
 * Org-wide savings de-duplication across engine AND AI recommendations:
 * among active recommendations sharing resources, the highest-savings one is
 * primary; the rest point to it via `overlapsWith` and are excluded from totals.
 */
export async function reconcileOverlaps(orgId: string) {
  const recs = await prisma.recommendation.findMany({
    where: { orgId, status: { in: ["open", "in_progress", "snoozed", "applied"] } },
    orderBy: { monthlySavings: "desc" },
  });
  // Applied/in-progress recommendations claim their resources first.
  const rank = (s: string) => (s === "applied" || s === "in_progress" ? 0 : 1);
  recs.sort((a, b) => rank(a.status) - rank(b.status) || b.monthlySavings - a.monthlySavings);
  const claimed = new Map<string, string>();
  for (const r of recs) {
    const ids: string[] = JSON.parse(r.resourceIds);
    const hit = ids.find((id) => claimed.has(id));
    const overlapsWith = hit ? claimed.get(hit)! : null;
    if (!hit) ids.forEach((id) => claimed.set(id, r.fingerprint));
    if (overlapsWith !== r.overlapsWith) {
      await prisma.recommendation.update({ where: { id: r.id }, data: { overlapsWith } });
    }
  }
}
