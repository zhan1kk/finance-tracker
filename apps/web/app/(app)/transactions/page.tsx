"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api, downloadFile } from "@/lib/api";
import { formatCents, parseAmountToCents, todayISO } from "@/lib/format";
import type {
  Account,
  Subcategory,
  Transaction,
  TransactionList,
  TransactionType,
} from "@/lib/types";

type Filters = {
  type: string;
  accountId: string;
  search: string;
  from: string;
  to: string;
  page: number;
};

const PAGE_SIZE = 20;

export default function TransactionsPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>({
    type: "",
    accountId: "",
    search: "",
    from: "",
    to: "",
    page: 1,
  });

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });

  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(PAGE_SIZE),
  });
  if (filters.type) params.set("type", filters.type);
  if (filters.accountId) params.set("accountId", filters.accountId);
  if (filters.search) params.set("search", filters.search);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);

  const transactions = useQuery({
    queryKey: ["transactions", Object.fromEntries(params)],
    queryFn: () => api<TransactionList>(`/transactions?${params.toString()}`),
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["budgets"] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => api(`/transactions/${id}`, { method: "DELETE" }),
    onSuccess: invalidateAll,
  });

  const accountName = (id: string | null) =>
    accounts.data?.find((a) => a.id === id)?.name ?? "—";
  const currencyOf = (id: string) =>
    accounts.data?.find((a) => a.id === id)?.currency ?? "EUR";

  const total = transactions.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="flex flex-col gap-6">
      <QuickAdd
        accounts={accounts.data ?? []}
        subcategories={subcategories.data ?? []}
        onCreated={invalidateAll}
      />

      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Type">
            <Select
              value={filters.type}
              onChange={(e) =>
                setFilters({ ...filters, type: e.target.value, page: 1 })
              }
            >
              <option value="">All</option>
              <option value="INCOME">Income</option>
              <option value="EXPENSE">Expense</option>
              <option value="TRANSFER">Transfer</option>
            </Select>
          </Field>
          <Field label="Account">
            <Select
              value={filters.accountId}
              onChange={(e) =>
                setFilters({ ...filters, accountId: e.target.value, page: 1 })
              }
            >
              <option value="">All</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input
              type="date"
              value={filters.from}
              onChange={(e) =>
                setFilters({ ...filters, from: e.target.value, page: 1 })
              }
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={filters.to}
              onChange={(e) =>
                setFilters({ ...filters, to: e.target.value, page: 1 })
              }
            />
          </Field>
          <Field label="Search description">
            <Input
              value={filters.search}
              onChange={(e) =>
                setFilters({ ...filters, search: e.target.value, page: 1 })
              }
              placeholder="espresso…"
            />
          </Field>
          <span className="ml-auto flex items-center gap-3 text-sm text-zinc-500">
            {total} transaction{total === 1 ? "" : "s"}
            <button
              className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 dark:decoration-zinc-700 dark:hover:text-zinc-300"
              onClick={() =>
                void downloadFile("/reports/transactions.csv", "transactions.csv")
              }
            >
              Export CSV
            </button>
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Category</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Account</th>
                <th className="py-2 pr-3 text-right font-medium">Amount</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {transactions.data?.items.map((t) => (
                <TransactionRow
                  key={t.id}
                  transaction={t}
                  accountName={accountName}
                  currency={currencyOf(t.accountId)}
                  onDelete={() => {
                    if (window.confirm("Delete this transaction?")) {
                      remove.mutate(t.id);
                    }
                  }}
                />
              ))}
              {transactions.data?.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-zinc-500">
                    No transactions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {lastPage > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <Button
              variant="ghost"
              disabled={filters.page <= 1}
              onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
            >
              Previous
            </Button>
            <span className="text-zinc-500">
              {filters.page} / {lastPage}
            </span>
            <Button
              variant="ghost"
              disabled={filters.page >= lastPage}
              onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
            >
              Next
            </Button>
          </div>
        )}
      </Card>
    </main>
  );
}

function TransactionRow({
  transaction: t,
  accountName,
  currency,
  onDelete,
}: {
  transaction: Transaction;
  accountName: (id: string | null) => string;
  currency: string;
  onDelete: () => void;
}) {
  const sign = t.type === "INCOME" ? "+" : "−";
  const color =
    t.type === "INCOME"
      ? "text-emerald-600"
      : t.type === "TRANSFER"
        ? "text-zinc-500"
        : "";

  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-900">
      <td className="py-2 pr-3 whitespace-nowrap">{t.date.slice(0, 10)}</td>
      <td className="py-2 pr-3">
        {t.type === "TRANSFER" ? (
          <span className="text-zinc-500">Transfer</span>
        ) : (
          (t.subcategory?.name ?? "—")
        )}
        {t.type === "INCOME" && t.parentTransactionId && (
          <span className="ml-1.5 text-xs text-zinc-400">reimbursement</span>
        )}
        {t.type === "EXPENSE" && t.reimbursements.length > 0 && (
          <span className="ml-1.5 text-xs text-zinc-400">
            reimbursed{" "}
            {formatCents(
              t.reimbursements.reduce((sum, r) => sum + r.amount, 0),
              currency,
            )}
          </span>
        )}
      </td>
      <td className="py-2 pr-3">{t.description ?? ""}</td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {accountName(t.accountId)}
        {t.type === "TRANSFER" && ` → ${accountName(t.counterAccountId)}`}
      </td>
      <td className={`py-2 pr-3 text-right whitespace-nowrap ${color}`}>
        {t.type === "TRANSFER" ? "" : sign}
        {formatCents(t.amount, currency)}
      </td>
      <td className="py-2 text-right">
        <button
          aria-label="Delete transaction"
          className="text-zinc-400 hover:text-red-600"
          onClick={onDelete}
        >
          ×
        </button>
      </td>
    </tr>
  );
}

function QuickAdd({
  accounts,
  subcategories,
  onCreated,
}: {
  accounts: Account[];
  subcategories: Subcategory[];
  onCreated: () => void;
}) {
  const [type, setType] = useState<TransactionType>("EXPENSE");
  const [error, setError] = useState<unknown>(null);

  const eligibleSubcategories = subcategories.filter((s) =>
    type === "INCOME" ? s.category === "Income" : s.category !== "Income",
  );

  // Candidate parents for a reimbursement (only relevant for INCOME).
  const recentExpenses = useQuery({
    queryKey: ["transactions", { recentExpenses: true }],
    queryFn: () => api<TransactionList>("/transactions?type=EXPENSE&pageSize=15"),
    enabled: type === "INCOME",
  });

  const expenseLabel = (t: Transaction) => {
    const currency =
      accounts.find((a) => a.id === t.accountId)?.currency ?? "EUR";
    const what = t.description || t.subcategory?.name || "expense";
    return `${t.date.slice(0, 10)} · ${what} · ${formatCents(t.amount, currency)}`;
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/transactions", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: onCreated,
    onError: setError,
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const amount = parseAmountToCents(String(form.get("amount")));
    if (amount === null) {
      setError(new Error("Invalid amount — use e.g. 12.50"));
      return;
    }

    const body: Record<string, unknown> = {
      type,
      amount,
      date: String(form.get("date")),
      accountId: String(form.get("accountId")),
      description: String(form.get("description") || "") || undefined,
    };
    if (type === "TRANSFER") {
      body.counterAccountId = String(form.get("counterAccountId"));
    } else {
      body.subcategoryId = String(form.get("subcategoryId"));
    }
    const parentId = String(form.get("parentTransactionId") || "");
    if (type === "INCOME" && parentId) {
      body.parentTransactionId = parentId;
    }
    create.mutate(body);
    e.currentTarget.reset();
  };

  return (
    <Card>
      <h2 className="mb-3 font-medium">Add transaction</h2>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Type">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as TransactionType)}
          >
            <option value="EXPENSE">Expense</option>
            <option value="INCOME">Income</option>
            <option value="TRANSFER">Transfer</option>
          </Select>
        </Field>
        <Field label="Amount">
          <Input
            name="amount"
            required
            placeholder="12.50"
            inputMode="decimal"
            className="w-28"
            autoFocus
          />
        </Field>
        <Field label={type === "TRANSFER" ? "From account" : "Account"}>
          <Select name="accountId" required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {type === "TRANSFER" ? (
          <Field label="To account">
            <Select name="counterAccountId" required>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Category">
            <Select name="subcategoryId" required>
              {eligibleSubcategories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.category})
                </option>
              ))}
            </Select>
          </Field>
        )}
        {type === "INCOME" && (
          <Field label="Reimburses">
            <Select name="parentTransactionId" defaultValue="">
              <option value="">—</option>
              {recentExpenses.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {expenseLabel(t)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Date">
          <Input name="date" type="date" defaultValue={todayISO()} required />
        </Field>
        <Field label="Description">
          <Input name="description" placeholder="optional" />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          Add
        </Button>
      </form>
      <ErrorText error={error} />
    </Card>
  );
}
