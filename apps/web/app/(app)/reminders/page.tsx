"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorText } from "@/components/ui";
import { api } from "@/lib/api";
import { runJob } from "@/lib/poll-job";
import { formatCents } from "@/lib/format";
import type { Reminder } from "@/lib/types";

function formatDue(iso: string | null): string {
  if (!iso) return "no date";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function RemindersPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reminders = useQuery({
    queryKey: ["reminders"],
    queryFn: () => api<Reminder[]>("/reminders"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["reminders"] });

  const scan = useMutation({
    mutationFn: () =>
      runJob<{ scanned: number; created: number }>(() =>
        api<{ jobId: string }>("/reminders/scan", { method: "POST" }),
      ),
    onSuccess: (res) => {
      invalidate();
      setNotice(
        res.created > 0
          ? `Found ${res.created} reminder${res.created === 1 ? "" : "s"}.`
          : "No new reminders in your recent transactions.",
      );
    },
    onError: setError,
  });

  const setDone = useMutation({
    mutationFn: (vars: { id: string; done: boolean }) =>
      api(`/reminders/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ done: vars.done }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/reminders/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });

  const open = reminders.data?.filter((r) => !r.done) ?? [];
  const done = reminders.data?.filter((r) => r.done) ?? [];

  const row = (r: Reminder) => (
    <li
      key={r.id}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-100 py-2 last:border-0 dark:border-zinc-900"
    >
      <span className={`font-medium ${r.done ? "text-zinc-400 line-through" : ""}`}>
        {r.label}
      </span>
      {r.cadence && (
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {r.cadence}
        </span>
      )}
      <span className="text-sm text-zinc-500">next · {formatDue(r.dueDate)}</span>
      {r.amountCents != null && (
        <span className="text-sm tabular-nums text-zinc-500">
          · {formatCents(r.amountCents, r.currency ?? "EUR")}
        </span>
      )}
      {r.note && <span className="text-xs text-zinc-400">— {r.note}</span>}
      <span className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          onClick={() => {
            setError(null);
            setDone.mutate({ id: r.id, done: !r.done });
          }}
        >
          {r.done ? "Reopen" : "Done"}
        </Button>
        <button
          aria-label="Delete reminder"
          className="px-1 text-zinc-400 hover:text-red-600"
          onClick={() => {
            setError(null);
            remove.mutate(r.id);
          }}
        >
          ×
        </button>
      </span>
    </li>
  );

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Reminders</h2>
          <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
            {scan.isPending ? "Scanning…" : "Scan for reminders"}
          </Button>
        </div>
        <p className="mb-3 text-sm text-zinc-500">
          A local model reads your transaction descriptions for future-payment
          hints (&ldquo;1/3 payment&hellip;&rdquo;, &ldquo;next in Sep&rdquo;,
          &ldquo;monthly&rdquo;) and lists what&rsquo;s coming up. It never posts
          anything — just reminds.
        </p>
        {scan.isPending && (
          <p className="text-sm text-amber-600">
            Reading recent descriptions with Ollama… this can take a moment.
          </p>
        )}
        {notice && !scan.isPending && (
          <p className="text-sm text-zinc-500">{notice}</p>
        )}
        <ErrorText error={error} />
      </Card>

      <Card>
        {reminders.isLoading && (
          <p className="text-sm text-zinc-500">Loading…</p>
        )}
        {reminders.data && open.length === 0 && done.length === 0 && (
          <p className="text-sm text-zinc-500">
            No reminders yet — hit &ldquo;Scan for reminders&rdquo; after an
            import.
          </p>
        )}
        {open.length > 0 && <ul className="flex flex-col">{open.map(row)}</ul>}
        {done.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-zinc-500">
              Dismissed ({done.length})
            </summary>
            <ul className="mt-2 flex flex-col">{done.map(row)}</ul>
          </details>
        )}
      </Card>
    </main>
  );
}
