"use client";

import clsx from "clsx";
import { BellRing, BrainCircuit, Building2, Check, ChartColumn, ChevronsUpDown, Cloud, CreditCard, House, LogOut, Plus, Settings, TrendingDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "./client-ui";
import { BrandMark } from "./ProviderLogo";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: House },
  { href: "/recommendations", label: "Recommendations", icon: BellRing },
  { href: "/advisor", label: "Architecture Advisor", icon: BrainCircuit, badge: "AI" },
  { href: "/savings", label: "Savings Projection", icon: TrendingDown },
  { href: "/cost-explorer", label: "Cost Explorer", icon: ChartColumn },
  { href: "/accounts", label: "Accounts", icon: Cloud },
  { href: "/organization", label: "Organization", icon: Building2 },
  { href: "/billing", label: "Plan & billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
];

type Org = { id: string; name: string; role: string; isDemo: boolean };

async function go(url: string, body: unknown) {
  const r = await api<{ next?: string }>(url, { body });
  window.location.assign(r.next ?? "/dashboard");
}

/** Organization card: shows where you are, switches organization, creates a new one, signs out. */
function OrgMenu({ org, orgs, user }: { org: { id: string; name: string; plan: string; isDemo: boolean }; orgs: Org[]; user: { name: string; email: string; role: string } }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-lg bg-navy-800 px-3 py-2.5 text-left hover:bg-navy-700">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-white">{org.name}</span>
          <span className="block text-[11px] capitalize">{org.isDemo ? "Read-only demo" : `${org.plan} plan · ${user.role}`}</span>
        </span>
        <ChevronsUpDown size={14} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-line bg-white py-1.5 text-[13px] text-ink shadow-xl">
          <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted">Organizations</p>
          {orgs.map((o) => (
            <button key={o.id} onClick={() => o.id !== org.id && go("/api/auth/switch", { orgId: o.id })} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50">
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              {o.id === org.id ? <Check size={14} className="text-brand" /> : <span className="text-[11px] capitalize text-muted">{o.role}</span>}
            </button>
          ))}
          {creating ? (
            <form
              className="border-t border-line px-3 py-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setErr(null);
                try {
                  await go("/api/orgs", { name });
                } catch (x) {
                  setErr((x as Error).message);
                }
              }}
            >
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Organization name" className="h-8 w-full rounded-md border border-line px-2 text-[13px] outline-none focus:border-brand" />
              {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
              <button type="submit" className="mt-2 h-8 w-full rounded-md bg-brand text-[12.5px] font-medium text-white">
                Create
              </button>
            </form>
          ) : (
            !org.isDemo && (
              <button onClick={() => setCreating(true)} className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left hover:bg-slate-50">
                <Plus size={14} /> New organization
              </button>
            )
          )}
          <button onClick={() => go("/api/auth/logout", {})} className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-muted hover:bg-slate-50 hover:text-ink">
            <LogOut size={14} /> {org.isDemo ? "Leave the demo" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar({ org, orgs, user }: { org: { id: string; name: string; plan: string; isDemo: boolean }; orgs: Org[]; user: { name: string; email: string; role: string } }) {
  const path = usePathname();
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-navy-900 text-navy-300">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-5 pb-6 pt-5">
        <BrandMark size={34} />
        <span className="text-[14px] font-semibold leading-tight text-white">
          Cloud Price
          <br />
          Optimizer
        </span>
      </Link>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV.filter((n) => !(org.isDemo && n.href === "/billing")).map(({ href, label, icon: Icon, badge }) => {
          const active = path === href || path.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                active ? "bg-navy-700 text-white" : "hover:bg-navy-800 hover:text-white",
              )}
            >
              <Icon size={16} strokeWidth={1.9} />
              <span className="flex-1">{label}</span>
              {badge && <span className="rounded bg-brand/25 px-1.5 py-px text-[10px] font-semibold text-blue-200">{badge}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-3 px-3 pb-4 pt-3">
        <OrgMenu org={org} orgs={orgs} user={user} />
        <div className="flex items-center gap-2.5 px-1">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-white">{initials}</span>
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium text-white">{user.name}</p>
            <p className="truncate text-[11px]">{user.email}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
