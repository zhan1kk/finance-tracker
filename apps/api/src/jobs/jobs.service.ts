import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'done' | 'error';

/** What the job is doing, so a page can reattach only to its own kind of work. */
export type JobKind = 'import' | 'pdf-import' | 'reminder-scan' | 'other';

export type Job = {
  id: string;
  userId: string;
  kind: JobKind;
  /** Shown while it runs, e.g. the statement's filename. */
  label?: string;
  status: JobStatus;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

// Finished jobs are kept this long so a client has time to poll the result.
const TTL_MS = 60 * 60 * 1000;

/**
 * A tiny in-memory job registry for long, one-off background work (LLM
 * extraction) so the HTTP request returns immediately with an id to poll
 * instead of holding the connection open for a minute.
 *
 * In-memory on purpose: fine for a single API instance (personal use), and the
 * work runs to completion server-side even if the client navigates away. A
 * multi-instance / must-survive-restart deployment would swap this for a shared,
 * durable store (e.g. BullMQ + Redis) — the same public shape.
 */
@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, Job>();

  /** Starts `work` in the background; returns a job id to poll immediately. */
  start(
    userId: string,
    work: () => Promise<unknown>,
    meta: { kind?: JobKind; label?: string } = {},
  ): string {
    const id = randomUUID();
    const now = Date.now();
    this.jobs.set(id, {
      id,
      userId,
      kind: meta.kind ?? 'other',
      label: meta.label,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    // Detached: capture the outcome onto the job. `Promise.resolve().then(work)`
    // funnels a synchronous throw into the rejection path too.
    void Promise.resolve()
      .then(work)
      .then(
        (result) => this.settle(id, 'done', result, undefined),
        (err: unknown) =>
          this.settle(
            id,
            'error',
            undefined,
            err instanceof Error ? err.message : String(err),
          ),
      );
    this.sweep();
    return id;
  }

  /**
   * The caller's jobs that are still running, oldest first.
   *
   * Without this a job was only reachable by an id the browser held in memory,
   * so navigating away lost it: the work ran on to completion server-side, but
   * nothing on the page could tell it was still going. A page reattaches by
   * asking what is running rather than by remembering.
   */
  listRunning(userId: string): Job[] {
    return [...this.jobs.values()]
      .filter((job) => job.userId === userId && job.status === 'running')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The caller's own job, or 404 — never another user's. */
  get(userId: string, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId) {
      throw new NotFoundException(`Job with id ${id} was not found`);
    }
    return job;
  }

  private settle(
    id: string,
    status: JobStatus,
    result: unknown,
    error: string | undefined,
  ): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    job.result = result;
    job.error = error;
    job.updatedAt = Date.now();
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && job.updatedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}
