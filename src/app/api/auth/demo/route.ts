import { route } from "@/lib/api";
import { clientInfo, setSessionCookie } from "@/lib/auth";
import { startDemoSession } from "@/lib/services/auth";

/** Start a short, read-only visit to the demo organization. */
export const POST = route(async () => {
  const { token, expiresAt } = await startDemoSession((await clientInfo()).userAgent);
  await setSessionCookie(token, expiresAt);
  return { next: "/dashboard" };
});
