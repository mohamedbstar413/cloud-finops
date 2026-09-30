import { z } from "zod";
import { route } from "@/lib/api";
import { clientInfo, setSessionCookie } from "@/lib/auth";
import { signUp } from "@/lib/services/auth";

const Body = z.object({ name: z.string().max(100), email: z.string().email().max(200), password: z.string().max(200), organization: z.string().max(80) });

export const POST = route(async (req: Request) => {
  const body = Body.parse(await req.json());
  const { userAgent } = await clientInfo();
  const { token, expiresAt, org } = await signUp({ ...body, userAgent });
  await setSessionCookie(token, expiresAt);
  return { orgId: org.id, next: "/onboarding" };
});
