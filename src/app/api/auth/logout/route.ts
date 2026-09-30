import { route } from "@/lib/api";
import { clearSessionCookie, sessionToken } from "@/lib/auth";
import { endSession } from "@/lib/services/auth";

export const POST = route(async () => {
  const token = await sessionToken();
  if (token) await endSession(token);
  await clearSessionCookie();
  return { next: "/login" };
});
