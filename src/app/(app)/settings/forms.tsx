"use client";

import clsx from "clsx";
import { Download, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, inputClass, Modal, Notice, Spinner } from "@/components/client-ui";
import { buttonClass, Card } from "@/components/ui";
import type { OrgSettings } from "@/lib/settings";

/* ---------------- Building blocks ---------------- */

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card className="grid gap-5 p-6 md:grid-cols-[260px_1fr]">
      <div>
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block max-w-lg">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={clsx("flex items-start gap-3", disabled && "opacity-60")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} className="mt-0.5 size-4 accent-brand" />
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {hint && <span className="block text-[12px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Save button + result, shared by every settings form. */
function useSave() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  async function save(url: string, body: unknown, method = "PATCH") {
    setBusy(true);
    setMsg(null);
    try {
      await api(url, { method, body });
      setMsg({ tone: "success", text: "Saved." });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const footer = (disabled: boolean) => (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <button type="submit" disabled={disabled || busy} className={buttonClass("primary")}>
        {busy && <Spinner />} Save
      </button>
      {msg && <span className={clsx("text-[12.5px]", msg.tone === "success" ? "text-good" : "text-red-600")}>{msg.text}</span>}
    </div>
  );
  return { save, footer };
}

const ReadOnlyNote = ({ canEdit }: { canEdit: boolean }) => (!canEdit ? <Notice>Only owners and admins can change these settings.</Notice> : null);

/* ---------------- General ---------------- */

export function GeneralSettings({ name: initialName, sync: initialSync, canEdit, nextSyncAt }: { name: string; sync: OrgSettings["sync"]; canEdit: boolean; nextSyncAt: string | null }) {
  const [name, setName] = useState(initialName);
  const [sync, setSync] = useState(initialSync);
  const org = useSave();
  const schedule = useSave();
  return (
    <div className="space-y-4">
      <ReadOnlyNote canEdit={canEdit} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void org.save("/api/org", { name });
        }}
      >
        <Section title="Organization" description="Shown to everyone in the organization and in emails.">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} className={clsx(inputClass, "h-10")} />
          </Field>
          {org.footer(!canEdit || name.trim() === initialName)}
        </Section>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void schedule.save("/api/org/settings", { sync });
        }}
      >
        <Section title="Daily sync" description="Every connected account is synced once a day, then the whole estate is analysed again.">
          <Toggle checked={sync.enabled} onChange={(enabled) => setSync({ ...sync, enabled })} disabled={!canEdit} label="Sync and analyse every day" hint="You can still sync an account by hand from the Accounts page." />
          <Field label="Time of day (UTC)" hint={nextSyncAt ? `Next run: ${new Date(nextSyncAt).toUTCString().replace(" GMT", " UTC")}` : undefined}>
            <select value={sync.hourUtc} onChange={(e) => setSync({ ...sync, hourUtc: Number(e.target.value) })} disabled={!canEdit || !sync.enabled} className={clsx(inputClass, "h-10 w-40")}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </Field>
          {schedule.footer(!canEdit)}
        </Section>
      </form>
    </div>
  );
}

/* ---------------- Remediation & backups ---------------- */

const MODES: { id: OrgSettings["remediation"]["mode"]; title: string; text: string }[] = [
  { id: "branch", title: "Branch only", text: "Each approved change is pushed to its own branch in your repository. Your team decides what happens next." },
  { id: "branch_and_pr", title: "Branch and pull request", text: "Same branch, plus a pull request with the evidence, the Terraform plan and the savings." },
  { id: "auto_apply", title: "Apply low-risk changes automatically", text: "Allowed low-risk changes are applied after the plan checks pass; everything else stays a branch." },
];

export function RemediationSettings({
  settings,
  changeTypes,
  lowRisk,
  canEdit,
}: {
  settings: Pick<OrgSettings, "remediation" | "backups" | "git">;
  changeTypes: Record<string, string>;
  lowRisk: string[];
  canEdit: boolean;
}) {
  const [remediation, setRemediation] = useState(settings.remediation);
  const [backups, setBackups] = useState(settings.backups);
  const [git, setGit] = useState(settings.git);
  const s1 = useSave();
  const s2 = useSave();
  const s3 = useSave();
  const toggleChange = (id: string, on: boolean) =>
    setRemediation({ ...remediation, allowedChanges: on ? [...remediation.allowedChanges, id as never] : remediation.allowedChanges.filter((c) => c !== id) });
  return (
    <div className="space-y-4">
      <ReadOnlyNote canEdit={canEdit} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void s1.save("/api/org/settings", { remediation });
        }}
      >
        <Section title="How changes are delivered" description="When someone applies a recommendation, the change is written to your infrastructure code — never made behind your back.">
          <div className="grid gap-2">
            {MODES.map((m) => (
              <label key={m.id} className={clsx("flex gap-3 rounded-lg border px-3.5 py-3", remediation.mode === m.id ? "border-brand bg-brand-50/40" : "border-line", !canEdit && "opacity-70")}>
                <input type="radio" name="mode" checked={remediation.mode === m.id} onChange={() => setRemediation({ ...remediation, mode: m.id })} disabled={!canEdit} className="mt-0.5 accent-brand" />
                <span>
                  <span className="block text-[13px] font-medium">{m.title}</span>
                  <span className="block text-[12px] text-muted">{m.text}</span>
                </span>
              </label>
            ))}
          </div>
          <Field label="Branch name prefix" hint={`Branches look like ${remediation.branchPrefix}rightsize-core-services`}>
            <input value={remediation.branchPrefix} onChange={(e) => setRemediation({ ...remediation, branchPrefix: e.target.value })} disabled={!canEdit} className={clsx(inputClass, "h-10 font-mono")} />
          </Field>
          <div>
            <p className="mb-2 text-[12.5px] font-medium">Changes the platform may prepare</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(changeTypes).map(([id, label]) => (
                <Toggle
                  key={id}
                  checked={remediation.allowedChanges.includes(id as never)}
                  onChange={(on) => toggleChange(id, on)}
                  disabled={!canEdit}
                  label={label}
                  hint={remediation.mode === "auto_apply" ? (lowRisk.includes(id) ? "Applied automatically" : "Branch only") : undefined}
                />
              ))}
            </div>
          </div>
          {s1.footer(!canEdit)}
        </Section>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void s2.save("/api/org/settings", { backups });
        }}
      >
        <Section title="Backups before deletion" description="Before a volume, disk or bucket is deleted, an archive-tier copy is taken. Recommendations include its cost in the savings they show.">
          <Field label="Keep the backup for">
            <select
              value={backups.retentionDays === null ? "forever" : String(backups.retentionDays)}
              onChange={(e) => setBackups({ retentionDays: e.target.value === "forever" ? null : Number(e.target.value) })}
              disabled={!canEdit}
              className={clsx(inputClass, "h-10 w-60")}
            >
              <option value="90">90 days</option>
              <option value="365">1 year</option>
              <option value="1095">3 years</option>
              <option value="2555">7 years</option>
              <option value="forever">Until someone deletes it</option>
            </select>
          </Field>
          {s2.footer(!canEdit)}
        </Section>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void s3.save("/api/org/settings", { git });
        }}
      >
        <Section title="Infrastructure repository" description="Where your Terraform lives. Remediation branches are pushed here; access is granted through the Git provider's app installation.">
          <Field label="Provider">
            <select value={git.provider ?? ""} onChange={(e) => setGit({ ...git, provider: (e.target.value || null) as never })} disabled={!canEdit} className={clsx(inputClass, "h-10 w-60")}>
              <option value="">Not connected</option>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
          </Field>
          {git.provider && (
            <>
              <Field label="Repository" hint="owner/name">
                <input value={git.repository} onChange={(e) => setGit({ ...git, repository: e.target.value })} disabled={!canEdit} placeholder="acme/infrastructure" className={clsx(inputClass, "h-10 font-mono")} />
              </Field>
              <div className="grid max-w-lg gap-4 sm:grid-cols-2">
                <Field label="Base branch">
                  <input value={git.baseBranch} onChange={(e) => setGit({ ...git, baseBranch: e.target.value })} disabled={!canEdit} className={clsx(inputClass, "h-10 font-mono")} />
                </Field>
                <Field label="Terraform path">
                  <input value={git.terraformPath} onChange={(e) => setGit({ ...git, terraformPath: e.target.value })} disabled={!canEdit} className={clsx(inputClass, "h-10 font-mono")} />
                </Field>
              </div>
            </>
          )}
          {s3.footer(!canEdit)}
        </Section>
      </form>
    </div>
  );
}

/* ---------------- Notifications ---------------- */

export function NotificationSettings({ notifications, admins, canEdit }: { notifications: OrgSettings["notifications"]; admins: string[]; canEdit: boolean }) {
  const [n, setN] = useState(notifications);
  const [emails, setEmails] = useState(notifications.emails.join(", "));
  const s = useSave();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void s.save("/api/org/settings", { notifications: { ...n, emails: emails.split(/[\s,]+/).filter(Boolean) } });
      }}
    >
      <ReadOnlyNote canEdit={canEdit} />
      <Section title="Email notifications" description={`Sent to owners and admins (${admins.join(", ") || "none yet"}) and to any extra addresses below.`}>
        <Toggle checked={n.newHighImpact} onChange={(v) => setN({ ...n, newHighImpact: v })} disabled={!canEdit} label="New high-impact savings" hint="When an analysis finds a high-impact recommendation that wasn't there before." />
        <Toggle checked={n.syncFailures} onChange={(v) => setN({ ...n, syncFailures: v })} disabled={!canEdit} label="Sync failures" hint="When a cloud account can't be read after all retries." />
        <Field label="Also send to" hint="Comma-separated email addresses, e.g. a team list.">
          <input value={emails} onChange={(e) => setEmails(e.target.value)} disabled={!canEdit} placeholder="finops@acme.com" className={clsx(inputClass, "h-10")} />
        </Field>
        {s.footer(!canEdit)}
      </Section>
    </form>
  );
}

/* ---------------- Data & privacy ---------------- */

export function DataPanel({ orgName, canDelete, isDemo, hasSubscription }: { orgName: string; canDelete: boolean; isDemo: boolean; hasSubscription: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Section
        title="Encryption"
        description="How your cloud credentials are protected."
      >
        <p className="max-w-xl text-[13px] leading-relaxed text-slate-700">
          Credentials are encrypted with AES-256-GCM using a key that belongs to this organization alone. That key is itself encrypted by the platform&apos;s master key, and it is destroyed when the organization is deleted. Access to your clouds is read-only unless you enable write access per account.
        </p>
      </Section>
      <Section title="Export your data" description="Everything we hold about this organization as one JSON file: accounts, resources, costs, recommendations, scenarios, members and the audit log. Credentials are never exported.">
        <a href={canDelete ? "/api/org/export" : undefined} aria-disabled={!canDelete} className={clsx(buttonClass("secondary"), !canDelete && "pointer-events-none opacity-50")}>
          <Download size={14} /> Download export
        </a>
        {!canDelete && <p className="text-xs text-muted">Only owners can export.</p>}
      </Section>
      {!isDemo && (
        <Section title="Delete organization" description="Removes the organization, its cloud connections and all of its data for everyone. Members keep their own login. This cannot be undone.">
          <button onClick={() => setOpen(true)} disabled={!canDelete} className={buttonClass("danger")}>
            <Trash2 size={14} /> Delete {orgName}
          </button>
          {!canDelete && <p className="text-xs text-muted">Only owners can delete the organization.</p>}
          {hasSubscription && <p className="text-xs text-muted">Cancel the subscription on the Billing page first.</p>}
        </Section>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete ${orgName}?`}>
        <p className="text-[13px] leading-relaxed text-slate-700">
          All cloud connections, usage history, recommendations and scenarios are removed, and everyone loses access. Download an export first if you may need any of it.
        </p>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12.5px] font-medium">
            Type <b>{orgName}</b> to confirm
          </span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={clsx(inputClass, "h-10")} autoFocus />
        </label>
        {err && (
          <div className="mt-3">
            <Notice tone="error">{err}</Notice>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setOpen(false)} className={buttonClass("secondary")}>
            Cancel
          </button>
          <button
            disabled={confirm !== orgName || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await api<{ next: string }>("/api/org/delete", { body: { confirm } });
                window.location.assign(r.next);
              } catch (e) {
                setErr((e as Error).message);
                setBusy(false);
              }
            }}
            className={clsx(buttonClass("danger"), "bg-red-600 text-white ring-red-600 hover:bg-red-700")}
          >
            {busy && <Spinner />} Delete permanently
          </button>
        </div>
      </Modal>
    </div>
  );
}
