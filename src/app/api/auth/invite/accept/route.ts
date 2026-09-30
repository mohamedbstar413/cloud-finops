import { z } from "zod";
import { route } from "@/lib/api";
import { currentUser, HttpError } from "@/lib/auth";
import { acceptInvite, switchOrganization } from "@/lib/services/auth";

/** Accept an invitation as the signed-in user, and switch to that organization. */
export const POST = route(async (req: Request) => {
  const s = await currentUser();
  if (!s) throw new HttpError(401, "Please sign in.");
  const { token } = z.object({ token: z.string().max(200) }).parse(await req.json());
  const invite = await acceptInvite(token, s.user.id);
  await switchOrganization(s.sessionId, s.user.id, invite.orgId);
  return { next: "/dashboard" };
});
