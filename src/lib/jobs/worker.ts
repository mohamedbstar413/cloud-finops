import { hostname } from "node:os";
import { prisma } from "../db";
import { runJob } from "./handlers";
import { scheduleDueSyncs } from "./scheduler";

/**
 * A small database-backed job runner (no extra infrastructure). Guarantees:
 *  - a job is run by one worker at a time (claimed with a conditional update);
 *  - an organization runs one job at a time, in the order its jobs were queued,
 *    so a large customer cannot starve the others and an analysis always runs
 *    after the syncs queued before it;
 *  - failures are retried with exponential backoff, then marked failed;
 *  - jobs left "running" by a crashed worker are picked up again.
 */

const STALE_MS = 20 * 60_000;
const BACKOFF_MS = 30_000;

type Claimed = Awaited<ReturnType<typeof prisma.job.findFirstOrThrow>>;

export async function claimNext(workerId: string, now = new Date()): Promise<Claimed | null> {
  const busy = new Set((await prisma.job.findMany({ where: { status: "running" }, select: { orgId: true } })).map((j) => j.orgId));
  const queued = await prisma.job.findMany({ where: { status: "queued", runAt: { lte: now } }, orderBy: [{ createdAt: "asc" }], take: 50 });
  const firstPerOrg = new Map<string, Claimed>();
  for (const j of queued) if (!busy.has(j.orgId) && !firstPerOrg.has(j.orgId)) firstPerOrg.set(j.orgId, j);
  for (const job of firstPerOrg.values()) {
    // An org whose earliest waiting job is delayed (retry backoff) must still run its jobs in order.
    const earlier = await prisma.job.count({ where: { orgId: job.orgId, status: "queued", createdAt: { lt: job.createdAt } } });
    if (earlier) continue;
    const { count } = await prisma.job.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "running", lockedBy: workerId, lockedAt: now, startedAt: now, attempts: { increment: 1 } },
    });
    if (count !== 1) continue; // another worker took it
    // Two workers can claim jobs of the same organization at the same instant: the later one steps back.
    const rivals = await prisma.job.count({ where: { orgId: job.orgId, status: "running", id: { not: job.id }, lockedAt: { lte: now } } });
    if (rivals) {
      await prisma.job.update({ where: { id: job.id }, data: { status: "queued", lockedBy: null, lockedAt: null, startedAt: null, attempts: { decrement: 1 } } });
      continue;
    }
    return { ...job, status: "running", attempts: job.attempts + 1 };
  }
  return null;
}

export async function recoverStale(now = new Date()) {
  const stale = await prisma.job.findMany({ where: { status: "running", lockedAt: { lt: new Date(now.getTime() - STALE_MS) } } });
  for (const j of stale) {
    const again = j.attempts < j.maxAttempts;
    await prisma.job.update({
      where: { id: j.id },
      data: again ? { status: "queued", lockedBy: null, lockedAt: null, runAt: now } : { status: "failed", finishedAt: now, error: "The worker stopped while running this job" },
    });
  }
  return stale.length;
}

/** Run one job end to end. Returns false when there was nothing to do. */
export async function workOnce(workerId: string): Promise<boolean> {
  const job = await claimNext(workerId);
  if (!job) return false;
  // updateMany, not update: a job can remove its own row (deleting an organization cascades to its jobs).
  try {
    const result = await runJob(job);
    await prisma.job.updateMany({ where: { id: job.id }, data: { status: "succeeded", finishedAt: new Date(), error: null, result: JSON.stringify(result ?? null) } });
  } catch (e) {
    const message = ((e as Error).message ?? String(e)).slice(0, 500);
    const retry = job.attempts < job.maxAttempts;
    await prisma.job.updateMany({
      where: { id: job.id },
      data: retry
        ? { status: "queued", lockedBy: null, lockedAt: null, error: message, runAt: new Date(Date.now() + BACKOFF_MS * 2 ** (job.attempts - 1)) }
        : { status: "failed", finishedAt: new Date(), error: message },
    });
  }
  return true;
}

declare global {
  // eslint-disable-next-line no-var
  var __cpoWorker: { stop: () => void } | undefined;
}

/** Start polling loops (one per unit of concurrency) plus the scheduler. Idempotent per process. */
export function startWorker(opts: { concurrency?: number; pollMs?: number; label?: string } = {}) {
  if (globalThis.__cpoWorker) return globalThis.__cpoWorker;
  const concurrency = Math.max(1, opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 2));
  const pollMs = opts.pollMs ?? 1500;
  const id = `${hostname()}:${process.pid}:${opts.label ?? "worker"}`;
  let stopped = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const loop = async (n: number) => {
    while (!stopped) {
      try {
        if (!(await workOnce(`${id}#${n}`))) await sleep(pollMs);
      } catch (e) {
        console.error("[worker]", e);
        await sleep(pollMs * 4);
      }
    }
  };
  const scheduler = async () => {
    while (!stopped) {
      try {
        await recoverStale();
        await scheduleDueSyncs();
      } catch (e) {
        console.error("[scheduler]", e);
      }
      await sleep(60_000);
    }
  };
  for (let n = 0; n < concurrency; n++) void loop(n);
  void scheduler();
  console.info(`[worker] ${id} started (${concurrency} concurrent jobs)`);
  globalThis.__cpoWorker = { stop: () => (stopped = true) };
  return globalThis.__cpoWorker;
}
