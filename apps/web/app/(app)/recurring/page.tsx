"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents, parseAmountToCents, todayISO } from "@/lib/format";
import {
  type Account,
  RECURRING_CADENCES,
  type RecurringCadence,
  type RecurringRule,
  type Subcategory,
} from "@/lib/types";

const CADENCE_UNIT: Record<RecurringCadence, string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};

function cadenceLabel(cadence: RecurringCadence, interval: number): string {
  if (interval === 1) {
    return { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" }[
      cadence
    ];
  }
  return `every ${interval} ${CADENCE_UNIT[cadence]}s`;
}

export default function RecurringPage() {
  const queryClient = useQueryClient();

  const rules = useQuery({
    queryKey: ["recurring"],
    queryFn: () => api<RecurringRule[]>("/recurring"),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["recurring"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["budgets"] });
  };

  const runNow = useMutation({
    mutationFn: () =>
      api<{ transactionsCreated: number }>("/recurring/run", { method: "POST" }),
    onSuccess: invalidate,
  });

  const removeAll = useMutation({
    mutationFn: () => api<{ deleted: number }>("/recurring", { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const hasRules = (rules.data?.length ?? 0) > 0;

  return (
    <main className="flex flex-col gap-6">
      <NewRule onCreated={invalidate} />

      <Card>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-medium">Scheduled transactions</h2>
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
          >
            Post due now
          </Button>
          {hasRules && (
            <Button
              variant="danger"
              onClick={() => {
                if (
                  window.confirm(
                    "Delete ALL recurring rules? Transactions they already posted stay put. This cannot be undone.",
                  )
                ) {
                  removeAll.mutate();
                }
              }}
              disabled={removeAll.isPending}
            >
              Delete all
            </Button>
          )}
        </div>
        {runNow.data && (
          <p className="mb-2 text-sm text-emerald-600">
            Posted {runNow.data.transactionsCreated} transaction
            {runNow.data.transactionsCreated === 1 ? "" : "s"}.
          </p>
        )}
        {rules.data && rules.data.length === 0 && (
          <p className="text-sm text-zinc-500">
            No recurring transactions yet. Add rent, salary, or a subscription
            above and it posts itself on schedule.
          </p>
        )}
        <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {rules.data?.map((rule) => (
            <RuleRow key={rule.id} rule={rule} onChange={invalidate} />
          ))}
        </ul>
      </Card>
    </main>
  );
}

function RuleRow({
  rule,
  onChange,
}: {
  rule: RecurringRule;
  onChange: () => void;
}) {
  const setActive = useMutation({
    mutationFn: (active: boolean) =>
      api(`/recurring/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      }),
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () => api(`/recurring/${rule.id}`, { method: "DELETE" }),
    onSuccess: onChange,
  });

  const currency = rule.account.currency;
  const sign = rule.type === "INCOME" ? "+" : "−";

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
      <div className="min-w-40">
        <p className="font-medium">
          {rule.description || rule.subcategory.name}
          {!rule.active && (
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-normal text-zinc-500 dark:bg-zinc-800">
              paused
            </span>
          )}
        </p>
        <p className="text-xs text-zinc-500">
          {rule.subcategory.name} · {rule.account.name}
        </p>
      </div>

      <div className="text-sm">
        <span className={rule.type === "INCOME" ? "text-emerald-600" : ""}>
          {sign}
          {formatCents(rule.amount, currency)}
        </span>{" "}
        <span className="text-zinc-500">
          {cadenceLabel(rule.cadence, rule.interval)}
        </span>
      </div>

      {rule.maxOccurrences ? (
        <div className="w-32 text-xs text-zinc-500">
          <div className="mb-0.5">
            {rule.occurrencesCreated} / {rule.maxOccurrences} paid
          </div>
          <span className="block h-1.5 rounded bg-zinc-200 dark:bg-zinc-800">
            <span
              className="block h-1.5 rounded bg-zinc-500"
              style={{ width: `${Math.round((rule.progress ?? 0) * 100)}%` }}
            />
          </span>
        </div>
      ) : (
        <div className="text-xs text-zinc-500">
          {rule.active ? `next ${rule.nextRunAt.slice(0, 10)}` : "—"}
        </div>
      )}

      <div className="ml-auto flex items-center gap-3 text-sm">
        <span className="text-zinc-400">
          ~{formatCents(rule.annualizedCents, currency)}/yr
        </span>
        <Button
          variant="ghost"
          onClick={() => setActive.mutate(!rule.active)}
          disabled={setActive.isPending}
        >
          {rule.active ? "Pause" : "Resume"}
        </Button>
        <button
          aria-label="Delete rule"
          className="text-zinc-400 hover:text-red-600"
          onClick={() => {
            if (window.confirm("Delete this recurring rule?")) remove.mutate();
          }}
        >
          ×
        </button>
      </div>
    </li>
  );
}

function NewRule({ onCreated }: { onCreated: () => void }) {
  const [type, setType] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [error, setError] = useState<unknown>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });
  const eligible = (subcategories.data ?? []).filter((s) =>
    type === "INCOME" ? s.category === "Income" : s.category !== "Income",
  );

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/recurring", { method: "POST", body: JSON.stringify(body) }),
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
    const maxRaw = String(form.get("maxOccurrences") || "").trim();
    const endRaw = String(form.get("endDate") || "").trim();
    const form_ = e.currentTarget;
    create.mutate(
      {
        type,
        amount,
        accountId: String(form.get("accountId")),
        subcategoryId: String(form.get("subcategoryId")),
        cadence: String(form.get("cadence")),
        interval: Number(form.get("interval")) || 1,
        startDate: String(form.get("startDate")),
        description: String(form.get("description") || "") || undefined,
        ...(endRaw ? { endDate: endRaw } : {}),
        ...(maxRaw ? { maxOccurrences: Number(maxRaw) } : {}),
      },
      // Nine fields: losing them to a failed save is the worst case in the app.
      { onSuccess: () => form_.reset() },
    );
  };

  return (
    <Card>
      <h2 className="mb-3 font-medium">New recurring transaction</h2>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Type">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as "EXPENSE" | "INCOME")}
          >
            <option value="EXPENSE">Expense</option>
            <option value="INCOME">Income</option>
          </Select>
        </Field>
        <Field label="Amount">
          <Input name="amount" required placeholder="12.50" className="w-24" />
        </Field>
        <Field label="Account">
          <Select name="accountId" required>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category">
          <Select name="subcategoryId" required>
            {eligible.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Every">
          <Input
            name="interval"
            type="number"
            min={1}
            defaultValue={1}
            className="w-16"
          />
        </Field>
        <Field label="Period">
          <Select name="cadence" defaultValue="MONTHLY">
            {RECURRING_CADENCES.map((c) => (
              <option key={c} value={c}>
                {CADENCE_UNIT[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Starts">
          <Input name="startDate" type="date" defaultValue={todayISO()} required />
        </Field>
        <Field label="Ends (optional)">
          <Input name="endDate" type="date" />
        </Field>
        <Field label="Installments (optional)">
          <Input
            name="maxOccurrences"
            type="number"
            min={1}
            placeholder="∞"
            className="w-24"
          />
        </Field>
        <Field label="Note">
          <Input name="description" placeholder="optional" className="w-32" />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          Add
        </Button>
      </form>
      <ErrorText error={error} />
    </Card>
  );
}
