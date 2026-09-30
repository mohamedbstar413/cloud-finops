"use client";

import clsx from "clsx";
import { ArrowDown, ArrowRight, ArrowUp, BrainCircuit, Check, ChevronDown, CircleCheck, Clock, Minus, Sparkles, Ticket, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArchitectureCompare } from "@/components/diagram/ArchitectureCompare";
import { api, CodeBlock, inputClass, Modal, Notice, Spinner, Tabs } from "@/components/client-ui";
import { CostBreakdown } from "@/components/CostBreakdown";
import { ProjectionPanel } from "@/components/ProjectionPanel";
import { ProviderLogo } from "@/components/ProviderLogo";
import { UsageEvidencePanel } from "@/components/UsageEvidence";
import { buttonClass, Card, CardHeader, CategoryBadge, ImpactBadge, LevelText, Pill, StatusBadge } from "@/components/ui";
import type { ArchitectureSpec } from "@/lib/engine/types";
import { PROVIDER_NAME, usd } from "@/lib/format";
import type { getRecommendation } from "@/lib/services/queries";

type Data = NonNullable<Awaited<ReturnType<typeof getRecommendation>>>;
type TabId = "overview" | "architecture" | "impact" | "implementation" | "terraform" | "ai";

export function RecommendationDetail({ data, growthRate, ai, canAct, canUseAi, initialTab }: { data: Data; growthRate: number; ai: boolean; canAct: boolean; canUseAi: boolean; initialTab?: string }) {
  const { rec, details } = data;
  const hasArch = Boolean(details.current?.nodes.length && details.proposed?.nodes.length);
  const tabs: { id: TabId; label: React.ReactNode }[] = [
    { id: "overview", label: "Overview" },
    ...(hasArch ? [{ id: "architecture" as const, label: "Architecture Comparison" }] : []),
    { id: "impact", label: "Cost Impact" },
    { id: "implementation", label: "Implementation" },
    ...(details.terraform || data.ai?.terraform ? [{ id: "terraform" as const, label: "Terraform Sketch" }] : []),
    { id: "ai", label: <span className="inline-flex items-center gap-1"><Sparkles size={13} /> AI Deep-dive</span> },
  ];
  const [tab, setTab] = useState<TabId>(tabs.some((t) => t.id === initialTab) ? (initialTab as TabId) : "overview");

  return (
    <div>
      <Link href="/recommendations" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
        ← Back to recommendations
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-6 xl:flex-nowrap">
        <div className="min-w-[320px] max-w-3xl flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryBadge category={rec.category} />
            {rec.source === "ai" && <Pill className="bg-blue-50 text-blue-700 ring-blue-200">AI-generated · priced by engine</Pill>}
            {rec.status !== "open" && <StatusBadge status={rec.status} />}
          </div>
          <h1 className="mt-2 text-[22px] font-semibold leading-snug tracking-tight">{rec.title}</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{rec.summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium">
              <ProviderLogo provider={rec.provider} size={16} /> {PROVIDER_NAME[rec.provider]}
              {rec.targetProvider && rec.targetProvider !== rec.provider && (
                <>
                  <ArrowRight size={13} className="text-muted" /> <ProviderLogo provider={rec.targetProvider} size={16} /> {PROVIDER_NAME[rec.targetProvider]}
                </>
              )}
            </span>
            {rec.accountName && <span className="text-xs text-muted">{rec.accountName}</span>}
            <ImpactBadge impact={rec.impact} />
            <CategoryBadge category={rec.category} />
            <span className="text-xs text-muted">Confidence {Math.round(rec.confidence * 100)}%</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[26px] font-semibold text-good">
            {usd(rec.monthlySavings)} <span className="text-sm font-normal text-muted">/ month</span>
          </p>
          <p className="text-[13px] font-medium text-good">{Math.round(rec.savingsPct)}% savings</p>
          <RecActions data={data} canAct={canAct} />
        </div>
      </div>

      {rec.overlapsWith && (
        <div className="mt-4">
          <Notice>
            This is an alternative to <Link className="font-medium underline" href={`/recommendations/${rec.overlapsWith.id}`}>{rec.overlapsWith.title}</Link>, which saves more on the same resources. Its savings are excluded from totals.
          </Notice>
        </div>
      )}
      {data.dismissReason && rec.status === "dismissed" && (
        <div className="mt-4">
          <Notice>Dismissed: {data.dismissReason}</Notice>
        </div>
      )}

      <div className="mt-6">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
      </div>
      <div className="mt-5">
        {tab === "overview" && <Overview data={data} />}
        {tab === "architecture" && <ArchitectureComparison data={data} />}
        {tab === "impact" && <CostImpact data={data} growthRate={growthRate} />}
        {tab === "implementation" && <Implementation data={data} />}
        {tab === "terraform" && <Terraform data={data} />}
        {tab === "ai" && <AiDeepDive data={data} ai={ai} canUseAi={canUseAi} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function RecActions({ data, canAct }: { data: Data; canAct: boolean }) {
  const router = useRouter();
  const { rec } = data;
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [ticket, setTicket] = useState<{ key: string; url: string | null; body: string } | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(String(body.action));
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`/api/recommendations/${rec.id}`, { method: "PATCH", body });
      setMsg({ tone: "success", text: r.message });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
      setDismissOpen(false);
      setSnoozeOpen(false);
    }
  }

  async function createTicket() {
    setBusy("ticket");
    try {
      const r = await api<{ ticket: { key: string; url: string | null; body: string } }>(`/api/recommendations/${rec.id}/ticket`, { method: "POST" });
      setTicket(r.ticket);
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const disabled = !canAct || busy !== null;
  return (
    <div className="mt-4 flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {rec.status === "open" && (
          <button className={buttonClass("primary")} disabled={disabled} onClick={() => act({ action: "apply" })}>
            {busy === "apply" ? <Spinner /> : <Check size={14} />} Apply
          </button>
        )}
        {rec.status === "in_progress" && (
          <button className={buttonClass("primary")} disabled={disabled} onClick={() => act({ action: "complete" })}>
            {busy === "complete" ? <Spinner /> : <CircleCheck size={14} />} Mark as applied
          </button>
        )}
        {(rec.status === "dismissed" || rec.status === "snoozed" || rec.status === "applied") && (
          <button className={buttonClass("secondary")} disabled={disabled} onClick={() => act({ action: "reopen" })}>
            Reopen
          </button>
        )}
        {(rec.status === "open" || rec.status === "in_progress") && (
          <>
            <button className={buttonClass("secondary")} disabled={disabled} onClick={() => setDismissOpen(true)}>
              Dismiss
            </button>
            <div className="relative">
              <button className={buttonClass("secondary")} disabled={disabled} onClick={() => setSnoozeOpen((s) => !s)}>
                <Clock size={14} /> Snooze <ChevronDown size={12} />
              </button>
              {snoozeOpen && (
                <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-lg border border-line bg-white py-1 text-left shadow-lg">
                  {[7, 30, 90].map((d) => (
                    <button key={d} className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-slate-50" onClick={() => act({ action: "snooze", days: d })}>
                      {d} days
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        <button className={buttonClass("secondary")} disabled={disabled} onClick={createTicket}>
          {busy === "ticket" ? <Spinner /> : <Ticket size={14} />} Create ticket
        </button>
      </div>
      {!canAct && <p className="text-[11px] text-muted">Your role is read-only for recommendations.</p>}
      {data.tickets.length > 0 && <p className="text-[11px] text-muted">Tickets: {data.tickets.map((t) => t.key).join(", ")}</p>}
      {msg && (
        <div className="max-w-sm text-left">
          <Notice tone={msg.tone} onClose={() => setMsg(null)}>
            {msg.text}
          </Notice>
        </div>
      )}

      <Modal open={dismissOpen} onClose={() => setDismissOpen(false)} title="Dismiss recommendation">
        <p className="text-[13px] text-muted">Tell the team why — this improves future recommendations.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["Already planned", "Business requirement", "Not accurate", "Too risky right now"].map((r) => (
            <button key={r} onClick={() => setReason(r)} className={clsx("rounded-full px-3 py-1 text-xs ring-1", reason === r ? "bg-brand text-white ring-brand" : "ring-line hover:bg-slate-50")}>
              {r}
            </button>
          ))}
        </div>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} className={clsx(inputClass, "mt-3 h-20 py-2")} placeholder="Reason (optional)" />
        <div className="mt-4 flex justify-end gap-2">
          <button className={buttonClass("secondary")} onClick={() => setDismissOpen(false)}>
            Cancel
          </button>
          <button className={buttonClass("danger")} disabled={busy !== null} onClick={() => act({ action: "dismiss", reason: reason || undefined })}>
            Dismiss
          </button>
        </div>
      </Modal>

      <Modal open={Boolean(ticket)} onClose={() => setTicket(null)} title={`Ticket ${ticket?.key ?? ""} created`} wide>
        {ticket?.url ? (
          <a href={ticket.url} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-brand underline">
            Open in tracker
          </a>
        ) : (
          <p className="text-[13px] text-muted">Stored internally. Set TICKET_WEBHOOK_URL to push tickets to Jira, Linear or ServiceNow. Copy the body below:</p>
        )}
        <div className="mt-3">
          <CodeBlock code={ticket?.body ?? ""} title={`${ticket?.key}.md`} />
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function ArchSummaryCard({ title, spec, tone }: { title: string; spec?: ArchitectureSpec; tone: "current" | "proposed" }) {
  return (
    <Card className="flex flex-col p-5">
      <p className={clsx("text-[13px] font-semibold", tone === "proposed" ? "text-good" : "text-ink")}>{title}</p>
      <ul className="mt-3 flex-1 space-y-1.5 text-[12.5px] text-ink">
        {(spec?.bullets ?? []).map((b) => (
          <li key={b} className="flex gap-2">
            <span className={clsx("mt-1.5 size-1.5 shrink-0 rounded-full", tone === "proposed" ? "bg-good" : "bg-slate-400")} />
            {b}
          </li>
        ))}
      </ul>
      {spec && (
        <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2.5">
          <p className="text-[11px] text-muted">Monthly cost</p>
          <p className={clsx("text-[20px] font-semibold", tone === "proposed" ? "text-good" : "text-ink")}>{usd(spec.monthlyCost)}</p>
          <p className="text-[10.5px] text-muted">{tone === "proposed" ? "(estimated, priced by engine)" : "(billed, last 30 days)"}</p>
        </div>
      )}
    </Card>
  );
}

function Overview({ data }: { data: Data }) {
  const { rec, details } = data;
  const [open, setOpen] = useState(true);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {details.current ? (
          <>
            <ArchSummaryCard title="Current Architecture" spec={details.current} tone="current" />
            <ArchSummaryCard title="Proposed Architecture" spec={details.proposed} tone="proposed" />
          </>
        ) : (
          <Card className="p-5 lg:col-span-2">
            <p className="text-[13px] font-semibold">Evidence</p>
            <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {details.evidence.map((e) => (
                <div key={e.label} className="flex justify-between gap-3 border-b border-line py-1.5 text-[12.5px]">
                  <dt className="text-muted">{e.label}</dt>
                  <dd className="text-right font-medium">{e.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex gap-6 text-[13px]">
              <span>
                Current <b>{usd(rec.currentMonthlyCost)}</b>
              </span>
              <span>
                After <b className="text-good">{usd(rec.projectedMonthlyCost)}</b>
              </span>
            </div>
          </Card>
        )}
        <Card className="p-5">
          <p className="text-[13px] font-semibold">Key Benefits</p>
          <ul className="mt-3 space-y-2 text-[12.5px]">
            {(details.benefits.length ? details.benefits : ["Lower monthly cost"]).map((b) => (
              <li key={b} className="flex gap-2">
                <CircleCheck size={15} className="mt-px shrink-0 text-good" />
                {b}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[
          { label: "Migration Effort", value: <LevelText level={rec.effort} /> },
          { label: "Risk Level", value: <LevelText level={rec.risk} /> },
          { label: "Estimated Timeline", value: <span className="text-[13px] font-semibold">{rec.timeline}</span> },
        ].map((x) => (
          <div key={x.label} className="px-5 py-3.5">
            <p className="text-[11px] text-muted">{x.label}</p>
            <div className="mt-1">{x.value}</div>
          </div>
        ))}
      </Card>

      {details.usage && <UsageEvidencePanel usage={details.usage} />}

      <Card>
        <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-5 py-3.5 text-left">
          <span className="text-[13.5px] font-semibold">Detailed Explanation</span>
          <ChevronDown size={16} className={clsx("text-muted transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div className="space-y-4 px-5 pb-5 text-[13px] leading-relaxed text-slate-700">
            <p>{details.explanation}</p>
            {details.current && details.evidence.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-3">
                {details.evidence.map((e) => (
                  <div key={e.label} className="rounded-lg bg-slate-50 px-3 py-2">
                    <p className="text-[11px] text-muted">{e.label}</p>
                    <p className="text-[13px] font-semibold text-ink">{e.value}</p>
                  </div>
                ))}
              </div>
            )}
            {details.alternatives && details.alternatives.length > 0 && (
              <div>
                <p className="mb-2 text-[12.5px] font-semibold text-ink">Alternatives considered</p>
                <table className="w-full text-[12.5px]">
                  <tbody>
                    {details.alternatives.map((a) => (
                      <tr key={a.label} className={clsx("border-t border-line", a.chosen && "bg-green-50/60")}>
                        <td className="py-1.5 pl-2">
                          <span className="inline-flex items-center gap-1.5">
                            <ProviderLogo provider={a.provider} size={13} /> {a.label}
                          </span>
                        </td>
                        <td className="tabular py-1.5 text-right">{usd(a.monthlyCost)}/mo</td>
                        <td className="tabular py-1.5 text-right text-good">{a.savingsPct > 0 ? `−${Math.round(a.savingsPct)}%` : "—"}</td>
                        <td className="py-1.5 pl-4 text-muted">{a.note}</td>
                        <td className="py-1.5 pr-2 text-right">{a.chosen && <Pill className="bg-green-100 text-green-700 ring-green-200">Recommended</Pill>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {details.risks.length > 0 && (
              <div>
                <p className="mb-1.5 text-[12.5px] font-semibold text-ink">Risks & trade-offs</p>
                <ul className="space-y-1">
                  {details.risks.map((r) => (
                    <li key={r} className="flex gap-2">
                      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" /> {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {details.assumptions && (
              <p className="text-[11.5px] text-muted">Assumptions: {details.assumptions.join(" · ")}</p>
            )}
          </div>
        )}
      </Card>

      {data.related.length > 0 && (
        <Card className="p-5">
          <p className="text-[13px] font-semibold">Related options on the same resources</p>
          <ul className="mt-2 space-y-1.5 text-[13px]">
            {data.related.map((r) => (
              <li key={r.id} className="flex justify-between gap-3">
                <Link href={`/recommendations/${r.id}`} className="text-brand hover:underline">
                  {r.title}
                </Link>
                <span className="text-muted">
                  {usd(r.monthlySavings)}/mo {r.primary ? "· primary" : "· alternative"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ChangeIcon({ change }: { change: string }) {
  if (change === "better") return <ArrowDown size={14} className="text-good" />;
  if (change === "worse") return <ArrowUp size={14} className="text-bad" />;
  return <Minus size={14} className="text-slate-400" />;
}

function ArchitectureComparison({ data }: { data: Data }) {
  const { rec, details } = data;
  const cur = details.current!;
  const pro = details.proposed!;
  return (
    <div className="space-y-4">
      <ArchitectureCompare current={cur} proposed={pro} filename={rec.fingerprint.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Comparison" />
          <table className="mt-3 w-full text-[12.5px]">
            <thead className="border-y border-line bg-slate-50 text-left text-[11px] text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Metric</th>
                <th className="px-3 py-2 font-medium">Current</th>
                <th className="px-3 py-2 font-medium">Recommended</th>
                <th className="px-5 py-2 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {(details.comparison ?? []).map((row) => (
                <tr key={row.metric} className="border-b border-line last:border-0">
                  <td className="px-5 py-2.5 text-muted">{row.metric}</td>
                  <td className="px-3 py-2.5">{row.current}</td>
                  <td className="px-3 py-2.5 font-medium">{row.proposed}</td>
                  <td className="px-5 py-2.5">
                    <span className="flex items-center justify-end gap-1">
                      <ChangeIcon change={row.change} />
                      {row.metric === "Monthly cost" && <span className="text-good">{Math.round(rec.savingsPct)}%</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <CardHeader title="Cost breakdown" subtitle="Hover a line to see how it was priced" />
          <div className="p-5">
            <CostBreakdown current={cur.components} proposed={pro.components} />
          </div>
        </Card>
      </div>
      {details.terraform && <CodeBlock code={details.terraform} title="Generated Terraform snippet" />}
    </div>
  );
}

function CostImpact({ data, growthRate }: { data: Data; growthRate: number }) {
  const { rec } = data;
  return (
    <ProjectionPanel
      growthRate={growthRate}
      inputs={[{ id: rec.id, label: rec.title, currentMonthlyCost: rec.currentMonthlyCost, projectedMonthlyCost: rec.projectedMonthlyCost, migrationCost: rec.migrationCost, rollout: rec.rollout }]}
    />
  );
}

function Implementation({ data }: { data: Data }) {
  const phases = data.ai?.migrationPlan?.length ? data.ai.migrationPlan : data.details.implementation;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="p-5 lg:col-span-2">
        <p className="text-[13.5px] font-semibold">Migration plan {data.ai?.migrationPlan?.length ? <Pill className="ml-2 bg-blue-50 text-blue-700 ring-blue-200">AI-refined</Pill> : null}</p>
        <ol className="mt-4 space-y-5">
          {phases.map((p, i) => (
            <li key={p.phase} className="relative flex gap-4">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand">{i + 1}</span>
              <div>
                <p className="text-[13px] font-semibold">
                  {p.phase} <span className="ml-1 font-normal text-muted">· {p.weeks}</span>
                </p>
                <ul className="mt-1.5 space-y-1 text-[12.5px] text-slate-700">
                  {p.tasks.map((t) => (
                    <li key={t} className="flex gap-2">
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-slate-400" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      </Card>
      <div className="space-y-4">
        <Card className="p-5">
          <p className="text-[13px] font-semibold">Effort & cost</p>
          <dl className="mt-3 space-y-2 text-[12.5px]">
            <div className="flex justify-between"><dt className="text-muted">Timeline</dt><dd className="font-medium">{data.rec.timeline}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">One-time migration</dt><dd className="font-medium">{usd(data.rec.migrationCost)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Payback</dt><dd className="font-medium">{data.rec.monthlySavings > 0 ? `${(data.rec.migrationCost / data.rec.monthlySavings).toFixed(1)} months` : "—"}</dd></div>
          </dl>
        </Card>
        {data.ai?.validationChecks && (
          <Card className="p-5">
            <p className="text-[13px] font-semibold">Validation checks</p>
            <ul className="mt-2 space-y-1 text-[12.5px]">
              {data.ai.validationChecks.map((v) => (
                <li key={v} className="flex gap-2"><CircleCheck size={14} className="mt-0.5 shrink-0 text-good" /> {v}</li>
              ))}
            </ul>
          </Card>
        )}
        {data.ai?.rollbackPlan && (
          <Card className="p-5">
            <p className="text-[13px] font-semibold">Rollback</p>
            <p className="mt-2 text-[12.5px] text-slate-700">{data.ai.rollbackPlan}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function Terraform({ data }: { data: Data }) {
  const [which, setWhich] = useState<"engine" | "ai">(data.ai?.terraform ? "ai" : "engine");
  const code = which === "ai" ? data.ai?.terraform : data.details.terraform;
  return (
    <div className="space-y-3">
      {data.ai?.terraform && data.details.terraform && (
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-xs font-medium">
          <button onClick={() => setWhich("ai")} className={clsx("rounded-md px-3 py-1", which === "ai" ? "bg-white shadow-sm" : "text-muted")}>AI-generated (context-aware)</button>
          <button onClick={() => setWhich("engine")} className={clsx("rounded-md px-3 py-1", which === "engine" ? "bg-white shadow-sm" : "text-muted")}>Template</button>
        </div>
      )}
      <p className="text-[12.5px] text-muted">A starting point for review — not applied automatically. Adapt names, networking and IAM to your modules.</p>
      {code && <CodeBlock code={code} title="main.tf" />}
    </div>
  );
}

function AiDeepDive({ data, ai, canUseAi }: { data: Data; ai: boolean; canUseAi: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const e = data.ai;

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/recommendations/${data.rec.id}/enrich`, { method: "POST" });
      router.refresh();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!ai && !e) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <BrainCircuit className="text-brand" />
          <div className="text-[13px]">
            <p className="font-semibold">Connect OpenAI to unlock the AI deep-dive</p>
            <p className="mt-1 text-muted">
              Set <code className="rounded bg-slate-100 px-1">OPENAI_API_KEY</code> (and optionally <code className="rounded bg-slate-100 px-1">OPENAI_MODEL</code>) in <code className="rounded bg-slate-100 px-1">.env</code> and restart. The advisor then writes a context-aware migration plan, risk register, validation checks and Terraform for this recommendation — while every number stays priced by the deterministic engine.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-muted">{e ? `Generated ${new Date(e.generatedAt).toLocaleString()} · ${data.aiModel}` : "No deep-dive generated yet."}</p>
        <button className={buttonClass("primary")} disabled={!ai || !canUseAi || busy} onClick={generate}>
          {busy ? <Spinner /> : <Sparkles size={14} />} {e ? "Regenerate" : "Generate AI deep-dive"}
        </button>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {busy && <Notice>The advisor is analysing resource metrics, pricing and dependencies… this usually takes 15–40 seconds.</Notice>}
      {e && (
        <>
          <Card className="p-5">
            <p className="text-[16px] font-semibold">{e.headline}</p>
            <div className="mt-2 space-y-2 whitespace-pre-line text-[13px] leading-relaxed text-slate-700">{e.narrative}</div>
            <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-[12.5px] text-blue-800">
              <b>Why now:</b> {e.whyNow}
            </p>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Risk register" />
              <table className="mt-3 w-full text-[12.5px]">
                <tbody>
                  {e.risks.map((r) => (
                    <tr key={r.risk} className="border-t border-line align-top">
                      <td className="px-5 py-2.5">
                        <p className="font-medium">{r.risk}</p>
                        <p className="mt-0.5 text-muted">{r.mitigation}</p>
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <LevelText level={r.likelihood} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="space-y-4">
              <Card className="p-5">
                <p className="text-[13px] font-semibold">Questions for your team</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px]">
                  {e.questionsForTeam.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </Card>
              <Card className="p-5">
                <p className="text-[13px] font-semibold">Savings caveats</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px]">
                  {e.savingsCaveats.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
