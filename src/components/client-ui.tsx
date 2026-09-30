"use client";

import clsx from "clsx";
import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export async function api<T = unknown>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="animate-spin" />;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-[11px] font-medium text-muted hover:text-ink"
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      {done ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, title, maxHeight = 520 }: { code: string; title?: string; maxHeight?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-[#0b1220]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-[11px] font-medium text-slate-400">{title ?? "main.tf"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-auto p-4 text-slate-200" style={{ maxHeight }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide, size }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; size?: "md" | "lg" | "xl" }) {
  const width = size === "xl" ? "max-w-[min(1320px,96vw)]" : size === "lg" || wide ? "max-w-3xl" : "max-w-lg";
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx("max-h-[92vh] w-full overflow-auto rounded-xl bg-white shadow-2xl", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-slate-100 hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            "-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors",
            value === t.id ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = "info", children, onClose }: { tone?: "info" | "success" | "error"; children: ReactNode; onClose?: () => void }) {
  const styles = { info: "border-blue-200 bg-blue-50 text-blue-800", success: "border-green-200 bg-green-50 text-green-800", error: "border-red-200 bg-red-50 text-red-800" };
  return (
    <div className={clsx("flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-[13px]", styles[tone])}>
      <div>{children}</div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function Select({ value, onChange, options, label, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label?: string; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      {label && <span className="mb-1 block text-[11px] font-medium text-muted">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-lg border border-line bg-white px-2.5 text-[13px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-lg border border-line bg-white px-3 text-[13px] text-ink outline-none placeholder:text-slate-400 focus:border-brand focus:ring-2 focus:ring-brand/15";

/* ---------------- Background jobs ---------------- */

export interface ClientJob {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  result: unknown;
}

/** Tell the activity banner that new background work was queued. */
export const announceJobs = () => window.dispatchEvent(new Event("cpo:jobs"));

/** Follow a background job until it finishes. */
export async function waitForJob(id: string, onUpdate?: (job: ClientJob) => void, intervalMs = 1200): Promise<ClientJob> {
  for (;;) {
    const { job } = await api<{ job: ClientJob }>(`/api/jobs/${id}`);
    onUpdate?.(job);
    if (job.status === "succeeded" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
