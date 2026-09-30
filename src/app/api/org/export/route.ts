import { route } from "@/lib/api";
import { audit, requirePermission } from "@/lib/auth";
import { exportOrganization } from "@/lib/services/org-lifecycle";

/** Everything held about the organization, as one JSON file (credentials excluded). */
export const GET = route(async () => {
  const { org, user } = await requirePermission("org:delete");
  const data = await exportOrganization(org.id);
  await audit(org.id, user.name, "exported organization data");
  const name = org.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "organization";
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}-export-${new Date().toISOString().slice(0, 10)}.json"` },
  });
});
