"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorText, Field, Select } from "@/components/ui";
import { api } from "@/lib/api";
import type { Account, TelegramLinkCode, TelegramSettings } from "@/lib/types";

export function TelegramCard({ accounts }: { accounts: Account[] }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [linkCode, setLinkCode] = useState<TelegramLinkCode | null>(null);

  const settings = useQuery({
    queryKey: ["telegram-settings"],
    queryFn: () => api<TelegramSettings>("/telegram/settings"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["telegram-settings"] });

  const generateCode = useMutation({
    mutationFn: () =>
      api<TelegramLinkCode>("/telegram/link-code", { method: "POST" }),
    onSuccess: setLinkCode,
    onError: setError,
  });

  const setDefaultAccount = useMutation({
    mutationFn: (defaultAccountId: string | null) =>
      api<TelegramSettings>("/telegram/settings", {
        method: "PATCH",
        body: JSON.stringify({ defaultAccountId }),
      }),
    onSuccess: invalidate,
    onError: setError,
  });

  const unlink = useMutation({
    mutationFn: () => api<TelegramSettings>("/telegram/link", { method: "DELETE" }),
    onSuccess: () => {
      setLinkCode(null);
      void invalidate();
    },
    onError: setError,
  });

  const bot = settings.data?.botUsername;

  return (
    <Card>
      <h2 className="mb-1 font-medium">Telegram quick-capture</h2>
      <p className="mb-3 text-sm text-zinc-500">
        Message the bot things like{" "}
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
          12.50 groceries lunch
        </code>{" "}
        to log cash spending on the go.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Default cash account">
          <Select
            value={settings.data?.defaultAccountId ?? ""}
            onChange={(e) => {
              setError(null);
              setDefaultAccount.mutate(e.target.value || null);
            }}
          >
            <option value="">— none —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        {settings.data?.linked ? (
          <>
            <span className="pb-2 text-sm text-emerald-600">
              Chat linked ✓
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                unlink.mutate();
              }}
              disabled={unlink.isPending}
            >
              Unlink
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            onClick={() => {
              setError(null);
              generateCode.mutate();
            }}
            disabled={generateCode.isPending}
          >
            Generate link code
          </Button>
        )}
      </div>

      {!settings.data?.linked && linkCode && (
        <p className="mt-3 text-sm">
          Send{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-semibold dark:bg-zinc-800">
            /link {linkCode.code}
          </code>{" "}
          to {bot ? <b>@{bot}</b> : "your bot"} within 10 minutes.
        </p>
      )}
      {!settings.data?.linked && !bot && settings.data && (
        <p className="mt-2 text-xs text-zinc-500">
          The bot is offline — set TELEGRAM_BOT_TOKEN in the API environment to
          enable it.
        </p>
      )}
      <ErrorText error={error} />
    </Card>
  );
}
