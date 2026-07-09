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
import { CreateRecurringDTO } from './dtos/create-recurring.dto';
import { UpdateRecurringDTO } from './dtos/update-recurring.dto';
import { RecurringService } from './recurring.service';

@Controller('recurring')
export class RecurringController {
  constructor(private readonly recurringService: RecurringService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.recurringService.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateRecurringDTO) {
    return this.recurringService.create(user.userId, body);
  }

  /** Manually post any occurrences due now (also runs daily via cron). */
  @Post('run')
  run(@CurrentUser() user: AuthUser) {
    return this.recurringService.runDue(new Date(), user.userId);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateRecurringDTO,
  ) {
    return this.recurringService.update(user.userId, id, body);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.recurringService.remove(user.userId, id);
    return { deleted: true };
  }
}
