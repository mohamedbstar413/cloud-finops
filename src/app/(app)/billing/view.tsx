"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, Spinner } from "@/components/client-ui";
import { buttonClass } from "@/components/ui";

export function PlanActions({ action, plan, label }: { action: "checkout" | "portal" | "dev"; plan?: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <button
        className={buttonClass(action === "checkout" ? "primary" : "secondary")}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            if (action === "dev") {
              await api("/api/billing/plan", { body: { plan } });
              router.refresh();
              setBusy(false);
            } else {
              const r = await api<{ url: string }>(`/api/billing/${action}`, { method: "POST" });
              window.location.assign(r.url);
            }
          } catch (e) {
            setErr((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner />} {label}
      </button>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </div>
  );
}
