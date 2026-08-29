"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // Whether this deployment gates registration. Asked rather than assumed: the
  // field is mandatory on an invite-only server and pointless on a self-hosted
  // one with no code set, and the label used to hedge between the two.
  const policy = useQuery({
    queryKey: ["registration-policy"],
    queryFn: () => api<{ inviteRequired: boolean }>("/auth/registration"),
  });
  const inviteRequired = policy.data?.inviteRequired ?? false;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const inviteCode = String(form.get("inviteCode") ?? "").trim();
      await register(
        String(form.get("email")),
        String(form.get("password")),
        inviteCode || undefined,
      );
      router.push("/");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-4">
      <Card>
        <h1 className="mb-4 text-xl font-semibold">Create account</h1>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="Email">
            <Input name="email" type="email" required autoFocus />
          </Field>
          <Field label="Password (min. 8 characters)">
            <Input name="password" type="password" minLength={8} required />
          </Field>
          {/* Hidden entirely where nothing gates registration — a field with
              nothing to put in it is worse than no field. */}
          {(inviteRequired || policy.isLoading) && (
            <Field label="Invite code">
              <Input
                name="inviteCode"
                autoComplete="off"
                required={inviteRequired}
                disabled={policy.isLoading}
              />
            </Field>
          )}
          <ErrorText error={error} />
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Register"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-zinc-500">
          Already registered?{" "}
          <Link href="/login" className="underline">
            Sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
