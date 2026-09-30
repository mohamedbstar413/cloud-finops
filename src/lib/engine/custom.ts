import {
  armEquivalent,
  cheapestEquivalentVm,
  DEFAULT_REGION,
  downsizeVm,
  ENGINEER_WEEK_COST,
  HOURS_PER_MONTH,
  PRICES,
  PROVIDER_LABEL,
  PROVIDERS,
  REGION_MULTIPLIER,
  resolveVm,
  type Provider,
} from "../pricing/catalog";
import { priceComponents, serviceName, type Component, type ComponentRole, type PricedComponent } from "../pricing/components";
import type { Level } from "./types";

/**
 * Architecture analysis for ANY architecture a user describes (not only
 * connected accounts). Every component carries a role (web / batch /
 * stateful / k8s) so each tier gets only the optimizations that are safe for
 * it. This deterministic analyzer is the offline fallback; with OpenAI
 * configured the LLM proposes, and this module still prices.
 */

export interface WorkloadProfile {
  trafficPattern: "steady" | "spiky" | "business_hours" | "batch" | "unknown";
  stateless: boolean;
  interruptible: boolean;
  latencySensitive: boolean;
  requestsPerMonthM?: number;
  /** Average CPU utilisation 0–1, when the user states it. */
  cpuUtilization?: number;
  /** Share of object storage not read in 90 days, when stated. */
  coldShare?: number;
}

export interface ArchitectureProposal {
  title: string;
  strategy: string;
  targetProvider: Provider;
  rationale: string;
  components: Component[];
  benefits: string[];
  risks: string[];
  effort: Level;
  risk: Level;
  timelineWeeks: number;
  migrationEngineerWeeks: number;
  /** One-time non-labour cost, e.g. bulk data transfer out of the old cloud. */
  oneTimeCost?: number;
  origin?: "rules" | "ai";
}

export interface PricedProposal extends Omit<ArchitectureProposal, "components"> {
  components: PricedComponent[];
  monthlyCost: number;
  monthlySavings: number;
  savingsPct: number;
  migrationCost: number;
}

export interface CustomAnalysis {
  current: { components: PricedComponent[]; monthlyCost: number };
  profile: WorkloadProfile;
  proposals: PricedProposal[];
  /** Findings that explain choices (break-even points, exclusions, estimates). */
  insights: string[];
  /** Values we had to assume because the input did not state them. */
  assumptions: string[];
  /** Services mentioned in the description that we cannot price yet. */
  unrecognized: string[];
  source: "ai" | "heuristic";
  model?: string;
}

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const clone = (c: Component, patch: Partial<Component> & { usage?: Component["usage"] }): Component => ({
  ...c,
  ...patch,
  id: patch.id ?? `${c.id}~${++seq}`,
  usage: { ...c.usage, ...(patch.usage ?? {}) },
});

export function priceProposal(p: ArchitectureProposal, currentMonthly: number): PricedProposal {
  const { components, total } = priceComponents(p.components);
  const savings = currentMonthly - total;
  return {
    ...p,
    components,
    monthlyCost: total,
    monthlySavings: round2(savings),
    savingsPct: currentMonthly > 0 ? Math.round((savings / currentMonthly) * 1000) / 10 : 0,
    migrationCost: round2(p.migrationEngineerWeeks * ENGINEER_WEEK_COST + (p.oneTimeCost ?? 0)),
  };
}

/* ------------------------------------------------------------------------- */
/* Roles & utilisation                                                        */
/* ------------------------------------------------------------------------- */

export function roleOf(c: Component, profile: WorkloadProfile): ComponentRole {
  if (c.role) return c.role;
  if (profile.interruptible && profile.trafficPattern === "batch") return "batch";
  if (profile.stateless) return "web";
  return "stateful";
}

function utilisation(role: ComponentRole, profile: WorkloadProfile): number {
  if (profile.cpuUtilization !== undefined) return profile.cpuUtilization;
  if (role === "batch") return 0.35;
  if (role === "k8s") return 0.3;
  if (role === "stateful") return 0.4;
  return { steady: 0.45, spiky: 0.15, business_hours: 0.2, batch: 0.35, unknown: 0.3 }[profile.trafficPattern];
}

const isVm = (c: Component) => c.kind === "compute.vm" && !c.usage.spot;
const vcpusOf = (cs: Component[]) => cs.reduce((s, c) => s + (resolveVm(c.sku)?.vcpu ?? 2) * (c.usage.count ?? 1), 0);

/** Serverless (API gateway + functions + queue) components for a request volume. */
function serverlessStack(p: Provider, region: string | undefined, reqM: number): Component[] {
  return [
    { id: id("api"), kind: "network.api_gateway", provider: p, label: `${serviceName("network.api_gateway", p)} (HTTP)`, region, usage: { requestsM: reqM, tier: "http" } },
    { id: id("fn"), kind: "compute.function", provider: p, label: `${serviceName("compute.function", p)} — handlers`, region, usage: { requestsM: round2(reqM * 0.75), avgDurationMs: 150, memoryMb: 1024 } },
    { id: id("q"), kind: "messaging.queue", provider: p, label: `${serviceName("messaging.queue", p)} — async`, region, usage: { requestsM: round2(reqM * 0.25 * 3) } },
    { id: id("wk"), kind: "compute.function", provider: p, label: `${serviceName("compute.function", p)} — workers`, region, usage: { requestsM: round2((reqM * 0.25) / 10), avgDurationMs: 900, memoryMb: 1024 } },
  ];
}

/** Monthly request volume at which serverless costs the same as `replacedCost`. */
export function serverlessBreakEvenM(p: Provider, replacedCost: number): number {
  const perThousandM = priceComponents(serverlessStack(p, undefined, 1000)).total;
  return perThousandM > 0 ? Math.round((replacedCost / perThousandM) * 1000) : 0;
}

function serverlessDb(d: Component): Component {
  const base = d.kind === "db.vcore" ? Math.max(1, (d.usage.vcores ?? 4) * 0.3) : Math.max(2, ((resolveVm(d.sku?.replace(/^db\./, ""))?.memGiB ?? 32) / 2) * 0.2);
  const replicas = (d.usage.count ?? 1) * (d.usage.multiAz ? 2 : 1);
  return {
    id: id("dbs"),
    kind: "db.serverless",
    provider: d.provider,
    label: `${serviceName("db.serverless", d.provider)} (was ${d.label})`,
    region: d.region,
    role: "stateful",
    usage: { capacityUnits: round2(base * replicas), storageGb: (d.usage.storageGb ?? 100) * (d.usage.count ?? 1) },
  };
}

/* ------------------------------------------------------------------------- */
/* Proposals                                                                  */
/* ------------------------------------------------------------------------- */

export function heuristicProposals(current: Component[], profile: WorkloadProfile): { proposals: ArchitectureProposal[]; insights: string[] } {
  const insights: string[] = [];
  const proposals: ArchitectureProposal[] = [];
  const providers = [...new Set(current.map((c) => c.provider))];
  const home: Provider = providers[0] ?? "aws";
  const byRole = (role: ComponentRole) => current.filter((c) => isVm(c) && roleOf(c, profile) === role);
  const web = byRole("web");
  const batch = profile.latencySensitive ? [] : byRole("batch");
  const k8s = byRole("k8s");
  const lbs = current.filter((c) => c.kind === "network.load_balancer");
  const plans = current.filter((c) => c.kind === "app.plan");
  const spikyDb = profile.trafficPattern === "spiky" || profile.trafficPattern === "business_hours";

  const estimated = [...new Set(current.filter((c) => c.kind === "compute.vm" && resolveVm(c.sku)?.estimated).map((c) => c.sku))];
  if (estimated.length) insights.push(`Rates for ${estimated.join(", ")} are estimated from instance shape (not in the price catalog).`);
  if (profile.latencySensitive) insights.push("Latency-sensitive: serverless cold starts and Spot interruptions were excluded.");
  if (profile.cpuUtilization === undefined && current.some(isVm))
    insights.push(`CPU utilisation not stated — sizing assumes ~${Math.round(utilisation("web", profile) * 100)}% for request tiers (${profile.trafficPattern.replace("_", " ")} traffic). Add e.g. "25% average CPU" for tighter estimates.`);
  if (batch.length && current.some((c) => isVm(c) && roleOf(c, profile) !== "batch"))
    insights.push(`Spot is applied only to batch tiers (${batch.map((b) => b.label).join(", ")}); request-serving and stateful tiers stay on-demand.`);

  /* ---- A. Modernize: best target per tier ---- */
  {
    const replaced = new Set<string>();
    const added: Component[] = [];
    const notes: string[] = [];
    let weeks = 0;

    const webTier = [...web, ...plans];
    if (webTier.length) {
      const replacedWeb = [...webTier, ...lbs, ...current.filter((c) => c.kind === "storage.block" && roleOf(c, profile) === "web")];
      const webCost = priceComponents(replacedWeb).total;
      const region = webTier[0].region;
      const p = webTier[0].provider;
      const reqM = profile.requestsPerMonthM;
      const breakEven = serverlessBreakEvenM(p, webCost);
      const u = utilisation("web", profile);
      const replicas = Math.max(2, Math.ceil((vcpusOf(web) + plans.reduce((s, a) => s + 4 * (a.usage.count ?? 1), 0)) * u * 1.3));
      const containers: Component[] = [
        ...lbs.map((l) => clone(l, {})),
        { id: id("ctr"), kind: "compute.container", provider: p, label: `${serviceName("compute.container", p)} — 1 vCPU / 2 GB replicas`, region, role: "web", usage: { count: replicas, vcpu: 1, memGb: 2, activeHours: HOURS_PER_MONTH } },
      ];
      const containerCost = priceComponents(containers).total;
      let chosen: Component[] | null = null;
      if (!profile.latencySensitive && reqM !== undefined) {
        const sls = serverlessStack(p, region, reqM);
        const slsCost = priceComponents(sls).total;
        if (slsCost < Math.min(webCost, containerCost)) {
          chosen = sls;
          notes.push(`${serviceName("network.api_gateway", p)} + ${serviceName("compute.function", p)} for the request tier`);
          weeks += 6;
        } else if (slsCost < webCost) {
          insights.push(`Serverless evaluated for the request tier: ${money(slsCost)}/month at ${reqM.toLocaleString()}M requests — cheaper than today (${money(webCost)}), but autoscaled containers (${money(containerCost)}) are cheaper still at this volume.`);
        } else {
          insights.push(
            `Serverless evaluated for the request tier: at ${reqM.toLocaleString()}M requests/month it would cost ${money(slsCost)} vs ${money(webCost)} today — break-even is ~${breakEven.toLocaleString()}M requests/month, so it is not recommended.`,
          );
        }
      } else if (!profile.latencySensitive) {
        insights.push(`Request volume not given: serverless for the request tier becomes cheaper below ~${breakEven.toLocaleString()}M requests/month (today the tier costs ${money(webCost)}). Add the volume to evaluate it.`);
      }
      if (!chosen && containerCost < webCost * 0.9) {
        chosen = containers;
        notes.push(`${serviceName("compute.container", p)} with request-based autoscaling (~${replicas} replicas at ${Math.round(u * 100)}% utilisation)`);
        weeks += 4;
      }
      if (chosen) {
        replacedWeb.forEach((c) => replaced.add(c.id));
        added.push(...chosen);
      }
    }

    for (const b of batch) {
      replaced.add(b.id);
      added.push(clone(b, { label: `${b.label} (Spot, managed batch)`, usage: { spot: true, hours: (b.usage.hours ?? HOURS_PER_MONTH) * 1.1 } }));
      notes.push(`Spot capacity for ${b.label}`);
      weeks += 1.5;
    }

    for (const n of k8s) {
      const count = n.usage.count ?? 1;
      if (!resolveVm(n.sku) || count < 4) continue;
      const needed = Math.max(3, Math.ceil((count * utilisation("k8s", profile)) / 0.65));
      const od = Math.max(3, Math.ceil(needed * 0.5));
      const spot = profile.latencySensitive ? 0 : Math.max(1, needed - od);
      if (od + spot >= count) continue;
      replaced.add(n.id);
      added.push(clone(n, { label: `${n.label} — on-demand pool (${od})`, usage: { count: od } }));
      if (spot) added.push(clone(n, { label: `${n.label} — Spot pool (~${spot})`, usage: { count: spot, spot: true, hours: HOURS_PER_MONTH * 1.1 } }));
      notes.push(`bin-pack ${n.label} onto ${od} on-demand${spot ? ` + ~${spot} Spot` : ""} nodes`);
      weeks += 3;
    }

    if (spikyDb) {
      for (const d of current.filter((c) => c.kind === "db.instance" || c.kind === "db.vcore")) {
        replaced.add(d.id);
        added.push(serverlessDb(d));
        notes.push(`serverless ${d.label}`);
        weeks += 2;
      }
    }

    if (notes.length) {
      const kept = current.filter((c) => !replaced.has(c.id));
      proposals.push({
        title: `Modernize: ${notes.slice(0, 2).join("; ")}${notes.length > 2 ? ` (+${notes.length - 2} more)` : ""}`,
        strategy: added.some((a) => a.kind === "compute.function") ? "serverless" : added.some((a) => a.kind === "compute.container") ? "containers" : added.some((a) => a.usage.spot) ? "spot" : "hybrid",
        targetProvider: home,
        rationale: `Each tier gets the target that fits its role: ${notes.join("; ")}. Stateful components and data stores are kept.`,
        components: [...kept, ...added],
        benefits: ["Capacity follows demand instead of peak", "Less infrastructure to patch and scale", ...(batch.length ? ["Batch runs at Spot prices"] : [])],
        risks: [
          ...(added.some((a) => a.kind === "compute.function") ? ["Cold starts on latency-critical paths; 29 s synchronous limit behind API gateways"] : []),
          ...(added.some((a) => a.usage.spot) ? ["Spot interruptions require checkpointing and retries"] : []),
          "Deployment pipelines and observability need updating",
        ],
        effort: weeks > 6 ? "high" : "medium",
        risk: "medium",
        timelineWeeks: Math.max(2, Math.ceil(weeks * 0.7)),
        migrationEngineerWeeks: Math.max(2, weeks),
      });
    }
  }

  /* ---- B. Optimize in place ---- */
  {
    const notes: string[] = [];
    const optimized: Component[] = current.flatMap((c): Component[] => {
      const role = roleOf(c, profile);
      if (isVm(c)) {
        if (role === "batch" && !profile.latencySensitive) {
          notes.push("Spot for batch tiers");
          return [clone(c, { label: `${c.label} (Spot)`, usage: { spot: true, hours: (c.usage.hours ?? HOURS_PER_MONTH) * 1.1 } })];
        }
        if (utilisation(role, profile) < 0.3 && role !== "k8s") {
          const down = c.sku ? downsizeVm(c.sku) : undefined;
          const arm = down && role === "web" ? armEquivalent(down.sku) : undefined;
          const to = arm ?? down;
          if (to) {
            notes.push(`Right-size ${c.sku} → ${to.sku}${arm ? " (Arm)" : ""}`);
            return [clone(c, { sku: to.sku, label: `${c.label} → ${to.sku}` })];
          }
        }
        return [c];
      }
      if (c.kind === "storage.object" && (c.usage.tier ?? "hot") === "hot" && (c.usage.gb ?? 0) > 1024) {
        const cold = profile.coldShare ?? 0.3;
        const cool = Math.min(0.3, 1 - cold);
        const hot = Math.max(0, 1 - cold - cool);
        notes.push("Lifecycle tiering for object storage");
        const gb = c.usage.gb!;
        return [
          ...(hot > 0 ? [clone(c, { label: `${c.label} — hot (${Math.round(hot * 100)}%)`, usage: { gb: gb * hot } })] : []),
          clone(c, { label: `${c.label} — cool (${Math.round(cool * 100)}%)`, usage: { gb: gb * cool, tier: "cool" } }),
          clone(c, { label: `${c.label} — cold (${Math.round(cold * 100)}%)`, usage: { gb: gb * cold, tier: "cold" } }),
        ];
      }
      if (c.kind === "storage.block" && c.provider === "aws" && c.usage.tier !== "standard") {
        notes.push("gp2 → gp3 volumes");
        return [clone(c, { label: `${c.label} (gp3)`, usage: { tier: "standard" } })];
      }
      if (c.kind === "network.nat_gateway" && (c.usage.gb ?? 0) > 500) {
        notes.push("Gateway endpoints for object-storage traffic");
        return [
          clone(c, { usage: { gb: (c.usage.gb ?? 0) * 0.5 } }),
          { id: id("vpce"), kind: "network.vpc_endpoint", provider: c.provider, label: "Gateway endpoints (storage)", usage: { tier: "gateway" } },
        ];
      }
      if ((c.kind === "db.instance" || c.kind === "db.vcore") && spikyDb) {
        notes.push("Serverless database capacity");
        return [serverlessDb(c)];
      }
      return [c];
    });
    // Commit to the steady on-demand compute that remains.
    for (const p of providers) {
      const steady = optimized.filter((c) => c.provider === p && isVm(c) && roleOf(c, profile) !== "batch");
      if (!steady.length) continue;
      const { total } = priceComponents(steady);
      const coverage = profile.trafficPattern === "spiky" ? 0.5 : 0.8;
      const credit = total * coverage * PRICES.commitment[p]["1y"];
      if (credit < 25) continue;
      notes.push(`1-year ${PRICES.commitment[p].name} on ${Math.round(coverage * 100)}% of steady ${PROVIDER_LABEL[p]} compute`);
      optimized.push({ id: id("commit"), kind: "other.fixed", provider: p, label: `${PRICES.commitment[p].name} credit (1y, ${Math.round(coverage * 100)}% coverage)`, usage: { monthlyCost: -round2(credit) } });
    }
    if (notes.length) {
      const uniq = [...new Set(notes)];
      proposals.push({
        title: "Optimize in place: " + uniq.slice(0, 3).join(", ") + (uniq.length > 3 ? ` (+${uniq.length - 3} more)` : ""),
        strategy: "hybrid",
        targetProvider: home,
        rationale: "Keeps the architecture and applies the proven, low-risk levers first.",
        components: optimized,
        benefits: uniq,
        risks: ["Reduced headroom after right-sizing — monitor p99 latency", ...(batch.length ? ["Spot interruptions require checkpointing"] : [])],
        effort: "low",
        risk: "low",
        timelineWeeks: Math.min(4, 1 + Math.ceil(uniq.length / 2)),
        migrationEngineerWeeks: Math.round(uniq.length * 0.4 * 10) / 10,
      });
    }
  }

  /* ---- C. Cheapest cloud: consolidate the whole architecture on one provider ---- */
  if (current.some(isVm) && !current.some((c) => c.kind === "other.fixed")) {
    const currentTotal = priceComponents(current).total;
    const options = PROVIDERS.map((p) => {
      let transferGb = 0;
      let transferCost = 0;
      const moved = current.map((c): Component => {
        if (c.provider === p) return c;
        const gb = c.kind === "storage.object" ? (c.usage.gb ?? 0) : c.kind === "db.instance" || c.kind === "db.vcore" ? (c.usage.storageGb ?? 0) * (c.usage.count ?? 1) : 0;
        transferGb += gb;
        transferCost += gb * PRICES.egressInternet[c.provider];
        if (c.kind === "compute.vm") {
          const vm = resolveVm(c.sku);
          const eq = vm ? cheapestEquivalentVm(p, vm.vcpu, vm.memGiB) : undefined;
          return clone(c, { provider: p, sku: eq?.sku ?? c.sku, region: DEFAULT_REGION[p], label: `${c.label} → ${eq?.sku ?? c.sku}` });
        }
        if (c.kind === "db.instance") {
          const vcores = (resolveVm(c.sku?.replace(/^db\./, ""))?.vcpu ?? 4) * (c.usage.multiAz ? 2 : 1) * (c.usage.count ?? 1);
          return { id: id("db"), kind: "db.vcore", provider: p, label: `${c.label} → ${serviceName("db.vcore", p)}`, region: DEFAULT_REGION[p], role: "stateful", usage: { vcores, storageGb: (c.usage.storageGb ?? 100) * (c.usage.count ?? 1) } };
        }
        if (c.kind === "app.plan") return { id: id("ctr"), kind: "compute.container", provider: p, label: `${c.label} → ${serviceName("compute.container", p)}`, role: "web", usage: { count: (c.usage.count ?? 1) * 2, vcpu: 1, memGb: 2 } };
        return clone(c, { provider: p, region: DEFAULT_REGION[p] });
      });
      return { p, comps: moved, total: priceComponents(moved).total, transferGb, transferCost, moves: current.some((c) => c.provider !== p) };
    }).filter((o) => o.moves);
    const best = options.sort((a, b) => a.total - b.total)[0];
    if (best && best.total < currentTotal * 0.9) {
      const multi = providers.length > 1;
      if (best.transferGb > 0) insights.push(`Re-platforming on ${PROVIDER_LABEL[best.p]} includes a one-time transfer of ${Math.round(best.transferGb / 1024)} TB (${money(best.transferCost)}) in the migration cost.`);
      proposals.push({
        title: multi ? `Consolidate everything on ${PROVIDER_LABEL[best.p]}` : `Re-platform on ${PROVIDER_LABEL[best.p]}`,
        strategy: "cross_cloud",
        targetProvider: best.p,
        rationale: `Equivalent capacity on ${PROVIDER_LABEL[best.p]} is priced lower for this mix of services${multi ? ", and consolidating removes cross-cloud operations" : ""}. Same pricing model (no Spot) so the comparison isolates the platform difference.`,
        components: best.comps,
        benefits: [`Lower list prices on ${PROVIDER_LABEL[best.p]} for this shape`, multi ? "One cloud to operate, secure and audit" : "Negotiating leverage with the incumbent provider"],
        risks: ["New operational tooling, IAM and on-call runbooks", "Managed-service feature gaps must be validated", "Egress for any data or consumers left behind"],
        effort: "high",
        risk: "medium",
        timelineWeeks: 10,
        migrationEngineerWeeks: 12,
        oneTimeCost: round2(best.transferCost),
      });
    }
  }
  return { proposals, insights };
}

export const MAX_PAYBACK_MONTHS = 36;
export const paysBack = (p: { migrationCost: number; monthlySavings: number }) => p.monthlySavings > 0 && p.migrationCost / p.monthlySavings <= MAX_PAYBACK_MONTHS;

export function analyzeHeuristically(current: Component[], profile: WorkloadProfile, extra: { assumptions?: string[]; unrecognized?: string[] } = {}): CustomAnalysis {
  const cur = priceComponents(current);
  const { proposals, insights } = heuristicProposals(current, profile);
  // Material savings only: at least $10/month and 1% of the current cost.
  const priced = proposals
    .map((p) => priceProposal({ ...p, origin: "rules" }, cur.total))
    .filter((p) => Number.isFinite(p.monthlyCost) && p.monthlySavings >= Math.max(10, cur.total * 0.01));
  const viable = priced.filter((p) => paysBack(p));
  if (priced.length > viable.length) {
    const dropped = priced.filter((p) => !paysBack(p));
    insights.push(`${dropped.map((p) => `“${p.title}”`).join(", ")} ${dropped.length === 1 ? "was" : "were"} dropped: savings of ${dropped.map((p) => money(p.monthlySavings)).join(" / ")}/month don't repay the migration effort within ${MAX_PAYBACK_MONTHS} months.`);
  }
  if (!viable.length && current.length) insights.push("No change pays back within 3 years at list prices — this architecture already looks cost-efficient.");
  return {
    current: { components: cur.components, monthlyCost: cur.total },
    profile,
    proposals: viable.sort((a, b) => b.monthlySavings - a.monthlySavings),
    insights,
    assumptions: extra.assumptions ?? [],
    unrecognized: extra.unrecognized ?? [],
    source: "heuristic",
  };
}

/* ------------------------------------------------------------------------- */
/* Free-text architecture parser (offline fallback)                           */
/* ------------------------------------------------------------------------- */

const SKU = String.raw`(?:[a-z]\d[a-z\d-]{0,3}\.(?:\d*xlarge|large|medium|small|micro|nano)|standard_[a-z]+\d+[a-z]*(?:_v\d+)?|[a-z]\d[a-z]?-(?:standard|highcpu|highmem|megamem)-\d+)`;
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
const ROLE_WORDS: [ComponentRole, RegExp][] = [
  ["k8s", /\b(kubernetes|k8s|eks|aks|gke|node ?pools?|nodes)\b/],
  ["batch", /\b(batch|etl|jobs?|workers?|nightly|cron|render(ing)?|training|spark|hadoop|emr|dataproc|queue consumers?)\b/],
  ["stateful", /\b(redis|memcached|cache|kafka|elasticsearch|opensearch|cassandra|mongodb|zookeeper|stateful|database|self-managed|rabbitmq)\b/],
  ["web", /\b(web|api|frontend|front-end|http|rest|graphql|app servers?|backend|microservices?|website|stateless)\b/],
];
const UNPRICED: [RegExp, string][] = [
  [/\bdynamo ?db\b/, "DynamoDB"],
  [/\bcosmos ?db\b/, "Cosmos DB"],
  [/\bspanner\b/, "Cloud Spanner"],
  [/\bfirestore\b/, "Firestore"],
  [/\b(msk|managed kafka|event hubs?|confluent)\b/, "Managed Kafka / Event Hubs"],
  [/\b(opensearch service|elastic cloud)\b/, "Managed search"],
  [/\bredshift\b/, "Redshift"],
  [/\bsnowflake\b/, "Snowflake"],
  [/\b(sagemaker|vertex ai|azure ml)\b/, "Managed ML platform"],
  [/\b(gpus?|a100|h100|p4d|p5|g5)\b/, "GPU instances"],
];

/** Split a description into list items: sentences, comma items, and "and/plus/with <number>" joins. */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.;:\n])\s+|,\s*|\s+plus\s+|\s+as well as\s+|\s+(?:and|with)\s+(?=(?:\d|one|two|three|four|five|six|eight|ten|twelve|twenty)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const clauseRole = (clause: string): ComponentRole | undefined => ROLE_WORDS.find(([, re]) => re.test(clause))?.[0];

function sizeGb(q: string, re: RegExp): number {
  const m = re.exec(q);
  if (!m) return 0;
  return Number(m[1]) * (m[2] === "pb" ? 1024 * 1024 : m[2] === "tb" ? 1024 : 1);
}

export interface ParsedArchitecture {
  components: Component[];
  profile: WorkloadProfile;
  assumptions: string[];
  unrecognized: string[];
}

export function parseArchitectureText(text: string): ParsedArchitecture {
  const q = text.toLowerCase().replace(/(\d),(\d{3})/g, "$1$2");
  const assumptions: string[] = [];
  const score = (re: RegExp) => (q.match(re) ?? []).length;
  const ranked = (
    [
      ["aws", score(/\b(aws|ec2|s3|rds|aurora|alb|elb|lambda|eks|dynamodb|cloudfront|[a-z]\d[a-z\d]{0,3}\.\d*x?large)\b/g)],
      ["azure", score(/\b(azure|app service|aks|blob|cosmos|front door|standard_[a-z0-9_]+)\b/g)],
      ["gcp", score(/\b(gcp|google|gke|cloud run|bigquery|gcs|cloud storage|cloud sql|[a-z]\d[a-z]?-(?:standard|highcpu|highmem)-\d+)\b/g)],
    ] as [Provider, number][]
  ).sort((a, b) => b[1] - a[1]);
  const provider: Provider = ranked[0][1] > 0 ? ranked[0][0] : "aws";
  const regionKey = Object.keys(REGION_MULTIPLIER).find((r) => new RegExp(`\\b${r}\\b`).test(q));
  const regionFor = (p: Provider) => {
    if (!regionKey) return DEFAULT_REGION[p];
    const fits = p === "aws" ? /^[a-z]{2}-[a-z]+-\d$/.test(regionKey) : p === "gcp" ? /^[a-z]+-[a-z]+\d$/.test(regionKey) : /^[a-z]+\d?$/.test(regionKey);
    return fits ? regionKey : DEFAULT_REGION[p];
  };
  const region = regionFor(provider);
  const components: Component[] = [];
  const parts = clauses(q);

  // --- VM fleets: "20 m6i.2xlarge", "24 EC2 m5.large instances", "m5.xlarge x 10", "8 instances of type c5.2xlarge"
  const vmRes = [
    new RegExp(String.raw`(?<![\w.])(\d+|${Object.keys(NUM_WORDS).join("|")})\s*(?:x|×)?\s*(?:[a-z0-9-]+\s+){0,4}?(${SKU})(?![\w.])`, "g"),
    new RegExp(String.raw`(?<![\w.])(${SKU})\s*(?:x|×|\(x?)\s*(\d+)\b`, "g"),
  ];
  for (const part of parts) {
    const seen = new Set<string>();
    const hits: { index: number; count: number; sku: string }[] = [];
    for (const [i, re] of vmRes.entries()) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(part))) {
        const [countRaw, skuRaw] = i === 0 ? [m[1], m[2]] : [m[2], m[1]];
        const count = NUM_WORDS[countRaw] ?? Number(countRaw);
        if (seen.has(skuRaw) || !count || !resolveVm(skuRaw)) continue;
        seen.add(skuRaw);
        hits.push({ index: m.index, count, sku: skuRaw });
      }
    }
    hits.sort((a, b) => a.index - b.index);
    hits.forEach((h, k) => {
      // Role comes from the words describing THIS fleet (up to the next fleet mention), then the whole clause.
      const window = part.slice(h.index, hits[k + 1]?.index ?? part.length);
      const role = clauseRole(window) ?? clauseRole(part);
      const vm = resolveVm(h.sku)!;
      components.push({ id: id("vm"), kind: "compute.vm", provider: vm.provider, label: `${h.count} × ${vm.sku}${role ? ` (${role})` : ""}`, sku: vm.sku, region: regionFor(vm.provider), role, usage: { count: h.count } });
    });
    // Fleets without an instance type: "40 VMs", "12 servers"
    if (!seen.size && !/app service/.test(part)) {
      const g = /(?<![\w.])(\d+)\s+(?:[a-z-]+\s+){0,2}?(?:vms?|virtual machines|instances|servers|ec2 instances)\b/.exec(part);
      if (g) {
        const n = Number(g[1]);
        const sku = provider === "aws" ? "m5.xlarge" : provider === "azure" ? "Standard_D4s_v5" : "n2-standard-4";
        assumptions.push(`${n} unspecified instances assumed to be ${sku} (4 vCPU / 16 GiB).`);
        components.push({ id: id("vm"), kind: "compute.vm", provider, label: `${n} × ${sku} (assumed size)`, sku, region, role: clauseRole(part), usage: { count: n } });
      }
    }
  }

  // --- Load balancer
  if (/\b(alb|elb|nlb|load balancers?|application gateway|app gateway)\b/.test(q)) {
    const gb = sizeGb(q, /(\d+(?:\.\d+)?)\s*(tb|gb)\s*(?:\/|per)\s*(?:mo|month)\s*(?:through|via|processed by)\s*(?:the\s*)?(?:alb|lb|load balancer)/);
    if (!gb) assumptions.push("Load balancer processes 5 TB/month.");
    components.push({ id: id("lb"), kind: "network.load_balancer", provider, label: serviceName("network.load_balancer", provider), region, role: "web", usage: { gb: gb || 5000 } });
  }

  // --- Relational databases (count-aware; self-managed databases on VMs are VMs, not RDS)
  for (const part of parts) {
    if (!/\b(aurora|rds|postgres(?:ql)?|mysql|mariadb|sql server|azure sql|cloud sql|database)\b/.test(part)) continue;
    if (/\b(dynamo|cosmos|spanner|firestore|bigquery|redshift|snowflake)\b/.test(part)) continue;
    if (/\bon (?:the )?(?:vms?|ec2|instances)\b|self-managed/.test(part) || new RegExp(SKU).test(part)) continue;
    const count = Number(/(?<![\w.])(\d+)\s+(?:[a-z]+\s+){0,2}?(?:databases|dbs|rds instances|clusters)\b/.exec(part)?.[1] ?? 1);
    const storageGb = sizeGb(part, /(\d+(?:\.\d+)?)\s*(tb|gb)\b/) || 500;
    const dbProvider: Provider = /azure sql/.test(part) ? "azure" : /cloud sql/.test(part) ? "gcp" : provider;
    const vcores = Number(/(\d+)\s*v?cores?/.exec(part)?.[1] ?? 0);
    if (dbProvider === "aws" && !vcores) {
      const cls = /\b(db\.[a-z0-9]+\.\d*x?large)\b/.exec(part)?.[1];
      const sku = cls && PRICES.dbInstance[cls] ? cls : "db.r5.xlarge";
      if (!cls) assumptions.push(`Database sized as ${sku}${storageGb === 500 ? " with 500 GB" : ""}.`);
      components.push({ id: id("db"), kind: "db.instance", provider: "aws", label: `${count > 1 ? `${count} × ` : ""}${/aurora/.test(part) ? "Aurora" : "RDS"} ${sku}`, sku, region: regionFor("aws"), role: "stateful", usage: { count, multiAz: /multi.?az|high availability|\bha\b/.test(part), storageGb } });
    } else {
      if (!vcores) assumptions.push("Database sized at 8 vCores.");
      components.push({ id: id("db"), kind: "db.vcore", provider: dbProvider, label: serviceName("db.vcore", dbProvider), region: regionFor(dbProvider), role: "stateful", usage: { vcores: (vcores || 8) * count, storageGb: storageGb * count } });
    }
  }

  // --- Object storage: every clause with a size + storage service
  for (const part of parts) {
    const gb = sizeGb(part, /(\d+(?:\.\d+)?)\s*(tb|gb|pb)\b[^.]*?\b(s3|blob|gcs|cloud storage|object storage|buckets?|data lake|storage)\b/);
    if (!gb || /\b(scanned|queried|egress|logs?)\b/.test(part)) continue;
    const p: Provider = /\bblob\b/.test(part) ? "azure" : /\b(gcs|cloud storage)\b/.test(part) ? "gcp" : /\bs3\b/.test(part) ? "aws" : provider;
    components.push({ id: id("obj"), kind: "storage.object", provider: p, label: serviceName("storage.object", p), region: regionFor(p), role: "stateful", usage: { gb, tier: "hot" } });
  }

  // --- Managed cache (only when not self-managed on VMs in the same clause)
  for (const part of parts) {
    if (!/\b(redis|memcached|elasticache|memorystore|cache)\b/.test(part)) continue;
    if (new RegExp(SKU).test(part) || /\bon (?:the )?(?:vms?|ec2|instances)\b|self-managed/.test(part)) continue;
    const mem = sizeGb(part, /(\d+(?:\.\d+)?)\s*(gb|tb)\b/) || 26;
    if (mem === 26) assumptions.push("Managed cache sized at 26 GB per node, 2 nodes.");
    components.push({ id: id("cache"), kind: "cache.managed", provider, label: serviceName("cache.managed", provider), region, role: "stateful", usage: { memGb: mem, count: 2 } });
  }

  // --- NAT, egress, CDN, App Service plans, serverless, analytics, logs
  const natClause = parts.find((p) => /\bnat\b/.test(p));
  if (natClause) {
    const gb = /\b(s3|storage|egress|blob|gcs)\b/.test(natClause) ? 0 : sizeGb(natClause, /(\d+(?:\.\d+)?)\s*(tb|gb)\b/);
    if (!gb) assumptions.push("NAT gateways process 10 TB/month.");
    components.push({ id: id("nat"), kind: "network.nat_gateway", provider, label: serviceName("network.nat_gateway", provider), region, usage: { count: 2, gb: gb || 10_000 } });
  }
  const egressGb = sizeGb(q, /(\d+(?:\.\d+)?)\s*(tb|gb)\s*(?:of\s*)?(?:internet\s*)?(?:egress|outbound|transfer|bandwidth)/);
  const cdn = /\b(cloudfront|cdn|front door|cloud cdn|akamai|fastly)\b/.test(q);
  if (cdn) {
    if (!egressGb) assumptions.push("CDN delivers 10 TB/month.");
    components.push({ id: id("cdn"), kind: "network.cdn", provider, label: serviceName("network.cdn", provider), usage: { gb: egressGb || 10_240, requestsM: 100 } });
  } else if (egressGb) {
    components.push({ id: id("eg"), kind: "network.egress", provider, label: "Internet egress", usage: { gb: egressGb, destination: "internet" } });
  }
  for (const part of parts) {
    const plan = /\b(p[123]v3|s1)\b/.exec(part);
    if (!plan || !/app service/.test(part)) continue;
    const n = Number(/(?<![\w.])(\d+)\s+(?:[a-z-]+\s+){0,3}?(?:instances|plans?)\b/.exec(part)?.[1] ?? /(?<![\w.])(\d+)\b/.exec(part)?.[1] ?? 1);
    const sku = Object.keys(PRICES.appPlatformPlan).find((k) => k.toLowerCase() === plan[1]) ?? "P1v3";
    components.push({ id: id("plan"), kind: "app.plan", provider: "azure", label: `App Service ${sku}`, sku, region: regionFor("azure"), role: "web", usage: { count: n } });
  }

  // --- Traffic
  let reqM: number | undefined;
  const req =
    /(\d+(?:\.\d+)?)\s*(k|m|million|b|billion)?\s*(?:requests|reqs|req|calls|invocations)\s*(?:\/|per|a)\s*(?:mo|month)/.exec(q) ??
    /(\d+(?:\.\d+)?)\s*(k|m|million|b|billion)\s*(?:requests|reqs|req|calls|invocations)\b/.exec(q);
  if (req) reqM = Number(req[1]) * ({ k: 0.001, m: 1, million: 1, b: 1000, billion: 1000 }[req[2] ?? "m"] ?? 1);
  const rps = /(\d+(?:\.\d+)?)\s*(k)?\s*(?:rps|req(?:uests)?\s*(?:\/|per)\s*s(?:ec(?:ond)?)?)\b/.exec(q);
  if (reqM === undefined && rps) {
    const value = Number(rps[1]) * (rps[2] ? 1000 : 1);
    const isPeak = /peak/.test(q.slice(Math.max(0, rps.index - 30), rps.index + rps[0].length + 10));
    reqM = Math.round((isPeak ? value / 3 : value) * 2.628);
    assumptions.push(isPeak ? `Average traffic assumed at 1/3 of the ${value.toLocaleString()} rps peak (≈${reqM.toLocaleString()}M requests/month).` : `${value.toLocaleString()} rps ≈ ${reqM.toLocaleString()}M requests/month.`);
  }
  if (/\b(api gateway|apigee|api management)\b/.test(q) && /\b(lambda|functions?|cloud run)\b/.test(q)) {
    const r = reqM ?? 100;
    if (reqM === undefined) assumptions.push("Serverless stack assumed at 100M requests/month.");
    components.push(
      { id: id("api"), kind: "network.api_gateway", provider, label: serviceName("network.api_gateway", provider), region, role: "web", usage: { requestsM: r, tier: "http" } },
      { id: id("fn"), kind: "compute.function", provider, label: serviceName("compute.function", provider), region, role: "web", usage: { requestsM: r, avgDurationMs: 150, memoryMb: 1024 } },
    );
  }
  if (/\b(bigquery|athena|synapse)\b/.test(q)) {
    const p: Provider = /bigquery/.test(q) ? "gcp" : /synapse/.test(q) ? "azure" : "aws";
    const scanned = sizeGb(q, /(\d+(?:\.\d+)?)\s*(tb|pb|gb)\s*(?:scanned|queried|processed)\b/);
    if (!scanned) assumptions.push("Analytics warehouse scans 50 TB/month.");
    components.push({ id: id("wh"), kind: "analytics.warehouse", provider: p, label: serviceName("analytics.warehouse", p), region: regionFor(p), usage: { gb: scanned || 51_200 } });
  }
  const logsGb = sizeGb(q, /(\d+(?:\.\d+)?)\s*(tb|gb)\s*(?:of\s*)?logs?\b/);
  if (logsGb) components.push({ id: id("logs"), kind: "observability.logs", provider, label: serviceName("observability.logs", provider), usage: { gb: logsGb } });

  // --- Profile
  const cpu = /(\d+(?:\.\d+)?)\s*%\s*(?:average\s*|avg\.?\s*|mean\s*)?cpu|cpu\s*(?:utili[sz]ation|usage)?\s*(?:is|at|of|around|~|≈)?\s*(\d+(?:\.\d+)?)\s*%/.exec(q);
  const cold = /(\d+)\s*%\s*(?:of\s*(?:the\s*)?(?:data|objects|storage)\s*)?(?:is\s*)?(?:rarely|not|never)\s*(?:accessed|read)/.exec(q);
  const profile: WorkloadProfile = {
    trafficPattern: /spiky|burst|peaks?|seasonal|unpredictable|black friday|flash sale/.test(q)
      ? "spiky"
      : /business.?hours|office.?hours|9.?to.?5|daytime|working.?hours/.test(q)
        ? "business_hours"
        : /steady|constant|24\/7|flat/.test(q)
          ? "steady"
          : /\b(batch|nightly|etl|cron)\b/.test(q) && !/\b(api|web|frontend)\b/.test(q)
            ? "batch"
            : "unknown",
    stateless: /stateless|rest api|http api|web app|\bapi\b|web tier|frontend/.test(q) && !/\bstateful\b/.test(q),
    interruptible: /\b(batch|spot|interrupt|fault.?tolerant|retr(y|yable)|etl|render|idempotent)\b/.test(q),
    latencySensitive: /latency.?sensitive|real.?time|low.?latency|trading|gaming|sub-?millisecond/.test(q),
    requestsPerMonthM: reqM,
    cpuUtilization: cpu ? Number(cpu[1] ?? cpu[2]) / 100 : undefined,
    coldShare: cold ? Number(cold[1]) / 100 : undefined,
  };

  const unrecognized = UNPRICED.filter(([re]) => re.test(q)).map(([, name]) => name);
  return { components, profile, assumptions: [...new Set(assumptions)], unrecognized };
}
