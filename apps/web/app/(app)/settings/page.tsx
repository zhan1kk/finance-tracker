"use client";

import { useState } from "react";
import { Card, ErrorText, Field, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";

export default function SettingsPage() {
  const { user, updateProfile } = useAuth();

  return (
    <main className="flex max-w-md flex-col gap-6">
      <Card>
        <h1 className="text-lg font-semibold">Account</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Signed in as {user?.email}.
        </p>
      </Card>

      <ReportingCurrency
        current={user?.baseCurrency ?? "EUR"}
        onChange={(baseCurrency) => updateProfile({ baseCurrency })}
      />

    </main>
  );
}

/**
 * Which currency totals are shown in.
 *
 * Presentation only: amounts stay stored in EUR and the server converts them at
 * one current rate, so switching is free and reversible — nothing is rewritten
 * and no history is recomputed. Offered from the currencies this account
 * already tracks, because those are the ones a rate is known for.
 */
function ReportingCurrency({
  current,
  onChange,
}: {
  current: string;
  onChange: (currency: string) => Promise<void>;
}) {
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const prefs = useQuery({
    queryKey: ["fx-preferences"],
    queryFn: () =>
      api<{ baseCurrency: string; currencies: { currency: string }[] }>(
        "/fx/preferences",
      ),
  });
  const options = Array.from(
    new Set([
      "EUR",
      ...(prefs.data?.currencies ?? []).map((c) => c.currency),
      current,
    ]),
  );

  return (
    <Card>
      <h2 className="font-medium">Reporting currency</h2>
      <p className="mb-3 mt-1 text-sm text-zinc-500">
        The currency your totals are shown in — the dashboard, the charts and
        the reports. Your accounts keep their own currencies, and every amount
        stays stored in EUR: this only converts them for display, at one current
        rate, so you can change it back at any time without touching your data.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Show totals in">
          <Select
            value={current}
            disabled={saving}
            onChange={(e) => {
              const next = e.target.value;
              setError(null);
              setSaving(true);
              void onChange(next)
                .catch(setError)
                .finally(() => setSaving(false));
            }}
          >
            {options.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        {current !== "EUR" && (
          <p className="pb-2 text-xs text-zinc-500">
            Converted at the latest rate.
          </p>
        )}
      </div>
      <ErrorText error={error} />
      <p className="mt-2 text-xs text-zinc-400">
        To show totals in a currency not listed, add it under Accounts →
        Exchange rates first.
      </p>
    </Card>
  );
}
