"use client";

import clsx from "clsx";
import { ArrowRight, Boxes, PenTool } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArchitectureCompare } from "@/components/diagram/ArchitectureCompare";
import { WaterfallChart } from "@/components/charts";
import { CostBreakdown } from "@/components/CostBreakdown";
import { ProjectionPanel } from "@/components/ProjectionPanel";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Card, CardHeader, CategoryBadge, Empty } from "@/components/ui";
import type { ArchitectureSpec } from "@/lib/engine/types";
import { usd } from "@/lib/format";
import type { Provider } from "@/lib/pricing/catalog";
import { waterfall } from "@/lib/projection";
import { CustomArchitecture } from "./custom";

export interface SavingsRec {
  id: string;
  title: string;
  category: string;
  provider: Provider;
  targetProvider: Provider | null;
  currentMonthlyCost: number;
  projectedMonthlyCost: number;
  monthlySavings: number;
  savingsPct: number;
  migrationCost: number;
  effort: string;
  risk: string;
  overlaps: boolean;
  source: string;
  rollout: { startWeek: number; fullWeek: number };
  current?: ArchitectureSpec;
  proposed?: ArchitectureSpec;
}

export function SavingsView(props: { recs: SavingsRec[]; initialSelection: string[]; baselineSpend: number; growthRate: number; ai: boolean; initialMode: "suggested" | "custom" }) {
  const [mode, setMode] = useState(props.initialMode);
  return (
    <div>
      <div className="mb-5 inline-flex rounded-xl bg-white p-1 ring-1 ring-line">
        {[
          { id: "suggested" as const, label: "Suggested improvements", icon: Boxes },
          { id: "custom" as const, label: "Analyze any architecture", icon: PenTool },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={clsx("inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-medium", mode === m.id ? "bg-navy-900 text-white" : "text-muted hover:text-ink")}
          >
            <m.icon size={15} /> {m.label}
          </button>
        ))}
      </div>
      {mode === "suggested" ? <Suggested {...props} /> : <CustomArchitecture ai={props.ai} growthRate={props.growthRate} />}
    </div>
  );
}

function Suggested({ recs, initialSelection, baselineSpend, growthRate }: { recs: SavingsRec[]; initialSelection: string[]; baselineSpend: number; growthRate: number }) {
  const [selected, setSelected] = useState<string[]>(initialSelection);
  const [archOnly, setArchOnly] = useState(false);
  const visible = recs.filter((r) => !archOnly || r.category === "architecture" || r.category === "cross_cloud");
  const chosen = recs.filter((r) => selected.includes(r.id));
  const conflicts = chosen.filter((r) => r.overlaps);

  const inputs = useMemo(
    () => chosen.map((r) => ({ id: r.id, label: r.title, currentMonthlyCost: r.currentMonthlyCost, projectedMonthlyCost: r.projectedMonthlyCost, migrationCost: r.migrationCost, rollout: r.rollout })),
    [chosen],
  );
  const steps = useMemo(
    () => waterfall(baselineSpend, [...chosen].sort((a, b) => b.monthlySavings - a.monthlySavings).map((r) => ({ label: r.title, savings: r.monthlySavings }))),
    [chosen, baselineSpend],
  );
  const single = chosen.length === 1 && chosen[0].current && chosen[0].proposed ? chosen[0] : null;
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="grid gap-5 xl:grid-cols-[340px_1fr]">
      <Card className="h-fit xl:sticky xl:top-6">
        <CardHeader
          title="Improvements"
          subtitle={`${chosen.length} selected · ${usd(chosen.reduce((s, r) => s + r.monthlySavings, 0))}/mo`}
          action={
            <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={archOnly} onChange={(e) => setArchOnly(e.target.checked)} className="accent-brand" /> Architecture only
            </label>
          }
        />
        <div className="mt-3 flex gap-2 px-5 text-[11px]">
          <button className="font-medium text-brand hover:underline" onClick={() => setSelected(visible.filter((r) => !r.overlaps).map((r) => r.id))}>
            Select all (no overlaps)
          </button>
          <span className="text-line">|</span>
          <button className="font-medium text-muted hover:text-ink" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
        <ul className="mt-2 max-h-[640px] overflow-auto px-2 pb-3">
          {visible.map((r) => (
            <li key={r.id}>
              <label className={clsx("flex cursor-pointer gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-50", selected.includes(r.id) && "bg-brand-50/60")}>
                <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} className="mt-1 accent-brand" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12.5px] font-medium text-ink">{r.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <ProviderLogo provider={r.provider} size={12} />
                    {r.targetProvider && r.targetProvider !== r.provider && (
                      <>
                        <ArrowRight size={10} /> <ProviderLogo provider={r.targetProvider} size={12} />
                      </>
                    )}
                    <span className="font-medium text-good">{usd(r.monthlySavings)}/mo</span>· {Math.round(r.savingsPct)}%
                    {r.overlaps && <span className="text-amber-600">· alternative</span>}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Card>

      <div className="min-w-0 space-y-4">
        {!chosen.length ? (
          <Empty title="Select one or more improvements">Pick suggested architectures on the left to chart their cost improvement.</Empty>
        ) : (
          <>
            {conflicts.length > 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800">
                {conflicts.length} selected item(s) are alternatives that touch the same resources as other recommendations — combined savings may be overstated.
              </p>
            )}
            {single && <SingleArchitecture rec={single} />}
            <Card>
              <CardHeader title="From today’s spend to optimized" subtitle={`Monthly run-rate ${usd(baselineSpend)} minus each selected improvement at full rollout`} />
              <div className="px-3 pb-3 pt-2">
                <WaterfallChart steps={steps} />
              </div>
            </Card>
            <ProjectionPanel inputs={inputs} growthRate={growthRate} />
          </>
        )}
      </div>
    </div>
  );
}

function SingleArchitecture({ rec }: { rec: SavingsRec }) {
  return (
    <Card>
      <CardHeader
        title={rec.title}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <CategoryBadge category={rec.category} /> {usd(rec.currentMonthlyCost)} → <b className="text-good">{usd(rec.projectedMonthlyCost)}</b> per month
          </span>
        }
        action={
          <Link href={`/recommendations/${rec.id}`} className="text-xs font-medium text-brand hover:underline">
            Open recommendation →
          </Link>
        }
      />
      <div className="p-5">
        <ArchitectureCompare current={rec.current!} proposed={rec.proposed!} bare title="Architecture" filename={rec.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)} />
      </div>
      <div className="border-t border-line p-5">
        <CostBreakdown current={rec.current!.components} proposed={rec.proposed!.components} />
      </div>
    </Card>
  );
}
