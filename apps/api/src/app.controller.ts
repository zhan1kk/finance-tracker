import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('transactions')
  getTransactions() {
    return this.appService.getTransactions();
  }

  @Post('transactions')
  createTransaction(
    @Body()
    body: {
      transactionDate: string;
      amount: number;
      subcategory: string;
      category:
        | 'Income'
        | 'Expenses'
        | 'Bills'
        | 'Debts'
        | 'Savings'
        | 'Subscriptions';
      description: string;
    },
  ) {
    return this.appService.createTransaction(body);
  }

  @Patch('transactions/:id')
  updateTransaction(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: Partial<{
      transactionDate: string;
      amount: number;
      subcategory: string;
      category:
        | 'Income'
        | 'Expenses'
        | 'Bills'
        | 'Debts'
        | 'Savings'
        | 'Subscriptions';
      description: string;
    }>,
  ) {
    const updated = this.appService.updateTransaction(id, body);
    if (!updated) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    return updated;
  }

  @Get('analytics/summary')
  getAnalyticsSummary() {
    return this.appService.getAnalyticsSummary();
  }
}
