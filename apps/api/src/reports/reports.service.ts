import { Injectable } from '@nestjs/common';
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
    const base =
      (
        await this.prisma.account.aggregate({
          _sum: { initialBalance: true },
          where: { userId },
        })
      )._sum.initialBalance ?? 0;

    const rows = await this.prisma.$queryRaw<
      { month: string; delta: bigint }[]
    >`
      SELECT to_char(date_trunc('month', t."date"), 'YYYY-MM') AS month,
        SUM(CASE t."type"
          WHEN 'INCOME' THEN t."amount"
          WHEN 'EXPENSE' THEN -t."amount"
          ELSE 0 END)::bigint AS delta
      FROM "Transaction" t
      JOIN "Account" a ON a."id" = t."accountId"
      WHERE a."userId" = ${userId}
      GROUP BY 1
    `;
    const deltaByMonth = new Map(rows.map((r) => [r.month, Number(r.delta)]));

    const now = new Date();
    const currentIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
    const startIndex = currentIndex - (months - 1);

    // Everything before the window folds into the starting running total.
    let running = base;
    for (const [month, delta] of deltaByMonth) {
      if (monthToIndex(month) < startIndex) running += delta;
    }

    const series: NetWorthPoint[] = [];
    for (let index = startIndex; index <= currentIndex; index++) {
      running += deltaByMonth.get(indexToMonth(index)) ?? 0;
      series.push({ month: indexToMonth(index), netWorthCents: running });
    }
    return series;
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
    ];
    const rows = transactions.map((t) => {
      const signed = t.type === 'INCOME' ? t.amount : -t.amount;
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
        (signed / 100).toFixed(2),
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

function indexToMonth(index: number): string {
  const year = Math.floor(index / 12);
  const month = index % 12;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}
