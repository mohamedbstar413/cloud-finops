import { prisma, parseJson } from "../db";
import { autoDiagram } from "../engine/diagram";
import {
  analyzeHeuristically,
  parseArchitectureText,
  priceProposal,
  type ArchitectureProposal,
  type CustomAnalysis,
  type PricedProposal,
  type WorkloadProfile,
} from "../engine/custom";
import { runEngineWithCoverage } from "../engine";
import { usageDigest } from "../engine/signals";
import type { Estate, RecommendationDetails, RecommendationDraft } from "../engine/types";
import { makeDraft, money, pct, round, slug, specFromResources } from "../engine/util";
import { narrateFallback, planFromKeywords, TRANSFORM_LABEL, type WhatIfPlan, type WhatIfResult } from "../engine/whatif";
import type { Provider } from "../pricing/catalog";
import { priceComponents, type Component } from "../pricing/components";
import { draftToRow, reconcileOverlaps } from "../services/analysis";
import { loadEstate } from "../services/estate";
import { aiEnabled, generateStructured, stripNulls } from "./client";
import { normalizeComponents } from "./normalize";
import {
  ALLOWED_SKUS,
  customAnalysisSchema,
  discoverySchema,
  enrichmentSchema,
  narrativeSchema,
  TRANSFORMS,
  whatIfPlanSchema,
} from "./schemas";

const SYSTEM = `You are the Architecture Advisor inside Cloud Price Optimizer, a multi-cloud FinOps platform.
You are a principal cloud architect across AWS, Azure and GCP. Your job is to find FUNDAMENTALLY cheaper architectures
(serverless, containers, managed services, spot, data locality, cross-cloud placement) — not just rightsizing.

Hard rules:
- Ground every claim in the metrics provided. Never invent utilisation, traffic or data volumes.
- Describe architectures ONLY with the allowed component kinds. Usage numbers must be derived from the given metrics.
- Do NOT output prices. A deterministic pricing engine prices every component you propose.
- compute.vm SKUs must come from this list: ${ALLOWED_SKUS.vm}.
- db.instance SKUs: ${ALLOWED_SKUS.db}. app.plan SKUs: ${ALLOWED_SKUS.app}.
- Resources may carry a "usage" summary built from weeks of measured history. Size for "peakIn90DaysPct" (the busiest day's peak projected forward at the measured trend), never for the average. Capacity is only needed during "weeklyPattern.busyWindow". "instances.alwaysRunning" is the steady baseline. When a metric says "not measured", treat it as unknown: never propose a change that depends on it being low (for example less memory when memory is not measured).
- "heldBack" lists resources the rules engine deliberately left alone, with the reason (a missing metric, too little history, growing usage, a host that still serves data). Do not propose the change it held back.
- Be honest about trade-offs: cold starts, request time limits, egress, lock-in, spot interruptions, operational overhead.
- Prefer the best savings-to-risk ratio. If a workload is already efficient, say nothing about it.`;

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* ------------------------------------------------------------------------- */

export function summarizeEstate(estate: Estate, minCost = 300) {
  const groups = new Map<string, typeof estate.resources>();
  for (const r of estate.resources) {
    const k = r.workload ?? `(unassigned:${r.accountId})`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([workload, rs]) => ({
      workload,
      providers: [...new Set(rs.map((r) => r.provider))],
      monthlyCost: round(rs.reduce((s, r) => s + r.monthlyCost, 0)),
      resources: rs.map((r) => ({
        id: r.id,
        kind: r.kind,
        service: r.service,
        sku: r.sku,
        quantity: r.quantity,
        region: r.region,
        environment: r.environment,
        monthlyCost: round(r.monthlyCost),
        metrics: Object.fromEntries(Object.entries(r.metrics).filter(([k]) => k !== "hourly")),
        // Peaks, trend, forecast and weekly pattern from the usage history (absent when only summary metrics exist).
        usage: usageDigest(r),
        config: r.config,
      })),
    }))
    .filter((w) => w.monthlyCost >= minCost)
    .sort((a, b) => b.monthlyCost - a.monthlyCost);
}

/* ------------------------------------------------------------------------- */
/* 1. Enrich a recommendation with an AI deep-dive                            */
/* ------------------------------------------------------------------------- */

export interface Enrichment {
  headline: string;
  narrative: string;
  whyNow: string;
  risks: { risk: string; likelihood: string; mitigation: string }[];
  migrationPlan: { phase: string; weeks: string; tasks: string[] }[];
  validationChecks: string[];
  rollbackPlan: string;
  terraform: string;
  questionsForTeam: string[];
  savingsCaveats: string[];
  generatedAt: string;
}

export async function enrichRecommendation(recId: string) {
  const rec = await prisma.recommendation.findUniqueOrThrow({ where: { id: recId } });
  const details = parseJson<RecommendationDetails>(rec.details, {} as RecommendationDetails);
  const ids = parseJson<string[]>(rec.resourceIds, []);
  const resources = await prisma.resource.findMany({ where: { id: { in: ids } } });

  const payload = {
    recommendation: {
      title: rec.title,
      category: rec.category,
      provider: rec.provider,
      targetProvider: rec.targetProvider,
      currentMonthlyCost: rec.currentMonthlyCost,
      projectedMonthlyCost: rec.projectedMonthlyCost,
      monthlySavings: rec.monthlySavings,
      effort: rec.effort,
      risk: rec.risk,
      timeline: rec.timeline,
      explanation: details.explanation,
      evidence: details.evidence,
      currentComponents: details.current?.components.map((c) => ({ label: c.label, kind: c.kind, monthlyCost: c.monthlyCost })),
      proposedComponents: details.proposed?.components.map((c) => ({ label: c.label, kind: c.kind, monthlyCost: c.monthlyCost, pricing: c.pricingNote })),
      alternatives: details.alternatives,
      assumptions: details.assumptions,
      // The measured history the recommendation rests on: how long, which metrics, and how each is trending.
      usageHistory: details.usage && {
        days: details.usage.days,
        metrics: details.usage.metrics,
        notMeasured: details.usage.missing,
        series: details.usage.charts.map((c) => ({ title: c.title, unit: c.unit, latest: c.points.at(-1)?.v, trendPerMonthPct: c.trendPerMonth === undefined ? undefined : Math.round(c.trendPerMonth * 1000) / 10, limits: c.lines })),
        keptOn: details.usage.heatmap?.schedule,
      },
    },
    resources: resources.map((r) => ({ name: r.name, service: r.service, sku: r.sku, quantity: r.quantity, metrics: parseJson(r.metrics, {}), config: parseJson(r.config, {}), tags: parseJson(r.tags, []) })),
  };

  const { data, model } = await generateStructured<Omit<Enrichment, "generatedAt">>({
    name: "recommendation_enrichment",
    schema: enrichmentSchema,
    system: SYSTEM,
    user:
      "Write the deep-dive for this recommendation for the engineering team that will execute it. " +
      "Explain the mechanism of the savings, the concrete migration plan, how to validate and roll back, and a production-quality Terraform sketch for the target state. " +
      "Where a usage history is given, refer to it (how many days, the peaks, the trend) and say which metric to watch after the change. " +
      "Keep numbers consistent with the priced components below.\n\n" +
      JSON.stringify(payload),
  });
  const enrichment: Enrichment = { ...data, generatedAt: new Date().toISOString() };
  await prisma.recommendation.update({ where: { id: recId }, data: { ai: JSON.stringify(enrichment), aiModel: model } });
  return { enrichment, model };
}

/* ------------------------------------------------------------------------- */
/* 2. Generative discovery of new architectures                               */
/* ------------------------------------------------------------------------- */

interface DiscoveryOutput {
  proposals: {
    workload: string;
    replacesResourceIds: string[];
    signals: { label: string; value: string }[];
    proposal: ArchitectureProposal;
  }[];
}

export async function discoverArchitectures(orgId: string) {
  const estate = await loadEstate(orgId);
  const workloads = summarizeEstate(estate, 500);
  const existing = await prisma.recommendation.findMany({ where: { orgId }, select: { title: true, resourceIds: true } });
  // What the rules engine deliberately did not recommend, so the model does not propose it either.
  const heldBack = runEngineWithCoverage(estate).gaps.map((g) => ({ resourceId: g.resourceId, resource: g.resource, reason: g.reason }));

  const { data, model } = await generateStructured<DiscoveryOutput>({
    name: "architecture_discovery",
    schema: discoverySchema,
    system: SYSTEM,
    user:
      "Here is the customer's normalized multi-cloud estate grouped by workload, and the recommendations our rules engine already made. " +
      "Propose up to 4 NEW architecture changes that the rules missed — fundamentally different designs, managed-service substitutions, data-locality moves or cross-cloud placements. " +
      "Each proposal must list the ids of the resources it replaces and the COMPLETE set of components that replace them. Skip workloads where you cannot beat the existing recommendations.\n\n" +
      JSON.stringify({ workloads, existingRecommendations: existing.map((e) => e.title), heldBack }),
    temperature: 0.4,
  });

  const byId = new Map(estate.resources.map((r) => [r.id, r]));
  const drafts: RecommendationDraft[] = [];
  const rejected: { title: string; reason: string }[] = [];
  for (const item of data.proposals) {
    const replaced = item.replacesResourceIds.map((id) => byId.get(id)).filter(Boolean) as Estate["resources"];
    const p = item.proposal;
    if (!replaced.length) {
      rejected.push({ title: p.title, reason: "Did not reference known resources" });
      continue;
    }
    const home = replaced[0].provider;
    const components = normalizeComponents(stripNulls(p.components) as unknown[], p.targetProvider ?? home);
    const priced = priceProposal({ ...p, components }, replaced.reduce((s, r) => s + r.monthlyCost, 0));
    if (priced.monthlySavings < 100 || priced.savingsPct < 10) {
      rejected.push({ title: p.title, reason: `Priced savings too small (${money(priced.monthlySavings)}, ${pct(priced.savingsPct)})` });
      continue;
    }
    const curDiagram = autoDiagram(
      replaced.map((r) => ({ id: r.id, kind: r.kind as Component["kind"], provider: r.provider, label: r.name, sku: r.sku ?? undefined, usage: { count: r.quantity } })),
      "removed",
    );
    const newDiagram = autoDiagram(components, "added");
    const current = specFromResources("Current architecture", home, replaced, curDiagram.nodes, curDiagram.edges, replaced.map((r) => `${r.quantity > 1 ? `${r.quantity} × ` : ""}${r.service} ${r.sku ?? ""} — ${r.name}`));
    const weeks = Math.max(1, Math.round(p.timelineWeeks));
    drafts.push(
      makeDraft({
        fingerprint: `ai:${item.workload}:${slug(p.title).slice(0, 60)}`,
        detector: `ai.${p.strategy}`,
        category: p.targetProvider && p.targetProvider !== home ? "cross_cloud" : "architecture",
        provider: home,
        targetProvider: p.targetProvider !== home ? p.targetProvider : undefined,
        accountId: replaced[0].accountId,
        title: p.title,
        summary: p.rationale.split(". ")[0] + ".",
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: priced.monthlyCost,
        migrationCost: priced.migrationCost,
        effort: p.effort,
        risk: p.risk,
        timeline: `${weeks}–${weeks + 2} weeks`,
        confidence: 0.7,
        resourceIds: replaced.map((r) => r.id),
        source: "ai",
        details: {
          explanation: p.rationale,
          evidence: item.signals,
          benefits: p.benefits,
          risks: p.risks,
          current,
          proposed: {
            title: `Proposed: ${p.title}`,
            provider: p.targetProvider ?? home,
            monthlyCost: priced.monthlyCost,
            components: priced.components,
            nodes: newDiagram.nodes,
            edges: newDiagram.edges,
            bullets: priced.components.map((c) => c.label),
          },
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(priced.monthlyCost), change: "better" },
            { metric: "Migration effort", current: "—", proposed: p.effort, change: "neutral" },
            { metric: "Risk", current: "—", proposed: p.risk, change: "neutral" },
          ],
          implementation: [],
          rollout: { startWeek: Math.max(1, Math.round(weeks / 2)), fullWeek: weeks },
          assumptions: [
            "Proposed by the AI advisor; priced by the deterministic pricing engine",
            ...(replaced.some((r) => r.usage) ? ["Sized by the AI advisor from the usage summary (peaks, trend, weekly pattern) — check it against the usage history before applying"] : ["No usage history for these resources: sizing rests on summary metrics"]),
            `Migration: ${p.migrationEngineerWeeks} engineer-weeks`,
          ],
        },
      }),
    );
  }

  for (const d of drafts) {
    const row = { ...draftToRow(orgId, d), aiModel: model };
    await prisma.recommendation.upsert({
      where: { orgId_fingerprint: { orgId, fingerprint: d.fingerprint } },
      create: row,
      update: row,
    });
  }
  await reconcileOverlaps(orgId);
  return { model, created: drafts.map((d) => ({ title: d.title, monthlySavings: d.monthlySavings })), rejected };
}

/* ------------------------------------------------------------------------- */
/* 3. What-if planning and narration                                          */
/* ------------------------------------------------------------------------- */

export async function planWhatIf(prompt: string, estate: Estate): Promise<{ plan: WhatIfPlan; source: "ai" | "rules"; model?: string }> {
  if (!aiEnabled()) return { plan: planFromKeywords(prompt), source: "rules" };
  const workloads = [...new Set(estate.resources.map((r) => r.workload).filter(Boolean))] as string[];
  const environments = [...new Set(estate.resources.map((r) => r.environment).filter(Boolean))] as string[];
  try {
    const { data, model } = await generateStructured<WhatIfPlan>({
      name: "whatif_plan",
      schema: whatIfPlanSchema,
      system: SYSTEM,
      user:
        `Translate the user's what-if question into simulation transforms. Available transforms: ${TRANSFORMS.map((t) => `${t} (${TRANSFORM_LABEL[t]})`).join(", ")}. ` +
        `Known workloads: ${workloads.join(", ")}. Known environments: ${environments.join(", ")}. Use empty arrays for "all". Only use workload/environment names from these lists.\n\nQuestion: ${prompt}`,
    });
    const plan = stripNulls(data);
    plan.transforms = plan.transforms
      .filter((t) => (TRANSFORMS as readonly string[]).includes(t.type))
      .map((t) => ({ ...t, workloads: t.workloads.filter((w) => workloads.includes(w)), environments: t.environments.filter((e) => environments.includes(e)) }));
    if (!plan.transforms.length) return { plan: planFromKeywords(prompt), source: "rules" };
    return { plan, source: "ai", model };
  } catch {
    return { plan: planFromKeywords(prompt), source: "rules" };
  }
}

export interface Narrative {
  headline: string;
  summary: string;
  keyPoints: string[];
  caveats: string[];
  nextSteps: string[];
}

export async function narrateScenario(prompt: string, plan: WhatIfPlan, result: WhatIfResult): Promise<{ narrative: Narrative; model?: string }> {
  if (!aiEnabled()) return { narrative: narrateFallback(prompt, plan, result) };
  try {
    const compact = {
      ...result,
      steps: result.steps.map((s) => ({ ...s, items: s.items.slice(0, 6) })),
    };
    const { data, model } = await generateStructured<Narrative>({
      name: "scenario_narrative",
      schema: narrativeSchema,
      system: SYSTEM,
      user: `The user asked: "${prompt}". Our simulator produced the result below (all numbers are authoritative — do not change them). Write a crisp answer for a CTO: headline, 2-sentence summary, key points, caveats (include what is NOT eligible and why) and the first three next steps.\n\n${JSON.stringify({ plan, result: compact })}`,
    });
    return { narrative: data, model };
  } catch {
    return { narrative: narrateFallback(prompt, plan, result) };
  }
}

/* ------------------------------------------------------------------------- */
/* 4. Analyze ANY architecture (projection page "custom" mode)                */
/* ------------------------------------------------------------------------- */

export async function analyzeCustomArchitecture(input: {
  description?: string;
  components?: Component[];
  profile?: Partial<WorkloadProfile>;
}): Promise<CustomAnalysis & { notice?: string }> {
  const parsed = input.description ? parseArchitectureText(input.description) : undefined;
  const builder = input.components?.length ? normalizeComponents(input.components as unknown[], input.components[0].provider) : [];
  const baseComponents = builder.length ? builder : (parsed?.components ?? []);
  const profile: WorkloadProfile = {
    trafficPattern: "unknown",
    // Conservative default: without a stated role or profile, tiers are treated as stateful.
    stateless: false,
    interruptible: false,
    latencySensitive: false,
    ...(parsed?.profile ?? {}),
    ...Object.fromEntries(Object.entries(input.profile ?? {}).filter(([, v]) => v !== undefined && v !== null)),
  };
  const extra = { assumptions: builder.length ? [] : (parsed?.assumptions ?? []), unrecognized: parsed?.unrecognized ?? [] };

  if (!aiEnabled()) {
    if (!baseComponents.length) throw new Error("Could not recognise any components. Add them with the builder, or configure OPENAI_API_KEY for free-text analysis.");
    return { ...analyzeHeuristically(baseComponents, profile, extra), notice: "Rules-based analysis (set OPENAI_API_KEY for AI-generated architectures)." };
  }

  const { data, model } = await generateStructured<{
    interpretedCurrent: Component[];
    profile: WorkloadProfile;
    proposals: ArchitectureProposal[];
  }>({
    name: "custom_architecture_analysis",
    schema: customAnalysisSchema,
    system: SYSTEM,
    user:
      "A prospect describes their current architecture. 1) Express the CURRENT architecture as components (reuse the provided components verbatim if given; set role web/batch/stateful/k8s per tier in the label). " +
      "2) Infer the workload profile. 3) Propose 2–3 alternative architectures, from bold redesigns (serverless, containers, cross-cloud, data locality) to optimize-in-place. " +
      "Only use Spot for interruption-tolerant tiers and never propose serverless for latency-sensitive paths. " +
      "Each proposal must list the COMPLETE set of components for the new architecture (including anything kept as-is).\n\n" +
      JSON.stringify({ description: input.description ?? null, components: baseComponents, profileHints: profile }),
    temperature: 0.3,
  });

  const home = (baseComponents[0]?.provider ?? data.interpretedCurrent[0]?.provider ?? "aws") as Provider;
  const current = baseComponents.length ? baseComponents : normalizeComponents(stripNulls(data.interpretedCurrent) as unknown[], home);
  const cur = priceComponents(current);
  const aiProfile = { ...profile, ...stripNulls(data.profile) };
  const aiProposals: PricedProposal[] = data.proposals
    .map((p) => priceProposal({ ...p, origin: "ai", components: normalizeComponents(stripNulls(p.components) as unknown[], p.targetProvider ?? home) }, cur.total))
    .filter((p) => p.monthlySavings > 0);
  // Rules-based proposals are always computed too: they act as a sanity baseline for the AI.
  const rules = analyzeHeuristically(current, aiProfile, extra);
  return {
    current: { components: cur.components, monthlyCost: cur.total },
    profile: aiProfile,
    proposals: [...aiProposals, ...rules.proposals].sort((a, b) => b.monthlySavings - a.monthlySavings).slice(0, 5),
    insights: rules.insights,
    assumptions: rules.assumptions,
    unrecognized: rules.unrecognized,
    source: "ai",
    model,
  };
}
