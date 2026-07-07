"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import type { CategorizationRule, Subcategory } from "@/lib/types";

export default function RulesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: () => api<CategorizationRule[]>("/rules"),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["rules"] });

  const create = useMutation({
    mutationFn: (body: { pattern: string; subcategoryId: string }) =>
      api("/rules", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/rules/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const pattern = String(form.get("pattern") || "").trim();
    const subcategoryId = String(form.get("subcategoryId") || "");
    if (!pattern || !subcategoryId) {
      setError(new Error("Enter a merchant text and a category"));
      return;
    }
    create.mutate({ pattern, subcategoryId });
    e.currentTarget.reset();
  };

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-medium">Categorization rules</h2>
        <p className="mb-3 text-sm text-zinc-500">
          When a transaction description contains the text of a rule, it is
          categorized automatically. Rules are also created for you whenever you
          correct an imported transaction.
        </p>
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <Field label="When description contains">
            <Input name="pattern" placeholder="albert heijn" className="w-56" />
          </Field>
          <Field label="Categorize as">
            <Select name="subcategoryId" defaultValue="">
              <option value="" disabled>
                Select…
              </option>
              {subcategories.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.category})
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Add rule
          </Button>
        </form>
        <ErrorText error={error} />
      </Card>

      <Card>
        {rules.data && rules.data.length === 0 && (
          <p className="text-sm text-zinc-500">
            No rules yet. Add one above, or correct an imported transaction and a
            rule is created automatically.
          </p>
        )}
        {rules.data && rules.data.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">Description contains</th>
                <th className="py-2 pr-3 font-medium">Category</th>
                <th className="py-2 pr-3 text-right font-medium">Times used</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.data.map((rule) => (
                <tr
                  key={rule.id}
                  className="border-b border-zinc-100 dark:border-zinc-900"
                >
                  <td className="py-2 pr-3 font-mono text-xs">{rule.pattern}</td>
                  <td className="py-2 pr-3">{rule.subcategory.name}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                    {rule.hitCount}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      aria-label="Delete rule"
                      className="text-zinc-400 hover:text-red-600"
                      onClick={() => remove.mutate(rule.id)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </main>
  );
}
