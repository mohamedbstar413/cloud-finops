import { cookies } from "next/headers";
import { prisma } from "./db";

/**
 * Session & RBAC. The demo resolves the current user from a cookie (switchable
 * on the Organization page). Swap `getSession` for Auth.js / Clerk / WorkOS in
 * production — everything else only depends on { user, org, role }.
 */

export type Role = "owner" | "admin" | "member" | "viewer";

export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

export const PERMISSIONS = {
  "recommendation:act": ["owner", "admin", "member"],
  "analysis:run": ["owner", "admin", "member"],
  "ai:use": ["owner", "admin", "member"],
  "account:manage": ["owner", "admin"],
  "org:manage": ["owner", "admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const SESSION_COOKIE = "cpo_uid";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function can(role: string, perm: Permission) {
  return (PERMISSIONS[perm] as readonly string[]).includes(role);
}

export async function getSession() {
  const uid = (await cookies()).get(SESSION_COOKIE)?.value;
  let membership = uid
    ? await prisma.membership.findFirst({ where: { userId: uid }, include: { user: true, org: true } })
    : null;
  membership ??= await prisma.membership.findFirst({
    where: { role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { user: true, org: true },
  });
  if (!membership) throw new HttpError(401, "No organization found — run `npm run setup` to seed demo data.");
  return { user: membership.user, org: membership.org, role: membership.role as Role };
}

export async function requirePermission(perm: Permission) {
  const session = await getSession();
  if (!can(session.role, perm)) {
    throw new HttpError(403, `Your role (${session.role}) cannot perform this action.`);
  }
  return session;
}

export async function audit(orgId: string, actor: string, action: string, target?: string) {
  await prisma.auditLog.create({ data: { orgId, actor, action, target } });
}
