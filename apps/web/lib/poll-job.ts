import { api } from "@/lib/api";

type JobResult<T> = {
  id: string;
  status: "running" | "done" | "error";
  result?: T;
  error?: string;
};

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 4 * 60 * 1000;

/**
 * Kicks off a background job (via `start`, which returns a `jobId`), then polls
 * `/jobs/:id` until it finishes — resolving with the job's result or rejecting
 * with its error. Keeps the request non-blocking: the work runs server-side to
 * completion even if this poll is abandoned.
 */
export async function runJob<T>(
  start: () => Promise<{ jobId: string }>,
): Promise<T> {
  const { jobId } = await start();
  return pollJob<T>(jobId);
}

/**
 * Polls a job that is already running — the half `runJob` cannot do, because it
 * only ever holds its id in a local variable. Navigating away discards that,
 * so a page coming back asks `/jobs/running` what is in flight and resumes with
 * the id it gets, instead of showing nothing while the server works on.
 */
export async function pollJob<T>(jobId: string): Promise<T> {
  const maxPolls = Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const job = await api<JobResult<T>>(`/jobs/${jobId}`);
    if (job.status === "done") return job.result as T;
    if (job.status === "error") throw new Error(job.error ?? "The job failed.");
  }
  throw new Error("Timed out waiting for the job to finish.");
}

export type RunningJob = {
  id: string;
  kind: "import" | "pdf-import" | "reminder-scan" | "other";
  label?: string;
  startedAt: string;
};

/** Background work this user has in flight right now. */
export function listRunningJobs(): Promise<RunningJob[]> {
  return api<RunningJob[]>("/jobs/running");
}
