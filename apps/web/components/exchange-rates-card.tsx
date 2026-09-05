"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import type { FxPreferences, FxRates } from "@/lib/types";

/** Trim a rate to 4 decimals for display without long floating tails. */
function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function ExchangeRatesCard() {
  const prefs = useQuery({
    queryKey: ["fx-preferences"],
    queryFn: () => api<FxPreferences>("/fx/preferences"),
  });
  const base = prefs.data?.baseCurrency ?? "EUR";

  return (
    <Card>
      <h2 className="mb-1 font-medium">Exchange rates</h2>
      <p className="mb-4 text-sm text-zinc-500">
        Foreign transactions are converted to {base} for your overview, using
        the rate in effect on each transaction&rsquo;s date.
      </p>
      <AddCurrency base={base} />
      {prefs.data?.currencies.length === 0 && (
        <p className="mb-2 text-sm text-zinc-500">
          No foreign currencies yet. Add one above if you hold money, or spend,
          in something other than {base}.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {(prefs.data?.currencies ?? []).map((c) => (
          <CurrencyRates
            key={c.currency}
            currency={c.currency}
            spreadPct={c.spreadPct}
            autoSync={c.autoSync}
            base={base}
          />
        ))}
      </div>
    </Card>
  );
}

/** Adds a currency to track. The rate is fetched on the server as it is added. */
function AddCurrency({ base }: { base: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const add = useMutation({
    mutationFn: (currency: string) =>
      api("/fx/currencies", {
        method: "POST",
        body: JSON.stringify({ currency }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fx-preferences"] });
      void queryClient.invalidateQueries({ queryKey: ["fx-rates"] });
    },
    onError: setError,
  });

  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem(
          "currency",
        ) as HTMLInputElement;
        const code = input.value.trim().toUpperCase();
        if (code.length !== 3) {
          setError(new Error("Use a three-letter code, e.g. USD"));
          return;
        }
        setError(null);
        add.mutate(code, { onSuccess: () => (input.value = "") });
      }}
    >
      <Field label="Track another currency">
        <Input
          name="currency"
          placeholder="USD"
          maxLength={3}
          className="w-24 uppercase"
          list="common-currencies"
        />
      </Field>
      <datalist id="common-currencies">
        {["USD", "GBP", "KZT", "TRY", "CHF", "PLN", "SEK", "JPY", "AED"]
          .filter((c) => c !== base)
          .map((c) => (
            <option key={c} value={c} />
          ))}
      </datalist>
      <Button type="submit" variant="ghost" disabled={add.isPending}>
        {add.isPending ? "Checking…" : "Add"}
      </Button>
      <ErrorText error={error} />
    </form>
  );
}

function CurrencyRates({
  currency,
  spreadPct,
  autoSync,
  base,
}: {
  currency: string;
  spreadPct: number;
  autoSync: boolean;
  base: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [spread, setSpread] = useState(String(spreadPct));
  const [pastDate, setPastDate] = useState("");
  const [open, setOpen] = useState(false);
  // Changing a rate rewrites the stored base amount of every transaction in
  // this currency from that date on. The server has always reported how many
  // it touched; nothing showed it, so past totals moved with no sign that they
  // had. Silent history is the thing this app is meant not to do.
  const [notice, setNotice] = useState<string | null>(null);
  const reportRecomputed = (what: string) => (res: unknown) => {
    const n = (res as { recomputed?: number } | undefined)?.recomputed ?? 0;
    setNotice(
      n === 0
        ? `${what}. No stored amounts changed.`
        : `${what}. ${n} transaction${n === 1 ? "" : "s"} recalculated.`,
    );
  };

  const setAutoSync = useMutation({
    mutationFn: (next: boolean) =>
      api(`/fx/currencies/${currency}/auto-sync`, {
        method: "PUT",
        body: JSON.stringify({ autoSync: next }),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["fx-preferences"] }),
    onError: setError,
  });

  const stopTracking = useMutation({
    mutationFn: () =>
      api(`/fx/currencies/${currency}`, { method: "DELETE" }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["fx-preferences"] }),
    onError: setError,
  });

  const rates = useQuery({
    queryKey: ["fx-rates", currency],
    queryFn: () => api<FxRates>(`/fx/rates?currency=${currency}`),
  });

  // Any rate change recomputes converted amounts, so refresh dependent views.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["fx-rates", currency] });
    void queryClient.invalidateQueries({ queryKey: ["fx-preferences"] });
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
  };

  const sync = useMutation({
    // With a date, fetches the rate as it was that day — needed for older
    // transactions, which otherwise fall back to a rough built-in rate.
    mutationFn: (date?: string) =>
      api("/fx/rates/sync", {
        method: "POST",
        body: JSON.stringify(date ? { currency, date } : { currency }),
      }),
    onSuccess: (res) => {
      invalidate();
      reportRecomputed("Rate synced")(res);
    },
    onError: setError,
  });
  const saveSpread = useMutation({
    mutationFn: (pct: number) =>
      api(`/fx/preferences/${currency}`, {
        method: "PUT",
        body: JSON.stringify({ spreadPct: pct }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });
  const setRate = useMutation({
    mutationFn: (body: { currency: string; date: string; rate: number }) =>
      api("/fx/rates", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (res) => {
      invalidate();
      reportRecomputed("Rate saved")(res);
    },
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/fx/rates/${id}`, { method: "DELETE" }),
    onSuccess: (res) => {
      invalidate();
      reportRecomputed("Rate removed")(res);
    },
    onError: setError,
  });

  const onSubmitRate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const rate = Number(form.get("rate"));
    const date = String(form.get("date"));
    if (!(rate > 0)) {
      setError(new Error("Rate must be a positive number"));
      return;
    }
    const form_ = e.currentTarget;
    setRate.mutate(
      { currency, date, rate },
      { onSuccess: () => form_.reset() },
    );
  };

  const onSaveSpread = () => {
    setError(null);
    const pct = Number(spread);
    if (!Number.isFinite(pct) || pct < 0 || pct > 10) {
      setError(new Error("Fee must be between 0 and 10%"));
      return;
    }
    saveSpread.mutate(pct);
  };

  const latest = rates.data?.rates[0];

  return (
    <div className="border-t border-zinc-100 pt-3 first:border-0 first:pt-0 dark:border-zinc-900">
      {/* The whole currency on one line. Everything below used to be open at
          once, so three tracked currencies filled the screen with forms that
          are touched about twice a year. Today's rate and Sync are the parts
          anyone actually looks at; the rest sits one click away. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-10 font-medium">{currency}</span>
        {rates.data ? (
          <span className="text-sm tabular-nums">
            1 {base} = <b>{round(rates.data.effectiveRate)}</b> {currency}
          </span>
        ) : (
          <span className="text-sm text-zinc-400">
            {rates.isError ? "rate unavailable" : "loading…"}
          </span>
        )}
        {latest && (
          <span className="text-xs text-zinc-400">
            as of {formatDate(latest.date)}
          </span>
        )}
        {autoSync && (
          <span
            className="text-xs text-zinc-400"
            title="Fetched automatically each morning"
          >
            · daily
          </span>
        )}
        <Button
          variant="ghost"
          className="ml-auto"
          disabled={sync.isPending}
          onClick={() => {
            setError(null);
            setNotice(null);
            sync.mutate(undefined);
          }}
        >
          {sync.isPending ? "Syncing…" : "Sync now"}
        </Button>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`fx-details-${currency}`}
          title={open ? "Hide settings" : "Rate history, fee and manual rates"}
          className="rounded px-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          onClick={() => setOpen(!open)}
        >
          <span className="inline-block transition-transform">
            {open ? "⌃" : "⌄"}
          </span>
        </button>
      </div>

      {notice && (
        <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-500">
          {notice}
        </p>
      )}

      <div
        id={`fx-details-${currency}`}
        hidden={!open}
        className="mt-3 border-l-2 border-zinc-100 pl-3 dark:border-zinc-800"
      >
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <label
            className="flex items-center gap-1.5 text-sm text-zinc-500"
            title="Fetch this rate automatically each morning"
          >
            <input
              type="checkbox"
              checked={autoSync}
              disabled={setAutoSync.isPending}
              onChange={(e) => {
                setError(null);
                setAutoSync.mutate(e.target.checked);
              }}
            />
            Sync daily
          </label>
          <button
            type="button"
            className="ml-auto text-xs text-zinc-400 hover:text-red-600"
            title={`Stop tracking ${currency}`}
            onClick={() => {
              if (
                !window.confirm(
                  `Stop tracking ${currency}? Rates already recorded stay, but no new ones are fetched.`,
                )
              )
                return;
              setError(null);
              stopTracking.mutate();
            }}
          >
            stop tracking
          </button>
        </div>

      <div className="mb-2 flex flex-wrap items-end gap-2">
        <Field label="Fetch the rate for a past day">
          {/* Deliberately not onChange: a date input reports every intermediate
              value, so typing a day and month fired a request (and a failure)
              before the year existed, and paging through the calendar fetched a
              rate for each month passed. The date is only used when asked for. */}
          <div className="flex items-end gap-2">
            <Input
              type="date"
              className="w-auto"
              value={pastDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setPastDate(e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={!pastDate || sync.isPending}
              onClick={() => {
                setError(null);
                sync.mutate(pastDate, { onSuccess: () => setPastDate("") });
              }}
            >
              Fetch
            </Button>
          </div>
        </Field>
        <p className="pb-2 text-xs text-zinc-500">
          Older transactions use the rate in effect on their date. With none,
          they fall back to a rough built-in rate.
        </p>
      </div>

      <div className="mb-2 flex flex-wrap items-end gap-3">
        <Field label="Exchange fee %">
          <Input
            value={spread}
            onChange={(e) => setSpread(e.target.value)}
            inputMode="decimal"
            className="w-20"
            placeholder="0"
          />
        </Field>
        <Button
          variant="ghost"
          disabled={saveSpread.isPending || spread === String(spreadPct)}
          onClick={onSaveSpread}
        >
          Save fee
        </Button>
        <span className="text-xs text-zinc-400">
          applied when you Sync (0–10%)
        </span>
      </div>

      <form onSubmit={onSubmitRate} className="flex flex-wrap items-end gap-3">
        <Field label="From date">
          <Input name="date" type="date" defaultValue={todayISO()} required />
        </Field>
        <Field label={`1 ${base} =`}>
          <Input
            name="rate"
            type="number"
            step="0.0001"
            min="0"
            /* The rate in effect, not a constant. It was hardcoded to 540 —
               a tenge-shaped number sitting under "1 EUR =" on a dollar card,
               suggesting an answer three orders of magnitude out. */
            placeholder={
              rates.data ? String(round(rates.data.effectiveRate)) : undefined
            }
            className="w-28"
            required
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={setRate.isPending}>
          Set manually
        </Button>
      </form>

      {rates.data && rates.data.rates.length > 0 && (
        <RateHistory
          rates={rates.data.rates}
          base={base}
          currency={currency}
          onRemove={(id, date) => {
            // Removing a rate re-converts every transaction that used it, so
            // the card's own warning deserves a confirmation.
            if (
              !window.confirm(
                `Remove the ${date} rate? Transactions converted with it are recalculated at the next rate that applies.`,
              )
            )
              return;
            setError(null);
            remove.mutate(id);
          }}
        />
      )}
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/**
 * Rate history, newest first. Daily sync adds a row a day, so only the few most
 * recent are shown and the rest sit behind a count — a wall of near-identical
 * numbers is not history anyone reads.
 */
function RateHistory({
  rates,
  base,
  currency,
  onRemove,
}: {
  rates: { id: string; date: string; rate: number }[];
  base: string;
  currency: string;
  onRemove: (id: string, date: string) => void;
}) {
  const RECENT = 3;
  const recent = rates.slice(0, RECENT);
  const older = rates.slice(RECENT);

  const row = (r: { id: string; date: string; rate: number }) => (
    <li key={r.id} className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-zinc-500 tabular-nums">
        {formatDate(r.date)}
      </span>
      <span className="tabular-nums">
        1 {base} = {round(r.rate)} {currency}
      </span>
      <button
        type="button"
        className="ml-auto text-xs text-zinc-400 hover:text-red-600"
        onClick={() => onRemove(r.id, formatDate(r.date))}
      >
        remove
      </button>
    </li>
  );

  return (
    <div className="mt-2 text-sm">
      <ul className="flex flex-col gap-1">{recent.map(row)}</ul>
      {older.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            {older.length} older rate{older.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">{older.map(row)}</ul>
        </details>
      )}
    </div>
  );
}
