"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ClientJob, Spinner } from "./client-ui";

const LABEL: Record<string, string> = { sync_account: "Syncing cloud accounts", analyze: "Analysing your estate", delete_org: "Deleting organization data" };

/**
 * A slim notice while syncs or analyses run in the background. When the last
 * one finishes, the page refreshes so new numbers appear without a reload.
 */
export function JobsBanner({ initial }: { initial: ClientJob[] }) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const had = useRef(initial.length > 0);

  const poll = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      const r = await api<{ jobs: ClientJob[] }>("/api/jobs");
      setJobs(r.jobs);
      if (r.jobs.length) {
        had.current = true;
        timer.current = setTimeout(poll, 2500);
      } else if (had.current) {
        had.current = false;
        router.refresh();
      }
    } catch {
      timer.current = setTimeout(poll, 10_000);
    }
  }, [router]);

  useEffect(() => {
    if (initial.length) timer.current = setTimeout(poll, 2500);
    const onNew = () => void poll();
    window.addEventListener("cpo:jobs", onNew);
    return () => {
      window.removeEventListener("cpo:jobs", onNew);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [initial.length, poll]);

  if (!jobs.length) return null;
  const running = jobs.find((j) => j.status === "running") ?? jobs[0];
  return (
    <div role="status" className="mb-5 flex items-center gap-2.5 rounded-lg border border-blue-100 bg-blue-50/70 px-3.5 py-2 text-[12.5px] text-blue-900">
      <Spinner />
      <span>
        <b className="font-medium">{LABEL[running.type] ?? "Working"}…</b> {jobs.length > 1 ? `${jobs.length} steps left. ` : ""}Numbers on this page update when it finishes.
      </span>
    </div>
  );
}
