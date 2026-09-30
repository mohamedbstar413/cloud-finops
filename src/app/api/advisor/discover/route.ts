import { aiEnabled } from "@/lib/ai/client";
import { consume } from "@/lib/billing/limits";
import { route } from "@/lib/api";
import { discoverArchitectures } from "@/lib/ai/advisor";
import { audit, requirePermission } from "@/lib/auth";

export const maxDuration = 180;

export const POST = route(async () => {
  const { org, user } = await requirePermission("ai:use");
  if (aiEnabled()) await consume(org.id, "ai_calls");
  const result = await discoverArchitectures(org.id);
  await audit(org.id, user.name, "ran AI architecture discovery", `${result.created.length} new proposals`);
  return result;
});
