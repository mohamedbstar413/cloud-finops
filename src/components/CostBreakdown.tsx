import { usd } from "@/lib/format";
import type { PricedComponent } from "@/lib/pricing/components";

/** Side-by-side component cost bars (shared scale) for current vs. proposed. */
export function CostBreakdown({ current, proposed }: { current: PricedComponent[]; proposed: PricedComponent[] }) {
  const max = Math.max(1, ...current.map((c) => Math.abs(c.monthlyCost)), ...proposed.map((c) => Math.abs(c.monthlyCost)));
  const Column = ({ title, items, color }: { title: string; items: PricedComponent[]; color: string }) => (
    <div>
      <p className="mb-2 flex justify-between text-xs font-medium text-muted">
        <span>{title}</span>
        <span className="tabular text-ink">{usd(items.reduce((s, c) => s + c.monthlyCost, 0))}/mo</span>
      </p>
      <ul className="space-y-2">
        {[...items]
          .sort((a, b) => b.monthlyCost - a.monthlyCost)
          .map((c) => (
            <li key={c.id}>
              <div className="flex justify-between gap-2 text-[12px]">
                <span className="truncate text-ink" title={c.pricingNote}>
                  {c.label}
                </span>
                <span className="tabular shrink-0 font-medium">{usd(c.monthlyCost)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                <div className="h-1.5 rounded-full" style={{ width: `${Math.max(1, (Math.abs(c.monthlyCost) / max) * 100)}%`, background: c.monthlyCost < 0 ? "#16a34a" : color }} />
              </div>
              <p className="mt-0.5 truncate text-[10.5px] text-muted">{c.pricingNote}</p>
            </li>
          ))}
      </ul>
    </div>
  );
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Column title="Current components" items={current} color="#94a3b8" />
      <Column title="Proposed components" items={proposed} color="#2a78d6" />
    </div>
  );
}
