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
import { BudgetService } from './budget.service';
import { CreateBudgetDTO } from './dtos/create-budget.dto';
import { UpdateBudgetDTO } from './dtos/update-budget.dto';

@Controller('budgets')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.budgetService.list(user.userId);
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

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.budgetService.remove(user.userId, id);
    return { deleted: true };
  }
}
