import { z } from "zod";
import { route, type Ctx } from "@/lib/api";
import { audit, HttpError, requirePermission, ROLES } from "@/lib/auth";
import { prisma } from "@/lib/db";

const Body = z.object({ role: z.enum(ROLES as [string, ...string[]]) });

async function guardOwners(orgId: string, membershipId: string, nextRole?: string) {
  const m = await prisma.membership.findFirst({ where: { id: membershipId, orgId }, include: { user: true } });
  if (!m) throw new HttpError(404, "Member not found");
  if (m.role === "owner" && nextRole !== "owner") {
    const owners = await prisma.membership.count({ where: { orgId, role: "owner" } });
    if (owners <= 1) throw new HttpError(400, "An organization needs at least one owner");
  }
  return m;
}

export const PATCH = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user, role } = await requirePermission("org:manage");
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  if (body.role === "owner" && role !== "owner") throw new HttpError(403, "Only owners can grant ownership");
  const m = await guardOwners(org.id, id, body.role);
  await prisma.membership.update({ where: { id }, data: { role: body.role } });
  await audit(org.id, user.name, `changed role to ${body.role}`, m.user.name);
  return { ok: true };
});

export const DELETE = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org, user } = await requirePermission("org:manage");
  const { id } = await ctx.params;
  const m = await guardOwners(org.id, id);
  await prisma.membership.delete({ where: { id } });
  await audit(org.id, user.name, "removed member", m.user.name);
  return { ok: true };
});
