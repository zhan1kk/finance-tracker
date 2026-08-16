"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

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
          <Field label="Invite code (if you were given one)">
            <Input name="inviteCode" autoComplete="off" />
          </Field>
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
