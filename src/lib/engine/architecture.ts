import { HOURS_PER_MONTH, PRICES, resolveVm } from "../pricing/catalog";
import { Component, priceComponents, serviceName } from "../pricing/components";
import { chartOf, cpuSignal, enoughHistory, evidence, MEMORY_AGENT_FIX, memSignal, MIN_HISTORY_DAYS, pctTrend, recordGap, requestSignal } from "./signals";
import {
  tfAksSpot,
  tfAuroraServerless,
  tfAzureSqlServerless,
  tfContainerApps,
  tfServerless,
  tfStaticSite,
  tfVpcEndpoints,
} from "./terraform";
import type { DiagramEdge, DiagramNode, Detector, Estate, RecommendationDraft, ResourceRow } from "./types";
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
  weightedAvg,
} from "./util";

const workloadGroups = (rs: ResourceRow[]) =>
  groupBy(
    rs.filter((r) => r.workload),
    (r) => `${r.accountId}|${r.workload}`,
  );

/** Carried-over resources, represented as fixed-cost components in the proposal. */
const carried = (rs: ResourceRow[]): Component[] =>
  rs.map((r) => ({
    id: `keep-${r.id}`,
    kind: "other.fixed",
    provider: r.provider,
    label: `${r.name} (unchanged)`,
    usage: { monthlyCost: r.monthlyCost },
  }));

const carriedNodes = (rs: ResourceRow[], layer: number): DiagramNode[] =>
  rs
    .filter((r) => r.kind.startsWith("db.") || r.kind === "storage.object" || r.kind === "cache.managed")
    .map((r) => ({
      id: `n-${r.id}`,
      label: r.service,
      sublabel: r.name,
      icon: r.kind.startsWith("db.") ? "db" : r.kind === "cache.managed" ? "cache" : "storage",
      layer,
      provider: r.provider,
    }));

/**
 * Billed capacity for autoscaling/serverless services, derived from the observed
 * utilisation profile — hour-of-week (168 values) when history exists, else a
 * 24h profile, else the flat average — not from provisioned capacity.
 */
export function billedCapacity(maxUnits: number, profileHours: number[] | undefined, avgPct: number, minUnits: number, headroom = 1.25) {
  const profile = profileHours && profileHours.length >= 24 ? profileHours : Array(24).fill(avgPct);
  const perHour = profile.map((h) => Math.max(minUnits, Math.min(maxUnits, (maxUnits * h * headroom) / 100)));
  return perHour.reduce((a, b) => a + b, 0) / perHour.length;
}

/* ------------------------------------------------------------------------- */
/* 1. Always-on VM fleet behind a load balancer → API Gateway + FaaS + queue   */
/* ------------------------------------------------------------------------- */
export const serverlessModernizationWith = ({ minFit = 60 } = {}): Detector => (estate) => {
  const out: RecommendationDraft[] = [];
  for (const [key, rs] of workloadGroups(estate.resources)) {
    const vms = rs.filter((r) => r.kind === "compute.vm" && r.state === "running");
    const lb = rs.find((r) => r.kind === "network.load_balancer");
    if (!lb || countOf(vms) < 3) continue;
    if (vms.some((v) => v.config.staticContent || v.config.role === "k8s-node")) continue;
    if (!vms.every((v) => v.config.stateless)) continue;
    const traffic = requestSignal(lb);
    if (!traffic || traffic.monthlyM <= 0) continue;
    const reqM = round(traffic.monthlyM, 1);

    const provider = vms[0].provider;
    const dur = lb.metrics.avgDurationMs ?? 150;
    const duty = weightedAvg(vms, (v) => v.metrics.dutyCycle);
    const cpuAvg = weightedAvg(vms, (v) => v.metrics.cpuAvg);
    const peak = traffic.peakToAvg;
    const asyncShare = vms[0].config.asyncShare ?? 0.25;
    const memoryMb = vms[0].config.memoryMb ?? 1024;

    let fit = 10; // stateless
    fit += cpuAvg < 15 ? 25 : cpuAvg < 30 ? 15 : 0;
    fit += duty < 0.4 ? 25 : duty < 0.6 ? 15 : 5;
    fit += peak >= 4 ? 20 : peak >= 2 ? 12 : 0;
    fit += dur <= 1000 ? 20 : dur <= 5000 ? 10 : 0;
    if (fit < minFit) continue;
    if (!enoughHistory(traffic)) {
      recordGap(estate, lb, "arch.serverless", "short_history", `Only ${Math.round(traffic.days)} days of request history; ${MIN_HISTORY_DAYS} are needed to price a per-request architecture.`);
      continue;
    }

    const replacedIds = new Set([...vms.map((v) => v.id), lb.id]);
    for (const r of rs) if (r.kind === "storage.block") replacedIds.add(r.id);
    const replaced = rs.filter((r) => replacedIds.has(r.id));
    const keep = rs.filter((r) => !replacedIds.has(r.id));
    const workload = vms[0].workload!;
    const vmCount = countOf(vms);
    const sku = vms[0].sku ?? "vm";
    const region = vms[0].region;

    const fn = serviceName("compute.function", provider);
    const api = serviceName("network.api_gateway", provider);
    const q = serviceName("messaging.queue", provider);

    const currentNodes: DiagramNode[] = [
      { id: "users", label: "Users", icon: "users", layer: 0 },
      { id: "lb", label: serviceName("network.load_balancer", provider), icon: "lb", layer: 1, provider },
      { id: "vm", label: serviceName("compute.vm", provider), sublabel: sku, icon: "vm", layer: 2, count: vmCount, provider, highlight: "removed" },
      ...carriedNodes(keep, 3),
    ];
    const currentEdges: DiagramEdge[] = [
      { from: "users", to: "lb" },
      { from: "lb", to: "vm" },
      ...carriedNodes(keep, 3).map((n) => ({ from: "vm", to: n.id })),
    ];

    // Per-request stack as a function of traffic, so it can be priced today AND at the forecast volume.
    const stack = (m: number): Component[] => [
      { id: "api", kind: "network.api_gateway", provider, label: `${api} (HTTP)`, region, usage: { requestsM: m, tier: "http" } },
      { id: "fn-api", kind: "compute.function", provider, label: `${fn} — API handlers`, region, usage: { requestsM: round(m * (1 - asyncShare)), avgDurationMs: dur, memoryMb } },
      { id: "queue", kind: "messaging.queue", provider, label: `${q} — async jobs`, region, usage: { requestsM: round(m * asyncShare * 3) } },
      { id: "fn-worker", kind: "compute.function", provider, label: `${fn} — queue workers`, region, usage: { requestsM: round((m * asyncShare) / 10), avgDurationMs: Math.min(dur * 6, 60000), memoryMb: 1024 } },
    ];
    const proposedComponents: Component[] = [...stack(reqM), ...carried(keep)];
    const proposedNodes: DiagramNode[] = [
      { id: "users", label: "Users", icon: "users", layer: 0 },
      { id: "api", label: api, icon: "api", layer: 1, provider, highlight: "added" },
      { id: "fn", label: fn, sublabel: "API handlers", icon: "function", layer: 2, provider, highlight: "added" },
      { id: "q", label: q, sublabel: "async jobs", icon: "queue", layer: 2, provider, highlight: "added" },
      ...carriedNodes(keep, 3),
      { id: "worker", label: fn, sublabel: "workers", icon: "function", layer: 3, provider, highlight: "added" },
    ];
    const proposedEdges: DiagramEdge[] = [
      { from: "users", to: "api" },
      { from: "api", to: "fn" },
      { from: "fn", to: "q" },
      { from: "q", to: "worker" },
      ...carriedNodes(keep, 3).map((n) => ({ from: "fn", to: n.id })),
    ];

    const current = specFromResources("Current architecture", provider, rs, currentNodes, currentEdges, [
      `${vmCount} × ${serviceName("compute.vm", provider)} instances (${sku}), always on`,
      `1 × ${serviceName("network.load_balancer", provider)}`,
      `${replaced.filter((r) => r.kind === "storage.block").length ? "Attached block volumes" : "Instance-local state"}`,
      `Auto Scaling sized for peak (${peak.toFixed(1)}× average)`,
    ]);
    const proposed = buildArchitecture(`Proposed: ${api} + ${fn} + ${q}`, provider, proposedComponents, proposedNodes, proposedEdges, [
      `${api} (HTTP API)`,
      `${fn} functions (arm64, ${memoryMb} MB)`,
      `${q} for async processing (${pct(asyncShare * 100)} of requests)`,
      "No load balancer or servers to manage",
    ]);

    // Serverless cost scales with traffic while the fleet's cost is fixed: check it still wins at the forecast volume.
    const carriedCost = sumCost(keep);
    const perMillion = (proposed.monthlyCost - carriedCost) / reqM;
    const breakEvenM = perMillion > 0 ? (current.monthlyCost - carriedCost) / perMillion : Infinity;
    const forecastM = round(traffic.forecastM, 1);
    const forecastCost = priceComponents(stack(forecastM)).total + carriedCost;
    const growth = Math.max(-0.2, Math.min(0.25, traffic.trendPerMonth));
    const monthsToBreakEven = growth > 0.002 && breakEvenM > reqM ? Math.log(breakEvenM / reqM) / Math.log(1 + growth) : Infinity;
    if (proposed.monthlyCost >= current.monthlyCost * 0.9) continue; // not materially cheaper even at today's traffic
    if (forecastCost >= current.monthlyCost * 0.9) {
      recordGap(
        estate,
        lb,
        "arch.serverless",
        "growing",
        `Per-request pricing is cheaper today (${money(proposed.monthlyCost)} vs ${money(current.monthlyCost)}), but traffic is growing ${pctTrend(traffic.trendPerMonth)}: at about ${Math.round(forecastM)}M requests/month in 6 months it would cost ${money(forecastCost)} — no longer a saving.`,
      );
      continue;
    }

    const weeks = 8;
    const fleetUsage = vms[0].usage?.metrics;
    out.push(
      makeDraft({
        fingerprint: `arch.serverless:${key}`,
        detector: "arch.serverless",
        category: "architecture",
        provider,
        accountId: vms[0].accountId,
        title: `Replace ${serviceName("compute.vm", provider)} + ${serviceName("network.load_balancer", provider)} with ${api} + ${fn} + ${q}`,
        summary: `${workload} runs ${vmCount} always-on ${sku} instances behind a load balancer at ${pct(cpuAvg)} average CPU. Its bursty, short-lived request profile fits a serverless architecture.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(weeks),
        effort: "medium",
        risk: "low",
        timeline: "2–4 weeks",
        confidence: round(Math.min(0.95, fit / 100), 2),
        resourceIds: replaced.map((r) => r.id),
        details: {
          fitScore: fit,
          explanation:
            `Your ${workload} service uses ${vmCount} always-on ${serviceName("compute.vm", provider)} instances behind a load balancer. ` +
            `Traffic is ${Math.round(reqM)}M requests/month with a ${dur} ms average duration, but CPU averages only ${pct(cpuAvg)} and the fleet is busy ${pct(duty * 100)} of hours. ` +
            `You are paying for peak capacity 24/7. Moving the request path to ${api} + ${fn} and background work to ${q} bills per request, scales to zero overnight and removes host management. ` +
            (traffic.source === "history"
              ? `Traffic is trending ${pctTrend(traffic.trendPerMonth)}: at about ${Math.round(forecastM)}M requests/month in 6 months the new architecture costs ${money(forecastCost)}, still below today's ${money(current.monthlyCost)}. ` +
                `It stays cheaper up to about ${Math.round(breakEvenM).toLocaleString()}M requests/month${Number.isFinite(monthsToBreakEven) ? ` (roughly ${Math.round(monthsToBreakEven)} months away at this growth)` : ""}.`
              : `Only a monthly request total is available (no history), so the traffic trend is unknown; it stays cheaper up to about ${Math.round(breakEvenM).toLocaleString()}M requests/month.`),
          evidence: [
            { label: "Average CPU", value: pct(cpuAvg) },
            { label: "Busy hours", value: pct(duty * 100) },
            { label: "Peak-to-average traffic", value: `${peak.toFixed(1)}×` },
            { label: "Requests / month", value: `${Math.round(reqM)}M${traffic.source === "history" ? ` (${pctTrend(traffic.trendPerMonth)})` : ""}` },
            ...(traffic.source === "history" ? [{ label: "Requests in 6 months", value: `${Math.round(forecastM)}M → ${money(forecastCost)}/mo` }] : []),
            { label: "Break-even volume", value: `${Math.round(breakEvenM).toLocaleString()}M requests/month` },
            { label: "Average request duration", value: `${dur} ms` },
            { label: "Serverless fit score", value: `${fit}/100` },
          ],
          benefits: [`${pct(((current.monthlyCost - proposed.monthlyCost) / current.monthlyCost) * 100)} lower cost at current traffic`, "Scales per request — no over-provisioning for peaks", "No servers, AMIs or OS patching", "Pay only for actual usage; idle nights cost ~$0"],
          risks: [
            "Cold starts add ~100–300 ms to p99 latency (mitigate with provisioned concurrency on hot paths)",
            `${api} caps synchronous requests at 29 s — long calls must move to the queue`,
            "Connection pooling to databases needs a proxy (e.g. RDS Proxy)",
          ],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Infrastructure management", current: "High", proposed: "Low", change: "better" },
            { metric: "Scalability", current: "Medium", proposed: "High", change: "better" },
            { metric: "Security", current: "Standard", proposed: "Enhanced", change: "better", note: "No OS surface, per-function IAM" },
            { metric: "p99 latency", current: "Stable", proposed: "+100–300 ms cold start", change: "worse" },
            { metric: "Migration effort", current: "—", proposed: "Medium", change: "neutral" },
          ],
          implementation: [
            { phase: "Strangler set-up", weeks: "Week 1", tasks: [`Put ${api} in front of the existing load balancer (HTTP proxy integration)`, "Add request tracing + per-route cost tags"] },
            { phase: "Port request handlers", weeks: "Weeks 2–3", tasks: [`Package stateless handlers as ${fn} functions (arm64)`, "Route 10% → 50% → 100% of traffic per path with canaries", "Add DB connection proxy"] },
            { phase: "Decouple background work", weeks: "Week 3", tasks: [`Move ${pct(asyncShare * 100)} async work to ${q} + worker functions with DLQ`] },
            { phase: "Decommission", weeks: "Week 4", tasks: ["Scale Auto Scaling group to 0, then delete ALB, launch template and volumes"] },
          ],
          terraform: provider === "aws" ? tfServerless({ name: workload, region, memoryMb, asyncShare }) : undefined,
          rollout: { startWeek: 2, fullWeek: 4 },
          assumptions: [`${Math.round(reqM)}M requests/month at ${dur} ms, ${memoryMb} MB`, `${pct(asyncShare * 100)} of requests trigger async work`, "Egress, logging and data stores unchanged"],
          usage: evidence(traffic.days, ["requests", "CPU"], [
            chartOf(traffic.profile, "requests", "Requests per day", { note: `Break-even at ${Math.round(breakEvenM).toLocaleString()}M requests/month` }),
            chartOf(fleetUsage?.cpu, "cpu", `Fleet CPU — daily p95 (${vms[0].name})`),
          ]),
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* 2. Static site on VMs → object storage + CDN                              */
/* ------------------------------------------------------------------------- */
export const staticSiteToCdn: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const [key, rs] of workloadGroups(estate.resources)) {
    const vms = rs.filter((r) => r.kind === "compute.vm" && r.config.staticContent);
    if (!vms.length) continue;
    const provider = vms[0].provider;
    const lb = rs.find((r) => r.kind === "network.load_balancer");
    const egress = rs.filter((r) => r.kind === "network.egress");
    const block = rs.filter((r) => r.kind === "storage.block");
    const replaced = [...vms, ...(lb ? [lb] : []), ...egress, ...block];
    const gbOut = egress.reduce((s, e) => s + (e.metrics.gbEgress ?? 0), 0);
    const requestsMeasured = lb?.metrics.requestsPerMonthM !== undefined;
    const reqM = lb?.metrics.requestsPerMonthM ?? 20;
    const sizeKnown = vms[0].config.sizeGb !== undefined;
    const siteGb = vms[0].config.sizeGb ?? 25;
    const delivery = egress[0]?.usage?.metrics.egress_gb;
    const hits = lb?.usage?.metrics.requests;
    const region = vms[0].region;
    const cdn = serviceName("network.cdn", provider);
    const obj = serviceName("storage.object", provider);

    const current = specFromResources("Current architecture", provider, replaced,
      [
        { id: "users", label: "Visitors", icon: "users", layer: 0 },
        ...(lb ? [{ id: "lb", label: serviceName("network.load_balancer", provider), icon: "lb" as const, layer: 1, provider }] : []),
        { id: "vm", label: "Web servers", sublabel: vms[0].sku ?? "", icon: "vm", layer: 2, count: countOf(vms), provider, highlight: "removed" },
      ],
      [{ from: "users", to: lb ? "lb" : "vm" }, ...(lb ? [{ from: "lb", to: "vm" }] : [])],
      [`${countOf(vms)} × web servers serving static files`, "Load balancer + internet egress from instances"],
    );
    const proposed = buildArchitecture(`Proposed: ${obj} + ${cdn}`, provider,
      [
        { id: "obj", kind: "storage.object", provider, label: `${obj} bucket`, region, usage: { gb: siteGb, tier: "hot" } },
        { id: "cdn", kind: "network.cdn", provider, label: cdn, usage: { gb: gbOut, requestsM: reqM } },
      ],
      [
        { id: "users", label: "Visitors", icon: "users", layer: 0 },
        { id: "cdn", label: cdn, icon: "cdn", layer: 1, provider, highlight: "added" },
        { id: "obj", label: obj, sublabel: "static assets", icon: "storage", layer: 2, provider, highlight: "added" },
      ],
      [{ from: "users", to: "cdn" }, { from: "cdn", to: "obj" }],
      [`${cdn} edge caching`, `${obj} origin with Origin Access Control`, "CI deploys with a sync + cache invalidation"],
    );
    out.push(
      makeDraft({
        fingerprint: `arch.static_site:${key}`,
        detector: "arch.static_site",
        category: "architecture",
        provider,
        accountId: vms[0].accountId,
        title: `Serve ${vms[0].workload} from ${obj} + ${cdn} instead of web servers`,
        summary: `${countOf(vms)} VMs serve static content. Object storage behind a CDN removes servers entirely and improves global latency.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(1.5),
        effort: "low",
        risk: "low",
        timeline: "1–2 weeks",
        confidence: 0.9,
        resourceIds: replaced.map((r) => r.id),
        details: {
          explanation: `The ${vms[0].workload} workload serves pre-rendered static files from ${countOf(vms)} always-on ${vms[0].sku} instances. Static sites don't need compute: hosting them in ${obj} behind ${cdn} costs a fraction, has no servers to patch and serves visitors from edge locations.`,
          evidence: [
            { label: "Content type", value: "Static (HTML/CSS/JS/images)" },
            { label: "Site size", value: sizeKnown ? `${siteGb} GB` : `not measured (${siteGb} GB assumed)` },
            { label: "Monthly delivery", value: `${round(gbOut / 1024, 1)} TB${delivery ? ` (${pctTrend(delivery.trendPerMonth)})` : ""}` },
            { label: "Requests / month", value: requestsMeasured ? `${Math.round(reqM)}M${hits ? ` (${pctTrend(hits.trendPerMonth)})` : ""}` : `not measured (${reqM}M assumed)` },
            { label: "Average CPU", value: pct(weightedAvg(vms, (v) => v.metrics.cpuAvg)) },
          ],
          benefits: ["No servers to run or patch", "Lower latency via edge caching", "Built-in DDoS protection at the edge"],
          risks: ["Server-side redirects/rewrites must move to edge functions", "Form handlers need a small serverless endpoint"],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Global latency", current: "Single region", proposed: "Edge cached", change: "better" },
            { metric: "Operations", current: "Patch & scale VMs", proposed: "None", change: "better" },
          ],
          implementation: [
            { phase: "Publish to bucket", weeks: "Week 1", tasks: ["Create bucket + CDN with OAC", "Add CI step: build → sync → invalidate"] },
            { phase: "Cutover", weeks: "Week 2", tasks: ["Switch DNS to the CDN", "Decommission web servers and LB"] },
          ],
          terraform: provider === "aws" ? tfStaticSite({ name: vms[0].workload!, region }) : undefined,
          rollout: { startWeek: 1, fullWeek: 2 },
          assumptions: [
            "CDN and origin priced at the delivery volume of the last 30 days; both scale with traffic, as the current egress does",
            ...(requestsMeasured ? [] : [`Request volume is not measured: ${reqM}M requests/month assumed`]),
            ...(sizeKnown ? [] : [`Site size is not measured: ${siteGb} GB assumed`]),
          ],
          usage: evidence(delivery?.days ?? hits?.days ?? 0, [...(delivery ? ["data delivered"] : []), ...(hits ? ["requests"] : [])], [chartOf(delivery, "egress", "Data delivered — GB per day"), chartOf(hits, "requests", "Requests per day")]),
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* 3. NAT gateway carrying object-storage traffic → gateway endpoints         */
/* ------------------------------------------------------------------------- */
/** NAT volume (GB/month) and the share of it that goes to object storage, from measured bytes when available. */
function natTraffic(estate: Estate, nat: ResourceRow): { gb: number; share: number; measured: boolean } | null {
  const m = nat.usage?.metrics;
  const gb = m?.nat_bytes ? m.nat_bytes.monthlyTotal / 1e9 : (nat.metrics.gbProcessed ?? 0);
  if (gb <= 1000) return null;
  const measuredShare = m?.nat_bytes && m.nat_storage_bytes && m.nat_bytes.monthlyTotal > 0 ? m.nat_storage_bytes.monthlyTotal / m.nat_bytes.monthlyTotal : undefined;
  const share = measuredShare ?? nat.config.s3TrafficShare;
  if (share === undefined) {
    recordGap(estate, nat, "arch.nat_endpoints", "missing_metric", `${round(gb / 1024)} TB/month flows through this NAT gateway, but there is no breakdown by destination, so the share going to object storage is unknown.`, "Enable VPC Flow Logs to see where NAT traffic goes");
    return null;
  }
  return share >= 0.3 ? { gb, share, measured: measuredShare !== undefined } : null;
}

export const natToEndpoints: Detector = (estate) =>
  estate.resources
    .filter((r) => r.kind === "network.nat_gateway")
    .map((nat) => ({ nat, t: natTraffic(estate, nat) }))
    .filter((x) => x.t !== null)
    .map(({ nat, t }) => {
      const p = nat.provider;
      const gb = t!.gb;
      const share = t!.share;
      const natBytes = nat.usage?.metrics.nat_bytes;
      const endpointName = p === "aws" ? "VPC Gateway Endpoints" : p === "azure" ? "Service Endpoints" : "Private Google Access";
      const objName = serviceName("storage.object", p);
      const current = specFromResources("Current architecture", p, [nat],
        [
          { id: "app", label: "Private subnets", icon: "vm", layer: 0, provider: p },
          { id: "nat", label: serviceName("network.nat_gateway", p), sublabel: `${round(gb / 1024)} TB/mo`, icon: "nat", layer: 1, provider: p, highlight: "changed", count: nat.quantity },
          { id: "s3", label: objName, icon: "storage", layer: 2, provider: p },
          { id: "net", label: "Internet", icon: "internet", layer: 2 },
        ],
        [{ from: "app", to: "nat" }, { from: "nat", to: "s3", label: pct(share * 100) }, { from: "nat", to: "net" }],
        [`${nat.quantity} NAT gateways`, `${pct(share * 100)} of processed bytes go to ${objName}/DynamoDB`],
      );
      const proposed = buildArchitecture(`Proposed: ${endpointName}`, p,
        [
          { id: "nat", kind: "network.nat_gateway", provider: p, label: serviceName("network.nat_gateway", p), usage: { count: nat.quantity, gb: gb * (1 - share) } },
          { id: "gw", kind: "network.vpc_endpoint", provider: p, label: `${endpointName} (${objName}, DynamoDB)`, usage: { tier: "gateway" } },
        ],
        [
          { id: "app", label: "Private subnets", icon: "vm", layer: 0, provider: p },
          { id: "gw", label: endpointName, icon: "endpoint", layer: 1, provider: p, highlight: "added" },
          { id: "nat", label: serviceName("network.nat_gateway", p), sublabel: `${round((gb * (1 - share)) / 1024)} TB/mo`, icon: "nat", layer: 1, provider: p, count: nat.quantity },
          { id: "s3", label: objName, icon: "storage", layer: 2, provider: p },
          { id: "net", label: "Internet", icon: "internet", layer: 2 },
        ],
        [{ from: "app", to: "gw" }, { from: "gw", to: "s3" }, { from: "app", to: "nat" }, { from: "nat", to: "net" }],
        ["Object storage traffic bypasses NAT (no per-GB charge)", "NAT only carries true internet egress"],
      );
      return makeDraft({
        fingerprint: `arch.nat_endpoints:${nat.id}`,
        detector: "arch.nat_endpoints",
        category: "architecture",
        provider: p,
        accountId: nat.accountId,
        title: `Route ${objName} traffic through ${endpointName} instead of NAT`,
        summary: `${pct(share * 100)} of the ${round(gb / 1024)} TB/month processed by NAT goes to ${objName}. ${endpointName} carry it for free.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(0.5),
        effort: "low",
        risk: "low",
        timeline: "1–3 days",
        confidence: t!.measured ? 0.93 : 0.75,
        resourceIds: [nat.id],
        details: {
          explanation:
            `NAT gateways charge per GB processed. ${t!.measured ? `Over the last 30 days, ${pct(share * 100)} of the bytes through ${nat.name} went` : `An estimated ${pct(share * 100)} of the bytes through ${nat.name} go (a supplied figure, not measured here)`} to ${objName}/DynamoDB in the same region. Gateway endpoints route that traffic privately at no charge, with a route-table change and no application changes.` +
            (natBytes && Math.abs(natBytes.trendPerMonth) >= 0.005 ? ` NAT volume is trending ${pctTrend(natBytes.trendPerMonth)}, so the saving moves with it.` : ""),
          evidence: [
            { label: "NAT data processed", value: `${round(gb / 1024, 1)} TB / month${natBytes ? ` (${pctTrend(natBytes.trendPerMonth)})` : ""}` },
            { label: "Share to object storage", value: `${pct(share * 100)}${t!.measured ? " (measured, 30 days)" : " (supplied, not measured)"}` },
            { label: "Per-GB processing fee", value: `$${PRICES.natGateway[p].perGb}/GB` },
          ],
          benefits: ["Removes per-GB NAT charge for storage traffic", "Traffic stays on the provider backbone", "Enables bucket policies restricted to your VPC"],
          risks: ["Bucket policies using source IP conditions must switch to aws:SourceVpce"],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Security posture", current: "Public path via NAT", proposed: "Private endpoint", change: "better" },
            { metric: "Application changes", current: "—", proposed: "None", change: "same" },
          ],
          implementation: [{ phase: "Add endpoints", weeks: "Day 1–3", tasks: ["Create gateway endpoints for S3 and DynamoDB", "Attach to private route tables", "Verify with VPC Flow Logs"] }],
          terraform: p === "aws" ? tfVpcEndpoints({ vpcId: nat.config.role ?? "vpc-0abc123", region: nat.region }) : undefined,
          rollout: { startWeek: 0, fullWeek: 1 },
          usage: evidence(natBytes?.days ?? 0, ["NAT bytes", "bytes to storage"], [
            chartOf(natBytes, "nat", "NAT data processed — GB per day"),
            chartOf(nat.usage?.metrics.nat_storage_bytes, "nat-storage", `To ${objName} — GB per day`),
          ]),
        },
      });
    });

/* ------------------------------------------------------------------------- */
/* 4. Provisioned relational DB with spiky/low load → serverless DB           */
/* ------------------------------------------------------------------------- */
export const databaseServerless: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const db of estate.resources.filter((r) => (r.kind === "db.instance" || r.kind === "db.vcore") && r.environment === "prod")) {
    const cpu = cpuSignal(db);
    if (!cpu) continue;
    const cpuAvg = cpu.avg;
    const peak = cpu.profile?.peakToAvg ?? db.metrics.peakToAvg ?? 1;
    if (cpuAvg > 25 || peak < 2.5) continue;
    if (!enoughHistory(cpu)) {
      recordGap(estate, db, "arch.db_serverless", "short_history", `Only ${Math.round(cpu.days)} days of load history; ${MIN_HISTORY_DAYS} are needed to size serverless capacity.`);
      continue;
    }
    // Size for the load expected in 90 days, from the hour-of-week curve when history exists.
    const growth = 1 + Math.max(0, cpu.trendPerMonth) * 3;
    const loadProfile = (cpu.profile?.howAvg ?? db.metrics.hourly)?.map((h) => h * growth);
    const p = db.provider;
    const storageGb = db.config.sizeGb ?? 200;
    let maxUnits: number;
    let minUnits: number;
    let units: number;
    let components: Component[];
    let tf: string | undefined;
    if (p === "aws") {
      const vm = resolveVm(db.sku?.replace(/^db\./, ""));
      maxUnits = Math.max(2, Math.round((vm?.memGiB ?? 32) / 2));
      minUnits = 0.5;
      units = round(billedCapacity(maxUnits, loadProfile, cpuAvg * growth, minUnits), 1);
      components = [
        { id: "writer", kind: "db.serverless", provider: p, label: "Aurora Serverless v2 — writer", region: db.region, usage: { capacityUnits: units, storageGb } },
        ...(db.config.multiAz ? [{ id: "reader", kind: "db.serverless" as const, provider: p, label: "Aurora Serverless v2 — reader (HA)", region: db.region, usage: { capacityUnits: units, storageGb: 0 } }] : []),
      ];
      tf = tfAuroraServerless({ name: db.name, minAcu: minUnits, maxAcu: maxUnits });
    } else if (p === "azure") {
      maxUnits = db.config.vcores ?? 8;
      minUnits = Math.max(0.5, maxUnits / 8);
      units = round(billedCapacity(maxUnits, loadProfile, cpuAvg * growth, minUnits), 1);
      components = [{ id: "db", kind: "db.serverless", provider: p, label: "Azure SQL Database — Serverless", region: db.region, usage: { capacityUnits: units, storageGb } }];
      tf = tfAzureSqlServerless({ name: db.name, maxVcores: maxUnits, minVcores: minUnits });
    } else continue;

    const dbName = serviceName("db.serverless", p);
    const current = specFromResources("Current architecture", p, [db],
      [
        { id: "app", label: "Application", icon: "app", layer: 0 },
        { id: "db", label: db.service, sublabel: db.sku ?? `${db.config.vcores} vCores`, icon: "db", layer: 1, provider: p, highlight: "changed", count: db.config.multiAz ? 2 : undefined },
      ],
      [{ from: "app", to: "db" }],
      [`${db.service} ${db.sku ?? `${db.config.vcores} vCores`}${db.config.multiAz ? " Multi-AZ" : ""}`, `Provisioned for peak (${peak.toFixed(1)}× average)`],
    );
    const proposed = buildArchitecture(`Proposed: ${dbName}`, p, components,
      [
        { id: "app", label: "Application", icon: "app", layer: 0 },
        { id: "db", label: dbName, sublabel: `${minUnits}–${maxUnits} ${PRICES.dbServerless[p].unit}`, icon: "db", layer: 1, provider: p, highlight: "added", count: db.config.multiAz ? 2 : undefined },
      ],
      [{ from: "app", to: "db" }],
      [`Scales ${minUnits}–${maxUnits} ${PRICES.dbServerless[p].unit} in seconds`, `Average billed capacity ≈ ${units} ${PRICES.dbServerless[p].unit}`, "Same engine, same endpoint semantics"],
    );
    out.push(
      makeDraft({
        fingerprint: `arch.db_serverless:${db.id}`,
        detector: "arch.db_serverless",
        category: "architecture",
        provider: p,
        accountId: db.accountId,
        title: `Move ${db.name} to ${dbName}`,
        summary: `${db.name} averages ${pct(cpuAvg)} CPU with ${peak.toFixed(1)}× peaks. Serverless capacity tracks the daily load curve instead of paying for peak all month.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(3),
        effort: "medium",
        risk: "medium",
        timeline: "2–3 weeks",
        confidence: 0.82,
        resourceIds: [db.id],
        details: {
          explanation:
            `${db.name} is provisioned for its peak but sits at ${pct(cpuAvg)} average CPU. ` +
            (cpu.profile?.howAvg
              ? `Replaying its measured hour-of-week load curve (${Math.round(cpu.days)} days of history${growth > 1.005 ? `, scaled for ${pctTrend(cpu.trendPerMonth)} growth over 90 days` : ""}), `
              : `Using its daily load profile, `) +
            `${dbName} would bill an average of ${units} ${PRICES.dbServerless[p].unit} (min ${minUnits}, max ${maxUnits}), tracking demand hour by hour.`,
          evidence: [
            { label: "History", value: cpu.source === "history" ? `${Math.round(cpu.days)} days, hourly` : "Summary metrics only" },
            { label: "Average CPU", value: pct(cpuAvg) },
            { label: "Peak-to-average", value: `${peak.toFixed(1)}×` },
            { label: "Load trend", value: pctTrend(cpu.trendPerMonth) },
            { label: "Modelled billed capacity", value: `${units} ${PRICES.dbServerless[p].unit} avg` },
          ],
          benefits: ["Capacity follows load hour by hour", "No resize maintenance windows", "Same engine and drivers"],
          risks: ["Scale-up takes seconds; sudden 10× spikes may queue briefly", "Requires engine/version compatible with serverless tier"],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Elasticity", current: "Manual resize", proposed: "Automatic", change: "better" },
            { metric: "Peak headroom", current: "Fixed", proposed: `Up to ${maxUnits} ${PRICES.dbServerless[p].unit}`, change: "same" },
          ],
          implementation: [
            { phase: "Replica & test", weeks: "Week 1", tasks: ["Create serverless replica / clone", "Replay production load in staging"] },
            { phase: "Switchover", weeks: "Week 2–3", tasks: ["Promote during low-traffic window", "Monitor capacity & latency for a week"] },
          ],
          terraform: tf,
          rollout: { startWeek: 2, fullWeek: 3 },
          usage: evidence(cpu.days, ["CPU (hourly)"], [chartOf(db.usage?.metrics.cpu_max ?? db.usage?.metrics.cpu, "cpu", "CPU — daily peak")], cpu.profile?.howAvg ? { heatmap: { title: "Load by hour of week", values: cpu.profile.howAvg.map((v) => round(v, 1)) } } : {}),
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* 5. Under-used PaaS app plans → consumption containers                       */
/* ------------------------------------------------------------------------- */
export const appPlanToContainers: Detector = (estate) =>
  estate.resources
    .filter((r) => r.kind === "app.plan" && (r.metrics.cpuAvg ?? 100) < 25)
    .map((plan) => {
      const p = plan.provider;
      const vcpuPerInstance = plan.sku === "P3v3" ? 8 : plan.sku === "P2v3" ? 4 : 2;
      const planCpu = cpuSignal(plan);
      // Replicas follow the hour-of-week load curve, scaled to the load expected in 90 days.
      const planGrowth = 1 + Math.max(0, planCpu?.trendPerMonth ?? 0) * 3;
      const vcpus = plan.quantity * vcpuPerInstance;
      const cpuAvg = planCpu?.avg ?? plan.metrics.cpuAvg ?? 10;
      const usedVcpu = ((vcpus * cpuAvg) / 100) * planGrowth;
      const minReplicas = 2;
      const replicasFor = (cpuPct: number) => Math.max(minReplicas, (((vcpus * cpuPct) / 100) * 1.3) / 0.5);
      const how = planCpu?.profile?.howAvg;
      const avgReplicas = how ? how.reduce((a, h) => a + replicasFor(h * planGrowth), 0) / how.length : replicasFor(cpuAvg * planGrowth);
      const peakReplicas = Math.ceil(replicasFor(planCpu?.forecastPeak ?? cpuAvg * 2));
      const maxReplicas = Math.max(10, Math.ceil(peakReplicas * 1.5));
      const replicaHours = avgReplicas * HOURS_PER_MONTH;
      // Requests are a small part of the bill; when they are not measured a nominal volume is priced and flagged.
      const requestsMeasured = plan.metrics.requestsPerMonthM !== undefined;
      const reqM = plan.metrics.requestsPerMonthM ?? 30;
      const ca = serviceName("compute.container", p);
      const current = specFromResources("Current architecture", p, [plan],
        [
          { id: "users", label: "Users", icon: "users", layer: 0 },
          { id: "plan", label: "App Service Plan", sublabel: `${plan.sku}`, icon: "app", layer: 1, count: plan.quantity, provider: p, highlight: "removed" },
        ],
        [{ from: "users", to: "plan" }],
        [`${plan.quantity} × ${plan.sku} instances, always on`, `${pct(plan.metrics.cpuAvg ?? 0)} average CPU`],
      );
      const proposed = buildArchitecture(`Proposed: ${ca} (consumption)`, p,
        [{ id: "ca", kind: "compute.container", provider: p, label: `${ca} — 0.5 vCPU / 1 GiB replicas`, region: plan.region, usage: { count: 1, activeHours: round(replicaHours), vcpu: 0.5, memGb: 1, requestsM: reqM } }],
        [
          { id: "users", label: "Users", icon: "users", layer: 0 },
          { id: "ca", label: ca, sublabel: `${minReplicas}–${maxReplicas} replicas`, icon: "container", layer: 1, provider: p, highlight: "added" },
        ],
        [{ from: "users", to: "ca" }],
        [`HTTP-driven autoscaling ${minReplicas}–${maxReplicas} replicas (about ${round(avgReplicas, 1)} on average, ${peakReplicas} at peak)`, "Per-second billing", "Same container image, revisions for blue/green"],
      );
      return makeDraft({
        fingerprint: `arch.app_platform:${plan.id}`,
        detector: "arch.app_platform",
        category: "architecture",
        provider: p,
        accountId: plan.accountId,
        title: `Move ${plan.name} from App Service Premium to ${ca}`,
        summary: `${plan.quantity} ${plan.sku} instances run at ${pct(plan.metrics.cpuAvg ?? 0)} CPU. Consumption-billed containers scale with requests instead.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(3),
        effort: "medium",
        risk: "low",
        timeline: "2–3 weeks",
        confidence: 0.85,
        resourceIds: [plan.id],
        details: {
          explanation:
            `${plan.name} reserves ${vcpus} vCPUs but uses about ${round(usedVcpu, 1)} on average. ` +
            (how
              ? `Replaying its hour-of-week load curve (${Math.round(planCpu!.days)} days of history, trend ${pctTrend(planCpu!.trendPerMonth)}, scaled to the load expected in 90 days), it needs ${round(avgReplicas, 1)} half-vCPU replicas on average and ${peakReplicas} at peak. `
              : `Only average CPU is available (no hourly history), so the replica count is estimated from the average. `) +
            `${ca} bills only for replica-seconds used and scales on concurrent requests, so capacity follows demand.`,
          evidence: [
            { label: "Provisioned vCPU", value: `${vcpus}` },
            { label: "Used vCPU (avg, 90-day forecast)", value: `${round(usedVcpu, 1)}` },
            { label: "Replicas needed", value: `${round(avgReplicas, 1)} average · ${peakReplicas} at peak` },
            { label: "Requests / month", value: requestsMeasured ? `${Math.round(reqM)}M` : `not measured (${Math.round(reqM)}M assumed)` },
            ...(planCpu?.source === "history" ? [{ label: "CPU trend", value: pctTrend(planCpu.trendPerMonth) }] : []),
          ],
          benefits: ["Pay for replica-seconds, not reserved instances", "Scale to demand automatically", "Revision-based blue/green deploys"],
          risks: ["Deployment slots map to revisions — update pipelines", "Min replicas kept at 2 to avoid cold starts"],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Scaling", current: "Instance-based", proposed: "Request-based", change: "better" },
            { metric: "Cold start", current: "None", proposed: "None (min 2 replicas)", change: "same" },
          ],
          implementation: [
            { phase: "Containerize", weeks: "Week 1", tasks: ["Build container image from the current app", "Create Container Apps environment in the same VNet"] },
            { phase: "Shadow & cutover", weeks: "Weeks 2–3", tasks: ["Split traffic 10/90 via Front Door", "Move to 100% and delete the plan"] },
          ],
          terraform: tfContainerApps({ name: plan.name, minReplicas, maxReplicas }),
          assumptions: [`0.5 vCPU / 1 GiB replicas with 30% headroom, at least ${minReplicas} running`, ...(requestsMeasured ? [] : [`Request volume is not measured: ${Math.round(reqM)}M requests/month assumed`])],
          usage: evidence(planCpu?.days ?? 0, ["CPU", "requests"], [chartOf(plan.usage?.metrics.cpu, "cpu", "CPU — daily p95"), chartOf(plan.usage?.metrics.requests, "requests", "Requests per day")]),
          rollout: { startWeek: 2, fullWeek: 3 },
        },
      });
    });

/* ------------------------------------------------------------------------- */
/* 6. Over-provisioned Kubernetes node pools → bin-pack + spot pool            */
/* ------------------------------------------------------------------------- */
/** Packing density the scheduler can safely reach once pod requests are right-sized. */
const K8S_TARGET_CPU = 0.65;
const K8S_TARGET_MEM = 0.75;
const K8S_MIN_NODES = 3;

export const kubernetesSpotConsolidation: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const pool of estate.resources.filter((r) => r.kind === "compute.vm" && r.config.role === "k8s-node" && r.state === "running" && r.quantity > 0 && (r.metrics.cpuAvg ?? 100) < 35)) {
    const vm = resolveVm(pool.sku);
    if (!vm) continue;
    const p = pool.provider;
    const statelessShare = pool.config.statelessShare ?? 0.5;
    const poolCpu = cpuSignal(pool);
    const poolMem = memSignal(pool);
    if (!poolCpu) continue;
    if (!poolMem) {
      recordGap(estate, pool, "arch.k8s_spot", "missing_metric", `Nodes average ${pct(poolCpu.avg)} CPU, so the pool looks over-provisioned — but node memory is not measured, and memory usually decides how tightly pods can be packed.`, MEMORY_AGENT_FIX[pool.provider]);
      continue;
    }
    if (!enoughHistory(poolCpu)) {
      recordGap(estate, pool, "arch.k8s_spot", "short_history", `Only ${Math.round(poolCpu.days)} days of node utilisation; ${MIN_HISTORY_DAYS} are needed before shrinking the pool.`);
      continue;
    }

    // Nodes needed to carry a given utilisation of today's pool at the target packing density.
    const nodesFor = (cpuPct: number, memPct: number) => Math.max((pool.quantity * cpuPct) / 100 / K8S_TARGET_CPU, (pool.quantity * memPct) / 100 / K8S_TARGET_MEM);
    const fit = (n: number) => Math.min(pool.quantity, Math.max(K8S_MIN_NODES, Math.ceil(n - 1e-9)));
    // Size for the utilisation expected in 90 days.
    const cpuGrowth = 1 + Math.max(0, poolCpu.trendPerMonth) * 3;
    const memGrowth = poolMem.peak > 0 ? poolMem.forecastPeak / poolMem.peak : 1;
    const cpuHow = poolCpu.profile?.howP95;
    const memHow = poolMem.profile?.howP95;
    const hourly = cpuHow && memHow && cpuHow.length === memHow.length;
    // With history the cluster autoscaler is modelled hour by hour over the week; with summary metrics
    // only the average and the peak are known.
    const perHour = hourly ? cpuHow.map((c, h) => fit(nodesFor(c * cpuGrowth, memHow[h] * memGrowth))) : [fit(nodesFor(poolCpu.avg * cpuGrowth, poolMem.forecastPeak))];
    const peakNodes = hourly ? Math.max(...perHour) : fit(nodesFor(poolCpu.forecastPeak, poolMem.forecastPeak));
    const avgNodes = perHour.reduce((a, b) => a + b, 0) / perHour.length;
    if (avgNodes > pool.quantity * 0.85) continue; // already packed within 15% of what is needed

    // Stateful and system pods stay on an on-demand pool sized for the peak; everything else autoscales on Spot.
    const onDemand = Math.min(peakNodes, Math.max(K8S_MIN_NODES, Math.ceil(peakNodes * (1 - statelessShare) - 1e-9)));
    const spotPerHour = perHour.map((n) => Math.max(0, n - onDemand));
    const spotMax = Math.max(1, peakNodes - onDemand);
    const spotMin = Math.min(spotMax, Math.min(...spotPerHour));
    const spotAvg = round(Math.max(0.5, spotPerHour.reduce((a, b) => a + b, 0) / spotPerHour.length), 1);
    const spotRange = spotMin === spotMax ? `${spotMax}` : `${spotMin}–${spotMax}`;
    const k8s = serviceName("compute.k8s_control_plane", p);
    const current = specFromResources("Current architecture", p, [pool],
      [
        { id: "cp", label: `${k8s} control plane`, icon: "k8s", layer: 0, provider: p },
        { id: "pool", label: "Node pool", sublabel: `${pool.sku}, on-demand`, icon: "vm", layer: 1, count: pool.quantity, provider: p, highlight: "changed" },
      ],
      [{ from: "cp", to: "pool" }],
      [`${pool.quantity} × ${pool.sku} on-demand nodes, fixed size`, `${pct(poolCpu.avg)} average CPU — requests far above usage`],
    );
    const proposed = buildArchitecture(`Proposed: bin-packed on-demand pool + autoscaled Spot pool`, p,
      [
        { id: "od", kind: "compute.vm", provider: p, label: `System/stateful pool — ${onDemand} × ${pool.sku}`, sku: pool.sku!, region: pool.region, usage: { count: onDemand } },
        { id: "spot", kind: "compute.vm", provider: p, label: `Spot pool — ${spotRange} × ${pool.sku} (autoscaled, ~${spotAvg} on average)`, sku: pool.sku!, region: pool.region, usage: { count: spotAvg, spot: true, hours: HOURS_PER_MONTH * 1.1 } },
      ],
      [
        { id: "cp", label: `${k8s} control plane`, icon: "k8s", layer: 0, provider: p },
        { id: "od", label: "On-demand pool", sublabel: "system + stateful", icon: "vm", layer: 1, count: onDemand, provider: p, highlight: "changed" },
        { id: "spot", label: "Spot pool", sublabel: `stateless, autoscaled ${spotRange}`, icon: "vm", layer: 1, count: Math.max(1, Math.round(spotAvg)), provider: p, highlight: "added" },
      ],
      [{ from: "cp", to: "od" }, { from: "cp", to: "spot" }],
      [`Right-size pod requests (VPA recommendations)`, `${onDemand} on-demand nodes for system + stateful pods`, `${spotRange} Spot nodes for the ${pct(statelessShare * 100)} of pods that are stateless (~${spotAvg} on average)`],
    );
    if (proposed.monthlyCost >= current.monthlyCost) continue;
    out.push(
      makeDraft({
        fingerprint: `arch.k8s_spot:${pool.id}`,
        detector: "arch.k8s_spot",
        category: "architecture",
        provider: p,
        accountId: pool.accountId,
        title: `Bin-pack ${pool.name} and move stateless pods to a Spot node pool`,
        summary: `${pool.quantity} nodes run at ${pct(poolCpu.avg)} CPU. Right-sized pod requests need ${peakNodes} nodes at peak${hourly && round(avgNodes, 1) < peakNodes ? ` and ${round(avgNodes, 1)} on average` : ""}, and ${pct(statelessShare * 100)} of pods can use Spot.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(2),
        effort: "medium",
        risk: "medium",
        timeline: "2–3 weeks",
        confidence: hourly ? 0.82 : 0.7,
        resourceIds: [pool.id],
        details: {
          explanation:
            `Pod resource requests on ${pool.name} are far above actual usage: nodes average ${pct(poolCpu.avg)} CPU and ${pct(poolMem.p95)} memory (p95). ` +
            (hourly
              ? `Replaying ${Math.round(poolCpu.days)} days of hourly node utilisation at a packing density of ${pct(K8S_TARGET_CPU * 100)} CPU / ${pct(K8S_TARGET_MEM * 100)} memory${cpuGrowth > 1.005 || memGrowth > 1.005 ? ", scaled to the usage expected in 90 days" : ""}, the cluster needs ${peakNodes} nodes in its busiest hour of the week and ${round(avgNodes, 1)} on average, instead of ${pool.quantity} around the clock. `
              : `Only summary metrics are available (no hourly history), so the estimate uses the average for the bill and the p95 for the peak: about ${round(avgNodes)} nodes on average and ${peakNodes} at peak, instead of ${pool.quantity}. `) +
            `System and stateful pods stay on ${onDemand} on-demand nodes; the ${pct(statelessShare * 100)} of pods that are stateless move to an autoscaled Spot pool (${spotRange} nodes), with ~10% capacity overhead for evictions.`,
          evidence: [
            { label: "Nodes", value: `${pool.quantity} × ${pool.sku}` },
            { label: "History", value: poolCpu.source === "history" ? `${Math.round(poolCpu.days)} days, hourly` : "Summary metrics only" },
            { label: "Average CPU", value: `${pct(poolCpu.avg)} (${pctTrend(poolCpu.trendPerMonth)})` },
            { label: "Memory p95", value: `${pct(poolMem.p95)} → ${pct(poolMem.forecastPeak)} in 90 days` },
            { label: "Nodes needed", value: `${peakNodes} at peak · ${round(avgNodes, 1)} on average` },
            { label: "Stateless pod share", value: pct(statelessShare * 100) },
          ],
          benefits: ["Fewer, better-utilised nodes", "Spot pricing for interruption-tolerant pods", "Autoscaler removes idle capacity in quiet hours"],
          risks: ["Spot evictions need PodDisruptionBudgets and graceful shutdown", "Aggressive bin-packing reduces burst headroom"],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Node count", current: `${pool.quantity}`, proposed: `${onDemand} + ${spotRange} Spot`, change: "better" },
            { metric: "Resilience", current: "Static", proposed: "Autoscaled, multi-pool", change: "better" },
          ],
          implementation: [
            { phase: "Right-size requests", weeks: "Week 1", tasks: ["Apply VPA recommendations to top 20 deployments", "Enable cluster autoscaler least-waste expander"] },
            { phase: "Spot pool", weeks: "Week 2", tasks: [`Create an autoscaled Spot pool (${spotMin}–${spotMax * 2} nodes) with taints`, "Add tolerations + PDBs to stateless deployments"] },
            { phase: "Shrink on-demand pool", weeks: "Week 3", tasks: [`Scale on-demand pool to ${onDemand}`] },
          ],
          terraform: p === "azure" ? tfAksSpot({ cluster: pool.name, vmSize: pool.sku!, max: spotMax * 2 }) : undefined,
          usage: evidence(
            poolCpu.days,
            ["CPU", "memory"],
            [chartOf(pool.usage?.metrics.cpu, "cpu", "Node CPU — daily p95"), chartOf(pool.usage?.metrics.mem, "mem", "Node memory — daily p95")],
            hourly ? { heatmap: { title: "Nodes needed by hour of week", unit: "nodes", values: perHour } } : {},
          ),
          rollout: { startWeek: 1, fullWeek: 3 },
        },
      }),
    );
  }
  return out;
};

export const serverlessModernization = serverlessModernizationWith();

export const ARCHITECTURE_DETECTORS: Detector[] = [
  serverlessModernization,
  staticSiteToCdn,
  natToEndpoints,
  databaseServerless,
  appPlanToContainers,
  kubernetesSpotConsolidation,
];
