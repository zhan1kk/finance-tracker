import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { TransactionCategory } from '../subcategories/types/subcategory.types';
import type {
  CreateTransactionInput,
  UpdateTransactionInput,
} from './types/transaction.types';

@Injectable()
export class TransactionService {
  constructor(private readonly prisma: PrismaService) {}

  listTransactions() {
    return this.prisma.transaction.findMany({ include: { subcategory: true } });
  }

  async getTransactionById(id: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
      include: { subcategory: true },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    return transaction;
  }

  async createTransaction(input: CreateTransactionInput) {
    const subcategory = await this.prisma.subcategory.findUnique({
      where: { id: input.subcategoryId },
    });

    if (!subcategory) {
      throw new NotFoundException(
        `Subcategory with id ${input.subcategoryId} was not found`,
      );
    }

    const delta = this.getBalanceDelta(subcategory.category, input.amount);

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          date: new Date(input.date),
          amount: input.amount,
          description: input.description,
          accountId: input.accountId,
          subcategoryId: input.subcategoryId,
        },
        include: { subcategory: true },
      }),
      this.prisma.account.update({
        where: { id: input.accountId },
        data: { balance: { increment: delta } },
      }),
    ]);

    return transaction;
  }

  async updateTransaction(id: string, input: UpdateTransactionInput) {
    const existing = await this.prisma.transaction.findUnique({
      where: { id },
      include: { subcategory: true },
    });

    if (!existing) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    let newSubcategory = existing.subcategory;
    if (input.subcategoryId && input.subcategoryId !== existing.subcategoryId) {
      const found = await this.prisma.subcategory.findUnique({
        where: { id: input.subcategoryId },
      });
      if (!found) {
        throw new NotFoundException(
          `Subcategory with id ${input.subcategoryId} was not found`,
        );
      }
      newSubcategory = found;
    }

    const oldDelta = this.getBalanceDelta(
      existing.subcategory.category,
      existing.amount,
    );
    const newDelta = this.getBalanceDelta(
      newSubcategory.category,
      input.amount ?? existing.amount,
    );
    const netDelta = newDelta - oldDelta;

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id },
        data: {
          date: input.date ? new Date(input.date) : undefined,
          amount: input.amount,
          description: input.description,
          subcategoryId: input.subcategoryId,
        },
        include: { subcategory: true },
      }),
      this.prisma.account.update({
        where: { id: existing.accountId },
        data: { balance: { increment: netDelta } },
      }),
    ]);

    return transaction;
  }

  async deleteTransaction(id: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
      include: { subcategory: true },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    const delta = this.getBalanceDelta(
      transaction.subcategory.category,
      transaction.amount,
    );

    await this.prisma.$transaction([
      this.prisma.transaction.delete({ where: { id } }),
      this.prisma.account.update({
        where: { id: transaction.accountId },
        data: { balance: { increment: -delta } },
      }),
    ]);
  }

  private getBalanceDelta(
    category: TransactionCategory,
    amount: number,
  ): number {
    switch (category) {
      case 'Income':
        return amount;
      case 'Expenses':
      case 'Bills':
      case 'Subscriptions':
        return -amount;
      case 'Debts':
      case 'Savings':
        return 0;
    }
  }
}
