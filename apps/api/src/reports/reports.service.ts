import { Injectable } from '@nestjs/common';
import {
  periodLabelShiftMonths,
  periodOffsetDays,
  recentPeriodLabels,
} from '../common/period';
import { BASE_CURRENCY } from '../fx/fx';
import { PrismaService } from '../prisma.service';

export type NetWorthPoint = { month: string; netWorthCents: number };

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Net worth (sum of all account balances) at the end of each of the last
   * `months` calendar months. Transfers cancel out across accounts, so a month's
   * change is simply that month's income minus expense; the running total is
   * anchored to the sum of account starting balances.
   */
  async netWorth(userId: string, months: number): Promise<NetWorthPoint[]> {
    const { monthStartDay } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { monthStartDay: true },
    });
    const offset = periodOffsetDays(monthStartDay);
    const shift = periodLabelShiftMonths(monthStartDay);

    // Anchor and deltas are both in the base currency so accounts in different
    // currencies add up (initialBalanceBase / amountBase are the converted values).
    const base =
      (
        await this.prisma.account.aggregate({
          _sum: { initialBalanceBase: true },
          where: { userId },
        })
      )._sum.initialBalanceBase ?? 0;

    // Grouped by financial month, matching the dashboard's periods.
    const rows = await this.prisma.$queryRaw<
      { month: string; delta: bigint }[]
    >`
      SELECT to_char(
          date_trunc('month', t."date" - make_interval(days => ${offset}::int))
            + make_interval(months => ${shift}::int),
          'YYYY-MM'
        ) AS month,
        SUM(CASE t."type"
          WHEN 'INCOME' THEN t."amountBase"
          WHEN 'EXPENSE' THEN -t."amountBase"
          ELSE 0 END)::bigint AS delta
      FROM "Transaction" t
      JOIN "Account" a ON a."id" = t."accountId"
      WHERE a."userId" = ${userId}
      GROUP BY 1
    `;
    const deltaByMonth = new Map(rows.map((r) => [r.month, Number(r.delta)]));

    const window = recentPeriodLabels(new Date(), monthStartDay, months);
    const startIndex = monthToIndex(window[0]);

    // Everything before the window folds into the starting running total.
    let running = base;
    for (const [month, delta] of deltaByMonth) {
      if (monthToIndex(month) < startIndex) running += delta;
    }

    const series: NetWorthPoint[] = [];
    for (const month of window) {
      running += deltaByMonth.get(month) ?? 0;
      series.push({ month, netWorthCents: running });
    }
    return series;
  }

  /**
   * Everything the user owns as one JSON document (backup/portability).
   * Read in a single transaction for a consistent snapshot; credentials and
   * Telegram linkage are deliberately excluded.
   */
  async exportJson(userId: string) {
    const [
      user,
      accounts,
      subcategories,
      transactions,
      rules,
      budgets,
      recurring,
    ] = await this.prisma.$transaction([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, baseCurrency: true, createdAt: true },
      }),
      this.prisma.account.findMany({ where: { userId } }),
      this.prisma.subcategory.findMany({ where: { userId } }),
      this.prisma.transaction.findMany({
        where: { account: { userId } },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.categorizationRule.findMany({ where: { userId } }),
      this.prisma.budget.findMany({ where: { userId } }),
      this.prisma.recurringRule.findMany({ where: { userId } }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      user,
      accounts,
      subcategories,
      transactions,
      categorizationRules: rules,
      budgets,
      recurringRules: recurring,
    };
  }

  /** All of the user's transactions as a CSV string (newest first). */
  async exportTransactionsCsv(userId: string): Promise<string> {
    const transactions = await this.prisma.transaction.findMany({
      where: { account: { userId } },
      include: {
        account: { select: { name: true, currency: true } },
        subcategory: { select: { name: true } },
        counterAccount: { select: { name: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    const header = [
      'Date',
      'Account',
      'Type',
      'Category',
      'Description',
      'Currency',
      'Amount',
      `Amount (${BASE_CURRENCY})`,
    ];
    const rows = transactions.map((t) => {
      const sign = t.type === 'INCOME' ? 1 : -1;
      const category =
        t.type === 'TRANSFER'
          ? `Transfer to ${t.counterAccount?.name ?? ''}`
          : (t.subcategory?.name ?? '');
      return [
        t.date.toISOString().slice(0, 10),
        defuse(t.account.name),
        t.type,
        defuse(category),
        defuse(t.description ?? ''),
        t.account.currency,
        ((sign * t.amount) / 100).toFixed(2),
        ((sign * t.amountBase) / 100).toFixed(2),
      ];
    });

    return [header, ...rows].map(toCsvRow).join('\n');
  }
}

/**
 * Neutralizes spreadsheet formula injection in user-controlled text (e.g. an
 * imported bank description of "=HYPERLINK(...)"): a leading formula trigger
 * gets a quote prefix, which spreadsheets render as literal text.
 */
function defuse(field: string): string {
  return /^[=+\-@\t\r]/.test(field) ? `'${field}` : field;
}

function toCsvRow(fields: string[]): string {
  return fields
    .map((field) =>
      /[",\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field,
    )
    .join(',');
}

function monthToIndex(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return year * 12 + (m - 1);
}

