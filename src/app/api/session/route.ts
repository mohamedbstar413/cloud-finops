import { cookies } from "next/headers";
import { z } from "zod";
import { route } from "@/lib/api";
import { getSession, HttpError, SESSION_COOKIE } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** Demo-only: switch the acting user to preview role-based access. */
export const POST = route(async (req: Request) => {
  const { org } = await getSession();
  const { userId } = z.object({ userId: z.string() }).parse(await req.json());
  const m = await prisma.membership.findFirst({ where: { userId, orgId: org.id } });
  if (!m) throw new HttpError(404, "User is not a member of this organization");
  (await cookies()).set(SESSION_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
  return { ok: true };
});
