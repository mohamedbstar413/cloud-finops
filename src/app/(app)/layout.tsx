import { Sidebar } from "@/components/Sidebar";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { org, user, role } = await getSession();
  return (
    <div className="flex min-h-screen">
      <Sidebar org={{ name: org.name, plan: org.plan }} user={{ name: user.name, email: user.email, role }} />
      <main className="min-w-0 flex-1 px-8 py-7">
        <div className="mx-auto max-w-[1280px]">{children}</div>
      </main>
    </div>
  );
}
