import { z } from "zod";
import { route } from "@/lib/api";
import { currentUser, HttpError } from "@/lib/auth";
import { switchOrganization } from "@/lib/services/auth";

export const POST = route(async (req: Request) => {
  const s = await currentUser();
  if (!s) throw new HttpError(401, "Please sign in.");
  const { orgId } = z.object({ orgId: z.string() }).parse(await req.json());
  await switchOrganization(s.sessionId, s.user.id, orgId);
  return { next: "/dashboard" };
});
