/**
 * Lightweight spend forecasting: ordinary least squares on daily totals with
 * day-of-week seasonal factors. Good enough to project a trajectory for
 * savings charts without shipping a heavy ML runtime.
 */

export interface TrendFit {
  intercept: number;
  slope: number; // $/day per day
  monthlyGrowthRate: number; // fraction per 30 days
  weekday: number[]; // multiplicative factors, index 0 = Sunday
}

export function fitTrend(daily: { date: string; cost: number }[]): TrendFit {
  const n = daily.length;
  if (n < 7) {
    const mean = n ? daily.reduce((s, d) => s + d.cost, 0) / n : 0;
    return { intercept: mean, slope: 0, monthlyGrowthRate: 0, weekday: Array(7).fill(1) };
  }
  const xs = daily.map((_, i) => i);
  const ys = daily.map((d) => d.cost);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;

  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  daily.forEach((d, i) => {
    const fitted = intercept + slope * i;
    if (fitted > 0) buckets[new Date(d.date + "T00:00:00Z").getUTCDay()].push(d.cost / fitted);
  });
  const weekday = buckets.map((b) => (b.length ? b.reduce((a, c) => a + c, 0) / b.length : 1));
  const level = intercept + slope * (n - 1);
  return { intercept, slope, monthlyGrowthRate: level > 0 ? (slope * 30) / level : 0, weekday };
}

/** Project `months` future monthly totals starting from the latest fitted level. */
export function projectMonthly(fit: TrendFit, currentMonthly: number, months: number): number[] {
  const g = Math.max(-0.05, Math.min(0.08, fit.monthlyGrowthRate));
  return Array.from({ length: months }, (_, i) => currentMonthly * (1 + g) ** (i + 1));
}
