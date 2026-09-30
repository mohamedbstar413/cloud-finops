"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function PeriodSelect({ value }: { value: number }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  return (
    <select
      aria-label="Period"
      value={value}
      onChange={(e) => {
        const next = new URLSearchParams(sp.toString());
        next.set("days", e.target.value);
        router.push(`${path}?${next.toString()}`);
      }}
      className="h-9 rounded-lg border border-line bg-white px-3 text-[13px] text-ink outline-none focus:border-brand"
    >
      <option value={7}>Last 7 days</option>
      <option value={30}>Last 30 days</option>
      <option value={60}>Last 60 days</option>
      <option value={90}>Last 90 days</option>
    </select>
  );
}
