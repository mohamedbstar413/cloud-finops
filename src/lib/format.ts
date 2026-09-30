import type { Provider } from "./pricing/catalog";

export const usd = (n: number, opts: { cents?: boolean; compact?: boolean } = {}) => {
  if (opts.compact && Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1)}k`;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: opts.cents ? 2 : 0, maximumFractionDigits: opts.cents ? 2 : 0 })}`;
};

export const pct = (n: number, digits = 0) => `${n.toFixed(digits)}%`;

export const PROVIDER_COLOR: Record<Provider, string> = {
  aws: "#eb6834",
  azure: "#2a78d6",
  gcp: "#1baf7a",
};

export const PROVIDER_NAME: Record<Provider, string> = { aws: "AWS", azure: "Azure", gcp: "GCP" };

export const CATEGORY_LABEL: Record<string, string> = {
  architecture: "Architecture",
  cross_cloud: "Cross-cloud",
  rightsizing: "Rightsizing",
  idle: "Idle resources",
  commitment: "Commitments",
  storage: "Storage",
  scheduling: "Scheduling",
  anomaly: "Anomaly",
  compute: "Compute",
  database: "Database",
  network: "Network",
  analytics: "Analytics",
  observability: "Observability",
  other: "Other",
};

export const CATEGORY_STYLE: Record<string, string> = {
  architecture: "bg-violet-50 text-violet-700 ring-violet-200",
  cross_cloud: "bg-teal-50 text-teal-700 ring-teal-200",
  rightsizing: "bg-amber-50 text-amber-700 ring-amber-200",
  idle: "bg-slate-100 text-slate-700 ring-slate-200",
  commitment: "bg-sky-50 text-sky-700 ring-sky-200",
  storage: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  scheduling: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  anomaly: "bg-rose-50 text-rose-700 ring-rose-200",
};

export const IMPACT_STYLE: Record<string, string> = {
  high: "bg-red-50 text-red-700 ring-red-200",
  medium: "bg-amber-50 text-amber-700 ring-amber-200",
  low: "bg-sky-50 text-sky-700 ring-sky-200",
};

export const STATUS_STYLE: Record<string, string> = {
  open: "bg-slate-100 text-slate-700 ring-slate-200",
  in_progress: "bg-blue-50 text-blue-700 ring-blue-200",
  applied: "bg-green-50 text-green-700 ring-green-200",
  dismissed: "bg-slate-50 text-slate-500 ring-slate-200",
  snoozed: "bg-purple-50 text-purple-700 ring-purple-200",
};

export const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  applied: "Applied",
  dismissed: "Dismissed",
  snoozed: "Snoozed",
};

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function timeAgo(isoDate: string | null) {
  if (!isoDate) return "never";
  const s = (Date.now() - new Date(isoDate).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const shortDate = (d: string) => new Date(d + (d.length === 10 ? "T00:00:00Z" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
