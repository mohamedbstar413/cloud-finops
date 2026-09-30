import { armEquivalent, downsizeVm, findVm, PRICES, Provider } from "../pricing/catalog";
import { Component, serviceName } from "../pricing/components";
import { tfAzureBlobLifecycle, tfGp3, tfRightsize, tfS3Lifecycle, tfSchedule, tfSnapshotArchive } from "./terraform";
import type { Detector, RecommendationDraft, ResourceRow } from "./types";
import {
  atEffectiveRate,
  buildArchitecture,
  countOf,
  effectiveRate,
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

const accountName = (estate: Parameters<Detector>[0], id: string) =>
  estate.accounts.find((a) => a.id === id)?.name ?? "account";

/* ------------------------------------------------------------------------- */
/* Rightsizing (with Arm/Graviton where the workload is compatible)           */
/* ------------------------------------------------------------------------- */
export const rightsizing: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  const candidates = estate.resources.filter(
    (r) =>
      r.kind === "compute.vm" &&
      r.state === "running" &&
      r.config.role !== "k8s-node" &&
      !r.config.staticContent &&
      (r.metrics.cpuMax ?? 100) >= 5 &&
      (r.metrics.cpuP95 ?? 100) < 40 &&
      (r.metrics.memP95 ?? 0) < 60,
  );
  for (const [key, rs] of groupBy(candidates, (r) => `${r.accountId}|${r.workload ?? r.id}`)) {
    const moves = rs
      .map((r) => {
        const down = downsizeVm(r.sku!);
        if (!down) return null;
        const arm = r.config.armCompatible ? armEquivalent(down.sku) : undefined;
        const to = arm ?? down;
        return { r, to };
      })
      .filter(Boolean) as { r: ResourceRow; to: NonNullable<ReturnType<typeof findVm>> }[];
    if (!moves.length) continue;
    const p = rs[0].provider;
    const proposedComponents: Component[] = moves.map(({ r, to }) => ({
      id: `rs-${r.id}`,
      kind: "compute.vm",
      provider: p,
      label: `${r.name} → ${to.sku}`,
      sku: to.sku,
      region: r.region,
      usage: { count: r.quantity },
    }));
    const moved = moves.map((m) => m.r);
    const n = countOf(moved);
    const from = moved[0].sku!;
    const to = moves[0].to.sku;
    const current = specFromResources("Current", p, moved, [], [], [`${n} × ${from}`]);
    const rate = effectiveRate(moved);
    const proposed = atEffectiveRate(buildArchitecture("Right-sized", p, proposedComponents, [], [], [`${n} × ${to}${moves[0].to.arch === "arm" ? " (Arm)" : ""}`]), rate);
    const cpuP95 = weightedAvg(moved, (r) => r.metrics.cpuP95);
    const memP95 = weightedAvg(moved, (r) => r.metrics.memP95);
    out.push(
      makeDraft({
        fingerprint: `rightsizing.vm:${key}`,
        detector: "rightsizing.vm",
        category: "rightsizing",
        provider: p,
        accountId: rs[0].accountId,
        title: `Right-size ${n} ${serviceName("compute.vm", p)} instances${moved[0].workload ? ` in ${moved[0].workload}` : ""}`,
        summary: `${n} ${serviceName("compute.vm", p)} instances are over-provisioned (p95 CPU ${pct(cpuP95)}, p95 memory ${pct(memP95)}). We recommend smaller instance types based on actual usage.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(moves[0].to.arch === "arm" ? 1.5 : 0.5),
        effort: moves[0].to.arch === "arm" ? "medium" : "low",
        risk: "low",
        timeline: "1–2 weeks",
        confidence: 0.9,
        resourceIds: moved.map((r) => r.id),
        details: {
          explanation: `Over the last 14 days these instances peaked at ${pct(cpuP95)} CPU (p95) and ${pct(memP95)} memory. Halving the instance size keeps projected p95 CPU under ${pct(Math.min(80, cpuP95 * 2))}${moves[0].to.arch === "arm" ? `, and the workload is Arm-compatible, so ${to} (Graviton) adds another ~15% price-performance gain` : ""}.`,
          evidence: [
            { label: "Instances", value: `${n} × ${from}` },
            { label: "CPU p95 (14d)", value: pct(cpuP95) },
            { label: "Memory p95 (14d)", value: pct(memP95) },
            { label: "Recommended type", value: to },
            ...(Math.abs(rate - 1) >= 0.005 ? [{ label: "Your effective rate vs list", value: pct(rate * 100) }] : []),
          ],
          benefits: ["Same availability, lower cost", "Rolling change via instance refresh"],
          risks: ["Reduced burst headroom — monitor p99 latency for a week"],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Instance type", current: from, proposed: to, change: "neutral" },
            { metric: "Projected p95 CPU", current: pct(cpuP95), proposed: pct(Math.min(90, cpuP95 * 2)), change: "neutral" },
          ],
          implementation: [{ phase: "Rolling resize", weeks: "Week 1", tasks: ["Update launch template", "Instance refresh with 90% min healthy", "Watch latency SLOs"] }],
          terraform: p === "aws" ? tfRightsize({ name: moved[0].workload ?? moved[0].name, from, to }) : undefined,
          rollout: { startWeek: 0, fullWeek: 1 },
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Relational database rightsizing                                           */
/* ------------------------------------------------------------------------- */
export const dbRightsizing: Detector = (estate) =>
  estate.resources
    .filter((r) => r.kind === "db.instance" && (r.metrics.cpuP95 ?? 100) < 40 && r.sku?.startsWith("db.r5"))
    .map((db) => {
      const target = db.sku === "db.r5.2xlarge" ? "db.r6g.xlarge" : "db.r6g.xlarge";
      const p = db.provider;
      const current = specFromResources("Current", p, [db], [], [], [`${db.sku}${db.config.multiAz ? " Multi-AZ" : ""}`]);
      const proposed = atEffectiveRate(buildArchitecture("Right-sized", p, [
        { id: "db", kind: "db.instance", provider: p, label: `${db.name} → ${target}`, sku: target, region: db.region, usage: { multiAz: db.config.multiAz, storageGb: db.config.sizeGb } },
      ], [], [], [`${target}${db.config.multiAz ? " Multi-AZ" : ""}`]), effectiveRate([db]));
      return makeDraft({
        fingerprint: `rightsizing.db:${db.id}`,
        detector: "rightsizing.db",
        category: "rightsizing",
        provider: p,
        accountId: db.accountId,
        title: `Right-size ${db.name} to ${target} (Graviton)`,
        summary: `${db.name} peaks at ${pct(db.metrics.cpuP95 ?? 0)} CPU. A Graviton instance half the size handles the load.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(0.5),
        effort: "low",
        risk: "low",
        timeline: "1 week",
        confidence: 0.87,
        resourceIds: [db.id],
        details: {
          explanation: `${db.name} (${db.sku}) runs at ${pct(db.metrics.cpuAvg ?? 0)} average and ${pct(db.metrics.cpuP95 ?? 0)} p95 CPU, with freeable memory consistently above 50%. ${target} halves vCPU/memory and uses Graviton2, which is ~10% cheaper per vCPU.`,
          evidence: [
            { label: "CPU avg / p95", value: `${pct(db.metrics.cpuAvg ?? 0)} / ${pct(db.metrics.cpuP95 ?? 0)}` },
            { label: "Connections p95", value: `${db.metrics.connectionsP95 ?? "—"}` },
          ],
          benefits: ["Multi-AZ failover-based resize keeps downtime to ~60 s"],
          risks: ["Buffer cache shrinks — validate query latency on a snapshot restore first"],
          current,
          proposed,
          implementation: [{ phase: "Resize", weeks: "Week 1", tasks: ["Test on snapshot restore", "Modify instance in maintenance window (Multi-AZ failover)"] }],
          rollout: { startWeek: 0, fullWeek: 1 },
        },
      });
    });

/* ------------------------------------------------------------------------- */
/* Idle & orphaned resources                                                 */
/* ------------------------------------------------------------------------- */
export const idleResources: Detector = (estate) => {
  const out: RecommendationDraft[] = [];

  const idleVms = estate.resources.filter((r) => r.kind === "compute.vm" && r.state === "running" && (r.metrics.cpuMax ?? 100) < 5);
  for (const [acct, rs] of groupBy(idleVms, (r) => r.accountId)) {
    const p = rs[0].provider;
    const n = countOf(rs);
    const cost = sumCost(rs);
    out.push(
      makeDraft({
        fingerprint: `idle.vm:${acct}`,
        detector: "idle.vm",
        category: "idle",
        provider: p,
        accountId: acct,
        title: `Terminate ${n} idle ${serviceName("compute.vm", p)} instance${n > 1 ? "s" : ""}`,
        summary: `${n} instance${n > 1 ? "s" : ""} in ${accountName(estate, acct)} peaked below 5% CPU with negligible network I/O for 14 days.`,
        currentMonthlyCost: cost,
        projectedMonthlyCost: 0,
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: 0.86,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: `These instances show max CPU under 5% and less than 1 MB/day of network traffic over 14 days. They look like forgotten test or legacy hosts. Snapshot the volumes, stop the instances for a week, then terminate them.`,
          evidence: rs.map((r) => ({ label: r.name, value: `${r.sku} · max CPU ${pct(r.metrics.cpuMax ?? 0)}` })),
          benefits: ["Removes 100% of their cost", "Smaller attack surface"],
          risks: ["Confirm with owners (tag: owner) before termination"],
          implementation: [{ phase: "Stop → terminate", weeks: "Day 1–7", tasks: ["Snapshot volumes", "Stop instances and notify owners", "Terminate after 7 days without objection"] }],
          rollout: { startWeek: 0, fullWeek: 1 },
        },
      }),
    );
  }

  const orphanDisks = estate.resources.filter((r) => r.kind === "storage.block" && r.config.attached === false);
  for (const [acct, rs] of groupBy(orphanDisks, (r) => r.accountId)) {
    const p = rs[0].provider;
    const gb = rs.reduce((s, r) => s + (r.config.sizeGb ?? 0) * r.quantity, 0);
    out.push(
      makeDraft({
        fingerprint: `idle.volume:${acct}`,
        detector: "idle.volume",
        category: "idle",
        provider: p,
        accountId: acct,
        title: `Delete ${countOf(rs)} unattached ${serviceName("storage.block", p)} volumes`,
        summary: `${round(gb / 1024, 1)} TB of block storage has been unattached for over 30 days.`,
        currentMonthlyCost: sumCost(rs),
        projectedMonthlyCost: gb * PRICES.snapshotArchive[p],
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: 0.92,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: `These volumes have not been attached to an instance for ${Math.min(...rs.map((r) => r.metrics.daysSinceAttach ?? 30))}+ days. Take an archive-tier snapshot (kept for audit) and delete the volumes.`,
          evidence: [{ label: "Unattached volumes", value: `${countOf(rs)} (${round(gb / 1024, 1)} TB)` }],
          benefits: ["Removes orphaned storage spend"],
          risks: ["Restore from archive snapshot takes 24–72 h"],
          implementation: [{ phase: "Clean up", weeks: "Day 1", tasks: ["Archive-tier snapshot", "Delete volumes"] }],
          rollout: { startWeek: 0, fullWeek: 0 },
        },
      }),
    );
  }

  const ips = estate.resources.filter((r) => r.kind === "network.public_ip" && r.config.attached === false);
  for (const [acct, rs] of groupBy(ips, (r) => r.accountId)) {
    const p = rs[0].provider;
    out.push(
      makeDraft({
        fingerprint: `idle.ip:${acct}`,
        detector: "idle.ip",
        category: "idle",
        provider: p,
        accountId: acct,
        title: `Release ${countOf(rs)} unused public IP addresses`,
        summary: `Unassociated public IPv4 addresses are billed hourly.`,
        currentMonthlyCost: sumCost(rs),
        projectedMonthlyCost: 0,
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: 0.95,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: "These addresses are not associated with any instance, load balancer or NAT gateway.",
          evidence: [{ label: "Addresses", value: `${countOf(rs)}` }],
          implementation: [{ phase: "Release", weeks: "Day 1", tasks: ["Verify no DNS records point at them", "Release"] }],
          rollout: { startWeek: 0, fullWeek: 0 },
        },
      }),
    );
  }

  const snaps = estate.resources.filter((r) => r.kind === "storage.snapshot" && (r.metrics.ageDays ?? 0) > 180);
  for (const [acct, rs] of groupBy(snaps, (r) => r.accountId)) {
    const p = rs[0].provider;
    const gb = rs.reduce((s, r) => s + (r.config.sizeGb ?? 0), 0);
    out.push(
      makeDraft({
        fingerprint: `idle.snapshots:${acct}`,
        detector: "idle.snapshots",
        category: "storage",
        provider: p,
        accountId: acct,
        title: `Archive ${round(gb / 1024)} TB of snapshots older than 180 days`,
        summary: `Old snapshots sit in the standard tier. The archive tier is 75% cheaper for backups you rarely restore.`,
        currentMonthlyCost: sumCost(rs),
        projectedMonthlyCost: gb * PRICES.snapshotArchive[p],
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 week",
        confidence: 0.88,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: `${round(gb / 1024)} TB of snapshots are older than 180 days and never restored. Moving them to the archive tier (and adding a lifecycle policy for new ones) cuts the cost by ~75%.`,
          evidence: [{ label: "Snapshots > 180 days", value: `${round(gb / 1024)} TB` }],
          benefits: ["Keeps backups for compliance at archive prices"],
          risks: ["Archive restores take 24–72 hours; minimum 90-day retention"],
          implementation: [{ phase: "Policy", weeks: "Week 1", tasks: ["Create a Data Lifecycle Manager archive policy", "Archive existing snapshots in bulk"] }],
          terraform: p === "aws" ? tfSnapshotArchive() : undefined,
          rollout: { startWeek: 0, fullWeek: 1 },
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Storage tiering                                                            */
/* ------------------------------------------------------------------------- */
export const storageTiering: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const b of estate.resources.filter((r) => r.kind === "storage.object" && !r.config.lifecyclePolicy && (r.metrics.coldShare90 ?? 0) >= 0.3)) {
    const p = b.provider;
    const gb = b.config.sizeGb ?? 0;
    const c90 = b.metrics.coldShare90 ?? 0;
    const c30 = Math.max(c90, b.metrics.coldShare30 ?? c90);
    const unpredictable = b.config.tier === "unpredictable";
    const rates = PRICES.objectStorage[p];
    let projected: number;
    let label: string;
    if (unpredictable && p === "aws") {
      projected = gb * ((1 - c30) * rates.hot + (c30 - c90) * rates.cool + c90 * rates.cold) + ((b.metrics.objectCount ?? 0) / 1000) * 0.0025;
      label = "S3 Intelligent-Tiering";
    } else {
      projected = gb * ((1 - c30) * rates.hot + (c30 - c90) * rates.cool + c90 * rates.cold);
      label = `${PRICES.objectStorageTierLabel[p].cool} after 30d → ${PRICES.objectStorageTierLabel[p].cold} after 90d`;
    }
    const transitionCost = ((b.metrics.objectCount ?? 0) / 1000) * 0.02;
    const svc = serviceName("storage.object", p);
    out.push(
      makeDraft({
        fingerprint: `storage.lifecycle:${b.id}`,
        detector: "storage.lifecycle",
        category: "storage",
        provider: p,
        accountId: b.accountId,
        title: unpredictable && p === "aws" ? `Enable S3 Intelligent-Tiering on ${b.name}` : `Implement ${svc} lifecycle policies on ${b.name}`,
        summary: `Move ${pct(c30 * 100)} of infrequently accessed data to cheaper storage classes.`,
        currentMonthlyCost: b.monthlyCost,
        projectedMonthlyCost: projected,
        migrationCost: round(transitionCost),
        effort: "low",
        risk: "low",
        timeline: "1 week",
        confidence: 0.9,
        resourceIds: [b.id],
        details: {
          explanation: `Access logs show ${pct(c30 * 100)} of the ${round(gb / 1024)} TB in ${b.name} has not been read in 30 days and ${pct(c90 * 100)} in 90 days, yet it is all stored in ${PRICES.objectStorageTierLabel[p].hot}. ${label} matches price to access frequency.`,
          evidence: [
            { label: "Bucket size", value: `${round(gb / 1024)} TB` },
            { label: "Not read in 30 days", value: pct(c30 * 100) },
            { label: "Not read in 90 days", value: pct(c90 * 100) },
            { label: "Objects", value: `${round((b.metrics.objectCount ?? 0) / 1e6, 1)}M` },
          ],
          benefits: ["Lower $/GB for cold data", "No application changes"],
          risks: ["Retrieval fees on cold tiers — keep hot prefixes excluded", `One-time transition requests ≈ ${money(transitionCost)}`],
          implementation: [{ phase: "Lifecycle rules", weeks: "Week 1", tasks: ["Add lifecycle rules", "Exclude hot prefixes", "Track retrieval costs for 30 days"] }],
          terraform: p === "aws" ? tfS3Lifecycle({ bucket: b.name, iaDays: 30, coldDays: 90, intelligentTiering: unpredictable }) : p === "azure" ? tfAzureBlobLifecycle({ account: b.name.replace(/[^a-z0-9]/g, "") }) : undefined,
          rollout: { startWeek: 0, fullWeek: 5 },
        },
      }),
    );
  }

  const gp2 = estate.resources.filter((r) => r.kind === "storage.block" && r.provider === "aws" && r.config.volumeType === "gp2" && r.config.attached !== false);
  for (const [key, rs] of groupBy(gp2, (r) => `${r.accountId}|${r.workload ?? "shared"}`)) {
    const gb = rs.reduce((s, r) => s + (r.config.sizeGb ?? 0) * r.quantity, 0);
    const projected = gb * PRICES.blockStorage.aws.standard;
    if (sumCost(rs) - projected < 25) continue;
    out.push(
      makeDraft({
        fingerprint: `storage.gp3:${key}`,
        detector: "storage.gp3",
        category: "storage",
        provider: "aws",
        accountId: rs[0].accountId,
        title: `Migrate ${countOf(rs)} EBS gp2 volumes to gp3${rs[0].workload ? ` (${rs[0].workload})` : ""}`,
        summary: "gp3 is 20% cheaper than gp2 with a 3,000 IOPS baseline regardless of size.",
        currentMonthlyCost: sumCost(rs),
        projectedMonthlyCost: projected,
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: 0.97,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: "gp3 volumes cost 20% less per GB than gp2 and decouple IOPS from size. The change is an online Elastic Volumes modification with no downtime.",
          evidence: [{ label: "gp2 capacity", value: `${round(gb / 1024, 1)} TB` }],
          implementation: [{ phase: "Modify volumes", weeks: "Day 1", tasks: ["aws ec2 modify-volume --volume-type gp3", "Update IaC defaults"] }],
          terraform: tfGp3({ volumes: rs.map((r) => r.name) }),
          rollout: { startWeek: 0, fullWeek: 0 },
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Non-production scheduling                                                   */
/* ------------------------------------------------------------------------- */
export const nonProdScheduling: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  const nonProd = estate.resources.filter(
    (r) => r.kind === "compute.vm" && r.state === "running" && ["staging", "dev", "test"].includes(r.environment ?? "") && (r.metrics.cpuMax ?? 0) >= 5,
  );
  const runtime = 60 / 168; // Mon–Fri, 12h/day
  for (const [key, rs] of groupBy(nonProd, (r) => `${r.accountId}|${r.environment}`)) {
    const p: Provider = rs[0].provider;
    const cost = sumCost(rs);
    const env = rs[0].environment!;
    out.push(
      makeDraft({
        fingerprint: `scheduling.nonprod:${key}`,
        detector: "scheduling.nonprod",
        category: "scheduling",
        provider: p,
        accountId: rs[0].accountId,
        title: `Schedule ${env} environment off nights and weekends`,
        summary: `${countOf(rs)} ${env} instances run 24/7 but are only used during working hours.`,
        currentMonthlyCost: cost,
        projectedMonthlyCost: cost * (runtime + 0.03),
        migrationCost: migrationCostFromWeeks(0.25),
        effort: "low",
        risk: "low",
        timeline: "2 days",
        confidence: 0.9,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: `Hourly utilisation of the ${env} fleet in ${accountName(estate, rs[0].accountId)} drops to near-zero outside 07:00–19:00 on weekdays. Running only Mon–Fri 12h/day is ${pct(runtime * 100)} of the hours in a week.`,
          evidence: [
            { label: "Instances", value: `${countOf(rs)}` },
            { label: "Duty cycle", value: pct(weightedAvg(rs, (r) => r.metrics.dutyCycle) * 100) },
            { label: "Target schedule", value: "Mon–Fri 07:00–19:00" },
          ],
          benefits: ["~64% lower non-prod compute", "Opt-out tag for exceptions"],
          risks: ["Nightly jobs in staging need their own window"],
          implementation: [{ phase: "Scheduler", weeks: "Day 1–2", tasks: ["Create stop/start schedules by tag", "Add `schedule=always-on` opt-out tag"] }],
          terraform: p === "aws" ? tfSchedule({ name: env, region: rs[0].region, tagKey: "env", tagValue: env }) : undefined,
          rollout: { startWeek: 0, fullWeek: 1 },
        },
      }),
    );
  }
  return out;
};

export const STANDARD_DETECTORS: Detector[] = [rightsizing, dbRightsizing, idleResources, storageTiering, nonProdScheduling];

