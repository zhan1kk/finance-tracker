"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { AccuracyCard } from "@/components/accuracy-card";
import { ImportReview } from "@/components/import-review";
import { Button, Card, ErrorText, Field, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { runJob } from "@/lib/poll-job";
import {
  type Account,
  type CategorizerOption,
  type ColumnMapping,
  type CsvInspection,
  DATE_FORMATS,
  type ImportBatchSummary,
  type ImportResult,
} from "@/lib/types";

/** First header matching any of the patterns (case-insensitive), else "". */
function guessColumn(headers: string[], patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const hit = headers.find((h) => pattern.test(h));
    if (hit) return hit;
  }
  return "";
}

export default function ImportsPage() {
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  // Owned here, not in NewImport: opening a batch unmounts NewImport in the same
  // tick it sets this, so a banner rendered there would never reach the screen —
  // and unparseable rows would go missing silently.
  const [skipped, setSkipped] = useState(0);

  const skippedNotice = skipped > 0 && (
    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
      {skipped} row{skipped === 1 ? "" : "s"} could not be read (unparseable date
      or amount) and {skipped === 1 ? "was" : "were"} left out of this import.
      Check the statement if a transaction seems to be missing.
    </p>
  );

  if (activeBatchId) {
    return (
      <main className="flex flex-col gap-6">
        {skippedNotice}
        <ImportReview
          batchId={activeBatchId}
          onDone={() => {
            setActiveBatchId(null);
            setSkipped(0);
          }}
        />
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      {skippedNotice}
      <NewImport
        onImported={(batchId, skippedRows) => {
          setSkipped(skippedRows);
          setActiveBatchId(batchId);
        }}
      />
      <AccuracyCard />
      <History onOpen={setActiveBatchId} />
    </main>
  );
}

function NewImport({
  onImported,
}: {
  onImported: (batchId: string, skippedRows: number) => void;
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState("");
  const [filename, setFilename] = useState("");
  const [csv, setCsv] = useState("");
  const [inspection, setInspection] = useState<CsvInspection | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [categorizer, setCategorizer] = useState("");

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });
  // Which categorizers this server can actually run. Offering the choice per
  // import is the only way to compare two models on the same statement, and it
  // stops the decision living invisibly in an environment variable.
  const categorizers = useQuery({
    queryKey: ["categorizers"],
    queryFn: () => api<CategorizerOption[]>("/imports/categorizers"),
  });
  const offered = categorizers.data?.filter((c) => c.available) ?? [];
  // Derived rather than synced into state: the server's default stands until
  // the user picks something, without an effect to keep the two in step.
  const chosen =
    offered.find((c) => c.id === categorizer) ??
    offered.find((c) => c.isDefault);

  const reset = () => {
    setCsv("");
    setFilename("");
    setInspection(null);
    setMapping(null);
    if (fileInput.current) fileInput.current.value = "";
    if (pdfInput.current) pdfInput.current.value = "";
  };

  const onFile = async (file: File) => {
    setError(null);
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    try {
      const found = await api<CsvInspection>("/imports/inspect", {
        method: "POST",
        body: JSON.stringify({ csv: text }),
      });
      setInspection(found);
      setMapping({
        dateColumn: guessColumn(found.headers, [/date/i, /datum/i]),
        amountColumn: guessColumn(found.headers, [
          /amount/i,
          /bedrag/i,
          /sum/i,
          /value/i,
        ]),
        descriptionColumn: guessColumn(found.headers, [
          /desc/i,
          /payee|merchant|name/i,
          /memo|omschrijving|details/i,
        ]),
        dateFormat: "ISO",
        decimalSeparator: ".",
        negativeIsExpense: true,
        hasHeader: true,
      });
    } catch (err) {
      setError(err);
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api<ImportResult>("/imports", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          filename,
          csv,
          mapping,
          categorizer: chosen?.id,
        }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["import-batches"] });
      reset();
      onImported(result.batch.id, result.skipped.length);
    },
    onError: setError,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!accountId) {
      setError(new Error("Pick an account first"));
      return;
    }
    create.mutate();
  };

  // PDF path: no column mapping — a local Ollama model reads the statement into
  // rows, which then flow through the same review screen as a CSV.
  const createPdf = useMutation({
    mutationFn: (vars: { filename: string; pdfBase64: string }) =>
      runJob<ImportResult>(() =>
        api<{ jobId: string }>("/imports/pdf", {
          method: "POST",
          body: JSON.stringify({ accountId, ...vars, categorizer: chosen?.id }),
        }),
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["import-batches"] });
      reset();
      onImported(result.batch.id, result.skipped.length);
    },
    onError: setError,
  });

  const onPdfFile = async (file: File) => {
    setError(null);
    if (!accountId) {
      setError(new Error("Pick an account first"));
      if (pdfInput.current) pdfInput.current.value = "";
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    // Strip the "data:application/pdf;base64," prefix.
    const pdfBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    createPdf.mutate({ filename: file.name, pdfBase64 });
  };

  return (
    <Card>
      <h2 className="mb-1 font-medium">Import a statement</h2>
      <p className="mb-3 text-sm text-zinc-500">
        Upload a CSV export, or a PDF (read locally by Ollama) for banks that
        only give PDFs. Transactions are categorized automatically where
        possible; you confirm the rest.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Account">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Select…</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {offered.length > 1 && (
          <Field label="Categorize with">
            <Select
              value={chosen?.id ?? ""}
              onChange={(e) => setCategorizer(e.target.value)}
            >
              {offered.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.model ? ` · ${c.model}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="CSV file">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            disabled={!accountId}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm disabled:opacity-50 dark:file:border-zinc-700 dark:file:bg-zinc-900"
          />
        </Field>
        <Field label="PDF file">
          <input
            ref={pdfInput}
            type="file"
            accept=".pdf,application/pdf"
            disabled={!accountId || createPdf.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPdfFile(file);
            }}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm disabled:opacity-50 dark:file:border-zinc-700 dark:file:bg-zinc-900"
          />
        </Field>
      </div>

      {chosen && (
        <p className="mt-2 text-sm text-zinc-500">
          {chosen.sendsDataOffServer
            ? `Each row's description and amount are sent to ${chosen.label} to suggest a category. Balances and account numbers are not.`
            : "Nothing leaves this server. Less accurate on merchants it has not seen."}
          {" Reading a PDF is always done locally, whichever you pick."}
        </p>
      )}

      {!accountId && (
        <p className="mt-2 text-sm text-zinc-400">
          Pick an account first, then choose a CSV or PDF file.
        </p>
      )}

      {createPdf.isPending && (
        <p className="mt-3 text-sm text-amber-600">
          Reading the PDF with Ollama… this can take up to a minute (longer on a
          cold model). Keep this tab open.
        </p>
      )}

      {inspection && mapping && (
        <form
          onSubmit={onSubmit}
          className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800"
        >
          <p className="mb-3 text-sm text-zinc-500">
            Map the columns from <span className="font-medium">{filename}</span>{" "}
            ({inspection.headers.length} columns detected):
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <ColumnSelect
              label="Date column"
              headers={inspection.headers}
              value={mapping.dateColumn}
              onChange={(v) => setMapping({ ...mapping, dateColumn: v })}
            />
            <ColumnSelect
              label="Amount column"
              headers={inspection.headers}
              value={mapping.amountColumn}
              onChange={(v) => setMapping({ ...mapping, amountColumn: v })}
            />
            <ColumnSelect
              label="Description column"
              headers={inspection.headers}
              value={mapping.descriptionColumn}
              onChange={(v) => setMapping({ ...mapping, descriptionColumn: v })}
            />
            <Field label="Date format">
              <Select
                value={mapping.dateFormat}
                onChange={(e) =>
                  setMapping({
                    ...mapping,
                    dateFormat: e.target.value as ColumnMapping["dateFormat"],
                  })
                }
              >
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Decimals">
              <Select
                value={mapping.decimalSeparator}
                onChange={(e) =>
                  setMapping({
                    ...mapping,
                    decimalSeparator: e.target.value as "." | ",",
                  })
                }
              >
                <option value=".">1234.56</option>
                <option value=",">1234,56</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={mapping.negativeIsExpense}
                onChange={(e) =>
                  setMapping({
                    ...mapping,
                    negativeIsExpense: e.target.checked,
                  })
                }
              />
              Negative = expense
            </label>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Importing…" : "Import"}
            </Button>
          </div>

          {inspection.sample[0]?.[mapping.descriptionColumn] && (
            <p className="mt-2 text-xs text-zinc-400">
              e.g. {inspection.sample[0][mapping.dateColumn]} ·{" "}
              {inspection.sample[0][mapping.descriptionColumn]} ·{" "}
              {inspection.sample[0][mapping.amountColumn]}
            </p>
          )}
        </form>
      )}

      <ErrorText error={error} />
    </Card>
  );
}

function ColumnSelect({
  label,
  headers,
  value,
  onChange,
}: {
  label: string;
  headers: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={value ? "" : "border-amber-400"}
      >
        <option value="">Select…</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const BATCH_STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: "Needs review",
  COMMITTED: "Imported",
  UNDONE: "Undone",
};

/** Statements arrive about monthly, so a year in the full list is only
 *  scrollable, not readable — once opened, show the recent ones and fold the
 *  rest away. */
const RECENT_BATCHES = 8;

function History({ onOpen }: { onOpen: (batchId: string) => void }) {
  const batches = useQuery({
    queryKey: ["import-batches"],
    queryFn: () => api<ImportBatchSummary[]>("/imports"),
  });
  // Collapsed by default: this page is for importing a statement, and the past
  // ones are reference you go looking for rather than something to scroll past
  // every time. The count in the heading is the part worth seeing at a glance.
  const [open, setOpen] = useState(false);

  if (!batches.data || batches.data.length === 0) {
    return null;
  }

  const row = (batch: ImportBatchSummary) => {
    const total = Object.values(batch.counts).reduce((a, b) => a + b, 0);
    return (
      <li key={batch.id}>
        <button
          onClick={() => onOpen(batch.id)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left hover:opacity-80"
        >
          <span className="font-medium">{batch.filename}</span>
          <span className="text-sm text-zinc-500">
            {batch.account.name} · {total} rows
          </span>
          <span className="ml-auto text-xs text-zinc-500">
            {formatTimestamp(batch.createdAt)}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">
            {BATCH_STATUS_LABEL[batch.status] ?? batch.status}
          </span>
        </button>
      </li>
    );
  };

  const recent = batches.data.slice(0, RECENT_BATCHES);
  const older = batches.data.slice(RECENT_BATCHES);

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-medium">
          Import history
          <span className="ml-2 text-sm font-normal text-zinc-500">
            {batches.data.length}
          </span>
        </h2>
        <Button variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>

      {open && (
        <div className="mt-3">
          <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
            {recent.map(row)}
          </ul>
          {older.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                {older.length} older import{older.length === 1 ? "" : "s"}
              </summary>
              <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
                {older.map(row)}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}
