import { z } from "zod";
import { route } from "@/lib/api";
import { audit, HttpError, requirePermission, ROLES } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { inviteMember, type Role } from "@/lib/services/auth";

const Body = z.object({ email: z.string().email(), role: z.enum(ROLES as [Role, ...Role[]]) });

export const POST = route(async (req: Request) => {
  const { org, user, role } = await requirePermission("org:manage");
  const body = Body.parse(await req.json());
  if (body.role === "owner" && role !== "owner") throw new HttpError(403, "Only owners can invite owners");
  const { invite, token } = await inviteMember({ orgId: org.id, email: body.email, role: body.role, invitedBy: user.name });
  await audit(org.id, user.name, `invited ${body.role}`, invite.email);
  // Without an email provider (local development) the inviter gets the link to pass on.
  const devLink = !process.env.RESEND_API_KEY && process.env.NODE_ENV !== "production" ? `/invite/${token}` : undefined;
  return { invite: { id: invite.id }, devLink };
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
