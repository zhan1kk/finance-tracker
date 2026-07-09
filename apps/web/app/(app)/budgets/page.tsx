"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCents, parseAmountToCents } from "@/lib/format";
import {
  BUDGETABLE_CATEGORIES,
  type Budget,
  type Subcategory,
} from "@/lib/types";

export default function BudgetsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const currency = user?.baseCurrency ?? "EUR";

  const budgets = useQuery({
    queryKey: ["budgets"],
    queryFn: () => api<Budget[]>("/budgets"),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["budgets"] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/budgets", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });
  const updateLimit = useMutation({
    mutationFn: (vars: { id: string; monthlyLimit: number }) =>
      api(`/budgets/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ monthlyLimit: vars.monthlyLimit }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/budgets/${id}`, { method: "DELETE" }),
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
    create.mutate({
      monthlyLimit,
      ...(kind === "sub" ? { subcategoryId: value } : { category: value }),
    });
    e.currentTarget.reset();
  };

  const spendingSubs = (subcategories.data ?? []).filter(
    (s) => s.category !== "Income",
  );

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-medium">New budget</h2>
        <p className="mb-3 text-sm text-zinc-500">
          A monthly spending limit for a whole category or a single
          subcategory. Reimbursements you receive count against the spending.
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
          <Field label="Monthly limit">
            <Input name="limit" required placeholder="300.00" className="w-28" />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Add budget
          </Button>
        </form>
        <ErrorText error={error} />
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">
          This month
          <span className="ml-2 text-sm font-normal text-zinc-500">
            resets on the 1st
          </span>
        </h2>
        {budgets.data && budgets.data.length === 0 && (
          <p className="text-sm text-zinc-500">
            No budgets yet — add one above to keep a category in check.
          </p>
        )}
        <ul className="flex flex-col gap-4">
          {budgets.data?.map((budget) => (
            <BudgetRow
              key={budget.id}
              budget={budget}
              currency={currency}
              onEdit={() => {
                const raw = window.prompt(
                  "New monthly limit",
                  (budget.monthlyLimit / 100).toFixed(2),
                );
                if (raw === null) return;
                const cents = parseAmountToCents(raw);
                if (cents === null) {
                  setError(new Error("Invalid amount"));
                  return;
                }
                setError(null);
                updateLimit.mutate({ id: budget.id, monthlyLimit: cents });
              }}
              onDelete={() => {
                if (window.confirm("Delete this budget?")) {
                  setError(null);
                  remove.mutate(budget.id);
                }
              }}
            />
          ))}
        </ul>
      </Card>
    </main>
  );
}

function BudgetRow({
  budget,
  currency,
  onEdit,
  onDelete,
}: {
  budget: Budget;
  currency: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const name = budget.subcategory
    ? budget.subcategory.name
    : `${budget.category} (whole category)`;
  // Clamp both ways: net reimbursements can push percent below zero.
  const width = Math.min(100, Math.max(0, Math.round(budget.percent * 100)));

  return (
    <li>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-medium">{name}</span>
        <span className="text-sm tabular-nums text-zinc-500">
          {formatCents(budget.spentCents, currency)} of{" "}
          {formatCents(budget.monthlyLimit, currency)}
        </span>
        {budget.overBudget ? (
          <span className="text-sm font-medium text-red-600">
            over by {formatCents(-budget.remainingCents, currency)}
          </span>
        ) : (
          <span className="text-sm text-zinc-400">
            {formatCents(budget.remainingCents, currency)} left
          </span>
        )}
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <button
            aria-label="Delete budget"
            className="px-1 text-zinc-400 hover:text-red-600"
            onClick={onDelete}
          >
            ×
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
          className={`h-2 rounded ${
            budget.overBudget ? "bg-red-600" : "bg-zinc-500"
          }`}
          style={{ width: `${width}%` }}
        />
      </div>
    </li>
  );
}
