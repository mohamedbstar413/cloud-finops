/**
 * Background worker: runs account syncs, analyses, the daily schedule and
 * organization deletions. Run one or more alongside the web servers:
 *   npm run worker            (WORKER_CONCURRENCY jobs at a time, default 2)
 */
import { startWorker } from "../src/lib/jobs/worker";

const worker = startWorker({ label: "worker" });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`[worker] ${signal}: finishing current jobs and stopping`);
    worker.stop();
    setTimeout(() => process.exit(0), 5_000);
  });
}
