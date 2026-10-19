import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { CreateFriendDTO } from './dtos/create-friend.dto';
import { CreateSettlementDTO } from './dtos/create-settlement.dto';
import { CreateSharedExpenseDTO } from './dtos/create-shared-expense.dto';
import {
  AddGroupMemberDTO,
  CreateSplitGroupDTO,
  MoveToGroupDTO,
  RenameSplitGroupDTO,
  SplitScopeQuery,
} from './dtos/split-group.dto';
import { parseScope } from './split-balances';
import { SplitGroupsService } from './split-groups.service';
import { SplitService } from './split.service';

@Controller('split')
export class SplitController {
  constructor(
    private readonly split: SplitService,
    private readonly groups: SplitGroupsService,
  ) {}

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

  // ---- groups ----

  @Get('groups')
  listGroups(@CurrentUser() user: AuthUser) {
    return this.groups.list(user.userId);
  }

  @Get('groups/:id')
  getGroup(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.groups.get(user.userId, id);
  }

  @Post('groups')
  createGroup(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSplitGroupDTO,
  ) {
    return this.groups.create(user.userId, body);
  }

  @Patch('groups/:id')
  renameGroup(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: RenameSplitGroupDTO,
  ) {
    return this.groups.rename(user.userId, id, body.name);
  }

  @Delete('groups/:id')
  async removeGroup(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.groups.remove(user.userId, id);
    return { deleted: true };
  }

  @Post('groups/:id/members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: AddGroupMemberDTO,
  ) {
    return this.groups.addMember(user.userId, id, body.friendId);
  }

  @Delete('groups/:id/members/:friendId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('friendId') friendId: string,
  ) {
    return this.groups.removeMember(user.userId, id, friendId);
  }

  // ---- expenses & settlements (?group=<id>|none narrows them) ----

  @Get('expenses')
  listExpenses(@CurrentUser() user: AuthUser, @Query() q: SplitScopeQuery) {
    return this.split.listExpenses(user.userId, parseScope(q.group));
  }

  @Post('expenses')
  createExpense(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSharedExpenseDTO,
  ) {
    return this.split.createExpense(user.userId, body);
  }

  @Patch('expenses/:id')
  moveExpense(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: MoveToGroupDTO,
  ) {
    return this.split.moveExpense(user.userId, id, body.groupId);
  }

  @Delete('expenses/:id')
  async removeExpense(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.split.removeExpense(user.userId, id);
    return { deleted: true };
  }

  @Get('settlements')
  listSettlements(@CurrentUser() user: AuthUser, @Query() q: SplitScopeQuery) {
    return this.split.listSettlements(user.userId, parseScope(q.group));
  }

  @Post('settlements')
  createSettlement(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSettlementDTO,
  ) {
    return this.split.createSettlement(user.userId, body);
  }

  @Patch('settlements/:id')
  moveSettlement(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: MoveToGroupDTO,
  ) {
    return this.split.moveSettlement(user.userId, id, body.groupId);
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
  balances(@CurrentUser() user: AuthUser, @Query() q: SplitScopeQuery) {
    return this.split.balances(user.userId, parseScope(q.group));
  }
}
