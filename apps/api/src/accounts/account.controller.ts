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
import { AccountService } from './account.service';
import { CreateAccountDTO } from './dtos/create-account.dto';
import { UpdateAccountDTO } from './dtos/update-account.dto';

@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  listAccounts(@CurrentUser() user: AuthUser) {
    return this.accountService.listAccounts(user.userId);
  }

  @Get(':id')
  getAccountById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accountService.getAccountById(user.userId, id);
  }

  @Post()
  createAccount(@CurrentUser() user: AuthUser, @Body() body: CreateAccountDTO) {
    return this.accountService.createAccount(user.userId, body);
  }

  @Patch(':id')
  updateAccount(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateAccountDTO,
  ) {
    return this.accountService.updateAccount(user.userId, id, body);
  }

  @Delete(':id')
  async deleteAccount(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.accountService.deleteAccount(user.userId, id);
    return { deleted: true };
  }
}
