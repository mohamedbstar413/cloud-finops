/**
 * Cost-improvement projections: turns a set of recommendations (or proposals)
 * into month-by-month trajectories, cumulative net savings, break-even, ROI
 * and NPV. Pure functions — shared by server components and the browser.
 */

export interface ProjectionInput {
  id?: string;
  label: string;
  currentMonthlyCost: number;
  projectedMonthlyCost: number;
  migrationCost: number;
  rollout: { startWeek: number; fullWeek: number };
}

export interface ProjectionPoint {
  month: number;
  label: string;
  baseline: number;
  optimized: number;
  savings: number;
  migrationSpend: number;
  cumulativeSavings: number;
  cumulativeNet: number;
  adoption: number;
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  monthlySavingsAtFull: number;
  annualSavings: number;
  firstYearNet: number;
  totalMigrationCost: number;
  breakEvenMonth: number | null;
  roi12: number | null;
  npv36: number;
  baselineMonthly: number;
  optimizedMonthly: number;
}

const WEEKS_PER_MONTH = 4.345;

export function adoptionAt(month: number, rollout: { startWeek: number; fullWeek: number }): number {
  if (month <= 0) return 0;
  const w = (month - 0.5) * WEEKS_PER_MONTH; // mid-month
  const { startWeek: s, fullWeek: f } = rollout;
  if (f <= s) return w >= s ? 1 : 0;
  return Math.max(0, Math.min(1, (w - s) / (f - s)));
}

export function project(
  inputs: ProjectionInput[],
  opts: { months?: number; growthRate?: number; start?: Date; discountRate?: number } = {},
): ProjectionResult {
  const months = opts.months ?? 12;
  const g = opts.growthRate ?? 0;
  const start = opts.start ?? new Date();
  const r = (opts.discountRate ?? 0.08) / 12;

  const baselineNow = inputs.reduce((s, i) => s + i.currentMonthlyCost, 0);
  const savingsFull = inputs.reduce((s, i) => s + Math.max(0, i.currentMonthlyCost - i.projectedMonthlyCost), 0);
  const migrationTotal = inputs.reduce((s, i) => s + i.migrationCost, 0);

  // Engineering spend is incurred while the migration is in flight.
  const migrationByMonth = (m: number) =>
    inputs.reduce((s, i) => {
      const spanMonths = Math.max(1, Math.ceil(Math.max(i.rollout.fullWeek, 1) / WEEKS_PER_MONTH));
      return s + (m >= 1 && m <= spanMonths ? i.migrationCost / spanMonths : 0);
    }, 0);

  const horizon = Math.max(months, 36);
  const points: ProjectionPoint[] = [];
  let cumSavings = 0;
  let cumNet = 0;
  let npv = 0;
  let breakEven: number | null = null;
  for (let m = 0; m <= horizon; m++) {
    const growth = (1 + g) ** m;
    const baseline = baselineNow * growth;
    const savings = inputs.reduce((s, i) => s + Math.max(0, i.currentMonthlyCost - i.projectedMonthlyCost) * adoptionAt(m, i.rollout), 0) * growth;
    const spend = migrationByMonth(m);
    cumSavings += savings;
    cumNet += savings - spend;
    if (m > 0) npv += (savings - spend) / (1 + r) ** m;
    if (breakEven === null && m > 0 && cumNet >= 0 && cumSavings > 0) breakEven = m;
    if (m <= months) {
      const d = new Date(start.getFullYear(), start.getMonth() + m, 1);
      points.push({
        month: m,
        label: m === 0 ? "Now" : d.toLocaleString("en-US", { month: "short", year: "2-digit" }),
        baseline: round(baseline),
        optimized: round(baseline - savings),
        savings: round(savings),
        migrationSpend: round(spend),
        cumulativeSavings: round(cumSavings),
        cumulativeNet: round(cumNet),
        adoption: savingsFull ? savings / growth / savingsFull : 0,
      });
    }
  }
  const firstYear = points.filter((p) => p.month >= 1 && p.month <= 12);
  const firstYearSavings = firstYear.reduce((s, p) => s + p.savings, 0);
  const firstYearNet = firstYearSavings - firstYear.reduce((s, p) => s + p.migrationSpend, 0);
  return {
    points,
    monthlySavingsAtFull: round(savingsFull),
    annualSavings: round(savingsFull * 12),
    firstYearNet: round(firstYearNet),
    totalMigrationCost: round(migrationTotal),
    breakEvenMonth: breakEven,
    roi12: migrationTotal > 0 ? Math.round((firstYearNet / migrationTotal) * 100) : null,
    npv36: round(npv),
    baselineMonthly: round(baselineNow),
    optimizedMonthly: round(baselineNow - savingsFull),
  };
}

export interface WaterfallStep {
  name: string;
  value: number;
  start: number;
  end: number;
  kind: "total" | "saving";
}

export function waterfall(baseline: number, items: { label: string; savings: number }[]): WaterfallStep[] {
  const steps: WaterfallStep[] = [{ name: "Current spend", value: round(baseline), start: 0, end: round(baseline), kind: "total" }];
  let running = baseline;
  for (const it of items) {
    const next = running - it.savings;
    steps.push({ name: it.label, value: round(it.savings), start: round(next), end: round(running), kind: "saving" });
    running = next;
  }
  steps.push({ name: "Optimized", value: round(running), start: 0, end: round(running), kind: "total" });
  return steps;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
