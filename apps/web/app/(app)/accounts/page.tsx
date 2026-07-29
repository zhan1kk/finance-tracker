"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ExchangeRatesCard } from "@/components/exchange-rates-card";
import { TelegramCard } from "@/components/telegram-card";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api, downloadFile } from "@/lib/api";
import { formatCents, parseSignedAmountToCents } from "@/lib/format";
import {
  ACCOUNT_TYPES,
  CURRENCIES,
  type Account,
  type AccountType,
} from "@/lib/types";

// A colour per account type so kinds are distinguishable at a glance — a tinted
// type badge plus a matching left stripe on the card.
const TYPE_BADGE: Record<AccountType, string> = {
  checking: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  savings: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  cash: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  credit: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  investment:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  crypto:
    "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
};

const TYPE_ACCENT: Record<AccountType, string> = {
  checking: "border-l-sky-400",
  savings: "border-l-amber-400",
  cash: "border-l-emerald-400",
  credit: "border-l-red-400",
  investment: "border-l-violet-400",
  crypto: "border-l-orange-400",
};

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["accounts"] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Account>("/accounts", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const setStartingBalance = useMutation({
    mutationFn: ({ id, initialBalance }: { id: string; initialBalance: number }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ initialBalance }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const setCounted = useMutation({
    mutationFn: ({ id, countInNetWorth }: { id: string; countInNetWorth: boolean }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ countInNetWorth }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const setPinned = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/accounts/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const amountInput = String(form.get("initialBalance") || "0") || "0";
    const initialBalance = parseSignedAmountToCents(amountInput);
    if (initialBalance === null) {
      setError(new Error("Invalid starting balance — e.g. 100 or -478.42"));
      return;
    }
    create.mutate({
      name: String(form.get("name")),
      type: String(form.get("type")),
      currency: String(form.get("currency")).toUpperCase(),
      initialBalance,
    });
    e.currentTarget.reset();
  };

  const pinned = accounts.data?.filter((a) => a.pinned) ?? [];
  const unpinned = accounts.data?.filter((a) => !a.pinned) ?? [];

  const renderAccount = (account: Account) => (
    <Card
      key={account.id}
      className={`flex items-center justify-between border-l-4 ${TYPE_ACCENT[account.type]}`}
    >
      <div>
        <p className="font-medium">
          {account.name}{" "}
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-normal ${TYPE_BADGE[account.type]}`}
          >
            {account.type}
          </span>
        </p>
        {/* Negative is a credit account's normal state (debt owed), so the red
            warning tint applies to the other types only. */}
        <p
          className={`text-lg ${
            account.balance < 0 && account.type !== "credit"
              ? "text-red-600"
              : ""
          }`}
        >
          {formatCents(account.balance, account.currency)}
        </p>
        <button
          className="mt-0.5 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
          title="Whether this account's balance is part of your net worth"
          onClick={() =>
            setCounted.mutate({
              id: account.id,
              countInNetWorth: !account.countInNetWorth,
            })
          }
        >
          {account.countInNetWorth ? "in net worth" : "✕ not in net worth"}
        </button>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          variant="ghost"
          onClick={() => {
            setError(null);
            setPinned.mutate({ id: account.id, pinned: !account.pinned });
          }}
        >
          {account.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const name = window.prompt("New name", account.name);
            if (name && name !== account.name) {
              setError(null);
              rename.mutate({ id: account.id, name });
            }
          }}
        >
          Rename
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const raw = window.prompt(
              "Starting balance on day one (negative = credit card debt, e.g. -478.42). Later transactions stay applied on top.",
              (account.initialBalance / 100).toFixed(2),
            );
            if (raw === null) return;
            const initialBalance = parseSignedAmountToCents(raw);
            if (initialBalance === null) {
              setError(new Error("Invalid amount — e.g. 100 or -478.42"));
              return;
            }
            if (initialBalance !== account.initialBalance) {
              setError(null);
              setStartingBalance.mutate({ id: account.id, initialBalance });
            }
          }}
        >
          Set balance
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm(`Delete account "${account.name}"?`)) {
              setError(null);
              remove.mutate(account.id);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-3 font-medium">New account</h2>
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <Input name="name" required placeholder="Main checking" />
          </Field>
          <Field label="Type">
            <Select name="type" defaultValue="checking">
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency">
            <Select name="currency" defaultValue="EUR">
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Starting balance">
            <Input name="initialBalance" placeholder="0.00" className="w-28" />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
        <ErrorText error={error} />
      </Card>

      {pinned.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Pinned
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {pinned.map(renderAccount)}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {unpinned.map(renderAccount)}
      </div>

      <ExchangeRatesCard />

      <TelegramCard accounts={accounts.data ?? []} />

      <Card>
        <h2 className="mb-1 font-medium">Your data</h2>
        <p className="mb-3 text-sm text-zinc-500">
          Everything you own — accounts, transactions, categories, rules,
          budgets, recurring — as one file. Your data is yours.
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() =>
              void downloadFile(
                "/reports/export.json",
                "finance-tracker-export.json",
              )
            }
          >
            Download JSON
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void downloadFile("/reports/transactions.csv", "transactions.csv")
            }
          >
            Transactions CSV
          </Button>
        </div>
      </Card>
    </main>
  );
}
