import { route } from "@/lib/api";
import { audit, requirePermission } from "@/lib/auth";
import { enqueue } from "@/lib/jobs/queue";

/** Re-analyse the organization in the background; the client follows the returned job. */
export const POST = route(async () => {
  const { org, user } = await requirePermission("analysis:run");
  const job = await enqueue(org.id, "analyze", {}, { requestedBy: user.name });
  await audit(org.id, user.name, "requested analysis");
  return { job };
});
