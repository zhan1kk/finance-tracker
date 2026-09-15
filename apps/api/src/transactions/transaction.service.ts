import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Account, Prisma } from '@prisma/client';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma.service';
import type { TransactionCategory } from '../subcategories/types/subcategory.types';
import { effectOnAccount, signedDelta } from './money';
import { checkOutlier, type OutlierVerdict } from './outlier';
import type {
  BulkUpdateInput,
  CreateTransactionInput,
  ListTransactionsQuery,
  SplitPartInput,
  TransactionType,
  UpdateTransactionInput,
} from './types/transaction.types';

const TRANSACTION_INCLUDE = {
  subcategory: true,
  reimbursements: true,
} as const;

/** Links in one income category before it is treated as a refund category. */
const MIN_LINKS_TO_WATCH = 2;

@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  /**
   * Income that looks like it should reimburse an expense but is not linked to
   * one yet.
   *
   * An unlinked refund is counted as fresh income *and* leaves the expense it
   * repaid at full price, so it overstates both sides at once. There is no
   * field marking a category as "refunds" and there should not be — the name is
   * the user's own, in their own language, so no fixed list could recognise it.
   *
   * Which categories to watch is therefore learned from the links already made:
   * an income category the user has linked before is one where linking is the
   * norm. Measured on the live account, the separation is not subtle — the two
   * reimbursement categories sit at 17 of 20 and 9 of 12 linked, while salary,
   * family transfers and currency exchange are at zero. Two links are required
   * so a single stray one cannot start nagging about a salary.
   */
  async listUnlinkedReimbursements(userId: string) {
    const linkedByCategory = await this.prisma.transaction.groupBy({
      by: ['subcategoryId'],
      where: {
        account: { userId },
        type: 'INCOME',
        parentTransactionId: { not: null },
        subcategoryId: { not: null },
      },
      _count: { _all: true },
    });
    const watched = linkedByCategory
      .filter((row) => row._count._all >= MIN_LINKS_TO_WATCH)
      .map((row) => row.subcategoryId as string);
    if (watched.length === 0) return [];

    return this.prisma.transaction.findMany({
      where: {
        account: { userId },
        type: 'INCOME',
        parentTransactionId: null,
        subcategoryId: { in: watched },
      },
      include: TRANSACTION_INCLUDE,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async listTransactions(userId: string, query: ListTransactionsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.TransactionWhereInput = {
      account: { userId },
      // Filtering by an account includes transfers *into* it (where it is the
      // counter account), not just those it owns — money arriving is a movement
      // on that account and must show for the ledger to reconcile.
      ...(query.accountId
        ? {
            OR: [
              { accountId: query.accountId },
              { type: 'TRANSFER', counterAccountId: query.accountId },
            ],
          }
        : {}),
      // A multi-select list (subcategoryIds) takes precedence over the single id.
      ...(() => {
        const ids = query.subcategoryIds
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids && ids.length > 0) return { subcategoryId: { in: ids } };
        if (query.subcategoryId) return { subcategoryId: query.subcategoryId };
        return {};
      })(),
      type: query.type,
      date: {
        gte: query.from ? new Date(query.from) : undefined,
        lte: query.to ? new Date(query.to) : undefined,
      },
      description: query.search
        ? { contains: query.search, mode: 'insensitive' }
        : undefined,
    };

    // Default stays newest-first. Sorting by amount uses amountBase so rows in
    // different account currencies compare on the same scale; date is the
    // tiebreaker either way, and createdAt keeps paging stable when both match.
    const dir = query.dir ?? (query.sort === 'amount' ? 'desc' : 'desc');
    const orderBy: Prisma.TransactionOrderByWithRelationInput[] =
      query.sort === 'amount'
        ? [{ amountBase: dir }, { date: 'desc' }, { createdAt: 'desc' }]
        : [{ date: dir }, { createdAt: dir }];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        include: TRANSACTION_INCLUDE,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    // A running balance is only meaningful for one account (one currency,
    // one ledger), so it is attached only when the list is scoped to one.
    const withBalance = query.accountId
      ? await this.attachRunningBalance(userId, query.accountId, items)
      : items;

    return { items: withBalance, total, page, pageSize };
  }

  /**
   * Decorates each returned row with the account's balance *after* that
   * transaction, computed over the account's full history (income +, expense −,
   * transfer ± by direction) so it matches a bank statement's running balance
   * for reconciliation — independent of the page or any display filter.
   */
  private async attachRunningBalance<T extends { id: string }>(
    userId: string,
    accountId: string,
    items: T[],
  ): Promise<(T & { runningBalance?: number })[]> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { initialBalance: true },
    });
    if (!account) return items;

    const all = await this.prisma.transaction.findMany({
      where: {
        OR: [{ accountId }, { type: 'TRANSFER', counterAccountId: accountId }],
      },
      select: {
        id: true,
        type: true,
        amount: true,
        accountId: true,
        counterAccountId: true,
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });

    let running = account.initialBalance;
    const balanceById = new Map<string, number>();
    for (const t of all) {
      running += effectOnAccount(t, accountId);
      balanceById.set(t.id, running);
    }

    return items.map((item) => ({
      ...item,
      runningBalance: balanceById.get(item.id),
    }));
  }

  async getTransactionById(userId: string, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
      include: TRANSACTION_INCLUDE,
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    return transaction;
  }

  async createTransaction(userId: string, input: CreateTransactionInput) {
    const account = await this.getOwnAccount(userId, input.accountId);

    if (input.type === 'TRANSFER') {
      return {
        ...(await this.createTransfer(userId, account, input)),
        outlier: null,
      };
    }

    if (input.counterAccountId) {
      throw new BadRequestException(
        'counterAccountId is only allowed for TRANSFER transactions',
      );
    }
    // An internal move (excluded from stats) may skip the category — it is not
    // spending or earnings, just money crossing between your own accounts.
    // Everything else needs a category, validated against the direction.
    if (input.subcategoryId) {
      const subcategory = await this.getOwnSubcategory(
        userId,
        input.subcategoryId,
      );
      this.ensureCategoryMatchesType(input.type, subcategory.category);
    } else if (!input.excludeFromStats) {
      throw new BadRequestException(
        'subcategoryId is required for INCOME and EXPENSE transactions',
      );
    }

    const parentTransactionId = await this.resolveReimbursementParent(
      userId,
      input,
    );

    const date = new Date(input.date);
    const amountBase = await this.fx.convert(
      userId,
      account.currency,
      date,
      input.amount,
    );

    // Judged against history *before* this transaction exists, in base currency
    // so a subcategory used across currencies is compared on one scale. Only
    // meaningful against a category, so internal moves skip it.
    const outlier = input.subcategoryId
      ? await this.outlierVerdict(userId, input, amountBase)
      : null;

    const delta = signedDelta(input.type, input.amount);

    const [transaction, updatedAccount] = await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          type: input.type,
          date,
          amount: input.amount,
          amountBase,
          description: input.description,
          accountId: input.accountId,
          subcategoryId: input.subcategoryId ?? null,
          parentTransactionId,
          excludeFromStats: input.excludeFromStats ?? false,
        },
        include: TRANSACTION_INCLUDE,
      }),
      this.prisma.account.update({
        where: { id: input.accountId },
        data: { balance: { increment: delta } },
      }),
    ]);

    // Negative balances are allowed (credit accounts; deliberate bookkeeping
    // like importing rows that predate the starting balance) — the resulting
    // balance is returned so clients can warn instead of block.
    return { ...transaction, outlier, balanceAfter: updatedAccount.balance };
  }

  /**
   * Non-blocking sanity check: is this amount unusual for its subcategory?
   * Based on the last 50 same-type transactions in that subcategory.
   */
  private async outlierVerdict(
    userId: string,
    input: CreateTransactionInput,
    amountBase: number,
  ): Promise<OutlierVerdict | null> {
    const history = await this.prisma.transaction.findMany({
      where: {
        subcategoryId: input.subcategoryId,
        type: input.type,
        account: { userId },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: { amountBase: true },
    });
    return checkOutlier(
      history.map((t) => t.amountBase),
      amountBase,
    );
  }

  async updateTransaction(
    userId: string,
    id: string,
    input: UpdateTransactionInput,
  ) {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
      include: { subcategory: true, account: { select: { currency: true } } },
    });

    if (!existing) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    if (existing.type === 'TRANSFER') {
      return this.updateTransfer(userId, existing, input);
    }

    let newSubcategory = existing.subcategory;
    if (input.subcategoryId && input.subcategoryId !== existing.subcategoryId) {
      newSubcategory = await this.getOwnSubcategory(
        userId,
        input.subcategoryId,
      );
    }
    if (newSubcategory) {
      this.ensureCategoryMatchesType(existing.type, newSubcategory.category);
    }

    const oldDelta = signedDelta(existing.type, existing.amount);
    const newDelta = signedDelta(
      existing.type,
      input.amount ?? existing.amount,
    );

    // Amount and date both feed the base conversion (date picks the rate).
    const newDate = input.date ? new Date(input.date) : existing.date;
    const newAmount = input.amount ?? existing.amount;
    const amountBase = await this.fx.convert(
      userId,
      existing.account.currency,
      newDate,
      newAmount,
    );

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id },
        data: {
          date: input.date ? new Date(input.date) : undefined,
          amount: input.amount,
          amountBase,
          description: input.description,
          subcategoryId: input.subcategoryId,
          excludeFromStats: input.excludeFromStats,
        },
        include: TRANSACTION_INCLUDE,
      }),
      this.prisma.account.update({
        where: { id: existing.accountId },
        data: { balance: { increment: newDelta - oldDelta } },
      }),
    ]);

    return transaction;
  }

  /**
   * Deletes a transaction and reverses its effect on the account balance.
   *
   * A transaction that came from an import also leaves an ImportRow behind.
   * The FK nulls that row's transactionId, but its status used to stay at
   * COMMITTED forever, so the batch went on claiming a row it no longer had —
   * and undo(), which only looks at rows still holding a transactionId, could
   * never reach it to correct the record. SKIPPED is the honest status: the
   * row is part of the statement and is not in the ledger, which is exactly
   * what "did I import August fully?" needs to be told.
   */
  async deleteTransaction(userId: string, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
      include: { _count: { select: { reimbursements: true } } },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }

    if (transaction._count.reimbursements > 0) {
      throw new ConflictException(
        `Cannot delete transaction: it has ${transaction._count.reimbursements} reimbursement(s). Delete them first.`,
      );
    }

    // Ordered first on purpose: deleting the transaction nulls the row's
    // transactionId through the FK, so a later update would match nothing.
    const releaseImportRow = this.prisma.importRow.updateMany({
      where: { transactionId: id },
      data: { status: 'SKIPPED', transactionId: null },
    });

    if (transaction.type === 'TRANSFER') {
      await this.prisma.$transaction([
        releaseImportRow,
        this.prisma.transaction.delete({ where: { id } }),
        this.prisma.account.update({
          where: { id: transaction.accountId },
          data: { balance: { increment: transaction.amount } },
        }),
        ...(transaction.counterAccountId
          ? [
              this.prisma.account.update({
                where: { id: transaction.counterAccountId },
                data: { balance: { decrement: transaction.amount } },
              }),
            ]
          : []),
      ]);
      return;
    }

    const delta = signedDelta(transaction.type, transaction.amount);
    await this.prisma.$transaction([
      releaseImportRow,
      this.prisma.transaction.delete({ where: { id } }),
      this.prisma.account.update({
        where: { id: transaction.accountId },
        data: { balance: { increment: -delta } },
      }),
    ]);
  }

  /**
   * Splits one INCOME/EXPENSE into several parts that add up to the original,
   * each with its own category — e.g. a supermarket charge that is part
   * Groceries, part Household, or a group bill split into "my share" and a
   * "shared / owed to me" bucket. The first part reuses the original row (so
   * its import link and any reimbursements survive); the rest become siblings
   * on the same account and date. Because the parts sum to the original amount,
   * the account balance is unchanged.
   */
  async splitTransaction(userId: string, id: string, parts: SplitPartInput[]) {
    if (parts.length < 2) {
      throw new BadRequestException('A split needs at least two parts');
    }

    const original = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
      include: { account: { select: { currency: true } } },
    });
    if (!original) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }
    if (original.type === 'TRANSFER') {
      throw new BadRequestException('Transfers cannot be split');
    }

    const sum = parts.reduce((acc, p) => acc + p.amount, 0);
    if (sum !== original.amount) {
      throw new BadRequestException(
        `Split parts must add up to the original amount (${original.amount}); got ${sum}`,
      );
    }

    for (const part of parts) {
      if (part.subcategoryId) {
        const sub = await this.getOwnSubcategory(userId, part.subcategoryId);
        this.ensureCategoryMatchesType(original.type, sub.category);
      } else if (!part.excludeFromStats) {
        throw new BadRequestException(
          'Each split part needs a category, or must be marked internal',
        );
      }
    }

    const type = original.type as TransactionType;
    // amountBase is linear in amount at a fixed date/rate, so re-converting each
    // part keeps the base total equal to the original's.
    const baseFor = (amount: number) =>
      this.fx.convert(userId, original.account.currency, original.date, amount);

    const [head, ...rest] = parts;
    const restCreates = await Promise.all(
      rest.map(async (part) => ({
        amountBase: await baseFor(part.amount),
        part,
      })),
    );

    const results = await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id },
        data: {
          amount: head.amount,
          amountBase: await baseFor(head.amount),
          subcategoryId: head.subcategoryId ?? null,
          description: head.description ?? original.description,
          excludeFromStats: head.excludeFromStats ?? false,
        },
        include: TRANSACTION_INCLUDE,
      }),
      ...restCreates.map(({ amountBase, part }) =>
        this.prisma.transaction.create({
          data: {
            type,
            date: original.date,
            amount: part.amount,
            amountBase,
            description: part.description ?? original.description,
            accountId: original.accountId,
            subcategoryId: part.subcategoryId ?? null,
            excludeFromStats: part.excludeFromStats ?? false,
          },
          include: TRANSACTION_INCLUDE,
        }),
      ),
    ]);

    return results;
  }

  /**
   * Applies one category and/or the internal flag to many INCOME/EXPENSE rows
   * at once — the workhorse for cleaning up a fresh import. Amounts are
   * untouched, so no balance moves. Transfers are rejected (they carry no
   * category), and a category is checked against every row's direction.
   */
  async bulkUpdate(userId: string, ids: string[], patch: BulkUpdateInput) {
    if (ids.length === 0) {
      throw new BadRequestException('No transactions selected');
    }
    if (
      patch.subcategoryId === undefined &&
      patch.excludeFromStats === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }

    const txns = await this.prisma.transaction.findMany({
      where: { id: { in: ids }, account: { userId } },
      select: { id: true, type: true },
    });
    if (txns.length !== ids.length) {
      throw new NotFoundException('One or more transactions were not found');
    }
    if (txns.some((t) => t.type === 'TRANSFER')) {
      throw new BadRequestException(
        'Transfers cannot be categorized or marked internal',
      );
    }

    if (patch.subcategoryId !== undefined) {
      const sub = await this.getOwnSubcategory(userId, patch.subcategoryId);
      for (const t of txns) {
        this.ensureCategoryMatchesType(t.type as TransactionType, sub.category);
      }
    }

    const { count } = await this.prisma.transaction.updateMany({
      where: { id: { in: ids }, account: { userId } },
      data: {
        subcategoryId: patch.subcategoryId,
        excludeFromStats: patch.excludeFromStats,
      },
    });
    return { updated: count };
  }

  /**
   * Deletes several transactions at once, reversing each one's balance effect
   * (both legs for a transfer). Rows that are the parent of a reimbursement are
   * refused as a group, mirroring the single-row guard, so a payback link is
   * never silently orphaned.
   */
  async bulkDelete(userId: string, ids: string[]) {
    if (ids.length === 0) {
      throw new BadRequestException('No transactions selected');
    }

    const txns = await this.prisma.transaction.findMany({
      where: { id: { in: ids }, account: { userId } },
      include: { _count: { select: { reimbursements: true } } },
    });
    if (txns.length !== ids.length) {
      throw new NotFoundException('One or more transactions were not found');
    }
    const blocked = txns.filter((t) => t._count.reimbursements > 0);
    if (blocked.length > 0) {
      throw new ConflictException(
        `${blocked.length} of the selected transaction(s) have reimbursements linked. Delete those paybacks first.`,
      );
    }

    // Net the reversal per account so each account is touched once — undo each
    // transaction's effect on every account it touched.
    const byAccount = new Map<string, number>();
    const add = (accountId: string, delta: number) =>
      byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + delta);
    for (const t of txns) {
      add(t.accountId, -effectOnAccount(t, t.accountId));
      if (t.type === 'TRANSFER' && t.counterAccountId) {
        add(t.counterAccountId, -effectOnAccount(t, t.counterAccountId));
      }
    }

    await this.prisma.$transaction([
      // Same release deleteTransaction does, and for the same reason: the FK
      // nulls the row's transactionId but leaves its status at COMMITTED, so
      // the batch goes on claiming rows that are no longer in the ledger.
      // Ordered first — the delete nulls the link this matches on.
      this.prisma.importRow.updateMany({
        where: { transactionId: { in: ids } },
        data: { status: 'SKIPPED', transactionId: null },
      }),
      this.prisma.transaction.deleteMany({
        where: { id: { in: ids }, account: { userId } },
      }),
      ...[...byAccount.entries()].map(([accountId, delta]) =>
        this.prisma.account.update({
          where: { id: accountId },
          data: { balance: { increment: delta } },
        }),
      ),
    ]);
    return { deleted: txns.length };
  }

  /**
   * Deletes every transaction the user owns and resets each account to its
   * starting balance — which, once all transactions are gone, is exactly what
   * the balance must be. A clean slate before importing real statements.
   * `amountBase` and reimbursement/recurring links vanish with the rows.
   * ImportRow.transactionId is nulled by the schema's ON DELETE SET NULL, but
   * the status is not — so it is released here, as the other delete paths do.
   */
  async deleteAllForUser(userId: string): Promise<{ deleted: number }> {
    return this.prisma.$transaction(async (tx) => {
      // Every row holding a transaction is about to lose it: all of them go.
      await tx.importRow.updateMany({
        where: { batch: { userId }, transactionId: { not: null } },
        data: { status: 'SKIPPED', transactionId: null },
      });
      const { count } = await tx.transaction.deleteMany({
        where: { account: { userId } },
      });
      await tx.$executeRaw`
        UPDATE "Account" SET "balance" = "initialBalance" WHERE "userId" = ${userId}
      `;
      return { deleted: count };
    });
  }

  private async createTransfer(
    userId: string,
    account: Account,
    input: CreateTransactionInput,
  ) {
    if (input.subcategoryId) {
      throw new BadRequestException('Transfers cannot have a subcategory');
    }
    if (input.parentTransactionId) {
      throw new BadRequestException('Transfers cannot be reimbursements');
    }
    if (!input.counterAccountId) {
      throw new BadRequestException(
        'counterAccountId is required for TRANSFER transactions',
      );
    }
    if (input.counterAccountId === input.accountId) {
      throw new BadRequestException('Cannot transfer to the same account');
    }

    const counterAccount = await this.getOwnAccount(
      userId,
      input.counterAccountId,
    );
    if (counterAccount.currency !== account.currency) {
      throw new BadRequestException(
        'A cross-currency move is two different amounts (plus any fee), so it ' +
          "can't be one transfer. Record it as an expense on the source and an " +
          'income on the destination, then link them with "reimburses" — the ' +
          'difference captures the conversion and commission.',
      );
    }

    const date = new Date(input.date);
    const amountBase = await this.fx.convert(
      userId,
      account.currency,
      date,
      input.amount,
    );

    const [transaction, updatedSource] = await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          type: 'TRANSFER',
          date,
          amount: input.amount,
          amountBase,
          description: input.description,
          accountId: input.accountId,
          counterAccountId: input.counterAccountId,
        },
        include: TRANSACTION_INCLUDE,
      }),
      this.prisma.account.update({
        where: { id: input.accountId },
        data: { balance: { decrement: input.amount } },
      }),
      this.prisma.account.update({
        where: { id: input.counterAccountId },
        data: { balance: { increment: input.amount } },
      }),
    ]);

    // The source account is the one that can dip below zero.
    return { ...transaction, balanceAfter: updatedSource.balance };
  }

  private async updateTransfer(
    userId: string,
    existing: {
      id: string;
      amount: number;
      date: Date;
      accountId: string;
      counterAccountId: string | null;
      account: { currency: string };
    },
    input: UpdateTransactionInput,
  ) {
    if (input.subcategoryId) {
      throw new BadRequestException('Transfers cannot have a subcategory');
    }

    const amountDiff = (input.amount ?? existing.amount) - existing.amount;

    const newDate = input.date ? new Date(input.date) : existing.date;
    const newAmount = input.amount ?? existing.amount;
    const amountBase = await this.fx.convert(
      userId,
      existing.account.currency,
      newDate,
      newAmount,
    );

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id: existing.id },
        data: {
          date: input.date ? new Date(input.date) : undefined,
          amount: input.amount,
          amountBase,
          description: input.description,
        },
        include: TRANSACTION_INCLUDE,
      }),
      this.prisma.account.update({
        where: { id: existing.accountId },
        data: { balance: { decrement: amountDiff } },
      }),
      ...(existing.counterAccountId
        ? [
            this.prisma.account.update({
              where: { id: existing.counterAccountId },
              data: { balance: { increment: amountDiff } },
            }),
          ]
        : []),
    ]);

    return transaction;
  }

  /**
   * Links an existing INCOME to the EXPENSE it reimburses (or unlinks, with
   * null) after the fact — the two legs often arrive in separate statements
   * weeks apart, e.g. a peer FX swap where the Kaspi debit and the Revolut
   * credit import at different times. Purely a stats/budget association: the
   * income already moved its account's balance as income, so nothing here
   * touches balances.
   */
  async linkReimbursement(
    userId: string,
    id: string,
    parentTransactionId: string | null,
  ) {
    const income = await this.prisma.transaction.findFirst({
      where: { id, account: { userId } },
    });
    if (!income) {
      throw new NotFoundException(`Transaction with id ${id} was not found`);
    }
    if (income.type !== 'INCOME') {
      throw new BadRequestException(
        'Only INCOME transactions can reimburse an expense',
      );
    }

    if (parentTransactionId) {
      if (parentTransactionId === id) {
        throw new BadRequestException('A transaction cannot reimburse itself');
      }
      const parent = await this.prisma.transaction.findFirst({
        where: { id: parentTransactionId, account: { userId } },
        select: { type: true },
      });
      if (!parent) {
        throw new NotFoundException(
          `Transaction with id ${parentTransactionId} was not found`,
        );
      }
      if (parent.type !== 'EXPENSE') {
        throw new BadRequestException(
          'Reimbursements can only be linked to EXPENSE transactions',
        );
      }
    }

    return this.prisma.transaction.update({
      where: { id },
      data: { parentTransactionId },
      include: TRANSACTION_INCLUDE,
    });
  }

  /** Validates and returns the parent id for a reimbursement, if requested. */
  private async resolveReimbursementParent(
    userId: string,
    input: CreateTransactionInput,
  ): Promise<string | undefined> {
    if (!input.parentTransactionId) {
      return undefined;
    }
    if (input.type !== 'INCOME') {
      throw new BadRequestException(
        'Only INCOME transactions can reimburse an expense',
      );
    }

    const parent = await this.prisma.transaction.findFirst({
      where: { id: input.parentTransactionId, account: { userId } },
    });
    if (!parent) {
      throw new NotFoundException(
        `Transaction with id ${input.parentTransactionId} was not found`,
      );
    }
    if (parent.type !== 'EXPENSE') {
      throw new BadRequestException(
        'Reimbursements can only be linked to EXPENSE transactions',
      );
    }

    return parent.id;
  }

  private async getOwnAccount(userId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
    });
    if (!account) {
      throw new NotFoundException(`Account with id ${accountId} was not found`);
    }
    return account;
  }

  private async getOwnSubcategory(userId: string, subcategoryId: string) {
    const subcategory = await this.prisma.subcategory.findFirst({
      where: { id: subcategoryId, userId },
    });
    if (!subcategory) {
      throw new NotFoundException(
        `Subcategory with id ${subcategoryId} was not found`,
      );
    }
    return subcategory;
  }

  private ensureCategoryMatchesType(
    type: TransactionType,
    category: TransactionCategory,
  ): void {
    if (type === 'INCOME' && category !== 'Income') {
      throw new BadRequestException(
        'INCOME transactions require a subcategory in the Income category',
      );
    }
    if (type === 'EXPENSE' && category === 'Income') {
      throw new BadRequestException(
        'EXPENSE transactions cannot use an Income subcategory',
      );
    }
  }
}
