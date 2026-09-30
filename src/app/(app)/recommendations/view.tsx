"use client";

import clsx from "clsx";
import { RefreshCw, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, inputClass, Notice, Select, Spinner, waitForJob } from "@/components/client-ui";
import { Pager } from "@/components/Pager";
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
      setMsg({ tone: "info", text: "Analysing your estate…" });
      const { job: queued } = await api<{ job: { id: string } }>("/api/analysis", { method: "POST" });
      const job = await waitForJob(queued.id);
      if (job.status === "failed") throw new Error(job.error ?? "Analysis failed");
      const r = job.result as { recommendations: number; monthlySavings: number; heldBack?: number; created?: number };
      setMsg({
        tone: "success",
        text: `Analysis complete: ${r.recommendations} recommendations${r.created ? ` (${r.created} new)` : ""}, ${usd(r.monthlySavings)}/mo potential.${r.heldBack ? ` ${r.heldBack} resource${r.heldBack > 1 ? "s were" : " was"} held back rather than guessed — see the Held back tab.` : ""}`,
      });
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

const PAGE_SIZE = 8;
const byImpact = ["high", "medium", "low"] as const;

/** A quiet segmented control: one choice, counts beside each option. */
function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1" role="group">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={clsx("whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors", value === o.id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink")}
        >
          {o.label}
          {o.count !== undefined && <span className="tabular ml-1.5 text-muted">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

const sorters: Record<string, (a: RecRow, b: RecRow) => number> = {
  savings_desc: (a, b) => b.monthlySavings - a.monthlySavings,
  pct_desc: (a, b) => b.savingsPct - a.savingsPct,
  effort: (a, b) => ["low", "medium", "high"].indexOf(a.effort) - ["low", "medium", "high"].indexOf(b.effort) || b.monthlySavings - a.monthlySavings,
};

export function OpenRecommendations({ recs, heldBack }: { recs: RecRow[]; heldBack: number }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [provider, setProvider] = useState("all");
  const [sort, setSort] = useState("savings_desc");
  const [impact, setImpact] = useState<"all" | (typeof byImpact)[number]>("all");
  const [account, setAccount] = useState("all");
  const [minSavings, setMinSavings] = useState("0");
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(1);
  // Any change of filter starts again from the first page.
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  const active = useMemo(() => recs.filter((r) => r.status === "open" || r.status === "in_progress"), [recs]);
  const accounts = useMemo(() => [...new Set(active.map((r) => r.accountName).filter(Boolean))] as string[], [active]);
  const categories = useMemo(() => [...new Set(active.map((r) => r.category))], [active]);
  const alternatives = active.filter((r) => r.overlapsWith).length;
  const extraFilters = (account !== "all" ? 1 : 0) + (minSavings !== "0" ? 1 : 0) + (showAlternatives ? 1 : 0);

  const filtered = active
    .filter((r) => !q || `${r.title} ${r.summary}`.toLowerCase().includes(q.toLowerCase()))
    .filter((r) => provider === "all" || r.provider === provider || r.targetProvider === provider)
    .filter((r) => category === "all" || r.category === category)
    .filter((r) => account === "all" || r.accountName === account)
    .filter((r) => r.monthlySavings >= Number(minSavings))
    .filter((r) => showAlternatives || !r.overlapsWith)
    .sort(sorters[sort]);
  const shown = impact === "all" ? filtered : filtered.filter((r) => r.impact === impact);
  const total = shown.filter((r) => !r.overlapsWith && r.category !== "anomaly").reduce((s, r) => s + r.monthlySavings, 0);
  const pageRows = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="Search recommendations…" className={clsx(inputClass, "pl-8")} />
        </label>
        <Select className="w-40" value={category} onChange={reset(setCategory)} options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))]} />
        <Select className="w-36" value={provider} onChange={reset(setProvider)} options={[{ value: "all", label: "All providers" }, { value: "aws", label: "AWS" }, { value: "azure", label: "Azure" }, { value: "gcp", label: "GCP" }]} />
        <Select className="w-40" value={sort} onChange={reset(setSort)} options={[{ value: "savings_desc", label: "Highest savings" }, { value: "pct_desc", label: "Highest savings %" }, { value: "effort", label: "Easiest first" }]} />
        <button onClick={() => setMore((m) => !m)} aria-expanded={more} className={clsx(buttonClass("secondary"), more && "bg-slate-50")}>
          <SlidersHorizontal size={14} /> Filters{extraFilters ? <span className="tabular rounded-full bg-brand px-1.5 text-[11px] text-white">{extraFilters}</span> : null}
        </button>
      </div>

      {more && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-3 py-2.5">
          <Select className="w-48" value={account} onChange={reset(setAccount)} options={[{ value: "all", label: "All accounts" }, ...accounts.map((a) => ({ value: a, label: a }))]} />
          <Select className="w-40" value={minSavings} onChange={reset(setMinSavings)} options={[{ value: "0", label: "Any savings" }, { value: "100", label: "≥ $100 / mo" }, { value: "500", label: "≥ $500 / mo" }, { value: "1000", label: "≥ $1,000 / mo" }, { value: "2500", label: "≥ $2,500 / mo" }]} />
          <label className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={showAlternatives} onChange={(e) => reset(setShowAlternatives)(e.target.checked)} className="accent-brand" />
            Show alternatives ({alternatives})
          </label>
          {extraFilters > 0 && (
            <button
              className="ml-auto text-xs font-medium text-brand hover:underline"
              onClick={() => {
                setAccount("all");
                setMinSavings("0");
                setShowAlternatives(false);
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={impact}
          onChange={reset(setImpact)}
          options={[
            { id: "all", label: "All", count: filtered.length },
            ...byImpact.map((i) => ({ id: i, label: i === "high" ? "High impact" : i === "medium" ? "Medium" : "Low", count: filtered.filter((r) => r.impact === i).length })),
          ]}
        />
        <p className="text-xs text-muted">
          <b className="font-semibold text-ink">{usd(total)}/mo</b> de-duplicated savings
          {heldBack > 0 && (
            <>
              {" · "}
              <Link href="/recommendations/held-back" className="font-medium text-brand hover:underline">
                {heldBack} held back for lack of data
              </Link>
            </>
          )}
        </p>
      </div>

      <div className="mt-3 space-y-3">{pageRows.length ? pageRows.map((r) => <RecListItem key={r.id} rec={r} />) : <Empty title="No recommendations match these filters" />}</div>
      <Pager page={page} pageSize={PAGE_SIZE} total={shown.length} onChange={setPage} />
    </div>
  );
}

const HISTORY = [
  { id: "applied", label: "Applied" },
  { id: "snoozed", label: "Snoozed" },
  { id: "dismissed", label: "Dismissed" },
] as const;

export function RecommendationHistory({ recs }: { recs: RecRow[] }) {
  const [status, setStatus] = useState<(typeof HISTORY)[number]["id"]>("applied");
  const [page, setPage] = useState(1);
  const rows = recs.filter((r) => r.status === status).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const applied = recs.filter((r) => r.status === "applied" && !r.overlapsWith).reduce((s, r) => s + r.monthlySavings, 0);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={HISTORY.map((h) => ({ id: h.id, label: h.label, count: recs.filter((r) => r.status === h.id).length }))}
        />
        {applied > 0 && (
          <p className="text-xs text-muted">
            <b className="font-semibold text-good">{usd(applied)}/mo</b> saved by applied recommendations
          </p>
        )}
      </div>
      <div className="mt-3 space-y-3">
        {rows.length ? (
          rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => <RecListItem key={r.id} rec={r} />)
        ) : (
          <Empty title={`Nothing ${status} yet`}>Recommendations you {status === "applied" ? "apply" : status === "snoozed" ? "snooze" : "dismiss"} show up here.</Empty>
        )}
      </div>
      <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} onChange={setPage} />
    </div>
  );
}
