import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * What the caller has running right now. Declared before `:id` so "running"
   * is not swallowed as a job id.
   */
  @Get('running')
  running(@CurrentUser() user: AuthUser) {
    return this.jobs.listRunning(user.userId).map((job) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      startedAt: new Date(job.createdAt).toISOString(),
    }));
  }

  /** Poll a background job's status and (once done) its result. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const job = this.jobs.get(user.userId, id);
    return {
      id: job.id,
      status: job.status,
      result: job.result,
      error: job.error,
    };
  }
}
