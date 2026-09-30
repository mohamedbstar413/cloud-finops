import { armEquivalent, HOURS_PER_MONTH, PROVIDER_LABEL, PROVIDERS, regionMultiplier, resolveVm, type Provider } from "../pricing/catalog";
import { priceComponent } from "../pricing/components";
import { arbitrageWith } from "./arbitrage";
import { appPlanToContainers, databaseServerless, kubernetesSpotConsolidation, natToEndpoints, serverlessModernizationWith, staticSiteToCdn } from "./architecture";
import { commitmentRecommendations } from "./commitments";
import { dbRightsizing, idleResources, nonProdScheduling, rightsizing, storageTiering } from "./standard";
import type { Detector, Estate, RecommendationDraft } from "./types";
import { effectiveRate, groupBy, isFiniteDraft, makeDraft, money, pct, round, sumCost, weightedAvg } from "./util";

export const TRANSFORM_LABEL: Record<string, string> = {
  serverless: "Move to serverless",
  containers: "Containerize VM fleets",
  spot: "Use Spot capacity",
  cross_cloud_cheapest: "Place each workload on its cheapest cloud",
  commitments: "Commit to steady-state compute",
  schedule_nonprod: "Schedule non-production",
  rightsizing: "Right-size",
  arm: "Migrate to Arm (Graviton/Ampere/Axion)",
  storage_tiering: "Tier storage",
  remove_idle: "Remove idle resources",
  cheapest_region: "Move to lowest-cost regions",
};

export interface WhatIfTransform {
  type: keyof typeof TRANSFORM_LABEL;
  providers: Provider[];
  workloads: string[];
  environments: string[];
  commitmentTerm?: "1y" | "3y" | null;
}

export interface WhatIfPlan {
  interpretation: string;
  transforms: WhatIfTransform[];
  assumptions: string[];
}

export interface WhatIfItem {
  title: string;
  resourceIds: string[];
  provider: Provider;
  targetProvider?: Provider;
  workload?: string;
  monthlySavings: number;
  currentMonthlyCost: number;
  migrationCost: number;
}

export interface WhatIfResult {
  baselineMonthly: number;
  scenarioMonthly: number;
  monthlySavings: number;
  savingsPct: number;
  migrationCost: number;
  paybackMonths: number | null;
  steps: { type: string; label: string; monthlySavings: number; items: WhatIfItem[] }[];
  byProvider: { provider: Provider; before: number; after: number }[];
  notEligible: { name: string; reason: string }[];
}

/* ---------------- Extra what-if-only transforms ---------------- */

const containerizeFleets: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  const fleets = groupBy(
    estate.resources.filter((r) => r.kind === "compute.vm" && r.state === "running" && r.config.role !== "k8s-node" && !r.config.interruptible && r.workload),
    (r) => `${r.accountId}|${r.workload}`,
  );
  for (const [key, rs] of fleets) {
    const shapes = rs.map((r) => ({ r, vm: resolveVm(r.sku) }));
    if (shapes.some((x) => !x.vm)) continue;
    const count = rs.reduce((s, r) => s + r.quantity, 0);
    if (count <= 0) continue; // e.g. an Auto Scaling group scaled to zero
    // Used vCPU / memory summed per instance group (fleets can mix instance types).
    const used = shapes.reduce((s, { r, vm }) => s + r.quantity * vm!.vcpu * ((r.metrics.cpuAvg ?? 30) / 100), 0);
    const memPerVcpu = shapes.reduce((s, { r, vm }) => s + r.quantity * vm!.memGiB, 0) / shapes.reduce((s, { r, vm }) => s + r.quantity * vm!.vcpu, 0);
    const replicas = Math.max(2, Math.ceil(used * 1.4));
    const p = rs[0].provider;
    const proposed = priceComponent({ id: "c", kind: "compute.container", provider: p, label: "containers", region: rs[0].region, usage: { count: replicas, vcpu: 1, memGb: Math.max(2, memPerVcpu), activeHours: HOURS_PER_MONTH } }).monthlyCost;
    const cur = sumCost(rs);
    if (proposed >= cur * 0.9) continue;
    out.push(
      makeDraft({
        fingerprint: `whatif.containers:${key}`,
        detector: "whatif.containers",
        category: "architecture",
        provider: p,
        title: `Containerize ${rs[0].workload} (${count} VMs → ~${replicas} serverless container replicas)`,
        summary: "",
        currentMonthlyCost: cur,
        projectedMonthlyCost: proposed,
        migrationCost: 5 * 4000,
        effort: "medium",
        risk: "low",
        timeline: "3 weeks",
        confidence: 0.7,
        resourceIds: rs.map((r) => r.id),
        details: { explanation: "", rollout: { startWeek: 2, fullWeek: 3 } },
      }),
    );
  }
  return out;
};

const armMigration: Detector = (estate) =>
  estate.resources
    .filter((r) => r.kind === "compute.vm" && r.state === "running" && r.sku && armEquivalent(r.sku))
    .map((r) => {
      const to = armEquivalent(r.sku!)!;
      const proposed = priceComponent({ id: r.id, kind: "compute.vm", provider: r.provider, label: to.sku, sku: to.sku, region: r.region, usage: { count: r.quantity } }).monthlyCost * effectiveRate([r]);
      return makeDraft({
        fingerprint: `whatif.arm:${r.id}`,
        detector: "whatif.arm",
        category: "rightsizing",
        provider: r.provider,
        title: `${r.name}: ${r.sku} → ${to.sku}`,
        summary: "",
        currentMonthlyCost: r.monthlyCost,
        projectedMonthlyCost: proposed,
        migrationCost: 1.5 * 4000,
        effort: "medium",
        risk: "medium",
        timeline: "2 weeks",
        confidence: 0.65,
        resourceIds: [r.id],
        details: { explanation: "", rollout: { startWeek: 1, fullWeek: 2 } },
      });
    });

const cheapestRegion: Detector = (estate) =>
  estate.resources
    .filter((r) => r.kind === "compute.vm" && regionMultiplier(r.region) > 1.02 && !r.config.dataResidency)
    .map((r) => {
      const m = regionMultiplier(r.region);
      return makeDraft({
        fingerprint: `whatif.region:${r.id}`,
        detector: "whatif.region",
        category: "architecture",
        provider: r.provider,
        title: `${r.name}: ${r.region} → lowest-cost region`,
        summary: "",
        currentMonthlyCost: r.monthlyCost,
        projectedMonthlyCost: r.monthlyCost / m,
        migrationCost: 2 * 4000,
        effort: "medium",
        risk: "medium",
        timeline: "3 weeks",
        confidence: 0.6,
        resourceIds: [r.id],
        details: { explanation: "", rollout: { startWeek: 2, fullWeek: 3 } },
      });
    });

const DETECTORS: Record<string, Detector[]> = {
  serverless: [serverlessModernizationWith({ minFit: 45 }), staticSiteToCdn, appPlanToContainers, databaseServerless],
  containers: [containerizeFleets, appPlanToContainers],
  spot: [arbitrageWith({ sameProviderOnly: true }), kubernetesSpotConsolidation],
  cross_cloud_cheapest: [arbitrageWith()],
  schedule_nonprod: [nonProdScheduling],
  rightsizing: [rightsizing, dbRightsizing],
  arm: [armMigration],
  storage_tiering: [storageTiering, (e) => idleResources(e).filter((d) => d.detector === "idle.snapshots"), natToEndpoints],
  remove_idle: [(e) => idleResources(e).filter((d) => d.detector !== "idle.snapshots")],
  cheapest_region: [cheapestRegion],
};

function scope(estate: Estate, t: WhatIfTransform): Estate {
  const resources = estate.resources.filter(
    (r) =>
      (!t.providers.length || t.providers.includes(r.provider)) &&
      (!t.workloads.length || (r.workload && t.workloads.includes(r.workload))) &&
      (!t.environments.length || (r.environment && t.environments.includes(r.environment))),
  );
  return { ...estate, resources };
}

function notEligibleFor(estate: Estate, type: string): { name: string; reason: string; ids: string[] }[] {
  const out: { name: string; reason: string; ids: string[] }[] = [];
  const groups = groupBy(estate.resources.filter((r) => r.kind === "compute.vm" && r.workload), (r) => r.workload!);
  for (const [w, rs] of groups) {
    const ids = rs.map((r) => r.id);
    const cpu = weightedAvg(rs, (r) => r.metrics.cpuAvg);
    if (type === "serverless") {
      let reason: string;
      if (rs.some((r) => r.config.role === "k8s-node")) reason = "Kubernetes node pool — optimize pods and nodes instead";
      else if (rs.some((r) => r.config.interruptible)) reason = "Long-running batch jobs exceed function time limits";
      else if (rs.every((r) => (r.metrics.cpuMax ?? 100) < 5)) reason = "Idle — terminate instead of migrating";
      else if (rs.some((r) => r.environment && r.environment !== "prod")) reason = "Non-production — schedule it off-hours instead";
      else if (!rs.every((r) => r.config.stateless)) reason = "Stateful service (sessions / local state) — needs refactoring first";
      else reason = `Steady utilisation (avg CPU ${pct(cpu)}) — VMs with commitments are cheaper`;
      out.push({ name: w, reason, ids });
    }
    if (type === "cross_cloud_cheapest" && !rs.some((r) => r.config.portable)) {
      out.push({ name: w, reason: "Not portable (managed-service or data dependencies) — stays on its current cloud", ids });
    }
  }
  return out;
}

export function simulate(estate: Estate, plan: WhatIfPlan): WhatIfResult {
  const baselineByProvider = new Map<Provider, number>(PROVIDERS.map((p) => [p, 0]));
  for (const r of estate.resources) baselineByProvider.set(r.provider, (baselineByProvider.get(r.provider) ?? 0) + r.monthlyCost);
  const baseline = sumCost(estate.resources);
  const after = new Map(baselineByProvider);

  const claimed = new Set<string>();
  const accepted: RecommendationDraft[] = [];
  const steps: WhatIfResult["steps"] = [];
  const notEligible: { name: string; reason: string; ids: string[] }[] = [];

  const order = ["remove_idle", "serverless", "containers", "cross_cloud_cheapest", "spot", "rightsizing", "arm", "schedule_nonprod", "storage_tiering", "cheapest_region", "commitments"];
  const transforms = [...plan.transforms].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

  for (const t of transforms) {
    let drafts: RecommendationDraft[];
    if (t.type === "commitments") {
      drafts = commitmentRecommendations(scope(estate, t), accepted, t.commitmentTerm ?? "1y");
    } else {
      drafts = (DETECTORS[t.type] ?? []).flatMap((d) => d(scope(estate, t))).sort((a, b) => b.monthlySavings - a.monthlySavings);
    }
    const items: WhatIfItem[] = [];
    for (const d of drafts) {
      if (!isFiniteDraft(d) || d.monthlySavings <= 0 || d.resourceIds.some((id) => claimed.has(id))) continue;
      d.resourceIds.forEach((id) => claimed.add(id));
      accepted.push(d);
      const target = d.targetProvider ?? d.provider;
      after.set(d.provider, (after.get(d.provider) ?? 0) - d.currentMonthlyCost);
      after.set(target, (after.get(target) ?? 0) + d.projectedMonthlyCost);
      const res = estate.resources.find((r) => d.resourceIds.includes(r.id));
      items.push({
        title: d.title,
        resourceIds: d.resourceIds,
        provider: d.provider,
        targetProvider: d.targetProvider,
        workload: res?.workload ?? undefined,
        monthlySavings: d.monthlySavings,
        currentMonthlyCost: d.currentMonthlyCost,
        migrationCost: d.migrationCost,
      });
    }
    notEligible.push(...notEligibleFor(scope(estate, t), t.type));
    steps.push({ type: t.type, label: TRANSFORM_LABEL[t.type] ?? t.type, monthlySavings: round(items.reduce((s, i) => s + i.monthlySavings, 0)), items });
  }

  const savings = steps.reduce((s, x) => s + x.monthlySavings, 0);
  const migration = accepted.reduce((s, d) => s + d.migrationCost, 0);
  return {
    baselineMonthly: round(baseline),
    scenarioMonthly: round(baseline - savings),
    monthlySavings: round(savings),
    savingsPct: baseline ? round((savings / baseline) * 100, 1) : 0,
    migrationCost: round(migration),
    paybackMonths: savings > 0 ? round(migration / savings, 1) : null,
    steps,
    byProvider: PROVIDERS.map((p) => ({ provider: p, before: round(baselineByProvider.get(p) ?? 0), after: round(Math.max(0, after.get(p) ?? 0)) })),
    notEligible: dedupe(notEligible.filter((n) => !n.ids.some((id) => claimed.has(id)))),
  };
}

const dedupe = (xs: { name: string; reason: string }[]) => {
  const m = new Map<string, { name: string; reason: string }>();
  for (const x of xs) if (!m.has(x.name)) m.set(x.name, { name: x.name, reason: x.reason });
  return [...m.values()];
};

/* ---------------- Offline planner (used when OpenAI is not configured) ---------------- */

export function planFromKeywords(prompt: string): WhatIfPlan {
  const q = prompt.toLowerCase();
  const providers = (["aws", "azure", "gcp"] as Provider[]).filter((p) => new RegExp(`\\bonly\\b[^.]*\\b${p}\\b|\\b${p}\\b[^.]*\\bonly\\b`).test(q));
  const envs = ["staging", "dev", "test", "prod"].filter((e) => q.includes(`${e} `) && /only|just/.test(q));
  const t = (type: WhatIfTransform["type"], extra: Partial<WhatIfTransform> = {}): WhatIfTransform => ({ type, providers, workloads: [], environments: envs, ...extra });
  const transforms: WhatIfTransform[] = [];
  const all = /(every (optimi[sz]ation|lever|recommendation)|all (the )?(recommendations|optimi[sz]ations|levers)|max(imum)? savings|every lever|everything we can)/.test(q);
  if (all || /serverless|lambda|functions|faas/.test(q)) transforms.push(t("serverless"));
  if (/containeri[sz]|fargate|cloud run|container apps/.test(q)) transforms.push(t("containers"));
  if (all || /\bspot\b|preemptible|interrupt/.test(q)) transforms.push(t("spot"));
  if (all || /cheapest cloud|cross.?cloud|multi.?cloud|arbitrage|move .*(to|onto) (gcp|google|azure|aws)|best cloud/.test(q)) transforms.push(t("cross_cloud_cheapest", { providers: [] }));
  if (all || /commit|reserved|reservation|savings plan|\bcud\b/.test(q)) transforms.push(t("commitments", { commitmentTerm: /3.?y|three.?year|36/.test(q) ? "3y" : "1y" }));
  if (all || /schedul|night|weekend|non.?prod|office hours/.test(q)) transforms.push(t("schedule_nonprod"));
  if (all || /right.?siz|downsiz|over.?provision/.test(q)) transforms.push(t("rightsizing"));
  if (/\barm\b|graviton|ampere|axion|cobalt/.test(q)) transforms.push(t("arm"));
  if (all || /storage|tier|lifecycle|archive|glacier|cold data|snapshot/.test(q)) transforms.push(t("storage_tiering"));
  if (all || /idle|unused|orphan|zombie|clean ?up|waste/.test(q)) transforms.push(t("remove_idle"));
  if (/region/.test(q)) transforms.push(t("cheapest_region"));
  const assumptions: string[] = [];
  if (!transforms.length) {
    transforms.push(t("rightsizing"), t("remove_idle"), t("commitments", { commitmentTerm: "1y" }));
    assumptions.push("No specific lever recognized — simulated the low-risk baseline (right-size, remove idle, commit).");
  }
  return {
    interpretation: `Simulate: ${transforms.map((x) => TRANSFORM_LABEL[x.type]).join(" + ")}${providers.length ? ` on ${providers.map((p) => PROVIDER_LABEL[p]).join(", ")}` : ""}.`,
    transforms,
    assumptions: [...assumptions, "Current list prices; usage held at the last 30 days", "Changes are applied in dependency order and never double-count a resource"],
  };
}

export function narrateFallback(prompt: string, plan: WhatIfPlan, r: WhatIfResult) {
  const top = r.steps.filter((s) => s.monthlySavings > 0).sort((a, b) => b.monthlySavings - a.monthlySavings);
  return {
    headline: `${money(r.monthlySavings)}/month (${pct(r.savingsPct)}) lower spend`,
    summary: `${plan.interpretation} Monthly spend would go from ${money(r.baselineMonthly)} to ${money(r.scenarioMonthly)}. One-time migration effort is about ${money(r.migrationCost)}${r.paybackMonths !== null ? `, paid back in ${r.paybackMonths} months` : ""}.`,
    keyPoints: top.map((s) => `${s.label}: ${money(s.monthlySavings)}/mo across ${s.items.length} change${s.items.length === 1 ? "" : "s"}`),
    caveats: [
      ...r.notEligible.slice(0, 4).map((n) => `${n.name}: ${n.reason}`),
      ...plan.assumptions,
    ],
    nextSteps: top.slice(0, 3).flatMap((s) => s.items.slice(0, 1).map((i) => `Start with “${i.title}” (${money(i.monthlySavings)}/mo)`)),
  };
}

