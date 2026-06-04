import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
} from '@nestjs/common';
import { CreateTransactionDTO } from './dtos/create-transaction.dto';
import { TransactionService } from './transaction.service';

@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get()
  listTransactions() {
    return this.transactionService.listTransactions();
  }

  @Get(':id')
  getTransactionById(@Param('id') id: string) {
    return this.transactionService.getTransactionById(id);
  }

  @Post()
  createTransaction(@Body() body: CreateTransactionDTO) {
    return this.transactionService.createTransaction(body);
  }

  @Patch(':id')
  updateTransaction(
    @Param('id') id: string,
    @Body() body: Partial<CreateTransactionDTO>,
  ) {
    return this.transactionService.updateTransaction(id, body);
  }

  @Delete(':id')
  async deleteTransaction(@Param('id') id: string) {
    await this.transactionService.deleteTransaction(id);
    return { deleted: true };
  }
}
