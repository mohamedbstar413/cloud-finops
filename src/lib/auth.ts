import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { HttpError } from "./auth-errors";
import { prisma } from "./db";
import { resolveSession, type Role } from "./services/auth";

/**
 * Request-level authentication and RBAC. The session cookie carries a random
 * token (only its hash is stored); everything else only depends on
 * { user, org, role }.
 */

export { HttpError };
export type { Role };

export { can, PERMISSIONS, ROLES, type Permission } from "./auth-permissions";
import { can, type Permission } from "./auth-permissions";

export const SESSION_COOKIE = "cpo_session";

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: expiresAt });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export const sessionToken = async () => (await cookies()).get(SESSION_COOKIE)?.value ?? null;

/** Client details for rate limiting and the session list. */
export async function clientInfo() {
  const h = await headers();
  return { client: h.get("x-forwarded-for")?.split(",")[0].trim() ?? h.get("x-real-ip") ?? "local", userAgent: h.get("user-agent") };
}

/** The signed-in user, whether or not they are in an organization yet. */
export async function currentUser() {
  const token = await sessionToken();
  return token ? resolveSession(token) : null;
}

/** Signed in and working in an organization (API routes: 401 otherwise). */
export async function getSession() {
  const s = await currentUser();
  if (!s) throw new HttpError(401, "Please sign in.");
  if (!s.org || !s.role) throw new HttpError(409, "Choose or create an organization first.");
  return { user: s.user, org: s.org, role: s.role, sessionId: s.sessionId };
}

/** Same as getSession for pages: redirects to sign-in (or to organization setup) instead of failing. */
export async function pageSession() {
  const s = await currentUser();
  if (!s) redirect("/login");
  if (!s.org || !s.role) redirect("/welcome");
  return { user: s.user, org: s.org, role: s.role, sessionId: s.sessionId };
}

export async function requirePermission(perm: Permission) {
  const session = await getSession();
  if (!can(session.role, perm)) {
    throw new HttpError(403, session.org.isDemo ? "This is a read-only demo. Create a free account to try it on your own clouds." : `Your role (${session.role}) cannot perform this action.`);
  }
  return session;
}

export async function audit(orgId: string, actor: string, action: string, target?: string) {
  await prisma.auditLog.create({ data: { orgId, actor, action, target } });
}
