"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents, todayISO } from "@/lib/format";
import type { Account, TransactionList } from "@/lib/types";

export default function OverviewPage() {
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });

  const monthStart = `${todayISO().slice(0, 7)}-01`;
  const monthTransactions = useQuery({
    queryKey: ["transactions", { from: monthStart }],
    queryFn: () =>
      api<TransactionList>(`/transactions?from=${monthStart}&pageSize=100`),
  });

  const items = monthTransactions.data?.items ?? [];
  const income = items
    .filter((t) => t.type === "INCOME")
    .reduce((sum, t) => sum + t.amount, 0);
  const expenses = items
    .filter((t) => t.type === "EXPENSE")
    .reduce((sum, t) => sum + t.amount, 0);
  const currency = accounts.data?.[0]?.currency ?? "EUR";

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
