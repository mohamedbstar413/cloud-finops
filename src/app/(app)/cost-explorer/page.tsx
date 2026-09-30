import { ArrowDown, ArrowUp } from "lucide-react";
import { CategoryStackedBar, Legend, ProviderDonut, providerLegend, Sparkline, SpendTrendChart } from "@/components/charts";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Card, CardHeader, Empty, PageHeader, Stat } from "@/components/ui";
import { getSession } from "@/lib/auth";
import { CATEGORY_LABEL, PROVIDER_COLOR, PROVIDER_NAME, usd } from "@/lib/format";
import { getCostExplorer, parseCostFilters } from "@/lib/services/queries";
import { CostFilterBar, ExportButton, PeriodFilter, ProviderTabs } from "./filters";

export default async function CostExplorerPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { org } = await getSession();
  const sp = await searchParams;
  const filters = parseCostFilters(sp);
  const d = await getCostExplorer(org.id, filters);

  return (
    <>
      <PageHeader title="Cost Explorer" subtitle="Analyze your cloud costs with powerful filters and visualizations" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ProviderTabs value={filters.providers} />
        <div className="flex items-center gap-2">
          <PeriodFilter days={filters.days} />
          <ExportButton />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat
          label="Total Cost"
          value={usd(d.total)}
          tone={d.changePct <= 0 ? "good" : "bad"}
          sub={
            <span className="inline-flex items-center gap-1">
              {d.changePct <= 0 ? <ArrowDown size={12} /> : <ArrowUp size={12} />} {Math.abs(d.changePct).toFixed(1)}% <span className="text-muted">vs. previous {filters.days} days</span>
            </span>
          }
        />
        <Stat label="Average Daily Cost" value={usd(d.avgDaily)} sub={`over ${filters.days} days`} />
        <Card className="px-5 py-4">
          <p className="text-xs font-medium text-muted">Top Service</p>
          {d.topService ? (
            <div className="mt-1.5 flex items-center gap-3">
              <ProviderLogo provider={d.topService.provider} size={22} />
              <div>
                <p className="text-[18px] font-semibold leading-tight">{d.topService.service}</p>
                <p className="text-xs text-muted">
                  {usd(d.topService.cost)} ({Math.round(d.topService.pct)}%)
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">—</p>
          )}
        </Card>
      </div>

      {!d.rows.length ? (
        <div className="mt-4">
          <Empty title="No costs match these filters" />
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Cost by Provider" />
              <div className="p-5">
                <ProviderDonut data={d.byProvider} total={d.total} />
              </div>
            </Card>
            <Card>
              <CardHeader title="Cost by Service Category" action={<Legend items={providerLegend} />} />
              <div className="px-3 pb-3 pt-2">
                <CategoryStackedBar data={d.byCategory} />
              </div>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title="Daily cost" subtitle="By provider" action={<Legend items={providerLegend} />} />
            <div className="px-3 pb-3 pt-2">
              <SpendTrendChart data={d.trend} height={200} />
            </div>
          </Card>
        </>
      )}

      <Card className="mt-4">
        <CostFilterBar options={d.options} filters={filters} />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-y border-line bg-slate-50 text-left text-[11px] text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Service / Provider</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">% of Total</th>
                <th className="px-3 py-2 font-medium">Trend</th>
                <th className="px-5 py-2 text-right font-medium">vs. previous</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {d.rows.map((r) => (
                <tr key={`${r.provider}-${r.service}`} className="border-b border-line last:border-0 hover:bg-slate-50/60">
                  <td className="px-5 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <ProviderLogo provider={r.provider} size={16} />
                      <span className="font-medium">{r.service}</span>
                      <span className="text-xs text-muted">({PROVIDER_NAME[r.provider]})</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="px-3 py-2.5 text-right font-medium">{usd(r.cost)}</td>
                  <td className="px-3 py-2.5 text-right text-muted">{r.pct.toFixed(1)}%</td>
                  <td className="px-3 py-2.5">
                    <Sparkline values={r.spark} color={PROVIDER_COLOR[r.provider]} />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {r.changePct === null ? (
                      <span className="text-muted">new</span>
                    ) : (
                      <span className={r.changePct > 0 ? "text-bad" : "text-good"}>
                        {r.changePct > 0 ? "↑" : "↓"} {Math.abs(r.changePct).toFixed(0)}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
