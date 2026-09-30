"use client";

import clsx from "clsx";
import { Calendar, Download } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/client-ui";
import { ProviderLogo } from "@/components/ProviderLogo";
import { buttonClass } from "@/components/ui";
import { CATEGORY_LABEL } from "@/lib/format";
import type { Provider } from "@/lib/pricing/catalog";
import type { CostFilters } from "@/lib/services/queries";

function useParamSetter() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  return (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    router.push(`${path}?${next.toString()}`, { scroll: false });
  };
}

export function ProviderTabs({ value }: { value: Provider[] }) {
  const set = useParamSetter();
  const current = value.length === 1 ? value[0] : null;
  const btn = (active: boolean) => clsx("inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium ring-1 ring-inset", active ? "bg-brand-50 text-brand ring-brand/40" : "bg-white text-ink ring-line hover:bg-slate-50");
  return (
    <div className="flex flex-wrap gap-2">
      <button className={btn(!current)} onClick={() => set({ provider: null })}>
        All Providers
      </button>
      {(["aws", "azure", "gcp"] as Provider[]).map((p) => (
        <button key={p} className={btn(current === p)} onClick={() => set({ provider: p })}>
          <ProviderLogo provider={p} size={15} /> {{ aws: "AWS", azure: "Azure", gcp: "GCP" }[p]}
        </button>
      ))}
    </div>
  );
}

export function PeriodFilter({ days }: { days: number }) {
  const set = useParamSetter();
  return (
    <label className="relative">
      <Calendar size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <select value={days} onChange={(e) => set({ days: e.target.value })} className="h-9 rounded-lg border border-line bg-white pl-8 pr-3 text-[13px] outline-none focus:border-brand" aria-label="Period">
        {[7, 30, 60, 90].map((d) => (
          <option key={d} value={d}>
            Last {d} days
          </option>
        ))}
      </select>
    </label>
  );
}

export function ExportButton() {
  const sp = useSearchParams();
  const q = new URLSearchParams(sp.toString());
  q.set("format", "csv");
  return (
    <a href={`/api/costs?${q.toString()}`} className={buttonClass("secondary")}>
      <Download size={14} /> Export
    </a>
  );
}

export function CostFilterBar({
  options,
  filters,
}: {
  options: { regions: string[]; categories: string[]; workloads: string[]; accounts: { id: string; label: string }[] };
  filters: CostFilters;
}) {
  const set = useParamSetter();
  return (
    <div className="px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] font-semibold">Filters</p>
        <button onClick={() => set({ category: null, region: null, account: null, workload: null })} className="text-xs font-medium text-brand hover:underline">
          Reset
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select label="Service category" value={filters.categories[0] ?? "all"} onChange={(v) => set({ category: v })} options={[{ value: "all", label: "All" }, ...options.categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))]} />
        <Select label="Region" value={filters.regions[0] ?? "all"} onChange={(v) => set({ region: v })} options={[{ value: "all", label: "All" }, ...options.regions.map((r) => ({ value: r, label: r }))]} />
        <Select label="Account" value={filters.accounts[0] ?? "all"} onChange={(v) => set({ account: v })} options={[{ value: "all", label: "All" }, ...options.accounts.map((a) => ({ value: a.id, label: a.label }))]} />
        <Select label="Tag: app / workload" value={filters.workloads[0] ?? "all"} onChange={(v) => set({ workload: v })} options={[{ value: "all", label: "All" }, ...options.workloads.map((w) => ({ value: w, label: w }))]} />
      </div>
    </div>
  );
}

