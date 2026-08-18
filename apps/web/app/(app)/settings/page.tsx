"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { changePasswordRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function SettingsPage() {
  const { user } = useAuth();
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
