import clsx from "clsx";
import type { Provider } from "@/lib/pricing/catalog";

/** Simple provider marks (not official logos) used as identity chips. */
export function ProviderLogo({ provider, size = 20, className }: { provider: Provider; size?: number; className?: string }) {
  if (provider === "aws") {
    return (
      <svg width={size * 1.5} height={size} viewBox="0 0 30 20" className={className} role="img" aria-label="AWS">
        <text x="1" y="12" fontSize="12" fontWeight="700" fill="#232f3e" fontFamily="Arial, sans-serif">
          aws
        </text>
        <path d="M3 15.5c6 3 14 3 21-.5" stroke="#eb6834" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <path d="M21.5 13.4l2.8 1.4-1.9 2.4" stroke="#eb6834" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
    );
  }
  if (provider === "azure") {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" className={className} role="img" aria-label="Azure">
        <path d="M8 2h4.2L6.6 17.4H2.3z" fill="#0f5fbf" />
        <path d="M12.8 5.5 17.7 17.4H9.2l5.4-1.6-4.1-5.3z" fill="#2a78d6" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} role="img" aria-label="Google Cloud">
      <path d="M12.6 6.2 14.2 4.6l.1-.7A7.2 7.2 0 0 0 2.8 7.4l.6-.1 3.2-.5.2-.3a3.9 3.9 0 0 1 5.8-.3z" fill="#ea4335" />
      <path d="M17.1 7.4a7.3 7.3 0 0 0-2.2-3.5l-2.3 2.3a4 4 0 0 1 1.5 3.2v.4a2 2 0 1 1 0 4H10l-.4.4v2.4l.4.4h4.1a5.2 5.2 0 0 0 3-9.6z" fill="#4285f4" />
      <path d="M5.9 17h4.1v-3.2H5.9a2 2 0 0 1-.8-.2l-.6.2-1.6 1.6-.2.6A5.2 5.2 0 0 0 5.9 17z" fill="#34a853" />
      <path d="M5.9 6.6a5.2 5.2 0 0 0-3.1 9.4l2.4-2.4a2 2 0 1 1 2.6-2.6L10.2 8.6a5.2 5.2 0 0 0-4.3-2z" fill="#fbbc05" />
    </svg>
  );
}

export function ProviderChip({ provider, label, className }: { provider: Provider; label?: string; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-xs font-medium text-ink", className)}>
      <ProviderLogo provider={provider} size={14} />
      {label ?? { aws: "AWS", azure: "Azure", gcp: "GCP" }[provider]}
    </span>
  );
}

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="bm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <path d="M16 2 28.1 9v14L16 30 3.9 23V9z" fill="url(#bm)" />
      <path d="M10 20.5V17m4 3.5v-7m4 7v-5m4 5v-9" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
