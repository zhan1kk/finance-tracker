import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  Account,
  CreateAccountInput,
  UpdateAccountInput,
} from './types/account.types';

@Injectable()
export class AccountService {
  private readonly accounts: Account[] = [];

  listAccounts(): Account[] {
    return this.accounts;
  }

  getAccountById(id: string): Account {
    const account = this.accounts.find((item) => item.id === id);

    if (!account) {
      throw new NotFoundException('Account with id ${id} was not found');
    }

    return account;
  }

  createAccount(input: CreateAccountInput): Account {
    const now = new Date().toISOString();
    const account: Account = {
      id: crypto.randomUUID(),
      name: input.name,
      type: input.type,
      currency: input.currency,
      balance: input.initialBalance ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    this.accounts.push(account);
    return account;
  }

  updateAccount(id: string, input: UpdateAccountInput): Account {
    const account = this.getAccountById(id);

    if (input.name !== undefined) {
      account.name = input.name;
    }

    if (input.type !== undefined) {
      account.type = input.type;
    }

    if (input.currency !== undefined) {
      account.currency = input.currency;
    }

    account.updatedAt = new Date().toISOString();
    return account;
  }

  deleteAccount(id: string): void {
    const index = this.accounts.findIndex((item) => item.id === id);

    if (index === -1) {
      throw new NotFoundException(`Account with id ${id} was not found`);
    }

    this.accounts.splice(index, 1);
  }
}
