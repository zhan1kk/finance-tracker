"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCents, parseAmountToCents } from "@/lib/format";
import { runJob } from "@/lib/poll-job";
import type {
  RecurringCadence,
  RecurringRule,
  Reminder,
  Subcategory,
  Transaction,
  TransactionList,
} from "@/lib/types";

const CADENCES = ["weekly", "monthly", "quarterly", "yearly", "one-off"];

/** Human label for a recurring rule's cadence + interval (e.g. "every 2 weeks"). */
function cadenceLabel(cadence: RecurringCadence, interval: number): string {
  const base = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" }[
    cadence
  ];
  if (interval === 1) return base;
  const unit = { DAILY: "days", WEEKLY: "weeks", MONTHLY: "months", YEARLY: "years" }[
    cadence
  ];
  return `every ${interval} ${unit}`;
}

/**
 * Searches the user's incomes so they can pick the one that paid back an
 * "Ask …" reminder. Selecting it reimburses the reminder's source expense and
 * marks the reminder done.
 */
function IncomePicker({
  currency,
  pending,
  onPick,
  onCancel,
}: {
  currency: string;
  pending: boolean;
  onPick: (transactionId: string) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const results = useQuery({
    queryKey: ["reminder-income-search", debounced],
    queryFn: () =>
      api<TransactionList>(
        `/transactions?type=INCOME&pageSize=12${
          debounced ? `&search=${encodeURIComponent(debounced)}` : ""
        }`,
      ),
  });

  const label = (t: Transaction) =>
    `${t.date.slice(0, 10)} · ${t.description || t.subcategory?.name || "income"} · ${formatCents(t.amount, currency)}`;

  return (
    <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-800/40">
      <p className="mb-1 text-xs text-zinc-500">
        Which income paid this back? Linking it reimburses the original expense
        and marks this done.
      </p>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="search income (name, amount)…"
        className="w-full text-sm"
        autoFocus
      />
      <div className="mt-1 max-h-40 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-800">
        {results.data?.items.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={pending}
            className="block w-full px-2 py-1 text-left text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
            onClick={() => onPick(t.id)}
          >
            {label(t)}
          </button>
        ))}
        {results.data?.items.length === 0 && (
          <p className="px-2 py-1 text-xs text-zinc-400">no matching income</p>
        )}
      </div>
      <button
        type="button"
        className="mt-1 text-xs text-zinc-500 hover:underline"
        onClick={onCancel}
      >
        cancel
      </button>
    </div>
  );
}

function formatDue(iso: string | null): string {
  if (!iso) return "no date";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Whole months a due date is in the past (0 if under a month), so we can hint
 * how far behind an unrecorded payment is. */
function monthsOverdue(due: Date, today: Date): number {
  let m =
    (today.getFullYear() - due.getFullYear()) * 12 +
    (today.getMonth() - due.getMonth());
  if (today.getDate() < due.getDate()) m -= 1;
  return Math.max(0, m);
}


export default function RemindersPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const baseCurrency = user?.baseCurrency ?? "EUR";
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The reminder whose "Received" income picker is open, if any.
  const [settling, setSettling] = useState<string | null>(null);

  const reminders = useQuery({
    queryKey: ["reminders"],
    queryFn: () => api<Reminder[]>("/reminders"),
  });
  const subcategories = useQuery({
    queryKey: ["subcategories"],
    queryFn: () => api<Subcategory[]>("/subcategories"),
  });
  // Active recurring rules surface as read-only "upcoming (auto)" rows — they
  // post their own transaction on the date, so they're shown for visibility, not
  // as something to act on.
  const recurringRules = useQuery({
    queryKey: ["recurring"],
    queryFn: () => api<RecurringRule[]>("/recurring"),
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

  // Links the income that paid back an "Ask …" reminder: reimburses the source
  // expense and marks the reminder done. Touches transactions + stats too.
  const linkPayment = useMutation({
    mutationFn: (vars: { id: string; transactionId: string }) =>
      api(`/reminders/${vars.id}/link-payment`, {
        method: "POST",
        body: JSON.stringify({ transactionId: vars.transactionId }),
      }),
    onSuccess: () => {
      setSettling(null);
      void queryClient.invalidateQueries({ queryKey: ["reminders"] });
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
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

  const detect = useMutation({
    mutationFn: () =>
      api<{ created: number }>("/reminders/detect-recurring", {
        method: "POST",
      }),
    onSuccess: (res) => {
      invalidate();
      setNotice(
        res.created > 0
          ? `Added ${res.created} recurring bill${res.created === 1 ? "" : "s"}.`
          : "No new recurring bills found in your Bills/Subscriptions.",
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
  const payments = open.filter((r) => r.kind === "payment");
  const ious = open.filter((r) => r.kind !== "payment");

  // Active expense rules, soonest first — shown read-only alongside reminders.
  const autoRules = (recurringRules.data ?? [])
    .filter((r) => r.active && r.type === "EXPENSE")
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));

  // Local midnight, for flagging reminders whose due date has already passed.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const row = (r: Reminder) => {
    const isInstallment = r.installmentsTotal != null;
    const installmentRemaining =
      isInstallment && (r.installmentsPaid ?? 0) < (r.installmentsTotal ?? 0);
    // A plain recurring payment (cadence + a due date, no fixed plan) can be
    // rolled forward a period when paid, instead of only being dismissed.
    const canAdvanceRecurring =
      !isInstallment &&
      r.kind === "payment" &&
      !!r.cadence &&
      r.cadence !== "one-off" &&
      !!r.dueDate;
    const showMarkPaid =
      !r.done && (installmentRemaining || canAdvanceRecurring);
    // A due date already in the past on an open reminder = a payment that fell
    // due but hasn't been recorded yet (e.g. the statement isn't imported).
    const overdue = !r.done && !!r.dueDate && new Date(r.dueDate) < startOfToday;
    const monthsBehind = overdue
      ? monthsOverdue(new Date(r.dueDate as string), startOfToday)
      : 0;
    return (
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
      {/* Skip the category chip when it just repeats the label (detected
          recurring bills use the subcategory name as the label). */}
      {r.subcategory && r.subcategory.name !== r.label && (
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {r.subcategory.name}
        </span>
      )}
      <span
        className={`text-sm ${overdue ? "font-medium text-red-600" : "text-zinc-500"}`}
      >
        {overdue ? "due" : "next"} · {formatDue(r.dueDate)}
      </span>
      {overdue && (
        <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
          overdue
          {monthsBehind >= 1 &&
            ` · ${monthsBehind} mo${monthsBehind === 1 ? "" : "s"} behind`}
        </span>
      )}
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
        {/* A friend owes them ("Ask …" read from an expense): settle it by
            linking the income that paid it back. */}
        {!r.done &&
          r.sourceTransaction?.type === "EXPENSE" &&
          r.kind === "ask" && (
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                setSettling(settling === r.id ? null : r.id);
              }}
            >
              Received
            </Button>
          )}
        {showMarkPaid && (
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
      {settling === r.id && (
        <div className="w-full">
          <IncomePicker
            currency={r.currency ?? baseCurrency}
            pending={linkPayment.isPending}
            onPick={(transactionId) =>
              linkPayment.mutate({ id: r.id, transactionId })
            }
            onCancel={() => setSettling(null)}
          />
        </div>
      )}
    </li>
    );
  };

  const section = (title: string, subtitle: string, items: Reminder[]) =>
    items.length === 0 ? null : (
      <section className="mb-5 last:mb-0">
        <div className="mb-0.5 flex items-baseline gap-2">
          <h3 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase dark:text-zinc-300">
            {title}
          </h3>
          <span className="text-xs text-zinc-400">{items.length}</span>
        </div>
        <p className="mb-1 text-xs text-zinc-400">{subtitle}</p>
        <ul className="flex flex-col">{items.map(row)}</ul>
      </section>
    );

  // A recurring rule, read-only: it posts its own transaction on the date, so
  // there's nothing to mark paid — just a heads-up, with a link to manage it.
  const autoRow = (rule: RecurringRule) => {
    const overdue = new Date(rule.nextRunAt) < startOfToday;
    return (
      <li
        key={rule.id}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-100 py-2 last:border-0 dark:border-zinc-900"
      >
        <span className="font-medium">
          {rule.subcategory.name}
          {rule.description ? ` · ${rule.description}` : ""}
        </span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {cadenceLabel(rule.cadence, rule.interval)}
        </span>
        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
          auto
        </span>
        <span
          className={`text-sm ${overdue ? "font-medium text-red-600" : "text-zinc-500"}`}
        >
          {overdue ? "due" : "next"} · {formatDue(rule.nextRunAt)}
        </span>
        <span className="text-sm tabular-nums text-zinc-500">
          · {formatCents(rule.amount, rule.account.currency)}
        </span>
        <Link
          href="/recurring"
          className="ml-auto text-xs text-zinc-500 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
        >
          manage
        </Link>
      </li>
    );
  };

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Reminders</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                setNotice(null);
                detect.mutate();
              }}
              disabled={detect.isPending}
              title="Find bills & subscriptions that repeat monthly/quarterly and remind you"
            >
              {detect.isPending ? "Detecting…" : "Detect recurring bills"}
            </Button>
            <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
              {scan.isPending ? "Scanning…" : "Scan for reminders"}
            </Button>
          </div>
        </div>
        <p className="mb-3 text-sm text-zinc-500">
          A local model reads your transaction descriptions for two things:
          upcoming payments (&ldquo;1/3 payment&hellip;&rdquo;, &ldquo;next in
          Sep&rdquo;, &ldquo;monthly&rdquo;) and money you owe or are owed (a
          friend&rsquo;s share of a bill, an IOU you jotted down). It never posts
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
        {reminders.data &&
          open.length === 0 &&
          done.length === 0 &&
          autoRules.length === 0 && (
            <p className="text-sm text-zinc-500">
              No reminders yet — hit &ldquo;Scan for reminders&rdquo; after an
              import.
            </p>
          )}
        {section(
          "Upcoming payments",
          "Bills, subscriptions and installments coming due",
          payments,
        )}
        {autoRules.length > 0 && (
          <section className="mb-5 last:mb-0">
            <div className="mb-0.5 flex items-baseline gap-2">
              <h3 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase dark:text-zinc-300">
                Auto-posting rules
              </h3>
              <span className="text-xs text-zinc-400">{autoRules.length}</span>
            </div>
            <p className="mb-1 text-xs text-zinc-400">
              These post their own transaction on the date — shown for
              visibility. Manage them on the Recurring page.
            </p>
            <ul className="flex flex-col">{autoRules.map(autoRow)}</ul>
          </section>
        )}
        {section(
          "Money owed",
          "IOUs — collect a friend's share, or pay one back",
          ious,
        )}
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
