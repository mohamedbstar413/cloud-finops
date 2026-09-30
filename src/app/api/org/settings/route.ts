import { route } from "@/lib/api";
import { audit, HttpError, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { nextRunAt } from "@/lib/jobs/scheduler";
import { mergeSettings, OrgSettings, parseSettings } from "@/lib/settings";

/** Update one or more settings sections; the result is validated as a whole. */
export const PATCH = route(async (req: Request) => {
  const { org, user } = await requirePermission("org:manage");
  const patch = await req.json();
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "Expected an object of settings sections");
  const unknown = Object.keys(patch).filter((k) => !(k in OrgSettings.shape));
  if (unknown.length) throw new HttpError(400, `Unknown settings: ${unknown.join(", ")}`);
  const next = mergeSettings(parseSettings(org.settings), patch);
  await prisma.organization.update({
    where: { id: org.id },
    // A new sync hour takes effect from the next occurrence.
    data: { settings: JSON.stringify(next), ...("sync" in patch ? { nextSyncAt: nextRunAt(next.sync.hourUtc) } : {}) },
  });
  await audit(org.id, user.name, "changed settings", Object.keys(patch).join(", "));
  return { settings: next };
});
