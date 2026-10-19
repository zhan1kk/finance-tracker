import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma.service';
import type {
  BalanceIntegrityEntry,
  CreateAccountInput,
  UpdateAccountInput,
} from './types/account.types';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  listAccounts(userId: string) {
    // Pinned first (then stable by creation) so every list surfaces the
    // important accounts at the top.
    return this.prisma.account.findMany({
      where: { userId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'asc' }],
    });
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

  async createAccount(userId: string, input: CreateAccountInput) {
    // A currency with no rate would convert 1:1 and freeze a wrong net-worth
    // anchor, so make sure one exists (fetching it if needed) before pricing.
    await this.fx.ensureRate(userId, input.currency);
    const initialBalance = input.initialBalance ?? 0;
    // Freeze the opening balance's base-currency value at today's rate; it is
    // the net-worth anchor and is not re-derived from transactions.
    const initialBalanceBase = await this.fx.convert(
      userId,
      input.currency,
      new Date(),
      initialBalance,
    );
    return this.prisma.account.create({
      data: {
        name: input.name,
        type: input.type,
        currency: input.currency,
        balance: initialBalance,
        initialBalance,
        initialBalanceBase,
        countInNetWorth: input.countInNetWorth ?? true,
        userId,
      },
    });
  }

  async updateAccount(userId: string, id: string, input: UpdateAccountInput) {
    const existing = await this.getAccountById(userId, id);

    if (input.currency && input.currency !== existing.currency) {
      // Amounts are not converted, so past transactions (and same-currency
      // transfers) would silently change meaning.
      const transactionCount = await this.prisma.transaction.count({
        where: { OR: [{ accountId: id }, { counterAccountId: id }] },
      });
      if (transactionCount > 0) {
        throw new ConflictException(
          `Cannot change currency: account is referenced by ${transactionCount} transaction(s).`,
        );
      }
    }

    // Correcting the starting balance shifts the derived balance by the same
    // difference, so every transaction since day one keeps its effect.
    const initialDelta =
      input.initialBalance !== undefined
        ? input.initialBalance - existing.initialBalance
        : 0;

    // Re-anchor the opening balance's base-currency value when either input
    // changes: a currency change (only allowed with no transactions) or a new
    // starting balance, both frozen at today's rate like on create.
    const currency = input.currency ?? existing.currency;
    const rebase =
      input.initialBalance !== undefined ||
      (input.currency !== undefined && input.currency !== existing.currency);
    const initialBalanceBase = rebase
      ? await this.fx.convert(
          userId,
          currency,
          new Date(),
          input.initialBalance ?? existing.initialBalance,
        )
      : undefined;

    // Balance is never set directly — only shifted alongside its anchor.
    return this.prisma.account.update({
      where: { id },
      data: {
        name: input.name,
        type: input.type,
        currency: input.currency,
        initialBalance: input.initialBalance,
        initialBalanceBase,
        countInNetWorth: input.countInNetWorth,
        pinned: input.pinned,
        balance: initialDelta !== 0 ? { increment: initialDelta } : undefined,
      },
    });
  }

  async deleteAccount(userId: string, id: string) {
    await this.getAccountById(userId, id);

    // Includes transfers into this account (counterAccountId), which would
    // otherwise silently lose their destination.
    const transactionCount = await this.prisma.transaction.count({
      where: { OR: [{ accountId: id }, { counterAccountId: id }] },
    });

    if (transactionCount > 0) {
      throw new ConflictException(
        `Cannot delete account: it is referenced by ${transactionCount} transaction(s). Delete them first.`,
      );
    }

    // Recurring rules and import batches also reference the account (with no
    // transactions yet), which would otherwise fail as a raw FK error.
    const [recurringCount, importCount, pendingRowCount, reminderCount] =
      await Promise.all([
        this.prisma.recurringRule.count({ where: { accountId: id } }),
        this.prisma.importBatch.count({ where: { accountId: id } }),
        // Rows in a batch still under review that were marked as transfers into
        // this account. The FK is SetNull, so deleting the account would quietly
        // strip the destination — and a row marked a transfer carries no
        // subcategory, so it would commit as uncategorised income or spending
        // rather than as the move it was marked to be.
        this.prisma.importRow.count({
          where: {
            counterAccountId: id,
            batch: { userId, status: 'PENDING_REVIEW' },
          },
        }),
        // Reminder.accountId is SetNull too. A reminder is scoped to an account
        // precisely to tell two same-category reminders apart — two gym
        // memberships, two phone bills — so silently unscoping one puts it back
        // to settling against whichever payment it sees first. Blocked rather
        // than cascaded: unlike a categorization rule, the reminder is still
        // wanted after the account goes, just not scoped this way.
        // Deleted reminders are invisible and must not block the delete.
        this.prisma.reminder.count({
          where: { userId, accountId: id, deletedAt: null },
        }),
      ]);
    if (recurringCount > 0) {
      throw new ConflictException(
        `Cannot delete account: it has ${recurringCount} recurring rule(s). Delete them first.`,
      );
    }
    if (importCount > 0) {
      throw new ConflictException(
        `Cannot delete account: it has ${importCount} import batch(es). Delete them first.`,
      );
    }
    if (pendingRowCount > 0) {
      throw new ConflictException(
        `Cannot delete account: ${pendingRowCount} row(s) waiting in an import review are marked as transfers into it. Finish or discard that review first.`,
      );
    }
    if (reminderCount > 0) {
      throw new ConflictException(
        `Cannot delete account: ${reminderCount} reminder(s) are scoped to it. Point them at another account or delete them first.`,
      );
    }

    // Categorization rules naming this account as a transfer destination are
    // deliberately not guarded here: they cascade. Unlike the references
    // above, such a rule means nothing once the account is gone, and it is
    // rebuilt from one corrected row on the next import — so blocking the
    // delete over it would cost more than losing it does.
    await this.prisma.account.delete({ where: { id } });
  }

  /**
   * Safety net: recomputes each account's balance from initialBalance plus the
   * signed sum of its transactions and reports any drift from the stored value.
   */
  async checkBalanceIntegrity(
    userId: string,
  ): Promise<BalanceIntegrityEntry[]> {
    const accounts = await this.prisma.account.findMany({ where: { userId } });

    return Promise.all(
      accounts.map(async (account) => {
        const [byType, incoming] = await Promise.all([
          this.prisma.transaction.groupBy({
            by: ['type'],
            where: { accountId: account.id },
            _sum: { amount: true },
          }),
          this.prisma.transaction.aggregate({
            where: { counterAccountId: account.id },
            _sum: { amount: true },
          }),
        ]);

        const sumOf = (type: string) =>
          byType.find((g) => g.type === type)?._sum.amount ?? 0;

        const expectedBalance =
          account.initialBalance +
          sumOf('INCOME') -
          sumOf('EXPENSE') -
          sumOf('TRANSFER') +
          (incoming._sum.amount ?? 0);

        return {
          accountId: account.id,
          name: account.name,
          storedBalance: account.balance,
          expectedBalance,
          drift: account.balance - expectedBalance,
        };
      }),
    );
  }

  /** Applies the recomputed balances wherever they drifted. */
  async repairBalances(userId: string): Promise<BalanceIntegrityEntry[]> {
    const report = await this.checkBalanceIntegrity(userId);
    const drifted = report.filter((entry) => entry.drift !== 0);

    await this.prisma.$transaction(
      drifted.map((entry) =>
        this.prisma.account.update({
          where: { id: entry.accountId },
          data: { balance: entry.expectedBalance },
        }),
      ),
    );

    return drifted;
  }
}
