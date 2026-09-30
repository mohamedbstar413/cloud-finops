import { HttpError } from "../auth-errors";
import { assertCanAddMember } from "../billing/limits";
import { prisma } from "../db";
import { appUrl, sendEmail } from "../email";
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from "../security/password";
import { hashToken, randomToken } from "../security/tokens";

/**
 * Accounts, sessions, invitations and password resets. Pure server logic with
 * no request objects, so it is tested directly; route handlers only move
 * cookies and JSON in and out.
 */

export type Role = "owner" | "admin" | "member" | "viewer";

const SESSION_DAYS = 30;
const DEMO_SESSION_HOURS = 4;
const INVITE_DAYS = 14;
const RESET_MINUTES = 60;
/** Refresh a session's expiry at most this often (sliding window). */
const TOUCH_MS = 60 * 60_000;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS_PER_EMAIL = 8;
const MAX_ATTEMPTS_PER_CLIENT = 40;

export const DEMO_VIEWER_EMAIL = "demo-viewer@cloudpriceoptimizer.dev";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const later = (ms: number) => new Date(Date.now() + ms);

/* ------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* ------------------------------------------------------------------------- */

export async function createSession(userId: string, orgId: string | null, opts: { userAgent?: string | null; hours?: number } = {}) {
  const token = randomToken();
  const expiresAt = later((opts.hours ?? SESSION_DAYS * 24) * 3_600_000);
  await prisma.session.create({ data: { tokenHash: hashToken(token), userId, orgId, expiresAt, userAgent: opts.userAgent?.slice(0, 200) ?? null } });
  return { token, expiresAt };
}

/**
 * The signed-in user behind a session token, and the organization they are
 * working in — or null when the token is unknown or expired. An organization
 * the user no longer belongs to (or that is being deleted) is dropped from the
 * session rather than trusted.
 */
export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  let membership = session.orgId
    ? await prisma.membership.findUnique({ where: { userId_orgId: { userId: session.userId, orgId: session.orgId } }, include: { org: true } })
    : null;
  if (membership?.org.deletedAt) membership = null;
  if (session.orgId && !membership) await prisma.session.update({ where: { id: session.id }, data: { orgId: null } });
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_MS && !membership?.org.isDemo) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: later(SESSION_DAYS * 86_400_000) } });
  }
  return {
    sessionId: session.id,
    user: session.user,
    org: membership?.org ?? null,
    role: (membership?.role ?? null) as Role | null,
  };
}

export async function endSession(token: string) {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function switchOrganization(sessionId: string, userId: string, orgId: string) {
  const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, include: { org: true } });
  if (!m || m.org.deletedAt) throw new HttpError(404, "You are not a member of that organization");
  await prisma.session.update({ where: { id: sessionId }, data: { orgId } });
}

export async function organizationsOf(userId: string) {
  const ms = await prisma.membership.findMany({ where: { userId, org: { deletedAt: null } }, include: { org: true }, orderBy: { createdAt: "asc" } });
  return ms.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role as Role, isDemo: m.org.isDemo }));
}

/* ------------------------------------------------------------------------- */
/* Sign up and sign in                                                        */
/* ------------------------------------------------------------------------- */

export async function createOrganization(userId: string, name: string) {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 80) throw new HttpError(400, "Organization name must be 2–80 characters.");
  return prisma.organization.create({ data: { name: clean, plan: "free", members: { create: { userId, role: "owner" } } } });
}

export async function signUp(input: { name: string; email: string; password: string; organization: string; userAgent?: string | null }) {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (name.length < 2) throw new HttpError(400, "Please enter your name.");
  const problem = passwordProblem(input.password, email);
  if (problem) throw new HttpError(400, problem);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.passwordHash) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  const passwordHash = await hashPassword(input.password);
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { name, passwordHash } })
    : await prisma.user.create({ data: { name, email, passwordHash } });
  const org = await createOrganization(user.id, input.organization);
  const session = await createSession(user.id, org.id, { userAgent: input.userAgent });
  return { user, org, ...session };
}

async function tooManyAttempts(keys: string[]) {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MS);
  const [email, client] = await Promise.all(keys.map((key) => prisma.authAttempt.count({ where: { key, createdAt: { gte: since } } })));
  return email >= MAX_ATTEMPTS_PER_EMAIL || (client ?? 0) >= MAX_ATTEMPTS_PER_CLIENT;
}

export async function signIn(input: { email: string; password: string; client?: string | null; userAgent?: string | null }) {
  const email = normalizeEmail(input.email);
  const keys = [`email:${email}`, `client:${input.client ?? "unknown"}`];
  if (await tooManyAttempts(keys)) throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes, or reset your password.");
  const user = await prisma.user.findUnique({ where: { email } });
  // Same work whether or not the user exists, so response time does not reveal registered emails.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));
  if (!user || !user.passwordHash || !ok) {
    await prisma.authAttempt.createMany({ data: keys.map((key) => ({ key })) });
    throw new HttpError(401, "Email or password is incorrect.");
  }
  await prisma.authAttempt.deleteMany({ where: { key: keys[0] } });
  const last = await prisma.session.findFirst({ where: { userId: user.id, orgId: { not: null } }, orderBy: { lastSeenAt: "desc" } });
  const orgs = await organizationsOf(user.id);
  const orgId = orgs.find((o) => o.id === last?.orgId)?.id ?? orgs.find((o) => !o.isDemo)?.id ?? orgs[0]?.id ?? null;
  return { user, orgId, ...(await createSession(user.id, orgId, { userAgent: input.userAgent })) };
}

/** A short, read-only visit to the shared demo organization — no account needed. */
export async function startDemoSession(userAgent?: string | null) {
  const org = await prisma.organization.findFirst({ where: { isDemo: true, deletedAt: null } });
  if (!org) throw new HttpError(404, "The demo is not available on this deployment.");
  const viewer = await prisma.user.upsert({ where: { email: DEMO_VIEWER_EMAIL }, create: { email: DEMO_VIEWER_EMAIL, name: "Demo visitor" }, update: {} });
  await prisma.membership.upsert({ where: { userId_orgId: { userId: viewer.id, orgId: org.id } }, create: { userId: viewer.id, orgId: org.id, role: "viewer" }, update: { role: "viewer" } });
  // Old demo sessions are cleaned up as new ones start.
  await prisma.session.deleteMany({ where: { userId: viewer.id, expiresAt: { lt: new Date() } } });
  return createSession(viewer.id, org.id, { userAgent, hours: DEMO_SESSION_HOURS });
}

/* ------------------------------------------------------------------------- */
/* Invitations                                                                */
/* ------------------------------------------------------------------------- */

export async function inviteMember(input: { orgId: string; email: string; role: Role; invitedBy: string }) {
  const email = normalizeEmail(input.email);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: input.orgId } });
  if (org.isDemo) throw new HttpError(403, "The demo organization cannot invite members.");
  if (await prisma.membership.findFirst({ where: { orgId: org.id, user: { email } } })) throw new HttpError(409, "Already a member");
  await assertCanAddMember(org.id);
  const token = randomToken();
  // One live invitation per address: re-inviting replaces the old link.
  await prisma.invite.deleteMany({ where: { orgId: org.id, email, acceptedAt: null } });
  const invite = await prisma.invite.create({ data: { orgId: org.id, email, role: input.role, invitedBy: input.invitedBy, tokenHash: hashToken(token), expiresAt: later(INVITE_DAYS * 86_400_000) } });
  await sendEmail({
    to: email,
    subject: `${input.invitedBy} invited you to ${org.name} on Cloud Price Optimizer`,
    text: `${input.invitedBy} invited you to join ${org.name} as ${input.role}.\n\nAccept the invitation: ${appUrl(`/invite/${token}`)}\n\nThe link expires in ${INVITE_DAYS} days.`,
  });
  return { invite, token };
}

export async function findInvite(token: string) {
  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashToken(token) }, include: { org: true } });
  if (!invite || invite.acceptedAt || invite.org.deletedAt || (invite.expiresAt && invite.expiresAt < new Date())) return null;
  return invite;
}

/** Join the invitation's organization as an existing, signed-in user. */
export async function acceptInvite(token: string, userId: string) {
  const invite = await findInvite(token);
  if (!invite) throw new HttpError(404, "This invitation is no longer valid. Ask for a new one.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (normalizeEmail(user.email) !== invite.email) throw new HttpError(403, `This invitation was sent to ${invite.email}. Sign in with that address to accept it.`);
  await prisma.membership.upsert({ where: { userId_orgId: { userId, orgId: invite.orgId } }, create: { userId, orgId: invite.orgId, role: invite.role }, update: {} });
  await prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
  // Following the link proves the address.
  if (!user.emailVerifiedAt) await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.auditLog.create({ data: { orgId: invite.orgId, actor: user.name, action: `joined as ${invite.role}`, target: user.email } });
  return invite;
}

/** Create an account from an invitation link and join the organization in one step. */
export async function signUpWithInvite(input: { token: string; name: string; password: string; userAgent?: string | null }) {
  const invite = await findInvite(input.token);
  if (!invite) throw new HttpError(404, "This invitation is no longer valid. Ask for a new one.");
  const existing = await prisma.user.findUnique({ where: { email: invite.email } });
  if (existing?.passwordHash) throw new HttpError(409, "You already have an account. Sign in to accept the invitation.");
  const problem = passwordProblem(input.password, invite.email);
  if (problem) throw new HttpError(400, problem);
  if (input.name.trim().length < 2) throw new HttpError(400, "Please enter your name.");
  const passwordHash = await hashPassword(input.password);
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { name: input.name.trim(), passwordHash } })
    : await prisma.user.create({ data: { email: invite.email, name: input.name.trim(), passwordHash } });
  await acceptInvite(input.token, user.id);
  return { user, orgId: invite.orgId, ...(await createSession(user.id, invite.orgId, { userAgent: input.userAgent })) };
}

/* ------------------------------------------------------------------------- */
/* Password reset                                                             */
/* ------------------------------------------------------------------------- */

/** Always succeeds from the caller's point of view, so it cannot be used to discover accounts. */
export async function requestPasswordReset(emailInput: string) {
  const email = normalizeEmail(emailInput);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash) return;
  const token = randomToken();
  await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: later(RESET_MINUTES * 60_000) } });
  await sendEmail({
    to: email,
    subject: "Reset your Cloud Price Optimizer password",
    text: `Someone asked to reset the password for ${email}.\n\nChoose a new password: ${appUrl(`/reset-password/${token}`)}\n\nThe link expires in ${RESET_MINUTES} minutes. If it wasn't you, ignore this email.`,
  });
}

export async function resetPassword(token: string, password: string) {
  const reset = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!reset || reset.usedAt || reset.expiresAt < new Date()) throw new HttpError(400, "This reset link is no longer valid. Request a new one.");
  const problem = passwordProblem(password, reset.user.email);
  if (problem) throw new HttpError(400, problem);
  await prisma.user.update({ where: { id: reset.userId }, data: { passwordHash: await hashPassword(password), emailVerifiedAt: reset.user.emailVerifiedAt ?? new Date() } });
  await prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
  // Every existing session ends: whoever had the old password is signed out.
  await prisma.session.deleteMany({ where: { userId: reset.userId } });
  await prisma.authAttempt.deleteMany({ where: { key: `email:${reset.user.email}` } });
}
