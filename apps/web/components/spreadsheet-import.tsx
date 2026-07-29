"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card, ErrorText, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents, parseAmountToCents } from "@/lib/format";
import {
  TRANSACTION_CATEGORIES,
  type SpreadsheetApplyResult,
  type SpreadsheetPreview,
  type SpreadsheetPreviewItem,
  type TransactionCategory,
} from "@/lib/types";

/** Base64 in chunks — spreading a multi-MB byte array blows the call stack. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function SpreadsheetImport() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [budgets, setBudgets] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SpreadsheetApplyResult | null>(null);

  const reset = () => {
    setPreview(null);
    setSelected(new Set());
    setBudgets({});
    if (fileInput.current) fileInput.current.value = "";
  };

  const inspect = useMutation({
    mutationFn: async (file: File) =>
      api<SpreadsheetPreview>("/imports/spreadsheet/preview", {
        method: "POST",
        body: JSON.stringify({ file: await toBase64(file) }),
      }),
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      // Likely-stale aliases start unticked so the list needs less pruning.
      setSelected(
        new Set(
          data.items.filter((i) => i.similarTo === null).map((i) => i.name),
        ),
      );
      setBudgets(
        Object.fromEntries(
          data.items.map((i) => [
            i.name,
            i.suggestedBudgetCents === null
              ? ""
              : (i.suggestedBudgetCents / 100).toFixed(2),
          ]),
        ),
      );
    },
    onError: setError,
  });

  const apply = useMutation({
    mutationFn: (items: unknown[]) =>
      api<SpreadsheetApplyResult>("/imports/spreadsheet/apply", {
        method: "POST",
        body: JSON.stringify({ items }),
      }),
    onSuccess: (data) => {
      setResult(data);
      reset();
      for (const key of ["subcategories", "budgets", "stats"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: setError,
  });

  const onImport = () => {
    if (!preview) return;
    setError(null);
    const items = preview.items
      .filter((item) => selected.has(item.name))
      .map((item) => {
        const raw = budgets[item.name]?.trim() ?? "";
        const cents = raw === "" ? null : parseAmountToCents(raw);
        return {
          name: item.name,
          category: item.category,
          budgetCents: item.budgetable ? cents : null,
        };
      });
    if (items.length === 0) {
      setError(new Error("Select at least one category to import"));
      return;
    }
    apply.mutate(items);
  };

  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const setAll = (on: boolean) =>
    setSelected(on ? new Set(preview?.items.map((i) => i.name)) : new Set());

  return (
    <Card>
      <h2 className="mb-1 font-medium">Start from a budget spreadsheet</h2>
      <p className="mb-3 text-sm text-zinc-500">
        Upload the Excel file you tracked in before. It reads only your
        categories and their monthly budgets — amounts spent are ignored, so
        one-off months never distort your history.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm dark:file:bg-zinc-800"
          onChange={(e) => {
            const file = e.target.files?.[0];
            setError(null);
            if (file) inspect.mutate(file);
          }}
        />
        {inspect.isPending && (
          <span className="text-sm text-zinc-500">Reading…</span>
        )}
        {preview && (
          <Button variant="ghost" onClick={reset}>
            Cancel
          </Button>
        )}
      </div>

      {result && (
        <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950">
          Imported {result.subcategoriesCreated} new categor
          {result.subcategoriesCreated === 1 ? "y" : "ies"}
          {result.subcategoriesReused > 0 &&
            ` (${result.subcategoriesReused} already existed)`}
          , {result.budgetsCreated} budget
          {result.budgetsCreated === 1 ? "" : "s"} created
          {result.budgetsUpdated > 0 && `, ${result.budgetsUpdated} updated`}.
          {result.skipped.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-zinc-600 dark:text-zinc-400">
              {result.skipped.map((s) => (
                <li key={s.name}>
                  {s.name}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {preview && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-zinc-500">
              Found {preview.items.length} categories across{" "}
              {preview.sheetsScanned.join(", ")}
            </span>
            <button
              type="button"
              className="underline"
              onClick={() => setAll(true)}
            >
              select all
            </button>
            <button
              type="button"
              className="underline"
              onClick={() => setAll(false)}
            >
              none
            </button>
            <span className="ml-auto font-medium">{selected.size} selected</span>
          </div>

          <div className="max-h-[28rem] overflow-y-auto rounded border border-zinc-200 dark:border-zinc-800">
            {TRANSACTION_CATEGORIES.map((category) => {
              const rows = preview.items.filter((i) => i.category === category);
              if (rows.length === 0) return null;
              return (
                <section key={category}>
                  <h3 className="sticky top-0 bg-zinc-100 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {category} ({rows.length})
                  </h3>
                  {rows.map((item) => (
                    <Row
                      key={item.name}
                      item={item}
                      checked={selected.has(item.name)}
                      budget={budgets[item.name] ?? ""}
                      onToggle={() => toggle(item.name)}
                      onBudget={(value) =>
                        setBudgets((b) => ({ ...b, [item.name]: value }))
                      }
                    />
                  ))}
                </section>
              );
            })}
          </div>

          <Button
            className="mt-3"
            onClick={onImport}
            disabled={apply.isPending}
          >
            Import {selected.size} categor{selected.size === 1 ? "y" : "ies"}
          </Button>
        </div>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

function Row({
  item,
  checked,
  budget,
  onToggle,
  onBudget,
}: {
  item: SpreadsheetPreviewItem;
  checked: boolean;
  budget: string;
  onToggle: () => void;
  onBudget: (value: string) => void;
}) {
  const notes: string[] = [];
  // Which of the pair is the current name cannot be known from the sheet, so
  // this stays a neutral hint — the month counts let the user decide.
  if (item.similarTo)
    notes.push(`same thing as "${item.similarTo}"? keep only one`);
  if (item.existingCategory)
    notes.push(`already exists under ${item.existingCategory}`);
  else if (item.existingSubcategory) notes.push("already exists");
  if (item.existingBudget) notes.push("has a budget already");
  if (!item.budgetable) notes.push("income — no budget");

  // The label wraps only the checkbox and name: a budget field nested inside it
  // would toggle the row every time you clicked to edit the amount.
  return (
    <div className="flex items-center gap-3 border-t border-zinc-100 px-3 py-2 text-sm first:border-t-0 dark:border-zinc-800">
      <label className="flex min-w-0 flex-1 items-center gap-3">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="min-w-0">
          <span className={item.similarTo ? "text-zinc-500" : ""}>
            {item.name}
          </span>
          {notes.length > 0 && (
            <span className="block text-xs text-amber-700 dark:text-amber-500">
              {notes.join(" · ")}
            </span>
          )}
        </span>
      </label>
      <span
        className="shrink-0 text-xs text-zinc-500"
        title={item.samples
          .map((s) => `${s.sheet}: ${formatCents(s.cents, "EUR")}`)
          .join("\n")}
      >
        {item.monthsSeen} mo
      </span>
      {item.budgetable ? (
        <Input
          value={budget}
          onChange={(e) => onBudget(e.target.value)}
          placeholder="—"
          className="w-24 shrink-0 text-right"
        />
      ) : (
        <span className="w-24 shrink-0" />
      )}
    </div>
  );
}
