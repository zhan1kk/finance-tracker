"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useSplitActions } from "@/components/split/actions";
import { ExpenseForm } from "@/components/split/expense-form";
import { FriendsCard } from "@/components/split/friends-card";
import { GroupsCard } from "@/components/split/groups-card";
import { SplitHistory } from "@/components/split/history";
import { SettleForm, type SettlePrefill } from "@/components/split/settle-form";
import {
  BalanceRows,
  nameFinder,
  NO_GROUP,
  scopeQuery,
  YOU,
  YourPosition,
} from "@/components/split/shared";
import { Card, ErrorText } from "@/components/ui";
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

/**
 * The split overview: where you stand overall, the groups, and everything not
 * in one. A group's own money lives on its page, so a finished trip is out of
 * the way here once it is settled.
 */
export default function SplitPage() {
  const { user } = useAuth();
  const currency = user?.baseCurrency ?? "EUR";
  const [error, setError] = useState<unknown>(null);
  const actions = useSplitActions(setError);

  const friends = useQuery({
    queryKey: ["friends"],
    queryFn: () => api<Friend[]>("/split/friends"),
  });
  const groups = useQuery({
    queryKey: ["split-groups"],
    queryFn: () => api<SplitGroup[]>("/split/groups"),
  });
  const overall = useQuery({
    queryKey: ["split-balances", "all"],
    queryFn: () => api<SplitBalances>("/split/balances"),
  });
  const outside = useQuery({
    queryKey: ["split-balances", NO_GROUP],
    queryFn: () => api<SplitBalances>(`/split/balances${scopeQuery(NO_GROUP)}`),
  });
  const expenses = useQuery({
    queryKey: ["shared-expenses", NO_GROUP],
    queryFn: () =>
      api<SharedExpense[]>(`/split/expenses${scopeQuery(NO_GROUP)}`),
  });
  const settlements = useQuery({
    queryKey: ["settlements", NO_GROUP],
    queryFn: () =>
      api<Settlement[]>(`/split/settlements${scopeQuery(NO_GROUP)}`),
  });

  const friendList = friends.data ?? [];
  const nameOf = nameFinder(friendList);
  const hasGroups = (groups.data?.length ?? 0) > 0;
  const moveTargets = (groups.data ?? []).map((g) => ({
    id: g.id,
    name: g.name,
  }));

  // Carried from a balance row's "Settle up" into the form below, rather than
  // recorded on the spot: settling a debt writes to the ledger, and a partial
  // payback is common enough that the amount wants reviewing before it lands.
  // `n` remounts the form so its fields re-initialise from the new values.
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

  // With no groups at all, everything is "not in a group", and one card says it.
  const headline = hasGroups ? overall : outside;
  const outsideSquare =
    !!outside.data &&
    outside.data.balances.length === 0 &&
    (expenses.data?.length ?? 0) > 0;

  const history = (
    <SplitHistory
      expenses={expenses}
      settlements={settlements}
      nameOf={nameOf}
      moveTargets={moveTargets}
      onMoveExpense={(id, groupId) => {
        setError(null);
        actions.moveExpense.mutate({ id, groupId });
      }}
      onMoveSettlement={(id, groupId) => {
        setError(null);
        actions.moveSettlement.mutate({ id, groupId });
      }}
      onDeleteExpense={(id) => {
        setError(null);
        actions.removeExpense.mutate(id);
      }}
      onDeleteSettlement={(id) => {
        setError(null);
        actions.removeSettlement.mutate(id);
      }}
    />
  );

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-medium">Who owes whom</h2>
        <p className="mb-3 text-sm text-zinc-500">
          A standalone ledger for splitting costs with friends (just names — not
          real accounts). Record who paid and who shares it; this nets out the
          balances. Nothing here touches your transactions.
          {hasGroups && " These totals include every group."}
        </p>
        {headline.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {/* Without this the card just looks empty on a dropped connection:
            isLoading is false, data is undefined, and the empty-state message
            below needs data to exist before it renders. */}
        {headline.isError && <ErrorText error={headline.error} />}
        {headline.data && headline.data.balances.length === 0 && (
          <p className="text-sm text-zinc-500">All settled up. ✨</p>
        )}
        {headline.data && (
          <>
            <YourPosition
              balances={headline.data.balances}
              currency={headline.data.currency}
            />
            {/* Settled where the debt lives: in its group, or in the card
                below for what is in none. An overall row can mix several. */}
            <BalanceRows
              balances={headline.data.balances}
              currency={headline.data.currency}
              onSettleUp={hasGroups ? undefined : settleUp}
            />
          </>
        )}
        <ErrorText error={error} />
      </Card>

      <GroupsCard groups={groups} />

      {hasGroups && (
        <Card>
          <h2 className="mb-1 font-medium">Not in a group</h2>
          <p className="mb-3 text-sm text-zinc-500">
            Expenses and settlements outside every group. &ldquo;Move to…&rdquo;
            on a row puts it into one.
          </p>
          {outside.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
          {outside.isError && <ErrorText error={outside.error} />}
          {outside.data && outside.data.balances.length === 0 && (
            <p className="text-sm text-zinc-500">Nothing open outside groups.</p>
          )}
          {outside.data && (
            <BalanceRows
              balances={outside.data.balances}
              currency={outside.data.currency}
              onSettleUp={settleUp}
            />
          )}
        </Card>
      )}

      <ExpenseForm
        people={friendList}
        currency={currency}
        pending={actions.addExpense.isPending}
        groupId={null}
        emptyHint="Add a friend first."
        onSubmit={(body) => {
          setError(null);
          // mutateAsync so the form clears only once the server accepted it.
          return actions.addExpense.mutateAsync(body);
        }}
      />

      <div ref={settleRef}>
        <SettleForm
          key={prefill?.n ?? 0}
          people={friendList}
          prefill={prefill}
          pending={actions.addSettlement.isPending}
          groupId={null}
          onSubmit={(body) => {
            setError(null);
            return actions.addSettlement.mutateAsync(body);
          }}
        />
      </div>

      {/* Square outside groups: the history is a record now, not something to
          act on, so it folds away like a settled group does. */}
      {outsideSquare ? (
        <details className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <summary className="cursor-pointer text-sm text-zinc-500">
            History not in a group — all settled ({expenses.data?.length ?? 0}{" "}
            expense{(expenses.data?.length ?? 0) === 1 ? "" : "s"})
          </summary>
          <div className="mt-4 flex flex-col gap-6">{history}</div>
        </details>
      ) : (
        history
      )}

      <FriendsCard
        friends={friends}
        adding={actions.addFriend.isPending}
        onAdd={(name, done) => {
          setError(null);
          actions.addFriend.mutate(name, { onSuccess: done });
        }}
        onRemove={(f) => {
          // Refused server-side while they still appear in expenses, but
          // confirm anyway — every other delete in the app does.
          if (!window.confirm(`Remove ${f.name} from your friends?`)) return;
          setError(null);
          actions.removeFriend.mutate(f.id);
        }}
      />
    </main>
  );
}
