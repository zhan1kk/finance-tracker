import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AccountService } from './account.service';
import { CreateAccountDTO } from './dtos/create-account.dto';
import { UpdateAccountDTO } from './dtos/update-account.dto';

@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  listAccounts() {
    return this.accountService.listAccounts();
  }

  @Get(':id')
  getAccountById(@Param('id') id: string) {
    return this.accountService.getAccountById(id);
  }

  @Post()
  createAccount(@Body() body: CreateAccountDTO) {
    return this.accountService.createAccount(body);
  }

  @Patch(':id')
  updateAccount(@Param('id') id: string, @Body() body: UpdateAccountDTO) {
    return this.accountService.updateAccount(id, body);
  }

  @Delete(':id')
  async deleteAccount(@Param('id') id: string) {
    await this.accountService.deleteAccount(id);
    return { deleted: true };
  }
}
