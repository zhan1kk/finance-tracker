import { Injectable } from '@nestjs/common';

type Category = 'Income' | 'Expenses';

export type Transaction = {
  id: number;
  transaction_date: string;
  amount: number;
  subcategory: string;
  category: Category;
  description: string;
};

@Injectable()
export class AppService {
  private nextId = 1;
  private transactions: Transaction[] = [];

  getTransactions(): Transaction[] {
    return this.transactions;
  }
}
