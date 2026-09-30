import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { SignupForm } from "../forms";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const s = await currentUser();
  if (s?.org && !s.org.isDemo) redirect("/dashboard");
  return <SignupForm />;
}
