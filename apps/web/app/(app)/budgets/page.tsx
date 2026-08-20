"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { BudgetCompare, BudgetSummary } from "@/components/budget-stats";
import { ConfirmPhrase } from "@/components/confirm-phrase";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCents, parseAmountToCents } from "@/lib/format";
import { formatPeriod, periodOf, shiftPeriod } from "@/lib/period";
import { revivePeriod, useStickyState } from "@/lib/sticky-state";
import {
  BUDGETABLE_CATEGORIES,
  type Budget,
  type Subcategory,
} from "@/lib/types";

export default function BudgetsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  // Same treatment as wiping transactions: irreversible, so it is typed.
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const currency = user?.baseCurrency ?? "EUR";
  const monthStartDay = user?.monthStartDay ?? 1;

  const currentPeriod = periodOf(new Date(), monthStartDay);
  const [period, setPeriod] = useStickyState<string | null>(
    "ft:budgets.period",
    null,
    revivePeriod,
  );
  const shown = period ?? currentPeriod;

  const budgets = useQuery({
    queryKey: ["budgets", shown],
    queryFn: () => api<Budget[]>(`/budgets?period=${shown}`),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });

  // Invalidate every period: an override changes only `shown`, but a create or
  // delete affects them all.
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["budgets"] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/budgets", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });
  const setMonthLimit = useMutation({
    mutationFn: (vars: { id: string; limit: number }) =>
      api(`/budgets/${vars.id}/periods/${shown}`, {
        method: "PUT",
        body: JSON.stringify({ limit: vars.limit }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });
  const resetMonth = useMutation({
    mutationFn: (id: string) =>
      api(`/budgets/${id}/periods/${shown}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });
  // Change a one-off budget's own limit (it has no separate default vs override).
  const updateLimit = useMutation({
    mutationFn: (vars: { id: string; limit: number }) =>
      api(`/budgets/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ monthlyLimit: vars.limit }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/budgets/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });
  const clearMonth = useMutation({
    mutationFn: () => api(`/budgets/month/${shown}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });
  const deleteAll = useMutation({
    mutationFn: () => api(`/budgets`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const scope = String(form.get("scope") || "");
    const monthlyLimit = parseAmountToCents(String(form.get("limit")));
    if (!scope || monthlyLimit === null) {
      setError(new Error("Pick a scope and a valid monthly limit"));
      return;
    }
    const [kind, value] = scope.split(":", 2);
    const oneOff = String(form.get("repeats")) === "oneoff";
    const form_ = e.currentTarget;
    create.mutate(
      {
        monthlyLimit,
        ...(kind === "sub" ? { subcategoryId: value } : { category: value }),
        ...(oneOff ? { oneOffPeriod: shown } : {}),
      },
      // A duplicate scope is a 409; keep the numbers so they can be adjusted.
      { onSuccess: () => form_.reset() },
    );
  };

  // Budgets are for variable spending only, so offer just Expenses subcategories.
  const spendingSubs = (subcategories.data ?? []).filter(
    (s) => s.category === "Expenses",
  );

  // "Clear this month" only does something when a budget has a per-month override
  // or is a one-off living in the shown month.
  const monthHasCustomizations = (budgets.data ?? []).some(
    (b) => b.isOverride || b.oneOffPeriod != null,
  );

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-medium">New budget</h2>
        <p className="mb-3 text-sm text-zinc-500">
          A monthly cap on <b>variable spending</b> — all of Expenses, or a
          single Expenses subcategory. (Bills, Subscriptions, Debts and Savings
          aren&rsquo;t budgeted — they&rsquo;re fixed or exact; track those with
          reminders.) This becomes the recurring default; you can override any
          single month below. Reimbursements count against the spending.
        </p>
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <Field label="Scope">
            <Select name="scope" defaultValue="">
              <option value="" disabled>
                Select…
              </option>
              <optgroup label="Whole category">
                {BUDGETABLE_CATEGORIES.map((c) => (
                  <option key={c} value={`cat:${c}`}>
                    {c}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Subcategory">
                {spendingSubs.map((s) => (
                  <option key={s.id} value={`sub:${s.id}`}>
                    {s.name} ({s.category})
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
          <Field label="Limit">
            <Input name="limit" required placeholder="300.00" className="w-28" />
          </Field>
          <Field label="Repeats">
            <Select name="repeats" defaultValue="recurring">
              <option value="recurring">Every month</option>
              <option value="oneoff">
                Only {formatPeriod(shown, monthStartDay)}
              </option>
            </Select>
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Add budget
          </Button>
        </form>
        <ErrorText error={error} />
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            aria-label="Previous month"
            onClick={() => setPeriod(shiftPeriod(shown, -1))}
          >
            ‹
          </Button>
          <h2 className="font-medium">{formatPeriod(shown, monthStartDay)}</h2>
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
          <div className="ml-auto flex flex-wrap gap-2">
            {monthHasCustomizations && (
              <Button
                variant="ghost"
                title="Revert every budget's custom limit for this month, and delete one-off budgets in it"
                onClick={() => {
                  if (
                    window.confirm(
                      `Clear all budget customizations for ${formatPeriod(
                        shown,
                        monthStartDay,
                      )}? This reverts custom monthly limits to their default and deletes one-off budgets in this month.`,
                    )
                  ) {
                    setError(null);
                    clearMonth.mutate();
                  }
                }}
              >
                Clear this month
              </Button>
            )}
            {(budgets.data?.length ?? 0) > 0 && (
              <button
                className="px-1 text-sm text-zinc-400 hover:text-red-600"
                title="Delete every budget, all months"
                onClick={() => {
                  setError(null);
                  setConfirmingWipe(true);
                }}
              >
                Delete all
              </button>
            )}
          </div>
        </div>
        {budgets.data && budgets.data.length === 0 && (
          <p className="text-sm text-zinc-500">
            No budgets yet — add one above to keep a category in check.
          </p>
        )}
        <BudgetSummary budgets={budgets.data ?? []} currency={currency} />
        <ul className="flex flex-col gap-4">
          {budgets.data?.map((budget) => (
            <BudgetRow
              key={budget.id}
              budget={budget}
              currency={currency}
              monthLabel={formatPeriod(shown, monthStartDay)}
              onEdit={() => {
                const isOneOff = budget.oneOffPeriod != null;
                const raw = window.prompt(
                  isOneOff
                    ? `Limit for ${formatPeriod(shown, monthStartDay)} (this-month-only budget)`
                    : `Limit for ${formatPeriod(shown, monthStartDay)}`,
                  (budget.limit / 100).toFixed(2),
                );
                if (raw === null) return;
                const cents = parseAmountToCents(raw);
                if (cents === null || cents < 1) {
                  setError(new Error("Invalid amount"));
                  return;
                }
                setError(null);
                // A one-off has no separate default vs override — edit its own
                // limit; a recurring budget gets a per-month override instead.
                if (isOneOff) updateLimit.mutate({ id: budget.id, limit: cents });
                else setMonthLimit.mutate({ id: budget.id, limit: cents });
              }}
              onReset={
                budget.isOverride && budget.oneOffPeriod == null
                  ? () => {
                      setError(null);
                      resetMonth.mutate(budget.id);
                    }
                  : undefined
              }
              onDelete={() => {
                const msg =
                  budget.oneOffPeriod != null
                    ? "Delete this one-off budget?"
                    : "Delete this budget (all months)?";
                if (window.confirm(msg)) {
                  setError(null);
                  remove.mutate(budget.id);
                }
              }}
            />
          ))}
        </ul>
      </Card>

      <BudgetCompare
        currentPeriod={currentPeriod}
        monthStartDay={monthStartDay}
        currency={currency}
      />

      {confirmingWipe && (
        <ConfirmPhrase
          title="Delete every budget?"
          body="This removes all budgets in every category and every month, including one-off ones. Your transactions are untouched, but the limits and their history are gone for good."
          confirmLabel="Delete all budgets"
          busy={deleteAll.isPending}
          onCancel={() => setConfirmingWipe(false)}
          onConfirm={() =>
            deleteAll.mutate(undefined, {
              onSuccess: () => setConfirmingWipe(false),
            })
          }
        />
      )}
    </main>
  );
}

function BudgetRow({
  budget,
  currency,
  monthLabel,
  onEdit,
  onReset,
  onDelete,
}: {
  budget: Budget;
  currency: string;
  monthLabel: string;
  onEdit: () => void;
  onReset?: () => void;
  onDelete: () => void;
}) {
  const name = budget.subcategory
    ? budget.subcategory.name
    : `${budget.category} (whole category)`;
  // Clamp both ways: net reimbursements can push percent below zero.
  const width = Math.min(100, Math.max(0, Math.round(budget.percent * 100)));

  // Under budget → green; landed exactly on the limit (a fixed installment like
  // a TV plan spends its budget in full every month) → blue; over → red.
  const status = budget.overBudget
    ? "over"
    : budget.limit > 0 && budget.spentCents === budget.limit
      ? "full"
      : "under";
  const barColor =
    status === "over"
      ? "bg-red-600"
      : status === "full"
        ? "bg-blue-600"
        : "bg-emerald-600";

  return (
    <li>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-medium">{name}</span>
        <span className="text-sm tabular-nums text-zinc-500">
          {formatCents(budget.spentCents, currency)} of{" "}
          {formatCents(budget.limit, currency)}
        </span>
        {budget.oneOffPeriod != null && (
          <span
            className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-700 dark:bg-sky-950 dark:text-sky-300"
            title="Applies to this month only"
          >
            this month only
          </span>
        )}
        {budget.isOverride && budget.oneOffPeriod == null && (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300"
            title={`Custom for ${monthLabel}; default is ${formatCents(
              budget.monthlyLimit,
              currency,
            )}`}
          >
            custom
          </span>
        )}
        {status === "over" ? (
          <span className="text-sm font-medium text-red-600">
            over by {formatCents(-budget.remainingCents, currency)}
          </span>
        ) : status === "full" ? (
          <span className="text-sm font-medium text-blue-600">fully used</span>
        ) : (
          <span className="text-sm text-emerald-600">
            {formatCents(budget.remainingCents, currency)} left
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          {onReset && (
            <Button variant="ghost" onClick={onReset} title="Revert to default">
              Reset
            </Button>
          )}
          <button
            aria-label="Delete budget (all months)"
            title="Delete this budget entirely (every month)"
            className="px-1 text-sm text-zinc-400 hover:text-red-600"
            onClick={onDelete}
          >
            Delete
          </button>
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(budget.percent * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${name} budget usage`}
        className="h-2 rounded bg-zinc-100 dark:bg-zinc-800"
      >
        <div
          className={`h-2 rounded ${barColor}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </li>
  );
}
