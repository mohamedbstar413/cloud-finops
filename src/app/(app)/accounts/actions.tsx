"use client";

import clsx from "clsx";
import { ArrowLeft, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CodeBlock, inputClass, Modal, Notice, Spinner } from "@/components/client-ui";
import { ProviderLogo } from "@/components/ProviderLogo";
import { buttonClass } from "@/components/ui";
import type { Provider } from "@/lib/pricing/catalog";

export function AccountRowActions({ account, canManage, canSync }: { account: { id: string; name: string; permissions: string }; canManage: boolean; canSync: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function run(kind: string, fn: () => Promise<string>) {
    setBusy(kind);
    setOpen(false);
    setMsg(null);
    try {
      setMsg({ tone: "success", text: await fn() });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        className={buttonClass("ghost", "sm")}
        disabled={!canSync || busy !== null}
        onClick={() =>
          run("sync", async () => {
            const r = await api<{ resources: number; costRows: number; analysis: { recommendations: number } | null }>(`/api/accounts/${account.id}/sync`, { method: "POST" });
            return `Synced ${r.resources} resources and ${r.costRows} cost rows · ${r.analysis?.recommendations ?? 0} recommendations`;
          })
        }
        title="Sync now"
      >
        {busy === "sync" ? <Spinner /> : <RefreshCw size={13} />} Sync
      </button>
      {canManage && (
        <button className={buttonClass("ghost", "sm")} onClick={() => setOpen((o) => !o)} aria-label="More actions">
          <MoreHorizontal size={15} />
        </button>
      )}
      {open && (
        <div className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-lg border border-line bg-white py-1 text-left text-[13px] shadow-lg">
          <button className="block w-full px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => run("test", async () => (await api<{ ok: boolean; message: string }>(`/api/accounts/${account.id}/test`, { method: "POST" })).message)}>
            Test connection
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-slate-50"
            onClick={() =>
              run("perm", async () => {
                const next = account.permissions === "read_only" ? "read_write" : "read_only";
                await api(`/api/accounts/${account.id}`, { method: "PATCH", body: { permissions: next } });
                return next === "read_write" ? "Write permissions enabled — low-risk changes can now be applied automatically." : "Account set back to read-only.";
              })
            }
          >
            {account.permissions === "read_only" ? "Enable write permissions" : "Make read-only"}
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
            onClick={() => {
              if (confirm(`Disconnect ${account.name}? Its inventory, costs and recommendations will be removed.`)) {
                void run("delete", async () => {
                  await api(`/api/accounts/${account.id}`, { method: "DELETE" });
                  return "Account disconnected.";
                });
              }
            }}
          >
            Disconnect
          </button>
        </div>
      )}
      {msg && (
        <div className="fixed bottom-5 right-5 z-50 w-80 text-left shadow-lg">
          <Notice tone={msg.tone} onClose={() => setMsg(null)}>
            {msg.text}
          </Notice>
        </div>
      )}
    </div>
  );
}

type Step = "provider" | "form";

export function AddAccountButton({ demoOptions }: { demoOptions: { key: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<Provider | "demo">("aws");
  const [setup, setSetup] = useState<{ aws: { externalId: string; platformAccount: string; template: string }; azure: { script: string }; gcp: { script: string } } | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && !setup) api<typeof setup>("/api/accounts/setup").then(setSetup).catch((e) => setErr((e as Error).message));
  }, [open, setup]);

  const f = (k: string) => ({ value: form[k] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((x) => ({ ...x, [k]: e.target.value })) });

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body =
        provider === "demo"
          ? { provider, key: form.demoKey ?? demoOptions[0]?.key }
          : provider === "aws"
            ? { provider, name: form.name, accountId: form.accountId, roleArn: form.roleArn, externalId: setup?.aws.externalId, region: form.region || "us-east-1" }
            : provider === "azure"
              ? { provider, name: form.name, tenantId: form.tenantId, clientId: form.clientId, clientSecret: form.clientSecret, subscriptionId: form.subscriptionId, region: form.region || "eastus" }
              : { provider, name: form.name, projectId: form.projectId, serviceAccountKey: form.serviceAccountKey, billingTable: form.billingTable || undefined, region: form.region || "us-central1" };
      await api("/api/accounts", { body });
      setOpen(false);
      setStep("provider");
      setForm({});
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, key: string, placeholder?: string, type = "text") => (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-muted">{label}</span>
      <input type={type} placeholder={placeholder} className={inputClass} {...f(key)} autoComplete="off" />
    </label>
  );

  return (
    <>
      <button className={buttonClass("primary")} onClick={() => setOpen(true)}>
        <Plus size={14} /> Add Account
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Connect a cloud account" wide>
        {step === "provider" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                { id: "aws", title: "Amazon Web Services", desc: "Cross-account IAM role + External ID (CloudFormation)" },
                { id: "azure", title: "Microsoft Azure", desc: "Service principal with Cost Management Reader" },
                { id: "gcp", title: "Google Cloud", desc: "Service account + BigQuery billing export" },
                { id: "demo", title: "Demo account", desc: "Synthetic, realistic data — no credentials needed" },
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  setProvider(o.id);
                  setStep("form");
                  setErr(null);
                }}
                disabled={o.id === "demo" && !demoOptions.length}
                className="flex items-start gap-3 rounded-xl border border-line p-4 text-left hover:border-brand hover:shadow-sm disabled:opacity-50"
              >
                <span className="grid size-9 place-items-center rounded-lg bg-slate-50 ring-1 ring-line">{o.id === "demo" ? "🧪" : <ProviderLogo provider={o.id} size={20} />}</span>
                <span>
                  <span className="block text-[13.5px] font-semibold">{o.title}</span>
                  <span className="block text-xs text-muted">{o.id === "demo" && !demoOptions.length ? "All demo accounts are connected" : o.desc}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <button onClick={() => setStep("provider")} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
              <ArrowLeft size={12} /> Choose another provider
            </button>
            {provider === "demo" && (
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-medium text-muted">Demo account</span>
                <select className={inputClass} value={form.demoKey ?? demoOptions[0]?.key} onChange={(e) => setForm({ demoKey: e.target.value })}>
                  {demoOptions.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {provider === "aws" && (
              <>
                <ol className="list-decimal space-y-1 pl-5 text-[13px] text-slate-700">
                  <li>Deploy this CloudFormation template in the account you want to connect (IAM → Stacks → Create stack).</li>
                  <li>It creates a read-only role trusted only with your unique External ID.</li>
                  <li>Paste the Role ARN from the stack outputs below.</li>
                </ol>
                {setup ? <CodeBlock code={setup.aws.template} title={`cloud-price-optimizer-role.json · External ID ${setup.aws.externalId}`} maxHeight={220} /> : <Spinner />}
                <div className="grid gap-3 sm:grid-cols-2">
                  {field("Account name", "name", "Production")}
                  {field("AWS account ID", "accountId", "123456789012")}
                  {field("Role ARN", "roleArn", "arn:aws:iam::123456789012:role/CloudPriceOptimizerReadOnly")}
                  {field("Primary region", "region", "us-east-1")}
                </div>
              </>
            )}
            {provider === "azure" && (
              <>
                <p className="text-[13px] text-slate-700">Run in Azure Cloud Shell to create a read-only service principal:</p>
                {setup && <CodeBlock code={setup.azure.script} title="azure-setup.sh" maxHeight={220} />}
                <div className="grid gap-3 sm:grid-cols-2">
                  {field("Account name", "name", "Main Subscription")}
                  {field("Subscription ID", "subscriptionId")}
                  {field("Tenant ID", "tenantId")}
                  {field("Client (app) ID", "clientId")}
                  {field("Client secret", "clientSecret", "", "password")}
                  {field("Primary region", "region", "eastus")}
                </div>
              </>
            )}
            {provider === "gcp" && (
              <>
                <p className="text-[13px] text-slate-700">Create a read-only service account and enable the detailed billing export to BigQuery:</p>
                {setup && <CodeBlock code={setup.gcp.script} title="gcp-setup.sh" maxHeight={220} />}
                <div className="grid gap-3 sm:grid-cols-2">
                  {field("Account name", "name", "Production Project")}
                  {field("Project ID", "projectId", "my-project-id")}
                  {field("Billing export table", "billingTable", "billing-proj.billing.gcp_billing_export_v1_XXXX")}
                  {field("Primary region", "region", "us-central1")}
                </div>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium text-muted">Service account key (JSON)</span>
                  <textarea className={clsx(inputClass, "h-24 py-2 font-mono text-[11px]")} placeholder='{"type": "service_account", ...}' {...f("serviceAccountKey")} />
                </label>
              </>
            )}
            {err && <Notice tone="error">{err}</Notice>}
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <button className={buttonClass("secondary")} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className={buttonClass("primary")} disabled={busy} onClick={submit}>
                {busy ? <Spinner /> : null} {provider === "demo" ? "Connect demo account" : "Test & connect"}
              </button>
            </div>
            <p className="text-[11px] text-muted">We validate the credentials, then ingest 90 days of billing data, inventory and utilisation and run the full analysis.</p>
          </div>
        )}
      </Modal>
    </>
  );
}
