"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { parseAmountToCents, todayISO } from "@/lib/format";
import { parties, YOU } from "./shared";

export type SettlePrefill = { from: string; to: string; amount: string };

export function SettleForm({
  people,
  pending,
  prefill,
  groupId,
  onSubmit,
}: {
  people: { id: string; name: string }[];
  pending: boolean;
  /** Direction and amount carried in from a balance row's "Settle up". */
  prefill?: SettlePrefill | null;
  /** The group whose debt this pays down; null for none. */
  groupId: string | null;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const all = parties(people);
  const [from, setFrom] = useState(prefill?.from ?? YOU);
  // Not seeded from people[0]: on the first render the query has not resolved,
  // so the list is [] and the initial value stuck at "You" for the life of the
  // component. The form opened as "You paid You" — invalid until a dropdown was
  // touched. null means "not chosen yet", resolved against what has loaded.
  const [to, setTo] = useState<string | null>(prefill?.to ?? null);
  const toKey = to ?? people[0]?.id ?? YOU;
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [showDetails, setShowDetails] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (people.length === 0) return null;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalError(null);
    const data = new FormData(e.currentTarget);
    const cents = parseAmountToCents(amount);
    if (cents === null) return setLocalError("Invalid amount");
    if (from === toKey) return setLocalError("Pick two different people");
    const date = String(data.get("date") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    const form_ = e.currentTarget;
    void onSubmit({
      fromFriendId: from === YOU ? undefined : from,
      toFriendId: toKey === YOU ? undefined : toKey,
      amountCents: cents,
      // Both omitted unless filled in: the server dates an undated settlement
      // now, which is right for the overwhelmingly common "they just paid me".
      ...(date ? { date } : {}),
      ...(note ? { note } : {}),
      ...(groupId ? { groupId } : {}),
    })
      .then(() => {
        form_.reset();
        setAmount("");
        setShowDetails(false);
      })
      .catch(() => {});
  };

  return (
    <Card>
      <h2 className="mb-3 font-medium">Settle up</h2>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From">
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              {all.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <span className="pb-2 text-sm text-zinc-400">paid</span>
          <Field label="To">
            <Select value={toKey} onChange={(e) => setTo(e.target.value)}>
              {all.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount">
            <Input
              name="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10.00"
              className="w-24"
            />
          </Field>
          <Button type="submit" disabled={pending}>
            Record
          </Button>
        </div>
        {/* Folded away rather than absent. Nearly every settlement is "they
            just paid me", where an untouched form is exactly right; the ones
            that are not — a payback from last week, or a note saying what it
            covered — had no way to be recorded at all. */}
        {showDetails ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Date">
              <Input name="date" type="date" defaultValue={todayISO()} />
            </Field>
            <Field label="Note">
              <Input
                name="note"
                placeholder="for the Berlin trip"
                className="w-56"
              />
            </Field>
          </div>
        ) : (
          <button
            type="button"
            className="self-start text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
            onClick={() => setShowDetails(true)}
          >
            Add a date or note
          </button>
        )}
      </form>
      {localError && <p className="mt-1 text-sm text-red-600">{localError}</p>}
    </Card>
  );
}
