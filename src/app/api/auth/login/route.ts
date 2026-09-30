import { z } from "zod";
import { route } from "@/lib/api";
import { clientInfo, setSessionCookie } from "@/lib/auth";
import { signIn } from "@/lib/services/auth";

const Body = z.object({ email: z.string().max(200), password: z.string().max(200) });

export const POST = route(async (req: Request) => {
  const body = Body.parse(await req.json());
  const { token, expiresAt, orgId } = await signIn({ ...body, ...(await clientInfo()) });
  await setSessionCookie(token, expiresAt);
  return { next: orgId ? "/dashboard" : "/welcome" };
});
