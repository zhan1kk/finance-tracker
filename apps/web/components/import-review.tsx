"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorText, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import type {
  ImportBatch,
  ImportRow,
  ImportRowStatus,
  Subcategory,
} from "@/lib/types";

const STATUS_STYLE: Record<ImportRowStatus, string> = {
  READY: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  NEEDS_REVIEW: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  DUPLICATE: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  COMMITTED: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  SKIPPED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const STATUS_LABEL: Record<ImportRowStatus, string> = {
  READY: "Ready",
  NEEDS_REVIEW: "Review",
  DUPLICATE: "Duplicate",
  COMMITTED: "Imported",
  SKIPPED: "Skipped",
};

const SOURCE_LABEL: Record<string, string> = {
  RULE: "rule",
  LLM: "auto",
  MANUAL: "you",
  NONE: "—",
};

export function ImportReview({
  batchId,
  onDone,
}: {
  batchId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();

  const batch = useQuery({
    queryKey: ["import-batch", batchId],
    queryFn: () => api<ImportBatch>(`/imports/${batchId}`),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["import-batch", batchId] });
    void queryClient.invalidateQueries({ queryKey: ["import-batches"] });
    void queryClient.invalidateQueries({ queryKey: ["import-accuracy"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["budgets"] });
  };

  const correct = useMutation({
    mutationFn: (vars: { rowId: string; subcategoryId: string }) =>
      api(`/imports/${batchId}/rows/${vars.rowId}`, {
        method: "PATCH",
        body: JSON.stringify({ subcategoryId: vars.subcategoryId }),
      }),
    onSuccess: invalidate,
  });
  const commit = useMutation({
    mutationFn: () => api(`/imports/${batchId}/commit`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const undo = useMutation({
    mutationFn: () => api(`/imports/${batchId}/undo`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const discard = useMutation({
    mutationFn: () => api(`/imports/${batchId}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });

  const data = batch.data;
  if (!data) {
    return <Card>Loading import…</Card>;
  }

  const currency = data.account.currency;
  const pending = data.status === "PENDING_REVIEW";
  const readyCount = data.rows.filter((r) => r.status === "READY").length;
  const reviewCount = data.rows.filter(
    (r) => r.status === "NEEDS_REVIEW",
  ).length;
  const error = commit.error ?? undo.error ?? discard.error ?? correct.error;

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={onDone}
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Back
        </button>
        <div>
          <h2 className="font-medium">{data.filename}</h2>
          <p className="text-xs text-zinc-500">
            {data.account.name} · categorized by {data.provider} ·{" "}
            {data.rows.length} rows
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {pending && (
            <>
              <Button
                onClick={() => commit.mutate()}
                disabled={commit.isPending || readyCount === 0}
              >
                Import {readyCount} ready
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm("Discard this uncommitted import?")) {
                    discard.mutate();
                  }
                }}
                disabled={discard.isPending}
              >
                Discard
              </Button>
            </>
          )}
          {data.status === "COMMITTED" && (
            <Button
              variant="ghost"
              onClick={() => {
                if (window.confirm("Undo this import? Its transactions will be removed.")) {
                  undo.mutate();
                }
              }}
              disabled={undo.isPending}
            >
              Undo import
            </Button>
          )}
        </div>
      </div>

      {pending && reviewCount > 0 && (
        <p className="mb-3 text-sm text-amber-600">
          {reviewCount} transaction{reviewCount === 1 ? "" : "s"} still need a
          category and won&apos;t be imported until you pick one.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">Description</th>
              <th className="py-2 pr-3 text-right font-medium">Amount</th>
              <th className="py-2 pr-3 font-medium">Category</th>
              <th className="py-2 pr-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                currency={currency}
                editable={pending && row.status !== "DUPLICATE"}
                subcategories={subcategories.data ?? []}
                onPick={(subcategoryId) =>
                  correct.mutate({ rowId: row.id, subcategoryId })
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      <ErrorText error={error} />
    </Card>
  );
}

function Row({
  row,
  currency,
  editable,
  subcategories,
  onPick,
}: {
  row: ImportRow;
  currency: string;
  editable: boolean;
  subcategories: Subcategory[];
  onPick: (subcategoryId: string) => void;
}) {
  const eligible = subcategories.filter((s) =>
    row.type === "INCOME" ? s.category === "Income" : s.category !== "Income",
  );
  const sign = row.type === "INCOME" ? "+" : "−";
  const duplicate = row.status === "DUPLICATE";

  return (
    <tr
      className={`border-b border-zinc-100 dark:border-zinc-900 ${
        duplicate ? "opacity-50" : ""
      }`}
    >
      <td className="py-2 pr-3 whitespace-nowrap">{row.date.slice(0, 10)}</td>
      <td className="py-2 pr-3">{row.description}</td>
      <td
        className={`py-2 pr-3 text-right whitespace-nowrap ${
          row.type === "INCOME" ? "text-emerald-600" : ""
        }`}
      >
        {sign}
        {formatCents(row.amount, currency)}
      </td>
      <td className="py-2 pr-3">
        {editable ? (
          <Select
            value={row.subcategoryId ?? ""}
            onChange={(e) => e.target.value && onPick(e.target.value)}
            className={row.subcategoryId ? "" : "border-amber-400"}
          >
            <option value="">Pick…</option>
            {eligible.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : (
          <span>{row.subcategory?.name ?? "—"}</span>
        )}
        {row.source !== "NONE" && row.subcategoryId && (
          <span className="ml-1.5 text-xs text-zinc-400">
            {SOURCE_LABEL[row.source]}
            {row.source === "LLM" && row.confidence != null
              ? ` ${Math.round(row.confidence * 100)}%`
              : ""}
          </span>
        )}
      </td>
      <td className="py-2 pr-3">
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </td>
    </tr>
  );
}
