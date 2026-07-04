"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents, parseAmountToCents } from "@/lib/format";
import { ACCOUNT_TYPES, type Account } from "@/lib/types";

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["accounts"] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Account>("/accounts", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
    onError: setError,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<Account>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/accounts/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: setError,
  });

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const amountInput = String(form.get("initialBalance") || "0") || "0";
    const initialBalance =
      amountInput === "0" ? 0 : parseAmountToCents(amountInput);
    if (initialBalance === null) {
      setError(new Error("Invalid starting balance"));
      return;
    }
    create.mutate({
      name: String(form.get("name")),
      type: String(form.get("type")),
      currency: String(form.get("currency")).toUpperCase(),
      initialBalance,
    });
    e.currentTarget.reset();
  };

  return (
    <main className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-3 font-medium">New account</h2>
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <Input name="name" required placeholder="Main checking" />
          </Field>
          <Field label="Type">
            <Select name="type" defaultValue="checking">
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency">
            <Input
              name="currency"
              required
              defaultValue="EUR"
              maxLength={3}
              className="w-20 uppercase"
            />
          </Field>
          <Field label="Starting balance">
            <Input name="initialBalance" placeholder="0.00" className="w-28" />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
        <ErrorText error={error} />
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {accounts.data?.map((account) => (
          <Card key={account.id} className="flex items-center justify-between">
            <div>
              <p className="font-medium">
                {account.name}{" "}
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-normal dark:bg-zinc-800">
                  {account.type}
                </span>
              </p>
              <p className="text-lg">
                {formatCents(account.balance, account.currency)}
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                onClick={() => {
                  const name = window.prompt("New name", account.name);
                  if (name && name !== account.name) {
                    setError(null);
                    rename.mutate({ id: account.id, name });
                  }
                }}
              >
                Rename
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm(`Delete account "${account.name}"?`)) {
                    setError(null);
                    remove.mutate(account.id);
                  }
                }}
              >
                Delete
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}
