import {
  cheapestEquivalentVm,
  DEFAULT_REGION,
  resolveVm,
  HOURS_PER_MONTH,
  PRICES,
  PROVIDER_LABEL,
  PROVIDERS,
  Provider,
} from "../pricing/catalog";
import { Component, serviceName } from "../pricing/components";
import { tfAwsSpot, tfGcpSpot } from "./terraform";
import type { Alternative, Detector, DiagramEdge, DiagramNode, RecommendationDraft } from "./types";
import {
  buildArchitecture,
  countOf,
  groupBy,
  makeDraft,
  migrationCostFromWeeks,
  money,
  pct,
  round,
  specFromResources,
  sumCost,
} from "./util";

/** Spot capacity overhead to cover re-runs after interruptions. */
const SPOT_OVERHEAD = 1.1;

interface Option {
  provider: Provider;
  region: string;
  spot: boolean;
  sku: string;
  components: Component[];
  monthly: number;
  migrationWeeks: number;
  egressMonthly: number;
}

/**
 * Cross-cloud arbitrage that is honest about data gravity: every candidate
 * placement is priced with compute, storage AND the egress it would create or
 * eliminate, plus a one-time migration cost. Same-cloud Spot is always
 * evaluated so we never recommend a cross-cloud move that a simpler change beats.
 */
export const arbitrageWith = ({ sameProviderOnly = false } = {}): Detector => (estate) => {
  const out: RecommendationDraft[] = [];
  const byWorkload = groupBy(estate.resources.filter((r) => r.workload), (r) => r.workload!);

  for (const [workload, rs] of byWorkload) {
    const vms = rs.filter((r) => r.kind === "compute.vm" && r.config.portable && r.state === "running");
    if (!vms.length) continue;
    const home = vms[0].provider;
    const shapes = vms.map((v) => ({ r: v, vm: resolveVm(v.sku) }));
    if (shapes.some((x) => !x.vm)) continue;
    const curSkus = [...new Set(shapes.map((x) => x.vm!.sku))].join(" + ");
    const count = countOf(vms);
    const interruptible = vms.every((v) => v.config.interruptible);
    const blockGb = rs.filter((r) => r.kind === "storage.block").reduce((s, r) => s + (r.config.sizeGb ?? 0) * r.quantity, 0);
    const sources = vms.flatMap((v) => v.config.dataSources ?? []);
    const sinks = vms.flatMap((v) => v.config.dataSinks ?? []);
    // Egress billed on another cloud is caused by this workload's cross-cloud reads;
    // egress on the home cloud is traffic to end users and follows the workload anywhere.
    const egressResources = rs.filter((r) => r.kind === "network.egress");
    const userEgressGb = egressResources
      .filter((r) => r.provider === home)
      .reduce((s, r) => s + (r.metrics.gbEgress ?? r.monthlyCost / PRICES.egressInternet[home]), 0);
    const workloadResources = rs.filter((r) => r.kind === "compute.vm" || r.kind === "storage.block" || r.kind === "network.egress");
    const currentCost = sumCost(workloadResources);

    const options: Option[] = [];
    for (const p of PROVIDERS) {
      if (sameProviderOnly && p !== home) continue;
      const equivalents = shapes.map(({ r, vm }) => ({ r, vm: p === home ? vm! : cheapestEquivalentVm(p, vm!.vcpu, vm!.memGiB) }));
      if (equivalents.some((e) => !e.vm)) continue;
      const region =
        sources.find((s) => s.provider === p)?.region ?? (p === home ? vms[0].region : DEFAULT_REGION[p]);
      for (const spot of interruptible ? [false, true] : [false]) {
        if (p === home && !spot) continue; // that's the status quo
        const comps: Component[] = [
          ...equivalents.map(({ r, vm }, i) => ({
            id: `vm-${p}-${spot}-${i}`,
            kind: "compute.vm" as const,
            provider: p,
            label: `${r.quantity} × ${vm!.sku}${spot ? " Spot" : ""}${equivalents.length > 1 ? ` (${r.name})` : ""}`,
            sku: vm!.sku,
            region,
            usage: { count: r.quantity, spot, hours: HOURS_PER_MONTH * (spot ? SPOT_OVERHEAD : 1) },
          })),
          { id: `disk-${p}`, kind: "storage.block", provider: p, label: `${serviceName("storage.block", p)} volumes`, region, usage: { gb: blockGb, tier: "standard" } },
          ...(userEgressGb > 0
            ? [{ id: `users-${p}`, kind: "network.egress" as const, provider: p, label: "Internet egress to users (unchanged volume)", region, usage: { gb: userEgressGb, destination: "internet" as const } }]
            : []),
        ];
        let egress = 0;
        for (const s of sources) {
          if (s.provider !== p) {
            comps.push({ id: `in-${s.label}`, kind: "network.egress", provider: s.provider, label: `${s.label} → ${PROVIDER_LABEL[p]} (${PROVIDER_LABEL[s.provider]} egress)`, usage: { gb: s.gbPerMonth, destination: "inter_cloud" } });
            egress += s.gbPerMonth * PRICES.egressInternet[s.provider];
          } else if (s.region !== region) {
            comps.push({ id: `in-${s.label}`, kind: "network.egress", provider: p, label: `${s.label} inter-region`, usage: { gb: s.gbPerMonth, destination: "inter_region" } });
            egress += s.gbPerMonth * PRICES.egressInterRegion[p];
          }
        }
        for (const s of sinks) {
          if (s.provider !== p) {
            comps.push({ id: `out-${s.label}`, kind: "network.egress", provider: p, label: `Results → ${s.label} (${PROVIDER_LABEL[p]} egress)`, usage: { gb: s.gbPerMonth, destination: "inter_cloud" } });
            egress += s.gbPerMonth * PRICES.egressInternet[p];
          }
        }
        const priced = buildArchitecture("", p, comps, [], [], []);
        const skus = [...new Set(equivalents.map((e) => e.vm!.sku))].join(" + ");
        options.push({ provider: p, region, spot, sku: skus, components: comps, monthly: priced.monthlyCost, migrationWeeks: p === home ? 1.5 : 6, egressMonthly: egress });
      }
    }
    if (!options.length) continue;
    options.sort((a, b) => a.monthly + (a.migrationWeeks * 4000) / 24 - (b.monthly + (b.migrationWeeks * 4000) / 24));
    const best = options[0];
    const savings = currentCost - best.monthly;
    if (savings / currentCost < 0.25) continue;

    const crossCloud = best.provider !== home;
    const bestSameCloud = options.find((o) => o.provider === home);
    const target = PROVIDER_LABEL[best.provider];
    const homeEgress = sumCost(egressResources.filter((r) => r.provider !== home));

    const alternatives: Alternative[] = [
      { label: `Current — ${PROVIDER_LABEL[home]} on-demand (${curSkus})`, provider: home, monthlyCost: round(currentCost), savingsPct: 0, note: homeEgress ? `includes ${money(homeEgress)} cross-cloud egress` : "status quo" },
      ...options.map((o) => ({
        label: `${PROVIDER_LABEL[o.provider]} ${o.spot ? "Spot" : "on-demand"} (${o.sku}, ${o.region})`,
        provider: o.provider,
        monthlyCost: round(o.monthly),
        savingsPct: round(((currentCost - o.monthly) / currentCost) * 100, 1),
        note: o.egressMonthly > 0 ? `${money(o.egressMonthly)} egress` : "no cross-cloud egress",
        chosen: o === best,
      })),
    ];

    const dataNodes = (layer: number): DiagramNode[] =>
      sources.map((s, i) => ({ id: `src${i}`, label: s.label, sublabel: PROVIDER_LABEL[s.provider], icon: "storage" as const, layer, provider: s.provider }));
    const sinkNodes = (layer: number): DiagramNode[] =>
      sinks.map((s, i) => ({ id: `sink${i}`, label: s.label, sublabel: PROVIDER_LABEL[s.provider], icon: "storage" as const, layer, provider: s.provider }));

    const curNodes: DiagramNode[] = [
      ...dataNodes(0),
      { id: "fleet", label: `${PROVIDER_LABEL[home]} ${serviceName("compute.vm", home)}`, sublabel: `${curSkus} on-demand`, icon: "vm", layer: 1, count, provider: home, highlight: "removed" },
      ...sinkNodes(2),
    ];
    const curEdges: DiagramEdge[] = [
      ...sources.map((s, i) => ({ from: `src${i}`, to: "fleet", label: s.provider !== home ? `${round(s.gbPerMonth / 1024)} TB/mo egress` : undefined, dashed: s.provider !== home })),
      ...sinks.map((s, i) => ({ from: "fleet", to: `sink${i}`, label: s.provider !== home ? `${round(s.gbPerMonth / 1024)} TB/mo` : undefined, dashed: s.provider !== home })),
    ];
    const newNodes: DiagramNode[] = [
      ...dataNodes(0),
      { id: "fleet", label: `${target} ${serviceName("compute.vm", best.provider)}`, sublabel: `${best.sku}${best.spot ? " Spot" : ""}`, icon: "vm", layer: 1, count, provider: best.provider, highlight: "added" },
      ...sinkNodes(2),
    ];
    const newEdges: DiagramEdge[] = [
      ...sources.map((s, i) => ({ from: `src${i}`, to: "fleet", label: s.provider !== best.provider ? `${round(s.gbPerMonth / 1024)} TB/mo egress` : "same region, free", dashed: s.provider !== best.provider })),
      ...sinks.map((s, i) => ({ from: "fleet", to: `sink${i}`, label: s.provider !== best.provider ? `${round(s.gbPerMonth / 1024)} TB/mo egress` : undefined, dashed: s.provider !== best.provider })),
    ];

    const current = specFromResources("Current architecture", home, workloadResources, curNodes, curEdges, [
      `${count} × ${curSkus} on-demand on ${PROVIDER_LABEL[home]}`,
      ...sources.map((s) => `Reads ${round(s.gbPerMonth / 1024)} TB/mo from ${s.label} (${PROVIDER_LABEL[s.provider]})`),
      ...sinks.map((s) => `Writes ${round(s.gbPerMonth / 1024)} TB/mo to ${s.label}`),
    ]);
    const proposed = buildArchitecture(`Proposed: ${target} ${best.spot ? "Spot" : "on-demand"}`, best.provider, best.components, newNodes, newEdges, [
      `${count} × ${best.sku}${best.spot ? " Spot" : ""} in ${best.region}`,
      ...sources.map((s) => (s.provider === best.provider ? `Co-located with ${s.label} — no egress` : `Still reads ${s.label} cross-cloud`)),
      ...(best.spot ? ["Checkpointing + 10% capacity buffer for interruptions"] : []),
    ]);

    const title = crossCloud
      ? `Move ${workload} to ${target} ${best.spot ? "Spot instances" : ""}`.trim()
      : `Run ${workload} on ${target} Spot instances`;

    out.push(
      makeDraft({
        fingerprint: `arch.cross_cloud:${workload}`,
        detector: "arch.cross_cloud",
        category: crossCloud ? "cross_cloud" : "architecture",
        provider: home,
        targetProvider: best.provider,
        accountId: vms[0].accountId,
        title,
        summary: crossCloud
          ? `Running ${workload} on ${target}${best.spot ? " Spot" : ""} is ${pct((savings / currentCost) * 100)} cheaper than your current ${PROVIDER_LABEL[home]} setup${homeEgress ? `, including ${money(homeEgress)}/mo of cross-cloud egress it eliminates` : ""}.`
          : `${workload} is interruption-tolerant — Spot capacity cuts its cost by ${pct((savings / currentCost) * 100)}.`,
        currentMonthlyCost: currentCost,
        projectedMonthlyCost: best.monthly,
        migrationCost: migrationCostFromWeeks(best.migrationWeeks),
        effort: crossCloud ? "medium" : "low",
        risk: crossCloud ? "medium" : "low",
        timeline: crossCloud ? "4–6 weeks" : "1–2 weeks",
        confidence: crossCloud ? 0.78 : 0.88,
        resourceIds: workloadResources.map((r) => r.id),
        details: {
          explanation: crossCloud
            ? `${workload} is a portable, interruption-tolerant batch workload running ${count} on-demand ${curSkus} instances on ${PROVIDER_LABEL[home]}. ` +
              `${sources.length ? `Its input data lives in ${sources.map((s) => `${s.label} (${PROVIDER_LABEL[s.provider]})`).join(", ")}, so every run pays cross-cloud egress. ` : ""}` +
              `We priced every placement across AWS, Azure and GCP (compute + storage + egress, with a 10% Spot interruption buffer). ` +
              `${target}${best.spot ? " Spot" : ""} next to the data is the cheapest by ${money(savings)}/month` +
              (bestSameCloud ? `, beating ${PROVIDER_LABEL[home]} Spot in place (${money(bestSameCloud.monthly)}/month) because it also removes the egress.` : ".")
            : `${workload} tolerates interruptions. Moving it to Spot capacity with a diversified instance pool saves ${money(savings)}/month.`,
          evidence: [
            { label: "Workload type", value: interruptible ? "Batch / interruption-tolerant" : "Service" },
            { label: "Current fleet", value: `${count} × ${curSkus} on-demand` },
            ...sources.map((s) => ({ label: `Input from ${s.label}`, value: `${round(s.gbPerMonth / 1024, 1)} TB / month` })),
            ...(homeEgress ? [{ label: "Cross-cloud egress today", value: `${money(homeEgress)} / month` }] : []),
          ],
          benefits: [
            ...(crossCloud ? ["Eliminates cross-cloud egress by co-locating compute with data"] : []),
            ...(best.spot ? [`Spot pricing (~${pct((1 - (resolveVm(best.sku.split(" + ")[0])?.spotFactor ?? 0.3)) * 100)} below on-demand)`] : []),
            "Portable container image — no application rewrite",
          ],
          risks: [
            ...(best.spot ? ["Spot interruptions: jobs must checkpoint and be idempotent"] : []),
            ...(crossCloud ? ["Second cloud to operate: IAM federation, monitoring and on-call runbooks", "Results written back cross-cloud still incur egress"] : []),
          ],
          alternatives,
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(currentCost), proposed: money(best.monthly), change: "better" },
            { metric: "Cross-cloud egress", current: money(homeEgress), proposed: money(best.egressMonthly), change: best.egressMonthly < homeEgress ? "better" : "same" },
            { metric: "Pricing model", current: "On-demand", proposed: best.spot ? "Spot" : "On-demand", change: "better" },
            { metric: "Operational complexity", current: "Single cloud", proposed: crossCloud ? "Multi-cloud" : "Single cloud", change: crossCloud ? "worse" : "same" },
          ],
          implementation: crossCloud
            ? [
                { phase: "Make jobs portable", weeks: "Weeks 1–2", tasks: ["Containerize job runner", "Add checkpointing to object storage", "Set up workload identity federation for cross-cloud writes"] },
                { phase: `Provision on ${target}`, weeks: "Weeks 2–3", tasks: [`Create ${best.spot ? "Spot " : ""}instance group / Batch queue in ${best.region}`, "Mirror secrets and config"] },
                { phase: "Parallel run", weeks: "Weeks 3–4", tasks: ["Run both pipelines, diff outputs", "Measure interruption rate and runtime"] },
                { phase: "Cutover", weeks: "Weeks 5–6", tasks: [`Switch scheduler to ${target}`, `Decommission ${PROVIDER_LABEL[home]} fleet`] },
              ]
            : [
                { phase: "Spot fleet", weeks: "Week 1", tasks: ["Diversify instance types", "Add interruption handler + checkpointing"] },
                { phase: "Cutover", weeks: "Week 2", tasks: ["Shift scheduler to the Spot group"] },
              ],
          terraform:
            best.provider === "gcp"
              ? tfGcpSpot({ name: workload, machineType: best.sku.split(" + ")[0], count, region: best.region })
              : best.provider === "aws"
                ? tfAwsSpot({ name: workload, instanceType: best.sku.split(" + ")[0], count, region: best.region })
                : undefined,
          rollout: crossCloud ? { startWeek: 4, fullWeek: 6 } : { startWeek: 1, fullWeek: 2 },
          assumptions: ["Spot price at 30–35% of on-demand with 10% re-run overhead", "Egress at public internet list rates", `Migration: ${best.migrationWeeks} engineer-weeks`],
        },
      }),
    );
  }
  return out;
};

export const crossCloudArbitrage = arbitrageWith();
