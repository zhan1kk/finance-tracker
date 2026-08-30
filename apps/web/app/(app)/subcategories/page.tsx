"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import {
  TRANSACTION_CATEGORIES,
  type Subcategory,
  type TransactionCategory,
} from "@/lib/types";

/**
 * The name, while it is being edited. Saves on Enter or on clicking away, and
 * abandons on Escape; `done` keeps the blur that follows either key from
 * submitting the same edit a second time.
 */
function RenameInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (!name || name === initial) onCancel();
    else onSave(name);
  };
  return (
    <input
      autoFocus
      defaultValue={initial}
      aria-label={`Rename ${initial}`}
      size={Math.max(initial.length, 8)}
      className="bg-transparent outline-none"
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export default function SubcategoriesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["subcategories"] });

  const create = useMutation({
    mutationFn: (body: { name: string; category: string }) =>
      api<Subcategory>("/subcategories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/subcategories/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<Subcategory>(`/subcategories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    // Only close the editor once the rename lands: a duplicate name comes back
    // as a 409, and closing on send would discard the typing along with it.
    onSuccess: () => {
      setRenaming(null);
      return invalidate();
    },
    onError: setError,
  });

  const setPinned = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api<Subcategory>(`/subcategories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const form_ = e.currentTarget;
    create.mutate(
      {
        name: String(form.get("name")),
        category: String(form.get("category")),
      },
      // A duplicate name is a 409; keep the typing so it can be edited.
      { onSuccess: () => form_.reset() },
    );
  };

  const setArchived = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api<Subcategory>(`/subcategories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const active = subcategories.data?.filter((s) => !s.archivedAt) ?? [];
  const archived = subcategories.data?.filter((s) => s.archivedAt) ?? [];

  const grouped = TRANSACTION_CATEGORIES.map((category) => ({
    category,
    items: active.filter((s) => s.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-3 font-medium">New subcategory</h2>
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <Input name="name" required placeholder="Coffee" />
          </Field>
          <Field label="Category">
            <Select name="category" defaultValue="Expenses">
              {TRANSACTION_CATEGORIES.map((c: TransactionCategory) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
        <ErrorText error={error} />
      </Card>

      {subcategories.isLoading && (
        <p className="text-sm text-zinc-500">Loading…</p>
      )}
      {subcategories.data?.length === 0 && (
        <p className="text-sm text-zinc-500">
          No subcategories yet — add one above.
        </p>
      )}

      {grouped.map(({ category, items }) => (
        <section key={category}>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
            {category}
          </h2>
          <div className="flex flex-wrap gap-2">
            {items.map((subcategory) => (
              <span
                key={subcategory.id}
                className="group flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <button
                  aria-label={`${subcategory.pinned ? "Unpin" : "Pin"} ${subcategory.name}`}
                  title="Pinned categories are one-tap shortcuts in the Telegram bot"
                  className={
                    subcategory.pinned
                      ? "text-amber-500"
                      : "text-zinc-300 hover:text-amber-500 dark:text-zinc-700"
                  }
                  onClick={() => {
                    setError(null);
                    setPinned.mutate({
                      id: subcategory.id,
                      pinned: !subcategory.pinned,
                    });
                  }}
                >
                  {/* The glyph changes, not just its colour: pinned and
                      unpinned used to differ only by a muted amber against a
                      light grey, with no shape to fall back on. */}
                  {subcategory.pinned ? "★" : "☆"}
                </button>
                {renaming === subcategory.id ? (
                  <RenameInput
                    initial={subcategory.name}
                    onSave={(name) => {
                      setError(null);
                      rename.mutate({ id: subcategory.id, name });
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <button
                    title="Rename"
                    className="hover:underline"
                    onClick={() => {
                      setError(null);
                      setRenaming(subcategory.id);
                    }}
                  >
                    {subcategory.name}
                  </button>
                )}
                <button
                  aria-label={`Archive ${subcategory.name}`}
                  title="Archive — keeps its history, stops offering it for anything new"
                  className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  onClick={() => {
                    setError(null);
                    setArchived.mutate({ id: subcategory.id, archived: true });
                  }}
                >
                  ⊘
                </button>
                <button
                  aria-label={`Delete ${subcategory.name}`}
                  className="text-zinc-400 hover:text-red-600"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete "${subcategory.name}"?\n\nAny import rules that assign it are deleted too. To just change the wording, click the name and rename it instead — that keeps its transactions and rules.`,
                      )
                    ) {
                      setError(null);
                      remove.mutate(subcategory.id);
                    }
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </section>
      ))}

      {/* Collapsed: retired categories are history, not something to scan past
          every visit. Their transactions, rules and past totals are untouched —
          they are simply no longer offered to the categorizer or the pickers,
          which is what keeps the list the model sees short. */}
      {archived.length > 0 && (
        <details className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300">
            Archived ({archived.length})
          </summary>
          <div className="flex flex-wrap gap-2 px-3 pb-3">
            {archived.map((subcategory) => (
              <span
                key={subcategory.id}
                className="flex items-center gap-2 rounded-full border border-dashed border-zinc-300 px-3 py-1 text-sm text-zinc-500 dark:border-zinc-700"
              >
                {subcategory.name}
                <span className="text-xs text-zinc-400">
                  {subcategory.category}
                </span>
                <button
                  aria-label={`Restore ${subcategory.name}`}
                  title="Bring it back"
                  className="text-zinc-400 hover:text-emerald-600"
                  onClick={() => {
                    setError(null);
                    setArchived.mutate({
                      id: subcategory.id,
                      archived: false,
                    });
                  }}
                >
                  ↩
                </button>
              </span>
            ))}
          </div>
        </details>
      )}
    </main>
  );
}
