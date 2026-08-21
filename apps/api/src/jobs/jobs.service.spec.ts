import { NotFoundException } from '@nestjs/common';
import { JobsService } from './jobs.service';

// Flush the microtask/timer queue so a detached job settles.
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('JobsService', () => {
  let jobs: JobsService;

  beforeEach(() => {
    jobs = new JobsService();
  });

  it('runs work in the background and exposes its result', async () => {
    const id = jobs.start('u1', () => Promise.resolve({ ok: 42 }));
    // Synchronously after start it is still running.
    expect(jobs.get('u1', id).status).toBe('running');

    await tick();
    const done = jobs.get('u1', id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ ok: 42 });
    expect(done.error).toBeUndefined();
  });

  it('captures a rejected job as an error with its message', async () => {
    const id = jobs.start('u1', () => Promise.reject(new Error('boom')));
    await tick();
    const job = jobs.get('u1', id);
    expect(job.status).toBe('error');
    expect(job.error).toBe('boom');
  });

  it("never returns another user's job, or an unknown id", () => {
    const id = jobs.start('u1', () => Promise.resolve(1));
    expect(() => jobs.get('u2', id)).toThrow(NotFoundException);
    expect(() => jobs.get('u1', 'no-such-id')).toThrow(NotFoundException);
  });
});
