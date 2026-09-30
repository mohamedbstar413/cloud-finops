import { Notice } from "@/components/client-ui";
import { Card, PageHeader } from "@/components/ui";
import { can, pageSession } from "@/lib/auth";
import { usage } from "@/lib/billing/limits";
import { PLANS } from "@/lib/billing/plans";
import { stripeConfigured } from "@/lib/billing/stripe";
import { PlanActions } from "./view";

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ upgraded?: string }> }) {
  const { org, role } = await pageSession();
  const u = await usage(org.id);
  const canManage = can(role, "billing:manage") && !org.isDemo;
  const payments = stripeConfigured();
  const devSwitch = !payments && process.env.NODE_ENV !== "production";
  const lapsed = org.planStatus === "past_due" || org.planStatus === "canceled";
  return (
    <>
      <PageHeader title="Plan & billing" subtitle="Your plan, what you're using, and how to change it" />
      {(await searchParams).upgraded && (
        <div className="mb-5">
          <Notice tone="success">Thank you — your subscription is active. It can take a few seconds for the plan below to update.</Notice>
        </div>
      )}
      {lapsed && org.plan !== "free" && (
        <div className="mb-5">
          <Notice tone="error">The last payment did not go through, so Free plan limits apply until it does. Update the card under “Manage billing”.</Notice>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card className="p-6">
          <p className="text-xs font-medium text-muted">Current plan</p>
          <p className="mt-1.5 text-[26px] font-semibold tracking-tight">{u.plan.name}</p>
          <p className="text-[13px] text-muted">
            {u.plan.priceMonthly === null ? "Custom pricing" : u.plan.priceMonthly === 0 ? "Free" : `$${u.plan.priceMonthly} per month`}
            {org.planStatus !== "active" && <span className="ml-1 capitalize">· {org.planStatus.replace("_", " ")}</span>}
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-slate-700">{u.plan.blurb}.</p>
          {canManage && org.stripeCustomerId && payments && (
            <div className="mt-5">
              <PlanActions action="portal" label="Manage billing" />
            </div>
          )}
        </Card>
        <Card className="p-6">
          <p className="text-[14px] font-semibold">Usage</p>
          <div className="mt-4 space-y-4">
            {u.meters.map((m) => {
              const pct = m.limit ? Math.min(100, (m.used / m.limit) * 100) : 0;
              return (
                <div key={m.id}>
                  <div className="flex items-baseline justify-between text-[13px]">
                    <span>{m.label}</span>
                    <span className="tabular text-muted">
                      <b className="font-semibold text-ink">{m.used.toLocaleString()}</b> {m.limit === null ? "· unlimited" : `of ${m.limit.toLocaleString()}`}
                    </span>
                  </div>
                  {m.limit !== null && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-[11.5px] text-muted">Sample-data accounts are free and not counted.</p>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-[15px] font-semibold">Plans</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {Object.values(PLANS).map((p) => {
          const current = p.id === u.plan.id;
          return (
            <Card key={p.id} className={`flex flex-col p-5 ${current ? "ring-2 ring-brand" : ""}`}>
              <p className="text-[15px] font-semibold">{p.name}</p>
              <p className="mt-1 text-[22px] font-semibold tracking-tight">
                {p.priceMonthly === null ? "Custom" : p.priceMonthly === 0 ? "$0" : `$${p.priceMonthly}`}
                {p.priceMonthly ? <span className="text-[13px] font-normal text-muted"> / month</span> : null}
              </p>
              <p className="mt-2 text-[12.5px] text-muted">{p.blurb}</p>
              <ul className="mt-4 flex-1 space-y-1.5 text-[12.5px] text-slate-700">
                <li>{p.limits.cloudAccounts === null ? "Unlimited" : p.limits.cloudAccounts} cloud account{p.limits.cloudAccounts === 1 ? "" : "s"}</li>
                <li>{p.limits.resources === null ? "Unlimited" : p.limits.resources.toLocaleString()} resources</li>
                <li>{p.limits.members === null ? "Unlimited" : p.limits.members} members</li>
                <li>{p.limits.aiCallsPerMonth === null ? "Unlimited" : p.limits.aiCallsPerMonth.toLocaleString()} AI requests a month</li>
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <div className="mt-5">
                {current ? (
                  <span className="inline-flex h-9 items-center text-[13px] font-medium text-brand">Current plan</span>
                ) : !canManage ? null : devSwitch ? (
                  <PlanActions action="dev" plan={p.id} label={`Switch to ${p.name} (development)`} />
                ) : p.id === "pro" && payments ? (
                  <PlanActions action="checkout" label="Upgrade to Pro" />
                ) : p.id === "enterprise" ? (
                  <a href="mailto:sales@cloudpriceoptimizer.dev?subject=Enterprise%20plan" className="inline-flex h-9 items-center rounded-lg px-3.5 text-[13px] font-medium ring-1 ring-inset ring-line hover:bg-slate-50">
                    Talk to us
                  </a>
                ) : p.id === "free" && org.stripeCustomerId && payments ? (
                  <PlanActions action="portal" label="Downgrade in billing portal" />
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
      {!payments && (
        <p className="mt-4 text-[12px] text-muted">
          Payments are not configured on this deployment (set STRIPE_SECRET_KEY, STRIPE_PRICE_PRO and STRIPE_WEBHOOK_SECRET).{devSwitch ? " In development you can switch plans directly to try the limits." : ""}
        </p>
      )}
      {!canManage && !org.isDemo && <p className="mt-4 text-[12px] text-muted">Only owners can change the plan.</p>}
    </>
  );
}
