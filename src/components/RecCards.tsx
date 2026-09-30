import { ArrowRight, Boxes, Cloud, Cpu, Database, Gauge, HardDrive, Moon, Siren, Trash2, Waypoints, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { ProviderLogo } from "@/components/ProviderLogo";
import { CategoryBadge, ImpactBadge, Pill } from "@/components/ui";
import { PROVIDER_NAME, usd } from "@/lib/format";
import type { RecRow } from "@/lib/services/queries";

export const CATEGORY_ICON: Record<string, { icon: LucideIcon; color: string; bg: string }> = {
  architecture: { icon: Boxes, color: "text-violet-600", bg: "bg-violet-50" },
  cross_cloud: { icon: Cloud, color: "text-teal-600", bg: "bg-teal-50" },
  rightsizing: { icon: Gauge, color: "text-amber-600", bg: "bg-amber-50" },
  idle: { icon: Trash2, color: "text-slate-600", bg: "bg-slate-100" },
  commitment: { icon: Cpu, color: "text-sky-600", bg: "bg-sky-50" },
  storage: { icon: HardDrive, color: "text-emerald-600", bg: "bg-emerald-50" },
  scheduling: { icon: Moon, color: "text-indigo-600", bg: "bg-indigo-50" },
  anomaly: { icon: Siren, color: "text-rose-600", bg: "bg-rose-50" },
  database: { icon: Database, color: "text-blue-600", bg: "bg-blue-50" },
  network: { icon: Waypoints, color: "text-violet-600", bg: "bg-violet-50" },
};

export function CategoryIcon({ category, size = 16 }: { category: string; size?: number }) {
  const c = CATEGORY_ICON[category] ?? CATEGORY_ICON.architecture;
  const Icon = c.icon;
  return (
    <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${c.bg} ${c.color}`}>
      <Icon size={size} />
    </span>
  );
}

export function TopRecCard({ rec }: { rec: RecRow }) {
  return (
    <Link href={`/recommendations/${rec.id}`} className="group flex flex-col rounded-xl border border-line bg-white p-4 transition-shadow hover:shadow-md">
      <CategoryIcon category={rec.category} />
      <p className="mt-3 line-clamp-2 min-h-[36px] text-[13px] font-semibold leading-snug text-ink">{rec.title}</p>
      <p className="mt-3 text-[17px] font-semibold text-ink">
        {usd(rec.monthlySavings)} <span className="text-xs font-normal text-muted">/ month</span>
      </p>
      <p className="text-xs font-medium text-good">{Math.round(rec.savingsPct)}% savings</p>
      <div className="mt-3">
        <CategoryBadge category={rec.category} />
      </div>
    </Link>
  );
}

export function RecListItem({ rec }: { rec: RecRow }) {
  return (
    <Link href={`/recommendations/${rec.id}`} className="group flex items-start gap-4 rounded-xl border border-line bg-white p-4 transition-shadow hover:shadow-md">
      <CategoryIcon category={rec.category} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <CategoryBadge category={rec.category} />
          {rec.source === "ai" && <Pill className="bg-blue-50 text-blue-700 ring-blue-200">AI-generated</Pill>}
          {rec.status !== "open" && <Pill className="bg-slate-100 text-slate-600 ring-slate-200">{rec.status.replace("_", " ")}</Pill>}
        </div>
        <p className="mt-1.5 text-[14px] font-semibold text-ink">{rec.title}</p>
        <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{rec.summary}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
            <ProviderLogo provider={rec.provider} size={14} />
            {PROVIDER_NAME[rec.provider]}
            {rec.targetProvider && rec.targetProvider !== rec.provider && (
              <>
                <ArrowRight size={12} className="text-muted" />
                <ProviderLogo provider={rec.targetProvider} size={14} />
                {PROVIDER_NAME[rec.targetProvider]}
              </>
            )}
          </span>
          {rec.accountName && <span className="text-xs text-muted">· {rec.accountName}</span>}
          <ImpactBadge impact={rec.impact} />
          {rec.overlapsWith && (
            <span title={`Alternative to “${rec.overlapsWith.title}” — not counted in totals`}>
              <Pill className="bg-white text-muted ring-line">Alternative</Pill>
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[17px] font-semibold text-ink">
          {usd(rec.monthlySavings)}
          <span className="text-xs font-normal text-muted"> / month</span>
        </p>
        <p className="text-xs font-medium text-good">{Math.round(rec.savingsPct)}% savings</p>
        <p className="mt-2 text-[11px] text-muted">
          {rec.effort} effort · {rec.risk} risk
        </p>
      </div>
      <ArrowRight size={16} className="mt-1 shrink-0 self-center text-slate-300 transition-colors group-hover:text-ink" />
    </Link>
  );
}
