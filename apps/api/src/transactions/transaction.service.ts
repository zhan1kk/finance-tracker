import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Account, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { TransactionCategory } from '../subcategories/types/subcategory.types';
import type {
  CategoryStat,
  CreateTransactionInput,
  ListTransactionsQuery,
  MonthlyStat,
  StatsQuery,
  TransactionStats,
  TransactionType,
  UpdateTransactionInput,
} from './types/transaction.types';

const TRANSACTION_INCLUDE = {
  subcategory: true,
  reimbursements: true,
} as const;

@Injectable()
export class TransactionService {
  constructor(private readonly prisma: PrismaService) {}

  async listTransactions(userId: string, query: ListTransactionsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.TransactionWhereInput = {
      account: { userId },
      accountId: query.accountId,
      subcategoryId: query.subcategoryId,
      type: query.type,
      date: {
        gte: query.from ? new Date(query.from) : undefined,
        lte: query.to ? new Date(query.to) : undefined,
      },
      description: query.search
        ? { contains: query.search, mode: 'insensitive' }
        : undefined,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        include: TRANSACTION_INCLUDE,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Aggregates for dashboards, all in cents. Transfers are excluded.
   * Reimbursements (INCOME linked to an EXPENSE) are not counted as income;
   * they reduce expenses instead — monthly in the month received, per-category
   * against the parent expense's subcategory.
   */
  async getStats(userId: string, query: StatsQuery): Promise<TransactionStats> {
    const range = [
      ...(query.from ? [Prisma.sql`t."date" >= ${new Date(query.from)}`] : []),
      ...(query.to ? [Prisma.sql`t."date" <= ${new Date(query.to)}`] : []),
    ];
    const scope = (extra: Prisma.Sql) =>
      Prisma.join(
        [Prisma.sql`a."userId" = ${userId}`, extra, ...range],
        ' AND ',
      );

    const [monthly, byCategory] = await this.prisma.$transaction([
      this.prisma.$queryRaw<MonthlyStat[]>`
        SELECT
          to_char(date_trunc('month', t."date"), 'YYYY-MM') AS month,
          COALESCE(SUM(t."amount") FILTER (
            WHERE t."type" = 'INCOME' AND t."parentTransactionId" IS NULL
          ), 0)::int AS income,
          (COALESCE(SUM(t."amount") FILTER (WHERE t."type" = 'EXPENSE'), 0)
           - COALESCE(SUM(t."amount") FILTER (
               WHERE t."type" = 'INCOME' AND t."parentTransactionId" IS NOT NULL
             ), 0))::int AS expense
        FROM "Transaction" t
        JOIN "Account" a ON a."id" = t."accountId"
        WHERE ${scope(Prisma.sql`t."type" <> 'TRANSFER'`)}
        GROUP BY 1
        ORDER BY 1
      `,
      this.prisma.$queryRaw<CategoryStat[]>`
        SELECT
          s."id" AS "subcategoryId",
          s."name",
          s."category"::text AS category,
          SUM(x.signed)::int AS amount
        FROM (
          SELECT t."subcategoryId" AS sid, t."amount" AS signed
          FROM "Transaction" t
          JOIN "Account" a ON a."id" = t."accountId"
          WHERE ${scope(Prisma.sql`t."type" = 'EXPENSE'`)}
          UNION ALL
          SELECT p."subcategoryId" AS sid, -t."amount" AS signed
          FROM "Transaction" t
          JOIN "Account" a ON a."id" = t."accountId"
          JOIN "Transaction" p ON p."id" = t."parentTransactionId"
          WHERE ${scope(
            Prisma.sql`t."type" = 'INCOME' AND t."parentTransactionId" IS NOT NULL`,
          )}
        ) x
        JOIN "Subcategory" s ON s."id" = x.sid
        GROUP BY s."id", s."name", s."category"
        ORDER BY amount DESC
      `,
    ]);

    return { monthly, byCategory };
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
      return this.createTransfer(userId, account, input);
    }

    if (input.counterAccountId) {
      throw new BadRequestException(
        'counterAccountId is only allowed for TRANSFER transactions',
      );
    }
    if (!input.subcategoryId) {
      throw new BadRequestException(
        'subcategoryId is required for INCOME and EXPENSE transactions',
      );
    }

    const subcategory = await this.getOwnSubcategory(
      userId,
      input.subcategoryId,
    );
    this.ensureCategoryMatchesType(input.type, subcategory.category);

    const parentTransactionId = await this.resolveReimbursementParent(
      userId,
      input,
    );

    const delta = this.signedDelta(input.type, input.amount);

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          type: input.type,
          date: new Date(input.date),
          amount: input.amount,
          description: input.description,
          accountId: input.accountId,
          subcategoryId: input.subcategoryId,
          parentTransactionId,
        },
        include: TRANSACTION_INCLUDE,
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

    if (existing.type === 'TRANSFER') {
      return this.updateTransfer(existing, input);
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

    const oldDelta = this.signedDelta(existing.type, existing.amount);
    const newDelta = this.signedDelta(
      existing.type,
      input.amount ?? existing.amount,
    );

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id },
        data: {
          date: input.date ? new Date(input.date) : undefined,
          amount: input.amount,
          description: input.description,
          subcategoryId: input.subcategoryId,
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

    if (transaction.type === 'TRANSFER') {
      await this.prisma.$transaction([
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

    const delta = this.signedDelta(transaction.type, transaction.amount);
    await this.prisma.$transaction([
      this.prisma.transaction.delete({ where: { id } }),
      this.prisma.account.update({
        where: { id: transaction.accountId },
        data: { balance: { increment: -delta } },
      }),
    ]);
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
        'Transfers between accounts with different currencies are not supported yet',
      );
    }

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          type: 'TRANSFER',
          date: new Date(input.date),
          amount: input.amount,
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

    return transaction;
  }

  private async updateTransfer(
    existing: {
      id: string;
      amount: number;
      accountId: string;
      counterAccountId: string | null;
    },
    input: UpdateTransactionInput,
  ) {
    if (input.subcategoryId) {
      throw new BadRequestException('Transfers cannot have a subcategory');
    }

    const amountDiff = (input.amount ?? existing.amount) - existing.amount;

    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id: existing.id },
        data: {
          date: input.date ? new Date(input.date) : undefined,
          amount: input.amount,
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

  private signedDelta(type: TransactionType, amount: number): number {
    return type === 'INCOME' ? amount : -amount;
  }
}
