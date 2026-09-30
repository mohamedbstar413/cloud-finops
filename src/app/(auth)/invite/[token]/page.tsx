import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { findInvite, normalizeEmail } from "@/lib/services/auth";
import { AcceptInviteButton, InviteSignupForm, SignOutButton } from "../../forms";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await findInvite(token);
  if (!invite) {
    return (
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">This invitation has expired</h1>
        <p className="mt-2 text-[13px] text-muted">It was already used, revoked, or is more than 14 days old. Ask whoever invited you to send a new one.</p>
        <Link href="/login" className="mt-6 inline-block text-[13px] font-medium text-brand hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }
  const heading = (
    <>
      <h1 className="text-[22px] font-semibold tracking-tight">Join {invite.org.name}</h1>
      <p className="mt-1 text-[13px] text-muted">
        {invite.invitedBy ?? "A teammate"} invited <b className="font-medium text-ink">{invite.email}</b> as <span className="capitalize">{invite.role}</span>.
      </p>
    </>
  );
  const s = await currentUser();
  if (s && normalizeEmail(s.user.email) === invite.email) {
    return (
      <div>
        {heading}
        <AcceptInviteButton token={token} orgName={invite.org.name} />
      </div>
    );
  }
  if (s) {
    return (
      <div>
        {heading}
        <p className="mt-6 text-[13px] text-slate-700">
          You&apos;re signed in as {s.user.email}. Sign out, then open this link again to accept with {invite.email}.
        </p>
        <div className="mt-4">
          <SignOutButton />
        </div>
      </div>
    );
  }
  const existing = await prisma.user.findUnique({ where: { email: invite.email }, select: { passwordHash: true } });
  if (existing?.passwordHash) {
    return (
      <div>
        {heading}
        <p className="mt-6 text-[13px] text-slate-700">You already have an account. Sign in and you&apos;ll come back here to accept.</p>
        <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-lg bg-brand text-[13px] font-medium text-white hover:bg-brand-600">
          Sign in to accept
        </Link>
      </div>
    );
  }
  return (
    <div>
      {heading}
      <InviteSignupForm token={token} email={invite.email} orgName={invite.org.name} />
    </div>
  );
}
