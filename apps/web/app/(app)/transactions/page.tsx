"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { ConfirmPhrase } from "@/components/confirm-phrase";
import { MultiSelect } from "@/components/multi-select";
import { SubcategoryOptions } from "@/components/subcategory-options";
import { api } from "@/lib/api";
import { useDownload } from "@/lib/use-download";
import { useAuth } from "@/lib/auth";
import {
  formatCents,
  formatDate,
  parseAmountToCents,
  todayISO,
} from "@/lib/format";
import { periodOf, periodRange, shiftPeriod } from "@/lib/period";
import { useStickyState } from "@/lib/sticky-state";
import {
  TRANSACTION_CATEGORIES,
  type Account,
  type Subcategory,
  type TelegramSettings,
  type Transaction,
  type TransactionList,
  type TransactionType,
} from "@/lib/types";

type Filters = {
  type: string;
  accountId: string;
  subcategoryIds: string[];
  search: string;
  from: string;
  to: string;
  /** "" is newest-first, the default. Amount sorts on the base-currency value
   *  server-side, so rows in different account currencies compare properly. */
  sort: "" | "amount-desc" | "amount-asc" | "date-asc";
  page: number;
};

const PAGE_SIZE = 20;

const NO_FILTERS: Filters = {
  type: "",
  accountId: "",
  subcategoryIds: [],
  search: "",
  from: "",
  to: "",
  sort: "",
  page: 1,
};

const SORT_OPTIONS: { value: Filters["sort"]; label: string }[] = [
  { value: "", label: "Newest first" },
  { value: "date-asc", label: "Oldest first" },
  { value: "amount-desc", label: "Largest amount" },
  { value: "amount-asc", label: "Smallest amount" },
];

/** Accept only a well-formed saved filter set; anything else starts clean. */
function reviveFilters(saved: unknown): Filters | null {
  if (typeof saved !== "object" || saved === null) return null;
  const s = saved as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    type: str(s.type),
    accountId: str(s.accountId),
    subcategoryIds: Array.isArray(s.subcategoryIds)
      ? s.subcategoryIds.filter((v): v is string => typeof v === "string")
      : [],
    search: str(s.search),
    from: str(s.from),
    to: str(s.to),
    sort: SORT_OPTIONS.some((o) => o.value === s.sort)
      ? (s.sort as Filters["sort"])
      : "",
    page: typeof s.page === "number" && s.page >= 1 ? Math.floor(s.page) : 1,
  };
}

export default function TransactionsPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const monthStartDay = user?.monthStartDay ?? 1;
  // Kept while you visit another page, so comparing the list against the
  // dashboard does not mean re-applying the same filters every time.
  const [filters, setFilters] = useStickyState<Filters>(
    "ft:transactions.filters",
    NO_FILTERS,
    reviveFilters,
  );
  // Rows ticked for a bulk action, and the row (if any) being split. Selection
  // is scoped to the visible page, so it clears whenever the page or filters
  // change — the ids in the set always map to rows we can still see and reason
  // about (their type, direction).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [splitting, setSplitting] = useState<Transaction | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Deleting a row, or all of them, is the one thing here with no undo — so it
  // is the last thing that should fail without saying so.
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const download = useDownload();
  // Wiping every transaction is the one action here with no way back, so it
  // asks for a typed word rather than a one-click confirm.
  const [confirmingWipe, setConfirmingWipe] = useState(false);

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
  if (filters.subcategoryIds.length > 0)
    params.set("subcategoryIds", filters.subcategoryIds.join(","));
  if (filters.search) params.set("search", filters.search);
  if (filters.sort) {
    const [sort, dir] = filters.sort.split("-");
    params.set("sort", sort);
    params.set("dir", dir);
  }
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
    onError: setDeleteError,
  });

  const removeAll = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>("/transactions", { method: "DELETE" }),
    onSuccess: invalidateAll,
    // Close the dialog too: an error rendered on the page behind the modal is
    // an error nobody can read, and the dialog looks merely stuck.
    onError: (e: unknown) => {
      setDeleteError(e);
      setConfirmingWipe(false);
    },
  });

  const clearSelection = () => setSelected(new Set());

  const bulkUpdate = useMutation({
    mutationFn: (body: {
      ids: string[];
      subcategoryId?: string;
      excludeFromStats?: boolean;
    }) =>
      api("/transactions/bulk", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onMutate: () => setBulkError(null),
    onSuccess: () => {
      clearSelection();
      invalidateAll();
    },
    onError: (e) => setBulkError(e instanceof Error ? e.message : String(e)),
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) =>
      api("/transactions/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onMutate: () => setBulkError(null),
    onSuccess: () => {
      clearSelection();
      invalidateAll();
    },
    onError: (e) => setBulkError(e instanceof Error ? e.message : String(e)),
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
  }, [transactions.data, filters.page, lastPage, setFilters]);

  // A running balance is only meaningful (and only returned) for one account.
  const singleAccount = filters.accountId !== "";

  const items = transactions.data?.items ?? [];
  const selectedItems = items.filter((t) => selected.has(t.id));
  const allSelected = items.length > 0 && items.every((t) => selected.has(t.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map((t) => t.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Extra leading checkbox column widens every full-width cell by one.
  const emptyColSpan = singleAccount ? 8 : 7;

  // One-tap date ranges. Month presets follow the user's financial month (so
  // "This month" matches the overview); the year preset is the plain calendar
  // year. Selecting one just fills the From/To fields.
  const currentPeriod = periodOf(new Date(), monthStartDay);
  const year = String(new Date().getFullYear());
  const presets = [
    { label: "This month", ...periodRange(currentPeriod, monthStartDay) },
    {
      label: "Last month",
      ...periodRange(shiftPeriod(currentPeriod, -1), monthStartDay),
    },
    { label: "This year", from: `${year}-01-01`, to: `${year}-12-31` },
  ];
  const applyRange = (from: string, to: string) =>
    setFilters((f) => ({ ...f, from, to, page: 1 }));

  const anyFilterActive =
    filters.type !== "" ||
    filters.accountId !== "" ||
    filters.subcategoryIds.length > 0 ||
    filters.search !== "" ||
    filters.sort !== "" ||
    filters.from !== "" ||
    filters.to !== "";
  const activePreset = presets.find(
    (p) => p.from === filters.from && p.to === filters.to,
  );
  const allDates = filters.from === "" && filters.to === "";
  const chip = (active: boolean) =>
    `rounded-full px-2.5 py-1 ${
      active
        ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
        : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
    }`;

  return (
    <main className="flex flex-col gap-6">
      <QuickAdd
        accounts={accounts.data ?? []}
        subcategories={subcategories.data ?? []}
        onCreated={invalidateAll}
      />

      <UnlinkedReimbursements
        currencyOf={currencyOf}
        onLinked={invalidateAll}
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
          <Field label="Category">
            <CategoryFilter
              subcategories={subcategories.data ?? []}
              selected={filters.subcategoryIds}
              onChange={(ids) =>
                setFilters({ ...filters, subcategoryIds: ids, page: 1 })
              }
            />
          </Field>
          <Field label="Sort">
            <Select
              value={filters.sort}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  sort: e.target.value as Filters["sort"],
                  page: 1,
                })
              }
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
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
          {/* Wraps for the same reason the Pager below does: four labelled
              controls in one row are wider than a phone, and flex items do not
              shrink below their content. */}
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500">
            {/* Filters persist across navigation, so there has to be one
                obvious way back to the unfiltered list. */}
            {anyFilterActive && (
              <button
                onClick={() => setFilters(NO_FILTERS)}
                className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 dark:decoration-zinc-700 dark:hover:text-zinc-300"
              >
                Clear filters
              </button>
            )}
            {total} transaction{total === 1 ? "" : "s"}
            <button
              className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 disabled:no-underline disabled:opacity-50 dark:decoration-zinc-700 dark:hover:text-zinc-300"
              disabled={download.pending}
              onClick={() =>
                download.start("/reports/transactions.csv", "transactions.csv")
              }
            >
              {download.pending ? "Preparing…" : "Export CSV"}
            </button>
            <button
              className="text-red-600 hover:underline disabled:opacity-50"
              disabled={removeAll.isPending}
              onClick={() => setConfirmingWipe(true)}
            >
              Delete all
            </button>
          </span>
        </div>
        <ErrorText error={download.error} />

        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-zinc-400">Quick range:</span>
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => applyRange(p.from, p.to)}
              className={chip(activePreset?.label === p.label)}
            >
              {p.label}
            </button>
          ))}
          <button onClick={() => applyRange("", "")} className={chip(allDates)}>
            All dates
          </button>
        </div>

        {selectedItems.length > 0 && (
          <SelectionBar
            selected={selectedItems}
            subcategories={subcategories.data ?? []}
            busy={bulkUpdate.isPending || bulkDelete.isPending}
            error={bulkError}
            onCategorize={(subcategoryId) =>
              bulkUpdate.mutate({
                ids: selectedItems.map((t) => t.id),
                subcategoryId,
              })
            }
            onInternal={() =>
              bulkUpdate.mutate({
                ids: selectedItems.map((t) => t.id),
                excludeFromStats: true,
              })
            }
            onDelete={() => {
              if (
                window.confirm(
                  `Delete ${selectedItems.length} transaction${
                    selectedItems.length === 1 ? "" : "s"
                  }? Balances are reversed. This cannot be undone.`,
                )
              ) {
                bulkDelete.mutate(selectedItems.map((t) => t.id));
              }
            }}
            onClear={clearSelection}
          />
        )}

        {lastPage > 1 && (
          <div className="mb-2">
            <Pager page={filters.page} lastPage={lastPage} onGo={goToPage} />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <th className="w-8 py-2 pr-2">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          selectedItems.length > 0 && !allSelected;
                    }}
                    onChange={toggleAll}
                  />
                </th>
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
              {items.map((t) => (
                <TransactionRow
                  key={t.id}
                  transaction={t}
                  accountName={accountName}
                  currency={currencyOf(t.accountId)}
                  currencyOf={currencyOf}
                  filterAccountId={singleAccount ? filters.accountId : null}
                  subcategories={subcategories.data ?? []}
                  selected={selected.has(t.id)}
                  onToggleSelect={() => toggleOne(t.id)}
                  onSplit={() => setSplitting(t)}
                  onChange={invalidateAll}
                  onDelete={() => {
                    if (window.confirm("Delete this transaction?")) {
                      remove.mutate(t.id);
                    }
                  }}
                />
              ))}
              {transactions.isLoading && (
                <tr>
                  <td
                    colSpan={emptyColSpan}
                    className="py-6 text-center text-zinc-500"
                  >
                    Loading…
                  </td>
                </tr>
              )}
              {/* Without this the table just looks empty on a dropped
                  connection: isLoading is false, data is undefined, and the
                  "No transactions match." row below needs data to exist
                  before it renders — so a failed load was indistinguishable
                  from an account with nothing in it. */}
              {transactions.isError && (
                <tr>
                  <td colSpan={emptyColSpan} className="py-6 text-center">
                    <ErrorText error={transactions.error} />
                  </td>
                </tr>
              )}
              {transactions.data?.items.length === 0 && (
                <tr>
                  <td
                    colSpan={emptyColSpan}
                    className="py-6 text-center text-zinc-500"
                  >
                    No transactions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <ErrorText error={deleteError} />

        {lastPage > 1 && (
          <div className="mt-3">
            <Pager page={filters.page} lastPage={lastPage} onGo={goToPage} />
          </div>
        )}
      </Card>

      {splitting && (
        <SplitDialog
          transaction={splitting}
          currency={currencyOf(splitting.accountId)}
          subcategories={subcategories.data ?? []}
          onClose={() => setSplitting(null)}
          onDone={() => {
            setSplitting(null);
            invalidateAll();
          }}
        />
      )}

      {confirmingWipe && (
        <ConfirmPhrase
          title="Delete every transaction?"
          body={`This removes all ${total} transaction${
            total === 1 ? "" : "s"
          } across every account, and each account falls back to its starting balance. Imports, budgets and reminders stay, but the history they describe is gone. There is no undo.`}
          confirmLabel="Delete everything"
          busy={removeAll.isPending}
          onCancel={() => setConfirmingWipe(false)}
          onConfirm={() =>
            removeAll.mutate(undefined, {
              onSuccess: () => setConfirmingWipe(false),
            })
          }
        />
      )}
    </main>
  );
}

/** Sticky toolbar shown while rows are ticked: categorize, mark internal, or
 * delete the whole selection at once. */
function SelectionBar({
  selected,
  subcategories,
  busy,
  error,
  onCategorize,
  onInternal,
  onDelete,
  onClear,
}: {
  selected: Transaction[];
  subcategories: Subcategory[];
  busy: boolean;
  error: string | null;
  onCategorize: (subcategoryId: string) => void;
  onInternal: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const hasTransfer = selected.some((t) => t.type === "TRANSFER");
  const allIncome = selected.every((t) => t.type === "INCOME");
  const allExpense = selected.every((t) => t.type === "EXPENSE");
  // One category can only apply to rows of a single direction (and never to a
  // transfer), so categorize is offered only for a same-direction selection.
  const canCategorize = !hasTransfer && (allIncome || allExpense);
  const eligible = subcategories.filter((s) =>
    allIncome ? s.category === "Income" : s.category !== "Income",
  );

  return (
    <div className="mb-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {selected.length} selected
        </span>
        {canCategorize ? (
          <Select
            defaultValue=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) onCategorize(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="">Categorize…</option>
            <SubcategoryOptions subcategories={eligible} />
          </Select>
        ) : (
          <span
            className="text-zinc-400"
            title="Select rows of a single direction (all income or all expense, no transfers) to categorize them together."
          >
            Categorize (same direction only)
          </span>
        )}
        <Button
          variant="ghost"
          disabled={busy || hasTransfer}
          onClick={onInternal}
          title={
            hasTransfer
              ? "Transfers can't be marked internal."
              : "Exclude from income/spending stats."
          }
        >
          Mark internal
        </Button>
        <Button variant="danger" disabled={busy} onClick={onDelete}>
          Delete
        </Button>
        <button
          className="ml-auto text-zinc-500 hover:underline"
          onClick={onClear}
        >
          Clear
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}

type SplitPart = {
  amount: string;
  subcategoryId: string;
  description: string;
  internal: boolean;
};

/** Splits one expense/income into parts that must add up to the original. Used
 * for mixed charges (part groceries, part household) and shared bills (my share
 * + a "owed to me" bucket that a later payback reimburses). */
function SplitDialog({
  transaction: t,
  currency,
  subcategories,
  onClose,
  onDone,
}: {
  transaction: Transaction;
  currency: string;
  subcategories: Subcategory[];
  onClose: () => void;
  onDone: () => void;
}) {
  const eligible = subcategories.filter((s) =>
    t.type === "INCOME" ? s.category === "Income" : s.category !== "Income",
  );
  const firstEligible = eligible[0]?.id ?? "";
  const [parts, setParts] = useState<SplitPart[]>([
    {
      amount: (t.amount / 100).toFixed(2),
      subcategoryId: t.subcategoryId ?? firstEligible,
      description: "",
      internal: t.excludeFromStats,
    },
    { amount: "", subcategoryId: firstEligible, description: "", internal: false },
  ]);
  const [error, setError] = useState<string | null>(null);

  const cents = (s: string) => parseAmountToCents(s) ?? 0;
  const allocated = parts.reduce((sum, p) => sum + cents(p.amount), 0);
  const remaining = t.amount - allocated;

  const setPart = (i: number, patch: Partial<SplitPart>) =>
    setParts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const addPart = () =>
    setParts((prev) => [
      ...prev,
      {
        // Pre-fill the leftover so the split closes out in one keystroke.
        amount: remaining > 0 ? (remaining / 100).toFixed(2) : "",
        subcategoryId: firstEligible,
        description: "",
        internal: false,
      },
    ]);
  const removePart = (i: number) =>
    setParts((prev) => prev.filter((_, j) => j !== i));

  // Escape closes it, matching the multi-select and the welcome tour — this
  // was the one overlay in the app that trapped you into reaching for the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const split = useMutation({
    mutationFn: (body: { parts: Record<string, unknown>[] }) =>
      api(`/transactions/${t.id}/split`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const submit = () => {
    setError(null);
    if (parts.length < 2) {
      setError("A split needs at least two parts.");
      return;
    }
    for (const p of parts) {
      if (parseAmountToCents(p.amount) === null || cents(p.amount) < 1) {
        setError("Every part needs an amount (e.g. 12.50).");
        return;
      }
      if (!p.internal && !p.subcategoryId) {
        setError("Every part needs a category, or mark it internal.");
        return;
      }
    }
    if (remaining !== 0) {
      setError(
        `Parts must add up to ${formatCents(t.amount, currency)} — ${
          remaining > 0 ? formatCents(remaining, currency) + " left" : "over by " + formatCents(-remaining, currency)
        }.`,
      );
      return;
    }
    split.mutate({
      parts: parts.map((p) => ({
        amount: cents(p.amount),
        subcategoryId: p.internal ? undefined : p.subcategoryId,
        description: p.description || undefined,
        excludeFromStats: p.internal || undefined,
      })),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="mt-12 w-full max-w-xl rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-medium">
            Split {formatCents(t.amount, currency)}
            {t.description ? ` · ${t.description}` : ""}
          </h2>
          <button
            aria-label="Close"
            title="Close"
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {parts.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                value={p.amount}
                inputMode="decimal"
                placeholder="0.00"
                className="w-24 text-right"
                // Focus the first amount so the dialog is usable from the
                // keyboard the moment it opens.
                autoFocus={i === 0}
                onChange={(e) => setPart(i, { amount: e.target.value })}
              />
              <Select
                value={p.subcategoryId}
                disabled={p.internal}
                className="min-w-[9rem]"
                onChange={(e) => setPart(i, { subcategoryId: e.target.value })}
              >
                <SubcategoryOptions
                  subcategories={eligible}
                  keepId={p.subcategoryId}
                />
              </Select>
              <Input
                value={p.description}
                placeholder="note (optional)"
                className="flex-1"
                onChange={(e) => setPart(i, { description: e.target.value })}
              />
              <label className="flex items-center gap-1 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={p.internal}
                  onChange={(e) => setPart(i, { internal: e.target.checked })}
                />
                internal
              </label>
              <button
                className="text-zinc-400 hover:text-red-600 disabled:opacity-30"
                disabled={parts.length <= 2}
                onClick={() => removePart(i)}
                aria-label="Remove part"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <button className="text-emerald-600 hover:underline" onClick={addPart}>
            + Add part
          </button>
          <span
            className={
              remaining === 0
                ? "text-zinc-400"
                : "font-medium text-amber-600"
            }
          >
            {remaining === 0
              ? "adds up ✓"
              : remaining > 0
                ? `${formatCents(remaining, currency)} left`
                : `over by ${formatCents(-remaining, currency)}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={split.isPending || remaining !== 0}
            >
              Split
            </Button>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </div>
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
    // Five controls in a row: on a narrow phone they were wider than the
    // viewport and pushed the whole page sideways, since flex items do not
    // shrink below their content. The table above already scrolls in place.
    <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
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
 * Multi-select category filter. Native <details> disclosure so open/close needs
 * no state; the panel lists every category (grouped) with checkboxes, and the
 * transaction count above the table reflects the selection.
 */
function CategoryFilter({
  subcategories,
  selected,
  onChange,
}: {
  subcategories: Subcategory[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  // Order options by category (Income / Expenses / Bills / …) then name, so the
  // grouped dropdown reads top-down in the familiar order.
  const order = (c: string) => {
    const i = TRANSACTION_CATEGORIES.indexOf(c as (typeof TRANSACTION_CATEGORIES)[number]);
    return i === -1 ? TRANSACTION_CATEGORIES.length : i;
  };
  const options = [...subcategories]
    .sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name))
    .map((s) => ({ id: s.id, label: s.name, group: s.category }));

  return (
    <MultiSelect
      options={options}
      selected={selected}
      onChange={onChange}
      placeholder="All"
      searchPlaceholder="Search categories…"
    />
  );
}

/**
 * Refunds and paybacks that never got tied to the expense they repaid.
 *
 * Unlinked, such an income counts as fresh earnings *and* leaves the expense at
 * full price, so both sides of the month are overstated at once. The server
 * decides which income categories to watch from the links already made rather
 * than from any fixed list of names, so this works whatever the categories are
 * called (see listUnlinkedReimbursements).
 *
 * Collapsed by default and absent entirely when there is nothing to do: this is
 * a nudge, and a nudge that is always on screen stops being read.
 */
function UnlinkedReimbursements({
  currencyOf,
  onLinked,
}: {
  currencyOf: (id: string) => string;
  onLinked: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const unlinked = useQuery({
    queryKey: ["unlinked-reimbursements"],
    queryFn: () => api<Transaction[]>("/transactions/unlinked-reimbursements"),
  });

  const link = useMutation({
    mutationFn: (vars: { id: string; parentTransactionId: string }) =>
      api<Transaction>(`/transactions/${vars.id}/reimburses`, {
        method: "PATCH",
        body: JSON.stringify({
          parentTransactionId: vars.parentTransactionId,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["unlinked-reimbursements"],
      });
      onLinked();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const rows = unlinked.data ?? [];
  if (rows.length === 0) return null;

  // One sum is only meaningful within one currency; these are almost always in
  // the account currency the refunds arrived in, so it is shown per currency.
  const totals = rows.reduce<Record<string, number>>((acc, r) => {
    const c = currencyOf(r.accountId);
    acc[c] = (acc[c] ?? 0) + r.amount;
    return acc;
  }, {});

  return (
    <Card>
      <details>
        <summary className="cursor-pointer list-none text-sm">
          <span className="font-medium">
            {rows.length} refund{rows.length === 1 ? "" : "s"} not linked to an
            expense
          </span>{" "}
          <span className="text-zinc-500">
            ·{" "}
            {Object.entries(totals)
              .map(([c, amount]) => formatCents(amount, c))
              .join(" + ")}{" "}
            counting as income
          </span>
        </summary>
        <p className="mt-2 text-xs text-zinc-500">
          Linking one cancels it against the expense it repaid, instead of
          counting as money earned.
        </p>
        <ul className="mt-2 flex flex-col gap-3">
          {rows.map((r) => (
            <li
              key={r.id}
              className="border-t border-zinc-100 pt-2 dark:border-zinc-900"
            >
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="text-zinc-500 tabular-nums">
                  {formatDate(r.date)}
                </span>
                <span>{r.description || r.subcategory?.name || "income"}</span>
                <span className="text-zinc-400">
                  {r.subcategory?.name ?? ""}
                </span>
                <span className="ml-auto tabular-nums text-emerald-600">
                  {formatCents(r.amount, currencyOf(r.accountId))}
                </span>
              </div>
              <ReimbursePicker
                value=""
                currencyOf={currencyOf}
                onChange={(parentTransactionId) => {
                  if (!parentTransactionId) return;
                  setError(null);
                  link.mutate({ id: r.id, parentTransactionId });
                }}
              />
            </li>
          ))}
        </ul>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </details>
    </Card>
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
    `${formatDate(e.date)} · ${
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
  selected,
  onToggleSelect,
  onSplit,
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
  selected: boolean;
  onToggleSelect: () => void;
  onSplit: () => void;
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
  // Green is reserved for real money coming in (income, refunds, reimbursements).
  // Moves between your own accounts — transfers either way, and internal moves —
  // are grey, so they don't read as earnings.
  const isRealIncome = t.type === "INCOME" && !t.excludeFromStats;
  // A payback is money coming back, not money earned, so it gets a softer green
  // than real income. The label beside it carries the meaning; the shade only
  // echoes it, so the distinction is never colour-alone.
  const isPayback = isRealIncome && t.parentTransactionId !== null;

  // A repaid expense: how much came back, and whether that covers it. Paybacks
  // are shown in the currency they arrived in, and only compared against the
  // expense when they share its currency — a €120 credit against a tenge charge
  // says nothing about how much of it was covered.
  const paybacks =
    t.type === "EXPENSE" && !t.excludeFromStats ? t.reimbursements : [];
  const paybackCurrency =
    paybacks.length > 0 ? currencyOf(paybacks[0].accountId) : null;
  const paidBack = paybacks.reduce((sum, r) => sum + r.amount, 0);
  const comparable =
    paybacks.length > 0 &&
    paybacks.every((r) => currencyOf(r.accountId) === paybackCurrency) &&
    paybackCurrency === currency;
  // Over-repayment (a friend rounds up) still means the expense cost nothing.
  const fullyReimbursed = comparable && paidBack >= t.amount;
  const partlyReimbursed = paybacks.length > 0 && !fullyReimbursed;
  const netSpent = comparable ? Math.max(t.amount - paidBack, 0) : null;

  const color = fullyReimbursed
    ? "text-zinc-400"
    : isPayback
      ? "text-emerald-500/80"
      : isRealIncome
        ? "text-emerald-600"
        : t.type === "TRANSFER" || t.excludeFromStats
          ? "text-zinc-500"
          : "";
  // Fully repaid reads like a transfer — the money came back, so it is greyed
  // out. Partly repaid still cost something, so it stays legible and is only
  // faded enough to signal "not the whole story".
  const amountClass = partlyReimbursed ? `${color} opacity-70` : color;
  // Show a signed amount for transfers only when scoped to one account (so the
  // running balance reads correctly); otherwise keep them sign-less.
  const showSign = t.type !== "TRANSFER" || filterAccountId !== null;

  if (editing) {
    return (
      <tr className="border-b border-zinc-100 align-top dark:border-zinc-900">
        <td className="py-2 pr-2">
          <input
            type="checkbox"
            aria-label="Select transaction"
            checked={selected}
            onChange={onToggleSelect}
          />
        </td>
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
                <SubcategoryOptions
                  subcategories={eligible}
                  keepId={subcategoryId}
                />
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
      <td className="py-2 pr-2">
        <input
          type="checkbox"
          aria-label="Select transaction"
          checked={selected}
          onChange={onToggleSelect}
        />
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">{formatDate(t.date)}</td>
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
          <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
            reimbursement
          </span>
        )}
        {paybacks.length > 0 && (
          <span
            className={`ml-1.5 rounded px-1.5 py-0.5 text-xs ${
              fullyReimbursed
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            }`}
          >
            {fullyReimbursed
              ? "fully reimbursed"
              : // Show what it actually cost after the partial payback, so the
                // faded amount above does not have to be worked out by hand.
                `reimbursed ${
                  comparable
                    ? `${formatCents(paidBack, currency)} · ${formatCents(
                        netSpent ?? 0,
                        currency,
                      )} net`
                    : `${paybacks.length}×`
                }`}
          </span>
        )}
      </td>
      <td className="py-2 pr-3">{t.description ?? ""}</td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {accountName(t.accountId)}
        {t.type === "TRANSFER" && ` → ${accountName(t.counterAccountId)}`}
      </td>
      <td className={`py-2 pr-3 text-right whitespace-nowrap ${amountClass}`}>
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
          {t.type !== "TRANSFER" && (
            <button
              aria-label="Split transaction"
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              onClick={onSplit}
            >
              Split
            </button>
          )}
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
  // Focus returns here after a save, so entering a run of transactions is
  // Tab-forward all the way and never Shift+Tab back to the start.
  const typeRef = useRef<HTMLSelectElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Account and date are controlled so they survive the form reset: entering a
  // run of past transactions should not mean re-picking both every single time.
  const settings = useQuery({
    queryKey: ["telegram-settings"],
    queryFn: () => api<TelegramSettings>("/telegram/settings"),
  });
  // Only what the user actually picked is stored; "" means "not chosen yet" and
  // the default below stands in. Storing the resolved id instead meant an effect
  // writing state on every render pass that found it empty — and a default that
  // could not correct itself once the accounts or settings finished loading.
  const [accountChoice, setAccountChoice] = useState("");
  const [counterChoice, setCounterChoice] = useState("");
  const [date, setDate] = useState(todayISO());

  // Prefer the account chosen as default, else the first one.
  const preferred = settings.data?.defaultAccountId;
  const accountId =
    accountChoice ||
    (accounts.length === 0
      ? ""
      : preferred && accounts.some((a) => a.id === preferred)
        ? preferred
        : accounts[0].id);

  // Default the transfer destination to a different account than the source.
  const counterAccountId =
    counterChoice ||
    (accounts.length === 0
      ? ""
      : (accounts.find((a) => a.id !== accountId) ?? accounts[0]).id);

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
  //
  // set-state-in-effect is suppressed rather than satisfied here: the server
  // cannot read localStorage, so resolving this during render — a lazy
  // initializer — would emit markup the client disagrees with and break
  // hydration. Setting it after mount is the intended pattern, not a shortcut.
  useEffect(() => {
    const saved = window.localStorage.getItem(LAST_DATE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved)) setDate(saved);
  }, []);

  const eligibleSubcategories = subcategories.filter((s) =>
    type === "INCOME" ? s.category === "Income" : s.category !== "Income",
  );

  // Candidate parents for a reimbursement (only relevant for INCOME).
  // The expense this income reimburses — chosen via the same description search
  // as the import review and row editor, so any expense is reachable by name.
  const [parentId, setParentId] = useState("");
  const currencyOf = (id: string) =>
    accounts.find((a) => a.id === id)?.currency ?? "EUR";

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
    if (type === "INCOME" && !internal && parentId) {
      body.parentTransactionId = parentId;
    }
    const form_ = e.currentTarget;
    create.mutate(body, {
      onSuccess: () => {
        // Remember the date and clear the form only once it actually saved.
        // These two belong here for the same reason, and used to sit after the
        // mutate call: a failed save cleared "internal" and the reimbursement
        // link while leaving the rest of the form filled in, so retrying
        // silently posted an internal move as ordinary spending under whatever
        // category the select happened to be showing.
        window.localStorage.setItem(LAST_DATE_KEY, date);
        setInternal(false);
        setParentId("");
        form_.reset();
        typeRef.current?.focus();
      },
    });
  };

  return (
    <Card>
      <h2 className="mb-3 font-medium">Add transaction</h2>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Type">
          <Select
            ref={typeRef}
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
            onChange={(e) => setAccountChoice(e.target.value)}
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
              onChange={(e) => setCounterChoice(e.target.value)}
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
              <SubcategoryOptions subcategories={eligibleSubcategories} />
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
            <div className="w-56">
              <ReimbursePicker
                value={parentId}
                currencyOf={currencyOf}
                onChange={setParentId}
              />
            </div>
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
