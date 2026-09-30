import { z } from "zod";
import { route } from "@/lib/api";
import { requestPasswordReset } from "@/lib/services/auth";

export const POST = route(async (req: Request) => {
  const { email } = z.object({ email: z.string().max(200) }).parse(await req.json());
  await requestPasswordReset(email);
  // Same answer whether or not the address has an account.
  return { ok: true };
});
