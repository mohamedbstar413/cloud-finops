"use client";

import clsx from "clsx";
import { ArrowRight, BrainCircuit, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, inputClass, Notice, Spinner } from "@/components/client-ui";
import { Pager } from "@/components/Pager";
import { buttonClass, Card, Empty } from "@/components/ui";
import { usd } from "@/lib/format";
import type { ScenarioView } from "@/lib/services/scenarios";

const PRESETS = [
  "What if we moved all possible workloads to serverless?",
  "What if every workload ran on its cheapest cloud?",
  "What if we used Spot everywhere it is safe?",
  "What if we committed to 3-year plans after optimizing?",
  "What if we shut down non-production nights and weekends?",
  "What if we migrated everything to Arm (Graviton/Ampere)?",
  "What if we applied every optimization lever?",
];

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function ScenarioCard({ s }: { s: ScenarioView }) {
  return (
    <Link href={`/advisor/scenarios/${s.id}`} className="group flex flex-col rounded-xl border border-line bg-white p-4 transition-shadow hover:shadow-md">
      <p className="line-clamp-2 min-h-[38px] text-[13px] font-medium leading-snug text-ink">{s.prompt}</p>
      <p className="mt-3 text-[17px] font-semibold text-good">
        −{usd(s.result.monthlySavings)} <span className="text-xs font-normal text-muted">/ month</span>
      </p>
      <p className="mt-1 flex items-center justify-between text-[11.5px] text-muted">
        <span>
          {when(s.createdAt)} · {s.source === "ai" ? "AI" : "rules"}
        </span>
        <ArrowRight size={14} className="text-slate-300 transition-colors group-hover:text-ink" />
      </p>
    </Link>
  );
}

/** One question at a time: ask, then land on the scenario's own page. */
export function AskView({ recent, initialPrompt, canUse }: { recent: ScenarioView[]; initialPrompt?: string; canUse: boolean }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ran = useRef(false);

  async function ask(q: string) {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const s = await api<{ id: string }>("/api/advisor/whatif", { body: { prompt: q } });
      router.push(`/advisor/scenarios/${s.id}`);
    } catch (e) {
      setErr((e as Error).message);
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
    <div className="mx-auto max-w-3xl space-y-8">
      <Card className="p-6">
        <p className="text-[15px] font-semibold text-ink">What would you like to explore?</p>
        <p className="mt-1 text-[13px] text-muted">Describe a change to your architecture. It is applied to every workload it fits, priced, and explained.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(prompt);
          }}
          className="mt-4 flex gap-2"
        >
          <div className="relative flex-1">
            <BrainCircuit size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand" />
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What if we moved the api-platform to serverless?"
              aria-label="Your what-if question"
              className={clsx(inputClass, "h-11 pl-9 text-[14px]")}
              disabled={busy}
            />
          </div>
          <button type="submit" className={clsx(buttonClass("primary"), "h-11 px-5")} disabled={busy || !canUse || !prompt.trim()}>
            {busy ? <Spinner /> : <Send size={14} />} Simulate
          </button>
        </form>
        {!canUse && <p className="mt-2 text-xs text-muted">Viewers can browse saved scenarios but not run new ones.</p>}
        {err && (
          <div className="mt-3">
            <Notice tone="error">{err}</Notice>
          </div>
        )}

        {busy ? (
          <p className="animate-pulse-soft mt-6 rounded-lg bg-slate-50 px-4 py-5 text-[13px] text-muted">
            Planning the scenario, applying it to every workload in dependency order and pricing the result…
          </p>
        ) : (
          <div className="mt-6">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <Sparkles size={13} /> Or start from one of these
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  disabled={!canUse}
                  onClick={() => {
                    setPrompt(p);
                    void ask(p);
                  }}
                  className="group flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5 text-left text-[12.5px] text-slate-700 transition-colors hover:border-brand/40 hover:bg-brand-50/50 hover:text-ink disabled:opacity-50"
                >
                  {p}
                  <ArrowRight size={13} className="shrink-0 text-slate-300 group-hover:text-brand" />
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {recent.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-ink">Recent scenarios</h2>
            <Link href="/advisor/history" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
              All scenarios <ArrowRight size={13} />
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {recent.map((s) => (
              <ScenarioCard key={s.id} s={s} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const PAGE_SIZE = 10;

export function ScenarioList({ scenarios }: { scenarios: ScenarioView[] }) {
  const [page, setPage] = useState(1);
  if (!scenarios.length) {
    return (
      <Empty title="No scenarios yet">
        <Link href="/advisor" className="font-medium text-brand hover:underline">
          Ask your first what-if question
        </Link>
      </Empty>
    );
  }
  return (
    <div>
      <Card className="divide-y divide-line">
        {scenarios.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((s) => (
          <Link key={s.id} href={`/advisor/scenarios/${s.id}`} className="group flex items-center gap-4 px-5 py-4 hover:bg-slate-50/70">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-600">
              <BrainCircuit size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-medium text-ink">{s.prompt}</p>
              <p className="mt-0.5 text-xs text-muted">
                {when(s.createdAt)}
                {s.createdBy ? ` · ${s.createdBy}` : ""} · {s.source === "ai" ? "planned by AI" : "rules"} · {s.result.steps.reduce((n, st) => n + st.items.length, 0)} changes
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="tabular text-[14px] font-semibold text-good">−{usd(s.result.monthlySavings)}/mo</p>
              <p className="text-[11px] text-muted">{Math.round(s.result.savingsPct)}% of spend</p>
            </div>
            <ArrowRight size={16} className="shrink-0 text-slate-300 group-hover:text-ink" />
          </Link>
        ))}
      </Card>
      <Pager page={page} pageSize={PAGE_SIZE} total={scenarios.length} onChange={setPage} />
    </div>
  );
}
