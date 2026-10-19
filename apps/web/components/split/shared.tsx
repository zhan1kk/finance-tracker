"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { formatCents } from "@/lib/format";
import type { Friend, SplitBalance } from "@/lib/types";

/** The user themselves, as a party key in the forms (sent as a null friend id). */
export const YOU = "you";

/** What part of the ledger a list covers: a group id, or "none" for no group. */
export type SplitScope = string;
export const NO_GROUP: SplitScope = "none";

export const scopeQuery = (scope: SplitScope) =>
  `?group=${encodeURIComponent(scope)}`;

/** Party options for a dropdown/checkboxes: You + each friend. */
export function parties(
  friends: { id: string; name: string }[],
): { key: string; name: string }[] {
  return [
    { key: YOU, name: "You" },
    ...friends.map((f) => ({ key: f.id, name: f.name })),
  ];
}

export function nameFinder(friends: Friend[]) {
  return (id: string | null) =>
    id === null ? "You" : (friends.find((f) => f.id === id)?.name ?? "?");
}

/**
 * Every split query, by prefix. Any change can move a balance, a group's
 * settled state and the overall total at once, so all of them refresh.
 */
export function useSplitInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const k of [
      "friends",
      "split-groups",
      "split-balances",
      "shared-expenses",
      "settlements",
    ])
      void qc.invalidateQueries({ queryKey: [k] });
  };
}

/** Shared expenses and settlements accumulate for as long as you split things
 *  with people and are never cleaned up, so show the recent ones and fold the
 *  rest away — the same shape as the import and FX-rate histories. Both lists
 *  arrive newest-first (date desc), so slicing off the top is the recent end. */
const RECENT_ROWS = 10;

export function RecentList<T>({
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

/** "You are owed … · You owe …" — the question you have before the detail. */
export function YourPosition({
  balances,
  currency,
}: {
  balances: SplitBalance[];
  currency: string;
}) {
  const owedToYou = balances
    .filter((b) => b.toId === null)
    .reduce((a, b) => a + b.amountCents, 0);
  const youOwe = balances
    .filter((b) => b.fromId === null)
    .reduce((a, b) => a + b.amountCents, 0);
  if (owedToYou === 0 && youOwe === 0) return null;
  return (
    <p className="mb-3 flex flex-wrap gap-x-4 text-sm">
      {owedToYou > 0 && (
        <span>
          You are owed{" "}
          <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatCents(owedToYou, currency)}
          </span>
        </span>
      )}
      {youOwe > 0 && (
        <span>
          You owe{" "}
          <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCents(youOwe, currency)}
          </span>
        </span>
      )}
    </p>
  );
}

/** The pairwise "A owes B" rows, each optionally with a Settle up action. */
export function BalanceRows({
  balances,
  currency,
  onSettleUp,
}: {
  balances: SplitBalance[];
  currency: string;
  onSettleUp?: (b: SplitBalance) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {balances.map((b, i) => {
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
              {formatCents(b.amountCents, currency)}
            </span>
            {onSettleUp && (
              <button
                type="button"
                className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
                onClick={() => onSettleUp(b)}
              >
                Settle up
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
