import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { CreateOrganizationForm, SignOutButton } from "../forms";

export const dynamic = "force-dynamic";

/** Signed in, but not part of any organization (e.g. theirs was deleted). */
export default async function WelcomePage() {
  const s = await currentUser();
  if (!s) redirect("/login");
  if (s.org) redirect("/dashboard");
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Create an organization</h1>
      <p className="mt-1 text-[13px] text-muted">
        You&apos;re signed in as {s.user.email} but not part of an organization. Create one, or open an invitation link from a teammate.
      </p>
      <CreateOrganizationForm />
      <div className="mt-6 text-center">
        <SignOutButton />
      </div>
    </div>
  );
}
