"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** "Showing 9–16 of 27" with previous / next and page numbers. Renders nothing for a single page. */
export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const go = (p: number) => {
    onChange(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const btn = "grid size-8 place-items-center rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40";
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p className="tabular text-xs text-muted">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1" role="navigation" aria-label="Pages">
        <button className={clsx(btn, "text-muted hover:bg-slate-100 hover:text-ink")} onClick={() => go(page - 1)} disabled={page === 1} aria-label="Previous page">
          <ChevronLeft size={16} />
        </button>
        {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
          <button key={p} onClick={() => go(p)} aria-current={p === page ? "page" : undefined} className={clsx(btn, p === page ? "bg-brand text-white" : "text-muted hover:bg-slate-100 hover:text-ink")}>
            {p}
          </button>
        ))}
        <button className={clsx(btn, "text-muted hover:bg-slate-100 hover:text-ink")} onClick={() => go(page + 1)} disabled={page === pages} aria-label="Next page">
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
