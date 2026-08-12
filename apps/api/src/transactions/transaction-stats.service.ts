import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { periodLabelShiftMonths, periodOffsetDays } from '../common/period';
import { PrismaService } from '../prisma.service';
import type {
  CategoryStat,
  MonthlyStat,
  StatsQuery,
  TransactionStats,
} from './types/transaction.types';

/**
 * Dashboard aggregates, isolated from the transaction write path because it is
 * all self-contained reporting SQL. Transfers are excluded; reimbursements
 * (INCOME linked to an EXPENSE) reduce expenses rather than count as income.
 */
@Injectable()
export class TransactionStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregates for dashboards, all in cents. Transfers are excluded.
   * Reimbursements (INCOME linked to an EXPENSE) are not counted as income;
   * they reduce expenses instead — monthly in the month received, per-category
   * against the parent expense's subcategory.
   */
  async getStats(userId: string, query: StatsQuery): Promise<TransactionStats> {
    const period = await this.periodExpression(userId);
    const range = [
      ...(query.from ? [Prisma.sql`t."date" >= ${new Date(query.from)}`] : []),
      ...(query.to ? [Prisma.sql`t."date" <= ${new Date(query.to)}`] : []),
    ];
    const scope = (extra: Prisma.Sql) =>
      Prisma.join(
        [
          Prisma.sql`a."userId" = ${userId}`,
          // Internal moves (own-account transfers / currency exchanges) move a
          // balance but are not earnings or spending, so they never count here.
          Prisma.sql`t."excludeFromStats" = false`,
          extra,
          ...range,
        ],
        ' AND ',
      );

    const [monthly, byCategory, incomeByCategory] = await this.prisma.$transaction([
      this.prisma.$queryRaw<MonthlyStat[]>`
        SELECT
          ${period} AS month,
          COALESCE(SUM(t."amountBase") FILTER (
            WHERE t."type" = 'INCOME' AND t."parentTransactionId" IS NULL
          ), 0)::int AS income,
          (COALESCE(SUM(t."amountBase") FILTER (WHERE t."type" = 'EXPENSE'), 0)
           - COALESCE(SUM(t."amountBase") FILTER (
               -- Skip reimbursements of an internal parent: that expense isn't
               -- counted, so netting its payback would leave a phantom credit.
               WHERE t."type" = 'INCOME' AND t."parentTransactionId" IS NOT NULL
                 AND p."excludeFromStats" = false
             ), 0))::int AS expense
        FROM "Transaction" t
        JOIN "Account" a ON a."id" = t."accountId"
        LEFT JOIN "Transaction" p ON p."id" = t."parentTransactionId"
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
          SELECT t."subcategoryId" AS sid, t."amountBase" AS signed
          FROM "Transaction" t
          JOIN "Account" a ON a."id" = t."accountId"
          WHERE ${scope(Prisma.sql`t."type" = 'EXPENSE'`)}
          UNION ALL
          SELECT p."subcategoryId" AS sid, -t."amountBase" AS signed
          FROM "Transaction" t
          JOIN "Account" a ON a."id" = t."accountId"
          JOIN "Transaction" p ON p."id" = t."parentTransactionId"
          WHERE ${scope(
            // Only net a payback against a parent that actually counts — an
            // internal parent is excluded, so its reimbursement must be too.
            Prisma.sql`t."type" = 'INCOME' AND t."parentTransactionId" IS NOT NULL AND p."excludeFromStats" = false`,
          )}
        ) x
        JOIN "Subcategory" s ON s."id" = x.sid
        GROUP BY s."id", s."name", s."category"
        ORDER BY amount DESC
      `,
      // Income by subcategory: real income only (reimbursements, which carry a
      // parent, are money coming back — not earnings — so they are excluded,
      // matching how monthly income is counted).
      this.prisma.$queryRaw<CategoryStat[]>`
        SELECT
          s."id" AS "subcategoryId",
          s."name",
          s."category"::text AS category,
          COALESCE(SUM(t."amountBase"), 0)::int AS amount
        FROM "Transaction" t
        JOIN "Account" a ON a."id" = t."accountId"
        JOIN "Subcategory" s ON s."id" = t."subcategoryId"
        WHERE ${scope(
          Prisma.sql`t."type" = 'INCOME' AND t."parentTransactionId" IS NULL`,
        )}
        GROUP BY s."id", s."name", s."category"
        ORDER BY amount DESC
      `,
    ]);

    return { monthly, byCategory, incomeByCategory };
  }

  /**
   * SQL that labels a transaction's financial month. Shifting the date back by
   * `monthStartDay - 1` days makes the calendar-month truncation land on the
   * right period; the month offset then names it after the month it ends in.
   * With the default start day of 1 this is exactly `date_trunc('month', date)`.
   */
  private async periodExpression(userId: string): Promise<Prisma.Sql> {
    const { monthStartDay } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { monthStartDay: true },
    });
    const offset = periodOffsetDays(monthStartDay);
    const shift = periodLabelShiftMonths(monthStartDay);
    // The ::int casts matter: Prisma binds JS numbers as bigint, and there is no
    // make_interval overload for that.
    return Prisma.sql`to_char(
      date_trunc('month', t."date" - make_interval(days => ${offset}::int))
        + make_interval(months => ${shift}::int),
      'YYYY-MM'
    )`;
  }
}
