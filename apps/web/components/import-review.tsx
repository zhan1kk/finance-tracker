"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorText, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import type {
  Account,
  ImportBatch,
  ImportRow,
  ImportRowStatus,
  Subcategory,
} from "@/lib/types";

/**
 * The picker offers both kinds of target, so option values carry which one they
 * are: "sub:<id>" for a category, "acc:<id>" for a transfer to my own account.
 */
const SUB = "sub:";
const ACC = "acc:";
// Marks a row an internal move (own-account transfer / currency exchange):
// commits and moves the balance, but is kept out of income/spending stats.
const INT = "internal";

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
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
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
    mutationFn: (vars: { rowId: string; choice: string }) =>
      api(`/imports/${batchId}/rows/${vars.rowId}`, {
        method: "PATCH",
        body: JSON.stringify(
          vars.choice === INT
            ? { excludeFromStats: true }
            : vars.choice.startsWith(ACC)
              ? { counterAccountId: vars.choice.slice(ACC.length) }
              : { subcategoryId: vars.choice.slice(SUB.length) },
        ),
      }),
    onSuccess: invalidate,
  });

  // Saves a row's personal note without touching its categorization.
  const annotate = useMutation({
    mutationFn: (vars: { rowId: string; userNote: string }) =>
      api(`/imports/${batchId}/rows/${vars.rowId}`, {
        method: "PATCH",
        body: JSON.stringify({ userNote: vars.userNote }),
      }),
    onSuccess: invalidate,
  });

  // Flips a row between income and expense (statements with inverted signs, e.g.
  // a credit card, can be read backwards). Resets the row to review.
  const flip = useMutation({
    mutationFn: (rowId: string) =>
      api(`/imports/${batchId}/rows/${rowId}/flip`, { method: "POST" }),
    onSuccess: invalidate,
  });

  // Drops a row from the import (or restores it) — e.g. a charge that already
  // exists under a different posting date, which dedup can't catch.
  const skip = useMutation({
    mutationFn: (vars: { rowId: string; skipped: boolean }) =>
      api(`/imports/${batchId}/rows/${vars.rowId}/skip`, {
        method: "POST",
        body: JSON.stringify({ skipped: vars.skipped }),
      }),
    onSuccess: invalidate,
  });

  // Confirms every still-in-review suggestion as-is. Sequential on purpose: a
  // burst of parallel PATCHes against the same batch buys nothing at this size.
  const acceptAll = useMutation({
    mutationFn: async (rows: { rowId: string; subcategoryId: string }[]) => {
      for (const row of rows) {
        await api(`/imports/${batchId}/rows/${row.rowId}`, {
          method: "PATCH",
          body: JSON.stringify({ subcategoryId: row.subcategoryId }),
        });
      }
    },
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
  const reopen = useMutation({
    mutationFn: () => api(`/imports/${batchId}/reopen`, { method: "POST" }),
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
  // Review rows that already carry a suggestion — confirmable in one click.
  const suggested = data.rows.filter(
    (r) => r.status === "NEEDS_REVIEW" && r.predictedSubcategory !== null,
  );
  const error =
    commit.error ?? undo.error ?? reopen.error ?? discard.error ??
    correct.error ?? acceptAll.error ?? skip.error;

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
              {suggested.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    acceptAll.mutate(
                      suggested.map((r) => ({
                        rowId: r.id,
                        subcategoryId: (r.predictedSubcategory as {
                          id: string;
                        }).id,
                      })),
                    )
                  }
                  disabled={acceptAll.isPending}
                >
                  {acceptAll.isPending
                    ? "Accepting…"
                    : `Accept ${suggested.length} suggested`}
                </Button>
              )}
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
          {data.status === "UNDONE" && (
            <Button
              onClick={() => reopen.mutate()}
              disabled={reopen.isPending}
            >
              {reopen.isPending ? "Reopening…" : "Reopen for review"}
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
                onPick={(choice) => correct.mutate({ rowId: row.id, choice })}
                onNote={(userNote) => annotate.mutate({ rowId: row.id, userNote })}
                onFlip={() => flip.mutate(row.id)}
                onSkip={(skipped) => skip.mutate({ rowId: row.id, skipped })}
                accounts={(accounts.data ?? []).filter(
                  (a) =>
                    a.id !== data.account.id &&
                    a.currency === data.account.currency,
                )}
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
  accounts,
  onPick,
  onNote,
  onFlip,
  onSkip,
}: {
  row: ImportRow;
  currency: string;
  editable: boolean;
  subcategories: Subcategory[];
  accounts: Account[];
  onPick: (choice: string) => void;
  onNote: (userNote: string) => void;
  onFlip: () => void;
  onSkip: (skipped: boolean) => void;
}) {
  const eligible = subcategories.filter((s) =>
    row.type === "INCOME" ? s.category === "Income" : s.category !== "Income",
  );
  const sign = row.type === "INCOME" ? "+" : "−";
  const duplicate = row.status === "DUPLICATE";
  const skipped = row.status === "SKIPPED";
  const chosen =
    row.subcategoryId ??
    row.counterAccountId ??
    (row.excludeFromStats ? INT : null);

  return (
    <tr
      className={`border-b border-zinc-100 dark:border-zinc-900 ${
        duplicate || skipped ? "opacity-50" : ""
      }`}
    >
      <td className="py-2 pr-3 whitespace-nowrap">{row.date.slice(0, 10)}</td>
      <td className="py-2 pr-3">
        {row.description}
        {/* System note (skip/duplicate/repeat reason) — explains why a row is
            flagged so a greyed duplicate or a "same as earlier" repeat isn't a
            mystery. */}
        {row.note && (
          <span className="block text-xs text-amber-600">{row.note}</span>
        )}
        {/* Capture "what was this for" the moment it is remembered — saved on
            blur, merged into the transaction's description on commit. */}
        {editable && (
          <input
            defaultValue={row.userNote ?? ""}
            placeholder="add a note…"
            maxLength={500}
            className="mt-0.5 block w-full max-w-56 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-zinc-500 placeholder:text-zinc-300 hover:border-zinc-200 focus:border-zinc-400 focus:outline-none dark:placeholder:text-zinc-700 dark:hover:border-zinc-800 dark:focus:border-zinc-600"
            onBlur={(e) => {
              if (e.target.value !== (row.userNote ?? "")) {
                onNote(e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        )}
        {!editable && row.userNote && (
          <span className="block text-xs text-zinc-500">{row.userNote}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-right whitespace-nowrap">
        <span className={row.type === "INCOME" ? "text-emerald-600" : ""}>
          {sign}
          {formatCents(row.amount, currency)}
        </span>
        {/* Some statements invert the sign (a credit card writes payments as
            negative), so the extractor can read a row backwards — flip it. */}
        {editable && !skipped && (
          <button
            className="ml-1.5 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
            title="Flip income/expense"
            onClick={onFlip}
          >
            ⇅
          </button>
        )}
      </td>
      <td className="py-2 pr-3">
        {editable && !skipped ? (
          <Select
            value={
              row.excludeFromStats
                ? INT
                : row.counterAccountId
                  ? `${ACC}${row.counterAccountId}`
                  : row.subcategoryId
                    ? `${SUB}${row.subcategoryId}`
                    : ""
            }
            onChange={(e) => e.target.value && onPick(e.target.value)}
            className={chosen ? "" : "border-amber-400"}
          >
            <option value="">Pick…</option>
            <option value={INT}>⊘ Internal move (exclude from stats)</option>
            <optgroup label="Category">
              {eligible.map((s) => (
                <option key={s.id} value={`${SUB}${s.id}`}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            {accounts.length > 0 && (
              <optgroup label="Transfer (not income or spending)">
                {accounts.map((a) => (
                  <option key={a.id} value={`${ACC}${a.id}`}>
                    {row.type === "INCOME" ? `from ${a.name}` : `to ${a.name}`}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        ) : (
          <span>
            {row.excludeFromStats
              ? "⊘ Internal"
              : row.counterAccount
                ? `⇄ ${row.counterAccount.name}`
                : (row.subcategory?.name ?? "—")}
          </span>
        )}
        {row.source !== "NONE" && chosen && (
          <span className="ml-1.5 text-xs text-zinc-400">
            {SOURCE_LABEL[row.source]}
            {row.source === "LLM" && row.confidence != null
              ? ` ${Math.round(row.confidence * 100)}%`
              : ""}
          </span>
        )}
        {/* The select is prefilled with the suggestion, so re-picking the same
            value fires no change event — confirming it needs its own control. */}
        {editable && row.status === "NEEDS_REVIEW" && row.predictedSubcategory && (
          <button
            className="ml-1.5 font-medium text-emerald-600 hover:underline"
            title={`Accept "${row.predictedSubcategory.name}"`}
            onClick={() =>
              onPick(`${SUB}${(row.predictedSubcategory as { id: string }).id}`)
            }
          >
            ✓ Accept
          </button>
        )}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
        {editable &&
          (skipped ? (
            <button
              className="ml-2 text-xs text-zinc-500 hover:underline"
              title="Put this row back in the import"
              onClick={() => onSkip(false)}
            >
              Restore
            </button>
          ) : (
            <button
              className="ml-2 text-xs text-zinc-400 hover:text-red-600"
              title="Drop this row from the import (e.g. a duplicate under a different date)"
              onClick={() => onSkip(true)}
            >
              ✕ Skip
            </button>
          ))}
      </td>
    </tr>
  );
}
