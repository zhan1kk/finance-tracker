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

type CreateTransactionInput = {
  transaction_date: string;
  amount: number;
  subcategory: string;
  category: Category;
  description: string;
};

type UpdateTransactionInput = Partial<CreateTransactionInput>;

@Injectable()
export class AppService {
  private nextId = 1;
  private transactions: Transaction[] = [];

  getTransactions(): Transaction[] {
    return this.transactions;
  }

  createTransaction(input: CreateTransactionInput): Transaction {
    const entry: Transaction = {
      id: this.nextId++,
      transaction_date: input.transaction_date,
      amount: Number(input.amount),
      subcategory: input.subcategory,
      category: input.category,
      description: input.description,
    };

    this.transactions.push(entry);
    return entry;
  }

  updateTransaction(
    id: number,
    input: UpdateTransactionInput,
  ): Transaction | null {
    const entry = this.transactions.find((t) => t.id === id);
    if (!entry) {
      return null;
    }

    if (input.transaction_date !== undefined) {
      entry.transaction_date = input.transaction_date;
    }
    if (input.amount !== undefined) {
      entry.amount = input.amount;
    }
    if (input.subcategory !== undefined) {
      entry.subcategory = input.subcategory;
    }
    if (input.category !== undefined) {
      entry.category = input.category;
    }
    if (input.description !== undefined) {
      entry.description = input.description;
    }

    return entry;
  }

  calculateTotalSpend(entries: Transaction[]): number {
    return entries
      .filter((e) => e.category !== 'Income')
      .reduce((sum, e) => sum + e.amount, 0);
  }

  calculateTotalEarned(entries: Transaction[]): number {
    return entries
      .filter((t) => t.category === 'Income')
      .reduce((sum, e) => sum + e.amount, 0);
  }

  getAnalytics() {
    const totalSpent = this.calculateTotalSpend(this.transactions);
    const totalEarned = this.calculateTotalEarned(this.transactions);

    return {
      totalSpent,
      totalEarned,
      balance: totalEarned - totalSpent,
      transactionCount: this.transactions.length,
    };
  }
}
