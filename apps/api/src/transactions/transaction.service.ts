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

  listTransactions(userId: string) {
    return this.prisma.transaction.findMany({
      where: { account: { userId } },
      include: { subcategory: true },
    });
  }

  async getTransactionById(userId: string, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
      include: { subcategory: true },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    return transaction;
  }

  async createTransaction(userId: string, input: CreateTransactionInput) {
    const account = await this.prisma.account.findFirst({
      where: { id: input.accountId, userId },
    });
    if (!account) {
      throw new NotFoundException(
        `Account with id ${input.accountId} was not found`,
      );
    }

    const subcategory = await this.prisma.subcategory.findFirst({
      where: { id: input.subcategoryId, userId },
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

  async updateTransaction(
    userId: string,
    id: string,
    input: UpdateTransactionInput,
  ) {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
      include: { subcategory: true },
    });

    if (!existing) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    let newSubcategory = existing.subcategory;
    if (input.subcategoryId && input.subcategoryId !== existing.subcategoryId) {
      const found = await this.prisma.subcategory.findFirst({
        where: { id: input.subcategoryId, userId },
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

  async deleteTransaction(userId: string, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
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
