import { z } from "zod";
import { route } from "@/lib/api";
import { clientInfo, setSessionCookie } from "@/lib/auth";
import { signUpWithInvite } from "@/lib/services/auth";

export const POST = route(async (req: Request) => {
  const body = z.object({ token: z.string().max(200), name: z.string().max(100), password: z.string().max(200) }).parse(await req.json());
  const { token, expiresAt } = await signUpWithInvite({ ...body, userAgent: (await clientInfo()).userAgent });
  await setSessionCookie(token, expiresAt);
  return { next: "/dashboard" };
});
