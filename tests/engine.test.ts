import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customAnalysisSchema, discoverySchema, enrichmentSchema, narrativeSchema, whatIfPlanSchema } from "../src/lib/ai/schemas";
import { demoSnapshot } from "../src/lib/connectors/demo";
import { DEMO_ACCOUNTS } from "../src/lib/demo/estate";
import { runEngine, totalAtRisk, totalPotentialSavings } from "../src/lib/engine";
import { analyzeHeuristically, parseArchitectureText } from "../src/lib/engine/custom";
import type { Estate, ResourceRow } from "../src/lib/engine/types";
import { planFromKeywords, simulate } from "../src/lib/engine/whatif";
import { priceComponent } from "../src/lib/pricing/components";
import { adoptionAt, project, waterfall } from "../src/lib/projection";

/** Build an in-memory estate from the demo generator (no database needed). */
function demoEstate(): Estate {
  const accounts = DEMO_ACCOUNTS.map((a) => ({ id: a.key, provider: a.provider, name: a.name, externalId: a.externalId, region: a.region }));
  const resources: ResourceRow[] = [];
  const daily: Estate["daily"] = [];
  for (const a of DEMO_ACCOUNTS) {
    const snap = demoSnapshot(a.key, a.externalId);
    snap.resources.forEach((r) =>
      resources.push({ ...r, id: `${a.key}:${r.externalId}`, accountId: a.key, provider: a.provider, sku: r.sku ?? null, workload: r.workload ?? null, environment: r.environment ?? null, dependsOn: [] }),
    );
    snap.costs.forEach((c) => daily.push({ ...c, accountId: a.key, provider: a.provider, workload: c.workload ?? null }));
  }
  return { orgId: "test", accounts, resources, daily };
}

describe("pricing engine", () => {
  it("prices VMs by the hour with region and spot factors", () => {
    const od = priceComponent({ id: "a", kind: "compute.vm", provider: "aws", label: "", sku: "m5.xlarge", region: "us-east-1", usage: { count: 2 } });
    assert.equal(od.monthlyCost, Math.round(0.192 * 730 * 2 * 100) / 100);
    const eu = priceComponent({ id: "b", kind: "compute.vm", provider: "aws", label: "", sku: "m5.xlarge", region: "eu-west-1", usage: {} });
    assert.ok(eu.monthlyCost > od.monthlyCost / 2);
    const spot = priceComponent({ id: "c", kind: "compute.vm", provider: "aws", label: "", sku: "m5.xlarge", usage: { spot: true } });
    assert.ok(spot.monthlyCost < od.monthlyCost / 2 * 0.5);
  });

  it("prices serverless by requests and GB-seconds", () => {
    const fn = priceComponent({ id: "f", kind: "compute.function", provider: "aws", label: "", usage: { requestsM: 100, avgDurationMs: 100, memoryMb: 1024 } });
    // 100M × $0.20/M + 10M GB-s × $0.0000166667
    assert.equal(fn.monthlyCost, Math.round((20 + 10_000_000 * 0.0000166667) * 100) / 100);
  });

  it("treats gateway endpoints as free", () => {
    assert.equal(priceComponent({ id: "e", kind: "network.vpc_endpoint", provider: "aws", label: "", usage: { tier: "gateway" } }).monthlyCost, 0);
  });
});

describe("optimization engine", () => {
  const estate = demoEstate();
  const recs = runEngine(estate);

  it("finds architecture-level recommendations, not just rightsizing", () => {
    const detectors = new Set(recs.map((r) => r.detector));
    for (const d of ["arch.serverless", "arch.cross_cloud", "arch.nat_endpoints", "arch.db_serverless", "arch.app_platform", "arch.k8s_spot", "arch.static_site"]) {
      assert.ok(detectors.has(d), `missing ${d}`);
    }
  });

  it("recommends moving batch-etl next to its data on GCP, accounting for egress", () => {
    const x = recs.find((r) => r.detector === "arch.cross_cloud")!;
    assert.equal(x.targetProvider, "gcp");
    assert.equal(x.category, "cross_cloud");
    const awsSpot = x.details.alternatives!.find((a) => a.provider === "aws" && a.label.includes("Spot"))!;
    assert.ok(x.projectedMonthlyCost < awsSpot.monthlyCost, "GCP must beat AWS Spot because it removes egress");
  });

  it("never double-counts savings on shared resources", () => {
    const primary = recs.filter((r) => !r.overlapsWith);
    const seen = new Set<string>();
    for (const r of primary) for (const id of r.resourceIds) {
      assert.ok(!seen.has(id), `resource ${id} claimed twice`);
      seen.add(id);
    }
    const alt = recs.find((r) => r.detector === "rightsizing.vm" && r.title.includes("api-platform"))!;
    assert.ok(alt.overlapsWith?.startsWith("arch.serverless"));
    assert.ok(totalPotentialSavings(recs) < recs.reduce((s, r) => s + r.monthlySavings, 0));
  });

  it("sizes commitments on the post-optimization baseline", () => {
    const aws = recs.find((r) => r.detector === "commitment" && r.provider === "aws")!;
    const today = Number(aws.details.evidence[0].value.replace(/[$,]/g, ""));
    const after = Number(aws.details.evidence[1].value.replace(/[$,]/g, ""));
    assert.ok(after < today);
  });

  it("detects the injected BigQuery anomaly and reports it as spend at risk, not savings", () => {
    const anomaly = recs.find((r) => r.category === "anomaly" && r.title.includes("BigQuery"))!;
    assert.ok(anomaly);
    assert.ok(totalAtRisk(recs) >= anomaly.monthlySavings);
    const withoutAnomalies = recs.filter((r) => r.category !== "anomaly");
    assert.equal(totalPotentialSavings(recs), totalPotentialSavings(withoutAnomalies));
  });

  it("produces savings that never exceed current cost", () => {
    for (const r of recs) {
      assert.ok(r.monthlySavings >= 0 && r.monthlySavings <= r.currentMonthlyCost + 0.01, r.title);
    }
  });
});

describe("what-if simulator", () => {
  const estate = demoEstate();
  it("plans from keywords and simulates without double counting", () => {
    const plan = planFromKeywords("What if we applied every optimization lever with 3-year commitments?");
    assert.ok(plan.transforms.some((t) => t.type === "commitments" && t.commitmentTerm === "3y"));
    const r = simulate(estate, plan);
    assert.ok(r.monthlySavings > 0 && r.monthlySavings < r.baselineMonthly);
    const titles = r.steps.flatMap((s) => s.items.map((i) => i.title));
    assert.equal(new Set(titles).size, titles.length);
  });

  it("explains why workloads are not eligible for serverless", () => {
    const r = simulate(estate, planFromKeywords("move everything possible to serverless"));
    assert.ok(r.notEligible.some((n) => n.name === "batch-etl"));
  });
});

describe("custom architecture analysis", () => {
  it("parses free text and proposes cheaper architectures", () => {
    const { components, profile } = parseArchitectureText("12 m5.2xlarge behind an ALB, stateless API, 300 million requests/month, spiky peaks, Postgres RDS Multi-AZ, 40 TB in S3");
    assert.equal(components[0].provider, "aws");
    assert.equal(profile.trafficPattern, "spiky");
    const a = analyzeHeuristically(components, profile);
    assert.ok(a.proposals.length >= 2);
    assert.ok(a.proposals.every((p) => p.monthlyCost < a.current.monthlyCost));
  });
});

describe("projection", () => {
  it("ramps adoption across the rollout window", () => {
    assert.equal(adoptionAt(0, { startWeek: 2, fullWeek: 6 }), 0);
    assert.equal(adoptionAt(3, { startWeek: 2, fullWeek: 6 }), 1);
  });

  it("computes break-even after migration spend", () => {
    const p = project([{ label: "x", currentMonthlyCost: 10_000, projectedMonthlyCost: 4_000, migrationCost: 30_000, rollout: { startWeek: 2, fullWeek: 4 } }], { months: 12 });
    assert.equal(p.monthlySavingsAtFull, 6_000);
    assert.ok(p.breakEvenMonth !== null && p.breakEvenMonth >= 5 && p.breakEvenMonth <= 7);
    assert.ok(p.points[p.points.length - 1].cumulativeNet > 0);
  });

  it("builds a waterfall that ends at the optimized spend", () => {
    const w = waterfall(1000, [{ label: "a", savings: 100 }, { label: "b", savings: 50 }]);
    assert.equal(w.at(-1)!.value, 850);
  });
});

describe("OpenAI structured-output schemas", () => {
  function assertStrict(schema: unknown, path = "$") {
    if (!schema || typeof schema !== "object") return;
    const s = schema as Record<string, unknown>;
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false, `${path} must set additionalProperties: false`);
      assert.deepEqual([...(s.required as string[])].sort(), Object.keys(s.properties as object).sort(), `${path} must require every property`);
      for (const [k, v] of Object.entries(s.properties as object)) assertStrict(v, `${path}.${k}`);
    }
    if (Array.isArray(s.type) && s.enum) assert.ok((s.enum as unknown[]).includes(null), `${path} nullable enum must include null`);
    if (s.items) assertStrict(s.items, `${path}[]`);
  }
  for (const [name, schema] of Object.entries({ discoverySchema, enrichmentSchema, whatIfPlanSchema, narrativeSchema, customAnalysisSchema })) {
    it(`${name} is valid for strict mode`, () => assertStrict(schema));
  }
});
