/**
 * In development the background worker runs inside the Next.js server, so one
 * `npm run dev` is enough. In production run it as its own process
 * (`npm run worker`) and set WORKER_MODE=separate on the web servers.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const mode = process.env.WORKER_MODE ?? (process.env.NODE_ENV === "production" ? "separate" : "inline");
  if (mode !== "inline") return;
  const { startWorker } = await import("./lib/jobs/worker");
  startWorker({ concurrency: 1, label: "inline" });
}
