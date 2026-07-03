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

  listAccounts() {
    return this.prisma.account.findMany();
  }

  async getAccountById(id: string) {
    const account = await this.prisma.account.findUnique({ where: { id } });

    if (!account) {
      throw new NotFoundException(`Account with id ${id} was not found`);
    }

    return account;
  }

  createAccount(input: CreateAccountInput) {
    return this.prisma.account.create({
      data: {
        name: input.name,
        type: input.type,
        currency: input.currency,
        balance: input.initialBalance,
      },
    });
  }

  async updateAccount(id: string, input: UpdateAccountInput) {
    await this.getAccountById(id);

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

  async deleteAccount(id: string) {
    await this.getAccountById(id);

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
