import { route } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { activeJobs } from "@/lib/jobs/queue";

/** Work queued or running for the organization (for "syncing…" indicators). */
export const GET = route(async () => {
  const { org } = await getSession();
  return { jobs: await activeJobs(org.id) };
});
