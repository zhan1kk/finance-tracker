"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import type { Account, CategorizationRule, Subcategory } from "@/lib/types";

/** Option values say which kind of target they are (see the import review). */
const SUB = "sub:";
const ACC = "acc:";

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

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });

  const create = useMutation({
    mutationFn: (body: {
      pattern: string;
      subcategoryId?: string;
      counterAccountId?: string;
    }) => api("/rules", { method: "POST", body: JSON.stringify(body) }),
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
    const target = String(form.get("target") || "");
    if (!pattern || !target) {
      setError(new Error("Enter a merchant text and pick what it means"));
      return;
    }
    create.mutate(
      target.startsWith(ACC)
        ? { pattern, counterAccountId: target.slice(ACC.length) }
        : { pattern, subcategoryId: target.slice(SUB.length) },
    );
    e.currentTarget.reset();
  };

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-medium">Categorization rules</h2>
        <p className="mb-3 text-sm text-zinc-500">
          When a transaction description contains the text of a rule, it is
          categorized automatically — as a category, or as a transfer between
          your own accounts (which counts as neither income nor spending). A
          rule only applies to money moving the same way as the category it
          points to, so “amazon” can mean Shopping when charged and Refunds
          when credited. When several rules match, the longest one wins. Rules
          are also created for you whenever you correct an imported
          transaction.
        </p>
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <Field label="When description contains">
            <Input name="pattern" placeholder="albert heijn" className="w-56" />
          </Field>
          <Field label="Treat as">
            <Select name="target" defaultValue="">
              <option value="" disabled>
                Select…
              </option>
              <optgroup label="Category">
                {subcategories.data?.map((s) => (
                  <option key={s.id} value={`${SUB}${s.id}`}>
                    {s.name} ({s.category})
                  </option>
                ))}
              </optgroup>
              <optgroup label="Transfer between my accounts">
                {accounts.data?.map((a) => (
                  <option key={a.id} value={`${ACC}${a.id}`}>
                    ⇄ {a.name}
                  </option>
                ))}
              </optgroup>
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
                  <td className="py-2 pr-3 font-mono text-xs">
                    {rule.pattern}
                    {rule.type !== "TRANSFER" && (
                      <span className="ml-1.5 font-sans text-xs text-zinc-400">
                        {rule.type === "INCOME" ? "income" : "expense"}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {rule.counterAccount
                      ? `⇄ ${rule.counterAccount.name}`
                      : (rule.subcategory?.name ?? "—")}
                  </td>
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
