import { route, type Ctx } from "@/lib/api";
import { getSession, HttpError } from "@/lib/auth";
import { getJob } from "@/lib/jobs/queue";

export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { org } = await getSession();
  const job = await getJob(org.id, (await ctx.params).id);
  if (!job) throw new HttpError(404, "Job not found");
  return { job };
});
