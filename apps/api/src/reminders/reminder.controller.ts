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
import { CreateReminderDTO } from './dtos/create-reminder.dto';
import { LinkPaymentDTO } from './dtos/link-payment.dto';
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

  /** Add a reminder by hand (subscription/bill). */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateReminderDTO) {
    return this.reminderService.create(user.userId, body);
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

  /** Record the next installment as paid (advances the plan, auto-completes). */
  @Post(':id/paid')
  markPaid(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reminderService.markPaid(user.userId, id);
  }

  /** Settle an "Ask …" reminder by linking the income that paid it back. */
  @Post(':id/link-payment')
  linkPayment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: LinkPaymentDTO,
  ) {
    return this.reminderService.linkPayment(user.userId, id, body.transactionId);
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
