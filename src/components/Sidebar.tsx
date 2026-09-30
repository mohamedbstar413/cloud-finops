"use client";

import clsx from "clsx";
import { BellRing, BrainCircuit, Building2, ChartColumn, Cloud, House, Settings, TrendingDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "./ProviderLogo";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: House },
  { href: "/recommendations", label: "Recommendations", icon: BellRing },
  { href: "/advisor", label: "Architecture Advisor", icon: BrainCircuit, badge: "AI" },
  { href: "/savings", label: "Savings Projection", icon: TrendingDown },
  { href: "/cost-explorer", label: "Cost Explorer", icon: ChartColumn },
  { href: "/accounts", label: "Accounts", icon: Cloud },
  { href: "/organization", label: "Organization", icon: Building2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ org, user }: { org: { name: string; plan: string }; user: { name: string; email: string; role: string } }) {
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
      <nav className="flex-1 space-y-0.5 px-3">
        {NAV.map(({ href, label, icon: Icon, badge }) => {
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
      <div className="space-y-3 px-3 pb-4">
        <div className="rounded-lg bg-navy-800 px-3 py-2.5">
          <p className="text-[13px] font-medium text-white">{org.name}</p>
          <p className="text-[11px] capitalize">{org.plan} Plan</p>
        </div>
        <div className="flex items-center gap-2.5 px-1">
          <span className="grid size-8 place-items-center rounded-full bg-brand text-xs font-semibold text-white">{initials}</span>
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium text-white">{user.name}</p>
            <p className="truncate text-[11px]">
              {user.email} · <span className="capitalize">{user.role}</span>
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
