"use client";

import { UserPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, inputClass, Notice, Spinner } from "@/components/client-ui";
import { buttonClass } from "@/components/ui";

const ROLE_OPTIONS = ["owner", "admin", "member", "viewer"];

export function MemberRoleSelect({ id, role }: { id: string; role: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <select
        defaultValue={role}
        onChange={async (e) => {
          setErr(null);
          try {
            await api(`/api/org/members/${id}`, { method: "PATCH", body: { role: e.target.value } });
            router.refresh();
          } catch (x) {
            setErr((x as Error).message);
            e.target.value = role;
          }
        }}
        className="h-8 rounded-md border border-line bg-white px-2 text-[12.5px] capitalize"
        aria-label="Role"
      >
        {ROLE_OPTIONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

export function InviteForm({ canInviteOwner }: { canInviteOwner: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          await api("/api/org/members", { body: { email, role } });
          setMsg({ tone: "success", text: `Invitation recorded for ${email}.` });
          setEmail("");
          router.refresh();
        } catch (x) {
          setMsg({ tone: "error", text: (x as Error).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-[12.5px] font-semibold">Invite a teammate</p>
      <div className="flex flex-wrap gap-2">
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className={`${inputClass} max-w-xs`} />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="h-9 rounded-lg border border-line bg-white px-2 text-[13px] capitalize" aria-label="Role">
          {ROLE_OPTIONS.filter((r) => canInviteOwner || r !== "owner").map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className={buttonClass("primary")} disabled={busy}>
          {busy ? <Spinner /> : <UserPlus size={14} />} Invite
        </button>
      </div>
      {msg && (
        <Notice tone={msg.tone} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
    </form>
  );
}

export function RemoveInvite({ id }: { id: string }) {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await api(`/api/org/members?invite=${id}`, { method: "DELETE" });
        router.refresh();
      }}
      className="inline-flex items-center gap-1 text-xs text-muted hover:text-red-600"
    >
      <X size={12} /> Revoke
    </button>
  );
}

/** Demo helper: act as another member to preview role-based access. */
export function ViewAsSwitcher({ members, current }: { members: { userId: string; label: string }[]; current: string }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      View as (demo)
      <select
        value={current}
        onChange={async (e) => {
          await api("/api/session", { body: { userId: e.target.value } });
          router.refresh();
        }}
        className="h-9 rounded-lg border border-line bg-white px-2 text-[13px] text-ink"
      >
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
