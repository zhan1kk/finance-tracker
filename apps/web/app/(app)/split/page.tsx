"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCents, parseAmountToCents, todayISO } from "@/lib/format";
import { useStickyState } from "@/lib/sticky-state";
import type {
  Friend,
  Settlement,
  SharedExpense,
  SplitBalances,
} from "@/lib/types";

/** The user themselves, as a party key in the form (sent as a null friend id). */
const YOU = "you";

/** Shared expenses and settlements accumulate for as long as you split things
 *  with people and are never cleaned up, so show the recent ones and fold the
 *  rest away — the same shape as the import and FX-rate histories. Both lists
 *  arrive newest-first (date desc), so slicing off the top is the recent end. */
const RECENT_ROWS = 10;

function RecentList<T>({
  rows,
  render,
  noun,
}: {
  rows: T[];
  render: (row: T) => ReactNode;
  noun: string;
}) {
  const recent = rows.slice(0, RECENT_ROWS);
  const older = rows.slice(RECENT_ROWS);
  const list = (items: T[]) => (
    <ul className="flex flex-col divide-y divide-zinc-100 text-sm dark:divide-zinc-900">
      {items.map(render)}
    </ul>
  );
  return (
    <>
      {list(recent)}
      {older.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            {older.length} older {noun}
            {older.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-1">{list(older)}</div>
        </details>
      )}
    </>
  );
}

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

  // Carried from a balance row's "Settle up" into the form below, rather than
  // recorded on the spot: settling a debt writes to the ledger, and a partial
  // payback is common enough that the amount wants reviewing before it lands.
  // `n` remounts the form so its fields re-initialise from the new values.
  const [prefill, setPrefill] = useState<{
    from: string;
    to: string;
    amount: string;
    n: number;
  } | null>(null);
  const settleRef = useRef<HTMLDivElement>(null);
  const settleUp = (b: SplitBalances["balances"][number]) => {
    setPrefill((prev) => ({
      from: b.fromId ?? YOU,
      to: b.toId ?? YOU,
      amount: (b.amountCents / 100).toFixed(2),
      n: (prev?.n ?? 0) + 1,
    }));
    settleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // The pairwise rows answer "who owes whom"; this answers "am I up or down",
  // which is the question you have before you want the detail.
  const rows = balances.data?.balances ?? [];
  const owedToYou = rows
    .filter((b) => b.toId === null)
    .reduce((a, b) => a + b.amountCents, 0);
  const youOwe = rows
    .filter((b) => b.fromId === null)
    .reduce((a, b) => a + b.amountCents, 0);

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-medium">Who owes whom</h2>
        <p className="mb-3 text-sm text-zinc-500">
          A standalone ledger for splitting costs with friends (just names — not
          real accounts). Record who paid and who shares it; this nets out the
          balances. Nothing here touches your transactions.
        </p>
        {balances.isLoading && (
          <p className="text-sm text-zinc-500">Loading…</p>
        )}
        {/* Without this the card just looks empty on a dropped connection:
            isLoading is false, data is undefined, and the empty-state message
            below needs data to exist before it renders. */}
        {balances.isError && <ErrorText error={balances.error} />}
        {balances.data && balances.data.balances.length === 0 && (
          <p className="text-sm text-zinc-500">All settled up. ✨</p>
        )}
        {(owedToYou > 0 || youOwe > 0) && (
          <p className="mb-3 flex flex-wrap gap-x-4 text-sm">
            {owedToYou > 0 && (
              <span>
                You are owed{" "}
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCents(owedToYou, balances.data!.currency)}
                </span>
              </span>
            )}
            {youOwe > 0 && (
              <span>
                You owe{" "}
                <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCents(youOwe, balances.data!.currency)}
                </span>
              </span>
            )}
          </p>
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
                <button
                  type="button"
                  className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
                  onClick={() => settleUp(b)}
                >
                  Settle up
                </button>
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
          // mutateAsync so the form clears only once the server accepted it.
          return addExpense.mutateAsync(body);
        }}
      />

      <div ref={settleRef}>
        <SettleForm
          key={prefill?.n ?? 0}
          friends={friendList}
          prefill={prefill}
          pending={addSettlement.isPending}
          onSubmit={(body) => {
            setError(null);
            return addSettlement.mutateAsync(body);
          }}
        />
      </div>

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
            addFriend.mutate(name, {
              onSuccess: () => {
                input.value = "";
              },
            });
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
                    // Refused server-side while they still appear in expenses,
                    // but confirm anyway — every other delete in the app does.
                    if (!window.confirm(`Remove ${f.name} from your friends?`))
                      return;
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
          <RecentList
            rows={settlements.data ?? []}
            noun="settlement"
            render={(s) => (
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
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Delete this settlement? The balances between you go back to what they were before it.",
                      )
                    )
                      return;
                    setError(null);
                    removeSettlement.mutate(s.id);
                  }}
                >
                  ×
                </button>
              </li>
            )}
          />
        </Card>
      )}

      {(expenses.data?.length ?? 0) > 0 && (
        <Card>
          <h2 className="mb-3 font-medium">Shared expenses</h2>
          <RecentList
            rows={expenses.data ?? []}
            noun="shared expense"
            render={(e) => (
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
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Delete this shared expense? Everyone's share of it is removed too.",
                      )
                    )
                      return;
                    setError(null);
                    removeExpense.mutate(e.id);
                  }}
                >
                  ×
                </button>
              </li>
            )}
          />
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
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [paidBy, setPaidBy] = useState(YOU);
  const [amount, setAmount] = useState("");
  // Sticky. Adding several expenses in a row almost always means the same
  // people, and re-ticking them every time was the most repeated action on the
  // page. Stored as an array — a Set does not survive JSON.
  const [amongKeys, setAmongKeys] = useStickyState<string[]>(
    "ft:split.among",
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

  const all = parties(friends);
  const toggle = (key: string) =>
    setAmong((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allSelected = among.size === all.length;
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
          <Button type="submit" disabled={pending || friends.length === 0}>
            Add expense
          </Button>
          {friends.length > 0 && (
            <Button type="button" variant="ghost" onClick={toggleAll}>
              {allSelected ? "Clear all" : "Select all"}
            </Button>
          )}
          {friends.length === 0 && (
            <span className="text-sm text-zinc-500">Add a friend first.</span>
          )}
        </div>
      </form>
    </Card>
  );
}

function SettleForm({
  friends,
  pending,
  prefill,
  onSubmit,
}: {
  friends: Friend[];
  pending: boolean;
  /** Direction and amount carried in from a balance row's "Settle up". */
  prefill?: { from: string; to: string; amount: string } | null;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const all = parties(friends);
  const [from, setFrom] = useState(prefill?.from ?? YOU);
  // Not seeded from friends[0]: on the first render the query has not resolved,
  // so friends is [] and the initial value stuck at "You" for the life of the
  // component. The form opened as "You paid You" — invalid until a dropdown was
  // touched. null means "not chosen yet", resolved against what has loaded.
  const [to, setTo] = useState<string | null>(prefill?.to ?? null);
  const toKey = to ?? friends[0]?.id ?? YOU;
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [showDetails, setShowDetails] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (friends.length === 0) return null;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalError(null);
    const data = new FormData(e.currentTarget);
    const cents = parseAmountToCents(amount);
    if (cents === null) return setLocalError("Invalid amount");
    if (from === toKey) return setLocalError("Pick two different people");
    const date = String(data.get("date") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    const form_ = e.currentTarget;
    void onSubmit({
      fromFriendId: from === YOU ? undefined : from,
      toFriendId: toKey === YOU ? undefined : toKey,
      amountCents: cents,
      // Both omitted unless filled in: the server dates an undated settlement
      // now, which is right for the overwhelmingly common "they just paid me".
      ...(date ? { date } : {}),
      ...(note ? { note } : {}),
    })
      .then(() => {
        form_.reset();
        setAmount("");
        setShowDetails(false);
      })
      .catch(() => {});
  };

  return (
    <Card>
      <h2 className="mb-3 font-medium">Settle up</h2>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
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
            <Select value={toKey} onChange={(e) => setTo(e.target.value)}>
              {all.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount">
            <Input
              name="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10.00"
              className="w-24"
            />
          </Field>
          <Button type="submit" disabled={pending}>
            Record
          </Button>
        </div>
        {/* Folded away rather than absent. Nearly every settlement is "they
            just paid me", where an untouched form is exactly right; the ones
            that are not — a payback from last week, or a note saying what it
            covered — had no way to be recorded at all. */}
        {showDetails ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Date">
              <Input name="date" type="date" defaultValue={todayISO()} />
            </Field>
            <Field label="Note">
              <Input
                name="note"
                placeholder="for the Berlin trip"
                className="w-56"
              />
            </Field>
          </div>
        ) : (
          <button
            type="button"
            className="self-start text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
            onClick={() => setShowDetails(true)}
          >
            Add a date or note
          </button>
        )}
      </form>
      {localError && <p className="mt-1 text-sm text-red-600">{localError}</p>}
    </Card>
  );
}
