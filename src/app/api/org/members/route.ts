import { z } from "zod";
import { route } from "@/lib/api";
import { audit, HttpError, requirePermission, ROLES } from "@/lib/auth";
import { prisma } from "@/lib/db";

const Body = z.object({ email: z.string().email(), role: z.enum(ROLES as [string, ...string[]]) });

export const POST = route(async (req: Request) => {
  const { org, user, role } = await requirePermission("org:manage");
  const body = Body.parse(await req.json());
  if (body.role === "owner" && role !== "owner") throw new HttpError(403, "Only owners can invite owners");
  const existing = await prisma.membership.findFirst({ where: { orgId: org.id, user: { email: body.email } } });
  if (existing) throw new HttpError(409, "Already a member");
  const invite = await prisma.invite.create({ data: { orgId: org.id, email: body.email, role: body.role } });
  await audit(org.id, user.name, `invited ${body.role}`, body.email);
  return { invite: { id: invite.id } };
});

export const DELETE = route(async (req: Request) => {
  const { org, user } = await requirePermission("org:manage");
  const id = new URL(req.url).searchParams.get("invite");
  if (!id) throw new HttpError(400, "Missing invite id");
  const inv = await prisma.invite.findFirst({ where: { id, orgId: org.id } });
  if (!inv) throw new HttpError(404, "Invite not found");
  await prisma.invite.delete({ where: { id } });
  await audit(org.id, user.name, "revoked invite", inv.email);
  return { ok: true };
});
