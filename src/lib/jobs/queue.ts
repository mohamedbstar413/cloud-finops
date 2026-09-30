import { prisma, parseJson } from "../db";

export type JobType = "sync_account" | "analyze" | "delete_org";

export interface JobView {
  id: string;
  type: JobType;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  error: string | null;
  result: unknown;
  createdAt: string;
  finishedAt: string | null;
}

const toView = (j: Awaited<ReturnType<typeof prisma.job.findUniqueOrThrow>>): JobView => ({
  id: j.id,
  type: j.type as JobType,
  status: j.status as JobView["status"],
  attempts: j.attempts,
  error: j.error,
  result: parseJson(j.result, null),
  createdAt: j.createdAt.toISOString(),
  finishedAt: j.finishedAt?.toISOString() ?? null,
});

/**
 * Queue background work for an organization. The same job is not queued twice:
 * if an identical one (same type and payload) is already waiting or running,
 * that one is returned instead.
 */
export async function enqueue(orgId: string, type: JobType, payload: Record<string, unknown> = {}, opts: { requestedBy?: string; runAt?: Date; maxAttempts?: number } = {}) {
  const body = JSON.stringify(payload);
  const existing = await prisma.job.findFirst({ where: { orgId, type, payload: body, status: { in: ["queued", "running"] } } });
  if (existing) return toView(existing);
  const job = await prisma.job.create({
    data: { orgId, type, payload: body, requestedBy: opts.requestedBy ?? "System", runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 3 },
  });
  return toView(job);
}

export async function getJob(orgId: string, id: string) {
  const j = await prisma.job.findFirst({ where: { id, orgId } });
  return j ? toView(j) : null;
}

export async function activeJobs(orgId: string) {
  const jobs = await prisma.job.findMany({ where: { orgId, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "asc" } });
  return jobs.map(toView);
}
