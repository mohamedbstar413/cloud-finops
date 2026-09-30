"use client";

import clsx from "clsx";
import { Lightbulb, Plus, Sparkles, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ArchitectureDiagram } from "@/components/ArchitectureDiagram";
import { api, inputClass, Notice, Select, Spinner } from "@/components/client-ui";
import { CostBreakdown } from "@/components/CostBreakdown";
import { ProjectionPanel } from "@/components/ProjectionPanel";
import { ProviderLogo } from "@/components/ProviderLogo";
import { buttonClass, Card, CardHeader, LevelText, Pill } from "@/components/ui";
import type { CustomAnalysis, PricedProposal } from "@/lib/engine/custom";
import { autoDiagram } from "@/lib/engine/diagram";
import { usd } from "@/lib/format";
import { PRICES, PROVIDER_LABEL, VM_TYPES, type Provider } from "@/lib/pricing/catalog";
import { priceComponent, serviceName, type Component, type ComponentKind } from "@/lib/pricing/components";

const EXAMPLES = [
  "E-commerce platform on AWS: 20 m6i.2xlarge web tier behind an ALB, 12 c6g.xlarge API servers, 6 r6i.4xlarge running self-managed Redis, Aurora Postgres Multi-AZ, 200 TB in S3, CloudFront, NAT gateway, 50 TB egress per month, 1.2 billion requests/month, spiky with Black Friday peaks.",
  "Hybrid: 10 n2-standard-8 on GCP running a stateless API; 6 Standard_D8s_v5 on Azure running batch ETL; BigQuery analytics with 80 TB scanned per month; 100 TB in Cloud Storage.",
  "12 m5.2xlarge behind an ALB serving a stateless REST API, ~300 million requests/month with spiky evening peaks. Postgres RDS Multi-AZ, 40 TB in S3, NAT gateway.",
  "Azure: 8 Standard_D8s_v5 VMs running a business-hours internal web app, Azure SQL 16 vCores, 60 TB blob storage.",
  "Nightly ETL batch on 10 n2-standard-16 in GCP, reads 20 TB from Cloud Storage, fault-tolerant and retryable.",
];

type Row = Component;

const BUILDER_KINDS: { kind: ComponentKind; label: string }[] = [
  { kind: "compute.vm", label: "Virtual machines" },
  { kind: "network.load_balancer", label: "Load balancer" },
  { kind: "db.instance", label: "Database (instance)" },
  { kind: "db.vcore", label: "Database (vCores)" },
  { kind: "storage.object", label: "Object storage" },
  { kind: "storage.block", label: "Block storage" },
  { kind: "network.nat_gateway", label: "NAT gateway" },
  { kind: "network.egress", label: "Internet egress" },
  { kind: "app.plan", label: "App platform plan" },
  { kind: "cache.managed", label: "Managed cache" },
  { kind: "compute.function", label: "Functions" },
  { kind: "network.api_gateway", label: "API gateway" },
  { kind: "observability.logs", label: "Log ingestion" },
];

let n = 0;
function defaultRow(kind: ComponentKind, provider: Provider): Row {
  const id = `c${++n}`;
  const label = serviceName(kind, provider);
  switch (kind) {
    case "compute.vm":
      return { id, kind, provider, label, sku: VM_TYPES.find((v) => v.provider === provider && v.profile === "general")!.sku, role: "web", usage: { count: 4 } };
    case "db.instance":
      return { id, kind, provider, label, sku: "db.r5.xlarge", usage: { multiAz: true, storageGb: 500 } };
    case "db.vcore":
      return { id, kind, provider, label, usage: { vcores: 8, storageGb: 500 } };
    case "storage.object":
      return { id, kind, provider, label, usage: { gb: 20 * 1024, tier: "hot" } };
    case "storage.block":
      return { id, kind, provider, label, usage: { gb: 2000, tier: "premium" } };
    case "network.nat_gateway":
      return { id, kind, provider, label, usage: { count: 2, gb: 10_000 } };
    case "app.plan":
      return { id, kind, provider, label, sku: "P2v3", usage: { count: 3 } };
    case "cache.managed":
      return { id, kind, provider, label, usage: { count: 2, memGb: 26 } };
    case "compute.function":
      return { id, kind, provider, label, usage: { requestsM: 100, avgDurationMs: 200, memoryMb: 1024 } };
    case "network.api_gateway":
      return { id, kind, provider, label, usage: { requestsM: 100, tier: "http" } };
    default:
      return { id, kind, provider, label, usage: { gb: 5000 } };
  }
}

function NumberField({ label, value, onChange, step = 1, suffix }: { label: string; value: number | undefined; onChange: (v: number) => void; step?: number; suffix?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] font-medium text-muted">{label}</span>
      <div className="relative">
        <input type="number" min={0} step={step} value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} className={clsx(inputClass, "h-8 pr-8 text-[12.5px]")} />
        {suffix && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] text-muted">{suffix}</span>}
      </div>
    </label>
  );
}

function RowEditor({ row, onChange, onRemove }: { row: Row; onChange: (r: Row) => void; onRemove: () => void }) {
  const u = row.usage;
  const set = (patch: Partial<Row["usage"]>) => onChange({ ...row, usage: { ...u, ...patch } });
  const price = priceComponent(row);
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Select
          label="Component"
          value={row.kind}
          onChange={(k) => onChange({ ...defaultRow(k as ComponentKind, row.provider), id: row.id })}
          options={BUILDER_KINDS.map((k) => ({ value: k.kind, label: k.label }))}
        />
        {row.kind === "compute.vm" && (
          <>
            <Select label="Instance type" value={row.sku ?? ""} onChange={(sku) => onChange({ ...row, sku })} options={VM_TYPES.filter((v) => v.provider === row.provider).map((v) => ({ value: v.sku, label: `${v.sku} (${v.vcpu} vCPU/${v.memGiB} GiB)` }))} />
            <NumberField label="Count" value={u.count} onChange={(count) => set({ count })} />
            <Select
              label="Role"
              value={row.role ?? "web"}
              onChange={(role) => onChange({ ...row, role: role as Row["role"] })}
              options={[
                { value: "web", label: "Web / API (stateless)" },
                { value: "batch", label: "Batch (interruptible)" },
                { value: "stateful", label: "Stateful (DB, cache, queue)" },
                { value: "k8s", label: "Kubernetes nodes" },
              ]}
            />
          </>
        )}
        {row.kind === "db.instance" && (
          <>
            <Select label="Class" value={row.sku ?? ""} onChange={(sku) => onChange({ ...row, sku })} options={Object.keys(PRICES.dbInstance).map((s) => ({ value: s, label: s }))} />
            <NumberField label="Storage" value={u.storageGb} onChange={(storageGb) => set({ storageGb })} suffix="GB" />
            <label className="flex items-end gap-1.5 pb-2 text-[12px]">
              <input type="checkbox" checked={Boolean(u.multiAz)} onChange={(e) => set({ multiAz: e.target.checked })} className="accent-brand" /> Multi-AZ
            </label>
          </>
        )}
        {row.kind === "db.vcore" && (
          <>
            <NumberField label="vCores" value={u.vcores} onChange={(vcores) => set({ vcores })} />
            <NumberField label="Storage" value={u.storageGb} onChange={(storageGb) => set({ storageGb })} suffix="GB" />
          </>
        )}
        {row.kind === "storage.object" && (
          <>
            <NumberField label="Size" value={Math.round(((u.gb ?? 0) / 1024) * 10) / 10} onChange={(tb) => set({ gb: tb * 1024 })} step={0.5} suffix="TB" />
            <Select label="Tier" value={u.tier ?? "hot"} onChange={(tier) => set({ tier: tier as Row["usage"]["tier"] })} options={["hot", "cool", "cold", "archive"].map((t) => ({ value: t, label: t }))} />
          </>
        )}
        {row.kind === "storage.block" && <NumberField label="Size" value={u.gb} onChange={(gb) => set({ gb })} suffix="GB" />}
        {(row.kind === "network.load_balancer" || row.kind === "network.egress" || row.kind === "observability.logs") && (
          <NumberField label={row.kind === "observability.logs" ? "Ingested / month" : "Data / month"} value={u.gb} onChange={(gb) => set({ gb })} suffix="GB" />
        )}
        {row.kind === "network.nat_gateway" && (
          <>
            <NumberField label="Gateways" value={u.count} onChange={(count) => set({ count })} />
            <NumberField label="Processed / month" value={u.gb} onChange={(gb) => set({ gb })} suffix="GB" />
          </>
        )}
        {row.kind === "app.plan" && (
          <>
            <Select label="Plan" value={row.sku ?? "P2v3"} onChange={(sku) => onChange({ ...row, sku })} options={Object.keys(PRICES.appPlatformPlan).map((s) => ({ value: s, label: s }))} />
            <NumberField label="Instances" value={u.count} onChange={(count) => set({ count })} />
          </>
        )}
        {row.kind === "cache.managed" && (
          <>
            <NumberField label="Nodes" value={u.count} onChange={(count) => set({ count })} />
            <NumberField label="Memory / node" value={u.memGb} onChange={(memGb) => set({ memGb })} suffix="GB" />
          </>
        )}
        {(row.kind === "compute.function" || row.kind === "network.api_gateway") && <NumberField label="Requests / month" value={u.requestsM} onChange={(requestsM) => set({ requestsM })} suffix="M" />}
        {row.kind === "compute.function" && <NumberField label="Avg duration" value={u.avgDurationMs} onChange={(avgDurationMs) => set({ avgDurationMs })} suffix="ms" />}
      </div>
      <div className="flex flex-col items-end justify-between">
        <button onClick={onRemove} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600" aria-label="Remove component">
          <Trash2 size={14} />
        </button>
        <span className="tabular text-[12.5px] font-semibold" title={price.pricingNote}>
          {usd(price.monthlyCost)}/mo
        </span>
      </div>
    </div>
  );
}

export function CustomArchitecture({ ai, growthRate }: { ai: boolean; growthRate: number }) {
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<Provider>("aws");
  const [rows, setRows] = useState<Row[]>([]);
  const [pattern, setPattern] = useState("unknown");
  const [stateless, setStateless] = useState(true);
  const [interruptible, setInterruptible] = useState(false);
  const [latency, setLatency] = useState(false);
  const [requests, setRequests] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<(CustomAnalysis & { notice?: string }) | null>(null);
  const [pick, setPick] = useState(0);

  const builderTotal = rows.reduce((s, r) => s + priceComponent(r).monthlyCost, 0);

  async function analyze() {
    setBusy(true);
    setErr(null);
    try {
      const out = await api<CustomAnalysis & { notice?: string }>("/api/advisor/custom", {
        body: {
          description: description.trim() || undefined,
          components: rows.length ? rows : undefined,
          profile: {
            trafficPattern: pattern === "unknown" && description ? undefined : pattern,
            stateless,
            interruptible,
            latencySensitive: latency,
            requestsPerMonthM: requests ? Number(requests) : undefined,
          },
        },
      });
      setResult(out);
      setPick(0);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Describe the architecture"
          subtitle={ai ? "Free text is interpreted by the AI advisor; every component it proposes is priced by our engine." : "Free text is parsed by rules (instance types, LB, DB, storage…). Add OPENAI_API_KEY for full AI interpretation."}
          action={<Pill className={ai ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-slate-100 text-slate-600 ring-slate-200"}>{ai ? "AI advisor" : "Rules mode"}</Pill>}
        />
        <div className="space-y-3 p-5">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. 12 m5.2xlarge behind an ALB serving a stateless API, 300M requests/month, spiky traffic, Postgres RDS Multi-AZ, 40 TB S3…"
            className={clsx(inputClass, "h-24 resize-y py-2 leading-relaxed")}
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((e) => (
              <button key={e} onClick={() => setDescription(e)} className="max-w-md truncate rounded-full bg-slate-100 px-3 py-1 text-left text-[11.5px] text-slate-600 hover:bg-slate-200" title={e}>
                {e}
              </button>
            ))}
          </div>

          <div className="border-t border-line pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12.5px] font-semibold">
                Component builder <span className="font-normal text-muted">(optional, overrides free-text parsing)</span>
              </p>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg bg-slate-100 p-0.5">
                  {(["aws", "azure", "gcp"] as Provider[]).map((p) => (
                    <button key={p} onClick={() => setProvider(p)} className={clsx("inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium", provider === p ? "bg-white shadow-sm" : "text-muted")}>
                      <ProviderLogo provider={p} size={12} /> {PROVIDER_LABEL[p]}
                    </button>
                  ))}
                </div>
                <button className={buttonClass("secondary", "sm")} onClick={() => setRows((r) => [...r, defaultRow("compute.vm", provider)])}>
                  <Plus size={13} /> Add component
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <RowEditor key={r.id} row={r} onChange={(nr) => setRows((rs) => rs.map((x, j) => (j === i ? nr : x)))} onRemove={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
              ))}
              {rows.length > 0 && <p className="text-right text-[12px] text-muted">Builder total: <b className="text-ink">{usd(builderTotal)}/mo</b></p>}
            </div>
          </div>

          <div className="grid gap-3 border-t border-line pt-4 md:grid-cols-[180px_160px_1fr_auto]">
            <Select label="Traffic pattern" value={pattern} onChange={setPattern} options={[{ value: "unknown", label: "Infer / unknown" }, { value: "spiky", label: "Spiky / bursty" }, { value: "business_hours", label: "Business hours" }, { value: "steady", label: "Steady 24/7" }, { value: "batch", label: "Batch / scheduled" }]} />
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-muted">Requests / month</span>
              <input value={requests} onChange={(e) => setRequests(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 300 (millions)" className={inputClass} />
            </label>
            <div className="flex flex-wrap items-end gap-4 pb-2 text-[12.5px]">
              <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={stateless} onChange={(e) => setStateless(e.target.checked)} className="accent-brand" /> Stateless</label>
              <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={interruptible} onChange={(e) => setInterruptible(e.target.checked)} className="accent-brand" /> Interruption-tolerant</label>
              <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={latency} onChange={(e) => setLatency(e.target.checked)} className="accent-brand" /> Latency-sensitive</label>
            </div>
            <div className="flex items-end">
              <button className={buttonClass("primary")} disabled={busy || (!description.trim() && !rows.length)} onClick={analyze}>
                {busy ? <Spinner /> : ai ? <Sparkles size={14} /> : <Wand2 size={14} />} Analyze & project savings
              </button>
            </div>
          </div>
          {err && <Notice tone="error">{err}</Notice>}
        </div>
      </Card>

      {result && <CustomResult result={result} pick={pick} setPick={setPick} growthRate={growthRate} />}
    </div>
  );
}

function CustomResult({ result, pick, setPick, growthRate }: { result: CustomAnalysis & { notice?: string }; pick: number; setPick: (i: number) => void; growthRate: number }) {
  const proposal: PricedProposal | undefined = result.proposals[pick];
  const currentDiagram = useMemo(() => autoDiagram(result.current.components), [result]);
  const proposedDiagram = useMemo(() => (proposal ? autoDiagram(proposal.components, "added") : null), [proposal]);
  const inputs = useMemo(
    () =>
      proposal
        ? [{ id: proposal.title, label: proposal.title, currentMonthlyCost: result.current.monthlyCost, projectedMonthlyCost: proposal.monthlyCost, migrationCost: proposal.migrationCost, rollout: { startWeek: Math.max(1, Math.round(proposal.timelineWeeks / 2)), fullWeek: Math.max(1, Math.round(proposal.timelineWeeks)) } }]
        : [],
    [proposal, result],
  );

  return (
    <div className="space-y-4">
      {result.notice && <Notice>{result.notice}</Notice>}
      {(result.insights.length > 0 || result.assumptions.length > 0 || result.unrecognized.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-3">
          {result.insights.length > 0 && (
            <Card className="p-4 lg:col-span-2">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold"><Lightbulb size={14} className="text-amber-500" /> Why these proposals</p>
              <ul className="mt-2 space-y-1.5 text-[12.5px] text-slate-700">
                {result.insights.map((i) => (
                  <li key={i} className="flex gap-2"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-400" />{i}</li>
                ))}
              </ul>
            </Card>
          )}
          <div className="space-y-3">
            {result.unrecognized.length > 0 && (
              <Card className="border-amber-200 bg-amber-50/60 p-4">
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-800"><TriangleAlert size={14} /> Not priced</p>
                <p className="mt-1 text-[12px] text-amber-800">{result.unrecognized.join(", ")} — mentioned but not in the price catalog, so excluded from totals.</p>
              </Card>
            )}
            {result.assumptions.length > 0 && (
              <Card className="p-4">
                <p className="text-[12.5px] font-semibold">Assumptions</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] text-muted">
                  {result.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="text-muted">Current architecture:</span>
        <b>{usd(result.current.monthlyCost)}/mo</b>
        <span className="text-muted">· profile: {result.profile.trafficPattern.replace("_", " ")}{result.profile.stateless ? ", stateless" : ""}{result.profile.interruptible ? ", interruptible" : ""}</span>
        {result.model && <Pill className="bg-blue-50 text-blue-700 ring-blue-200">{result.model}</Pill>}
      </div>
      {!result.proposals.length ? (
        <Notice>No cheaper architecture found for this description — it already looks efficient at list prices.</Notice>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {result.proposals.map((p, i) => (
            <button key={p.title + i} onClick={() => setPick(i)} className={clsx("rounded-xl border bg-white p-4 text-left transition-shadow hover:shadow-md", i === pick ? "border-brand shadow-[0_0_0_1px_#2563eb]" : "border-line")}>
              <div className="flex items-center gap-2">
                <Pill className="bg-violet-50 text-violet-700 ring-violet-200">{p.strategy.replace("_", " ")}</Pill>
                <ProviderLogo provider={p.targetProvider} size={13} />
                {p.origin === "ai" && <Pill className="bg-blue-50 text-blue-700 ring-blue-200">AI</Pill>}
              </div>
              <p className="mt-2 line-clamp-2 text-[13px] font-semibold">{p.title}</p>
              <p className="mt-2 text-[17px] font-semibold">
                {usd(p.monthlyCost)} <span className="text-xs font-normal text-muted">/ month</span>
              </p>
              <p className="text-xs font-medium text-good">
                −{usd(p.monthlySavings)} ({Math.round(p.savingsPct)}%)
              </p>
              <div className="mt-2 flex gap-3 text-[11px] text-muted">
                <span>Effort <LevelText level={p.effort} /></span>
                <span>Risk <LevelText level={p.risk} /></span>
              </div>
            </button>
          ))}
        </div>
      )}

      {proposal && proposedDiagram && (
        <>
          <Card>
            <CardHeader title={proposal.title} subtitle={proposal.rationale} />
            <div className="grid gap-4 p-5 lg:grid-cols-2">
              <div className="rounded-lg border border-line p-3">
                <p className="mb-2 text-xs font-semibold text-muted">Current · {usd(result.current.monthlyCost)}/mo</p>
                <ArchitectureDiagram nodes={currentDiagram.nodes} edges={currentDiagram.edges} />
              </div>
              <div className="rounded-lg border border-green-200 bg-green-50/30 p-3">
                <p className="mb-2 text-xs font-semibold text-good">Proposed · {usd(proposal.monthlyCost)}/mo</p>
                <ArchitectureDiagram nodes={proposedDiagram.nodes} edges={proposedDiagram.edges} />
              </div>
            </div>
            <div className="grid gap-6 border-t border-line p-5 lg:grid-cols-[2fr_1fr]">
              <CostBreakdown current={result.current.components} proposed={proposal.components} />
              <div className="space-y-3 text-[12.5px]">
                <div>
                  <p className="font-semibold">Benefits</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-700">{proposal.benefits.map((b) => <li key={b}>{b}</li>)}</ul>
                </div>
                <div>
                  <p className="font-semibold">Risks</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-700">{proposal.risks.map((b) => <li key={b}>{b}</li>)}</ul>
                </div>
                <p className="text-muted">
                  Timeline ~{proposal.timelineWeeks} weeks · {proposal.migrationEngineerWeeks} engineer-weeks ({usd(proposal.migrationCost)})
                </p>
              </div>
            </div>
          </Card>
          <ProjectionPanel inputs={inputs} growthRate={growthRate} />
        </>
      )}
    </div>
  );
}
