import { z } from "zod";
import { route } from "@/lib/api";
import { resetPassword } from "@/lib/services/auth";

export const POST = route(async (req: Request) => {
  const { token, password } = z.object({ token: z.string().max(200), password: z.string().max(200) }).parse(await req.json());
  await resetPassword(token, password);
  return { next: "/login?reset=1" };
});
