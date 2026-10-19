"use client";

import { useMutation, type UseQueryResult } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents, formatDate } from "@/lib/format";
import type { SplitGroup } from "@/lib/types";
import { useSplitInvalidate } from "./shared";

/** "You are owed €12.00", "You owe €4.50", or "Even" — your side of a group. */
function GroupPosition({ group }: { group: SplitGroup }) {
  if (group.owedToYouCents > 0)
    return (
      <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
        you are owed {formatCents(group.owedToYouCents, group.currency)}
      </span>
    );
  if (group.youOweCents > 0)
    return (
      <span className="tabular-nums text-rose-600 dark:text-rose-400">
        you owe {formatCents(group.youOweCents, group.currency)}
      </span>
    );
  return <span className="text-zinc-500">even for you</span>;
}

function GroupRow({ group }: { group: SplitGroup }) {
  const people =
    group.members.length === 0
      ? "no members yet"
      : group.members.map((m) => m.name).join(", ");
  return (
    <li>
      <Link
        href={`/split/groups/${group.id}`}
        className="flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900"
      >
        <span className="font-medium">{group.name}</span>
        <span className="text-xs text-zinc-400">· {people}</span>
        <span className="ml-auto text-sm">
          {group.settled ? (
            <span className="text-zinc-500">
              settled
              {group.lastActivity && ` · last ${formatDate(group.lastActivity)}`}
            </span>
          ) : group.expenseCount === 0 ? (
            <span className="text-zinc-500">nothing added yet</span>
          ) : (
            <GroupPosition group={group} />
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * The groups on the overview.
 *
 * A settled group folds into "Settled groups" by itself — no archive button to
 * remember, the way Splitwise hides settled-up groups and Settle Up keeps
 * archived ones viewable. An expense added later brings it back.
 */
export function GroupsCard({ groups }: { groups: UseQueryResult<SplitGroup[]> }) {
  const invalidate = useSplitInvalidate();
  const [error, setError] = useState<unknown>(null);
  const create = useMutation({
    mutationFn: (name: string) =>
      api<SplitGroup>("/split/groups", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const open = groups.data?.filter((g) => !g.settled) ?? [];
  const settled = groups.data?.filter((g) => g.settled) ?? [];

  return (
    <Card>
      <h2 className="mb-1 font-medium">Groups</h2>
      <p className="mb-3 text-sm text-zinc-500">
        Keep a trip, a flat or a dinner club together. Once everyone in a group
        is square, it moves out of the way into &ldquo;Settled groups&rdquo;.
      </p>
      {groups.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      {groups.isError && <ErrorText error={groups.error} />}
      {open.length > 0 && (
        <ul className="mb-3 flex flex-col">
          {open.map((g) => (
            <GroupRow key={g.id} group={g} />
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem(
            "groupName",
          ) as HTMLInputElement;
          const name = input.value.trim();
          if (!name) return;
          setError(null);
          create.mutate(name, {
            onSuccess: () => {
              input.value = "";
            },
          });
        }}
        className="flex items-end gap-2"
      >
        <Field label="New group">
          <Input name="groupName" placeholder="Berlin trip" className="w-48" />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          Create
        </Button>
      </form>
      <ErrorText error={error} />
      {settled.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-zinc-500">
            Settled groups ({settled.length})
          </summary>
          <ul className="mt-1 flex flex-col">
            {settled.map((g) => (
              <GroupRow key={g.id} group={g} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
