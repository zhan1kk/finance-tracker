"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import {
  TRANSACTION_CATEGORIES,
  type Subcategory,
  type TransactionCategory,
} from "@/lib/types";

export default function SubcategoriesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);

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

  const grouped = TRANSACTION_CATEGORIES.map((category) => ({
    category,
    items:
      subcategories.data?.filter((s) => s.category === category) ??
      ([] as Subcategory[]),
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
                  ★
                </button>
                {subcategory.name}
                <button
                  aria-label={`Delete ${subcategory.name}`}
                  className="text-zinc-400 hover:text-red-600"
                  onClick={() => {
                    if (window.confirm(`Delete "${subcategory.name}"?`)) {
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
    </main>
  );
}
