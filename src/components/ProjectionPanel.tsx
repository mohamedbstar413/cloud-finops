"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import { CumulativeChart, Legend, PROJECTION_COLORS, ProjectionChart } from "@/components/charts";
import { Card, CardHeader } from "@/components/ui";
import { usd } from "@/lib/format";
import { project, type ProjectionInput } from "@/lib/projection";

export function ProjectionPanel({ inputs, growthRate, compact }: { inputs: ProjectionInput[]; growthRate: number; compact?: boolean }) {
  const [months, setMonths] = useState(12);
  const [useGrowth, setUseGrowth] = useState(true);
  const [table, setTable] = useState(false);
  const result = useMemo(() => project(inputs, { months, growthRate: useGrowth ? growthRate : 0 }), [inputs, months, useGrowth, growthRate]);

  const kpis = [
    { label: "Monthly savings (full rollout)", value: usd(result.monthlySavingsAtFull), sub: `${usd(result.baselineMonthly)} → ${usd(result.optimizedMonthly)} / mo` },
    { label: "Annualized savings", value: usd(result.annualSavings), sub: `First-year net ${usd(result.firstYearNet)}` },
    { label: "One-time migration effort", value: usd(result.totalMigrationCost), sub: result.totalMigrationCost ? "Engineering time, spread over rollout" : "No migration cost" },
    { label: "Break-even", value: result.breakEvenMonth ? `Month ${result.breakEvenMonth}` : "—", sub: result.roi12 !== null ? `12-month ROI ${result.roi12}%` : "Immediate" },
    { label: "3-year NPV (8%)", value: usd(result.npv36), sub: "Net of migration cost" },
  ];

  return (
    <div className="space-y-4">
      <div className={clsx("grid gap-3", compact ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-2 lg:grid-cols-5")}>
        {kpis.map((k) => (
          <Card key={k.label} className="px-4 py-3">
            <p className="text-[11px] font-medium text-muted">{k.label}</p>
            <p className="mt-1 text-[19px] font-semibold tracking-tight text-ink">{k.value}</p>
            <p className="mt-0.5 text-[11px] text-muted">{k.sub}</p>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Cost improvement over time"
          subtitle="Current trajectory vs. spend with the improvement, including the migration ramp"
          action={
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={useGrowth} onChange={(e) => setUseGrowth(e.target.checked)} className="accent-brand" />
                Apply forecast growth ({(growthRate * 100).toFixed(1)}%/mo)
              </label>
              <div className="flex rounded-lg bg-slate-100 p-0.5">
                {[12, 24, 36].map((m) => (
                  <button key={m} onClick={() => setMonths(m)} className={clsx("rounded-md px-2.5 py-1 text-xs font-medium", months === m ? "bg-white shadow-sm" : "text-muted")}>
                    {m}m
                  </button>
                ))}
              </div>
            </div>
          }
        />
        <div className="px-5 pt-3">
          <Legend
            items={[
              { label: "Current trajectory", color: PROJECTION_COLORS.baseline, dashed: true },
              { label: "With improvement", color: PROJECTION_COLORS.optimized },
              { label: "Savings", color: PROJECTION_COLORS.band },
            ]}
          />
        </div>
        <div className="px-3 pb-3 pt-1">
          <ProjectionChart points={result.points} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Cumulative net savings" subtitle="Savings minus one-time migration spend — where the line crosses zero is break-even" />
          <div className="px-3 pb-3 pt-2">
            <CumulativeChart points={result.points} breakEvenMonth={result.breakEvenMonth} />
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Rollout schedule"
            subtitle="When each change starts saving"
            action={
              <button onClick={() => setTable((t) => !t)} className="text-xs font-medium text-brand hover:underline">
                {table ? "Hide" : "Show"} data table
              </button>
            }
          />
          <div className="space-y-3 px-5 pb-5 pt-4">
            {inputs.map((i) => {
              const weeks = Math.max(i.rollout.fullWeek, 1);
              return (
                <div key={i.id ?? i.label}>
                  <div className="flex justify-between gap-3 text-[12.5px]">
                    <span className="truncate text-ink">{i.label}</span>
                    <span className="tabular shrink-0 font-medium text-good">{usd(i.currentMonthlyCost - i.projectedMonthlyCost)}/mo</span>
                  </div>
                  <div className="relative mt-1.5 h-2 rounded-full bg-slate-100">
                    <div className="absolute h-2 rounded-full bg-amber-300" style={{ left: 0, width: `${(i.rollout.startWeek / 26) * 100}%` }} />
                    <div className="absolute h-2 rounded-full bg-[#1baf7a]" style={{ left: `${(i.rollout.startWeek / 26) * 100}%`, width: `${Math.max(2, ((weeks - i.rollout.startWeek) / 26) * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    Savings start week {i.rollout.startWeek}, full by week {weeks}
                  </p>
                </div>
              );
            })}
            <p className="flex gap-3 pt-1 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-amber-300" /> Migration</span>
              <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[#1baf7a]" /> Ramp to full savings</span>
              <span>Scale: 26 weeks</span>
            </p>
          </div>
        </Card>
      </div>

      {table && (
        <Card className="overflow-hidden">
          <table className="w-full text-[12.5px]">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                {["Month", "Current trajectory", "With improvement", "Savings", "Migration spend", "Cumulative net"].map((h) => (
                  <th key={h} className="px-4 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {result.points.map((p) => (
                <tr key={p.month} className="border-t border-line">
                  <td className="px-4 py-1.5">{p.label}</td>
                  <td className="px-4 py-1.5">{usd(p.baseline)}</td>
                  <td className="px-4 py-1.5">{usd(p.optimized)}</td>
                  <td className="px-4 py-1.5 text-good">{usd(p.savings)}</td>
                  <td className="px-4 py-1.5">{usd(p.migrationSpend)}</td>
                  <td className={clsx("px-4 py-1.5 font-medium", p.cumulativeNet < 0 ? "text-bad" : "text-good")}>{usd(p.cumulativeNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
