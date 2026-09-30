import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { LoginForm } from "../forms";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const sp = await searchParams;
  const s = await currentUser();
  if (s?.org && !s.org.isDemo) redirect("/dashboard");
  return <LoginForm next={sp.next} notice={sp.reset ? "Your password was changed. Sign in with the new one." : undefined} />;
}
