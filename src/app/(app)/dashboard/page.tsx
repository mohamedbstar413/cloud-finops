import { ArrowDown, ArrowRight, ArrowUp, BrainCircuit, Sparkles } from "lucide-react";
import Link from "next/link";
import { Legend, providerLegend, SpendTrendChart } from "@/components/charts";
import { PeriodSelect } from "@/components/PeriodSelect";
import { TopRecCard } from "@/components/RecCards";
import { Card, CardHeader, Empty, LinkButton, PageHeader, Stat } from "@/components/ui";
import { aiEnabled } from "@/lib/ai/client";
import { getSession } from "@/lib/auth";
import { CATEGORY_LABEL, usd } from "@/lib/format";
import { getDashboard } from "@/lib/services/queries";

const PROMPTS = [
  "What if we moved all possible workloads to serverless?",
  "What if every workload ran on its cheapest cloud?",
  "What if we applied every optimization with 3-year commitments?",
];

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { org } = await getSession();
  const days = [7, 30, 60, 90].includes(Number((await searchParams).days)) ? Number((await searchParams).days) : 30;
  const d = await getDashboard(org.id, days);
  const maxCat = Math.max(1, ...d.savingsByCategory.map((c) => c.savings));

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Your cloud spend, insights and top recommendations" actions={<PeriodSelect value={days} />} />

      <div className="grid gap-4 md:grid-cols-3">
        <Stat
          label={days === 30 ? "Total Monthly Spend" : `Total Spend (${days} days)`}
          value={usd(d.totalSpend)}
          tone={d.changePct <= 0 ? "good" : "bad"}
          sub={
            <span className="inline-flex items-center gap-1">
              {d.changePct <= 0 ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
              {Math.abs(d.changePct).toFixed(1)}% <span className="text-muted">vs. previous {days} days</span>
            </span>
          }
        />
        <Stat
          label="Potential Savings"
          value={usd(d.potentialSavings)}
          sub={
            <>
              <span className="font-medium text-good">{Math.round(d.potentialPct)}%</span> of current monthly spend
              {d.atRisk > 0 && <span className="text-red-600"> · {usd(d.atRisk)}/mo at risk from anomalies</span>}
            </>
          }
        />
        <Stat label="Active Recommendations" value={d.activeCount} sub={<><span className="font-medium text-red-600">{d.highImpact} high impact</span> · {d.architectureCount} architecture</>} />
      </div>

      <Card className="mt-4">
        <CardHeader title="Spend Trend" subtitle="Daily cost by provider" action={<Legend items={providerLegend} />} />
        <div className="px-3 pb-3 pt-2">{d.trend.length ? <SpendTrendChart data={d.trend} /> : <Empty title="No cost data yet">Connect an account to start ingesting billing data.</Empty>}</div>
      </Card>

      <div className="mb-3 mt-7 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Top Recommendations</h2>
        <Link href="/recommendations" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
          View all <ArrowRight size={14} />
        </Link>
      </div>
      {d.top.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {d.top.map((r) => (
            <TopRecCard key={r.id} rec={r} />
          ))}
        </div>
      ) : (
        <Empty title="No open recommendations">You&apos;re fully optimized — or run an analysis from the Recommendations page.</Empty>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Savings by lever" subtitle="De-duplicated monthly savings across open recommendations" />
          <div className="space-y-3 px-5 pb-5 pt-4">
            {d.savingsByCategory.map((c) => (
              <div key={c.category} className="grid grid-cols-[120px_1fr_80px] items-center gap-3 text-[13px]">
                <span className="text-muted">{CATEGORY_LABEL[c.category] ?? c.category}</span>
                <div className="h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-brand" style={{ width: `${(c.savings / maxCat) * 100}%` }} />
                </div>
                <span className="tabular text-right font-medium">{usd(c.savings)}</span>
              </div>
            ))}
            <div className="flex flex-wrap gap-6 border-t border-line pt-3 text-xs text-muted">
              <span>
                Open <b className="ml-1 text-ink">{usd(d.pipeline.open)}</b>
              </span>
              <span>
                In progress <b className="ml-1 text-ink">{usd(d.pipeline.inProgress)}</b>
              </span>
              <span>
                Realized <b className="ml-1 text-good">{usd(d.pipeline.applied)}</b>
              </span>
            </div>
          </div>
        </Card>
        <Card className="bg-gradient-to-br from-navy-900 to-navy-700 text-white lg:col-span-2">
          <div className="p-5">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <BrainCircuit size={16} className="text-blue-300" /> Architecture Advisor
              <span className="rounded bg-white/10 px-1.5 py-px text-[10px] font-medium text-blue-100">{aiEnabled() ? "OpenAI connected" : "Rules mode"}</span>
            </div>
            <p className="mt-2 text-[13px] text-blue-100/80">Ask what-if questions about your estate. Every answer is priced by the same engine as your recommendations.</p>
            <div className="mt-4 space-y-2">
              {PROMPTS.map((p) => (
                <Link key={p} href={`/advisor?q=${encodeURIComponent(p)}`} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-[12.5px] text-blue-50 ring-1 ring-white/10 hover:bg-white/10">
                  <Sparkles size={13} className="shrink-0 text-blue-300" />
                  {p}
                </Link>
              ))}
            </div>
            <LinkButton href="/savings" variant="primary" size="sm" className="mt-4">
              Open savings projection
            </LinkButton>
          </div>
        </Card>
      </div>
    </>
  );
}
