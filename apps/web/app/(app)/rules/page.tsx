"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { BulkRules } from "@/components/bulk-rules";
import { SubcategoryOptions } from "@/components/subcategory-options";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import type { Account, CategorizationRule, Subcategory } from "@/lib/types";

/** Option values say which kind of target they are (see the import review). */
const SUB = "sub:";
const ACC = "acc:";

/** What a rule does, as one line — shown in the table and searched against, so
 *  typing a category name finds its rules and not just merchant text. */
function targetLabel(rule: CategorizationRule): string {
  if (rule.excludeFromStats) return "⊘ Internal (excluded)";
  if (rule.counterAccount) return `⇄ ${rule.counterAccount.name}`;
  return rule.subcategory?.name ?? "—";
}

/** Below this the whole list fits on a screen and a search box is just clutter. */
const SEARCHABLE_FROM = 8;

export default function RulesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"pattern" | "hits">("pattern");

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
    const form_ = e.currentTarget;
    create.mutate(
      target.startsWith(ACC)
        ? { pattern, counterAccountId: target.slice(ACC.length) }
        : { pattern, subcategoryId: target.slice(SUB.length) },
      // Only clear once it saved: a rejected rule used to wipe what was typed.
      { onSuccess: () => form_.reset() },
    );
  };

  const all = rules.data ?? [];
  const query = search.trim().toLowerCase();
  const shown = all
    .filter(
      (r) =>
        !query ||
        r.pattern.toLowerCase().includes(query) ||
        targetLabel(r).toLowerCase().includes(query),
    )
    // The server sorts by pattern; "most used" is the view that answers "which
    // of these am I actually relying on, and which are dead weight?".
    .sort((a, b) => (sort === "hits" ? b.hitCount - a.hitCount : 0));

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
              <SubcategoryOptions
                subcategories={subcategories.data ?? []}
                prefix={SUB}
              />
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

      <BulkRules
        subcategories={subcategories.data ?? []}
        onCreated={invalidate}
      />

      <Card>
        {rules.data && all.length === 0 && (
          <p className="text-sm text-zinc-500">
            No rules yet. Add one above, or correct an imported transaction and a
            rule is created automatically.
          </p>
        )}

        {all.length >= SEARCHABLE_FROM && (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search rules…"
              aria-label="Search rules"
              className="w-56"
            />
            <Select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              aria-label="Sort rules"
              className="w-auto"
            >
              <option value="pattern">A–Z</option>
              <option value="hits">Most used</option>
            </Select>
            <span className="text-sm text-zinc-500">
              {query ? `${shown.length} of ${all.length}` : `${all.length} rules`}
            </span>
          </div>
        )}

        {all.length > 0 && shown.length === 0 && (
          <p className="text-sm text-zinc-500">
            No rule matches “{search.trim()}”.
          </p>
        )}

        {shown.length > 0 && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">Description contains</th>
                <th className="py-2 pr-3 font-medium">Category</th>
                <th className="py-2 pr-3 text-right font-medium">Times used</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((rule) => (
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
                    {/* Two rules can read identically here and behave very
                        differently, so the matching mode has to be visible. */}
                    {rule.wholeWord && (
                      <span
                        className="ml-1.5 rounded bg-zinc-100 px-1.5 py-0.5 font-sans text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                        title="Matches only as a whole word, not inside a longer one"
                      >
                        whole word
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{targetLabel(rule)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                    {rule.hitCount}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      aria-label="Delete rule"
                      className="text-zinc-400 hover:text-red-600"
                      onClick={() => {
                        // Rules are learned from past corrections, so losing one
                        // to a misclick throws away real work — confirm like
                        // every other delete in the app.
                        if (
                          window.confirm(
                            `Delete the rule for "${rule.pattern}"? Future imports will stop matching it automatically.`,
                          )
                        ) {
                          remove.mutate(rule.id);
                        }
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>
    </main>
  );
}
