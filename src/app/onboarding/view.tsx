"use client";

import clsx from "clsx";
import { ArrowRight, CircleCheck, FlaskConical, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AddAccountButton } from "@/app/(app)/accounts/actions";
import { api, announceJobs, type ClientJob, Notice, Spinner } from "@/components/client-ui";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Card } from "@/components/ui";
import { usd } from "@/lib/format";
import type { Provider } from "@/lib/pricing/catalog";

const CLOUDS: { id: Provider; name: string; how: string }[] = [
  { id: "aws", name: "Amazon Web Services", how: "A read-only IAM role, created from a CloudFormation template" },
  { id: "azure", name: "Microsoft Azure", how: "A service principal with Reader and Cost Management Reader" },
  { id: "gcp", name: "Google Cloud", how: "A service account and the billing export to BigQuery" },
];

function Step({ n, title, state, children }: { n: number; title: string; state: "todo" | "active" | "done"; children?: React.ReactNode }) {
  return (
    <section className="flex gap-4">
      <span
        className={clsx(
          "grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold",
          state === "done" ? "bg-green-100 text-green-700" : state === "active" ? "bg-brand text-white" : "bg-slate-100 text-slate-500",
        )}
      >
        {state === "done" ? <CircleCheck size={16} /> : n}
      </span>
      <div className="min-w-0 flex-1 pb-8">
        <h2 className={clsx("pt-1 text-[15px] font-semibold", state === "todo" ? "text-slate-400" : "text-ink")}>{title}</h2>
        {state === "active" && <div className="mt-3">{children}</div>}
      </div>
    </section>
  );
}

export function Onboarding({ orgName, firstName, hasAccounts, initialJobs, summary }: { orgName: string; firstName: string; hasAccounts: boolean; initialJobs: ClientJob[]; summary: { recommendations: number; monthlySavings: number } }) {
  const router = useRouter();
  const [connected, setConnected] = useState(hasAccounts);
  const [jobs, setJobs] = useState(initialJobs);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const analysing = connected && jobs.length > 0;
  const done = connected && jobs.length === 0;

  const poll = useCallback(async () => {
    const r = await api<{ jobs: ClientJob[] }>("/api/jobs");
    setJobs(r.jobs);
    if (r.jobs.length) setTimeout(() => void poll(), 2000);
    else router.refresh();
  }, [router]);

  useEffect(() => {
    if (initialJobs.length) void poll();
  }, [initialJobs.length, poll]);

  const started = () => {
    setConnected(true);
    setJobs([{ id: "pending", type: "sync_account", status: "queued", error: null, result: null }]);
    setTimeout(() => void poll(), 800);
  };

  async function loadSample() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/accounts/sample", { method: "POST" });
      announceJobs();
      started();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-[24px] font-semibold tracking-tight">Welcome, {firstName}</h1>
      <p className="mt-1 text-[14px] text-muted">Two steps and {orgName} gets its first recommendations.</p>

      <div className="mt-8">
        <Step n={1} title="Connect a cloud account" state={connected ? "done" : "active"}>
          <p className="text-[13px] text-muted">Access is read-only: billing, inventory and utilisation metrics. Nothing is changed in your cloud.</p>
          <div className="mt-4 grid gap-3">
            {CLOUDS.map((c) => (
              <AddAccountButton
                key={c.id}
                demoOptions={[]}
                initialProvider={c.id}
                onConnected={started}
                className="group flex w-full items-center gap-3 rounded-xl border border-line bg-white px-4 py-3.5 text-left transition-colors hover:border-brand/40 hover:bg-brand-50/40"
                label={
                  <>
                    <span className="grid size-10 place-items-center rounded-lg bg-slate-50 ring-1 ring-line">
                      <ProviderLogo provider={c.id} size={22} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-semibold text-ink">{c.name}</span>
                      <span className="block text-xs text-muted">{c.how}</span>
                    </span>
                    <ArrowRight size={15} className="text-slate-300 group-hover:text-brand" />
                  </>
                }
              />
            ))}
          </div>
          <Card className="mt-4 flex flex-wrap items-center gap-3 border-dashed px-4 py-3.5">
            <span className="grid size-10 place-items-center rounded-lg bg-violet-50 text-violet-600">
              <FlaskConical size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold">Not ready to connect? Load sample data</span>
              <span className="block text-xs text-muted">Four realistic accounts across AWS, Azure and GCP. Free, and removable later.</span>
            </span>
            <button onClick={loadSample} disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[13px] font-medium ring-1 ring-inset ring-line hover:bg-slate-50">
              {busy && <Spinner />} Load sample data
            </button>
          </Card>
          {err && (
            <div className="mt-3">
              <Notice tone="error">{err}</Notice>
            </div>
          )}
        </Step>

        <Step n={2} title={done ? "Your first analysis is ready" : "Analysing usage and costs"} state={!connected ? "todo" : done ? "done" : "active"}>
          {analysing && (
            <Card className="p-5">
              <p className="flex items-center gap-2 text-[13.5px] font-medium">
                <LoaderCircle size={16} className="animate-spin text-brand" /> {jobs.some((j) => j.type === "sync_account") ? "Collecting inventory, costs and usage history…" : "Finding savings…"}
              </p>
              <p className="mt-2 text-[12.5px] text-muted">A real account can take a few minutes. You can leave this page; the analysis continues in the background.</p>
            </Card>
          )}
        </Step>
      </div>

      {done && (
        <Card className="p-6">
          <p className="text-[13px] text-muted">Found so far</p>
          <p className="mt-1 text-[26px] font-semibold tracking-tight">
            {usd(summary.monthlySavings)} <span className="text-[14px] font-normal text-muted">a month in {summary.recommendations} recommendations</span>
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/recommendations" className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand-600">
              See recommendations <ArrowRight size={14} />
            </Link>
            <Link href="/organization" className="inline-flex h-10 items-center rounded-lg px-4 text-[13px] font-medium ring-1 ring-inset ring-line hover:bg-slate-50">
              Invite your team
            </Link>
            <Link href="/dashboard" className="inline-flex h-10 items-center rounded-lg px-4 text-[13px] font-medium text-muted hover:text-ink">
              Go to dashboard
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}
