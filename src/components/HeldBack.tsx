import { Wrench } from "lucide-react";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Card, Pill } from "@/components/ui";
import { usd } from "@/lib/format";
import type { HeldBackRow } from "@/lib/services/queries";

export const HELD_BACK_KIND: Record<string, { label: string; title: string; cls: string }> = {
  missing_metric: { label: "Metric not collected", title: "A metric the decision needs is not collected", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  short_history: { label: "Not enough history", title: "Not enough history yet", cls: "bg-sky-50 text-sky-700 ring-sky-200" },
  growing: { label: "Usage growing", title: "Usage is growing into the smaller size", cls: "bg-violet-50 text-violet-700 ring-violet-200" },
  in_use: { label: "Still in use", title: "Looks idle, but still in use", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
};

/** Held-back resources grouped by reason, one calm card per group. */
export function HeldBackList({ gaps }: { gaps: HeldBackRow[] }) {
  const groups = Object.keys(HELD_BACK_KIND)
    .map((kind) => ({ kind, rows: gaps.filter((g) => g.kind === kind) }))
    .concat([{ kind: "other", rows: gaps.filter((g) => !HELD_BACK_KIND[g.kind]) }])
    .filter((g) => g.rows.length);
  return (
    <div className="space-y-5">
      {groups.map(({ kind, rows }) => (
        <section key={kind}>
          <h2 className="mb-2.5 flex items-center gap-2 text-[14px] font-semibold text-ink">
            {HELD_BACK_KIND[kind]?.title ?? "Other"}
            <span className="tabular rounded-full bg-slate-100 px-1.5 py-px text-[11px] font-medium text-slate-600">{rows.length}</span>
          </h2>
          <Card className="divide-y divide-line">
            {rows.map((g) => (
              <div key={`${g.resourceId}:${g.detector}`} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Pill className={HELD_BACK_KIND[g.kind]?.cls ?? HELD_BACK_KIND.in_use.cls}>{HELD_BACK_KIND[g.kind]?.label ?? g.kind}</Pill>
                    <span className="truncate text-[13.5px] font-semibold text-ink">{g.resource}</span>
                    {g.provider && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted">
                        <ProviderLogo provider={g.provider} size={13} /> {g.accountName}
                      </span>
                    )}
                  </span>
                  <span className="tabular text-xs text-muted">{usd(g.monthlyCost)}/mo</span>
                </div>
                <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-slate-700">{g.reason}</p>
                {g.fix && (
                  <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-ink">
                    <Wrench size={13} className="mt-0.5 shrink-0 text-muted" />
                    <span>
                      <span className="text-muted">Next step:</span> {g.fix}
                    </span>
                  </p>
                )}
              </div>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
