"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { SubcategoryOptions } from "@/components/subcategory-options";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import type { Subcategory } from "@/lib/types";

type Preview = {
  input: string;
  pattern: string;
  matchCount: number;
  wholeWordCount?: number;
  samples: { description: string; current: string | null }[];
  empty: boolean;
};

/**
 * Add several keyword rules at once, after seeing what each one would catch.
 *
 * Rules match a substring of the merchant text, so a short keyword is a trap:
 * "cos" also sits inside "tesco stores". Rather than block short patterns with
 * an arbitrary minimum length, this shows the actual transactions each keyword
 * would have matched. A bad keyword is then obvious instead of theoretical.
 */
export function BulkRules({
  subcategories,
  onCreated,
}: {
  subcategories: Subcategory[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [subcategoryId, setSubcategoryId] = useState("");
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Preview[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: (patterns: string[]) =>
      api<Preview[]>("/rules/preview", {
        method: "POST",
        body: JSON.stringify({ patterns }),
      }),
    onSuccess: (data) => {
      setRows(data);
      // Pre-tick everything that matched something. A keyword matching nothing
      // is not wrong, it just cannot be judged yet, so it stays unticked.
      setPicked(new Set(data.filter((r) => r.matchCount > 0).map((r) => r.pattern)));
    },
    onError: setError,
  });

  const add = useMutation({
    mutationFn: (patterns: string[]) =>
      api<{ created: number; skipped: string[] }>("/rules/bulk", {
        method: "POST",
        body: JSON.stringify({
          rules: patterns.map((pattern) => ({ pattern, subcategoryId })),
        }),
      }),
    onSuccess: (res) => {
      setNotice(
        `Added ${res.created} rule${res.created === 1 ? "" : "s"}` +
          (res.skipped.length > 0
            ? `, skipped ${res.skipped.length} already known`
            : ""),
      );
      setRows(null);
      setRaw("");
      setPicked(new Set());
      onCreated();
    },
    onError: setError,
  });

  const patterns = raw
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);

  const onPreview = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (patterns.length === 0) {
      setError(new Error("Enter at least one keyword"));
      return;
    }
    preview.mutate(patterns);
  };

  const toggle = (pattern: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(pattern)) next.add(pattern);
      return next;
    });

  const name =
    subcategories.find((s) => s.id === subcategoryId)?.name ?? "this category";

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Add keywords in bulk</h2>
        <Button variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-zinc-500">
            Teach a category several merchant words at once, for example{" "}
            <span className="font-mono text-xs">cafe, restaurant, bar</span> for
            Dining Out. Each becomes a normal rule, so it applies before the
            categorizer ever runs. You will see what each keyword matches in
            your history before anything is saved.
          </p>

          <form onSubmit={onPreview} className="flex flex-wrap items-end gap-3">
            <Field label="Category">
              <Select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
              >
                <option value="">Select…</option>
                <SubcategoryOptions subcategories={subcategories} />
              </Select>
            </Field>
            <Field label="Keywords (comma separated)">
              <Input
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder="cafe, restaurant, bar"
                className="w-72"
              />
            </Field>
            <Button type="submit" disabled={preview.isPending}>
              {preview.isPending ? "Checking…" : "Preview"}
            </Button>
          </form>

          {notice && <p className="text-sm text-emerald-600">{notice}</p>}
          <ErrorText error={error} />

          {rows && (
            <div className="flex flex-col gap-2">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[26rem] text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                      <th className="py-2 pr-3 font-medium">Use</th>
                      <th className="py-2 pr-3 font-medium">Keyword</th>
                      <th className="py-2 pr-3 font-medium">Would match</th>
                      <th className="py-2 font-medium">Examples from your history</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.pattern || r.input}
                        className="border-b border-zinc-100 align-top dark:border-zinc-900"
                      >
                        <td className="py-2 pr-3">
                          <input
                            type="checkbox"
                            aria-label={`Use ${r.pattern}`}
                            checked={picked.has(r.pattern)}
                            disabled={r.empty}
                            onChange={() => toggle(r.pattern)}
                          />
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {r.pattern || r.input}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {r.empty ? (
                            <span className="text-zinc-400">unusable</span>
                          ) : (
                            <>
                              {r.matchCount}
                              {/* The gap between a substring match and a
                                  whole-word one is the "tesco stores" risk,
                                  so it is named rather than hidden. */}
                              {r.wholeWordCount !== undefined &&
                                r.wholeWordCount < r.matchCount && (
                                  <span
                                    className="ml-1 text-xs text-amber-600"
                                    title={`${
                                      r.matchCount - r.wholeWordCount
                                    } of these match inside a longer word`}
                                  >
                                    ({r.wholeWordCount} whole word)
                                  </span>
                                )}
                            </>
                          )}
                        </td>
                        <td className="py-2 text-xs text-zinc-500">
                          {r.samples.length === 0 ? (
                            <span className="text-zinc-400">
                              nothing in your history yet
                            </span>
                          ) : (
                            r.samples.map((s, i) => (
                              <div key={i} className="truncate">
                                {s.description}
                                {s.current && (
                                  <span className="text-zinc-400">
                                    {" "}
                                    · now {s.current}
                                  </span>
                                )}
                              </div>
                            ))
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  disabled={
                    add.isPending || picked.size === 0 || subcategoryId === ""
                  }
                  onClick={() => {
                    setError(null);
                    add.mutate([...picked]);
                  }}
                >
                  {add.isPending
                    ? "Adding…"
                    : `Add ${picked.size} to ${name}`}
                </Button>
                {subcategoryId === "" && (
                  <span className="text-sm text-amber-600">
                    Pick a category first.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
