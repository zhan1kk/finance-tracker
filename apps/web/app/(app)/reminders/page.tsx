"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCents, parseAmountToCents } from "@/lib/format";
import { runJob } from "@/lib/poll-job";
import type { Reminder, Subcategory } from "@/lib/types";

const CADENCES = ["weekly", "monthly", "quarterly", "yearly", "one-off"];

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
  const { user } = useAuth();
  const baseCurrency = user?.baseCurrency ?? "EUR";
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reminders = useQuery({
    queryKey: ["reminders"],
    queryFn: () => api<Reminder[]>("/reminders"),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["reminders"] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Reminder>("/reminders", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });

  const markPaid = useMutation({
    mutationFn: (id: string) =>
      api(`/reminders/${id}/paid`, { method: "POST" }),
    onSuccess: invalidate,
    onError: setError,
  });

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

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const form = new FormData(e.currentTarget);
    const label = String(form.get("label") || "").trim();
    if (!label) {
      setError(new Error("Give the reminder a name"));
      return;
    }
    const amountRaw = String(form.get("amount") || "").trim();
    const amountCents = amountRaw ? parseAmountToCents(amountRaw) : undefined;
    if (amountRaw && amountCents === null) {
      setError(new Error("Invalid amount — e.g. 12.50"));
      return;
    }
    const instRaw = String(form.get("installmentsTotal") || "").trim();
    const installmentsTotal = instRaw ? Number(instRaw) : undefined;
    if (
      instRaw &&
      (!Number.isInteger(installmentsTotal) || (installmentsTotal ?? 0) < 2)
    ) {
      setError(new Error("Installments must be a whole number of 2 or more"));
      return;
    }
    create.mutate({
      label,
      subcategoryId: String(form.get("subcategoryId") || "") || undefined,
      dueDate: String(form.get("dueDate") || "") || undefined,
      amountCents: amountCents ?? undefined,
      currency: amountCents != null ? baseCurrency : undefined,
      cadence: String(form.get("cadence") || "") || undefined,
      installmentsTotal: installmentsTotal ?? undefined,
      note: String(form.get("note") || "").trim() || undefined,
    });
    e.currentTarget.reset();
  };

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
      {r.subcategory && (
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {r.subcategory.name}
        </span>
      )}
      <span className="text-sm text-zinc-500">next · {formatDue(r.dueDate)}</span>
      {r.amountCents != null && (
        <span className="text-sm tabular-nums text-zinc-500">
          · {formatCents(r.amountCents, r.currency ?? "EUR")}
        </span>
      )}
      {r.installmentsTotal != null && (
        <span className="text-xs font-medium text-zinc-500">
          {r.installmentsPaid ?? 0}/{r.installmentsTotal} paid
        </span>
      )}
      {r.note && <span className="text-xs text-zinc-400">— {r.note}</span>}
      <span className="ml-auto flex items-center gap-1">
        {r.installmentsTotal != null &&
          !r.done &&
          (r.installmentsPaid ?? 0) < r.installmentsTotal && (
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                markPaid.mutate(r.id);
              }}
            >
              Mark paid
            </Button>
          )}
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
          A local model reads your transaction descriptions for two things:
          upcoming payments (&ldquo;1/3 payment&hellip;&rdquo;, &ldquo;next in
          Sep&rdquo;, &ldquo;monthly&rdquo;) and money you owe or are owed
          (&ldquo;125 is Shar&rsquo;s share, ask her&rdquo;, &ldquo;shared w
          Amaani&rdquo;). It never posts anything — just reminds.
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
        <h2 className="mb-3 font-medium">Add a reminder</h2>
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <Field label="What">
            <Input name="label" required placeholder="Netflix" className="w-40" />
          </Field>
          <Field label="Category">
            <Select name="subcategoryId" defaultValue="">
              <option value="">—</option>
              {(subcategories.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.category})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount">
            <Input name="amount" placeholder="12.50" className="w-24" />
          </Field>
          <Field label="Next payment">
            <Input name="dueDate" type="date" className="w-40" />
          </Field>
          <Field label="Repeats">
            <Select name="cadence" defaultValue="">
              <option value="">—</option>
              {CADENCES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Installments">
            <Input
              name="installmentsTotal"
              placeholder="e.g. 3"
              inputMode="numeric"
              className="w-20"
            />
          </Field>
          <Field label="Note">
            <Input name="note" placeholder="optional" className="w-40" />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Add
          </Button>
        </form>
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
