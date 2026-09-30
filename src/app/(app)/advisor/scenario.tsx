"use client";

import clsx from "clsx";
import { ArrowLeft, ArrowRight, CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Legend, ProviderBeforeAfter, providerLegend, WaterfallChart } from "@/components/charts";
import { Tabs } from "@/components/client-ui";
import { ProjectionPanel } from "@/components/ProjectionPanel";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Card, CardHeader, Pill } from "@/components/ui";
import { PROVIDER_NAME, usd } from "@/lib/format";
import { waterfall } from "@/lib/projection";
import type { ScenarioView } from "@/lib/services/scenarios";

const ROLLOUT: Record<string, { startWeek: number; fullWeek: number }> = {
  serverless: { startWeek: 2, fullWeek: 6 },
  containers: { startWeek: 2, fullWeek: 5 },
  cross_cloud_cheapest: { startWeek: 4, fullWeek: 8 },
  cheapest_region: { startWeek: 2, fullWeek: 4 },
  arm: { startWeek: 1, fullWeek: 4 },
  spot: { startWeek: 1, fullWeek: 3 },
  rightsizing: { startWeek: 0, fullWeek: 2 },
  storage_tiering: { startWeek: 0, fullWeek: 5 },
  schedule_nonprod: { startWeek: 0, fullWeek: 1 },
  remove_idle: { startWeek: 0, fullWeek: 1 },
  commitments: { startWeek: 0, fullWeek: 0 },
};

type TabId = "summary" | "breakdown" | "changes" | "timeline";

/** One scenario, one page: the answer first, the detail one tab away. */
export function ScenarioDetail({ s, growthRate, initialTab }: { s: ScenarioView; growthRate: number; initialTab?: string }) {
  const r = s.result;
  const changes = r.steps.reduce((n, x) => n + x.items.length, 0);
  const tabs: { id: TabId; label: string }[] = [
    { id: "summary", label: "Summary" },
    { id: "breakdown", label: "Savings breakdown" },
    { id: "changes", label: `Changes (${changes})` },
    { id: "timeline", label: "Over time" },
  ];
  const [tab, setTab] = useState<TabId>(tabs.some((t) => t.id === initialTab) ? (initialTab as TabId) : "summary");

  return (
    <div>
      <Link href="/advisor/history" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
        <ArrowLeft size={12} /> All scenarios
      </Link>
      <h1 className="max-w-4xl text-[21px] font-semibold leading-snug tracking-tight text-ink">{s.prompt}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <span>
          {new Date(s.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
          {s.createdBy ? ` · ${s.createdBy}` : ""} ·
        </span>
        {s.plan.transforms.map((t, i) => (
          <Pill key={i} className="bg-violet-50 text-violet-700 ring-violet-200">
            {t.type.replace(/_/g, " ")}
            {t.providers.length ? ` · ${t.providers.join("/")}` : ""}
            {t.workloads.length ? ` · ${t.workloads.join(", ")}` : ""}
            {t.commitmentTerm ? ` · ${t.commitmentTerm}` : ""}
          </Pill>
        ))}
        <Pill className={s.source === "ai" ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-slate-100 text-slate-600 ring-slate-200"}>{s.source === "ai" ? `planned by ${s.model}` : "keyword planner"}</Pill>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { l: "Monthly spend today", v: usd(r.baselineMonthly) },
          { l: "With this scenario", v: usd(r.scenarioMonthly) },
          { l: "Monthly savings", v: `${usd(r.monthlySavings)}`, sub: `${Math.round(r.savingsPct)}% of spend`, good: true },
          { l: "Payback", v: r.paybackMonths !== null ? `${r.paybackMonths} months` : "—", sub: `${usd(r.migrationCost)} one-time migration` },
        ].map((k) => (
          <Card key={k.l} className="px-4 py-3">
            <p className="text-[11px] text-muted">{k.l}</p>
            <p className={clsx("mt-1 text-[19px] font-semibold tracking-tight", k.good && "text-good")}>{k.v}</p>
            {k.sub && <p className="text-[11px] text-muted">{k.sub}</p>}
          </Card>
        ))}
      </div>

      <div className="mt-6">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
      </div>
      <div className="mt-5">
        {tab === "summary" && <Summary s={s} onChanges={() => setTab("changes")} />}
        {tab === "breakdown" && <Breakdown s={s} />}
        {tab === "changes" && <Changes s={s} />}
        {tab === "timeline" && <Timeline s={s} growthRate={growthRate} />}
      </div>
    </div>
  );
}

function Summary({ s, onChanges }: { s: ScenarioView; onChanges: () => void }) {
  const n = s.narrative;
  const left = s.result.notEligible.length;
  return (
    <div className="space-y-4">
      <Card className="p-6">
        <p className="text-[17px] font-semibold leading-snug text-ink">{n.headline}</p>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-slate-700">{n.summary}</p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <p className="text-[13px] font-semibold text-ink">Key points</p>
          <ul className="mt-3 space-y-2 text-[13px] leading-relaxed">
            {n.keyPoints.map((k) => (
              <li key={k} className="flex gap-2">
                <CircleCheck size={15} className="mt-0.5 shrink-0 text-good" />
                {k}
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-5">
          <p className="text-[13px] font-semibold text-ink">Next steps</p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed">
            {n.nextSteps.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ol>
        </Card>
      </div>
      {n.caveats.length > 0 && (
        <Card className="p-5">
          <p className="text-[13px] font-semibold text-ink">Caveats</p>
          <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-slate-700">
            {n.caveats.slice(0, 6).map((k) => (
              <li key={k} className="flex gap-2">
                <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-500" />
                {k}
              </li>
            ))}
          </ul>
          {left > 0 && (
            <button onClick={onChanges} className="mt-3 text-[12.5px] font-medium text-brand hover:underline">
              {left} workload{left > 1 ? "s were" : " was"} left out — see why
            </button>
          )}
        </Card>
      )}
    </div>
  );
}

function Breakdown({ s }: { s: ScenarioView }) {
  const r = s.result;
  const steps = useMemo(() => waterfall(r.baselineMonthly, r.steps.filter((x) => x.monthlySavings > 0).map((x) => ({ label: x.label, savings: x.monthlySavings }))), [r]);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Savings by lever" subtitle="Applied in dependency order — no resource is counted twice" />
        <div className="px-3 pb-3 pt-2">
          <WaterfallChart steps={steps} height={300} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Spend by provider" subtitle="Today (gray) vs. with this scenario (provider color)" />
        <div className="px-5 pt-3">
          <Legend items={[{ label: "Today", color: "#cbd5e1" }, ...providerLegend]} />
        </div>
        <div className="px-3 pb-3 pt-2">
          <ProviderBeforeAfter data={r.byProvider} height={260} />
        </div>
        <p className="border-t border-line px-5 py-3 text-[11.5px] text-muted">
          {r.byProvider.map((p) => `${PROVIDER_NAME[p.provider]} ${usd(p.before)} → ${usd(p.after)}`).join(" · ")}
        </p>
      </Card>
    </div>
  );
}

function Changes({ s }: { s: ScenarioView }) {
  const r = s.result;
  return (
    <div className="space-y-4">
      {r.steps.map((st) => (
        <Card key={st.type}>
          <div className="flex items-center justify-between px-5 py-3.5">
            <span className="text-[13.5px] font-semibold">{st.label}</span>
            <span className="tabular text-[13px] font-semibold text-good">{usd(st.monthlySavings)}/mo</span>
          </div>
          {st.items.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {st.items.map((i) => (
                <li key={i.title} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[12.5px]">
                  <span className="flex min-w-0 items-center gap-1.5 text-slate-700">
                    <ProviderLogo provider={i.provider} size={13} />
                    {i.targetProvider && i.targetProvider !== i.provider && (
                      <>
                        <ArrowRight size={11} /> <ProviderLogo provider={i.targetProvider} size={13} />
                      </>
                    )}
                    <span className="truncate">{i.title}</span>
                  </span>
                  <span className="tabular shrink-0 text-muted">{usd(i.monthlySavings)}/mo</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-line px-5 py-3 text-[12.5px] text-muted">No eligible resources for this lever.</p>
          )}
        </Card>
      ))}
      {r.notEligible.length > 0 && (
        <Card>
          <CardHeader title="Left out, and why" subtitle="Workloads this scenario did not change" />
          <ul className="mt-2 divide-y divide-line">
            {r.notEligible.map((n) => (
              <li key={n.name} className="px-5 py-3 text-[12.5px] leading-relaxed">
                <b className="font-semibold text-ink">{n.name}</b>
                <p className="mt-0.5 text-slate-700">{n.reason}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Timeline({ s, growthRate }: { s: ScenarioView; growthRate: number }) {
  const r = s.result;
  const inputs = useMemo(
    () =>
      r.steps
        .filter((x) => x.monthlySavings > 0)
        .map((x) => ({
          id: x.type,
          label: x.label,
          currentMonthlyCost: x.items.reduce((a, i) => a + i.currentMonthlyCost, 0),
          projectedMonthlyCost: x.items.reduce((a, i) => a + i.currentMonthlyCost - i.monthlySavings, 0),
          migrationCost: x.items.reduce((a, i) => a + i.migrationCost, 0),
          rollout: ROLLOUT[x.type] ?? { startWeek: 1, fullWeek: 4 },
        })),
    [r],
  );
  if (!inputs.length) return <Card className="p-8 text-center text-[13px] text-muted">This scenario does not change spend, so there is nothing to project.</Card>;
  return <ProjectionPanel inputs={inputs} growthRate={growthRate} />;
}
