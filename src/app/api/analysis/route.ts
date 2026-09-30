import { route } from "@/lib/api";
import { audit, requirePermission } from "@/lib/auth";
import { runAnalysis } from "@/lib/services/analysis";

export const POST = route(async () => {
  const { org, user } = await requirePermission("analysis:run");
  const result = await runAnalysis(org.id);
  await audit(org.id, user.name, "ran analysis", `${result.recommendations} recommendations`);
  return result;
});
