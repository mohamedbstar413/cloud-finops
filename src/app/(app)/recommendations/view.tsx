"use client";

import clsx from "clsx";
import { RefreshCw, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, inputClass, Notice, Select, Spinner } from "@/components/client-ui";
import { RecListItem } from "@/components/RecCards";
import { buttonClass, Empty } from "@/components/ui";
import { CATEGORY_LABEL, usd } from "@/lib/format";
import type { RecRow } from "@/lib/services/queries";

export function RecommendationActionsBar({ ai, canRun }: { ai: boolean; canRun: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"run" | "ai" | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);

  async function run() {
    setBusy("run");
    setMsg(null);
    try {
      const r = await api<{ recommendations: number; architecture: number; monthlySavings: number }>("/api/analysis", { method: "POST" });
      setMsg({ tone: "success", text: `Analysis complete: ${r.recommendations} recommendations (${r.architecture} architecture), ${usd(r.monthlySavings)}/mo potential.` });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function discover() {
    setBusy("ai");
    setMsg({ tone: "info", text: "The AI advisor is reviewing every workload for architectures the rules missed…" });
    try {
      const r = await api<{ created: { title: string; monthlySavings: number }[]; rejected: { title: string; reason: string }[] }>("/api/advisor/discover", { method: "POST" });
      setMsg({
        tone: "success",
        text: r.created.length
          ? `AI discovery added ${r.created.length} proposal(s): ${r.created.map((c) => `${c.title} (${usd(c.monthlySavings)}/mo)`).join("; ")}${r.rejected.length ? ` · ${r.rejected.length} rejected by the pricing engine` : ""}.`
          : `No new proposals beat the existing recommendations${r.rejected.length ? ` (${r.rejected.length} rejected by the pricing engine)` : ""}.`,
      });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button className={buttonClass("secondary")} onClick={run} disabled={!canRun || busy !== null}>
          {busy === "run" ? <Spinner /> : <RefreshCw size={14} />} Re-run analysis
        </button>
        <button
          className={buttonClass("primary")}
          onClick={discover}
          disabled={!ai || !canRun || busy !== null}
          title={ai ? "Ask the AI advisor for novel architectures" : "Set OPENAI_API_KEY to enable AI discovery"}
        >
          {busy === "ai" ? <Spinner /> : <Sparkles size={14} />} AI architecture discovery
        </button>
      </div>
      {msg && (
        <div className="max-w-xl">
          <Notice tone={msg.tone} onClose={() => setMsg(null)}>
            {msg.text}
          </Notice>
        </div>
      )}
    </div>
  );
}

const STATUS_TABS = [
  { id: "active", label: "Active" },
  { id: "snoozed", label: "Snoozed" },
  { id: "applied", label: "Applied" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
] as const;

export function RecommendationsView({ recs }: { recs: RecRow[] }) {
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("all");
  const [category, setCategory] = useState("all");
  const [account, setAccount] = useState("all");
  const [minSavings, setMinSavings] = useState("0");
  const [sort, setSort] = useState("savings_desc");
  const [status, setStatus] = useState<(typeof STATUS_TABS)[number]["id"]>("active");
  const [impact, setImpact] = useState<string | null>(null);
  const [hideAlternatives, setHideAlternatives] = useState(false);

  const accounts = useMemo(() => [...new Set(recs.map((r) => r.accountName).filter(Boolean))] as string[], [recs]);
  const categories = useMemo(() => [...new Set(recs.map((r) => r.category))], [recs]);

  const byStatus = recs.filter((r) =>
    status === "active" ? r.status === "open" || r.status === "in_progress" : status === "all" ? true : r.status === status,
  );
  const filtered = byStatus
    .filter((r) => !q || `${r.title} ${r.summary}`.toLowerCase().includes(q.toLowerCase()))
    .filter((r) => provider === "all" || r.provider === provider || r.targetProvider === provider)
    .filter((r) => category === "all" || r.category === category)
    .filter((r) => account === "all" || r.accountName === account)
    .filter((r) => r.monthlySavings >= Number(minSavings))
    .filter((r) => !hideAlternatives || !r.overlapsWith)
    .sort((a, b) => {
      if (sort === "savings_asc") return a.monthlySavings - b.monthlySavings;
      if (sort === "pct_desc") return b.savingsPct - a.savingsPct;
      if (sort === "effort") return ["low", "medium", "high"].indexOf(a.effort) - ["low", "medium", "high"].indexOf(b.effort) || b.monthlySavings - a.monthlySavings;
      return b.monthlySavings - a.monthlySavings;
    });
  const shown = impact ? filtered.filter((r) => r.impact === impact) : filtered;
  const counts = { total: filtered.length, high: filtered.filter((r) => r.impact === "high").length, medium: filtered.filter((r) => r.impact === "medium").length, low: filtered.filter((r) => r.impact === "low").length };
  const total = shown.filter((r) => !r.overlapsWith && r.category !== "anomaly").reduce((s, r) => s + r.monthlySavings, 0);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="relative min-w-[240px] flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recommendations…" className={clsx(inputClass, "pl-8")} />
        </label>
        <Select className="w-36" value={provider} onChange={setProvider} options={[{ value: "all", label: "All providers" }, { value: "aws", label: "AWS" }, { value: "azure", label: "Azure" }, { value: "gcp", label: "GCP" }]} />
        <Select className="w-40" value={category} onChange={setCategory} options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))]} />
        <Select className="w-44" value={account} onChange={setAccount} options={[{ value: "all", label: "All accounts" }, ...accounts.map((a) => ({ value: a, label: a }))]} />
        <Select className="w-40" value={minSavings} onChange={setMinSavings} options={[{ value: "0", label: "Any savings" }, { value: "100", label: "≥ $100 / mo" }, { value: "500", label: "≥ $500 / mo" }, { value: "1000", label: "≥ $1,000 / mo" }, { value: "2500", label: "≥ $2,500 / mo" }]} />
        <Select className="w-40" value={sort} onChange={setSort} options={[{ value: "savings_desc", label: "Highest savings" }, { value: "savings_asc", label: "Lowest savings" }, { value: "pct_desc", label: "Highest savings %" }, { value: "effort", label: "Easiest first" }]} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { id: null, label: "Total", value: counts.total, cls: "bg-white ring-line text-ink" },
          { id: "high", label: "High Impact", value: counts.high, cls: "bg-red-50/70 ring-red-100 text-red-600" },
          { id: "medium", label: "Medium", value: counts.medium, cls: "bg-amber-50/70 ring-amber-100 text-amber-600" },
          { id: "low", label: "Low", value: counts.low, cls: "bg-sky-50/70 ring-sky-100 text-sky-600" },
        ].map((c) => (
          <button
            key={c.label}
            onClick={() => setImpact(c.id)}
            className={clsx("rounded-xl px-4 py-3 text-left ring-1 ring-inset transition-shadow", c.cls, impact === c.id && "shadow-[0_0_0_2px_#2563eb]")}
          >
            <p className="text-[22px] font-semibold">{c.value}</p>
            <p className="text-xs font-medium opacity-80">{c.label}</p>
          </button>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {STATUS_TABS.map((t) => (
            <button key={t.id} onClick={() => setStatus(t.id)} className={clsx("rounded-md px-3 py-1 text-xs font-medium", status === t.id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink")}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={hideAlternatives} onChange={(e) => setHideAlternatives(e.target.checked)} className="accent-brand" />
            Hide alternatives
          </label>
          <span>
            {shown.length} shown · <b className="text-ink">{usd(total)}/mo</b> de-duplicated savings
          </span>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {shown.length ? shown.map((r) => <RecListItem key={r.id} rec={r} />) : <Empty title="No recommendations match these filters" />}
      </div>
    </div>
  );
}
