import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { CATEGORY_LABEL, CATEGORY_STYLE, IMPACT_STYLE, STATUS_LABEL, STATUS_STYLE, cap } from "@/lib/format";

export function Card({ className, children, ...rest }: ComponentProps<"div">) {
  return (
    <div className={clsx("rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-start justify-between gap-3 px-5 pt-4", className)}>
      <div>
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {back && (
          <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", className)}>{children}</span>;
}

export const ImpactBadge = ({ impact }: { impact: string }) => <Pill className={IMPACT_STYLE[impact]}>{cap(impact)} Impact</Pill>;
export const CategoryBadge = ({ category }: { category: string }) => <Pill className={CATEGORY_STYLE[category] ?? "bg-slate-50 text-slate-700 ring-slate-200"}>{CATEGORY_LABEL[category] ?? category}</Pill>;
export const StatusBadge = ({ status }: { status: string }) => <Pill className={STATUS_STYLE[status]}>{STATUS_LABEL[status] ?? status}</Pill>;
export const LevelText = ({ level }: { level: string }) => {
  const dot = level === "high" ? "bg-red-500" : level === "medium" ? "bg-amber-500" : "bg-green-500";
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
      <span className={clsx("size-2 rounded-full", dot)} aria-hidden />
      {cap(level)}
    </span>
  );
};

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const BTN: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-600 shadow-sm",
  secondary: "bg-white text-ink ring-1 ring-inset ring-line hover:bg-slate-50",
  ghost: "text-muted hover:text-ink hover:bg-slate-100",
  danger: "bg-white text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: "sm" | "md" = "md") {
  return clsx(
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-3.5 text-[13px]",
    BTN[variant],
  );
}

export function LinkButton({ href, variant, size, children, className }: { href: string; variant?: ButtonVariant; size?: "sm" | "md"; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={clsx(buttonClass(variant, size), className)}>
      {children}
    </Link>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "neutral" }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1.5 text-[26px] font-semibold leading-tight tracking-tight text-ink">{value}</p>
      {sub && <p className={clsx("mt-1 text-xs", tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-muted")}>{sub}</p>}
    </Card>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[15px] font-semibold text-ink">{children}</h2>
      {action}
    </div>
  );
}
