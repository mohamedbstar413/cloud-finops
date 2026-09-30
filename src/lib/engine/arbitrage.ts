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
import { describeSchedule } from "../usage/series";
import { chartOf, cpuSignal, evidence, isIdleCpu, mergeWindows, pctTrend, usageWindow, type UsageWindow } from "./signals";
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
    // A fleet that does nothing at all is a candidate for termination (the idle detector), not for a move.
    if (vms.every((v) => {
      const cpu = cpuSignal(v);
      return cpu !== null && isIdleCpu(cpu);
    }))
      continue;
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
    // Egress billed on a cloud where the workload declares no data source cannot be explained by its reads:
    // it is carried over unchanged unless the workload moves to that very cloud.
    const declaredSources = new Set(sources.map((s) => s.provider));
    const unexplainedEgress = egressResources.filter((r) => r.provider !== home && !declaredSources.has(r.provider));
    const workloadResources = rs.filter((r) => r.kind === "compute.vm" || r.kind === "storage.block" || r.kind === "network.egress");
    const currentCost = sumCost(workloadResources);

    // Batch fleets rarely need to run all day. When the hourly history shows the whole fleet idle for a
    // large part of every week, every placement is priced for the hours the job actually runs.
    const windows = interruptible ? vms.map((v) => usageWindow(v)) : [];
    const window = windows.length && windows.every((w) => w !== null) ? mergeWindows(windows as UsageWindow[]) : null;
    const runShare = window && window.share > 0 && window.share <= 0.7 ? window.share : 1;
    const windowed = runShare < 1;
    const schedule = windowed ? describeSchedule(window!.active) : "";

    const options: Option[] = [];
    for (const p of PROVIDERS) {
      if (sameProviderOnly && p !== home) continue;
      const equivalents = shapes.map(({ r, vm }) => ({ r, vm: p === home ? vm! : cheapestEquivalentVm(p, vm!.vcpu, vm!.memGiB) }));
      if (equivalents.some((e) => !e.vm)) continue;
      const region =
        sources.find((s) => s.provider === p)?.region ?? (p === home ? vms[0].region : DEFAULT_REGION[p]);
      for (const spot of interruptible ? [false, true] : [false]) {
        if (p === home && !spot && !windowed) continue; // that's the status quo
        const comps: Component[] = [
          ...equivalents.map(({ r, vm }, i) => ({
            id: `vm-${p}-${spot}-${i}`,
            kind: "compute.vm" as const,
            provider: p,
            label: `${r.quantity} × ${vm!.sku}${spot ? " Spot" : ""}${equivalents.length > 1 ? ` (${r.name})` : ""}`,
            sku: vm!.sku,
            region,
            usage: { count: r.quantity, spot, hours: HOURS_PER_MONTH * runShare * (spot ? SPOT_OVERHEAD : 1) },
          })),
          { id: `disk-${p}`, kind: "storage.block", provider: p, label: `${serviceName("storage.block", p)} volumes`, region, usage: { gb: blockGb, tier: "standard" } },
          ...(userEgressGb > 0
            ? [{ id: `users-${p}`, kind: "network.egress" as const, provider: p, label: "Internet egress to users (unchanged volume)", region, usage: { gb: userEgressGb, destination: "internet" as const } }]
            : []),
        ];
        let egress = 0;
        for (const r of unexplainedEgress) {
          if (r.provider === p) continue; // co-located with whatever it was talking to
          comps.push({ id: `keep-${r.id}`, kind: "other.fixed", provider: r.provider, label: `${r.name} (unchanged)`, usage: { monthlyCost: r.monthlyCost } });
          egress += r.monthlyCost;
        }
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
        options.push({ provider: p, region, spot, sku: skus, components: comps, monthly: priced.monthlyCost, migrationWeeks: p === home ? (spot ? 1.5 : 0.5) : 6, egressMonthly: egress });
      }
    }
    if (!options.length) continue;
    options.sort((a, b) => a.monthly + (a.migrationWeeks * 4000) / 24 - (b.monthly + (b.migrationWeeks * 4000) / 24));
    const best = options[0];
    const savings = currentCost - best.monthly;
    if (savings / currentCost < 0.25) continue;

    const crossCloud = best.provider !== home;
    const bestSameCloud = options.find((o) => o.provider === home && o.spot);
    const pricing = (spot: boolean) => `${spot ? "Spot" : "on-demand"}${windowed ? ", job window only" : ""}`;
    const target = PROVIDER_LABEL[best.provider];
    const homeEgress = sumCost(egressResources.filter((r) => r.provider !== home));
    const transfer = egressResources.find((r) => r.provider !== home)?.usage?.metrics.egress_gb;

    const alternatives: Alternative[] = [
      { label: `Current — ${PROVIDER_LABEL[home]} on-demand${windowed ? ", 24/7" : ""} (${curSkus})`, provider: home, monthlyCost: round(currentCost), savingsPct: 0, note: homeEgress ? `includes ${money(homeEgress)} cross-cloud egress` : "status quo" },
      ...options.map((o) => ({
        label: `${PROVIDER_LABEL[o.provider]} ${pricing(o.spot)} (${o.sku}, ${o.region})`,
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
      { id: "fleet", label: `${PROVIDER_LABEL[home]} ${serviceName("compute.vm", home)}`, sublabel: `${curSkus} on-demand${windowed ? ", 24/7" : ""}`, icon: "vm", layer: 1, count, provider: home, highlight: crossCloud ? "removed" : "changed" },
      ...sinkNodes(2),
    ];
    const curEdges: DiagramEdge[] = [
      ...sources.map((s, i) => ({ from: `src${i}`, to: "fleet", label: s.provider !== home ? `${round(s.gbPerMonth / 1024)} TB/mo egress` : undefined, dashed: s.provider !== home })),
      ...sinks.map((s, i) => ({ from: "fleet", to: `sink${i}`, label: s.provider !== home ? `${round(s.gbPerMonth / 1024)} TB/mo` : undefined, dashed: s.provider !== home })),
    ];
    const newNodes: DiagramNode[] = [
      ...dataNodes(0),
      { id: "fleet", label: `${target} ${serviceName("compute.vm", best.provider)}`, sublabel: `${best.sku}${best.spot ? " Spot" : ""}${windowed ? ", job window only" : ""}`, icon: "vm", layer: 1, count, provider: best.provider, highlight: crossCloud ? "added" : "changed" },
      ...sinkNodes(2),
    ];
    const newEdges: DiagramEdge[] = [
      ...sources.map((s, i) => ({ from: `src${i}`, to: "fleet", label: s.provider !== best.provider ? `${round(s.gbPerMonth / 1024)} TB/mo egress` : "same region, free", dashed: s.provider !== best.provider })),
      ...sinks.map((s, i) => ({ from: "fleet", to: `sink${i}`, label: s.provider !== best.provider ? `${round(s.gbPerMonth / 1024)} TB/mo egress` : undefined, dashed: s.provider !== best.provider })),
    ];

    const current = specFromResources("Current architecture", home, workloadResources, curNodes, curEdges, [
      `${count} × ${curSkus} on-demand on ${PROVIDER_LABEL[home]}${windowed ? `, running 24/7 but busy ${pct(runShare * 100)} of the week` : ""}`,
      ...sources.map((s) => `Reads ${round(s.gbPerMonth / 1024)} TB/mo from ${s.label} (${PROVIDER_LABEL[s.provider]})`),
      ...sinks.map((s) => `Writes ${round(s.gbPerMonth / 1024)} TB/mo to ${s.label}`),
    ]);
    const proposed = buildArchitecture(`Proposed: ${target} ${pricing(best.spot)}`, best.provider, best.components, newNodes, newEdges, [
      `${count} × ${best.sku}${best.spot ? " Spot" : ""} in ${best.region}`,
      ...(windowed ? [`Started for the job and scaled to zero afterwards: ${schedule}`] : []),
      ...sources.map((s) => (s.provider === best.provider ? `Co-located with ${s.label} — no egress` : `Still reads ${s.label} cross-cloud`)),
      ...(best.spot ? ["Checkpointing + 10% capacity buffer for interruptions"] : []),
    ]);

    const title = crossCloud
      ? `Move ${workload} to ${target} ${best.spot ? "Spot instances" : ""}`.trim()
      : best.spot
        ? `Run ${workload} on ${target} Spot instances`
        : `Run ${workload} only during its batch window`;
    const windowNote = windowed ? ` The fleet is busy only ${pct(runShare * 100)} of the week, so it is started for the job and scaled to zero afterwards.` : "";

    out.push(
      makeDraft({
        fingerprint: `arch.cross_cloud:${workload}`,
        detector: "arch.cross_cloud",
        category: crossCloud ? "cross_cloud" : best.spot ? "architecture" : "scheduling",
        provider: home,
        targetProvider: best.provider,
        accountId: vms[0].accountId,
        title,
        summary:
          (crossCloud
            ? `Running ${workload} on ${target}${best.spot ? " Spot" : ""} is ${pct((savings / currentCost) * 100)} cheaper than your current ${PROVIDER_LABEL[home]} setup${homeEgress - best.egressMonthly > 1 ? `, including ${money(homeEgress - best.egressMonthly)}/mo of cross-cloud egress it eliminates` : ""}.`
            : best.spot
              ? `${workload} is interruption-tolerant — Spot capacity cuts its cost by ${pct((savings / currentCost) * 100)}.`
              : `${workload} runs around the clock but only works part of the week — running it for the job alone cuts its cost by ${pct((savings / currentCost) * 100)}.`) + (crossCloud || best.spot ? windowNote : ""),
        currentMonthlyCost: currentCost,
        projectedMonthlyCost: best.monthly,
        migrationCost: migrationCostFromWeeks(best.migrationWeeks),
        effort: crossCloud ? "medium" : "low",
        risk: crossCloud ? "medium" : "low",
        timeline: crossCloud ? "4–6 weeks" : best.spot ? "1–2 weeks" : "2–3 days",
        confidence: crossCloud ? 0.78 : 0.88,
        resourceIds: workloadResources.map((r) => r.id),
        details: {
          explanation:
            (crossCloud
              ? `${workload} is a portable, interruption-tolerant batch workload running ${count} on-demand ${curSkus} instances on ${PROVIDER_LABEL[home]}. ` +
                `${sources.length ? `Its input data lives in ${sources.map((s) => `${s.label} (${PROVIDER_LABEL[s.provider]})`).join(", ")}, so every run pays cross-cloud egress. ` : ""}` +
                `We priced every placement across AWS, Azure and GCP (compute + storage + egress, with a 10% Spot interruption buffer). ` +
                `${target}${best.spot ? " Spot" : ""} next to the data is the cheapest by ${money(savings)}/month` +
                (bestSameCloud ? `, beating ${PROVIDER_LABEL[home]} Spot in place (${money(bestSameCloud.monthly)}/month) because it also removes the egress.` : ".")
              : best.spot
                ? `${workload} tolerates interruptions. Moving it to Spot capacity with a diversified instance pool saves ${money(savings)}/month.`
                : `${workload} is a batch workload on ${count} on-demand ${curSkus} instances that stay up around the clock. Running them only while the job runs saves ${money(savings)}/month without changing the instances.`) +
            (windowed
              ? ` Over ${Math.round(window!.days)} days of hourly history the fleet was busy only during ${schedule} — ${pct(runShare * 100)} of the week, including a one-hour buffer before and after — and idle in every other hour of every observed week, so every option is priced for those hours.`
              : interruptible && vms.every((v) => v.usage?.metrics.cpu)
                ? " Its hourly history shows no regular idle window, so every option is priced to run around the clock."
                : ""),
          evidence: [
            { label: "Workload type", value: interruptible ? "Batch / interruption-tolerant" : "Service" },
            { label: "Current fleet", value: `${count} × ${curSkus} on-demand${windowed ? ", 24/7" : ""}` },
            ...(windowed
              ? [
                  { label: "Busy window (observed)", value: schedule },
                  { label: "Hours needed per week", value: `${window!.active.filter(Boolean).length} of 168` },
                ]
              : []),
            ...sources.map((s) => ({ label: `Input from ${s.label}`, value: `${round(s.gbPerMonth / 1024, 1)} TB / month` })),
            ...(homeEgress ? [{ label: "Cross-cloud egress today", value: `${money(homeEgress)} / month${transfer ? ` (${pctTrend(transfer.trendPerMonth)})` : ""}` }] : []),
          ],
          benefits: [
            ...(crossCloud ? ["Eliminates cross-cloud egress by co-locating compute with data"] : []),
            ...(best.spot ? [`Spot pricing (~${pct((1 - (resolveVm(best.sku.split(" + ")[0])?.spotFactor ?? 0.3)) * 100)} below on-demand)`] : []),
            ...(windowed ? [`Pays for ${pct(runShare * 100)} of the week instead of 24/7`] : []),
            "Portable container image — no application rewrite",
          ],
          risks: [
            ...(best.spot ? ["Spot interruptions: jobs must checkpoint and be idempotent"] : []),
            ...(windowed ? ["Runs that overrun the observed window keep the fleet up longer — scale on queue depth, not only on the clock"] : []),
            ...(crossCloud ? ["Second cloud to operate: IAM federation, monitoring and on-call runbooks", "Results written back cross-cloud still incur egress"] : []),
          ],
          alternatives,
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(currentCost), proposed: money(best.monthly), change: "better" },
            { metric: "Cross-cloud egress", current: money(homeEgress), proposed: money(best.egressMonthly), change: best.egressMonthly < homeEgress ? "better" : "same" },
            { metric: "Pricing model", current: "On-demand", proposed: best.spot ? "Spot" : "On-demand", change: best.spot ? "better" : "same" },
            ...(windowed ? [{ metric: "Running hours", current: "24/7", proposed: `${pct(runShare * 100)} of the week`, change: "better" as const }] : []),
            { metric: "Operational complexity", current: "Single cloud", proposed: crossCloud ? "Multi-cloud" : "Single cloud", change: crossCloud ? "worse" : "same" },
          ],
          implementation: crossCloud
            ? [
                { phase: "Make jobs portable", weeks: "Weeks 1–2", tasks: ["Containerize job runner", "Add checkpointing to object storage", "Set up workload identity federation for cross-cloud writes"] },
                { phase: `Provision on ${target}`, weeks: "Weeks 2–3", tasks: [`Create ${best.spot ? "Spot " : ""}instance group / Batch queue in ${best.region}`, "Mirror secrets and config"] },
                { phase: "Parallel run", weeks: "Weeks 3–4", tasks: ["Run both pipelines, diff outputs", "Measure interruption rate and runtime"] },
                { phase: "Cutover", weeks: "Weeks 5–6", tasks: [`Switch scheduler to ${target}`, ...(windowed ? ["Start the fleet from the scheduler and scale to zero when the queue is empty"] : []), `Decommission ${PROVIDER_LABEL[home]} fleet`] },
              ]
            : best.spot
              ? [
                  { phase: "Spot fleet", weeks: "Week 1", tasks: ["Diversify instance types", "Add interruption handler + checkpointing"] },
                  { phase: "Cutover", weeks: "Week 2", tasks: ["Shift scheduler to the Spot group", ...(windowed ? ["Start the fleet from the scheduler and scale to zero when the queue is empty"] : [])] },
                ]
              : [{ phase: "Scale to zero", weeks: "Day 1–3", tasks: ["Set the group's minimum size to 0", "Start the fleet from the job scheduler", "Scale in when the queue is empty"] }],
          terraform:
            best.provider === "gcp"
              ? tfGcpSpot({ name: workload, machineType: best.sku.split(" + ")[0], count, region: best.region, spot: best.spot, window: schedule || undefined })
              : best.provider === "aws"
                ? tfAwsSpot({ name: workload, instanceType: best.sku.split(" + ")[0], count, region: best.region, spot: best.spot, window: schedule || undefined })
                : undefined,
          rollout: crossCloud ? { startWeek: 4, fullWeek: 6 } : best.spot ? { startWeek: 1, fullWeek: 2 } : { startWeek: 0, fullWeek: 1 },
          usage: evidence(
            transfer?.days ?? vms[0].usage?.days ?? 0,
            [...(transfer ? ["cross-cloud transfer"] : []), "CPU (hourly)"],
            [
              chartOf(transfer, "egress", "Cross-cloud transfer — GB per day", transfer ? { note: transfer.trendPerMonth > 0.005 ? `Growing ${pctTrend(transfer.trendPerMonth)}: the egress this move removes grows with it` : `Trend: ${pctTrend(transfer.trendPerMonth)}` } : {}),
              chartOf(vms[0].usage?.metrics.cpu, "cpu", `Fleet CPU — daily p95 (${vms[0].name})`),
            ],
            windowed ? { heatmap: { title: `CPU by hour of week — ${vms[0].name}`, values: window!.how.map((v) => round(v, 1)), idle: window!.active.map((a) => !a), schedule } } : {},
          ),
          assumptions: [
            ...(best.spot ? ["Spot price at 30–35% of on-demand with 10% re-run overhead"] : []),
            ...(windowed ? [`Fleet runs ${window!.active.filter(Boolean).length} h/week (observed busy window plus a 1-hour buffer); volumes are kept`] : []),
            "Egress at public internet list rates",
            `Migration: ${best.migrationWeeks} engineer-weeks`,
          ],
        },
      }),
    );
  }
  return out;
};

export const crossCloudArbitrage = arbitrageWith();
