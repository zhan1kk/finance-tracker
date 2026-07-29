import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { CreateTransactionDTO } from './dtos/create-transaction.dto';
import { ListTransactionsQueryDTO } from './dtos/list-transactions.query.dto';
import { StatsQueryDTO } from './dtos/stats.query.dto';
import { UpdateTransactionDTO } from './dtos/update-transaction.dto';
import { TransactionService } from './transaction.service';

@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get()
  listTransactions(
    @CurrentUser() user: AuthUser,
    @Query() query: ListTransactionsQueryDTO,
  ) {
    return this.transactionService.listTransactions(user.userId, query);
  }

  // Must be declared before @Get(':id') so 'stats' is not captured as an id.
  @Get('stats')
  getStats(@CurrentUser() user: AuthUser, @Query() query: StatsQueryDTO) {
    return this.transactionService.getStats(user.userId, query);
  }

  @Get(':id')
  getTransactionById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactionService.getTransactionById(user.userId, id);
  }

  @Post()
  createTransaction(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateTransactionDTO,
  ) {
    return this.transactionService.createTransaction(user.userId, body);
  }

  @Patch(':id')
  updateTransaction(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateTransactionDTO,
  ) {
    return this.transactionService.updateTransaction(user.userId, id, body);
  }

  // Declared before @Delete(':id') so the bare path is not read as an id.
  @Delete()
  deleteAll(@CurrentUser() user: AuthUser) {
    return this.transactionService.deleteAllForUser(user.userId);
  }

  @Delete(':id')
  async deleteTransaction(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.transactionService.deleteTransaction(user.userId, id);
    return { deleted: true };
  }
}
