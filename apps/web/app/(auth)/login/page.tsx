"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await login(String(form.get("email")), String(form.get("password")));
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
        <h1 className="mb-4 text-xl font-semibold">Sign in</h1>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="Email">
            <Input name="email" type="email" required autoFocus />
          </Field>
          <Field label="Password">
            <Input name="password" type="password" required />
          </Field>
          <ErrorText error={error} />
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-zinc-500">
          No account yet?{" "}
          <Link href="/register" className="underline">
            Register
          </Link>
        </p>
      </Card>
    </main>
  );
}
