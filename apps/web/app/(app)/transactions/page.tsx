"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api, downloadFile } from "@/lib/api";
import { formatCents, parseAmountToCents, todayISO } from "@/lib/format";
import type {
  Account,
  Subcategory,
  TelegramSettings,
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

  const removeAll = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>("/transactions", { method: "DELETE" }),
    onSuccess: invalidateAll,
  });

  const accountName = (id: string | null) =>
    accounts.data?.find((a) => a.id === id)?.name ?? "—";
  const currencyOf = (id: string) =>
    accounts.data?.find((a) => a.id === id)?.currency ?? "EUR";

  const total = transactions.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const goToPage = (p: number) =>
    setFilters({ ...filters, page: Math.min(Math.max(1, p), lastPage) });

  // Deleting the last row on a page (or any change that shrinks the list) can
  // leave `page` pointing past the end — the pager then hides and you're stuck
  // on an empty page. Once fresh data lands, pull the page back into range.
  useEffect(() => {
    if (transactions.data && filters.page > lastPage) {
      setFilters((f) => ({ ...f, page: lastPage }));
    }
  }, [transactions.data, filters.page, lastPage]);

  // A running balance is only meaningful (and only returned) for one account.
  const singleAccount = filters.accountId !== "";

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
            <button
              className="text-red-600 hover:underline disabled:opacity-50"
              disabled={removeAll.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete ALL transactions across every account? Each account resets to its starting balance. This cannot be undone.",
                  )
                ) {
                  removeAll.mutate();
                }
              }}
            >
              Delete all
            </button>
          </span>
        </div>

        {lastPage > 1 && (
          <div className="mb-2">
            <Pager page={filters.page} lastPage={lastPage} onGo={goToPage} />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Category</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Account</th>
                <th className="py-2 pr-3 text-right font-medium">Amount</th>
                {singleAccount && (
                  <th className="py-2 pr-3 text-right font-medium">Balance</th>
                )}
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
                  currencyOf={currencyOf}
                  filterAccountId={singleAccount ? filters.accountId : null}
                  subcategories={subcategories.data ?? []}
                  onChange={invalidateAll}
                  onDelete={() => {
                    if (window.confirm("Delete this transaction?")) {
                      remove.mutate(t.id);
                    }
                  }}
                />
              ))}
              {transactions.data?.items.length === 0 && (
                <tr>
                  <td
                    colSpan={singleAccount ? 7 : 6}
                    className="py-6 text-center text-zinc-500"
                  >
                    No transactions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {lastPage > 1 && (
          <div className="mt-3">
            <Pager page={filters.page} lastPage={lastPage} onGo={goToPage} />
          </div>
        )}
      </Card>
    </main>
  );
}

/** First / Prev / Next / Last pager, so jumping to either end never needs scrolling. */
function Pager({
  page,
  lastPage,
  onGo,
}: {
  page: number;
  lastPage: number;
  onGo: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 text-sm">
      <Button variant="ghost" disabled={page <= 1} onClick={() => onGo(1)}>
        « First
      </Button>
      <Button variant="ghost" disabled={page <= 1} onClick={() => onGo(page - 1)}>
        ‹ Prev
      </Button>
      <span className="text-zinc-500">
        {page} / {lastPage}
      </span>
      <Button
        variant="ghost"
        disabled={page >= lastPage}
        onClick={() => onGo(page + 1)}
      >
        Next ›
      </Button>
      <Button
        variant="ghost"
        disabled={page >= lastPage}
        onClick={() => onGo(lastPage)}
      >
        Last »
      </Button>
    </div>
  );
}

/**
 * Search-driven picker for the expense an income reimburses. A plain dropdown
 * only holds the most recent expenses, so an older one (a May charge refunded
 * in June) is unreachable — this queries the server by merchant text instead,
 * so any expense is findable no matter its age.
 */
function ReimbursePicker({
  value,
  currencyOf,
  onChange,
}: {
  value: string;
  currencyOf: (id: string) => string;
  onChange: (parentId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  // Results for the typed query; only fires once something is typed.
  const results = useQuery({
    queryKey: ["reimburse-search", debounced],
    queryFn: () =>
      api<TransactionList>(
        `/transactions?type=EXPENSE&pageSize=12&search=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced !== "",
  });
  // The linked expense may be far older than any search result, so fetch it
  // directly to label the current selection.
  const current = useQuery({
    queryKey: ["transaction", value],
    queryFn: () => api<Transaction>(`/transactions/${value}`),
    enabled: value !== "",
  });

  const label = (e: Transaction) =>
    `${e.date.slice(0, 10)} · ${
      e.description || e.subcategory?.name || "expense"
    } · ${formatCents(e.amount, currencyOf(e.accountId))}`;

  if (value) {
    return (
      <div className="mt-1 flex items-center gap-2 text-xs">
        <span className="text-emerald-600">
          reimburses: {current.data ? label(current.data) : "…"}
        </span>
        <button
          type="button"
          className="text-zinc-400 hover:text-red-600"
          onClick={() => onChange("")}
        >
          clear
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="reimburses an expense? search it (e.g. amazon)…"
        className="w-full text-xs"
      />
      {debounced && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-800">
          {results.data?.items.map((e) => (
            <button
              type="button"
              key={e.id}
              className="block w-full px-2 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={() => onChange(e.id)}
            >
              {label(e)}
            </button>
          ))}
          {results.data?.items.length === 0 && (
            <p className="px-2 py-1 text-xs text-zinc-400">
              no matching expense
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TransactionRow({
  transaction: t,
  accountName,
  currency,
  currencyOf,
  filterAccountId,
  subcategories,
  onChange,
  onDelete,
}: {
  transaction: Transaction;
  accountName: (id: string | null) => string;
  currency: string;
  currencyOf: (id: string) => string;
  /** When the list is scoped to one account, its id — enables the running
   * balance column and orients a transfer's sign to that account. */
  filterAccountId: string | null;
  subcategories: Subcategory[];
  onChange: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(t.date.slice(0, 10));
  const [amount, setAmount] = useState((t.amount / 100).toFixed(2));
  const [subcategoryId, setSubcategoryId] = useState(t.subcategoryId ?? "");
  const [description, setDescription] = useState(t.description ?? "");
  const [parentId, setParentId] = useState(t.parentTransactionId ?? "");
  const [excludeFromStats, setExcludeFromStats] = useState(t.excludeFromStats);
  const [error, setError] = useState<string | null>(null);

  // Type and account are fixed; only these fields are editable. Categories are
  // filtered to the row's direction (income vs. spending).
  const eligible = subcategories.filter((s) =>
    t.type === "INCOME" ? s.category === "Income" : s.category !== "Income",
  );

  const save = useMutation({
    mutationFn: async (vars: {
      body: Record<string, unknown>;
      parentChanged: boolean;
      parentTransactionId: string | null;
    }) => {
      await api<Transaction>(`/transactions/${t.id}`, {
        method: "PATCH",
        body: JSON.stringify(vars.body),
      });
      // The reimbursement link is a separate association, set via its own route.
      if (vars.parentChanged) {
        await api<Transaction>(`/transactions/${t.id}/reimburses`, {
          method: "PATCH",
          body: JSON.stringify({
            parentTransactionId: vars.parentTransactionId,
          }),
        });
      }
    },
    onSuccess: () => {
      setEditing(false);
      onChange();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const beginEdit = () => {
    setDate(t.date.slice(0, 10));
    setAmount((t.amount / 100).toFixed(2));
    setSubcategoryId(t.subcategoryId ?? "");
    setDescription(t.description ?? "");
    setParentId(t.parentTransactionId ?? "");
    setExcludeFromStats(t.excludeFromStats);
    setError(null);
    setEditing(true);
  };

  const submit = () => {
    const cents = parseAmountToCents(amount);
    if (cents === null) {
      setError("Invalid amount — use e.g. 12.50");
      return;
    }
    const body: Record<string, unknown> = { date, amount: cents, description };
    if (t.type !== "TRANSFER") {
      if (!excludeFromStats && !subcategoryId) {
        setError("Pick a category (or mark it internal)");
        return;
      }
      if (subcategoryId) body.subcategoryId = subcategoryId;
      body.excludeFromStats = excludeFromStats;
    }
    save.mutate({
      body,
      parentChanged:
        t.type === "INCOME" && parentId !== (t.parentTransactionId ?? ""),
      parentTransactionId: parentId || null,
    });
  };

  // A transfer's sign depends on which side the filtered account is on: money
  // arriving (this account is the destination) is +, leaving is −.
  const transferIn =
    t.type === "TRANSFER" && t.counterAccountId === filterAccountId;
  const sign = t.type === "INCOME" || transferIn ? "+" : "−";
  const color =
    t.type === "INCOME" || transferIn
      ? "text-emerald-600"
      : t.type === "TRANSFER"
        ? "text-zinc-500"
        : "";
  // Show a signed amount for transfers only when scoped to one account (so the
  // running balance reads correctly); otherwise keep them sign-less.
  const showSign = t.type !== "TRANSFER" || filterAccountId !== null;

  if (editing) {
    return (
      <tr className="border-b border-zinc-100 align-top dark:border-zinc-900">
        <td className="py-2 pr-3">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-36"
          />
        </td>
        <td className="py-2 pr-3">
          {t.type === "TRANSFER" ? (
            <span className="text-zinc-500">Transfer</span>
          ) : (
            <>
              <Select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                disabled={excludeFromStats}
              >
                {eligible.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <label className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={excludeFromStats}
                  onChange={(e) => setExcludeFromStats(e.target.checked)}
                />
                Internal (exclude from stats)
              </label>
            </>
          )}
        </td>
        <td className="py-2 pr-3">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="optional"
            className="w-full"
          />
          {/* Link this income to the expense it pays back (e.g. a peer FX swap:
              the Kaspi debit is the expense, this Revolut credit reimburses it,
              so only the spread hits the monthly total). */}
          {t.type === "INCOME" && (
            <ReimbursePicker
              value={parentId}
              currencyOf={currencyOf}
              onChange={setParentId}
            />
          )}
        </td>
        <td className="py-2 pr-3 whitespace-nowrap text-zinc-500">
          {accountName(t.accountId)}
          {t.type === "TRANSFER" && ` → ${accountName(t.counterAccountId)}`}
        </td>
        <td className="py-2 pr-3 text-right">
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="w-24 text-right"
          />
        </td>
        {filterAccountId && <td className="py-2 pr-3" />}
        <td className="py-2">
          <div className="flex items-center justify-end gap-2">
            <button
              className="font-medium text-emerald-600 hover:underline disabled:opacity-50"
              onClick={submit}
              disabled={save.isPending}
            >
              Save
            </button>
            <button
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="mt-1 text-right text-xs text-red-600">{error}</p>
          )}
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-900">
      <td className="py-2 pr-3 whitespace-nowrap">{t.date.slice(0, 10)}</td>
      <td className="py-2 pr-3">
        {t.type === "TRANSFER" ? (
          <span className="text-zinc-500">Transfer</span>
        ) : (
          (t.subcategory?.name ?? "—")
        )}
        {t.excludeFromStats && (
          <span className="ml-1.5 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            internal
          </span>
        )}
        {t.type === "INCOME" && t.parentTransactionId && (
          <span className="ml-1.5 text-xs text-zinc-400">reimbursement</span>
        )}
        {t.type === "EXPENSE" &&
          !t.excludeFromStats &&
          t.reimbursements.length > 0 &&
          (() => {
            // Show the payback in the currency it actually arrived in (the
            // reimbursing account's), not the expense's — a €120 Revolut credit
            // against a tenge charge is "€120", not "KZT 120". Amounts are only
            // summed when they share a currency.
            const cur = currencyOf(t.reimbursements[0].accountId);
            const uniform = t.reimbursements.every(
              (r) => currencyOf(r.accountId) === cur,
            );
            return (
              <span className="ml-1.5 text-xs text-zinc-400">
                reimbursed{" "}
                {uniform
                  ? formatCents(
                      t.reimbursements.reduce((sum, r) => sum + r.amount, 0),
                      cur,
                    )
                  : `${t.reimbursements.length}×`}
              </span>
            );
          })()}
      </td>
      <td className="py-2 pr-3">{t.description ?? ""}</td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {accountName(t.accountId)}
        {t.type === "TRANSFER" && ` → ${accountName(t.counterAccountId)}`}
      </td>
      <td className={`py-2 pr-3 text-right whitespace-nowrap ${color}`}>
        {showSign ? sign : ""}
        {formatCents(t.amount, currency)}
      </td>
      {filterAccountId && (
        <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums text-zinc-500">
          {t.runningBalance !== undefined
            ? formatCents(t.runningBalance, currency)
            : ""}
        </td>
      )}
      <td className="py-2">
        <div className="flex items-center justify-end gap-2">
          <button
            aria-label="Edit transaction"
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
            onClick={beginEdit}
          >
            Edit
          </button>
          <button
            aria-label="Delete transaction"
            className="text-zinc-400 hover:text-red-600"
            onClick={onDelete}
          >
            ×
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Remembers the date across entries so a backlog can be typed in one sitting. */
const LAST_DATE_KEY = "ft:lastTransactionDate";

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
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Account and date are controlled so they survive the form reset: entering a
  // run of past transactions should not mean re-picking both every single time.
  const settings = useQuery({
    queryKey: ["telegram-settings"],
    queryFn: () => api<TelegramSettings>("/telegram/settings"),
  });
  const [accountId, setAccountId] = useState("");
  const [counterAccountId, setCounterAccountId] = useState("");
  const [date, setDate] = useState(todayISO());

  // Prefer the account chosen as default, else the first one.
  useEffect(() => {
    if (accountId || accounts.length === 0) return;
    const preferred = settings.data?.defaultAccountId;
    setAccountId(
      preferred && accounts.some((a) => a.id === preferred)
        ? preferred
        : accounts[0].id,
    );
  }, [accountId, accounts, settings.data?.defaultAccountId]);

  // Default the transfer destination to a different account than the source.
  useEffect(() => {
    if (counterAccountId || accounts.length === 0) return;
    setCounterAccountId(
      (accounts.find((a) => a.id !== accountId) ?? accounts[0]).id,
    );
  }, [counterAccountId, accountId, accounts]);

  // A transfer can't cross currencies (two amounts + a fee) — warn before submit.
  const fromCurrency = accounts.find((a) => a.id === accountId)?.currency;
  const toCurrency = accounts.find((a) => a.id === counterAccountId)?.currency;
  const currencyMismatch =
    type === "TRANSFER" &&
    !!fromCurrency &&
    !!toCurrency &&
    fromCurrency !== toCurrency;

  // Restore the last date used on this device (read after mount, so the
  // server-rendered markup and the first client render still agree).
  useEffect(() => {
    const saved = window.localStorage.getItem(LAST_DATE_KEY);
    if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved)) setDate(saved);
  }, []);

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
      api<Transaction>("/transactions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (created, body) => {
      onCreated();
      const currency =
        accounts.find((a) => a.id === body.accountId)?.currency ?? "EUR";
      const notices: string[] = [];
      if (created.outlier) {
        notices.push(
          `Heads up: that's unusually ${created.outlier.direction} for ${
            created.subcategory?.name ?? "this category"
          } — typically around ${formatCents(created.outlier.medianCents, currency)}.`,
        );
      }
      const bookedAccount = accounts.find((a) => a.id === body.accountId);
      if (
        created.balanceAfter !== undefined &&
        created.balanceAfter < 0 &&
        // Negative is a credit account's normal state (debt owed) — no warning.
        bookedAccount?.type !== "credit"
      ) {
        notices.push(
          `${bookedAccount?.name ?? "The account"} is below zero (${formatCents(created.balanceAfter, currency)}).`,
        );
      }
      if (notices.length > 0) setNotice(notices.join(" "));
    },
    onError: setError,
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
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
    } else if (internal) {
      // An internal move (own-account transfer / exchange): no category, and
      // kept out of income/spending stats.
      body.excludeFromStats = true;
    } else {
      body.subcategoryId = String(form.get("subcategoryId"));
    }
    const parentId = String(form.get("parentTransactionId") || "");
    if (type === "INCOME" && !internal && parentId) {
      body.parentTransactionId = parentId;
    }
    create.mutate(body);
    window.localStorage.setItem(LAST_DATE_KEY, date);
    e.currentTarget.reset();
    setInternal(false);
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
          <Select
            name="accountId"
            required
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {type === "TRANSFER" ? (
          <Field label="To account">
            <Select
              name="counterAccountId"
              required
              value={counterAccountId}
              onChange={(e) => setCounterAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : internal ? null : (
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
        {/* Own-account transfer / currency exchange: moves the balance, but is
            kept out of income/spending. No category needed. */}
        {type !== "TRANSFER" && (
          <Field label="Internal move">
            <label className="flex h-9 items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={internal}
                onChange={(e) => setInternal(e.target.checked)}
              />
              exclude from stats
            </label>
          </Field>
        )}
        {type === "INCOME" && !internal && (
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
          <Input
            name="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Description">
          <Input name="description" placeholder="optional" />
        </Field>
        <Button type="submit" disabled={create.isPending || currencyMismatch}>
          Add
        </Button>
      </form>
      {currencyMismatch && (
        <p className="mt-2 text-sm text-amber-600">
          A {fromCurrency}→{toCurrency} move isn&apos;t one transfer (two amounts
          plus any fee). Record it as an <strong>expense</strong> on the source
          and an <strong>income</strong> on the destination, then link them with
          “reimburses” — the difference captures the conversion and commission.
        </p>
      )}
      {notice && <p className="mt-2 text-sm text-amber-600">{notice}</p>}
      <ErrorText error={error} />
    </Card>
  );
}
