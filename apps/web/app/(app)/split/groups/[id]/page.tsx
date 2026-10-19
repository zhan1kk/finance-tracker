"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PromptDialog } from "@/components/prompt-dialog";
import { useSplitActions } from "@/components/split/actions";
import { ExpenseForm } from "@/components/split/expense-form";
import { SplitHistory } from "@/components/split/history";
import { SettleForm, type SettlePrefill } from "@/components/split/settle-form";
import {
  BalanceRows,
  nameFinder,
  scopeQuery,
  useSplitInvalidate,
  YOU,
  YourPosition,
} from "@/components/split/shared";
import { Button, Card, ErrorText, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type {
  Friend,
  Settlement,
  SharedExpense,
  SplitBalance,
  SplitBalances,
  SplitGroup,
} from "@/lib/types";

/** One group: who is in it, who owes whom inside it, and its history. */
export default function SplitGroupPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const currency = user?.baseCurrency ?? "EUR";
  const [error, setError] = useState<unknown>(null);
  const [renaming, setRenaming] = useState(false);
  const actions = useSplitActions(setError);
  const invalidate = useSplitInvalidate();

  const group = useQuery({
    queryKey: ["split-groups", id],
    queryFn: () => api<SplitGroup>(`/split/groups/${id}`),
  });
  const groups = useQuery({
    queryKey: ["split-groups"],
    queryFn: () => api<SplitGroup[]>("/split/groups"),
  });
  const friends = useQuery({
    queryKey: ["friends"],
    queryFn: () => api<Friend[]>("/split/friends"),
  });
  const balances = useQuery({
    queryKey: ["split-balances", id],
    queryFn: () => api<SplitBalances>(`/split/balances${scopeQuery(id)}`),
  });
  const expenses = useQuery({
    queryKey: ["shared-expenses", id],
    queryFn: () => api<SharedExpense[]>(`/split/expenses${scopeQuery(id)}`),
  });
  const settlements = useQuery({
    queryKey: ["settlements", id],
    queryFn: () => api<Settlement[]>(`/split/settlements${scopeQuery(id)}`),
  });

  const opts = { onSuccess: invalidate, onError: setError };
  const addMember = useMutation({
    mutationFn: (friendId: string) =>
      api(`/split/groups/${id}/members`, {
        method: "POST",
        body: JSON.stringify({ friendId }),
      }),
    ...opts,
  });
  const removeMember = useMutation({
    mutationFn: (friendId: string) =>
      api(`/split/groups/${id}/members/${friendId}`, { method: "DELETE" }),
    ...opts,
  });
  const rename = useMutation({
    mutationFn: (name: string) =>
      api(`/split/groups/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setRenaming(false);
      invalidate();
    },
    onError: setError,
  });
  const removeGroup = useMutation({
    mutationFn: () => api(`/split/groups/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      router.push("/split");
    },
    onError: setError,
  });

  const [prefill, setPrefill] = useState<(SettlePrefill & { n: number }) | null>(
    null,
  );
  const settleRef = useRef<HTMLDivElement>(null);
  const settleUp = (b: SplitBalance) => {
    setPrefill((prev) => ({
      from: b.fromId ?? YOU,
      to: b.toId ?? YOU,
      amount: (b.amountCents / 100).toFixed(2),
      n: (prev?.n ?? 0) + 1,
    }));
    settleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const back = (
    <Link href="/split" className="text-sm text-zinc-500 hover:underline">
      ← All splits
    </Link>
  );

  if (group.isLoading)
    return (
      <main className="flex flex-col gap-4">
        {back}
        <p className="text-sm text-zinc-500">Loading…</p>
      </main>
    );
  if (group.isError || !group.data)
    return (
      <main className="flex flex-col gap-4">
        {back}
        <ErrorText error={group.error ?? "This group could not be loaded."} />
      </main>
    );

  const g = group.data;
  const members = g.members;
  const nameOf = nameFinder(friends.data ?? []);
  const notMembers = (friends.data ?? []).filter(
    (f) => !members.some((m) => m.id === f.id),
  );
  const moveTargets = [
    { id: null, name: "Not in a group" },
    ...(groups.data ?? [])
      .filter((other) => other.id !== g.id)
      .map((other) => ({ id: other.id, name: other.name })),
  ];
  const empty = g.expenseCount + g.settlementCount === 0;

  return (
    <main className="flex flex-col gap-6">
      {back}
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-lg font-medium">{g.name}</h2>
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${
              g.settled
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {g.settled ? "Settled" : empty ? "Nothing added yet" : "Open"}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button variant="ghost" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            {/* Only an empty group can go — its expenses are debts. */}
            {empty && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (!window.confirm(`Delete the group "${g.name}"?`)) return;
                  setError(null);
                  removeGroup.mutate();
                }}
              >
                Delete
              </Button>
            )}
          </span>
        </div>

        <p className="mb-1.5 text-sm text-zinc-500">Members</p>
        <ul className="mb-3 flex flex-wrap gap-2">
          {members.length === 0 && (
            <li className="text-sm text-zinc-400">
              Nobody yet — add who this group is with.
            </li>
          )}
          {members.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-sm dark:bg-zinc-800"
            >
              {m.name}
              <button
                aria-label={`Remove ${m.name} from ${g.name}`}
                className="text-zinc-400 hover:text-red-600"
                onClick={() => {
                  if (!window.confirm(`Remove ${m.name} from "${g.name}"?`))
                    return;
                  setError(null);
                  removeMember.mutate(m.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <AddMember
          candidates={notMembers}
          busy={addMember.isPending || actions.addFriend.isPending}
          onAdd={(friendId) => {
            setError(null);
            addMember.mutate(friendId);
          }}
          onCreate={(name, done) => {
            setError(null);
            // A new friend joins straight in: they were typed here for this.
            actions.addFriend.mutate(name, {
              onSuccess: (friend) =>
                addMember.mutate(friend.id, { onSuccess: done }),
            });
          }}
        />
        <ErrorText error={error} />
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">Who owes whom in {g.name}</h2>
        {balances.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {balances.isError && <ErrorText error={balances.error} />}
        {balances.data && balances.data.balances.length === 0 && (
          <p className="text-sm text-zinc-500">
            {empty ? "Nothing spent in this group yet." : "Everyone is square. ✨"}
          </p>
        )}
        {balances.data && (
          <>
            <YourPosition
              balances={balances.data.balances}
              currency={balances.data.currency}
            />
            <BalanceRows
              balances={balances.data.balances}
              currency={balances.data.currency}
              onSettleUp={settleUp}
            />
          </>
        )}
      </Card>

      <ExpenseForm
        people={members}
        currency={currency}
        pending={actions.addExpense.isPending}
        groupId={g.id}
        emptyHint="Add a member first."
        onSubmit={(body) => {
          setError(null);
          return actions.addExpense.mutateAsync(body);
        }}
      />

      <div ref={settleRef}>
        <SettleForm
          key={prefill?.n ?? 0}
          people={members}
          prefill={prefill}
          pending={actions.addSettlement.isPending}
          groupId={g.id}
          onSubmit={(body) => {
            setError(null);
            return actions.addSettlement.mutateAsync(body);
          }}
        />
      </div>

      <SplitHistory
        expenses={expenses}
        settlements={settlements}
        nameOf={nameOf}
        moveTargets={moveTargets}
        onMoveExpense={(expenseId, groupId) => {
          setError(null);
          actions.moveExpense.mutate({ id: expenseId, groupId });
        }}
        onMoveSettlement={(settlementId, groupId) => {
          setError(null);
          actions.moveSettlement.mutate({ id: settlementId, groupId });
        }}
        onDeleteExpense={(expenseId) => {
          setError(null);
          actions.removeExpense.mutate(expenseId);
        }}
        onDeleteSettlement={(settlementId) => {
          setError(null);
          actions.removeSettlement.mutate(settlementId);
        }}
      />

      {renaming && (
        <PromptDialog
          title="Rename group"
          label="Name"
          initialValue={g.name}
          confirmLabel="Rename"
          busy={rename.isPending}
          validate={(raw) => (raw.trim() ? null : "Give it a name")}
          onSubmit={(raw) => rename.mutate(raw.trim())}
          onCancel={() => setRenaming(false)}
        />
      )}
    </main>
  );
}

/** Add an existing friend to the group, or someone new straight into it. */
function AddMember({
  candidates,
  busy,
  onAdd,
  onCreate,
}: {
  candidates: Friend[];
  busy: boolean;
  onAdd: (friendId: string) => void;
  onCreate: (name: string, done: () => void) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {candidates.length > 0 && (
        <Select
          aria-label="Add a friend to this group"
          value=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) onAdd(e.target.value);
          }}
        >
          <option value="">Add a friend…</option>
          {candidates.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          onCreate(trimmed, () => setName(""));
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="or someone new"
          aria-label="New friend's name"
          className="w-40"
        />
        <Button type="submit" variant="ghost" disabled={busy}>
          Add
        </Button>
      </form>
    </div>
  );
}
