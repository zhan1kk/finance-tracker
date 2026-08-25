"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, Field, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { formatPeriod, shiftPeriod } from "@/lib/period";
import type { Budget } from "@/lib/types";

const budgetName = (b: Budget) =>
  b.subcategory ? b.subcategory.name : `${b.category} (whole category)`;

/** One month's figures for a budget: spend, its limit, and whether it went over. */
type MonthInfo = { spent: number; limit: number; over: boolean };

/** A comparison cell: "spent / budget", spend in red when it went over. */
function MonthCell({
  info,
  currency,
}: {
  info: MonthInfo | null;
  currency: string;
}) {
  if (!info) return <span className="text-zinc-400">—</span>;
  return (
    <span className="tabular-nums">
      <span className={info.over ? "text-rose-600 dark:text-rose-400" : ""}>
        {formatCents(info.spent, currency)}
      </span>
      <span className="text-zinc-400"> / {formatCents(info.limit, currency)}</span>
    </span>
  );
}

/** Stat tile: a label over a number. */
function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "bad";
}) {
  // "good" is deliberately the plain ink colour: a grid where every tile is
  // coloured has no emphasis left to spend on the one that matters.
  const color =
    tone === "bad"
      ? "text-rose-600 dark:text-rose-400"
      : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>
        {value}
      </p>
    </div>
  );
}

/**
 * At-a-glance totals for the shown month: how much of the combined budget is
 * spent, what's left, and how many budgets are over.
 */
export function BudgetSummary({
  budgets,
  currency,
}: {
  budgets: Budget[];
  currency: string;
}) {
  if (budgets.length === 0) return null;
  const totalLimit = budgets.reduce((a, b) => a + b.limit, 0);
  const totalSpent = budgets.reduce((a, b) => a + b.spentCents, 0);
  const remaining = totalLimit - totalSpent;
  const pct = totalLimit > 0 ? totalSpent / totalLimit : 0;
  const overCount = budgets.filter((b) => b.overBudget).length;
  const width = Math.min(100, Math.max(0, Math.round(pct * 100)));
  const over = totalSpent > totalLimit;

  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Total budget" value={formatCents(totalLimit, currency)} />
        <Stat label="Spent" value={formatCents(totalSpent, currency)} />
        <Stat
          label={remaining < 0 ? "Over by" : "Remaining"}
          value={formatCents(Math.abs(remaining), currency)}
          tone={remaining < 0 ? "bad" : "good"}
        />
        <Stat
          label="Over budget"
          value={`${overCount} of ${budgets.length}`}
          tone={overCount > 0 ? "bad" : "good"}
        />
      </div>
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
          <span>{width}% of total budget used</span>
          <span className="tabular-nums">
            {formatCents(totalSpent, currency)} / {formatCents(totalLimit, currency)}
          </span>
        </div>
        <div className="h-2 rounded bg-zinc-100 dark:bg-zinc-800">
          <div
            className={`h-2 rounded ${
              over
                ? "bg-rose-400 dark:bg-rose-500/70"
                : "bg-emerald-400 dark:bg-emerald-500/70"
            }`}
            style={{ width: `${width}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/** A month <Select> over the last 12 periods (plus any explicitly passed). */
function MonthSelect({
  value,
  onChange,
  months,
  monthStartDay,
}: {
  value: string;
  onChange: (period: string) => void;
  months: string[];
  monthStartDay: number;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {months.map((m) => (
        <option key={m} value={m}>
          {formatPeriod(m, monthStartDay)}
        </option>
      ))}
    </Select>
  );
}

/**
 * Side-by-side spend for two months, per budgeted category, with the change
 * between them. Reads the same /budgets endpoint for each period and joins by
 * budget — so it reflects reimbursement-netted spending, exactly like the list.
 */
export function BudgetCompare({
  currentPeriod,
  monthStartDay,
  currency,
}: {
  currentPeriod: string;
  monthStartDay: number;
  currency: string;
}) {
  const [monthA, setMonthA] = useState(() => shiftPeriod(currentPeriod, -1));
  const [monthB, setMonthB] = useState(currentPeriod);

  // Last 12 months, newest first (union with whatever's selected, so a manually
  // picked older month stays valid).
  const recent = Array.from({ length: 12 }, (_, i) =>
    shiftPeriod(currentPeriod, -i),
  );
  const months = [...new Set([...recent, monthA, monthB])].sort((a, b) =>
    b.localeCompare(a),
  );

  const a = useQuery({
    queryKey: ["budgets", monthA],
    queryFn: () => api<Budget[]>(`/budgets?period=${monthA}`),
  });
  const b = useQuery({
    queryKey: ["budgets", monthB],
    queryFn: () => api<Budget[]>(`/budgets?period=${monthB}`),
  });

  const infoById = (list: Budget[] | undefined) => {
    const m = new Map<string, MonthInfo & { name: string }>();
    for (const bud of list ?? [])
      m.set(bud.id, {
        name: budgetName(bud),
        spent: bud.spentCents,
        limit: bud.limit,
        over: bud.overBudget,
      });
    return m;
  };
  const mapA = infoById(a.data);
  const mapB = infoById(b.data);

  const rows = [...new Set([...mapA.keys(), ...mapB.keys()])]
    .map((id) => {
      const ra = mapA.get(id) ?? null;
      const rb = mapB.get(id) ?? null;
      return { id, name: rb?.name ?? ra?.name ?? "—", a: ra, b: rb };
    })
    .sort((x, y) => (y.b?.spent ?? y.a?.spent ?? 0) - (x.b?.spent ?? x.a?.spent ?? 0));

  const total = (m: Map<string, MonthInfo & { name: string }>): MonthInfo => {
    const spent = [...m.values()].reduce((s, r) => s + r.spent, 0);
    const limit = [...m.values()].reduce((s, r) => s + r.limit, 0);
    return { spent, limit, over: spent > limit };
  };
  const totalA = total(mapA);
  const totalB = total(mapB);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="font-medium">Compare months</h2>
        <div className="flex items-end gap-2">
          <Field label="From">
            <MonthSelect
              value={monthA}
              onChange={setMonthA}
              months={months}
              monthStartDay={monthStartDay}
            />
          </Field>
          <span className="pb-2 text-sm text-zinc-400">vs</span>
          <Field label="To">
            <MonthSelect
              value={monthB}
              onChange={setMonthB}
              months={months}
              monthStartDay={monthStartDay}
            />
          </Field>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No budgeted spending in either month.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                <th className="py-1.5 pr-3 font-medium">Category</th>
                <th className="py-1.5 pr-3 text-right font-medium">
                  {formatPeriod(monthA, monthStartDay)}
                </th>
                <th className="py-1.5 pr-3 text-right font-medium">
                  {formatPeriod(monthB, monthStartDay)}
                </th>
                <th className="py-1.5 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                >
                  <td className="py-1.5 pr-3">{r.name}</td>
                  <td className="py-1.5 pr-3 text-right">
                    <MonthCell info={r.a} currency={currency} />
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    <MonthCell info={r.b} currency={currency} />
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Delta
                      a={r.a?.spent ?? null}
                      b={r.b?.spent ?? null}
                      currency={currency}
                    />
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-zinc-200 font-medium dark:border-zinc-700">
                <td className="py-1.5 pr-3">Total</td>
                <td className="py-1.5 pr-3 text-right">
                  <MonthCell info={totalA} currency={currency} />
                </td>
                <td className="py-1.5 pr-3 text-right">
                  <MonthCell info={totalB} currency={currency} />
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  <Delta a={totalA.spent} b={totalB.spent} currency={currency} />
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-400">
            Each cell is <span className="tabular-nums">spent / budget</span> (net
            of reimbursements); red spend went over that month&rsquo;s budget.
            Change compares spend — less is greener, more is redder.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Coloured change between two months' spend (▲ more = red, ▼ less = green). */
function Delta({
  a,
  b,
  currency,
}: {
  a: number | null;
  b: number | null;
  currency: string;
}) {
  if (a == null && b != null)
    return <span className="text-zinc-400">new</span>;
  if (a != null && b == null)
    return <span className="text-zinc-400">—</span>;
  if (a == null || b == null) return <span className="text-zinc-400">—</span>;
  const diff = b - a;
  if (diff === 0) return <span className="text-zinc-400">no change</span>;
  const up = diff > 0;
  const pct = a > 0 ? Math.round((diff / a) * 100) : null;
  return (
    <span
      className={
        up
          ? "text-rose-600 dark:text-rose-400"
          : "text-emerald-600 dark:text-emerald-400"
      }
    >
      {up ? "▲" : "▼"} {formatCents(Math.abs(diff), currency)}
      {pct != null && ` (${up ? "+" : ""}${pct}%)`}
    </span>
  );
}
