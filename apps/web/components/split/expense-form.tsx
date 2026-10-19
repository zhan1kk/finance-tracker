"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { formatCents, parseAmountToCents, todayISO } from "@/lib/format";
import { useStickyState } from "@/lib/sticky-state";
import { parties, YOU } from "./shared";

export function ExpenseForm({
  people,
  currency,
  pending,
  groupId,
  emptyHint,
  onSubmit,
}: {
  /** Who can share it: every friend, or a group's members. */
  people: { id: string; name: string }[];
  currency: string;
  pending: boolean;
  /** The group it is added to; null for none. */
  groupId: string | null;
  /** Said in place of the button when there is nobody to split with yet. */
  emptyHint: string;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [paidBy, setPaidBy] = useState(YOU);
  const [amount, setAmount] = useState("");
  // Sticky, per group. Adding several expenses in a row almost always means the
  // same people, and re-ticking them every time was the most repeated action on
  // the page. Stored as an array — a Set does not survive JSON.
  const [amongKeys, setAmongKeys] = useStickyState<string[]>(
    `ft:split.among:${groupId ?? "none"}`,
    [YOU],
    (saved) =>
      Array.isArray(saved) && saved.every((v) => typeof v === "string")
        ? (saved as string[])
        : null,
  );
  const among = new Set(amongKeys);
  const setAmong = (next: Set<string> | ((prev: Set<string>) => Set<string>)) =>
    setAmongKeys((prev) => [
      ...(typeof next === "function" ? next(new Set(prev)) : next),
    ]);
  const [method, setMethod] = useState<"equal" | "exact">("equal");
  const [exact, setExact] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  const all = parties(people);
  const toggle = (key: string) =>
    setAmong((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allSelected = all.every((p) => among.has(p.key));
  const toggleAll = () =>
    setAmong(allSelected ? new Set() : new Set(all.map((p) => p.key)));

  // Live split preview (a hint while filling the form).
  const totalCents = parseAmountToCents(amount);
  const selectedCount = all.filter((p) => among.has(p.key)).length;
  const equalShare =
    totalCents != null && selectedCount > 0
      ? Math.round(totalCents / selectedCount)
      : null;
  const exactSum = all
    .filter((p) => among.has(p.key))
    .reduce((a, p) => a + (parseAmountToCents(exact[p.key] ?? "") ?? 0), 0);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalError(null);
    const form = new FormData(e.currentTarget);
    const description = String(form.get("description") || "").trim();
    const total = totalCents;
    const date = String(form.get("date"));
    if (!description) return setLocalError("Give it a description");
    if (total === null) return setLocalError("Invalid amount — e.g. 30.00");
    const amongKeys = all.filter((p) => among.has(p.key)).map((p) => p.key);
    if (amongKeys.length === 0) return setLocalError("Pick who shares it");

    // Validate exact amounts before building the payload.
    if (method === "exact") {
      if (amongKeys.some((k) => parseAmountToCents(exact[k] ?? "") === null))
        return setLocalError("Enter an exact amount for each person");
      const sum = amongKeys.reduce(
        (a, k) => a + (parseAmountToCents(exact[k] ?? "") ?? 0),
        0,
      );
      if (sum !== total)
        return setLocalError(
          `Exact shares must add up to ${formatCents(total, currency)}`,
        );
    }

    const participants = amongKeys.map((key) => {
      const base: { friendId?: string; amountCents?: number } = {};
      if (key !== YOU) base.friendId = key;
      if (method === "exact")
        base.amountCents = parseAmountToCents(exact[key] ?? "") ?? 0;
      return base;
    });

    const form_ = e.currentTarget;
    void onSubmit({
      description,
      amountCents: total,
      date,
      payerFriendId: paidBy === YOU ? undefined : paidBy,
      splitMethod: method,
      participants,
      ...(groupId ? { groupId } : {}),
    })
      .then(() => {
        // Only on success: a rejected expense used to wipe the description,
        // amount, date, payer and every per-person share at once.
        form_.reset();
        setAmount("");
        // `among` deliberately survives: it is the thing you would have to
        // re-tick identically on the next expense.
        setExact({});
        setMethod("equal");
        setPaidBy(YOU);
      })
      .catch(() => {
        // The parent surfaces the error; keep what was typed so it can be fixed.
      });
  };

  return (
    <Card>
      <h2 className="mb-3 font-medium">Add a shared expense</h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="What">
            <Input name="description" placeholder="Dinner" className="w-40" />
          </Field>
          <Field label="Total">
            <Input
              name="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="30.00"
              className="w-24"
            />
          </Field>
          <Field label="Date">
            <Input name="date" type="date" defaultValue={todayISO()} required />
          </Field>
          <Field label="Paid by">
            <Select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              {all.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Split">
            <Select
              value={method}
              onChange={(e) => setMethod(e.target.value as "equal" | "exact")}
            >
              <option value="equal">equally</option>
              <option value="exact">exact amounts</option>
            </Select>
          </Field>
        </div>

        <div>
          <p className="mb-1.5 text-sm text-zinc-500">Split among</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {all.map((p) => (
              <label key={p.key} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={among.has(p.key)}
                  onChange={() => toggle(p.key)}
                />
                <span className={p.key === YOU ? "font-medium" : ""}>
                  {p.name}
                </span>
                {method === "exact" && among.has(p.key) && (
                  <Input
                    value={exact[p.key] ?? ""}
                    onChange={(ev) =>
                      setExact((prev) => ({ ...prev, [p.key]: ev.target.value }))
                    }
                    placeholder="0.00"
                    aria-label={`${p.name}'s share`}
                    className="w-20"
                  />
                )}
              </label>
            ))}
          </div>
          {/* Live preview so the split is tangible before saving. */}
          {method === "equal" && equalShare != null && (
            <p className="mt-1.5 text-xs text-zinc-500">
              Split {selectedCount} {selectedCount === 1 ? "way" : "ways"} · ≈{" "}
              {formatCents(equalShare, currency)} each
            </p>
          )}
          {method === "exact" && totalCents != null && selectedCount > 0 && (
            <p
              className={`mt-1.5 text-xs ${
                exactSum === totalCents
                  ? "text-emerald-600"
                  : exactSum > totalCents
                    ? "text-red-600"
                    : "text-zinc-500"
              }`}
            >
              {formatCents(exactSum, currency)} of{" "}
              {formatCents(totalCents, currency)}
              {exactSum !== totalCents &&
                ` · ${formatCents(Math.abs(totalCents - exactSum), currency)} ${
                  exactSum > totalCents ? "over" : "left"
                }`}
            </p>
          )}
        </div>

        {localError && <p className="text-sm text-red-600">{localError}</p>}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || people.length === 0}>
            Add expense
          </Button>
          {people.length > 0 && (
            <Button type="button" variant="ghost" onClick={toggleAll}>
              {allSelected ? "Clear all" : "Select all"}
            </Button>
          )}
          {people.length === 0 && (
            <span className="text-sm text-zinc-500">{emptyHint}</span>
          )}
        </div>
      </form>
    </Card>
  );
}
