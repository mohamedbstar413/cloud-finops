"use client";

import clsx from "clsx";
import { ArrowRight, BrainCircuit, CircleCheck, History, Send, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Legend, ProviderBeforeAfter, providerLegend, WaterfallChart } from "@/components/charts";
import { api, inputClass, Notice, Spinner } from "@/components/client-ui";
import { ProjectionPanel } from "@/components/ProjectionPanel";
import { ProviderLogo } from "@/components/ProviderLogo";
import { buttonClass, Card, CardHeader, Pill } from "@/components/ui";
import type { Narrative } from "@/lib/ai/advisor";
import type { WhatIfPlan, WhatIfResult } from "@/lib/engine/whatif";
import { PROVIDER_NAME, usd } from "@/lib/format";
import { waterfall } from "@/lib/projection";

export interface ScenarioView {
  id: string;
  prompt: string;
  plan: WhatIfPlan;
  result: WhatIfResult;
  narrative: Narrative;
  model: string | null;
  source: string;
  createdAt: string;
}

const PRESETS = [
  "What if we moved all possible workloads to serverless?",
  "What if every workload ran on its cheapest cloud?",
  "What if we used Spot everywhere it is safe?",
  "What if we committed to 3-year plans after optimizing?",
  "What if we shut down non-production nights and weekends?",
  "What if we migrated everything to Arm (Graviton/Ampere)?",
  "What if we applied every optimization lever?",
];

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

export function AdvisorView({ history: initial, initialPrompt, canUse, growthRate }: { history: ScenarioView[]; initialPrompt?: string; canUse: boolean; growthRate: number }) {
  const [history, setHistory] = useState(initial);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [active, setActive] = useState<ScenarioView | null>(initial[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ran = useRef(false);

  async function ask(q: string) {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const s = await api<ScenarioView>("/api/advisor/whatif", { body: { prompt: q } });
      setHistory((h) => [s, ...h]);
      setActive(s);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialPrompt && !ran.current) {
      ran.current = true;
      void ask(initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
      <div className="min-w-0 space-y-4">
        <Card className="p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(prompt);
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <BrainCircuit size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand" />
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What if we moved the api-platform to serverless and committed to 1-year plans on AWS only?" className={clsx(inputClass, "h-11 pl-9 text-[14px]")} />
            </div>
            <button type="submit" className={clsx(buttonClass("primary"), "h-11 px-5")} disabled={busy || !canUse || !prompt.trim()}>
              {busy ? <Spinner /> : <Send size={14} />} Simulate
            </button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                disabled={busy || !canUse}
                onClick={() => {
                  setPrompt(p);
                  void ask(p);
                }}
                className="rounded-full bg-slate-100 px-3 py-1 text-[11.5px] text-slate-700 hover:bg-brand-50 hover:text-brand disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
          {!canUse && <p className="mt-2 text-xs text-muted">Viewers can browse saved scenarios but not run new ones.</p>}
        </Card>

        {err && <Notice tone="error">{err}</Notice>}
        {busy && (
          <Card className="animate-pulse-soft p-6 text-[13px] text-muted">
            Planning the scenario, applying transforms to every workload in dependency order, and pricing the result…
          </Card>
        )}
        {!busy && active && <ScenarioResult s={active} growthRate={growthRate} />}
        {!busy && !active && (
          <Card className="p-8 text-center text-[13px] text-muted">Ask a question or pick a preset to simulate a new architecture strategy across all your clouds.</Card>
        )}
      </div>

      <Card className="h-fit">
        <CardHeader title={<span className="inline-flex items-center gap-1.5"><History size={14} /> Scenario history</span>} subtitle="Shared with your organization" />
        <ul className="mt-2 max-h-[720px] overflow-auto px-2 pb-3">
          {history.map((h) => (
            <li key={h.id}>
              <button onClick={() => setActive(h)} className={clsx("w-full rounded-lg px-3 py-2 text-left hover:bg-slate-50", active?.id === h.id && "bg-brand-50/70")}>
                <p className="line-clamp-2 text-[12.5px] font-medium text-ink">{h.prompt}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  <span className="font-medium text-good">−{usd(h.result.monthlySavings)}/mo</span> · {new Date(h.createdAt).toLocaleDateString()} · {h.source === "ai" ? "AI" : "rules"}
                </p>
              </button>
            </li>
          ))}
          {!history.length && <li className="px-3 py-4 text-xs text-muted">No scenarios yet.</li>}
        </ul>
      </Card>
    </div>
  );
}

function ScenarioResult({ s, growthRate }: { s: ScenarioView; growthRate: number }) {
  const r = s.result;
  const steps = useMemo(() => waterfall(r.baselineMonthly, r.steps.filter((x) => x.monthlySavings > 0).map((x) => ({ label: x.label, savings: x.monthlySavings }))), [r]);
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

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
          <span>Interpreted as:</span>
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
        <p className="mt-3 text-[18px] font-semibold">{s.narrative.headline}</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-700">{s.narrative.summary}</p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div>
            <p className="text-xs font-semibold text-ink">Key points</p>
            <ul className="mt-1.5 space-y-1 text-[12.5px]">
              {s.narrative.keyPoints.map((k) => (
                <li key={k} className="flex gap-1.5"><CircleCheck size={14} className="mt-0.5 shrink-0 text-good" />{k}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-ink">Caveats</p>
            <ul className="mt-1.5 space-y-1 text-[12.5px]">
              {s.narrative.caveats.slice(0, 6).map((k) => (
                <li key={k} className="flex gap-1.5"><TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />{k}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-ink">Next steps</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[12.5px]">
              {s.narrative.nextSteps.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ol>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { l: "Monthly spend today", v: usd(r.baselineMonthly) },
          { l: "Scenario spend", v: usd(r.scenarioMonthly) },
          { l: "Monthly savings", v: `${usd(r.monthlySavings)} (${Math.round(r.savingsPct)}%)`, good: true },
          { l: "One-time migration", v: usd(r.migrationCost) },
          { l: "Payback", v: r.paybackMonths !== null ? `${r.paybackMonths} months` : "—" },
        ].map((k) => (
          <Card key={k.l} className="px-4 py-3">
            <p className="text-[11px] text-muted">{k.l}</p>
            <p className={clsx("mt-1 text-[18px] font-semibold", k.good && "text-good")}>{k.v}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Savings by lever" subtitle="Applied in dependency order — no resource is counted twice" />
          <div className="px-3 pb-3 pt-2">
            <WaterfallChart steps={steps} height={280} />
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Spend by provider" subtitle="Today (gray) vs. scenario (provider color)" />
          <div className="px-5 pt-3">
            <Legend items={[{ label: "Today", color: "#cbd5e1" }, ...providerLegend]} />
          </div>
          <div className="px-3 pb-3 pt-2">
            <ProviderBeforeAfter data={r.byProvider} height={280} />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Changes in this scenario" subtitle={`${r.steps.reduce((a, x) => a + x.items.length, 0)} changes across ${r.steps.length} levers`} />
        <div className="mt-3 divide-y divide-line">
          {r.steps.map((st) => (
            <div key={st.type} className="px-5 py-3">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-semibold">{st.label}</span>
                <span className="tabular font-semibold text-good">{usd(st.monthlySavings)}/mo</span>
              </div>
              {st.items.length ? (
                <ul className="mt-1.5 space-y-1">
                  {st.items.map((i) => (
                    <li key={i.title} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <span className="flex min-w-0 items-center gap-1.5 text-slate-700">
                        <ProviderLogo provider={i.provider} size={12} />
                        {i.targetProvider && i.targetProvider !== i.provider && (
                          <>
                            <ArrowRight size={10} /> <ProviderLogo provider={i.targetProvider} size={12} />
                          </>
                        )}
                        <span className="truncate">{i.title}</span>
                      </span>
                      <span className="tabular shrink-0 text-muted">{usd(i.monthlySavings)}/mo</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[12px] text-muted">No eligible resources for this lever.</p>
              )}
            </div>
          ))}
        </div>
        {r.notEligible.length > 0 && (
          <div className="border-t border-line bg-slate-50/60 px-5 py-3">
            <p className="text-[12px] font-semibold">Not eligible (and why)</p>
            <ul className="mt-1.5 grid gap-x-6 gap-y-1 text-[12px] md:grid-cols-2">
              {r.notEligible.map((n) => (
                <li key={n.name}>
                  <b className="font-medium">{n.name}</b> <span className="text-muted">— {n.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {inputs.length > 0 && (
        <div>
          <p className="mb-2 text-[15px] font-semibold">Cost improvement over time</p>
          <ProjectionPanel inputs={inputs} growthRate={growthRate} />
        </div>
      )}
      <p className="text-[11px] text-muted">
        Providers: {r.byProvider.map((p) => `${PROVIDER_NAME[p.provider]} ${usd(p.before)} → ${usd(p.after)}`).join(" · ")}
      </p>
    </div>
  );
}
