import { armEquivalent, downsizeVm, PRICES, type Provider, type VmType } from "../pricing/catalog";
import { Component, serviceName } from "../pricing/components";
import { describeSchedule, scheduleTransitions } from "../usage/series";
import {
  chartOf,
  cpuSignal,
  enoughHistory,
  evidence,
  isIdleCpu,
  MEMORY_AGENT_FIX,
  memSignal,
  mergeWindows,
  MIN_HISTORY_DAYS,
  networkBytesPerDay,
  pctTrend,
  recordGap,
  usageWindow,
  type Signal,
  type UsageWindow,
} from "./signals";
import { tfAzureBlobLifecycle, tfGp3, tfRightsize, tfS3Lifecycle, tfSchedule, tfSnapshotArchive } from "./terraform";
import type { Detector, Estate, RecommendationDraft, ResourceRow } from "./types";
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
} from "./util";

const accountName = (estate: Estate, id: string) => estate.accounts.find((a) => a.id === id)?.name ?? "account";

/**
 * Halving an instance doubles its utilisation. A half-size instance is only
 * safe when the peak PROJECTED 90 days ahead stays at or below these limits
 * (i.e. ≤ 80% after the change).
 */
const HALVE_CPU_LIMIT = 40;
const HALVE_MEM_LIMIT = 40;
/** History needed before a growth trend is more than noise. */
const TREND_HISTORY_DAYS = 28;
/** Monitoring agents and health checks alone produce less than this per instance. */
const IDLE_NETWORK_BYTES_PER_DAY = 100e6;
/** Below these daily volumes a load balancer or NAT gateway carries nothing but noise. */
const IDLE_LB_REQUESTS_PER_DAY = 100;
const IDLE_NAT_BYTES_PER_DAY = 50e6;
/** IOPS history is hourly averages, which hide sub-hour bursts: provision this much above the p99. */
const GP3_BURST_HEADROOM = 1.25;

const fmtBytes = (b: number) => (b >= 1e9 ? `${round(b / 1e9, 1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const weighted = (items: { q: number; v: number }[]) => {
  const w = items.reduce((s, i) => s + i.q, 0);
  return w ? items.reduce((s, i) => s + i.v * i.q, 0) / w : 0;
};
const windowText = (s: Signal) => (s.source === "history" ? `${Math.round(s.days)} days of hourly history` : "summary metrics (no hourly history)");

/* ------------------------------------------------------------------------- */
/* Rightsizing (with Arm/Graviton where the workload is compatible)           */
/* ------------------------------------------------------------------------- */
export const rightsizing: Detector = (estate) => {
  const moves: { r: ResourceRow; to: VmType; cpu: Signal; mem: Signal }[] = [];
  for (const r of estate.resources) {
    if (r.kind !== "compute.vm" || r.state !== "running" || r.quantity <= 0 || r.config.role === "k8s-node" || r.config.staticContent || !r.sku) continue;
    const cpu = cpuSignal(r);
    if (!cpu || isIdleCpu(cpu)) continue; // nothing measured, or idle (handled by the idle detector)
    if (cpu.peak > HALVE_CPU_LIMIT) continue; // busy today: correctly sized
    const down = downsizeVm(r.sku);
    if (!down) continue;

    // The instance looks oversized today. Every gate below must pass; when one fails we say why.
    if (!enoughHistory(cpu)) {
      recordGap(estate, r, "rightsizing.vm", "short_history", `Only ${Math.round(cpu.days)} days of CPU history; ${MIN_HISTORY_DAYS} are needed before resizing.`);
      continue;
    }
    const mem = memSignal(r);
    if (!mem) {
      recordGap(
        estate,
        r,
        "rightsizing.vm",
        "missing_metric",
        `CPU peaks at ${pct(cpu.peak)}, so a smaller size looks possible — but memory is not measured, and a half-size instance has half the memory.`,
        MEMORY_AGENT_FIX[r.provider],
      );
      continue;
    }
    if (mem.peak > HALVE_MEM_LIMIT) continue; // memory-bound today: correctly sized
    if (cpu.forecastPeak > HALVE_CPU_LIMIT || mem.forecastPeak > HALVE_MEM_LIMIT) {
      const parts = [
        cpu.forecastPeak > HALVE_CPU_LIMIT ? `CPU ${pct(cpu.peak)} → about ${pct(cpu.forecastPeak)} (${pctTrend(cpu.trendPerMonth)})` : "",
        mem.forecastPeak > HALVE_MEM_LIMIT ? `memory ${pct(mem.peak)} → about ${pct(mem.forecastPeak)} (${pctTrend(mem.trendPerMonth)})` : "",
      ].filter(Boolean);
      recordGap(
        estate,
        r,
        "rightsizing.vm",
        "growing",
        `Looks oversized today, but usage is growing: in 90 days ${parts.join(" and ")}, above the ${HALVE_CPU_LIMIT}% limit for a half-size instance. Downsizing now would have to be undone.`,
        "Re-evaluate in 30 days, or downsize with autoscaling headroom",
      );
      continue;
    }
    const arm = r.config.armCompatible ? armEquivalent(down.sku) : undefined;
    moves.push({ r, to: arm ?? down, cpu, mem });
  }

  const out: RecommendationDraft[] = [];
  for (const [key, ms] of groupBy(moves, (m) => `${m.r.accountId}|${m.r.workload ?? m.r.id}`)) {
    const p = ms[0].r.provider;
    const moved = ms.map((m) => m.r);
    const proposedComponents: Component[] = ms.map(({ r, to }) => ({ id: `rs-${r.id}`, kind: "compute.vm", provider: p, label: `${r.name} → ${to.sku}`, sku: to.sku, region: r.region, usage: { count: r.quantity } }));
    const n = countOf(moved);
    const from = moved[0].sku!;
    const to = ms[0].to.sku;
    const isArm = ms[0].to.arch === "arm";
    const current = specFromResources("Current", p, moved, [], [], [`${n} × ${from}`]);
    const rate = effectiveRate(moved);
    const proposed = atEffectiveRate(buildArchitecture("Right-sized", p, proposedComponents, [], [], [`${n} × ${to}${isArm ? " (Arm)" : ""}`]), rate);
    const cpuPeak = weighted(ms.map((m) => ({ q: m.r.quantity, v: m.cpu.peak })));
    const cpuForecast = weighted(ms.map((m) => ({ q: m.r.quantity, v: m.cpu.forecastPeak })));
    const memP95 = weighted(ms.map((m) => ({ q: m.r.quantity, v: m.mem.p95 })));
    const memPeak = weighted(ms.map((m) => ({ q: m.r.quantity, v: m.mem.peak })));
    const memForecast = weighted(ms.map((m) => ({ q: m.r.quantity, v: m.mem.forecastPeak })));
    const lead = ms.reduce((a, b) => (b.r.monthlyCost > a.r.monthlyCost ? b : a));
    const history = ms.every((m) => m.cpu.source === "history");
    // Under four weeks of history a trend cannot be told apart from noise yet.
    const young = history && ms.some((m) => m.cpu.days < TREND_HISTORY_DAYS);
    const usage = lead.r.usage?.metrics;

    out.push(
      makeDraft({
        fingerprint: `rightsizing.vm:${key}`,
        detector: "rightsizing.vm",
        category: "rightsizing",
        provider: p,
        accountId: moved[0].accountId,
        title: `Right-size ${n} ${serviceName("compute.vm", p)} instances${moved[0].workload ? ` in ${moved[0].workload}` : ""}`,
        summary: `${n} ${serviceName("compute.vm", p)} instances are over-provisioned: CPU peaks at ${pct(cpuPeak)} and memory at ${pct(memPeak)}${history ? `, and usage is ${Math.abs(lead.cpu.trendPerMonth) < 0.02 ? "flat" : `trending ${pctTrend(lead.cpu.trendPerMonth)}`}` : ""}. A half-size instance fits with headroom.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(isArm ? 1.5 : 0.5),
        effort: isArm ? "medium" : "low",
        risk: "low",
        timeline: "1–2 weeks",
        confidence: !history ? 0.72 : young ? 0.8 : 0.9,
        resourceIds: moved.map((r) => r.id),
        details: {
          explanation: history
            ? `Based on ${windowText(lead.cpu)}: CPU peaks at ${pct(cpuPeak)} (the busiest day's p95 of the hourly maximum) and memory at ${pct(memPeak)}. Projected 90 days ahead at the current trend (${pctTrend(lead.cpu.trendPerMonth)}) the peaks are ${pct(cpuForecast)} CPU and ${pct(memForecast)} memory, so a half-size instance still runs at about ${pct(cpuForecast * 2)} CPU and ${pct(memForecast * 2)} memory at peak.${isArm ? ` The workload is Arm-compatible, so ${to} (Graviton) adds another ~15% price-performance gain.` : ""}`
            : `Based on summary metrics only (no hourly history, so the trend is unknown): p95 CPU ${pct(lead.cpu.p95)}, p95 memory ${pct(memP95)}. A half-size instance would peak around ${pct(cpuPeak * 2)} CPU. Re-check once 30 days of hourly history are available.`,
          evidence: [
            { label: "Instances", value: `${n} × ${from}` },
            { label: "History", value: history ? `${Math.round(lead.cpu.days)} days, hourly` : "Summary metrics only" },
            { label: "CPU peak", value: pct(cpuPeak) },
            { label: "Memory peak", value: pct(memPeak) },
            ...(history ? [{ label: "CPU trend", value: pctTrend(lead.cpu.trendPerMonth) }, { label: "CPU peak in 90 days", value: pct(cpuForecast) }] : []),
            { label: "Peak after the change", value: `${pct(cpuForecast * 2)} CPU · ${pct(memForecast * 2)} memory` },
            { label: "Recommended type", value: to },
            ...(Math.abs(rate - 1) >= 0.005 ? [{ label: "Your effective rate vs list", value: pct(rate * 100) }] : []),
          ],
          benefits: ["Same availability, lower cost", "Rolling change via instance refresh"],
          risks: [
            "Reduced burst headroom — monitor p99 latency for a week",
            ...(history ? [] : ["No usage trend available — validate against a growth forecast"]),
            ...(young ? [`Only ${Math.round(Math.min(...ms.map((m) => m.cpu.days)))} days of history: enough to see the peaks, too short to see a trend — re-check in two weeks`] : []),
          ],
          current,
          proposed,
          comparison: [
            { metric: "Monthly cost", current: money(current.monthlyCost), proposed: money(proposed.monthlyCost), change: "better" },
            { metric: "Instance type", current: from, proposed: to, change: "neutral" },
            { metric: "Peak CPU (90-day forecast)", current: pct(cpuForecast), proposed: pct(Math.min(100, cpuForecast * 2)), change: "neutral" },
            { metric: "Peak memory (90-day forecast)", current: pct(memForecast), proposed: pct(Math.min(100, memForecast * 2)), change: "neutral" },
          ],
          implementation: [{ phase: "Rolling resize", weeks: "Week 1", tasks: ["Update launch template", "Instance refresh with 90% min healthy", "Watch latency SLOs"] }],
          terraform: p === "aws" ? tfRightsize({ name: moved[0].workload ?? moved[0].name, from, to }) : undefined,
          rollout: { startWeek: 0, fullWeek: 1 },
          usage: evidence(lead.cpu.days, ["CPU", "memory"], [
            chartOf(usage?.cpu_max ?? usage?.cpu, "cpu", `CPU — daily peak (${lead.r.name})`, { lines: [{ label: "Limit for half size", value: HALVE_CPU_LIMIT, tone: "limit" }] }),
            chartOf(usage?.mem, "mem", "Memory — daily p95", { lines: [{ label: "Limit for half size", value: HALVE_MEM_LIMIT, tone: "limit" }] }),
          ]),
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Relational database rightsizing                                           */
/* ------------------------------------------------------------------------- */
export const dbRightsizing: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const db of estate.resources) {
    if (db.kind !== "db.instance" || !db.sku?.startsWith("db.r5")) continue;
    const cpu = cpuSignal(db);
    if (!cpu || cpu.peak > HALVE_CPU_LIMIT) continue;
    if (!enoughHistory(cpu)) {
      recordGap(estate, db, "rightsizing.db", "short_history", `Only ${Math.round(cpu.days)} days of CPU history; ${MIN_HISTORY_DAYS} are needed before resizing.`);
      continue;
    }
    const mem = memSignal(db);
    if (!mem) {
      recordGap(estate, db, "rightsizing.db", "missing_metric", `CPU peaks at ${pct(cpu.peak)}, but memory use (FreeableMemory) is not collected — a smaller class halves the buffer cache.`, "Collect FreeableMemory for this database");
      continue;
    }
    if (mem.forecastPeak > HALVE_MEM_LIMIT) continue;
    if (cpu.forecastPeak > HALVE_CPU_LIMIT) {
      recordGap(estate, db, "rightsizing.db", "growing", `CPU peaks at ${pct(cpu.peak)} today but is growing ${pctTrend(cpu.trendPerMonth)}: about ${pct(cpu.forecastPeak)} in 90 days.`);
      continue;
    }
    const target = "db.r6g.xlarge";
    const p = db.provider;
    const current = specFromResources("Current", p, [db], [], [], [`${db.sku}${db.config.multiAz ? " Multi-AZ" : ""}`]);
    const proposed = atEffectiveRate(
      buildArchitecture("Right-sized", p, [{ id: "db", kind: "db.instance", provider: p, label: `${db.name} → ${target}`, sku: target, region: db.region, usage: { multiAz: db.config.multiAz, storageGb: db.config.sizeGb } }], [], [], [`${target}${db.config.multiAz ? " Multi-AZ" : ""}`]),
      effectiveRate([db]),
    );
    const usage = db.usage?.metrics;
    out.push(
      makeDraft({
        fingerprint: `rightsizing.db:${db.id}`,
        detector: "rightsizing.db",
        category: "rightsizing",
        provider: p,
        accountId: db.accountId,
        title: `Right-size ${db.name} to ${target} (Graviton)`,
        summary: `${db.name} peaks at ${pct(cpu.peak)} CPU and ${pct(mem.peak)} memory. A Graviton instance half the size handles the load.`,
        currentMonthlyCost: current.monthlyCost,
        projectedMonthlyCost: proposed.monthlyCost,
        migrationCost: migrationCostFromWeeks(0.5),
        effort: "low",
        risk: "low",
        timeline: "1 week",
        confidence: cpu.source === "history" ? 0.87 : 0.7,
        resourceIds: [db.id],
        details: {
          explanation: `Based on ${windowText(cpu)}, ${db.name} (${db.sku}) runs at ${pct(cpu.avg)} average CPU, peaks at ${pct(cpu.peak)} on its busiest day and uses up to ${pct(mem.peak)} of its memory. Projected 90 days ahead the peak is ${pct(cpu.forecastPeak)} CPU. ${target} halves vCPU and memory (about ${pct(cpu.forecastPeak * 2)} CPU and ${pct(mem.forecastPeak * 2)} memory at peak) and uses Graviton2, which is ~10% cheaper per vCPU.`,
          evidence: [
            { label: "History", value: cpu.source === "history" ? `${Math.round(cpu.days)} days, hourly` : "Summary metrics only" },
            { label: "CPU avg / peak", value: `${pct(cpu.avg)} / ${pct(cpu.peak)}` },
            { label: "Memory peak", value: pct(mem.peak) },
            { label: "CPU trend", value: pctTrend(cpu.trendPerMonth) },
            { label: "Connections p95", value: `${Math.round(usage?.connections?.p95 ?? db.metrics.connectionsP95 ?? 0) || "—"}` },
          ],
          benefits: ["Multi-AZ failover-based resize keeps downtime to ~60 s"],
          risks: ["Buffer cache shrinks — validate query latency on a snapshot restore first"],
          current,
          proposed,
          implementation: [{ phase: "Resize", weeks: "Week 1", tasks: ["Test on snapshot restore", "Modify instance in maintenance window (Multi-AZ failover)"] }],
          rollout: { startWeek: 0, fullWeek: 1 },
          usage: evidence(cpu.days, ["CPU", "memory", "connections"], [
            chartOf(usage?.cpu_max ?? usage?.cpu, "cpu", "CPU — daily peak", { lines: [{ label: "Limit for half size", value: HALVE_CPU_LIMIT, tone: "limit" }] }),
            chartOf(usage?.mem, "mem", "Memory — daily p95", { lines: [{ label: "Limit for half size", value: HALVE_MEM_LIMIT, tone: "limit" }] }),
          ]),
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Idle & orphaned resources                                                 */
/* ------------------------------------------------------------------------- */
export const idleResources: Detector = (estate) => {
  const out: RecommendationDraft[] = [];

  // Idle VMs: CPU AND network must both be quiet. Low CPU with live network traffic is a server in use.
  const idle: { r: ResourceRow; cpu: Signal; net: number | null }[] = [];
  for (const r of estate.resources) {
    if (r.kind !== "compute.vm" || r.state !== "running" || r.quantity <= 0) continue;
    const cpu = cpuSignal(r);
    if (!cpu || !isIdleCpu(cpu)) continue;
    if (!enoughHistory(cpu)) {
      recordGap(estate, r, "idle.vm", "short_history", `CPU has stayed under 5%, but only for ${Math.round(cpu.days)} days; ${MIN_HISTORY_DAYS} are needed before calling it idle.`);
      continue;
    }
    const net = networkBytesPerDay(r);
    if (net !== null && net > IDLE_NETWORK_BYTES_PER_DAY * r.quantity) {
      recordGap(
        estate,
        r,
        "idle.vm",
        "in_use",
        `CPU stayed under 5% for ${Math.round(cpu.days)} days, but up to ${fmtBytes(net)} of network traffic a day still flows through it — it is probably still serving data, so it is not flagged as idle.`,
        "Confirm with the owner what reads from this host",
      );
      continue;
    }
    idle.push({ r, cpu, net });
  }
  for (const [acct, items] of groupBy(idle, (i) => i.r.accountId)) {
    const rs = items.map((i) => i.r);
    const p = rs[0].provider;
    const n = countOf(rs);
    const cost = sumCost(rs);
    const measured = items.filter((i) => i.net !== null);
    const allNet = measured.length === items.length;
    const days = Math.round(Math.min(...items.map((i) => i.cpu.days)));
    const history = items.every((i) => i.cpu.source === "history");
    const period = history ? `${days} days` : "the metrics window";
    const maxNet = Math.max(0, ...measured.map((i) => i.net! / i.r.quantity));
    const usage = rs[0].usage?.metrics;
    out.push(
      makeDraft({
        fingerprint: `idle.vm:${acct}`,
        detector: "idle.vm",
        category: "idle",
        provider: p,
        accountId: acct,
        title: `Terminate ${n} idle ${serviceName("compute.vm", p)} instance${n > 1 ? "s" : ""}`,
        summary: `${n} instance${n > 1 ? "s" : ""} in ${accountName(estate, acct)} stayed below 5% CPU for ${period}${allNet ? " with almost no network traffic" : ""}.`,
        currentMonthlyCost: cost,
        projectedMonthlyCost: 0,
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: allNet && history ? 0.9 : 0.7,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation:
            (history ? `CPU stayed under 5% on every one of the last ${period} (each day's p95 of the hourly maximum, so a patch reboot does not count as use)` : `Maximum CPU stayed under 5% over ${period}`) +
            (allNet
              ? ` and network traffic (in + out) stayed under ${fmtBytes(maxNet)} per instance per day, which is what monitoring agents alone produce.`
              : `. Network traffic is not measured for ${items.length - measured.length} of them, so CPU is the only signal: confirm with the owners before terminating.`) +
            ` Snapshot the volumes, stop the instances for a week, then terminate them.`,
          evidence: items.map((i) => ({
            label: i.r.name,
            value: `${i.r.sku} · ${history ? "busiest day" : "max"} CPU ${pct(history ? i.cpu.peak : i.cpu.max)} · ${i.net === null ? "network not measured" : `${fmtBytes(i.net / i.r.quantity)}/day network`}`,
          })),
          benefits: ["Removes 100% of their cost", "Smaller attack surface"],
          risks: ["Confirm with owners (tag: owner) before termination", ...(allNet ? [] : ["Network activity was not measured"])],
          implementation: [{ phase: "Stop → terminate", weeks: "Day 1–7", tasks: ["Snapshot volumes", "Stop instances and notify owners", "Terminate after 7 days without objection"] }],
          rollout: { startWeek: 0, fullWeek: 1 },
          usage: evidence(days, allNet ? ["CPU", "network"] : ["CPU"], [
            chartOf(usage?.cpu_max ?? usage?.cpu, "cpu", `CPU — daily peak (${rs[0].name})`, { lines: [{ label: "Idle threshold", value: 5, tone: "limit" }] }),
            chartOf(usage?.net_out, "net", "Network out — GB per day"),
          ], allNet ? {} : { missing: ["network traffic"] }),
        },
      }),
    );
  }

  const orphanDisks = estate.resources.filter((r) => r.kind === "storage.block" && r.config.attached === false);
  for (const [acct, rs] of groupBy(orphanDisks, (r) => r.accountId)) {
    const p = rs[0].provider;
    const gb = rs.reduce((s, r) => s + (r.config.sizeGb ?? 0) * r.quantity, 0);
    const known = rs.map((r) => r.metrics.daysSinceAttach).filter((d): d is number => d !== undefined);
    const since = known.length === rs.length ? `for at least ${Math.min(...known)} days` : "and have no attachment on record";
    out.push(
      makeDraft({
        fingerprint: `idle.volume:${acct}`,
        detector: "idle.volume",
        category: "idle",
        provider: p,
        accountId: acct,
        title: `Delete ${countOf(rs)} unattached ${serviceName("storage.block", p)} volumes`,
        summary: `${round(gb / 1024, 1)} TB of block storage is not attached to any instance.`,
        currentMonthlyCost: sumCost(rs),
        projectedMonthlyCost: gb * PRICES.snapshotArchive[p],
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: 0.92,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: `These volumes are unattached ${since}. Take an archive-tier snapshot (kept for audit) and delete the volumes.`,
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
        confidence: 0.85,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: `${round(gb / 1024)} TB of snapshots are older than 180 days. Moving them to the archive tier (and adding a lifecycle policy for new ones) cuts their cost by ~75%. Restore frequency is not tracked, so keep any snapshot you restore from regularly in the standard tier.`,
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
/* Idle network resources: billed by the hour, carrying no traffic            */
/* ------------------------------------------------------------------------- */
export const idleNetwork: Detector = (estate) => {
  const idle: { r: ResourceRow; lb: boolean; days: number; peakDay: number }[] = [];
  for (const r of estate.resources) {
    const lb = r.kind === "network.load_balancer";
    if ((!lb && r.kind !== "network.nat_gateway") || r.monthlyCost <= 0 || r.quantity <= 0) continue;
    // Traffic must be measured: a load balancer without request history is never assumed idle.
    const m = lb ? r.usage?.metrics.requests : r.usage?.metrics.nat_bytes;
    if (!m || !m.daily.length) continue;
    const peakDay = Math.max(...m.daily.map((d) => d.total));
    if (peakDay > (lb ? IDLE_LB_REQUESTS_PER_DAY : IDLE_NAT_BYTES_PER_DAY) * r.quantity) continue;
    if (m.days < MIN_HISTORY_DAYS) {
      recordGap(estate, r, "idle.network", "short_history", `No real traffic so far, but only ${Math.round(m.days)} days are on record; ${MIN_HISTORY_DAYS} are needed before calling it idle.`);
      continue;
    }
    idle.push({ r, lb, days: m.days, peakDay });
  }

  const out: RecommendationDraft[] = [];
  for (const [acct, items] of groupBy(idle, (i) => i.r.accountId)) {
    const rs = items.map((i) => i.r);
    const p = rs[0].provider;
    const lbs = countOf(items.filter((i) => i.lb).map((i) => i.r));
    const nats = countOf(items.filter((i) => !i.lb).map((i) => i.r));
    const plural = (n: number, word: string) => `${n} idle ${word}${n > 1 ? "s" : ""}`;
    // "2 idle load balancers and 1 idle NAT gateway"
    const what = [lbs ? plural(lbs, "load balancer") : "", nats ? plural(nats, "NAT gateway") : ""].filter(Boolean).join(" and ");
    const days = Math.round(Math.min(...items.map((i) => i.days)));
    const lead = items.reduce((a, b) => (b.r.monthlyCost > a.r.monthlyCost ? b : a));
    const leadMetric = lead.lb ? lead.r.usage?.metrics.requests : lead.r.usage?.metrics.nat_bytes;
    out.push(
      makeDraft({
        fingerprint: `idle.network:${acct}`,
        detector: "idle.network",
        category: "idle",
        provider: p,
        accountId: acct,
        title: `Delete ${what}`,
        summary: `${what[0].toUpperCase()}${what.slice(1)} in ${accountName(estate, acct)} carried no real traffic for ${days} days but ${lbs + nats > 1 ? "are" : "is"} still billed every hour.`,
        currentMonthlyCost: sumCost(rs),
        projectedMonthlyCost: 0,
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: 0.88,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation:
            `Load balancers and NAT gateways are billed for every hour they exist, whether or not traffic flows. Over ${days} days of history, ` +
            items.map((i) => `${i.r.name} ${i.lb ? `received at most ${Math.round(i.peakDay)} requests on its busiest day` : `processed at most ${fmtBytes(i.peakDay)} on its busiest day`}`).join("; ") +
            `. That is background noise, not a workload.`,
          evidence: items.map((i) => ({
            label: i.r.name,
            value: i.lb ? `${Math.round(i.peakDay)} requests on the busiest day · ${Math.round(i.days)} days of history` : `${fmtBytes(i.peakDay)} on the busiest day · ${Math.round(i.days)} days of history`,
          })),
          benefits: ["Removes 100% of their hourly charge", "Fewer public endpoints to secure"],
          risks: ["A standby or disaster-recovery endpoint also looks idle — confirm with the owner", "Check that no DNS record or route table still points at them"],
          implementation: [{ phase: "Remove", weeks: "Day 1", tasks: ["Confirm with the owner", "Remove DNS records and routes", "Delete the resources"] }],
          rollout: { startWeek: 0, fullWeek: 0 },
          usage: evidence(days, [lbs ? "requests" : "", nats ? "NAT bytes" : ""].filter(Boolean), [chartOf(leadMetric, "traffic", lead.lb ? `Requests per day — ${lead.r.name}` : `NAT data processed — GB per day (${lead.r.name})`)]),
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Storage tiering                                                            */
/* ------------------------------------------------------------------------- */
const LAST_ACCESS_FIX: Record<Provider, string> = {
  aws: "Enable S3 Storage Lens (advanced) or S3 Inventory with last-access analysis",
  azure: "Enable last access time tracking on the storage account",
  gcp: "Enable Storage Insights / Autoclass for the bucket",
};

export const storageTiering: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  for (const b of estate.resources) {
    if (b.kind !== "storage.object" || b.config.lifecyclePolicy) continue;
    const usage = b.usage?.metrics;
    const gb = usage?.stored_gb?.daily.at(-1)?.avg ?? b.config.sizeGb ?? 0;
    if (b.metrics.coldShare90 === undefined) {
      if (gb >= 5 * 1024 && (b.config.tier ?? "hot") === "hot") {
        recordGap(estate, b, "storage.lifecycle", "missing_metric", `${round(gb / 1024)} TB sits in the hot tier with no lifecycle policy, but there is no last-access data to tell how much of it is cold.`, LAST_ACCESS_FIX[b.provider]);
      }
      continue;
    }
    if (b.metrics.coldShare90 < 0.3) continue;
    const p = b.provider;
    const c90 = b.metrics.coldShare90;
    const c30 = Math.max(c90, b.metrics.coldShare30 ?? c90);
    const intelligent = b.config.tier === "unpredictable" && p === "aws";
    const rates = PRICES.objectStorage[p];
    const coolGb = gb * (c30 - c90);
    const coldGb = gb * c90;
    // Retrieval fees: assume every cool/cold object is read back once a year (Intelligent-Tiering has none).
    const retrieval = intelligent ? 0 : (coolGb * PRICES.objectRetrievalPerGb[p].cool + coldGb * PRICES.objectRetrievalPerGb[p].cold) / 12;
    const monitoring = intelligent ? ((b.metrics.objectCount ?? 0) / 1000) * 0.0025 : 0;
    // Scale the BILLED cost by the blended-rate ratio so regional pricing and negotiated discounts carry over.
    const blended = (1 - c30) * rates.hot + (c30 - c90) * rates.cool + c90 * rates.cold;
    const projected = b.monthlyCost * (blended / rates.hot) + retrieval + monitoring;
    const label = intelligent ? "S3 Intelligent-Tiering" : `${PRICES.objectStorageTierLabel[p].cool} after 30d → ${PRICES.objectStorageTierLabel[p].cold} after 90d`;
    const transitionCost = ((b.metrics.objectCount ?? 0) / 1000) * 0.02;
    const svc = serviceName("storage.object", p);
    const stored = usage?.stored_gb;
    const reads = usage?.read_gb;
    out.push(
      makeDraft({
        fingerprint: `storage.lifecycle:${b.id}`,
        detector: "storage.lifecycle",
        category: "storage",
        provider: p,
        accountId: b.accountId,
        title: intelligent ? `Enable S3 Intelligent-Tiering on ${b.name}` : `Implement ${svc} lifecycle policies on ${b.name}`,
        summary: `Move the ${pct(c30 * 100)} of data that has not been read in 30 days to cheaper storage classes.`,
        currentMonthlyCost: b.monthlyCost,
        projectedMonthlyCost: projected,
        migrationCost: round(transitionCost),
        effort: "low",
        risk: "low",
        timeline: "1 week",
        confidence: 0.88,
        resourceIds: [b.id],
        details: {
          explanation:
            `Last-access analysis shows ${pct(c30 * 100)} of the ${round(gb / 1024)} TB in ${b.name} has not been read in 30 days and ${pct(c90 * 100)} in 90 days, yet it is all stored in ${PRICES.objectStorageTierLabel[p].hot}. ${label} matches price to access frequency.` +
            (reads ? ` Reads average ${round(reads.monthlyTotal / 30)} GB a day (${pctTrend(reads.trendPerMonth)}).` : "") +
            (retrieval > 0 ? ` The estimate includes ${money(retrieval)}/month of retrieval fees, assuming every cool or cold object is read back once a year.` : "") +
            (stored && stored.trendPerMonth >= 0.005 ? ` The bucket is growing ${pctTrend(stored.trendPerMonth)}, and the rules apply to new data too, so the saving grows with it.` : ""),
          evidence: [
            { label: "Bucket size", value: `${round(gb / 1024)} TB${stored ? ` (${pctTrend(stored.trendPerMonth)})` : ""}` },
            { label: "Not read in 30 days", value: pct(c30 * 100) },
            { label: "Not read in 90 days", value: pct(c90 * 100) },
            ...(reads ? [{ label: "Reads", value: `${round(reads.monthlyTotal / 1024, 1)} TB / month` }] : []),
            ...(retrieval > 0 ? [{ label: "Retrieval fees (included)", value: `${money(retrieval)} / month` }] : []),
            { label: "Objects", value: `${round((b.metrics.objectCount ?? 0) / 1e6, 1)}M` },
          ],
          benefits: ["Lower $/GB for cold data", "No application changes"],
          risks: ["Minimum storage duration (30–90 days) applies to transitioned objects", "Objects under 128 KB do not benefit from infrequent-access tiers", `One-time transition requests ≈ ${money(transitionCost)}`],
          implementation: [{ phase: "Lifecycle rules", weeks: "Week 1", tasks: ["Add lifecycle rules", "Exclude hot prefixes", "Track retrieval costs for 30 days"] }],
          terraform: p === "aws" ? tfS3Lifecycle({ bucket: b.name, iaDays: 30, coldDays: 90, intelligentTiering: intelligent }) : p === "azure" ? tfAzureBlobLifecycle({ account: b.name.replace(/[^a-z0-9]/g, "") }) : undefined,
          rollout: { startWeek: 0, fullWeek: 5 },
          assumptions: retrieval > 0 ? ["Each cool/cold object is read back once a year"] : undefined,
          usage: evidence(stored?.days ?? 0, ["stored bytes", ...(reads ? ["reads"] : [])], [chartOf(stored, "stored", "Stored — GB"), chartOf(reads, "reads", "Read — GB per day")]),
        },
      }),
    );
  }

  // gp2 → gp3. Safe without IOPS data up to 1 TB (gp2 cannot exceed 3,000 IOPS there); larger volumes need measured IOPS.
  const gp2 = estate.resources.filter((r) => r.kind === "storage.block" && r.provider === "aws" && r.config.volumeType === "gp2" && r.config.attached !== false);
  const convertible: { r: ResourceRow; extraIops: number; peakIops: number | null }[] = [];
  for (const r of gp2) {
    const iops = r.usage?.metrics.iops;
    const measured = iops && iops.days >= MIN_HISTORY_DAYS ? iops.p99 / Math.max(1, r.quantity) : null;
    if (measured === null && (r.config.sizeGb ?? 0) > 1000) {
      recordGap(
        estate,
        r,
        "storage.gp3",
        iops ? "short_history" : "missing_metric",
        iops
          ? `Only ${Math.round(iops.days)} days of IOPS history for volumes over 1 TB; ${MIN_HISTORY_DAYS} are needed to size gp3 IOPS.`
          : `Volumes over 1 TB get more than 3,000 IOPS on gp2. IOPS are not measured, so the gp3 price (which charges for IOPS above 3,000) cannot be estimated.`,
        "Collect VolumeReadOps / VolumeWriteOps for these volumes",
      );
      continue;
    }
    // A gp2 volume cannot do more than 3 IOPS per GB (3,000 when bursting), so that caps what gp3 must provide.
    const gp2Ceiling = Math.max(PRICES.gp3.baselineIops, 3 * (r.config.sizeGb ?? 0));
    const needed = measured === null ? 0 : Math.min(gp2Ceiling, measured * GP3_BURST_HEADROOM);
    convertible.push({ r, peakIops: measured, extraIops: Math.max(0, needed - PRICES.gp3.baselineIops) });
  }
  for (const [key, items] of groupBy(convertible, (i) => `${i.r.accountId}|${i.r.workload ?? "shared"}`)) {
    const rs = items.map((i) => i.r);
    const gb = rs.reduce((s, r) => s + (r.config.sizeGb ?? 0) * r.quantity, 0);
    const iopsCost = items.reduce((s, i) => s + i.extraIops * PRICES.gp3.perIopsMonth * i.r.quantity, 0);
    const projected = gb * PRICES.blockStorage.aws.standard + iopsCost;
    if (sumCost(rs) - projected < 25) continue;
    const measured = items.filter((i) => i.peakIops !== null);
    const peak = Math.max(0, ...measured.map((i) => i.peakIops!));
    const leadItem = measured.length ? measured.reduce((a, b) => (b.peakIops! > a.peakIops! ? b : a)) : undefined;
    const lead = leadItem?.r.usage?.metrics.iops;
    const leadName = leadItem?.r.name ?? "";
    const leadQty = leadItem?.r.quantity ?? 1;
    out.push(
      makeDraft({
        fingerprint: `storage.gp3:${key}`,
        detector: "storage.gp3",
        category: "storage",
        provider: "aws",
        accountId: rs[0].accountId,
        title: `Migrate ${countOf(rs)} EBS gp2 volumes to gp3${rs[0].workload ? ` (${rs[0].workload})` : ""}`,
        summary: "gp3 is 20% cheaper per GB than gp2 and includes 3,000 IOPS regardless of size.",
        currentMonthlyCost: sumCost(rs),
        projectedMonthlyCost: projected,
        migrationCost: 0,
        effort: "low",
        risk: "low",
        timeline: "1 day",
        confidence: measured.length === items.length ? 0.97 : 0.9,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation:
            "gp3 volumes cost 20% less per GB than gp2 and decouple IOPS from size. The change is an online Elastic Volumes modification with no downtime." +
            (measured.length
              ? ` Measured peak is ${Math.round(peak).toLocaleString()} IOPS per volume (p99 of hourly averages)${iopsCost > 0 ? `; with ${pct((GP3_BURST_HEADROOM - 1) * 100)} headroom for bursts that is above the included 3,000, so the estimate adds ${money(iopsCost)}/month of provisioned IOPS` : `, within the 3,000 IOPS gp3 includes even with ${pct((GP3_BURST_HEADROOM - 1) * 100)} headroom for bursts`}.`
              : " IOPS are not measured; these volumes are 1 TB or smaller, where gp2 cannot exceed 3,000 IOPS either."),
          evidence: [
            { label: "gp2 capacity", value: `${round(gb / 1024, 1)} TB` },
            { label: "Peak IOPS per volume", value: measured.length ? Math.round(peak).toLocaleString() : "not measured (≤ 1 TB volumes)" },
          ],
          benefits: ["20% lower $/GB", "IOPS and throughput no longer depend on volume size"],
          risks: [
            "gp3 includes 125 MB/s of throughput; gp2 volumes over 334 GB can reach 250 MB/s — throughput is not measured here, so check it for scan-heavy workloads",
            ...(measured.length ? ["IOPS history is hourly averages; short bursts can be higher"] : []),
          ],
          implementation: [{ phase: "Modify volumes", weeks: "Day 1", tasks: ["aws ec2 modify-volume --volume-type gp3", ...(iopsCost > 0 ? ["Provision IOPS above 3,000 where the history shows it is needed"] : []), "Update IaC defaults"] }],
          terraform: tfGp3({ volumes: rs.map((r) => r.name) }),
          rollout: { startWeek: 0, fullWeek: 0 },
          usage: evidence(lead?.days ?? 0, ["IOPS"], [chartOf(lead, "iops", `IOPS — daily p95${leadQty > 1 ? `, all ${leadQty} volumes` : ""} (${leadName})`, { lines: [{ label: "Included with gp3", value: PRICES.gp3.baselineIops * Math.max(1, leadQty), tone: "limit" }] })]),
        },
      }),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Non-production scheduling — derived from each fleet's own weekly pattern    */
/* ------------------------------------------------------------------------- */
export const nonProdScheduling: Detector = (estate) => {
  const out: RecommendationDraft[] = [];
  const eligible: { r: ResourceRow; window: UsageWindow }[] = [];
  for (const r of estate.resources) {
    if (r.kind !== "compute.vm" || r.state !== "running" || r.quantity <= 0 || !["staging", "dev", "test"].includes(r.environment ?? "")) continue;
    const cpu = cpuSignal(r);
    if (!cpu || isIdleCpu(cpu)) continue;
    const window = usageWindow(r);
    if (!window) {
      const profile = r.usage?.metrics.cpu_max ?? r.usage?.metrics.cpu;
      recordGap(
        estate,
        r,
        "scheduling.nonprod",
        profile?.howP95 ? "short_history" : "missing_metric",
        profile?.howP95
          ? `Only ${Math.round(profile.days)} days of hourly history; two full weeks are needed to see when this ${r.environment} fleet is really idle.`
          : `This ${r.environment} fleet runs 24/7, but without hourly utilisation history there is no safe way to tell when it can be switched off.`,
        "Collect hourly CPU metrics for at least 14 days",
      );
      continue;
    }
    if (window.share > 0.7) continue; // used most of the week: nothing to schedule
    eligible.push({ r, window });
  }

  for (const [key, items] of groupBy(eligible, (i) => `${i.r.accountId}|${i.r.environment}`)) {
    const rs = items.map((i) => i.r);
    const p: Provider = rs[0].provider;
    const env = rs[0].environment!;
    const lead = items.reduce((a, b) => (b.r.monthlyCost > a.r.monthlyCost ? b : a));
    // The fleet stays up whenever ANY member is in use.
    const { active, share: runtime, days } = mergeWindows(items.map((i) => i.window));
    if (runtime > 0.7) continue;
    const cost = sumCost(rs);
    const schedule = describeSchedule(active);
    const history = Math.round(days);
    out.push(
      makeDraft({
        fingerprint: `scheduling.nonprod:${key}`,
        detector: "scheduling.nonprod",
        category: "scheduling",
        provider: p,
        accountId: rs[0].accountId,
        title: `Schedule ${env} environment off when it is idle`,
        summary: `${countOf(rs)} ${env} instances run 24/7 but are only used ${pct(runtime * 100)} of the week: ${schedule}.`,
        currentMonthlyCost: cost,
        projectedMonthlyCost: cost * runtime,
        migrationCost: migrationCostFromWeeks(0.25),
        effort: "low",
        risk: "low",
        timeline: "2 days",
        confidence: 0.9,
        resourceIds: rs.map((r) => r.id),
        details: {
          explanation: `Over ${history} days of hourly history, the ${env} fleet in ${accountName(estate, rs[0].accountId)} was in use only during ${schedule} — every other hour of the week stayed idle in every observed week. Running it on that schedule (which already includes a one-hour buffer before and after) is ${pct(runtime * 100)} of the hours in a week.`,
          evidence: [
            { label: "Instances", value: `${countOf(rs)}` },
            { label: "History", value: `${history} days, hourly` },
            { label: "Observed usage window", value: schedule },
            { label: "Hours needed per week", value: `${active.filter(Boolean).length} of 168` },
          ],
          benefits: [`${pct((1 - runtime) * 100)} lower ${env} compute`, "Opt-out tag for exceptions"],
          risks: [`Jobs that run outside the observed window need their own schedule`, "Times are UTC — adjust for daylight saving if the team works on local time"],
          implementation: [{ phase: "Scheduler", weeks: "Day 1–2", tasks: ["Create stop/start schedules by tag", "Add `schedule=always-on` opt-out tag"] }],
          terraform: p === "aws" ? tfSchedule({ name: env, region: rs[0].region, tagKey: "env", tagValue: env, schedule, ...scheduleTransitions(active) }) : undefined,
          rollout: { startWeek: 0, fullWeek: 1 },
          usage: evidence(history, ["CPU (hourly)"], [], { heatmap: { title: `CPU by hour of week — ${lead.r.name}`, values: lead.window.how.map((v) => round(v, 1)), idle: active.map((a) => !a), schedule } }),
        },
      }),
    );
  }
  return out;
};

export const STANDARD_DETECTORS: Detector[] = [rightsizing, dbRightsizing, idleResources, idleNetwork, storageTiering, nonProdScheduling];
