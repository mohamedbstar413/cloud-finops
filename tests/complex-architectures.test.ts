/**
 * Complex-architecture optimization tests.
 *
 * 1. Scenario tests: realistic multi-tier / multi-cloud architectures described in
 *    free text, checked for correct parsing, role-aware proposals and guardrails.
 * 2. Engine tests on a complex connected estate (heterogeneous fleets, SKUs outside
 *    the catalog, duplicate workload names, multi-account, multi-cloud).
 * 3. Property-based fuzzing: hundreds of random estates and architectures, checked
 *    against invariants (finite prices, no double counting, conservation, guardrails).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeComponents } from "../src/lib/ai/normalize";
import { runEngine, totalPotentialSavings } from "../src/lib/engine";
import { analyzeHeuristically, parseArchitectureText, serverlessBreakEvenM, type CustomAnalysis, type WorkloadProfile } from "../src/lib/engine/custom";
import type { ArchitectureSpec, Estate, RecommendationDraft } from "../src/lib/engine/types";
import { planFromKeywords, simulate, TRANSFORM_LABEL, type WhatIfTransform } from "../src/lib/engine/whatif";
import { downsizeVm, inferVmShape, PROVIDERS, resolveVm } from "../src/lib/pricing/catalog";
import { COMPONENT_KINDS, priceComponent, priceComponents, type Component } from "../src/lib/pricing/components";
import { complexEstate, randomArchitecture, randomEstate, rng } from "./fixtures";

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/** Multiply fuzz iterations, e.g. FUZZ_RUNS=10 npm test. */
const RUNS = Math.max(1, Number(process.env.FUZZ_RUNS ?? 1));

const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const analyze = (text: string): CustomAnalysis => {
  const p = parseArchitectureText(text);
  return analyzeHeuristically(p.components, p.profile, { assumptions: p.assumptions, unrecognized: p.unrecognized });
};
const kinds = (a: CustomAnalysis) => a.current.components.map((c) => c.kind);
const vmsOf = (a: CustomAnalysis) => a.current.components.filter((c) => c.kind === "compute.vm");
const origin = (id: string) => id.split("~")[0];

function assertSpecIntegrity(spec: ArchitectureSpec | undefined, where: string) {
  if (!spec) return;
  const ids = spec.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, `${where}: duplicate diagram node ids`);
  for (const e of spec.edges) assert.ok(ids.includes(e.from) && ids.includes(e.to), `${where}: edge ${e.from}→${e.to} references a missing node`);
  const sum = spec.components.reduce((s, c) => s + c.monthlyCost, 0);
  assert.ok(Math.abs(sum - spec.monthlyCost) < 0.05 + spec.components.length * 0.01, `${where}: spec total ${spec.monthlyCost} ≠ Σ components ${sum}`);
}

function assertEngineInvariants(estate: Estate, recs: RecommendationDraft[], label: string) {
  const resourceIds = new Set(estate.resources.map((r) => r.id));
  const fps = recs.map((r) => r.fingerprint);
  assert.equal(new Set(fps).size, fps.length, `${label}: duplicate fingerprints`);
  const primary = recs.filter((r) => !r.overlapsWith);
  const primaryFps = new Set(primary.map((r) => r.fingerprint));
  const claimed = new Set<string>();
  for (const r of recs) {
    const where = `${label} / ${r.title}`;
    for (const k of ["currentMonthlyCost", "projectedMonthlyCost", "monthlySavings", "savingsPct", "migrationCost", "confidence"] as const) {
      assert.ok(finite(r[k]), `${where}: ${k} is not finite (${r[k]})`);
    }
    assert.ok(r.monthlySavings >= 0 && r.monthlySavings <= r.currentMonthlyCost + 0.01, `${where}: savings ${r.monthlySavings} outside [0, ${r.currentMonthlyCost}]`);
    assert.ok(r.projectedMonthlyCost >= 0, `${where}: negative projected cost`);
    assert.ok(r.savingsPct >= 0 && r.savingsPct <= 100, `${where}: savingsPct ${r.savingsPct}`);
    assert.ok(r.migrationCost >= 0, `${where}: negative migration cost`);
    assert.ok(r.details.rollout.startWeek >= 0 && r.details.rollout.startWeek <= r.details.rollout.fullWeek, `${where}: invalid rollout`);
    for (const id of r.resourceIds) assert.ok(resourceIds.has(id), `${where}: unknown resource ${id}`);
    if (r.overlapsWith) assert.ok(primaryFps.has(r.overlapsWith), `${where}: overlapsWith points to a non-primary recommendation`);
    assertSpecIntegrity(r.details.current, `${where} (current)`);
    assertSpecIntegrity(r.details.proposed, `${where} (proposed)`);
  }
  for (const r of primary) {
    for (const id of r.resourceIds) {
      assert.ok(!claimed.has(id), `${label}: resource ${id} is claimed by two primary recommendations (double-counted savings)`);
      claimed.add(id);
    }
  }
  const spend = estate.resources.reduce((s, r) => s + r.monthlyCost, 0);
  assert.ok(totalPotentialSavings(recs) <= spend + 0.01, `${label}: potential savings exceed total spend`);
}

function assertCustomInvariants(a: CustomAnalysis, profile: WorkloadProfile, label: string) {
  assert.ok(finite(a.current.monthlyCost) && a.current.monthlyCost >= 0, `${label}: current cost ${a.current.monthlyCost}`);
  const currentById = new Map(a.current.components.map((c) => [c.id, c]));
  const storageGb = (cs: Component[]) => cs.filter((c) => c.kind === "storage.object").reduce((s, c) => s + (c.usage.gb ?? 0), 0);
  const curGb = storageGb(a.current.components);
  const hasDb = a.current.components.some((c) => c.kind.startsWith("db."));
  for (const p of a.proposals) {
    const where = `${label} / ${p.title}`;
    for (const c of p.components) assert.ok(finite(c.monthlyCost), `${where}: component ${c.label} priced ${c.monthlyCost}`);
    assert.ok(finite(p.monthlyCost) && p.monthlyCost < a.current.monthlyCost, `${where}: proposal is not cheaper (${p.monthlyCost} vs ${a.current.monthlyCost})`);
    assert.ok(p.savingsPct > 0 && p.savingsPct <= 100, `${where}: savingsPct ${p.savingsPct}`);
    assert.ok(p.migrationCost >= 0, `${where}: migration cost ${p.migrationCost}`);
    assert.ok(p.migrationCost / p.monthlySavings <= 36 + 1e-9, `${where}: payback beyond 36 months was not filtered`);
    // Conservation: object storage is re-tiered or moved, never lost.
    assert.ok(Math.abs(storageGb(p.components) - curGb) < 1e-6 * Math.max(1, curGb), `${where}: object storage not conserved (${storageGb(p.components)} vs ${curGb} GB)`);
    // Data stores are kept or converted, never dropped.
    if (hasDb) assert.ok(p.components.some((c) => c.kind.startsWith("db.")), `${where}: database disappeared`);
    for (const c of p.components) {
      const src = currentById.get(origin(c.id));
      // Guardrail: Spot only for batch tiers or Kubernetes Spot pools, and never for latency-sensitive systems.
      if (c.usage.spot && !src?.usage.spot) {
        assert.ok(!profile.latencySensitive, `${where}: Spot proposed for a latency-sensitive system`);
        assert.ok(src && (src.role === "batch" || src.role === "k8s" || (!src.role && profile.interruptible && profile.trafficPattern === "batch")), `${where}: Spot applied to a non-batch tier (${c.label})`);
      }
      if (c.kind === "compute.function" && !a.current.components.some((x) => x.kind === "compute.function")) {
        assert.ok(!profile.latencySensitive, `${where}: serverless proposed for a latency-sensitive system`);
        assert.ok(profile.requestsPerMonthM !== undefined, `${where}: serverless proposed without a known request volume`);
      }
    }
    // Stateful VMs survive every same-cloud proposal unchanged in kind.
    if (p.strategy !== "cross_cloud") {
      for (const vm of a.current.components.filter((c) => c.kind === "compute.vm" && c.role === "stateful")) {
        assert.ok(p.components.some((c) => origin(c.id) === vm.id && c.kind === "compute.vm" && !c.usage.spot), `${where}: stateful tier ${vm.label} was replaced`);
      }
    }
  }
}

/* ------------------------------------------------------------------------- */
/* 1. Pricing for instance types outside the catalog                          */
/* ------------------------------------------------------------------------- */

describe("instance types outside the price catalog", () => {
  const hourly = (sku: string) => resolveVm(sku)!.hourly;

  it("infers shapes from AWS, Azure and GCP naming schemes", () => {
    assert.deepEqual(inferVmShape("m6i.2xlarge"), { provider: "aws", family: "m6i", vcpu: 8, memGiB: 32, arch: "x86", profile: "general" });
    assert.equal(inferVmShape("c7g.xlarge")!.arch, "arm");
    assert.equal(inferVmShape("r6i.4xlarge")!.memGiB, 128);
    assert.deepEqual(inferVmShape("Standard_D32as_v5"), { provider: "azure", family: "DAS", vcpu: 32, memGiB: 128, arch: "x86", profile: "general" });
    assert.equal(inferVmShape("Standard_E16ps_v5")!.arch, "arm");
    assert.deepEqual(inferVmShape("n2d-highmem-16"), { provider: "gcp", family: "n2d", vcpu: 16, memGiB: 128, arch: "x86", profile: "memory" });
    assert.equal(inferVmShape("m5.metal"), undefined);
    assert.equal(inferVmShape("not-a-vm"), undefined);
  });

  it("prices inferred types consistently with catalog neighbours", () => {
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) / b <= tol;
    assert.ok(near(hourly("m6i.2xlarge"), hourly("m5.2xlarge"), 0.15));
    assert.ok(near(hourly("Standard_D32s_v5"), 2 * hourly("Standard_D16s_v5"), 0.01));
    assert.ok(near(hourly("n2-standard-32"), 2 * hourly("n2-standard-16"), 0.05));
    assert.ok(hourly("c7g.xlarge") < hourly("c5.xlarge"), "Arm should price below x86");
    assert.ok(resolveVm("m6i.2xlarge")!.estimated);
    assert.ok(!("estimated" in resolveVm("m5.2xlarge")!) || !resolveVm("m5.2xlarge")!.estimated);
  });

  it("never falls back to a flat default rate for known naming schemes", () => {
    const p = priceComponent({ id: "x", kind: "compute.vm", provider: "aws", label: "", sku: "r6i.4xlarge", usage: { count: 6 } });
    assert.ok(p.monthlyCost > 3000 && p.monthlyCost < 6000, `r6i.4xlarge ×6 priced at ${p.monthlyCost}`);
    assert.match(p.pricingNote, /estimated from instance shape/);
  });

  it("downsizes inferred types along the provider's size ladder", () => {
    assert.equal(downsizeVm("m6i.2xlarge")!.sku, "m6i.xlarge");
    assert.equal(downsizeVm("m6i.xlarge")!.sku, "m6i.large");
    assert.equal(downsizeVm("Standard_D16as_v5")!.sku, "Standard_D8as_v5");
    assert.equal(downsizeVm("n2d-standard-8")!.sku, "n2d-standard-4");
    assert.equal(downsizeVm("m6i.large"), undefined);
  });

  it("prices managed cache realistically (≈ $300/month for a 26 GB node)", () => {
    const c = priceComponent({ id: "c", kind: "cache.managed", provider: "aws", label: "", usage: { memGb: 26, count: 1 } });
    assert.ok(c.monthlyCost > 200 && c.monthlyCost < 450, `26 GB cache priced ${c.monthlyCost}`);
  });

  it("looks up plan and DB classes case-insensitively", () => {
    const a = priceComponent({ id: "a", kind: "app.plan", provider: "azure", label: "", sku: "P3V3", usage: { count: 1 } });
    const b = priceComponent({ id: "b", kind: "app.plan", provider: "azure", label: "", sku: "P3v3", usage: { count: 1 } });
    assert.equal(a.monthlyCost, b.monthlyCost);
  });
});

/* ------------------------------------------------------------------------- */
/* 2. Free-text parsing of complex architectures                              */
/* ------------------------------------------------------------------------- */

describe("parsing complex architecture descriptions", () => {
  it("parses a multi-tier e-commerce platform completely", () => {
    const p = parseArchitectureText(
      "E-commerce platform on AWS: 20 m6i.2xlarge web tier behind an ALB, 12 c6g.xlarge API servers, 6 r6i.4xlarge running self-managed Redis, Aurora Postgres Multi-AZ, 200 TB in S3, CloudFront, NAT gateway, 50 TB egress per month, 1.2 billion requests/month, spiky with Black Friday peaks.",
    );
    const vms = p.components.filter((c) => c.kind === "compute.vm");
    assert.deepEqual(vms.map((v) => [v.sku, v.usage.count, v.role]), [
      ["m6i.2xlarge", 20, "web"],
      ["c6g.xlarge", 12, "web"],
      ["r6i.4xlarge", 6, "stateful"],
    ]);
    const db = p.components.find((c) => c.kind === "db.instance")!;
    assert.ok(db.usage.multiAz);
    assert.equal(p.components.find((c) => c.kind === "storage.object")!.usage.gb, 200 * 1024);
    assert.equal(p.components.find((c) => c.kind === "network.cdn")!.usage.gb, 50 * 1024);
    assert.equal(p.components.find((c) => c.kind === "network.nat_gateway")!.usage.gb, 10_000, "NAT must not absorb the S3 volume");
    assert.ok(!p.components.some((c) => c.kind === "cache.managed"), "self-managed Redis on VMs is not a managed cache");
    assert.equal(p.profile.requestsPerMonthM, 1200);
    assert.equal(p.profile.trafficPattern, "spiky");
  });

  it("handles count-after, words-between and digit-inside-word phrasings", () => {
    const after = parseArchitectureText("Our API runs on m5.xlarge x 10 behind a load balancer.");
    assert.equal(after.components.find((c) => c.kind === "compute.vm")!.usage.count, 10);
    const between = parseArchitectureText("We have 24 EC2 m5.large instances for the web frontend and 8 EC2 instances of type c5.2xlarge for batch jobs.");
    const vms = between.components.filter((c) => c.kind === "compute.vm");
    assert.deepEqual(vms.map((v) => [v.sku, v.usage.count, v.role]), [
      ["m5.large", 24, "web"],
      ["c5.2xlarge", 8, "batch"],
    ]);
  });

  it("assigns roles per fleet across clouds", () => {
    const p = parseArchitectureText("10 n2-standard-8 on GCP running a stateless API; 6 Standard_D8s_v5 on Azure running batch ETL; 100 TB in Cloud Storage.");
    const vms = p.components.filter((c) => c.kind === "compute.vm");
    assert.deepEqual(vms.map((v) => [v.provider, v.role]), [
      ["gcp", "web"],
      ["azure", "batch"],
    ]);
    assert.equal(p.components.find((c) => c.kind === "storage.object")!.provider, "gcp");
  });

  it("keeps a database that shares a sentence with VM fleets", () => {
    const p = parseArchitectureText("Low-latency trading engine: 16 c5.4xlarge, stateful, steady 24/7, latency-sensitive, Postgres RDS, 5 TB S3.");
    assert.ok(p.components.some((c) => c.kind === "db.instance"));
    const az = parseArchitectureText("Azure: 4 App Service P3v3 instances, AKS with 20 Standard_D16s_v5 nodes, Azure SQL 32 vCores, 500 TB blob storage.");
    assert.equal(az.components.find((c) => c.kind === "db.vcore")!.usage.vcores, 32);
    assert.equal(az.components.find((c) => c.kind === "app.plan")!.sku, "P3v3");
    assert.equal(az.components.find((c) => c.kind === "compute.vm")!.role, "k8s");
  });

  it("converts peak rps to monthly requests and records the assumption", () => {
    const p = parseArchitectureText("Stateless REST API on 8 m5.2xlarge, peaks at 3000 rps, ALB, spiky.");
    assert.equal(p.profile.requestsPerMonthM, Math.round(1000 * 2.628));
    assert.ok(p.assumptions.some((a) => a.includes("1/3 of the 3,000 rps peak")));
  });

  it("detects regions, CPU utilisation and cold-data share", () => {
    const p = parseArchitectureText("Stateless web app on 10 e2-standard-8 in europe-west1 behind a load balancer, 18% average CPU, 70% of data rarely accessed, 40 TB in Cloud Storage.");
    assert.equal(p.components.find((c) => c.kind === "compute.vm")!.region, "europe-west1");
    assert.equal(p.profile.cpuUtilization, 0.18);
    assert.equal(p.profile.coldShare, 0.7);
  });

  it("reports services it cannot price instead of silently ignoring them", () => {
    const p = parseArchitectureText("API Gateway with Lambda functions, 50M requests/month, DynamoDB, Kafka on MSK, 2 TB in S3.");
    assert.deepEqual(p.unrecognized, ["DynamoDB", "Managed Kafka / Event Hubs"]);
    assert.ok(p.components.some((c) => c.kind === "compute.function"));
  });
});

/* ------------------------------------------------------------------------- */
/* 3. Role-aware optimization of complex architectures                        */
/* ------------------------------------------------------------------------- */

describe("optimizing complex architectures", () => {
  it("e-commerce: prefers containers over serverless at 1.2B requests and keeps stateful Redis", () => {
    const a = analyze(
      "E-commerce platform on AWS: 20 m6i.2xlarge web tier behind an ALB, 12 c6g.xlarge API servers, 6 r6i.4xlarge running self-managed Redis, Aurora Postgres Multi-AZ, 200 TB in S3, CloudFront, NAT gateway, 50 TB egress per month, 1.2 billion requests/month, spiky with Black Friday peaks.",
    );
    assertCustomInvariants(a, a.profile, "ecommerce");
    assert.ok(a.proposals.length >= 2);
    assert.ok(!a.proposals.some((p) => p.components.some((c) => c.kind === "compute.function")));
    assert.ok(a.insights.some((i) => i.includes("containers") && i.includes("cheaper still")));
    assert.ok(a.insights.some((i) => i.includes("estimated from instance shape")));
    const move = a.proposals.find((p) => p.strategy === "cross_cloud");
    if (move) assert.ok(move.migrationCost > 12 * 4000, "cross-cloud migration must include the one-time data transfer");
  });

  it("high traffic: rejects serverless when it would cost more, with a break-even", () => {
    const a = analyze("Stateless REST API on 8 m5.2xlarge, peaks at 3000 rps, ALB, spiky.");
    assertCustomInvariants(a, a.profile, "rps");
    assert.ok(!a.proposals.some((p) => p.strategy === "serverless"));
    assert.ok(a.insights.some((i) => /break-even is ~[\d,]+M requests\/month, so it is not recommended/.test(i)));
  });

  it("low traffic: recommends serverless", () => {
    const a = analyze("Our API runs on m5.xlarge x 10 behind a load balancer with 50M requests/month, spiky traffic, stateless.");
    assertCustomInvariants(a, a.profile, "low-traffic");
    assert.equal(a.proposals[0].strategy, "serverless");
  });

  it("unknown traffic: no serverless guess, but a break-even hint", () => {
    const a = analyze("Stateless web app on 10 e2-standard-8 behind a load balancer, business hours.");
    assertCustomInvariants(a, a.profile, "unknown-traffic");
    assert.ok(!a.proposals.some((p) => p.components.some((c) => c.kind === "compute.function")));
    const be = serverlessBreakEvenM("gcp", a.current.monthlyCost);
    assert.ok(be > 0);
    assert.ok(a.insights.some((i) => i.startsWith("Request volume not given")));
  });

  it("latency-sensitive stateful system: no Spot, no serverless, stateful tier kept", () => {
    const a = analyze("Low-latency trading engine: 16 c5.4xlarge, stateful, steady 24/7, latency-sensitive, Postgres RDS, 5 TB S3.");
    assertCustomInvariants(a, a.profile, "trading");
    for (const p of a.proposals) {
      assert.ok(!p.components.some((c) => c.usage.spot), `${p.title} uses Spot`);
      assert.ok(!p.components.some((c) => c.kind === "compute.function" || c.kind === "compute.container"), `${p.title} re-architects the engine`);
    }
  });

  it("mixed tiers: Spot only for the batch fleet", () => {
    const a = analyze("We have 24 EC2 m5.large instances for the web frontend and 8 EC2 instances of type c5.2xlarge for batch jobs, plus 30 TB in S3.");
    assertCustomInvariants(a, a.profile, "mixed");
    const web = vmsOf(a).find((v) => v.role === "web")!;
    for (const p of a.proposals) {
      assert.ok(!p.components.some((c) => origin(c.id) === web.id && c.usage.spot), `${p.title} put the web tier on Spot`);
    }
    assert.ok(a.proposals.some((p) => p.components.some((c) => c.usage.spot)), "batch tier should get Spot somewhere");
  });

  it("multi-cloud: batch on Azure gets Spot, API on GCP stays on-demand", () => {
    const a = analyze("Hybrid: 10 n2-standard-8 on GCP running a stateless API; 6 Standard_D8s_v5 on Azure running batch ETL; BigQuery analytics with 80 TB scanned per month; 100 TB in Cloud Storage.");
    assertCustomInvariants(a, a.profile, "multicloud");
    const spotProviders = new Set(a.proposals.flatMap((p) => p.components.filter((c) => c.usage.spot).map((c) => c.provider)));
    assert.deepEqual([...spotProviders], ["azure"]);
    assert.ok(kinds(a).includes("analytics.warehouse"));
  });

  it("enterprise Azure: bin-packs AKS with stated utilisation and keeps SQL", () => {
    const a = analyze("Azure: 4 App Service P3v3 instances, AKS with 20 Standard_D16s_v5 nodes, Azure SQL 32 vCores, 500 TB blob storage, business-hours usage, 15% average CPU.");
    assertCustomInvariants(a, a.profile, "azure-enterprise");
    const modern = a.proposals.find((p) => p.title.startsWith("Modernize"))!;
    const nodes = modern.components.filter((c) => c.kind === "compute.vm").reduce((s, c) => s + (c.usage.count ?? 0), 0);
    assert.ok(nodes < 20 && nodes >= 3, `bin-packed node count ${nodes}`);
  });

  it("already-efficient architecture: drops changes that never pay back", () => {
    const a = analyze("API Gateway with Lambda functions, 50M requests/month, DynamoDB, 2 TB in S3.");
    assertCustomInvariants(a, a.profile, "serverless");
    assert.ok(a.proposals.every((p) => p.migrationCost / p.monthlySavings <= 36));
    assert.ok(a.unrecognized.includes("DynamoDB"));
  });
});

/* ------------------------------------------------------------------------- */
/* 4. Connected-estate engine on a complex, messy estate                      */
/* ------------------------------------------------------------------------- */

describe("engine on a complex connected estate", () => {
  const estate = complexEstate();
  const recs = runEngine(estate);

  it("holds every invariant", () => assertEngineInvariants(estate, recs, "complex"));

  it("prices a heterogeneous batch fleet per instance group (not as N copies of the first SKU)", () => {
    const x = recs.find((r) => r.detector === "arch.cross_cloud")!;
    assert.ok(x, "expected a cross-cloud/spot recommendation for etl");
    const proposedVms = x.details.proposed!.components.filter((c) => c.kind === "compute.vm");
    assert.equal(proposedVms.length, 2, "one proposed VM group per current group");
    assert.deepEqual(proposedVms.map((c) => c.usage.count).sort((a, b) => a! - b!), [6, 10]);
    const disk = x.details.proposed!.components.find((c) => c.kind === "storage.block")!;
    assert.equal(disk.usage.gb, 16 * 300, "block storage must count every volume");
  });

  it("moves etl next to its Azure data (egress-aware)", () => {
    const x = recs.find((r) => r.detector === "arch.cross_cloud")!;
    assert.equal(x.targetProvider, "azure");
  });

  it("keeps same-named workloads in different accounts separate", () => {
    const apiRecs = recs.filter((r) => r.resourceIds.includes("api-a") || r.resourceIds.includes("api-b"));
    for (const r of apiRecs) assert.ok(!(r.resourceIds.includes("api-a") && r.resourceIds.includes("api-b")), `${r.title} merged two accounts`);
    assert.ok(recs.some((r) => r.detector === "arch.serverless" && r.resourceIds.includes("api-a")));
  });

  it("bin-packs Kubernetes pools with SKUs outside the catalog", () => {
    assert.ok(recs.some((r) => r.detector === "arch.k8s_spot" && r.resourceIds.includes("eks")));
    assert.ok(recs.some((r) => r.detector === "arch.k8s_spot" && r.resourceIds.includes("aks")));
    assert.ok(!recs.some((r) => r.detector === "arch.k8s_spot" && r.resourceIds.includes("gke")), "a well-utilised pool must be left alone");
  });

  it("never recommends terminating stopped instances or pricing them", () => {
    assert.ok(!recs.some((r) => r.resourceIds.includes("stopped")));
  });

  it("what-if simulations never double count and balance per provider", () => {
    const types = Object.keys(TRANSFORM_LABEL) as WhatIfTransform["type"][];
    const all = simulate(estate, { interpretation: "", assumptions: [], transforms: types.map((type) => ({ type, providers: [], workloads: [], environments: [], commitmentTerm: "3y" })) });
    const ids = all.steps.flatMap((s) => s.items.flatMap((i) => i.resourceIds));
    assert.equal(new Set(ids).size, ids.length, "a resource was changed by two transforms");
    const after = all.byProvider.reduce((s, p) => s + p.after, 0);
    assert.ok(Math.abs(after - all.scenarioMonthly) < 1, `provider split ${after} ≠ scenario ${all.scenarioMonthly}`);
    assert.ok(all.monthlySavings > 0 && all.monthlySavings < all.baselineMonthly);
  });
});

/* ------------------------------------------------------------------------- */
/* 5. Property-based fuzzing                                                  */
/* ------------------------------------------------------------------------- */

describe("property-based fuzzing: random estates", () => {
  it(`runEngine holds all invariants across ${300 * RUNS} random estates and is deterministic`, () => {
    for (let seed = 1; seed <= 300 * RUNS; seed++) {
      const estate = randomEstate(seed);
      const recs = runEngine(estate);
      assertEngineInvariants(estate, recs, `seed ${seed}`);
      const again = runEngine(randomEstate(seed));
      assert.deepEqual(
        again.map((x) => [x.fingerprint, x.monthlySavings]),
        recs.map((x) => [x.fingerprint, x.monthlySavings]),
        `seed ${seed}: non-deterministic output`,
      );
    }
  });

  it("simulate holds invariants for random what-if plans", () => {
    const types = Object.keys(TRANSFORM_LABEL) as WhatIfTransform["type"][];
    for (let seed = 1; seed <= 150 * RUNS; seed++) {
      const r = rng(seed * 7);
      const estate = randomEstate(seed);
      const transforms = types.filter(() => r() < 0.5).map((type) => ({
        type,
        providers: r() < 0.3 ? [PROVIDERS[Math.floor(r() * 3)]] : [],
        workloads: r() < 0.2 ? ["api"] : [],
        environments: r() < 0.2 ? ["prod"] : [],
        commitmentTerm: (r() < 0.5 ? "1y" : "3y") as "1y" | "3y",
      }));
      const res = simulate(estate, { interpretation: "", assumptions: [], transforms });
      const where = `seed ${seed}`;
      for (const k of ["baselineMonthly", "scenarioMonthly", "monthlySavings", "migrationCost"] as const) assert.ok(finite(res[k]), `${where}: ${k}=${res[k]}`);
      assert.ok(res.monthlySavings >= 0 && res.monthlySavings <= res.baselineMonthly + 0.01, `${where}: savings ${res.monthlySavings} of ${res.baselineMonthly}`);
      assert.ok(Math.abs(res.baselineMonthly - res.monthlySavings - res.scenarioMonthly) < 0.05, `${where}: scenario arithmetic`);
      const ids = res.steps.flatMap((s) => s.items.flatMap((i) => i.resourceIds));
      assert.equal(new Set(ids).size, ids.length, `${where}: resource changed twice`);
      for (const p of res.byProvider) assert.ok(p.after >= 0 && finite(p.after), `${where}: provider ${p.provider} after=${p.after}`);
      if (res.paybackMonths !== null) assert.ok(res.paybackMonths >= 0, `${where}: payback ${res.paybackMonths}`);
    }
  });
});

describe("property-based fuzzing: random architectures", () => {
  it(`analyzeHeuristically holds invariants and guardrails across ${500 * RUNS} random architectures`, () => {
    for (let seed = 1; seed <= 500 * RUNS; seed++) {
      const { components, profile } = randomArchitecture(seed);
      const a = analyzeHeuristically(components, profile);
      assertCustomInvariants(a, profile, `seed ${seed}`);
    }
  });

  it("the free-text parser never throws and always yields priceable components", () => {
    const r = rng(42);
    const words = ["20", "m6i.2xlarge", "web", "tier", "behind", "an", "ALB", ",", "Aurora", "Postgres", "Multi-AZ", "200", "TB", "in", "S3", "3000", "rps", "peak", "batch", "ETL", "on", "8", "c5.2xlarge", "x", "12", "Standard_D8s_v5", "Azure", "SQL", "32", "vCores", "NAT", "CloudFront", "BigQuery", "latency-sensitive", "stateful", "50%", "CPU", ";", ".", "and", "plus", "Kubernetes", "nodes", "n2-standard-8", "1.2", "billion", "requests/month", "DynamoDB", "App", "Service", "P3v3", "europe-west1", "EC2"];
    for (let i = 0; i < 400 * RUNS; i++) {
      const text = Array.from({ length: 5 + Math.floor(r() * 40) }, () => words[Math.floor(r() * words.length)]).join(" ");
      const p = parseArchitectureText(text);
      for (const c of p.components) {
        assert.ok((COMPONENT_KINDS as readonly string[]).includes(c.kind));
        const priced = priceComponent(c);
        assert.ok(finite(priced.monthlyCost) && priced.monthlyCost >= 0, `"${text}" → ${c.label} priced ${priced.monthlyCost}`);
      }
      if (p.components.length) assertCustomInvariants(analyzeHeuristically(p.components, p.profile), p.profile, `text #${i}`);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 6. Robustness to malformed LLM output                                      */
/* ------------------------------------------------------------------------- */

describe("AI output normalization", () => {
  it("sanitizes malformed components before pricing", () => {
    const raw = [
      { kind: "compute.vm", provider: "aws", label: "web", sku: "m6i.2xlarge", usage: { count: "12" } },
      { kind: "compute.vm", provider: "gcp", label: "wrong-cloud sku", sku: "m5.large", usage: { count: -3 } },
      { kind: "compute.vm", provider: "azure", label: "hallucinated", sku: "Standard_Z99_v9x", usage: { count: 4, hours: 99999 } },
      { kind: "storage.object", provider: "aws", label: "bucket", usage: { gb: -500, tier: "glacier-deep" } },
      { kind: "network.egress", provider: "mars", label: "egress", usage: { gb: "NaN", destination: "moon" } },
      { kind: "quantum.computer", provider: "aws", label: "nope", usage: {} },
      { kind: "other.fixed", provider: "aws", label: "commit credit", usage: { monthlyCost: -120 } },
      { kind: "db.instance", provider: "aws", label: "db", sku: "db.x99.mega", usage: { multiAz: "yes" } },
      null,
      "string",
    ];
    const cs = normalizeComponents(raw, "aws");
    assert.equal(cs.length, 7, "invalid kinds and non-objects are dropped");
    assert.equal(cs[0].usage.count, 12);
    assert.equal(cs[1].provider, "gcp");
    assert.ok(resolveVm(cs[1].sku)!.provider === "gcp", "VM type is re-mapped to the component's cloud");
    assert.equal(cs[1].usage.count, 1, "negative counts are clamped");
    assert.ok(cs[2].usage.hours! <= 744 * 1.2);
    assert.equal(cs[3].usage.gb, 0);
    assert.equal(cs[3].usage.tier, undefined);
    assert.equal(cs[4].provider, "aws");
    assert.equal(cs[4].usage.destination, undefined);
    assert.equal(cs[5].usage.monthlyCost, -120, "commitment credits may be negative");
    assert.equal(cs[6].sku, "db.r5.xlarge");
    assert.equal(cs[6].usage.multiAz, undefined);
    const { total, components } = priceComponents(cs);
    assert.ok(finite(total));
    for (const c of components) assert.ok(finite(c.monthlyCost) && (c.kind === "other.fixed" || c.monthlyCost >= 0), `${c.label}: ${c.monthlyCost}`);
  });

  it("keyword planner handles mixed intents", () => {
    const plan = planFromKeywords("What if we move batch to spot and put everything on its cheapest cloud, only on AWS?");
    const types = plan.transforms.map((t) => t.type);
    assert.ok(types.includes("spot") && types.includes("cross_cloud_cheapest"));
    assert.ok(!types.includes("serverless"));
  });
});

describe("custom analysis API contract", () => {
  it("keeps component roles through request validation", async () => {
    const { CustomAnalysisRequest } = await import("../src/lib/ai/requests");
    const body = CustomAnalysisRequest.parse({
      components: [
        { id: "a", kind: "compute.vm", provider: "azure", label: "api", sku: "Standard_D8s_v5", role: "web", usage: { count: 12 } },
        { id: "b", kind: "compute.vm", provider: "azure", label: "render farm", sku: "Standard_F16s_v2", role: "batch", usage: { count: 20 } },
        { id: "c", kind: "compute.vm", provider: "azure", label: "kafka", sku: "Standard_E8s_v5", role: "stateful", usage: { count: 5 } },
      ],
      profile: { trafficPattern: "business_hours", requestsPerMonthM: 80 },
    });
    assert.deepEqual(body.components!.map((c) => c.role), ["web", "batch", "stateful"]);
    const cs = normalizeComponents(body.components!, "azure");
    const a = analyzeHeuristically(cs, { trafficPattern: "business_hours", stateless: false, interruptible: false, latencySensitive: false, requestsPerMonthM: 80 });
    assertCustomInvariants(a, a.profile, "api-contract");
    const kafka = cs.find((c) => c.label === "kafka")!;
    for (const p of a.proposals) assert.ok(p.components.some((c) => origin(c.id) === kafka.id && c.kind === "compute.vm"), `${p.title} removed the Kafka cluster`);
    assert.ok(a.proposals.some((p) => p.components.some((c) => c.usage.spot && c.label.includes("render farm"))), "render farm should go to Spot");
  });
});

describe("customers with negotiated discounts", () => {
  it("keeps the effective discount when right-sizing (billed at 80% of list)", () => {
    const list = priceComponent({ id: "x", kind: "compute.vm", provider: "aws", label: "", sku: "m5.2xlarge", usage: { count: 10 } }).monthlyCost;
    const estate: Estate = {
      orgId: "edp",
      accounts: [{ id: "a", provider: "aws", name: "a", externalId: "1", region: "us-east-1" }],
      resources: [
        {
          id: "fleet", accountId: "a", provider: "aws", externalId: "fleet", name: "fleet", kind: "compute.vm", service: "EC2", sku: "m5.2xlarge", region: "us-east-1",
          workload: "svc", environment: "prod", state: "running", quantity: 10, monthlyCost: list * 0.8,
          metrics: { cpuAvg: 10, cpuP95: 25, cpuMax: 50, memP95: 30, dutyCycle: 1 }, config: {}, tags: [], dependsOn: [],
        },
      ],
      daily: [],
    };
    const rec = runEngine(estate).find((r) => r.detector === "rightsizing.vm")!;
    const halfList = priceComponent({ id: "y", kind: "compute.vm", provider: "aws", label: "", sku: "m5.xlarge", usage: { count: 10 } }).monthlyCost;
    assert.ok(Math.abs(rec.projectedMonthlyCost - halfList * 0.8) < 1, `projected ${rec.projectedMonthlyCost} should be ${halfList * 0.8}`);
    assert.ok(Math.abs(rec.monthlySavings - (list - halfList) * 0.8) < 1);
    assert.ok(rec.details.evidence.some((e) => e.label.includes("effective rate") && e.value === "80%"));
  });
});
