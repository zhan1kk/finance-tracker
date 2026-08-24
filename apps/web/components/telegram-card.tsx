"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
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

  // Patch semantics: only the fields sent are written, so each control here
  // can update one setting without disturbing the others.
  const saveReminders = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<TelegramSettings>("/telegram/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
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
                // One click otherwise severs the bot: quick-capture stops and,
                // less obviously, so do the payment reminder nudges.
                if (
                  !window.confirm(
                    "Unlink Telegram? Quick-capture and payment reminders stop until you link the chat again. Nothing you have already recorded is affected.",
                  )
                )
                  return;
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

      {settings.data?.linked && (
        <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.data.remindersEnabled}
              onChange={(e) => {
                setError(null);
                saveReminders.mutate({ remindersEnabled: e.target.checked });
              }}
            />
            <span className="font-medium">Nudge me about upcoming payments</span>
          </label>
          <p className="mt-1 text-xs text-zinc-500">
            One message a morning, only when something is due soon. Each
            reminder comes with a Done button.
          </p>
          {settings.data.remindersEnabled && (
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <Field label="Start (days before)">
                <Input
                  type="number"
                  min={1}
                  max={60}
                  defaultValue={settings.data.leadDays}
                  className="w-24"
                  onBlur={(e) => {
                    const leadDays = Number(e.target.value);
                    // Say so rather than quietly ignoring it: the field keeps
                    // the rejected number, so it looked like it had saved.
                    if (!(leadDays >= 1 && leadDays <= 60)) {
                      e.target.value = String(settings.data?.leadDays ?? 10);
                      setError(new Error("Start must be between 1 and 60 days"));
                      return;
                    }
                    setError(null);
                    saveReminders.mutate({ leadDays });
                  }}
                />
              </Field>
              <Field label="Then every (days)">
                <Input
                  type="number"
                  min={1}
                  max={30}
                  defaultValue={settings.data.intervalDays}
                  className="w-24"
                  onBlur={(e) => {
                    const intervalDays = Number(e.target.value);
                    if (!(intervalDays >= 1 && intervalDays <= 30)) {
                      e.target.value = String(settings.data?.intervalDays ?? 3);
                      setError(
                        new Error("Repeat must be between 1 and 30 days"),
                      );
                      return;
                    }
                    setError(null);
                    saveReminders.mutate({ intervalDays });
                  }}
                />
              </Field>
              <p className="text-xs text-zinc-500">
                Starts {settings.data.leadDays} days out, then every{" "}
                {settings.data.intervalDays}. The day before and the day itself
                are always included, whatever that works out to.
              </p>
            </div>
          )}
        </div>
      )}

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
