import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type {
  CreateAccountInput,
  UpdateAccountInput,
} from './types/account.types';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  listAccounts(userId: string) {
    return this.prisma.account.findMany({ where: { userId } });
  }

  async getAccountById(userId: string, id: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, userId },
    });

    if (!account) {
      throw new NotFoundException(`Account with id ${id} was not found`);
    }

    return account;
  }

  createAccount(userId: string, input: CreateAccountInput) {
    return this.prisma.account.create({
      data: {
        name: input.name,
        type: input.type,
        currency: input.currency,
        balance: input.initialBalance,
        userId,
      },
    });
  }

  async updateAccount(userId: string, id: string, input: UpdateAccountInput) {
    await this.getAccountById(userId, id);

    // Balance is derived from transactions and is intentionally not updatable.
    return this.prisma.account.update({
      where: { id },
      data: {
        name: input.name,
        type: input.type,
        currency: input.currency,
      },
    });
  }

  async deleteAccount(userId: string, id: string) {
    await this.getAccountById(userId, id);

    const transactionCount = await this.prisma.transaction.count({
      where: { accountId: id },
    });

    if (transactionCount > 0) {
      throw new ConflictException(
        `Cannot delete account: it has ${transactionCount} transaction(s). Delete them first.`,
      );
    }

    await this.prisma.account.delete({ where: { id } });
  }
}
