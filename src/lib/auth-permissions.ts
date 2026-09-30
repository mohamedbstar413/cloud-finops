import type { Role } from "./services/auth";

/** Role-based access control: which roles may do what. */
export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

export const PERMISSIONS = {
  "recommendation:act": ["owner", "admin", "member"],
  "analysis:run": ["owner", "admin", "member"],
  "ai:use": ["owner", "admin", "member"],
  "account:manage": ["owner", "admin"],
  "org:manage": ["owner", "admin"],
  "billing:manage": ["owner"],
  "org:delete": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: string, perm: Permission) {
  return (PERMISSIONS[perm] as readonly string[]).includes(role);
}
