"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import type { Friend } from "@/lib/types";

/**
 * Adding and removing friends. The list itself is folded away: friends you
 * are square with have no reason to sit on the overview, and the balances
 * above already name everyone who owes or is owed.
 */
export function FriendsCard({
  friends,
  adding,
  onAdd,
  onRemove,
}: {
  friends: UseQueryResult<Friend[]>;
  adding: boolean;
  onAdd: (name: string, done: () => void) => void;
  onRemove: (friend: Friend) => void;
}) {
  const list = friends.data ?? [];
  return (
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
          onAdd(name, () => {
            input.value = "";
          });
        }}
        className="mb-3 flex items-end gap-2"
      >
        <Field label="Add a friend">
          <Input name="name" placeholder="Alex" className="w-40" />
        </Field>
        <Button type="submit" disabled={adding}>
          Add
        </Button>
      </form>
      {friends.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      {/* Without this a failed load read as "No friends yet" — as if every
          friend had been deleted. */}
      {friends.isError && <ErrorText error={friends.error} />}
      {friends.data && list.length === 0 && (
        <p className="text-sm text-zinc-500">
          No friends yet — add one to start splitting.
        </p>
      )}
      {list.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-zinc-500">
            {list.length} friend{list.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 flex flex-wrap gap-2">
            {list.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-sm dark:bg-zinc-800"
              >
                {f.name}
                <button
                  aria-label={`Remove ${f.name}`}
                  className="text-zinc-400 hover:text-red-600"
                  onClick={() => onRemove(f)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
