"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CategoryBars, MonthlyTrendChart } from "@/components/charts";
import { Card } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import type { Account, MonthlyStat, TransactionStats } from "@/lib/types";

/** "YYYY-MM" for the month `offset` months from now (0 = current). */
function monthKey(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset, 1))
    .toISOString()
    .slice(0, 7);
}

const TREND_MONTHS = 6;

export default function OverviewPage() {
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });

  const monthStart = `${monthKey(0)}-01`;
  const trendStart = `${monthKey(1 - TREND_MONTHS)}-01`;

  const monthStats = useQuery({
    queryKey: ["stats", { from: monthStart }],
    queryFn: () =>
      api<TransactionStats>(`/transactions/stats?from=${monthStart}`),
  });
  const trendStats = useQuery({
    queryKey: ["stats", { from: trendStart }],
    queryFn: () =>
      api<TransactionStats>(`/transactions/stats?from=${trendStart}`),
  });

  const income =
    monthStats.data?.monthly.reduce((sum, m) => sum + m.income, 0) ?? 0;
  const expenses =
    monthStats.data?.monthly.reduce((sum, m) => sum + m.expense, 0) ?? 0;
  const currency = accounts.data?.[0]?.currency ?? "EUR";

  // Fill months with no transactions so the trend always shows 6 columns.
  const trend: MonthlyStat[] = Array.from({ length: TREND_MONTHS }, (_, i) => {
    const month = monthKey(i + 1 - TREND_MONTHS);
    const stat = trendStats.data?.monthly.find((m) => m.month === month);
    return { month, income: stat?.income ?? 0, expense: stat?.expense ?? 0 };
  });

  return (
    <main className="flex flex-col gap-6">
      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          This month
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card>
            <p className="text-sm text-zinc-500">Income</p>
            <p className="text-2xl font-semibold">
              {formatCents(income, currency)}
            </p>
          </Card>
          <Card>
            <p className="text-sm text-zinc-500">Spending</p>
            <p className="text-2xl font-semibold">
              {formatCents(expenses, currency)}
            </p>
          </Card>
          <Card>
            <p className="text-sm text-zinc-500">Net</p>
            <p className="text-2xl font-semibold">
              {formatCents(income - expenses, currency)}
            </p>
          </Card>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-medium">
            Spending by category
            <span className="ml-2 text-sm font-normal text-zinc-500">
              this month
            </span>
          </h2>
          {monthStats.data && (
            <CategoryBars data={monthStats.data.byCategory} currency={currency} />
          )}
        </Card>
        <Card>
          <h2 className="mb-3 font-medium">
            Income vs spending
            <span className="ml-2 text-sm font-normal text-zinc-500">
              last 6 months
            </span>
          </h2>
          {trendStats.data && (
            <MonthlyTrendChart data={trend} currency={currency} />
          )}
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Accounts
        </h2>
        {accounts.data?.length === 0 && (
          <p className="text-sm text-zinc-500">
            No accounts yet —{" "}
            <Link href="/accounts" className="underline">
              create your first one
            </Link>
            .
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.data?.map((account) => (
            <Card key={account.id}>
              <p className="text-sm text-zinc-500">
                {account.name}
                <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">
                  {account.type}
                </span>
              </p>
              <p className="text-xl font-semibold">
                {formatCents(account.balance, account.currency)}
              </p>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
