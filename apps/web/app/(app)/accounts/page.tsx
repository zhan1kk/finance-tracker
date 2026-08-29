"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ExchangeRatesCard } from "@/components/exchange-rates-card";
import { PromptDialog } from "@/components/prompt-dialog";
import { TelegramCard } from "@/components/telegram-card";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api, downloadFile } from "@/lib/api";
import { formatCents, parseSignedAmountToCents } from "@/lib/format";
import { TYPE_ACCENT, TYPE_BADGE } from "@/lib/account-style";
import {
  ACCOUNT_TYPES,
  COMMON_CURRENCIES,
  type Account,
  type FxPreferences,
} from "@/lib/types";

export default function AccountsPage() {
  const queryClient = useQueryClient();
  // Two error states, not one. Creating an account fails at the form up top;
  // renaming, pinning, retyping, setting a balance and deleting fail at a row
  // far down the list. Delete in particular fails routinely — the API refuses
  // while an account still has transactions, recurring rules or import batches
  // — and reporting that inside the "New account" card meant scrolling back up
  // past every account to find out why nothing happened.
  const [error, setError] = useState<unknown>(null);
  const [rowError, setRowError] = useState<unknown>(null);

  const fxPrefs = useQuery({
    queryKey: ["fx-preferences"],
    queryFn: () => api<FxPreferences>("/fx/preferences"),
  });
  const baseCurrency = fxPrefs.data?.baseCurrency ?? "EUR";
  const currencyOptions = [
    baseCurrency,
    ...(fxPrefs.data?.currencies ?? []).map((c) => c.currency),
    ...COMMON_CURRENCIES,
  ].filter((c, i, all) => all.indexOf(c) === i);

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
    onError: setRowError,
  });

  const setStartingBalance = useMutation({
    mutationFn: ({ id, initialBalance }: { id: string; initialBalance: number }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ initialBalance }),
      }),
    onSuccess: invalidate,
    onError: setRowError,
  });

  const setCounted = useMutation({
    mutationFn: ({ id, countInNetWorth }: { id: string; countInNetWorth: boolean }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ countInNetWorth }),
      }),
    onSuccess: invalidate,
    onError: setRowError,
  });

  const setPinned = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      }),
    onSuccess: invalidate,
    onError: setRowError,
  });

  const changeType = useMutation({
    mutationFn: ({ id, type }: { id: string; type: string }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ type }),
      }),
    onSuccess: invalidate,
    onError: setRowError,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/accounts/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setRowError,
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
    const form_ = e.currentTarget;
    create.mutate(
      {
        name: String(form.get("name")),
        type: String(form.get("type")),
        currency: String(form.get("currency")).toUpperCase(),
        initialBalance,
      },
      { onSuccess: () => form_.reset() },
    );
  };

  // Which account is being edited in the prompt dialog, and which field.
  const [editing, setEditing] = useState<{
    kind: "name" | "balance";
    account: Account;
  } | null>(null);

  const pinned = accounts.data?.filter((a) => a.pinned) ?? [];
  const unpinned = accounts.data?.filter((a) => !a.pinned) ?? [];

  // Any in-flight change disables that account's controls: on a slow
  // connection a second click used to fire a duplicate request, and after a
  // delete the retry came back as a confusing "Not Found".
  const rowBusy =
    rename.isPending ||
    setStartingBalance.isPending ||
    setCounted.isPending ||
    setPinned.isPending ||
    changeType.isPending ||
    remove.isPending;

  const renderAccount = (account: Account) => (
    <Card
      key={account.id}
      // Wrapping, because the controls (a type Select plus four buttons) and the
      // name/balance block cannot share one row at phone width — without it the
      // row overflows or squeezes the name into an unreadable column.
      className={`flex flex-wrap items-center justify-between gap-3 border-l-4 ${TYPE_ACCENT[account.type]}`}
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
          className={`text-xl font-semibold tabular-nums ${
            account.balance < 0 && account.type !== "credit"
              ? "text-red-600"
              : ""
          }`}
        >
          {formatCents(account.balance, account.currency)}
        </p>
        <button
          disabled={rowBusy}
          className="mt-0.5 text-xs text-zinc-400 hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-300"
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
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Select
          value={account.type}
          disabled={rowBusy}
          aria-label="Account type"
          title="Change account type"
          onChange={(e) => {
            setRowError(null);
            changeType.mutate({ id: account.id, type: e.target.value });
          }}
        >
          {ACCOUNT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          disabled={rowBusy}
          onClick={() => {
            setRowError(null);
            setPinned.mutate({ id: account.id, pinned: !account.pinned });
          }}
        >
          {account.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button
          variant="ghost"
          disabled={rowBusy}
          onClick={() => {
            setRowError(null);
            setEditing({ kind: "name", account });
          }}
        >
          Rename
        </Button>
        <Button
          variant="ghost"
          disabled={rowBusy}
          onClick={() => {
            setRowError(null);
            setEditing({ kind: "balance", account });
          }}
        >
          Set balance
        </Button>
        <Button
          variant="danger"
          disabled={rowBusy}
          onClick={() => {
            if (window.confirm(`Delete account "${account.name}"?`)) {
              setRowError(null);
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
            <Input
              name="currency"
              defaultValue={baseCurrency}
              maxLength={3}
              required
              className="w-24 uppercase"
              list="account-currencies"
              title="Any three-letter code — its rate is fetched when the account is created"
            />
            <datalist id="account-currencies">
              {currencyOptions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
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

      <ErrorText error={rowError} />

      {accounts.isLoading && (
        <p className="text-sm text-zinc-500">Loading accounts…</p>
      )}
      {accounts.data?.length === 0 && (
        <p className="text-sm text-zinc-500">
          No accounts yet — add your first one above.
        </p>
      )}

      {pinned.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            <span aria-hidden>★</span> Pinned
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {pinned.map(renderAccount)}
          </div>
        </section>
      )}

      {unpinned.length > 0 && (
        <section>
          {pinned.length > 0 && (
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
              Other accounts
            </h3>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {unpinned.map(renderAccount)}
          </div>
        </section>
      )}

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

      {editing?.kind === "name" && (
        <PromptDialog
          title={`Rename "${editing.account.name}"`}
          label="Account name"
          initialValue={editing.account.name}
          busy={rename.isPending}
          validate={(raw) => (raw.trim() ? null : "Enter a name")}
          onCancel={() => setEditing(null)}
          onSubmit={(raw) => {
            const name = raw.trim();
            if (name !== editing.account.name) {
              rename.mutate({ id: editing.account.id, name });
            }
            setEditing(null);
          }}
        />
      )}

      {editing?.kind === "balance" && (
        <PromptDialog
          title={`Starting balance for "${editing.account.name}"`}
          help="The balance on day one, before any transaction you have recorded. Negative means debt, e.g. -478.42 for a credit card. Later transactions stay applied on top."
          label={`Amount (${editing.account.currency})`}
          inputMode="decimal"
          initialValue={(editing.account.initialBalance / 100).toFixed(2)}
          busy={setStartingBalance.isPending}
          validate={(raw) =>
            parseSignedAmountToCents(raw) === null
              ? "Invalid amount — e.g. 100 or -478.42"
              : null
          }
          onCancel={() => setEditing(null)}
          onSubmit={(raw) => {
            const initialBalance = parseSignedAmountToCents(raw);
            if (
              initialBalance !== null &&
              initialBalance !== editing.account.initialBalance
            ) {
              setStartingBalance.mutate({
                id: editing.account.id,
                initialBalance,
              });
            }
            setEditing(null);
          }}
        />
      )}
    </main>
  );
}
