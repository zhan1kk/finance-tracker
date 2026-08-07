"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCents, parseAmountToCents, todayISO } from "@/lib/format";
import type {
  Friend,
  Settlement,
  SharedExpense,
  SplitBalances,
} from "@/lib/types";

/** The user themselves, as a party key in the form (sent as a null friend id). */
const YOU = "you";

export default function SplitPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const currency = user?.baseCurrency ?? "EUR";
  const [error, setError] = useState<unknown>(null);

  const friends = useQuery({
    queryKey: ["friends"],
    queryFn: () => api<Friend[]>("/split/friends"),
  });
  const balances = useQuery({
    queryKey: ["split-balances"],
    queryFn: () => api<SplitBalances>("/split/balances"),
  });
  const expenses = useQuery({
    queryKey: ["shared-expenses"],
    queryFn: () => api<SharedExpense[]>("/split/expenses"),
  });
  const settlements = useQuery({
    queryKey: ["settlements"],
    queryFn: () => api<Settlement[]>("/split/settlements"),
  });

  const invalidate = () => {
    for (const k of ["friends", "split-balances", "shared-expenses", "settlements"])
      void qc.invalidateQueries({ queryKey: [k] });
  };

  const addFriend = useMutation({
    mutationFn: (name: string) =>
      api("/split/friends", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: invalidate,
    onError: setError,
  });
  const removeFriend = useMutation({
    mutationFn: (id: string) => api(`/split/friends/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });
  const addExpense = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/split/expenses", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });
  const removeExpense = useMutation({
    mutationFn: (id: string) => api(`/split/expenses/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });
  const addSettlement = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/split/settlements", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });
  const removeSettlement = useMutation({
    mutationFn: (id: string) =>
      api(`/split/settlements/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });

  const friendList = friends.data ?? [];
  const nameOf = (id: string | null) =>
    id === null ? "You" : (friendList.find((f) => f.id === id)?.name ?? "?");

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-medium">Who owes whom</h2>
        <p className="mb-3 text-sm text-zinc-500">
          A standalone ledger for splitting costs with friends (just names — not
          real accounts). Record who paid and who shares it; this nets out the
          balances. Nothing here touches your transactions.
        </p>
        {balances.data && balances.data.balances.length === 0 && (
          <p className="text-sm text-zinc-500">All settled up. ✨</p>
        )}
        <ul className="flex flex-col gap-1.5 text-sm">
          {balances.data?.balances.map((b, i) => {
            const involvesYou = b.fromId === null || b.toId === null;
            return (
              <li
                key={i}
                className={`flex flex-wrap items-center gap-x-1.5 ${
                  involvesYou ? "" : "text-zinc-500"
                }`}
              >
                <span className="font-medium">{b.fromName}</span>
                <span className="text-zinc-400">owes</span>
                <span className="font-medium">{b.toName}</span>
                <span className="ml-auto tabular-nums font-medium">
                  {formatCents(b.amountCents, balances.data!.currency)}
                </span>
              </li>
            );
          })}
        </ul>
        <ErrorText error={error} />
      </Card>

      <ExpenseForm
        friends={friendList}
        currency={currency}
        pending={addExpense.isPending}
        onSubmit={(body) => {
          setError(null);
          addExpense.mutate(body);
        }}
      />

      <SettleForm
        friends={friendList}
        pending={addSettlement.isPending}
        onSubmit={(body) => {
          setError(null);
          addSettlement.mutate(body);
        }}
      />

      <Card>
        <h2 className="mb-3 font-medium">Friends</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem(
              "name",
            ) as HTMLInputElement;
            const name = input.value.trim();
            if (!name) return;
            setError(null);
            addFriend.mutate(name);
            input.value = "";
          }}
          className="mb-3 flex items-end gap-2"
        >
          <Field label="Add a friend">
            <Input name="name" placeholder="Alex" className="w-40" />
          </Field>
          <Button type="submit" disabled={addFriend.isPending}>
            Add
          </Button>
        </form>
        {friendList.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No friends yet — add one to start splitting.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {friendList.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-sm dark:bg-zinc-800"
              >
                {f.name}
                <button
                  aria-label={`Remove ${f.name}`}
                  className="text-zinc-400 hover:text-red-600"
                  onClick={() => {
                    setError(null);
                    removeFriend.mutate(f.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(settlements.data?.length ?? 0) > 0 && (
        <Card>
          <h2 className="mb-3 font-medium">Settlements</h2>
          <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-900">
            {settlements.data?.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-2 py-1.5">
                <span>{s.date.slice(0, 10)}</span>
                <span className="font-medium">{nameOf(s.fromFriendId)}</span>
                <span className="text-zinc-400">paid</span>
                <span className="font-medium">{nameOf(s.toFriendId)}</span>
                {s.note && <span className="text-xs text-zinc-400">· {s.note}</span>}
                <span className="ml-auto tabular-nums text-zinc-500">
                  {formatCents(s.amountCents, s.currency)}
                </span>
                <button
                  aria-label="Delete settlement"
                  className="text-zinc-400 hover:text-red-600"
                  onClick={() => removeSettlement.mutate(s.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(expenses.data?.length ?? 0) > 0 && (
        <Card>
          <h2 className="mb-3 font-medium">Shared expenses</h2>
          <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-900">
            {expenses.data?.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-2 py-1.5">
                <span className="text-zinc-500">{e.date.slice(0, 10)}</span>
                <span className="font-medium">{e.description}</span>
                <span className="text-xs text-zinc-400">
                  · {nameOf(e.payerFriendId)} paid · split{" "}
                  {e.shares.map((s) => nameOf(s.friendId)).join(", ")}
                </span>
                <span className="ml-auto tabular-nums text-zinc-500">
                  {formatCents(e.amountCents, e.currency)}
                </span>
                <button
                  aria-label="Delete shared expense"
                  className="text-zinc-400 hover:text-red-600"
                  onClick={() => removeExpense.mutate(e.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}

/** Party options for a dropdown/checkboxes: You + each friend. */
function parties(friends: Friend[]): { key: string; name: string }[] {
  return [{ key: YOU, name: "You" }, ...friends.map((f) => ({ key: f.id, name: f.name }))];
}

function ExpenseForm({
  friends,
  currency,
  pending,
  onSubmit,
}: {
  friends: Friend[];
  currency: string;
  pending: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [paidBy, setPaidBy] = useState(YOU);
  const [among, setAmong] = useState<Set<string>>(new Set([YOU]));
  const [method, setMethod] = useState<"equal" | "exact">("equal");
  const [exact, setExact] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  const all = parties(friends);
  const toggle = (key: string) =>
    setAmong((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalError(null);
    const form = new FormData(e.currentTarget);
    const description = String(form.get("description") || "").trim();
    const total = parseAmountToCents(String(form.get("amount")));
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

    onSubmit({
      description,
      amountCents: total,
      date,
      payerFriendId: paidBy === YOU ? undefined : paidBy,
      splitMethod: method,
      participants,
    });
    e.currentTarget.reset();
    setAmong(new Set([YOU]));
    setExact({});
    setMethod("equal");
    setPaidBy(YOU);
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
            <Input name="amount" placeholder="30.00" className="w-24" />
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
          <p className="mb-1 text-sm text-zinc-500">Split among</p>
          <div className="flex flex-wrap gap-3">
            {all.map((p) => (
              <label key={p.key} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={among.has(p.key)}
                  onChange={() => toggle(p.key)}
                />
                {p.name}
                {method === "exact" && among.has(p.key) && (
                  <Input
                    value={exact[p.key] ?? ""}
                    onChange={(ev) =>
                      setExact((prev) => ({ ...prev, [p.key]: ev.target.value }))
                    }
                    placeholder="0.00"
                    className="w-20"
                  />
                )}
              </label>
            ))}
          </div>
        </div>

        {localError && <p className="text-sm text-red-600">{localError}</p>}
        <div>
          <Button type="submit" disabled={pending || friends.length === 0}>
            Add expense
          </Button>
          {friends.length === 0 && (
            <span className="ml-2 text-sm text-zinc-500">
              Add a friend first.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function SettleForm({
  friends,
  pending,
  onSubmit,
}: {
  friends: Friend[];
  pending: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const all = parties(friends);
  const [from, setFrom] = useState(YOU);
  const [to, setTo] = useState(friends[0]?.id ?? YOU);
  const [localError, setLocalError] = useState<string | null>(null);

  if (friends.length === 0) return null;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalError(null);
    const amount = parseAmountToCents(
      String(new FormData(e.currentTarget).get("amount")),
    );
    if (amount === null) return setLocalError("Invalid amount");
    if (from === to) return setLocalError("Pick two different people");
    onSubmit({
      fromFriendId: from === YOU ? undefined : from,
      toFriendId: to === YOU ? undefined : to,
      amountCents: amount,
    });
    e.currentTarget.reset();
  };

  return (
    <Card>
      <h2 className="mb-3 font-medium">Settle up</h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {all.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <span className="pb-2 text-sm text-zinc-400">paid</span>
        <Field label="To">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {all.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount">
          <Input name="amount" placeholder="10.00" className="w-24" />
        </Field>
        <Button type="submit" disabled={pending}>
          Record
        </Button>
      </form>
      {localError && <p className="mt-1 text-sm text-red-600">{localError}</p>}
    </Card>
  );
}
