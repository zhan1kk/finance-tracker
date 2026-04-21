import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  Transaction,
  CreateTransactionInput,
  UpdateTransactionInput,
  TransactionCategory,
} from './types/transaction.types';

@Injectable()
export class TransactionService {
  private readonly transactions: Transaction[] = [];
  private subcategoryPairs: Record<string, TransactionCategory> = {
    Salary: 'Income',
    Groceries: 'Expenses',
    Clothes: 'Expenses',
    Rent: 'Bills',
    Insurance: 'Bills',
    YouTube: 'Subscriptions',
    SavingsAccount: 'Savings',
    CreditCardAllowance: 'Debts',
  };

  listTransactions(): Transaction[] {
    return this.transactions;
  }

  getTransactionById(id: string): Transaction {
    const transaction = this.transactions.find((item) => item.id === id);

    if (!transaction) {
      throw new NotFoundException('Transaction was not found');
    }

    return transaction;
  }

  createTransaction(input: CreateTransactionInput): Transaction {
    const now = new Date().toISOString();
    const transaction: Transaction = {
      id: crypto.randomUUID(),
      date: input.date,
      amount: input.amount,
      subcategory: input.subcategory,
      category: input.category,
      description: input.description ?? '',
      createdAt: now,
      updatedAt: now,
    };

    this.transactions.push(transaction);
    return transaction;
  }

  updateTransaction(id: string, input: UpdateTransactionInput): Transaction {
    const transaction = this.getTransactionById(id);
    transaction.updatedAt = new Date().toISOString();

    if (input.date !== undefined) transaction.date = input.date;
    if (input.amount !== undefined) transaction.amount = input.amount;
    if (input.subcategory !== undefined) {
      transaction.subcategory = input.subcategory;
      transaction.category = this.updateCategory(transaction.subcategory);
    }
    if (input.description !== undefined)
      transaction.description = input.description;

    return transaction;
  }

  private updateCategory(subcategory: string): TransactionCategory {
    const capitalized = (value: string) =>
      value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

    const normalizedSubcategory = capitalized(subcategory);
    const category = this.subcategoryPairs[normalizedSubcategory];

    if (!category) {
      throw new NotFoundException(
        `Category mapping was not found for subcategory: ${subcategory}`,
      );
    }

    return category;
  }

  deleteTransaction(id: string): void {
    const index = this.transactions.findIndex((item) => item.id === id);

    if (index === -1) {
      throw new Error(`Transaction with ${id} was not found`);
    }

    this.transactions.splice(index, 1);
  }
}
