"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  CategoryBars,
  MonthlyTrendChart,
  NetWorthChart,
} from "@/components/charts";
import { Button, Card } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCents } from "@/lib/format";
import {
  formatPeriod,
  periodOf,
  periodRange,
  shiftPeriod,
} from "@/lib/period";
import type {
  Account,
  MonthlyStat,
  NetWorthPoint,
  TransactionStats,
} from "@/lib/types";

const TREND_MONTHS = 6;

export default function OverviewPage() {
  const { user } = useAuth();
  const monthStartDay = user?.monthStartDay ?? 1;
  const currentPeriod = periodOf(new Date(), monthStartDay);
  const [period, setPeriod] = useState<string | null>(null);
  const shown = period ?? currentPeriod;

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });

  // Ask for exactly the selected period, and a window ending with it for the trend.
  const selected = periodRange(shown, monthStartDay);
  const trendFrom = periodRange(
    shiftPeriod(shown, 1 - TREND_MONTHS),
    monthStartDay,
  ).from;

  const monthStats = useQuery({
    queryKey: ["stats", selected],
    queryFn: () =>
      api<TransactionStats>(
        `/transactions/stats?from=${selected.from}&to=${selected.to}`,
      ),
  });
  const trendStats = useQuery({
    queryKey: ["stats", { from: trendFrom, to: selected.to }],
    queryFn: () =>
      api<TransactionStats>(
        `/transactions/stats?from=${trendFrom}&to=${selected.to}`,
      ),
  });
  const netWorth = useQuery({
    queryKey: ["stats", "net-worth"],
    queryFn: () => api<NetWorthPoint[]>("/reports/net-worth?months=12"),
  });

  const income =
    monthStats.data?.monthly.reduce((sum, m) => sum + m.income, 0) ?? 0;
  const expenses =
    monthStats.data?.monthly.reduce((sum, m) => sum + m.expense, 0) ?? 0;
  // All cross-account aggregates are converted to the base currency server-side,
  // so they are always formatted in it (not any single account's currency).
  const currency = user?.baseCurrency ?? "EUR";

  // Fill periods with no transactions so the trend always shows 6 columns.
  const trend: MonthlyStat[] = Array.from({ length: TREND_MONTHS }, (_, i) => {
    const month = shiftPeriod(shown, i + 1 - TREND_MONTHS);
    const stat = trendStats.data?.monthly.find((m) => m.month === month);
    return { month, income: stat?.income ?? 0, expense: stat?.expense ?? 0 };
  });

  return (
    <main className="flex flex-col gap-6">
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            aria-label="Previous month"
            onClick={() => setPeriod(shiftPeriod(shown, -1))}
          >
            ‹
          </Button>
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            {formatPeriod(shown, monthStartDay)}
          </h2>
          <Button
            variant="ghost"
            aria-label="Next month"
            onClick={() => setPeriod(shiftPeriod(shown, 1))}
          >
            ›
          </Button>
          {shown !== currentPeriod && (
            <Button variant="ghost" onClick={() => setPeriod(null)}>
              Today
            </Button>
          )}
        </div>
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
              {formatPeriod(shown, monthStartDay)}
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
        <Card className="lg:col-span-2">
          <h2 className="mb-3 font-medium">
            Net worth
            <span className="ml-2 text-sm font-normal text-zinc-500">
              last 12 months
            </span>
          </h2>
          {netWorth.data && (
            <NetWorthChart data={netWorth.data} currency={currency} />
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
