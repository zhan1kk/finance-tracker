"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { todayISO } from "@/lib/format";
import type { FxRates } from "@/lib/types";

/** The one non-base currency the app supports. */
const FOREIGN = "KZT";

export function ExchangeRatesCard() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const rates = useQuery({
    queryKey: ["fx-rates", FOREIGN],
    queryFn: () => api<FxRates>(`/fx/rates?currency=${FOREIGN}`),
  });

  // Setting a rate recomputes converted amounts, so refresh dependent views too.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["fx-rates", FOREIGN] });
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
  };

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

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const rate = Number(form.get("rate"));
    const date = String(form.get("date"));
    if (!(rate > 0)) {
      setError(new Error("Rate must be a positive number"));
      return;
    }
    setRate.mutate({ currency: FOREIGN, date, rate });
    e.currentTarget.reset();
  };

  const base = rates.data?.baseCurrency ?? "EUR";

  return (
    <Card>
      <h2 className="mb-1 font-medium">
        Exchange rate ({FOREIGN} → {base})
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        {FOREIGN} transactions are converted to {base} for your overview. A rate
        applies from its date until the next later one; changing it recomputes
        the affected transactions.
      </p>

      {rates.data && (
        <p className="mb-3 text-sm">
          Today:{" "}
          <b>
            1 {base} = {rates.data.effectiveRate} {FOREIGN}
          </b>
        </p>
      )}

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
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
        <Button type="submit" disabled={setRate.isPending}>
          Set rate
        </Button>
      </form>

      {rates.data && rates.data.rates.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {rates.data.rates.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="w-24 text-zinc-500">{r.date.slice(0, 10)}</span>
              <span>
                1 {base} = {r.rate} {r.currency}
              </span>
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
                onClick={() => {
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
    </Card>
  );
}
