import { HOURS_PER_MONTH, PRICES, resolveVm } from "../pricing/catalog";
import { Component, serviceName } from "../pricing/components";
import {
  tfAksSpot,
  tfAuroraServerless,
  tfAzureSqlServerless,
  tfContainerApps,
  tfServerless,
  tfStaticSite,
  tfVpcEndpoints,
} from "./terraform";
import type { DiagramEdge, DiagramNode, Detector, RecommendationDraft, ResourceRow } from "./types";
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
 * 24h utilisation profile (not from provisioned capacity).
 */
export function billedCapacity(maxUnits: number, hourly: number[] | undefined, avgPct: number, minUnits: number, headroom = 1.25) {
  const profile = hourly && hourly.length === 24 ? hourly : Array(24).fill(avgPct);
  const perHour = profile.map((h) => Math.max(minUnits, Math.min(maxUnits, (maxUnits * h * headroom) / 100)));
  return perHour.reduce((a, b) => a + b, 0) / 24;
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
    const reqM = lb.metrics.requestsPerMonthM;
    if (!reqM) continue;

    const provider = vms[0].provider;
    const dur = lb.metrics.avgDurationMs ?? 150;
    const duty = weightedAvg(vms, (v) => v.metrics.dutyCycle);
    const cpuAvg = weightedAvg(vms, (v) => v.metrics.cpuAvg);
    const peak = lb.metrics.peakToAvg ?? 1;
    const asyncShare = vms[0].config.asyncShare ?? 0.25;
    const memoryMb = vms[0].config.memoryMb ?? 1024;

    let fit = 10; // stateless
    fit += cpuAvg < 15 ? 25 : cpuAvg < 30 ? 15 : 0;
    fit += duty < 0.4 ? 25 : duty < 0.6 ? 15 : 5;
    fit += peak >= 4 ? 20 : peak >= 2 ? 12 : 0;
    fit += dur <= 1000 ? 20 : dur <= 5000 ? 10 : 0;
    if (fit < minFit) continue;

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

    const proposedComponents: Component[] = [
      { id: "api", kind: "network.api_gateway", provider, label: `${api} (HTTP)`, region, usage: { requestsM: reqM, tier: "http" } },
      { id: "fn-api", kind: "compute.function", provider, label: `${fn} — API handlers`, region, usage: { requestsM: round(reqM * (1 - asyncShare)), avgDurationMs: dur, memoryMb } },
      { id: "queue", kind: "messaging.queue", provider, label: `${q} — async jobs`, region, usage: { requestsM: round(reqM * asyncShare * 3) } },
      { id: "fn-worker", kind: "compute.function", provider, label: `${fn} — queue workers`, region, usage: { requestsM: round((reqM * asyncShare) / 10), avgDurationMs: Math.min(dur * 6, 60000), memoryMb: 1024 } },
      ...carried(keep),
    ];
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

    const weeks = 8;
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
            `Traffic averages ${round(reqM)}M requests/month with a ${dur} ms median duration, but CPU averages only ${pct(cpuAvg)} and the fleet is busy ${pct(duty * 100)} of hours. ` +
            `You are paying for peak capacity 24/7. Moving the request path to ${api} + ${fn} and background work to ${q} bills per request, scales to zero overnight and removes host management.`,
          evidence: [
            { label: "Average CPU", value: pct(cpuAvg) },
            { label: "Duty cycle", value: pct(duty * 100) },
            { label: "Peak-to-average traffic", value: `${peak.toFixed(1)}×` },
            { label: "Requests / month", value: `${round(reqM)}M` },
            { label: "Median request duration", value: `${dur} ms` },
            { label: "Serverless fit score", value: `${fit}/100` },
          ],
          benefits: ["65%+ lower compute cost at current traffic", "Scales per request — no over-provisioning for peaks", "No servers, AMIs or OS patching", "Pay only for actual usage; idle nights cost ~$0"],
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
          assumptions: [`${round(reqM)}M requests/month at ${dur} ms, ${memoryMb} MB`, `${pct(asyncShare * 100)} of requests trigger async work`, "Egress, logging and data stores unchanged"],
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
    const reqM = lb?.metrics.requestsPerMonthM ?? 20;
    const siteGb = vms[0].config.sizeGb ?? 25;
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
            { label: "Site size", value: `${siteGb} GB` },
            { label: "Monthly delivery", value: `${round(gbOut / 1024, 1)} TB` },
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
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* 3. NAT gateway carrying object-storage traffic → gateway endpoints         */
/* ------------------------------------------------------------------------- */
export const natToEndpoints: Detector = (estate) =>
  estate.resources
    .filter((r) => r.kind === "network.nat_gateway" && (r.config.s3TrafficShare ?? 0) >= 0.3 && (r.metrics.gbProcessed ?? 0) > 1000)
    .map((nat) => {
      const p = nat.provider;
      const gb = nat.metrics.gbProcessed!;
      const share = nat.config.s3TrafficShare!;
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
        confidence: 0.93,
        resourceIds: [nat.id],
        details: {
          explanation: `NAT gateways charge per GB processed. VPC Flow Log analysis shows ${pct(share * 100)} of bytes through ${nat.name} are destined for ${objName}/DynamoDB in the same region. Gateway endpoints route that traffic privately at no charge, with a route-table change and no application changes.`,
          evidence: [
            { label: "NAT data processed", value: `${round(gb / 1024, 1)} TB / month` },
            { label: "Share to object storage", value: pct(share * 100) },
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
        },
      });
    });

/* ------------------------------------------------------------------------- */
/* 4. Provisioned relational DB with spiky/low load → serverless DB           */
/* ------------------------------------------------------------------------- */
export const databaseServerless: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const db of estate.resources.filter((r) => (r.kind === "db.instance" || r.kind === "db.vcore") && r.environment === "prod")) {
    const cpuAvg = db.metrics.cpuAvg ?? 100;
    const peak = db.metrics.peakToAvg ?? 1;
    if (cpuAvg > 25 || peak < 2.5) continue;
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
      units = round(billedCapacity(maxUnits, db.metrics.hourly, cpuAvg, minUnits), 1);
      components = [
        { id: "writer", kind: "db.serverless", provider: p, label: "Aurora Serverless v2 — writer", region: db.region, usage: { capacityUnits: units, storageGb } },
        ...(db.config.multiAz ? [{ id: "reader", kind: "db.serverless" as const, provider: p, label: "Aurora Serverless v2 — reader (HA)", region: db.region, usage: { capacityUnits: units, storageGb: 0 } }] : []),
      ];
      tf = tfAuroraServerless({ name: db.name, minAcu: minUnits, maxAcu: maxUnits });
    } else if (p === "azure") {
      maxUnits = db.config.vcores ?? 8;
      minUnits = Math.max(0.5, maxUnits / 8);
      units = round(billedCapacity(maxUnits, db.metrics.hourly, cpuAvg, minUnits), 1);
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
          explanation: `${db.name} is provisioned for its daily peak but sits at ${pct(cpuAvg)} average CPU. Using the observed 24-hour load profile, ${dbName} would bill an average of ${units} ${PRICES.dbServerless[p].unit} (min ${minUnits}, max ${maxUnits}), which tracks demand hour by hour.`,
          evidence: [
            { label: "Average CPU", value: pct(cpuAvg) },
            { label: "Peak-to-average", value: `${peak.toFixed(1)}×` },
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
      const usedVcpu = (plan.quantity * vcpuPerInstance * (plan.metrics.cpuAvg ?? 10)) / 100;
      const minReplicas = 2;
      const replicaHours = Math.max(minReplicas * HOURS_PER_MONTH, (usedVcpu * 1.3 * HOURS_PER_MONTH) / 0.5);
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
          { id: "ca", label: ca, sublabel: `${minReplicas}–30 replicas`, icon: "container", layer: 1, provider: p, highlight: "added" },
        ],
        [{ from: "users", to: "ca" }],
        [`HTTP-driven autoscaling ${minReplicas}–30 replicas`, "Per-second billing", "Same container image, revisions for blue/green"],
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
          explanation: `${plan.name} reserves ${plan.quantity * vcpuPerInstance} vCPUs but uses about ${round(usedVcpu, 1)} on average. ${ca} bills only for replica-seconds used and scales on concurrent requests, so capacity follows demand.`,
          evidence: [
            { label: "Provisioned vCPU", value: `${plan.quantity * vcpuPerInstance}` },
            { label: "Used vCPU (avg)", value: `${round(usedVcpu, 1)}` },
            { label: "Requests / month", value: `${reqM}M` },
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
          terraform: tfContainerApps({ name: plan.name, minReplicas }),
          rollout: { startWeek: 2, fullWeek: 3 },
        },
      });
    });

/* ------------------------------------------------------------------------- */
/* 6. Over-provisioned Kubernetes node pools → bin-pack + spot pool            */
/* ------------------------------------------------------------------------- */
export const kubernetesSpotConsolidation: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const pool of estate.resources.filter((r) => r.kind === "compute.vm" && r.config.role === "k8s-node" && (r.metrics.cpuAvg ?? 100) < 35)) {
    const vm = resolveVm(pool.sku);
    if (!vm) continue;
    const p = pool.provider;
    const statelessShare = pool.config.statelessShare ?? 0.5;
    const usedVcpu = (pool.quantity * vm.vcpu * (pool.metrics.cpuAvg ?? 30)) / 100;
    const usedMem = (pool.quantity * vm.memGiB * (pool.metrics.memP95 ?? 50)) / 100;
    const needed = Math.ceil(Math.max(usedVcpu / (vm.vcpu * 0.65), usedMem / (vm.memGiB * 0.75)));
    const onDemand = Math.max(3, Math.ceil(needed * (1 - statelessShare)));
    const spot = Math.max(1, Math.ceil(needed * statelessShare));
    if (onDemand + spot >= pool.quantity) continue;
    const k8s = serviceName("compute.k8s_control_plane", p);
    const current = specFromResources("Current architecture", p, [pool],
      [
        { id: "cp", label: `${k8s} control plane`, icon: "k8s", layer: 0, provider: p },
        { id: "pool", label: "Node pool", sublabel: `${pool.sku}, on-demand`, icon: "vm", layer: 1, count: pool.quantity, provider: p, highlight: "changed" },
      ],
      [{ from: "cp", to: "pool" }],
      [`${pool.quantity} × ${pool.sku} on-demand nodes`, `${pct(pool.metrics.cpuAvg ?? 0)} avg CPU — requests far above usage`],
    );
    const proposed = buildArchitecture(`Proposed: bin-packed on-demand pool + autoscaled Spot pool`, p,
      [
        { id: "od", kind: "compute.vm", provider: p, label: `System/stateful pool — ${onDemand} × ${pool.sku}`, sku: pool.sku!, region: pool.region, usage: { count: onDemand } },
        { id: "spot", kind: "compute.vm", provider: p, label: `Spot pool — ~${spot} × ${pool.sku} (autoscaled)`, sku: pool.sku!, region: pool.region, usage: { count: spot, spot: true, hours: HOURS_PER_MONTH * 1.1 } },
      ],
      [
        { id: "cp", label: `${k8s} control plane`, icon: "k8s", layer: 0, provider: p },
        { id: "od", label: "On-demand pool", sublabel: "system + stateful", icon: "vm", layer: 1, count: onDemand, provider: p, highlight: "changed" },
        { id: "spot", label: "Spot pool", sublabel: "stateless, autoscaled", icon: "vm", layer: 1, count: spot, provider: p, highlight: "added" },
      ],
      [{ from: "cp", to: "od" }, { from: "cp", to: "spot" }],
      [`Right-size pod requests (VPA recommendations)`, `${onDemand} on-demand nodes for system + stateful pods`, `~${spot} Spot nodes for ${pct(statelessShare * 100)} stateless pods`],
    );
    out.push(
      makeDraft({
        fingerprint: `arch.k8s_spot:${pool.id}`,
        detector: "arch.k8s_spot",
        category: "architecture",
        provider: p,
        accountId: pool.accountId,
        title: `Bin-pack ${pool.name} and move stateless pods to a Spot node pool`,
        summary: `${pool.quantity} nodes run at ${pct(pool.metrics.cpuAvg ?? 0)} CPU. Right-sized pod requests fit on ${onDemand + spot} nodes, and ${pct(statelessShare * 100)} of pods can use Spot.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(2),
        effort: "medium",
        risk: "medium",
        timeline: "2–3 weeks",
        confidence: 0.8,
        resourceIds: [pool.id],
        details: {
          explanation: `Pod resource requests on ${pool.name} are far above actual usage (≈${round(usedVcpu)} of ${pool.quantity * vm.vcpu} vCPUs used). Right-sizing requests lets the scheduler pack onto ${needed} nodes. Stateless deployments (${pct(statelessShare * 100)} of pods) then move to an autoscaled Spot pool, with ~10% capacity overhead for evictions.`,
          evidence: [
            { label: "Nodes", value: `${pool.quantity} × ${pool.sku}` },
            { label: "Average CPU", value: pct(pool.metrics.cpuAvg ?? 0) },
            { label: "Memory p95", value: pct(pool.metrics.memP95 ?? 0) },
            { label: "Stateless pod share", value: pct(statelessShare * 100) },
          ],
          benefits: ["Fewer, better-utilised nodes", "Spot pricing for interruption-tolerant pods", "Autoscaler removes idle capacity at night"],
          risks: ["Spot evictions need PodDisruptionBudgets and graceful shutdown", "Aggressive bin-packing reduces burst headroom"],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Node count", current: `${pool.quantity}`, proposed: `${onDemand} + ~${spot} spot`, change: "better" },
            { metric: "Resilience", current: "Static", proposed: "Autoscaled, multi-pool", change: "better" },
          ],
          implementation: [
            { phase: "Right-size requests", weeks: "Week 1", tasks: ["Apply VPA recommendations to top 20 deployments", "Enable cluster autoscaler least-waste expander"] },
            { phase: "Spot pool", weeks: "Week 2", tasks: ["Create Spot pool with taints", "Add tolerations + PDBs to stateless deployments"] },
            { phase: "Shrink on-demand pool", weeks: "Week 3", tasks: [`Scale on-demand pool to ${onDemand}`] },
          ],
          terraform: p === "azure" ? tfAksSpot({ cluster: pool.name, vmSize: pool.sku!, max: spot * 2 }) : undefined,
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
