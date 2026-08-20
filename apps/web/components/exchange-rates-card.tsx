"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { todayISO } from "@/lib/format";
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
        Foreign transactions are converted to {base} for your overview.{" "}
        <b>Sync</b> pulls today&rsquo;s market rate; your exchange fee is applied
        so the stored rate reflects what you actually get. A rate applies from its
        date until the next later one; changing it recomputes affected
        transactions.
      </p>
      <AddCurrency base={base} />
      {prefs.data?.currencies.length === 0 && (
        <p className="mb-2 text-sm text-zinc-500">
          No foreign currencies yet. Add one above if you hold money, or spend,
          in something other than {base}.
        </p>
      )}
      <div className="flex flex-col gap-5">
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
    onSuccess: invalidate,
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
    onSuccess: invalidate,
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/fx/rates/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
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

  return (
    <div className="border-t border-zinc-100 pt-4 first:border-0 first:pt-0 dark:border-zinc-900">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-medium">
          {currency} → {base}
        </h3>
        {rates.data && (
          <span className="text-sm text-zinc-500">
            today: 1 {base} = <b>{round(rates.data.effectiveRate)}</b> {currency}
          </span>
        )}
        <label
          className="ml-auto flex items-center gap-1.5 text-sm text-zinc-500"
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
          daily
        </label>
        <Button
          variant="ghost"
          disabled={sync.isPending}
          onClick={() => {
            setError(null);
            sync.mutate(undefined);
          }}
        >
          {sync.isPending ? "Syncing…" : "Sync now"}
        </Button>
        <button
          type="button"
          className="text-xs text-zinc-400 hover:text-red-600"
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
          remove
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
            placeholder="540"
            className="w-28"
            required
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={setRate.isPending}>
          Set manually
        </Button>
      </form>

      {rates.data && rates.data.rates.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {rates.data.rates.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="w-24 text-zinc-500">{r.date.slice(0, 10)}</span>
              <span>
                1 {base} = {round(r.rate)} {currency}
              </span>
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
                onClick={() => {
                  // Removing a rate re-converts every transaction that used it,
                  // so the card's own warning deserves a confirmation.
                  if (
                    !window.confirm(
                      `Remove the ${r.date.slice(0, 10)} rate? Transactions converted with it are recalculated at the next rate that applies.`,
                    )
                  )
                    return;
                  setError(null);
                  remove.mutate(r.id);
                }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
    </div>
  );
}
