"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  CategoryDonut,
  MonthlyTrendChart,
  NetWorthChart,
} from "@/components/charts";
import { Button, Card } from "@/components/ui";
import { TYPE_ACCENT, TYPE_BADGE } from "@/lib/account-style";
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
  Reminder,
  TransactionList,
  TransactionStats,
} from "@/lib/types";

const TREND_MONTHS = 6;

// Order the breakdown filter chips predictably (income first, then spend types).
const BREAKDOWN_CATEGORIES = [
  "Income",
  "Expenses",
  "Bills",
  "Subscriptions",
  "Debts",
  "Savings",
] as const;

export default function OverviewPage() {
  const { user, updateProfile } = useAuth();
  const monthStartDay = user?.monthStartDay ?? 1;
  const currentPeriod = periodOf(new Date(), monthStartDay);
  const [period, setPeriod] = useState<string | null>(null);
  const shown = period ?? currentPeriod;

  // Changing the day the financial month starts re-periods every stat; snap the
  // view back to the current month so the label still matches what's shown.
  const changeMonthStart = async (day: number) => {
    await updateProfile({ monthStartDay: day });
    setPeriod(null);
  };

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });

  // A cheap "has this user ever recorded anything?" probe (total only) that
  // drives the onboarding prompt once at least one account exists.
  const anyTx = useQuery({
    queryKey: ["transactions", { probe: true }],
    queryFn: () => api<TransactionList>("/transactions?pageSize=1"),
    enabled: (accounts.data?.length ?? 0) > 0,
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
  const reminders = useQuery({
    queryKey: ["reminders"],
    queryFn: () => api<Reminder[]>("/reminders"),
  });
  const upcoming = (reminders.data ?? []).filter((r) => !r.done).slice(0, 4);

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

  const noAccounts = accounts.data?.length === 0;
  const noTransactions =
    !noAccounts && anyTx.data !== undefined && anyTx.data.total === 0;

  // First run: skip the empty dashboard and walk the user through setup.
  if (noAccounts) {
    return (
      <main className="flex flex-col gap-6">
        <Onboarding step={1} />
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      {noTransactions && <Onboarding step={2} />}
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
          <label
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500"
            title="The day your financial month begins — e.g. 28 runs the 28th to the 27th. 1 = plain calendar months. Short months just end on their last day."
          >
            Month starts
            <select
              value={monthStartDay}
              onChange={(e) => void changeMonthStart(Number(e.target.value))}
              className="rounded border border-zinc-200 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-800"
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1st (calendar)" : `${d}`}
                </option>
              ))}
            </select>
          </label>
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
            <CategoryDonut
              data={monthStats.data.byCategory}
              currency={currency}
            />
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

      {monthStats.data && (
        <FullBreakdown
          stats={monthStats.data}
          currency={currency}
          monthLabel={formatPeriod(shown, monthStartDay)}
        />
      )}

      {upcoming.length > 0 && (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-medium">Upcoming</h2>
            <Link href="/reminders" className="text-sm text-zinc-500 underline">
              All reminders
            </Link>
          </div>
          <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
            {upcoming.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-2 py-1.5 text-sm"
              >
                <span className="font-medium">{r.label}</span>
                {r.cadence && (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {r.cadence}
                  </span>
                )}
                <span className="text-zinc-500">
                  next ·{" "}
                  {r.dueDate
                    ? new Date(r.dueDate).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                      })
                    : "no date"}
                </span>
                {r.amountCents != null && (
                  <span className="ml-auto tabular-nums text-zinc-500">
                    {formatCents(r.amountCents, r.currency ?? currency)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

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
            <Card
              key={account.id}
              className={`border-l-4 ${TYPE_ACCENT[account.type]}`}
            >
              <p className="text-sm text-zinc-500">
                {account.name}
                <span
                  className={`ml-2 rounded px-1.5 py-0.5 text-xs ${TYPE_BADGE[account.type]}`}
                >
                  {account.type}
                </span>
                {!account.countInNetWorth && (
                  <span className="ml-1.5 text-xs text-zinc-400">
                    not in net worth
                  </span>
                )}
              </p>
              <p
                className={`text-xl font-semibold tabular-nums ${
                  account.balance < 0 && account.type !== "credit"
                    ? "text-red-600"
                    : ""
                }`}
              >
                {formatCents(account.balance, account.currency)}
              </p>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}

const PRIMARY_LINK =
  "inline-block rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const GHOST_LINK =
  "inline-block rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

/**
 * First-run guide. Step 1 (no accounts) replaces the empty dashboard; step 2
 * (accounts, but nothing recorded yet) sits above it as a nudge. Keeps a new
 * user from landing on a wall of empty charts.
 */
function Onboarding({ step }: { step: 1 | 2 }) {
  const steps = [
    {
      title: "Create an account",
      body: "Add a bank account, card, or cash wallet to track.",
      done: step > 1,
    },
    {
      title: "Add your transactions",
      body: "Import a statement (CSV or PDF), or type a few in by hand.",
      done: false,
    },
    {
      title: "Make it yours",
      body: "Set monthly budgets, bill reminders, and your financial month.",
      done: false,
    },
  ];
  const current = step === 1 ? 0 : 1;

  return (
    <Card>
      <h2 className="text-lg font-semibold">
        {step === 1 ? "Welcome 👋 Let's get you set up" : "You're almost set"}
      </h2>
      <p className="mt-1 text-sm text-zinc-500">
        {step === 1
          ? "Three quick steps and your dashboard fills itself in."
          : "Add some transactions and the charts below come to life."}
      </p>
      <ol className="mt-4 flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                s.done
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                  : i === current
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
              }`}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <div className="flex-1">
              <p className="font-medium">{s.title}</p>
              <p className="text-sm text-zinc-500">{s.body}</p>
              {i === current && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {i === 0 ? (
                    <Link href="/accounts" className={PRIMARY_LINK}>
                      Add an account
                    </Link>
                  ) : (
                    <>
                      <Link href="/imports" className={PRIMARY_LINK}>
                        Import a statement
                      </Link>
                      <Link href="/transactions" className={GHOST_LINK}>
                        Add manually
                      </Link>
                    </>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * A collapsed, full picture of the month: every subcategory with income and
 * spending, filterable by category type. Complements the spending-only bars.
 */
function FullBreakdown({
  stats,
  currency,
  monthLabel,
}: {
  stats: TransactionStats;
  currency: string;
  monthLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<string>("All");

  const rows = [
    ...stats.incomeByCategory.map((r) => ({ ...r, kind: "income" as const })),
    ...stats.byCategory.map((r) => ({ ...r, kind: "expense" as const })),
  ];
  // Only offer chips for categories that actually have rows this month.
  const present = BREAKDOWN_CATEGORIES.filter((c) =>
    rows.some((r) => r.category === c),
  );
  const shown = filter === "All" ? rows : rows.filter((r) => r.category === filter);

  const income = shown
    .filter((r) => r.kind === "income")
    .reduce((sum, r) => sum + r.amount, 0);
  const expense = shown
    .filter((r) => r.kind === "expense")
    .reduce((sum, r) => sum + r.amount, 0);
  const total = filter === "All" ? income - expense : filter === "Income" ? income : expense;
  const totalLabel =
    filter === "All"
      ? "Net (income − spending)"
      : filter === "Income"
        ? "Total income"
        : `${filter} spending`;

  return (
    <section>
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-medium">
            Full breakdown
            <span className="ml-2 text-sm font-normal text-zinc-500">
              {monthLabel}
            </span>
          </h2>
          <Button variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"}
          </Button>
        </div>

        {open && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {["All", ...present].map((c) => (
                <button
                  key={c}
                  onClick={() => setFilter(c)}
                  className={`rounded-full px-2.5 py-1 text-xs ${
                    filter === c
                      ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>

            {shown.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing here this month.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {shown.map((r) => (
                    <tr key={`${r.kind}:${r.subcategoryId}`}>
                      <td className="py-1.5">{r.name}</td>
                      <td className="py-1.5">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {r.category}
                        </span>
                      </td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${
                          r.kind === "income" ? "text-emerald-600" : ""
                        }`}
                      >
                        {r.kind === "income" ? "+" : ""}
                        {formatCents(r.amount, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="flex justify-between border-t border-zinc-200 pt-2 text-sm font-medium dark:border-zinc-800">
              <span>{totalLabel}</span>
              <span
                className={`tabular-nums ${
                  filter === "All" && total < 0 ? "text-red-600" : ""
                }`}
              >
                {formatCents(total, currency)}
              </span>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
