import { z } from "zod";
import { route } from "@/lib/api";
import { currentUser, HttpError } from "@/lib/auth";
import { createOrganization, switchOrganization } from "@/lib/services/auth";

/** Create another organization for the signed-in user and switch to it. */
export const POST = route(async (req: Request) => {
  const s = await currentUser();
  if (!s) throw new HttpError(401, "Please sign in.");
  const { name } = z.object({ name: z.string().max(80) }).parse(await req.json());
  const org = await createOrganization(s.user.id, name);
  await switchOrganization(s.sessionId, s.user.id, org.id);
  return { orgId: org.id, next: "/onboarding" };
});
