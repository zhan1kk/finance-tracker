import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { BudgetService } from './budget.service';
import { CreateBudgetDTO } from './dtos/create-budget.dto';
import { SetPeriodLimitDTO } from './dtos/set-period-limit.dto';
import { UpdateBudgetDTO } from './dtos/update-budget.dto';

@Controller('budgets')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('period') period?: string) {
    return this.budgetService.list(user.userId, period);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateBudgetDTO) {
    return this.budgetService.create(user.userId, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateBudgetDTO,
  ) {
    return this.budgetService.update(user.userId, id, body);
  }

  /** Delete every budget (all months). Declared before :id so it isn't shadowed. */
  @Delete()
  removeAll(@CurrentUser() user: AuthUser) {
    return this.budgetService.removeAll(user.userId);
  }

  /** Clear one month: revert all overrides for it and delete one-off budgets in it. */
  @Delete('month/:period')
  clearMonth(@CurrentUser() user: AuthUser, @Param('period') period: string) {
    return this.budgetService.clearMonth(user.userId, period);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.budgetService.remove(user.userId, id);
    return { deleted: true };
  }

  /** Set this month's limit for a budget (overrides the recurring limit). */
  @Put(':id/periods/:period')
  setPeriodLimit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('period') period: string,
    @Body() body: SetPeriodLimitDTO,
  ) {
    return this.budgetService.setPeriodLimit(
      user.userId,
      id,
      period,
      body.limit,
    );
  }

  /** Clear this month's override, reverting to the recurring limit. */
  @Delete(':id/periods/:period')
  clearPeriodLimit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('period') period: string,
  ) {
    return this.budgetService.clearPeriodLimit(user.userId, id, period);
  }
}
