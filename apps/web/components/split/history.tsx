"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Card, ErrorText } from "@/components/ui";
import { formatCents, formatDate } from "@/lib/format";
import type { Settlement, SharedExpense } from "@/lib/types";
import { RecentList } from "./shared";

type MoveTarget = { id: string | null; name: string };

/**
 * "Move to…" for one row: into a group, or out of one. Only rendered when
 * there is somewhere to move to.
 */
function MoveSelect({
  current,
  targets,
  onMove,
}: {
  current: string | null;
  targets: MoveTarget[];
  onMove: (groupId: string | null) => void;
}) {
  const options = targets.filter((t) => t.id !== current);
  if (options.length === 0) return null;
  return (
    <select
      aria-label="Move to a group"
      value=""
      className="rounded border border-zinc-200 bg-transparent px-1 py-0.5 text-xs text-zinc-500 dark:border-zinc-800"
      onChange={(e) => {
        const value = e.target.value;
        if (value === "") return;
        onMove(value === "none" ? null : value);
      }}
    >
      <option value="">Move to…</option>
      {options.map((t) => (
        <option key={t.id ?? "none"} value={t.id ?? "none"}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

/**
 * The expense and settlement lists for one scope.
 *
 * Each list says when it failed to load. Without that a dropped connection
 * left the settlements and expenses cards simply missing — which reads as
 * your history being gone, not as a request that failed.
 */
export function SplitHistory({
  expenses,
  settlements,
  nameOf,
  moveTargets,
  onMoveExpense,
  onMoveSettlement,
  onDeleteExpense,
  onDeleteSettlement,
}: {
  expenses: UseQueryResult<SharedExpense[]>;
  settlements: UseQueryResult<Settlement[]>;
  nameOf: (id: string | null) => string;
  moveTargets: MoveTarget[];
  onMoveExpense: (id: string, groupId: string | null) => void;
  onMoveSettlement: (id: string, groupId: string | null) => void;
  onDeleteExpense: (id: string) => void;
  onDeleteSettlement: (id: string) => void;
}) {
  return (
    <>
      {(settlements.isError || (settlements.data?.length ?? 0) > 0) && (
        <Card>
          <h2 className="mb-3 font-medium">Settlements</h2>
          {settlements.isError && <ErrorText error={settlements.error} />}
          <RecentList
            rows={settlements.data ?? []}
            noun="settlement"
            render={(s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-2 py-1.5">
                <span>{formatDate(s.date)}</span>
                <span className="font-medium">{nameOf(s.fromFriendId)}</span>
                <span className="text-zinc-400">paid</span>
                <span className="font-medium">{nameOf(s.toFriendId)}</span>
                {s.note && <span className="text-xs text-zinc-400">· {s.note}</span>}
                <span className="ml-auto tabular-nums text-zinc-500">
                  {formatCents(s.amountCents, s.currency)}
                </span>
                <MoveSelect
                  current={s.groupId}
                  targets={moveTargets}
                  onMove={(g) => onMoveSettlement(s.id, g)}
                />
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
                    onDeleteSettlement(s.id);
                  }}
                >
                  ×
                </button>
              </li>
            )}
          />
        </Card>
      )}

      {(expenses.isError || (expenses.data?.length ?? 0) > 0) && (
        <Card>
          <h2 className="mb-3 font-medium">Shared expenses</h2>
          {expenses.isError && <ErrorText error={expenses.error} />}
          <RecentList
            rows={expenses.data ?? []}
            noun="shared expense"
            render={(e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-2 py-1.5">
                <span className="text-zinc-500">{formatDate(e.date)}</span>
                <span className="font-medium">{e.description}</span>
                <span className="text-xs text-zinc-400">
                  · {nameOf(e.payerFriendId)} paid · split{" "}
                  {e.shares.map((s) => nameOf(s.friendId)).join(", ")}
                </span>
                <span className="ml-auto tabular-nums text-zinc-500">
                  {formatCents(e.amountCents, e.currency)}
                </span>
                <MoveSelect
                  current={e.groupId}
                  targets={moveTargets}
                  onMove={(g) => onMoveExpense(e.id, g)}
                />
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
                    onDeleteExpense(e.id);
                  }}
                >
                  ×
                </button>
              </li>
            )}
          />
        </Card>
      )}
    </>
  );
}
