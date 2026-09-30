import Link from "next/link";
import { JobsBanner } from "@/components/JobsBanner";
import { Sidebar } from "@/components/Sidebar";
import { pageSession } from "@/lib/auth";
import { activeJobs } from "@/lib/jobs/queue";
import { organizationsOf } from "@/lib/services/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { org, user, role } = await pageSession();
  const [orgs, jobs] = await Promise.all([organizationsOf(user.id), activeJobs(org.id)]);
  return (
    <div className="flex min-h-screen">
      <Sidebar
        org={{ id: org.id, name: org.name, plan: org.plan, isDemo: org.isDemo }}
        orgs={orgs.filter((o) => !o.isDemo || o.id === org.id)}
        user={{ name: user.name, email: user.email, role }}
      />
      <main className="min-w-0 flex-1 px-8 py-7">
        <div className="mx-auto max-w-[1280px]">
          {org.isDemo && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-navy-900 px-4 py-2.5 text-[13px] text-navy-300">
              <span>
                <b className="font-medium text-white">You&apos;re exploring a read-only demo</b> with sample AWS, Azure and GCP accounts.
              </span>
              <Link href="/signup" className="rounded-md bg-brand px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-brand-600">
                Try it on your own clouds — free
              </Link>
            </div>
          )}
          <JobsBanner initial={jobs.map((j) => ({ id: j.id, type: j.type, status: j.status, error: j.error, result: j.result }))} />
          {children}
        </div>
      </main>
    </div>
  );
}
