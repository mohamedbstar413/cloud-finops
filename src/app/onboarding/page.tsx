import { redirect } from "next/navigation";
import { BrandMark } from "@/components/ProviderLogo";
import { can, pageSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { activeJobs } from "@/lib/jobs/queue";
import { Onboarding } from "./view";

export const dynamic = "force-dynamic";

/** First run for a new organization: connect a cloud (or load sample data), then watch the first analysis. */
export default async function OnboardingPage() {
  const { org, user, role } = await pageSession();
  if (org.isDemo || !can(role, "account:manage")) redirect("/dashboard");
  const [accounts, jobs, recs] = await Promise.all([
    prisma.cloudAccount.count({ where: { orgId: org.id } }),
    activeJobs(org.id),
    prisma.recommendation.aggregate({ where: { orgId: org.id, overlapsWith: null, status: "open", category: { not: "anomaly" } }, _count: true, _sum: { monthlySavings: true } }),
  ]);
  return (
    <div className="min-h-screen bg-canvas">
      <header className="flex items-center gap-2.5 px-8 py-5">
        <BrandMark size={30} />
        <span className="text-[14px] font-semibold">Cloud Price Optimizer</span>
        <span className="ml-auto text-xs text-muted">
          {org.name} · {user.email}
        </span>
      </header>
      <main className="mx-auto max-w-3xl px-5 pb-16 pt-6">
        <Onboarding
          orgName={org.name}
          firstName={user.name.split(" ")[0]}
          hasAccounts={accounts > 0}
          initialJobs={jobs}
          summary={{ recommendations: recs._count, monthlySavings: recs._sum.monthlySavings ?? 0 }}
        />
      </main>
    </div>
  );
}
