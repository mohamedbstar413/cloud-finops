"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SubNavItem {
  href: string;
  label: string;
  count?: number;
  /** Also active for these path prefixes (e.g. a scenario page belongs to "Scenarios"). */
  alsoFor?: string[];
}

/** Section tabs under a page header: each tab is its own page, so every page stays focused. */
export function SubNav({ items }: { items: SubNavItem[] }) {
  const path = usePathname();
  return (
    <nav className="-mt-2 mb-6 flex gap-1 overflow-x-auto border-b border-line" aria-label="Section">
      {items.map((i) => {
        const active = path === i.href || (i.alsoFor ?? []).some((p) => path.startsWith(p));
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors",
              active ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {i.label}
            {i.count !== undefined && (
              <span className={clsx("tabular rounded-full px-1.5 py-px text-[11px]", active ? "bg-brand-50 text-brand" : "bg-slate-100 text-slate-600")}>{i.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
