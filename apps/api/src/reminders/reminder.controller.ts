import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { JobsService } from '../jobs/jobs.service';
import { UpdateReminderDTO } from './dtos/update-reminder.dto';
import { ReminderService } from './reminder.service';

@Controller('reminders')
export class ReminderController {
  constructor(
    private readonly reminderService: ReminderService,
    private readonly jobs: JobsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.reminderService.list(user.userId);
  }

  /**
   * Scan recent transaction descriptions (local Ollama) for upcoming payments.
   * Runs in the background — returns a job id to poll.
   */
  @Post('scan')
  scan(@CurrentUser() user: AuthUser) {
    const jobId = this.jobs.start(user.userId, () =>
      this.reminderService.scan(user.userId),
    );
    return { jobId };
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateReminderDTO,
  ) {
    return this.reminderService.update(user.userId, id, body);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.reminderService.remove(user.userId, id);
    return { deleted: true };
  }
}
