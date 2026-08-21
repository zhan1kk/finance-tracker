import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { CreateFriendDTO } from './dtos/create-friend.dto';
import { CreateSettlementDTO } from './dtos/create-settlement.dto';
import { CreateSharedExpenseDTO } from './dtos/create-shared-expense.dto';
import { SplitService } from './split.service';

@Controller('split')
export class SplitController {
  constructor(private readonly split: SplitService) {}

  @Get('friends')
  listFriends(@CurrentUser() user: AuthUser) {
    return this.split.listFriends(user.userId);
  }

  @Post('friends')
  createFriend(@CurrentUser() user: AuthUser, @Body() body: CreateFriendDTO) {
    return this.split.createFriend(user.userId, body);
  }

  @Delete('friends/:id')
  async removeFriend(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.split.removeFriend(user.userId, id);
    return { deleted: true };
  }

  @Get('expenses')
  listExpenses(@CurrentUser() user: AuthUser) {
    return this.split.listExpenses(user.userId);
  }

  @Post('expenses')
  createExpense(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSharedExpenseDTO,
  ) {
    return this.split.createExpense(user.userId, body);
  }

  @Delete('expenses/:id')
  async removeExpense(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.split.removeExpense(user.userId, id);
    return { deleted: true };
  }

  @Get('settlements')
  listSettlements(@CurrentUser() user: AuthUser) {
    return this.split.listSettlements(user.userId);
  }

  @Post('settlements')
  createSettlement(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSettlementDTO,
  ) {
    return this.split.createSettlement(user.userId, body);
  }

  @Delete('settlements/:id')
  async removeSettlement(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.split.removeSettlement(user.userId, id);
    return { deleted: true };
  }

  @Get('balances')
  balances(@CurrentUser() user: AuthUser) {
    return this.split.balances(user.userId);
  }
}
