import type { Estate, RecommendationDraft } from "./types";
import { makeDraft, median, money, pct, round } from "./util";

export interface AnomalyPoint {
  date: string;
  cost: number;
  expected: number;
  z: number;
}

export interface Anomaly {
  accountId: string;
  provider: string;
  service: string;
  startDate: string;
  baselineDaily: number;
  recentDaily: number;
  maxZ: number;
  points: AnomalyPoint[];
}

/**
 * Robust, seasonality-aware anomaly detection: each day is compared to the
 * median of the same weekday over the prior 4 weeks, scaled by MAD
 * (median absolute deviation), so one-off spikes don't poison the baseline.
 */
export function detectAnomalies(estate: Estate): Anomaly[] {
  const series = new Map<string, Map<string, number>>();
  const meta = new Map<string, { accountId: string; provider: string; service: string }>();
  for (const d of estate.daily) {
    const k = `${d.accountId}|${d.service}`;
    if (!series.has(k)) {
      series.set(k, new Map());
      meta.set(k, { accountId: d.accountId, provider: d.provider, service: d.service });
    }
    const m = series.get(k)!;
    m.set(d.date, (m.get(d.date) ?? 0) + d.cost);
  }

  const out: Anomaly[] = [];
  for (const [k, m] of series) {
    const days = [...m.keys()].sort();
    if (days.length < 42) continue;
    const recent = days.slice(-7);
    const points: AnomalyPoint[] = [];
    for (const day of recent) {
      const idx = days.indexOf(day);
      const sameWeekday = [7, 14, 21, 28].map((o) => m.get(days[idx - o]) ?? 0).filter((v) => v > 0);
      const window = days.slice(Math.max(0, idx - 35), idx - 7).map((d) => m.get(d)!);
      const expected = median(sameWeekday.length ? sameWeekday : window);
      const mad = median(window.map((v) => Math.abs(v - median(window)))) || expected * 0.05 || 1;
      const z = (m.get(day)! - expected) / (1.4826 * mad);
      points.push({ date: day, cost: m.get(day)!, expected, z });
    }
    const flagged = points.filter((p) => p.z > 4 && p.cost - p.expected > 40);
    if (flagged.length < 3) continue;
    const info = meta.get(k)!;
    const baselineDaily = median(points.map((p) => p.expected));
    const recentDaily = flagged.reduce((s, p) => s + p.cost, 0) / flagged.length;
    out.push({
      ...info,
      startDate: flagged[0].date,
      baselineDaily: round(baselineDaily),
      recentDaily: round(recentDaily),
      maxZ: round(Math.max(...flagged.map((p) => p.z)), 1),
      points,
    });
  }
  return out;
}

export function anomalyRecommendations(estate: Estate): RecommendationDraft[] {
  return detectAnomalies(estate).map((a) => {
    const acct = estate.accounts.find((x) => x.id === a.accountId);
    const increase = (a.recentDaily / a.baselineDaily - 1) * 100;
    return makeDraft({
      fingerprint: `anomaly:${a.accountId}|${a.service}`,
      detector: "anomaly",
      category: "anomaly",
      provider: a.provider as RecommendationDraft["provider"],
      accountId: a.accountId,
      title: `Investigate ${a.service} cost spike (+${pct(increase)} since ${a.startDate.slice(5)})`,
      summary: `${a.service} in ${acct?.name ?? "account"} is running at ${money(a.recentDaily)}/day vs a ${money(a.baselineDaily)}/day baseline. If it persists it adds ${money((a.recentDaily - a.baselineDaily) * 30)}/month.`,
      currentMonthlyCost: a.recentDaily * 30,
      projectedMonthlyCost: a.baselineDaily * 30,
      migrationCost: 0,
      effort: "low",
      risk: "low",
      timeline: "Now",
      confidence: Math.min(0.95, 0.6 + a.maxZ / 40),
      resourceIds: [],
      details: {
        explanation: `Daily ${a.service} spend deviates from the same-weekday baseline by up to ${a.maxZ}σ (robust z-score, MAD-scaled) for ${a.points.filter((p) => p.z > 4).length} of the last 7 days. The usual causes are a runaway job, a missing partition filter, or new unbounded queries.`,
        evidence: [
          { label: "Baseline", value: `${money(a.baselineDaily)} / day` },
          { label: "Recent", value: `${money(a.recentDaily)} / day` },
          { label: "Max deviation", value: `${a.maxZ}σ` },
          { label: "Started", value: a.startDate },
        ],
        benefits: ["Stops the leak before month-end"],
        risks: [],
        implementation: [
          { phase: "Triage", weeks: "Today", tasks: ["Open the service's job/query history for the spike window", "Identify top principals and labels by cost", "Add a budget alert at 120% of baseline"] },
        ],
        rollout: { startWeek: 0, fullWeek: 0 },
      },
    });
  });
}

