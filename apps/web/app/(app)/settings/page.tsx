"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api, changePasswordRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";

export default function SettingsPage() {
  const { user, updateProfile } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = String(form.get("newPassword"));
    // Checked here rather than server-side: the confirmation field exists only
    // to catch a typo before it locks you out of your own account.
    if (next !== String(form.get("confirmPassword"))) {
      setMismatch(true);
      setError(null);
      return;
    }
    setMismatch(false);
    setBusy(true);
    setError(null);
    try {
      await changePasswordRequest(String(form.get("currentPassword")), next);
      router.replace("/login");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

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

      <Card>
        <h2 className="font-semibold">Change password</h2>
        <p className="mt-1 mb-3 text-sm text-zinc-500">
          You will be signed out everywhere and can sign back in with the new
          password.
        </p>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="Current password">
            <Input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password (min. 8 characters)">
            <Input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label="Repeat new password">
            <Input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          {mismatch && (
            <p className="text-sm text-red-600 dark:text-red-400">
              The two new passwords do not match.
            </p>
          )}
          <ErrorText error={error} />
          <Button type="submit" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="font-semibold">Forgotten password</h2>
        <p className="mt-1 text-sm text-zinc-500">
          There is no reset email: this server sends no mail, and the accounts
          here are invite-only. If you are locked out, ask whoever runs the
          server to set a new password for you, then change it from this page.
        </p>
      </Card>
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
      <h2 className="font-semibold">Reporting currency</h2>
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
            Converted at the latest rate. Budgets stay in EUR.
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
